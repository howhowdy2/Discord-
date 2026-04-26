// ==UserScript==
// @name         Discord 定時指令
// @namespace    http://tampermonkey.net/
// @version      5.3
// @description  定時指令 / 連續指令 / 元素偵測 三合一面板
// @author       howhowdy2
// @match        https://discord.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  // ═══════════════════════════════════════════════
  //  資料層
  // ═══════════════════════════════════════════════
  function load(key, def) {
    try { return JSON.parse(GM_getValue(key, JSON.stringify(def))); }
    catch { return def; }
  }
  function save(key, val) {
    GM_setValue(key, JSON.stringify(val));
  }

  // 定時指令
  let tasks = load('sch_tasks', []);
  tasks.forEach(t => { t.timerId = null; t.nextRun = Date.now() + t.intervalMs; });

  // 連續指令群組
  let seqGroups = load('sch_seqgroups', []);
  seqGroups.forEach(g => { g.timerId = null; g.running = false; });

  function saveTasks()     { save('sch_tasks',     tasks.map(({ timerId, ...r }) => r)); }
  function saveSeqGroups() { save('sch_seqgroups', seqGroups.map(({ timerId, running, ...r }) => r)); }

  // ═══════════════════════════════════════════════
  //  Discord 輸入層
  // ═══════════════════════════════════════════════
  function pressEnter(editor) {
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true
    }));
  }

  // 偵測補全選單，timeout ms 內找到回傳 true，否則 false
  function waitForAutocomplete(timeout, cb) {
    const start = Date.now();
    const check = setInterval(() => {
      const menu =
        document.querySelector('[data-list-id="channel-autocomplete"]') ||
        document.querySelector('[id*="autocomplete"]') ||
        document.querySelector('[class*="autocomplete-"]') ||
        document.querySelector('[role="listbox"]');
      if (menu) { clearInterval(check); cb(true); return; }
      if (Date.now() - start > timeout) { clearInterval(check); cb(false); }
    }, 50);
  }

  // 清空輸入框（相容 React contenteditable）
  function clearEditor(editor) {
    editor.focus();
    // 嘗試 React 原生方式清空
    const fiberKey = Object.keys(editor).find(
      k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    if (fiberKey) {
      // 送出空字串 input event 讓 React 清空
      editor.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward', bubbles: true, cancelable: true
      }));
    }
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);
  }

  // 注入文字（優先 paste，fallback insertText）
  function injectText(editor, text) {
    const fiberKey = Object.keys(editor).find(
      k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
    );
    if (fiberKey) {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt, bubbles: true, cancelable: true
      }));
    } else {
      document.execCommand('insertText', false, text);
    }
  }

  function sendMessage(command, mode, cb) {
    const editor = document.querySelector('[data-slate-editor="true"]');
    if (!editor) {
      console.warn('[定時指令] 找不到輸入框，請先點選一個頻道');
      if (cb) cb(false);
      return false;
    }

    // Step 1：清空
    clearEditor(editor);

    setTimeout(() => {
      // Step 2：注入文字
      injectText(editor, command);

      if (mode === 'bot') {
        // Step 3a（Bot 指令）：
        // 等補全選單出現 → Enter 確認選項 → 等 300ms → Enter 送出
        // 若 2 秒內選單沒出現（例如只有一個完全符合的指令），直接連按兩次
        waitForAutocomplete(2000, (found) => {
          const delay = found ? 80 : 0;
          setTimeout(() => {
            pressEnter(editor);           // 第一次 Enter：確認補全 / 選擇指令
            setTimeout(() => {
              pressEnter(editor);         // 第二次 Enter：送出訊息
              if (cb) cb(true);
            }, 350);
          }, delay);
        });
      } else {
        // Step 3b（一般對話）：直接 Enter 送出
        setTimeout(() => {
          pressEnter(editor);
          if (cb) cb(true);
        }, 100);
      }
    }, 80); // 給 React 80ms 處理清空後的狀態

    return true;
  }

  // ═══════════════════════════════════════════════
  //  定時指令：計時器
  // ═══════════════════════════════════════════════

  // 計算 clock 模式的下次觸發時間（今天或明天的 HH:MM）
  function nextClockTime(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const now = new Date();
    const target = new Date(now);
    target.setHours(h, m, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target.getTime();
  }

  // 下一個整點（每小時 :00）
  function nextHourTime() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(now.getHours() + 1, 0, 0, 0);
    return next.getTime();
  }

  function startTask(task) {
    if (task.timerId) clearInterval(task.timerId);

    if (task.scheduleType === 'clock') {
      task.nextRun = nextClockTime(task.clockTime);
      task.timerId = setInterval(() => {
        if (!task.enabled) return;
        if (Date.now() >= task.nextRun) {
          sendMessage(task.command, task.mode, () => {});
          task.nextRun = nextClockTime(task.clockTime);
        }
      }, 1000);
    } else if (task.scheduleType === 'hour') {
      // 每小時整點 :00 觸發
      task.nextRun = nextHourTime();
      task.timerId = setInterval(() => {
        if (!task.enabled) return;
        if (Date.now() >= task.nextRun) {
          sendMessage(task.command, task.mode, () => {});
          task.nextRun = nextHourTime();
        }
      }, 1000);
    } else {
      // 原本的 interval 模式
      task.nextRun = Date.now() + task.intervalMs;
      task.timerId = setInterval(() => {
        if (!task.enabled) return;
        sendMessage(task.command, task.mode, () => {});
        task.nextRun = Date.now() + task.intervalMs;
      }, task.intervalMs);
    }
  }
  function stopTask(task) {
    if (task.timerId) { clearInterval(task.timerId); task.timerId = null; }
    task.nextRun = null;
  }
  function startAllTasks() { tasks.forEach(t => { if (t.enabled) startTask(t); }); }

  // ═══════════════════════════════════════════════
  //  連續指令：執行一個群組的所有指令
  // ═══════════════════════════════════════════════
  function runSequence(group, done) {
    const cmds = group.commands; // [{text, mode, delayMs}]
    let i = 0;
    function next() {
      if (i >= cmds.length) { if (done) done(); return; }
      const cmd = cmds[i++];
      sendMessage(cmd.text, cmd.mode, () => {
        setTimeout(next, cmd.delayMs || group.fixedDelayMs || 1000);
      });
    }
    next();
  }

  function startSeqGroup(group) {
    if (group.timerId) clearInterval(group.timerId);

    if (group.scheduleType === 'clock') {
      group.nextRun = nextClockTime(group.clockTime);
      group.timerId = setInterval(() => {
        if (!group.enabled) return;
        if (Date.now() >= group.nextRun) {
          runSequence(group, () => {});
          group.nextRun = nextClockTime(group.clockTime);
        }
      }, 1000);
    } else {
      group.nextRun = Date.now() + group.intervalMs;
      group.timerId = setInterval(() => {
        if (!group.enabled) return;
        runSequence(group, () => {});
        group.nextRun = Date.now() + group.intervalMs;
      }, group.intervalMs);
    }
  }
  function stopSeqGroup(group) {
    if (group.timerId) { clearInterval(group.timerId); group.timerId = null; }
    group.nextRun = null;
  }
  function startAllSeqGroups() { seqGroups.forEach(g => { if (g.enabled) startSeqGroup(g); }); }

  // ═══════════════════════════════════════════════
  //  樣式注入
  // ═══════════════════════════════════════════════
  const STYLE_ID = '__sch4_style__';
  const BTN_ID   = '__sch4_mainbtn__';
  const PANEL_ID = '__sch4_panel__';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      /* ── 主按鈕 ── */
      #${BTN_ID} {
        background:#5865F2; color:#fff; border:none;
        border-radius:6px; padding:5px 12px;
        font-size:13px; font-weight:600; cursor:pointer;
        font-family:'gg sans','Noto Sans',sans-serif;
        transition:background .15s;
      }
      #${BTN_ID}:hover { background:#4752C4; }
      .__sch_quick_mainbtn {
        background:#4e3fa0; color:#fff; border:none;
        border-radius:6px; padding:5px 12px;
        font-size:13px; font-weight:600; cursor:pointer;
        font-family:'gg sans','Noto Sans',sans-serif;
        transition:background .15s;
      }
      .__sch_quick_mainbtn:hover { background:#3d3180; }

      /* ── 面板 ── */
      #${PANEL_ID} {
        display:none; position:fixed; top:44px; right:56px;
        z-index:9998; width:360px; max-height:84vh;
        background:#2b2d31; border:1px solid #1e1f22;
        border-radius:10px; box-shadow:0 8px 32px rgba(0,0,0,.55);
        font-family:'gg sans','Noto Sans',sans-serif;
        color:#dbdee1; flex-direction:column; overflow:hidden;
      }
      #${PANEL_ID}.open { display:flex; }

      /* ── 頁籤列 ── */
      .__sch_tabs {
        display:flex; border-bottom:1px solid #1e1f22;
        background:#232428; flex-shrink:0;
      }
      .__sch_tab {
        flex:1; padding:10px 4px; font-size:11px; font-weight:700;
        border:none; background:none; color:#949ba4; cursor:pointer;
        letter-spacing:.3px; transition:color .15s, border-bottom .15s;
        border-bottom:2px solid transparent; font-family:inherit;
      }
      .__sch_tab:hover { color:#dbdee1; }
      .__sch_tab.active { color:#fff; border-bottom:2px solid #5865F2; }

      /* ── 頁面容器 ── */
      .__sch_page { display:none; flex:1; flex-direction:column; overflow:hidden; }
      .__sch_page.active { display:flex; }

      /* ── 表單通用 ── */
      .__sch_form {
        padding:12px 14px; border-bottom:1px solid #1e1f22;
        display:flex; flex-direction:column; gap:8px; flex-shrink:0;
      }
      .__sch_input {
        background:#1e1f22; border:1px solid #3f4248;
        border-radius:5px; color:#dbdee1;
        padding:7px 10px; font-size:13px;
        width:100%; box-sizing:border-box;
        outline:none; transition:border .15s; font-family:inherit;
      }
      .__sch_input:focus { border-color:#5865F2; }
      .__sch_input::placeholder { color:#555861; }
      .__sch_input[type="number"] { width:80px; }

      .__sch_row { display:flex; gap:6px; align-items:center; }
      .__sch_select {
        background:#1e1f22; border:1px solid #3f4248;
        border-radius:5px; color:#dbdee1;
        padding:7px 8px; font-size:13px;
        flex:1; outline:none; cursor:pointer; font-family:inherit;
      }

      .__sch_mode_wrap { display:flex; border:1px solid #3f4248; border-radius:5px; overflow:hidden; }
      .__sch_mode_btn {
        flex:1; padding:7px 6px; font-size:12px; font-weight:600;
        border:none; cursor:pointer; font-family:inherit;
        background:#1e1f22; color:#6d6f78; transition:background .15s, color .15s;
      }
      .__sch_mode_btn.active { background:#5865F2; color:#fff; }

      .__sch_btn_primary {
        background:#5865F2; color:#fff; border:none;
        border-radius:5px; padding:8px; font-size:13px;
        font-weight:600; cursor:pointer; transition:background .15s; font-family:inherit;
        width:100%;
      }
      .__sch_btn_primary:hover { background:#4752C4; }

      .__sch_btn_sm {
        background:none; border:1px solid #3f4248;
        border-radius:4px; color:#b5bac1;
        padding:3px 8px; font-size:12px; cursor:pointer;
        font-family:inherit; transition:background .15s;
      }
      .__sch_btn_sm:hover { background:#3f4248; color:#fff; }

      /* ── 卡片列表 ── */
      .__sch_list {
        overflow-y:auto; flex:1; padding:8px 10px;
        display:flex; flex-direction:column; gap:6px;
      }
      .__sch_list::-webkit-scrollbar { width:4px; }
      .__sch_list::-webkit-scrollbar-thumb { background:#3f4248; border-radius:2px; }

      .__sch_empty { color:#555861; font-size:12px; text-align:center; padding:20px 0; }

      .__sch_card {
        background:#1e1f22; border:1px solid #3f4248;
        border-radius:7px; padding:10px 11px;
        display:flex; flex-direction:column; gap:4px;
        transition:border-color .15s;
      }
      .__sch_card.active { border-color:#5865F2; }

      .__sch_card_top { display:flex; justify-content:space-between; align-items:center; }
      .__sch_card_label {
        font-size:13px; font-weight:600; color:#fff;
        white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:170px;
      }
      .__sch_card_btns { display:flex; gap:4px; flex-shrink:0; }

      .__sch_card_meta { font-size:11px; color:#6d6f78; display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
      .__sch_badge { font-size:10px; padding:1px 6px; border-radius:3px; font-weight:700; letter-spacing:.3px; }
      .__sch_badge.bot  { background:#4f46e5; color:#c7d2fe; }
      .__sch_badge.chat { background:#15803d; color:#bbf7d0; }
      .__sch_badge.seq  { background:#92400e; color:#fde68a; }

      .__sch_card_cmd { font-size:11px; color:#949ba4; font-family:'Consolas',monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .__sch_countdown { color:#23a55a; }
      .__sch_countdown.off { color:#f23f43; }

      .__sch_icon_btn {
        background:none; border:none; cursor:pointer;
        border-radius:4px; padding:3px 7px; font-size:13px;
        color:#b5bac1; transition:background .15s, color .15s; line-height:1;
      }
      .__sch_icon_btn:hover { background:#3f4248; color:#fff; }
      .__sch_icon_btn.is-on  { color:#23a55a; }
      .__sch_icon_btn.is-off { color:#f23f43; }

      /* ── 連續指令：子指令列 ── */
      .__sch_seq_cmds {
        display:flex; flex-direction:column; gap:6px;
        max-height:180px; overflow-y:auto; padding:2px 0;
      }
      .__sch_seq_cmds::-webkit-scrollbar { width:3px; }
      .__sch_seq_cmds::-webkit-scrollbar-thumb { background:#3f4248; border-radius:2px; }

      .__sch_seq_cmd_row {
        display:flex; gap:5px; align-items:center;
        background:#161719; border:1px solid #2e3035;
        border-radius:5px; padding:5px 8px;
      }
      .__sch_seq_cmd_num {
        font-size:10px; color:#555861; min-width:14px; text-align:center;
      }
      .__sch_seq_cmd_text { flex:1; font-size:12px; color:#dbdee1; font-family:'Consolas',monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .__sch_seq_cmd_delay { font-size:10px; color:#5865F2; white-space:nowrap; }
      .__sch_seq_cmd_del { background:none; border:none; color:#555861; cursor:pointer; font-size:12px; padding:0 3px; }
      .__sch_seq_cmd_del:hover { color:#f23f43; }

      .__sch_delay_mode_wrap { display:flex; gap:6px; align-items:center; }
      .__sch_delay_toggle {
        font-size:11px; padding:4px 8px; border-radius:4px;
        border:1px solid #3f4248; background:#1e1f22; color:#949ba4;
        cursor:pointer; font-family:inherit; white-space:nowrap;
        transition:all .15s;
      }
      .__sch_delay_toggle.active { border-color:#5865F2; color:#5865F2; }

      /* ── 元素偵測 ── */
      .__sch_detect_result {
        font-size:11px; display:flex; flex-direction:column; gap:4px;
      }
      .__sch_detect_msg {
        background:#161719; border:1px solid #2e3035;
        border-radius:5px; padding:6px 8px;
        display:flex; flex-direction:column; gap:3px;
      }
      .__sch_detect_msg_header { font-size:10px; color:#555861; margin-bottom:2px; }
      .__sch_detect_item {
        display:flex; gap:5px; align-items:flex-start;
      }
      .__sch_detect_type {
        font-size:9px; padding:1px 5px; border-radius:3px;
        font-weight:700; flex-shrink:0; margin-top:1px;
      }
      .__sch_detect_type.btn  { background:#1d4ed8; color:#bfdbfe; }
      .__sch_detect_type.text { background:#374151; color:#d1d5db; }
      .__sch_detect_content { color:#dbdee1; word-break:break-all; line-height:1.4; }

      /* ── 版本控制器（面板底部）── */
      .__sch_footer {
        border-top:1px solid #1e1f22;
        padding:7px 12px;
        flex-shrink:0;
      }
      #__sch_ver__ {
        display:inline-flex; align-items:center; gap:7px;
        cursor:pointer; transition:opacity .15s;
        text-decoration:none;
      }
      #__sch_ver__:hover { opacity:0.75; }
      #__sch_ver__ img {
        width:20px; height:20px; border-radius:50%;
        object-fit:cover; flex-shrink:0;
      }
      .__sch_ver_info { display:flex; align-items:center; gap:5px; }
      .__sch_ver_name { font-size:11px; font-weight:700; color:#949ba4; line-height:1; }
      .__sch_ver_tag  { font-size:10px; color:#555861; line-height:1; }
      .__sch_ver_badge {
        font-size:9px; font-weight:700; padding:1px 5px;
        border-radius:3px; display:none;
      }
      .__sch_ver_badge.update { background:#f59e0b; color:#1c1917; display:inline-block; }
      .__sch_ver_badge.latest { background:#166534; color:#bbf7d0; display:inline-block; }

      /* ── Footer 左右布局 ── */
      .__sch_footer {
        border-top:1px solid #1e1f22;
        padding:7px 12px;
        flex-shrink:0;
        display:flex;
        align-items:center;
        justify-content:space-between;
      }

      /* ── 米米預設腳本 toggle ── */
      .__sch_mimi_wrap { display:flex; align-items:center; gap:6px; }
      .__sch_mimi_label { font-size:10px; color:#6d6f78; white-space:nowrap; }
      .__sch_toggle_track {
        width:30px; height:16px; border-radius:8px;
        background:#3f4248; cursor:pointer;
        position:relative; transition:background .2s; flex-shrink:0;
        border:none; padding:0;
      }
      .__sch_toggle_track.on { background:#5865F2; }
      .__sch_toggle_thumb {
        position:absolute; top:2px; left:2px;
        width:12px; height:12px; border-radius:50%;
        background:#fff; transition:left .2s;
        pointer-events:none;
      }
      .__sch_toggle_track.on .__sch_toggle_thumb { left:16px; }

      /* ── 米米快捷鍵面板 ── */
      #__sch_quick_panel__ {
        display:none; position:fixed; top:44px; right:180px;
        z-index:9998; width:200px;
        background:#2b2d31; border:1px solid #1e1f22;
        border-radius:10px; box-shadow:0 8px 32px rgba(0,0,0,.55);
        font-family:'gg sans','Noto Sans',sans-serif;
        flex-direction:column; overflow:hidden;
        padding:8px;
        gap:5px;
      }
      #__sch_quick_panel__.open { display:flex; }
      .__sch_quick_title {
        font-size:11px; font-weight:700; color:#949ba4;
        padding:4px 4px 6px; letter-spacing:.4px;
        border-bottom:1px solid #1e1f22; margin-bottom:2px;
      }
      .__sch_quick_btn {
        background:#1e1f22; border:1px solid #3f4248;
        border-radius:6px; color:#dbdee1;
        padding:8px 10px; font-size:12px; font-weight:600;
        cursor:pointer; text-align:left; font-family:inherit;
        transition:background .15s, border-color .15s;
        display:flex; flex-direction:column; gap:2px;
      }
      .__sch_quick_btn:hover { background:#3f4248; border-color:#5865F2; }
      .__sch_quick_btn span { font-size:10px; color:#555861; font-weight:400; font-family:'Consolas',monospace; }

      /* ── 頂部主按鈕群 ── */
      #__sch_topbar__ {
        position:fixed; top:8px; right:56px; z-index:9999;
        display:flex; gap:6px; align-items:center;
      }
    `;
    document.head.appendChild(s);
  }

  // ═══════════════════════════════════════════════
  //  工具函式
  // ═══════════════════════════════════════════════
  function fmtMs(ms) {
    const s = ms / 1000;
    if (s < 60)   return `${s}秒`;
    if (s < 3600) return `${Math.round(s/60)}分鐘`;
    return `${+(s/3600).toFixed(1)}小時`;
  }
  function fmtCountdown(nextRun, clockTime) {
    if (!nextRun) return '已停止';
    const diff = Math.max(0, nextRun - Date.now());
    const s = Math.floor(diff / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const timeStr = clockTime ? ` (${clockTime})` : '';
    if (h > 0) return `${h}h ${m%60}m 後${timeStr}`;
    if (m > 0) return `${m}m ${s%60}s 後${timeStr}`;
    return `${s}s 後${timeStr}`;
  }

  function makeIconBtn(icon, title, cls, onClick) {
    const b = document.createElement('button');
    b.className = `__sch_icon_btn${cls ? ' '+cls : ''}`;
    b.title = title; b.textContent = icon;
    b.addEventListener('click', onClick);
    return b;
  }

  // ═══════════════════════════════════════════════
  //  頁面1：定時指令
  // ═══════════════════════════════════════════════
  function buildPage1() {
    const page = document.createElement('div');
    page.className = '__sch_page active';
    page.dataset.page = '1';

    // 表單
    const form = document.createElement('div');
    form.className = '__sch_form';

    const labelInp = mkInput('text', '名稱（如：派遣領取）', 20);
    const cmdInp   = mkInput('text', '指令文字');

    const { wrap: modeWrap, getMode } = mkModeToggle();

    // 觸發模式：間隔 / 指定時間
    const schedWrap = document.createElement('div');
    schedWrap.className = '__sch_mode_wrap';
    const intBtn  = document.createElement('button');
    const clkBtn  = document.createElement('button');
    intBtn.className  = '__sch_mode_btn active'; intBtn.textContent = '🔁 間隔觸發';
    clkBtn.className  = '__sch_mode_btn';        clkBtn.textContent = '🕐 指定時間';
    schedWrap.append(intBtn, clkBtn);

    // 間隔輸入列
    const timeRow = document.createElement('div');
    timeRow.className = '__sch_row';
    const timeInp = mkInput('number', '時間'); timeInp.value='23'; timeInp.min='1';
    const unitSel = mkSelect([['分鐘','60000'],['小時','3600000'],['秒','1000']]);
    timeRow.append(timeInp, unitSel);

    // 指定時間輸入列
    const clockRow = document.createElement('div');
    clockRow.className = '__sch_row';
    clockRow.style.display = 'none';
    const clockLabel = document.createElement('span');
    clockLabel.style.cssText = 'font-size:12px;color:#949ba4;white-space:nowrap;';
    clockLabel.textContent = '每天';
    const clockInp = mkInput('text', '');
    clockInp.type = 'time'; clockInp.value = '12:00';
    clockInp.style.cssText = 'flex:1;padding:7px 8px;';
    const clockLabel2 = document.createElement('span');
    clockLabel2.style.cssText = 'font-size:12px;color:#949ba4;white-space:nowrap;';
    clockLabel2.textContent = '執行';
    clockRow.append(clockLabel, clockInp, clockLabel2);

    let schedType = 'interval';
    intBtn.addEventListener('click', () => {
      schedType = 'interval';
      intBtn.classList.add('active'); clkBtn.classList.remove('active');
      timeRow.style.display = 'flex'; clockRow.style.display = 'none';
    });
    clkBtn.addEventListener('click', () => {
      schedType = 'clock';
      clkBtn.classList.add('active'); intBtn.classList.remove('active');
      clockRow.style.display = 'flex'; timeRow.style.display = 'none';
    });

    const addBtn = document.createElement('button');
    addBtn.className = '__sch_btn_primary';
    addBtn.textContent = '＋ 新增定時指令';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      const label   = labelInp.value.trim();
      const command = cmdInp.value.trim();
      if (!label)   { alert('請輸入名稱'); return; }
      if (!command) { alert('請輸入指令'); return; }

      let intervalMs = 0;
      let clockTime  = '';
      if (schedType === 'interval') {
        const time = parseFloat(timeInp.value);
        const unit = parseInt(unitSel.value);
        if (!time||time<=0) { alert('請輸入有效時間'); return; }
        intervalMs = Math.round(time * unit);
      } else {
        clockTime = clockInp.value;
        if (!clockTime) { alert('請選擇時間'); return; }
        intervalMs = 86400000; // 24h，clock 模式不用這個但存著備用
      }

      const task = {
        id: Date.now().toString(), label, command,
        mode: getMode(), scheduleType: schedType,
        intervalMs, clockTime,
        enabled: true,
        nextRun: schedType === 'clock' ? nextClockTime(clockTime) : Date.now() + intervalMs,
        timerId: null
      };
      tasks.push(task); saveTasks(); startTask(task); renderPage1List();
      labelInp.value=''; cmdInp.value=''; timeInp.value='23'; clockInp.value='12:00';
      schedType='interval';
      intBtn.classList.add('active'); clkBtn.classList.remove('active');
      timeRow.style.display='flex'; clockRow.style.display='none';
    });

    // 供外部（米米預設）使用的新增函式，走完全相同的路徑
    page._addTask = ({ label, command, mode, scheduleType, clockTime, intervalMs }) => {
      const task = {
        id: 'mimi_' + label,
        label, command, mode, scheduleType,
        intervalMs: intervalMs || 86400000,
        clockTime: clockTime || '',
        enabled: true,
        nextRun: scheduleType === 'clock' ? nextClockTime(clockTime)
               : scheduleType === 'hour'  ? nextHourTime()
               : Date.now() + intervalMs,
        timerId: null
      };
      tasks.push(task); saveTasks(); startTask(task); renderPage1List();
    };

    form.append(labelInp, cmdInp, modeWrap, schedWrap, timeRow, clockRow, addBtn);

    // 列表
    const list = document.createElement('div');
    list.className = '__sch_list';
    list.id = '__sch_p1_list__';

    page.append(form, list);

    // 倒數每秒更新
    setInterval(() => {
      page.querySelectorAll('.__sch_countdown').forEach(el => {
        const id = el.closest('[data-id]')?.dataset.id;
        const t  = tasks.find(x => x.id === id);
        if (!t) return;
        el.textContent = t.enabled ? fmtCountdown(t.nextRun, t.scheduleType==='clock'?t.clockTime:'') : '已停止';
        el.className   = `__sch_countdown${t.enabled?'':' off'}`;
      });
    }, 1000);

    return page;
  }

  function renderPage1List() {
    const list = document.getElementById('__sch_p1_list__');
    if (!list) return;
    list.innerHTML = '';
    if (!tasks.length) { list.innerHTML='<div class="__sch_empty">尚無定時指令</div>'; return; }

    tasks.forEach(t => {
      const card = document.createElement('div');
      card.className = `__sch_card${t.enabled?' active':''}`;
      card.dataset.id = t.id;

      const top = document.createElement('div'); top.className='__sch_card_top';
      const lbl = document.createElement('span'); lbl.className='__sch_card_label'; lbl.textContent=t.label; lbl.title=t.label;
      const btns = document.createElement('div'); btns.className='__sch_card_btns';

      const toggleBtn = makeIconBtn(t.enabled?'⏸':'▶', t.enabled?'暫停':'啟動', t.enabled?'is-on':'is-off', (e) => {
        e.stopPropagation();
        t.enabled=!t.enabled; t.enabled?startTask(t):stopTask(t); saveTasks(); renderPage1List();
      });
      const nowBtn = makeIconBtn('⚡','立即執行','', (e) => {
        e.stopPropagation();
        sendMessage(t.command, t.mode, ()=>{}); t.nextRun=Date.now()+t.intervalMs;
      });
      const delBtn = makeIconBtn('✕','刪除','', (e) => {
        e.stopPropagation();
        stopTask(t); tasks=tasks.filter(x=>x.id!==t.id); saveTasks(); renderPage1List();
      });
      btns.append(toggleBtn, nowBtn, delBtn);
      top.append(lbl, btns);

      const cmd = document.createElement('div'); cmd.className='__sch_card_cmd'; cmd.textContent=t.command;

      const meta = document.createElement('div'); meta.className='__sch_card_meta';
      const badge = document.createElement('span'); badge.className=`__sch_badge ${t.mode==='bot'?'bot':'chat'}`; badge.textContent=t.mode==='bot'?'BOT':'對話';
      const ivl   = document.createElement('span');
      ivl.textContent = t.scheduleType==='clock' ? `每天 ${t.clockTime}` : t.scheduleType==='hour' ? '每小時整點' : `每 ${fmtMs(t.intervalMs)}`;
      const cd    = document.createElement('span'); cd.className=`__sch_countdown${t.enabled?'':' off'}`; cd.dataset.nextrun='1'; cd.textContent=t.enabled?fmtCountdown(t.nextRun, t.scheduleType==='clock'?t.clockTime:''):'已停止';
      meta.append(badge, ivl, cd);

      card.append(top, cmd, meta);
      list.appendChild(card);
    });
  }

  // ═══════════════════════════════════════════════
  //  頁面2：連續指令
  // ═══════════════════════════════════════════════
  function buildPage2() {
    const page = document.createElement('div');
    page.className = '__sch_page';
    page.dataset.page = '2';

    // ── 新增群組表單 ──
    const form = document.createElement('div');
    form.className = '__sch_form';

    // 群組名稱
    const groupLabel = mkInput('text', '群組名稱', 20);

    // 間隔模式切換
    let delayMode = 'fixed'; // 'fixed' | 'custom'
    const delayModeRow = document.createElement('div');
    delayModeRow.className = '__sch_row';
    const delayModeLabel = document.createElement('span');
    delayModeLabel.style.cssText = 'font-size:11px;color:#949ba4;white-space:nowrap;';
    delayModeLabel.textContent = '指令間隔：';
    const fixedToggle  = document.createElement('button');
    const customToggle = document.createElement('button');
    fixedToggle.className  = '__sch_delay_toggle active';
    customToggle.className = '__sch_delay_toggle';
    fixedToggle.textContent  = '固定間隔';
    customToggle.textContent = '每條自訂';

    // 固定間隔輸入
    const fixedRow = document.createElement('div');
    fixedRow.className = '__sch_row';
    const fixedInp = mkInput('number','固定間隔'); fixedInp.value='2'; fixedInp.min='1'; fixedInp.style.width='70px';
    const fixedUnit = mkSelect([['秒','1000'],['分鐘','60000']]);
    fixedRow.append(document.createTextNode('固定間隔：'), fixedInp, fixedUnit);

    fixedToggle.addEventListener('click', () => {
      delayMode = 'fixed';
      fixedToggle.classList.add('active'); customToggle.classList.remove('active');
      fixedRow.style.display = 'flex';
    });
    customToggle.addEventListener('click', () => {
      delayMode = 'custom';
      customToggle.classList.add('active'); fixedToggle.classList.remove('active');
      fixedRow.style.display = 'none';
    });
    delayModeRow.append(delayModeLabel, fixedToggle, customToggle);

    // 子指令輸入區
    const seqCmdsDiv = document.createElement('div');
    seqCmdsDiv.className = '__sch_seq_cmds';
    seqCmdsDiv.id = '__sch_seq_edit_cmds__';

    let editCmds = []; // [{text, mode, delayMs}]

    function refreshEditCmds() {
      seqCmdsDiv.innerHTML = '';
      if (!editCmds.length) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#555861;font-size:11px;text-align:center;padding:8px;';
        empty.textContent = '尚無指令，請在下方新增';
        seqCmdsDiv.appendChild(empty);
        return;
      }
      editCmds.forEach((cmd, i) => {
        const row = document.createElement('div');
        row.className = '__sch_seq_cmd_row';
        const num = document.createElement('span'); num.className='__sch_seq_cmd_num'; num.textContent=`${i+1}.`;
        const txt = document.createElement('span'); txt.className='__sch_seq_cmd_text'; txt.textContent=cmd.text;
        const delay = document.createElement('span'); delay.className='__sch_seq_cmd_delay';
        delay.textContent = delayMode==='custom' ? `+${fmtMs(cmd.delayMs||1000)}` : '';
        const del = document.createElement('button'); del.className='__sch_seq_cmd_del'; del.textContent='✕';
        del.addEventListener('click', () => { editCmds.splice(i,1); refreshEditCmds(); });
        row.append(num, txt, delay, del);
        seqCmdsDiv.appendChild(row);
      });
    }
    refreshEditCmds();

    // 新增子指令輸入
    const addCmdRow = document.createElement('div');
    addCmdRow.className = '__sch_row';
    const cmdInp = mkInput('text','指令文字');
    const { wrap: modWrap, getMode } = mkModeToggle();

    // 自訂延遲（custom 模式才顯示）
    const customDelayRow = document.createElement('div');
    customDelayRow.className = '__sch_row';
    customDelayRow.style.display = 'none';
    const customDelayInp  = mkInput('number','延遲'); customDelayInp.value='2'; customDelayInp.min='1'; customDelayInp.style.width='60px';
    const customDelayUnit = mkSelect([['秒','1000'],['分鐘','60000']]);
    customDelayRow.append(document.createTextNode('此條延遲：'), customDelayInp, customDelayUnit);

    customToggle.addEventListener('click', () => { customDelayRow.style.display='flex'; });
    fixedToggle.addEventListener('click',  () => { customDelayRow.style.display='none'; });

    const addCmdBtn = document.createElement('button');
    addCmdBtn.className = '__sch_btn_sm'; addCmdBtn.textContent = '＋ 加入指令';
    addCmdBtn.addEventListener('click', e => {
      e.stopPropagation();
      const text = cmdInp.value.trim();
      if (!text) { alert('請輸入指令'); return; }
      const delayMs = delayMode==='custom'
        ? Math.round(parseFloat(customDelayInp.value||2) * parseInt(customDelayUnit.value))
        : Math.round(parseFloat(fixedInp.value||2) * parseInt(fixedUnit.value));
      editCmds.push({ text, mode: getMode(), delayMs });
      cmdInp.value = '';
      refreshEditCmds();
    });

    // 整體觸發模式：間隔 / 指定時間
    const gSchedWrap = document.createElement('div');
    gSchedWrap.className = '__sch_mode_wrap';
    const gIntBtn = document.createElement('button');
    const gClkBtn = document.createElement('button');
    gIntBtn.className = '__sch_mode_btn active'; gIntBtn.textContent = '🔁 間隔觸發';
    gClkBtn.className = '__sch_mode_btn';        gClkBtn.textContent = '🕐 指定時間';
    gSchedWrap.append(gIntBtn, gClkBtn);

    // 間隔輸入
    const groupIntervalRow = document.createElement('div');
    groupIntervalRow.className = '__sch_row';
    const gInp  = mkInput('number','整體間隔'); gInp.value='30'; gInp.min='1'; gInp.style.width='70px';
    const gUnit = mkSelect([['分鐘','60000'],['小時','3600000'],['秒','1000']]);
    groupIntervalRow.append(document.createTextNode('執行週期：'), gInp, gUnit);

    // 指定時間輸入
    const gClockRow = document.createElement('div');
    gClockRow.className = '__sch_row';
    gClockRow.style.display = 'none';
    const gClockLabel = document.createElement('span');
    gClockLabel.style.cssText = 'font-size:12px;color:#949ba4;white-space:nowrap;';
    gClockLabel.textContent = '每天';
    const gClockInp = mkInput('text', '');
    gClockInp.type = 'time'; gClockInp.value = '12:00';
    gClockInp.style.cssText = 'flex:1;padding:7px 8px;';
    const gClockLabel2 = document.createElement('span');
    gClockLabel2.style.cssText = 'font-size:12px;color:#949ba4;white-space:nowrap;';
    gClockLabel2.textContent = '執行';
    gClockRow.append(gClockLabel, gClockInp, gClockLabel2);

    let gSchedType = 'interval';
    gIntBtn.addEventListener('click', () => {
      gSchedType = 'interval';
      gIntBtn.classList.add('active'); gClkBtn.classList.remove('active');
      groupIntervalRow.style.display = 'flex'; gClockRow.style.display = 'none';
    });
    gClkBtn.addEventListener('click', () => {
      gSchedType = 'clock';
      gClkBtn.classList.add('active'); gIntBtn.classList.remove('active');
      gClockRow.style.display = 'flex'; groupIntervalRow.style.display = 'none';
    });

    const createBtn = document.createElement('button');
    createBtn.className = '__sch_btn_primary'; createBtn.textContent = '＋ 建立連續指令群組';
    createBtn.addEventListener('click', e => {
      e.stopPropagation();
      const label = groupLabel.value.trim();
      if (!label)          { alert('請輸入群組名稱'); return; }
      if (!editCmds.length){ alert('請至少新增一條指令'); return; }

      let intervalMs = 86400000;
      let clockTime  = '';
      if (gSchedType === 'interval') {
        intervalMs = Math.round(parseFloat(gInp.value||30) * parseInt(gUnit.value));
      } else {
        clockTime = gClockInp.value;
        if (!clockTime) { alert('請選擇時間'); return; }
      }

      const group = {
        id: Date.now().toString(), label,
        commands: [...editCmds],
        delayMode,
        fixedDelayMs: Math.round(parseFloat(fixedInp.value||2)*parseInt(fixedUnit.value)),
        scheduleType: gSchedType, intervalMs, clockTime,
        enabled: true,
        nextRun: gSchedType === 'clock' ? nextClockTime(clockTime) : Date.now()+intervalMs,
        timerId: null, running: false
      };
      seqGroups.push(group); saveSeqGroups(); startSeqGroup(group); renderPage2List();
      groupLabel.value=''; editCmds=[]; refreshEditCmds(); gInp.value='30'; gClockInp.value='12:00';
      gSchedType='interval';
      gIntBtn.classList.add('active'); gClkBtn.classList.remove('active');
      groupIntervalRow.style.display='flex'; gClockRow.style.display='none';
    });

    // ── 分隔線 ──
    const divider = document.createElement('div');
    divider.style.cssText = 'border-top:1px solid #3f4248;margin:2px 0;';

    // ── 子指令區標題 ──
    const seqLabel = document.createElement('div');
    seqLabel.style.cssText = 'font-size:11px;color:#949ba4;font-weight:600;letter-spacing:.3px;';
    seqLabel.textContent = '指令列表';

    // 排版：跟 Page1 一致
    // 名稱 → 指令 → Bot模式 → 觸發模式 → 時間 → [分隔] → 子指令標題+間隔設定 → 子指令列表 → 加入按鈕 → 建立按鈕
    form.append(
      groupLabel,          // 群組名稱
      modWrap,             // 🤖/💬 模式
      gSchedWrap,          // 🔁/🕐 觸發模式
      groupIntervalRow,    // 間隔輸入
      gClockRow,           // 指定時間輸入
      divider,             // 分隔線
      seqLabel,            // 「指令列表」標題
      delayModeRow,        // 固定間隔 / 每條自訂
      fixedRow,            // 固定間隔輸入
      seqCmdsDiv,          // 子指令預覽列表
      cmdInp,              // 子指令文字輸入
      customDelayRow,      // 自訂延遲輸入
      addCmdBtn,           // ＋ 加入指令
      createBtn            // ＋ 建立群組
    );

    // 群組列表
    const list = document.createElement('div');
    list.className = '__sch_list';
    list.id = '__sch_p2_list__';

    page.append(form, list);

    setInterval(() => {
      page.querySelectorAll('.__sch_countdown').forEach(el => {
        const id = el.closest('[data-id]')?.dataset.id;
        const g  = seqGroups.find(x => x.id === id);
        if (!g) return;
        el.textContent = g.enabled ? fmtCountdown(g.nextRun, g.scheduleType==='clock'?g.clockTime:'') : '已停止';
        el.className   = `__sch_countdown${g.enabled?'':' off'}`;
      });
    }, 1000);

    return page;
  }

  function renderPage2List() {
    const list = document.getElementById('__sch_p2_list__');
    if (!list) return;
    list.innerHTML = '';
    if (!seqGroups.length) { list.innerHTML='<div class="__sch_empty">尚無連續指令群組</div>'; return; }

    seqGroups.forEach(g => {
      const card = document.createElement('div');
      card.className = `__sch_card${g.enabled?' active':''}`;
      card.dataset.id = g.id;

      const top = document.createElement('div'); top.className='__sch_card_top';
      const lbl = document.createElement('span'); lbl.className='__sch_card_label'; lbl.textContent=g.label; lbl.title=g.label;
      const btns= document.createElement('div'); btns.className='__sch_card_btns';

      const toggleBtn = makeIconBtn(g.enabled?'⏸':'▶', g.enabled?'暫停':'啟動', g.enabled?'is-on':'is-off', (e) => {
        e.stopPropagation();
        g.enabled=!g.enabled; g.enabled?startSeqGroup(g):stopSeqGroup(g); saveSeqGroups(); renderPage2List();
      });
      const nowBtn = makeIconBtn('⚡','立即執行一次','', (e) => {
        e.stopPropagation();
        runSequence(g, ()=>{}); g.nextRun=Date.now()+g.intervalMs;
      });
      const delBtn = makeIconBtn('✕','刪除','', (e) => {
        e.stopPropagation();
        stopSeqGroup(g); seqGroups=seqGroups.filter(x=>x.id!==g.id); saveSeqGroups(); renderPage2List();
      });
      btns.append(toggleBtn, nowBtn, delBtn);
      top.append(lbl, btns);

      // 指令清單預覽
      const preview = document.createElement('div');
      preview.className = '__sch_card_cmd';
      preview.textContent = g.commands.map((c,i)=>`${i+1}.${c.text}`).join(' → ');

      const meta = document.createElement('div'); meta.className='__sch_card_meta';
      const badge= document.createElement('span'); badge.className='__sch_badge seq'; badge.textContent=`${g.commands.length}條`;
      const ivl  = document.createElement('span');
      ivl.textContent = g.scheduleType==='clock' ? `每天 ${g.clockTime}` : `每 ${fmtMs(g.intervalMs)}`;
      const cd   = document.createElement('span'); cd.className=`__sch_countdown${g.enabled?'':' off'}`; cd.textContent=g.enabled?fmtCountdown(g.nextRun, g.scheduleType==='clock'?g.clockTime:''):'已停止';
      meta.append(badge, ivl, cd);

      card.append(top, preview, meta);
      list.appendChild(card);
    });
  }

  // ═══════════════════════════════════════════════
  //  頁面3：元素偵測
  // ═══════════════════════════════════════════════
  function buildPage3() {
    const page = document.createElement('div');
    page.className = '__sch_page';
    page.dataset.page = '3';

    const form = document.createElement('div');
    form.className = '__sch_form';

    const ctrlRow = document.createElement('div');
    ctrlRow.className = '__sch_row';

    const countLabel = document.createElement('span');
    countLabel.style.cssText = 'font-size:12px;color:#949ba4;white-space:nowrap;';
    countLabel.textContent = '掃描最新';

    const countInp = mkInput('number', '條數'); countInp.value='5'; countInp.min='1'; countInp.max='50'; countInp.style.width='60px';

    const countLabel2 = document.createElement('span');
    countLabel2.style.cssText = 'font-size:12px;color:#949ba4;white-space:nowrap;';
    countLabel2.textContent = '條訊息';

    const scanBtn = document.createElement('button');
    scanBtn.className = '__sch_btn_primary';
    scanBtn.style.marginTop = '0';
    scanBtn.textContent = '🔍 立即掃描';

    ctrlRow.append(countLabel, countInp, countLabel2);
    form.append(ctrlRow, scanBtn);

    const resultDiv = document.createElement('div');
    resultDiv.className = '__sch_list';
    resultDiv.id = '__sch_p3_result__';
    resultDiv.innerHTML = '<div class="__sch_empty">點擊掃描查看結果</div>';

    scanBtn.addEventListener('click', e => {
      e.stopPropagation();
      const n = parseInt(countInp.value) || 5;
      scanElements(n, resultDiv);
    });

    page.append(form, resultDiv);
    return page;
  }

  function scanElements(n, resultDiv) {
    resultDiv.innerHTML = '';

    // Discord 訊息容器
    const msgEls = document.querySelectorAll('[class*="messageListItem"],[class*="message-"]');
    const msgs   = Array.from(msgEls).slice(-n);

    if (!msgs.length) {
      resultDiv.innerHTML = '<div class="__sch_empty">找不到訊息元素，請確認已開啟頻道</div>';
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.className = '__sch_detect_result';

    msgs.forEach((msg, mi) => {
      const msgBlock = document.createElement('div');
      msgBlock.className = '__sch_detect_msg';

      const header = document.createElement('div');
      header.className = '__sch_detect_msg_header';
      header.textContent = `訊息 ${mi + 1}`;
      msgBlock.appendChild(header);

      let found = false;

      // 掃按鈕
      msg.querySelectorAll('button').forEach(btn => {
        const text = btn.textContent.trim();
        if (!text) return;
        const item = mkDetectItem('btn', text);
        msgBlock.appendChild(item);
        found = true;
      });

      // 掃文字（只取直接文字節點，避免重複）
      msg.querySelectorAll('[class*="messageContent"],[class*="content-"]').forEach(el => {
        const text = el.textContent.trim();
        if (!text || text.length > 200) return;
        const item = mkDetectItem('text', text);
        msgBlock.appendChild(item);
        found = true;
      });

      if (!found) {
        const empty = document.createElement('div');
        empty.style.cssText = 'color:#555861;font-size:11px;';
        empty.textContent = '（無可偵測元素）';
        msgBlock.appendChild(empty);
      }

      wrapper.appendChild(msgBlock);
    });

    const countInfo = document.createElement('div');
    countInfo.style.cssText = 'font-size:11px;color:#555861;text-align:center;padding:6px 0;';
    countInfo.textContent = `共掃描 ${msgs.length} 條訊息`;
    wrapper.appendChild(countInfo);

    resultDiv.appendChild(wrapper);
  }

  function mkDetectItem(type, text) {
    const item = document.createElement('div');
    item.className = '__sch_detect_item';
    const badge = document.createElement('span');
    badge.className = `__sch_detect_type ${type}`;
    badge.textContent = type === 'btn' ? '按鈕' : '文字';
    const content = document.createElement('span');
    content.className = '__sch_detect_content';
    content.textContent = text;
    item.append(badge, content);
    return item;
  }

  // ═══════════════════════════════════════════════
  //  共用 UI 工具
  // ═══════════════════════════════════════════════
  function mkInput(type, placeholder, maxLength) {
    const el = document.createElement('input');
    el.type = type; el.placeholder = placeholder || '';
    el.className = '__sch_input';
    if (maxLength) el.maxLength = maxLength;
    return el;
  }

  function mkSelect(options) {
    const sel = document.createElement('select');
    sel.className = '__sch_select';
    options.forEach(([txt, val]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = txt;
      sel.appendChild(opt);
    });
    return sel;
  }

  function mkModeToggle() {
    const wrap = document.createElement('div');
    wrap.className = '__sch_mode_wrap';
    const botBtn  = document.createElement('button');
    const chatBtn = document.createElement('button');
    botBtn.className  = '__sch_mode_btn active'; botBtn.dataset.mode='bot';  botBtn.textContent='🤖 機器人指令';
    chatBtn.className = '__sch_mode_btn';        chatBtn.dataset.mode='chat'; chatBtn.textContent='💬 一般對話';
    let mode = 'bot';
    [botBtn, chatBtn].forEach(b => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      botBtn.classList.toggle('active', mode==='bot');
      chatBtn.classList.toggle('active', mode==='chat');
    }));
    wrap.append(botBtn, chatBtn);
    return { wrap, getMode: () => mode };
  }

  // ═══════════════════════════════════════════════
  //  米米預設腳本
  // ═══════════════════════════════════════════════
  const MIMI_TASKS = [
    { label: '每日獎勵', command: '/daily',  mode: 'bot', scheduleType: 'clock',    clockTime: '00:00', intervalMs: 86400000 },
    { label: '定時獎勵', command: '/hourly', mode: 'bot', scheduleType: 'hour',     clockTime: '',      intervalMs: 3600000  },
  ];
  const MIMI_KEY = 'sch_mimi_enabled';

  function isMimiEnabled() {
    return GM_getValue(MIMI_KEY, 'false') === 'true';
  }

  function setMimiEnabled(val) {
    GM_setValue(MIMI_KEY, val ? 'true' : 'false');
  }

  function applyMimiTasks(enabled) {
    if (enabled) {
      // 找到 Page1 的 _addTask 函式（與手動新增完全相同路徑）
      const page1 = document.querySelector('[data-page="1"]');
      MIMI_TASKS.forEach(def => {
        const exists = tasks.find(t => t.id === 'mimi_' + def.label);
        if (exists) return;
        if (page1 && page1._addTask) {
          page1._addTask(def);
        } else {
          // fallback：面板尚未建立時直接 push（啟動時用）
          const task = {
            ...def,
            id: 'mimi_' + def.label,
            enabled: true,
            nextRun: def.scheduleType === 'clock' ? nextClockTime(def.clockTime)
                   : def.scheduleType === 'hour'  ? nextHourTime()
                   : Date.now() + def.intervalMs,
            timerId: null
          };
          tasks.push(task);
          saveTasks();
          startTask(task);
        }
      });
      renderPage1List();
    } else {
      MIMI_TASKS.forEach(def => {
        const idx = tasks.findIndex(t => t.id === 'mimi_' + def.label);
        if (idx === -1) return;
        stopTask(tasks[idx]);
        tasks.splice(idx, 1);
      });
      saveTasks();
      renderPage1List();
    }
  }

  function createMimiToggle() {
    const wrap = document.createElement('div');
    wrap.className = '__sch_mimi_wrap';

    const label = document.createElement('span');
    label.className = '__sch_mimi_label';
    label.textContent = '米米預設';

    const track = document.createElement('button');
    track.className = `__sch_toggle_track${isMimiEnabled() ? ' on' : ''}`;
    const thumb = document.createElement('div');
    thumb.className = '__sch_toggle_thumb';
    track.appendChild(thumb);

    track.addEventListener('click', e => {
      e.stopPropagation();
      const nowOn = !track.classList.contains('on');
      track.classList.toggle('on', nowOn);
      setMimiEnabled(nowOn);
      applyMimiTasks(nowOn);
      // 同步顯示/隱藏米米快捷鍵按鈕
      const qb = document.querySelector('.__sch_quick_mainbtn');
      if (qb) qb.style.display = nowOn ? 'inline-block' : 'none';
      if (!nowOn) {
        const qp = document.getElementById('__sch_quick_panel__');
        if (qp) qp.classList.remove('open');
      }
    });

    wrap.append(label, track);
    return wrap;
  }

  // ═══════════════════════════════════════════════
  //  版本控制器
  // ═══════════════════════════════════════════════
  const CURRENT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script) ? GM_info.script.version : '4.2';
  const GITHUB_USER     = 'howhowdy2';
  const GITHUB_REPO     = 'Discord-';
  const GITHUB_FILE     = 'discord_scheduler.user.js';
  const GITHUB_URL      = `https://github.com/${GITHUB_USER}/${GITHUB_REPO}`;
  const RAW_URL         = `https://raw.githubusercontent.com/${GITHUB_USER}/${GITHUB_REPO}/main/${GITHUB_FILE}`;
  const AVATAR_URL      = `https://github.com/${GITHUB_USER}.png`;

  function createVersionWidget() {
    const widget = document.createElement('a');
    widget.id = '__sch_ver__';
    widget.href = GITHUB_URL;
    widget.target = '_blank';
    widget.rel = 'noopener';
    widget.title = '點擊前往 GitHub';

    // 頭像：先顯示文字佔位，用 GM_xmlhttpRequest 抓圖後以 background-image 顯示
    // （Discord CSP 擋 img src 外部連結，但不擋 CSS background-image data URL）
    const avatarWrap = document.createElement('div');
    avatarWrap.style.cssText = 'width:22px;height:22px;border-radius:50%;background:#5865F2;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:#fff;flex-shrink:0;background-size:cover;background-position:center;';
    avatarWrap.textContent = GITHUB_USER[0].toUpperCase();

    GM_xmlhttpRequest({
      method: 'GET',
      url: AVATAR_URL + '?size=40',
      responseType: 'blob',
      onload(res) {
        const reader = new FileReader();
        reader.onload = () => {
          // 用 CSS background-image 而非 img src，繞過 Discord img-src CSP
          avatarWrap.textContent = '';
          avatarWrap.style.backgroundImage = `url(${reader.result})`;
          avatarWrap.style.background = `url(${reader.result}) center/cover no-repeat`;
        };
        reader.readAsDataURL(res.response);
      },
      onerror() {} // 失敗就維持文字頭像
    });

    const info = document.createElement('div');
    info.className = '__sch_ver_info';

    const name = document.createElement('div');
    name.className = '__sch_ver_name';
    name.textContent = GITHUB_USER;

    const tag = document.createElement('div');
    tag.className = '__sch_ver_tag';
    tag.textContent = `v${CURRENT_VERSION}`;

    const badge = document.createElement('div');
    badge.className = '__sch_ver_badge';
    badge.textContent = '檢查中...';

    info.append(name, tag, badge);
    widget.append(avatarWrap, info);

    widget.addEventListener('click', e => e.stopPropagation());

    function checkUpdate() {
      badge.className = '__sch_ver_badge';
      badge.textContent = '檢查中...';
      GM_xmlhttpRequest({
        method: 'GET',
        url: RAW_URL + '?t=' + Date.now(),
        onload(res) {
          const match = res.responseText.match(/@version\s+([\d.]+)/);
          if (!match) return;
          const remoteVer = match[1];
          const hasUpdate = remoteVer !== CURRENT_VERSION;
          badge.className = `__sch_ver_badge ${hasUpdate ? 'update' : 'latest'}`;
          badge.textContent = hasUpdate ? `↑ v${remoteVer} 可更新` : '✓ 最新版';
          if (hasUpdate) widget.title = `有新版本 v${remoteVer}，點擊前往 GitHub 更新`;
        },
        onerror() { badge.className = '__sch_ver_badge'; badge.textContent = '無法連線'; }
      });
    }

    // 啟動時先檢查一次
    checkUpdate();

    // 暴露給 createPanel 使用（點開面板時重新檢查）
    widget._checkUpdate = checkUpdate;

    return widget;
  }

  // ═══════════════════════════════════════════════
  //  建立主面板
  // ═══════════════════════════════════════════════
  function createPanel() {
    // 頂部按鈕群
    const topbar = document.createElement('div');
    topbar.id = '__sch_topbar__';

    const mainBtn = document.createElement('button');
    mainBtn.id = BTN_ID; mainBtn.textContent = '⏱ 定時指令';

    const quickBtn = document.createElement('button');
    quickBtn.className = '__sch_quick_mainbtn';
    quickBtn.textContent = '🐱 米米快捷鍵';

    // 米米快捷鍵按鈕：只在米米預設開啟時顯示
    quickBtn.style.display = isMimiEnabled() ? 'inline-block' : 'none';
    topbar.append(quickBtn, mainBtn);
    document.body.appendChild(topbar);

    // 米米快捷鍵面板
    const quickPanel = document.createElement('div');
    quickPanel.id = '__sch_quick_panel__';

    const quickTitle = document.createElement('div');
    quickTitle.className = '__sch_quick_title';
    quickTitle.textContent = '🐱 米米快捷鍵';
    quickPanel.appendChild(quickTitle);

    const quickCmds = [
      { label: '帳戶餘額', cmd: '/balance' },
      { label: '股票資訊', cmd: '/portfolio' },
      { label: '貓娘狀態', cmd: '/nekomusume status' },
    ];
    quickCmds.forEach(({ label, cmd }) => {
      const btn = document.createElement('button');
      btn.className = '__sch_quick_btn';
      btn.innerHTML = `${label}<span>${cmd}</span>`;
      btn.addEventListener('click', e => {
        e.stopPropagation();
        sendMessage(cmd, 'bot', () => {});
        quickPanel.classList.remove('open');
      });
      quickPanel.appendChild(btn);
    });
    document.body.appendChild(quickPanel);

    quickBtn.addEventListener('click', e => {
      e.stopPropagation();
      quickPanel.classList.toggle('open');
      panel.classList.remove('open'); // 關閉另一個
    });

    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    // 頁籤
    const tabs = document.createElement('div');
    tabs.className = '__sch_tabs';

    const tabDefs = [
      { label: '⏱ 定時指令', page: '1' },
      { label: '▶▶ 連續指令', page: '2' },
      { label: '🔍 元素偵測', page: '3' },
    ];

    const pages = [buildPage1(), buildPage2(), buildPage3()];

    tabDefs.forEach((def, i) => {
      const tab = document.createElement('button');
      tab.className = `__sch_tab${i===0?' active':''}`;
      tab.textContent = def.label;
      tab.addEventListener('click', e => {
        e.stopPropagation();
        tabs.querySelectorAll('.__sch_tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        pages.forEach(p => p.classList.remove('active'));
        pages[i].classList.add('active');
      });
      tabs.appendChild(tab);
    });

    panel.appendChild(tabs);
    pages.forEach(p => panel.appendChild(p));

    // 底部 footer：左邊版本控制器，右邊米米預設開關
    const footer = document.createElement('div');
    footer.className = '__sch_footer';
    footer.appendChild(createVersionWidget());
    footer.appendChild(createMimiToggle());
    panel.appendChild(footer);

    document.body.appendChild(panel);

    // 初始渲染
    renderPage1List();
    renderPage2List();

    // 開關面板
    mainBtn.addEventListener('click', e => {
      e.stopPropagation();
      const opening = !panel.classList.contains('open');
      panel.classList.toggle('open');
      quickPanel.classList.remove('open');
      // 每次開啟時重新檢查版本
      if (opening) {
        const ver = document.getElementById('__sch_ver__');
        if (ver && ver._checkUpdate) ver._checkUpdate();
      }
    });

    // 點外部關閉（mousedown 防拖曳誤關）
    let mousedownInPanel = false;
    panel.addEventListener('mousedown', () => { mousedownInPanel = true; });
    quickPanel.addEventListener('mousedown', e => e.stopPropagation());
    document.addEventListener('mousedown', e => {
      if (e.target !== mainBtn && e.target !== quickBtn) mousedownInPanel = false;
    });
    document.addEventListener('click', e => {
      if (mousedownInPanel) return;
      if (!panel.contains(e.target) && e.target !== mainBtn) panel.classList.remove('open');
      if (!quickPanel.contains(e.target) && e.target !== quickBtn) quickPanel.classList.remove('open');
    });
  }

  // ═══════════════════════════════════════════════
  //  初始化
  // ═══════════════════════════════════════════════
  const observer = new MutationObserver(() => {
    const app = document.querySelector('[class*="app-"]');
    if (app && !document.getElementById(BTN_ID)) {
      observer.disconnect();
      setTimeout(() => {
        injectStyles();
        createPanel();
        if (isMimiEnabled()) applyMimiTasks(true);
        startAllTasks();
        startAllSeqGroups();
        console.log('[定時指令 v4] 已載入');
      }, 3000);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();