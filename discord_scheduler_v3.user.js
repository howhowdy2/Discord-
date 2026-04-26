// ==UserScript==
// @name         Discord 定時指令
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  在 Discord 右上角新增定時指令面板
// @author       howhowdy2
// @match        https://discord.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

(function () {
  'use strict';

  // ────────────────────────────────────────────
  //  資料層
  // ────────────────────────────────────────────
  function loadTasks() {
    try { return JSON.parse(GM_getValue('scheduler_tasks', '[]')); }
    catch { return []; }
  }

  function saveTasks() {
    GM_setValue('scheduler_tasks', JSON.stringify(
      tasks.map(({ timerId, ...rest }) => rest)
    ));
  }

  let tasks = loadTasks();
  tasks.forEach(t => { t.timerId = null; t.nextRun = Date.now() + t.intervalMs; });

  // ────────────────────────────────────────────
  //  執行層：支援 slash指令 / 一般對話 兩種模式
  // ────────────────────────────────────────────
  function pressEnter(editor) {
    editor.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13,
      bubbles: true, cancelable: true
    }));
  }

  function sendMessage(command, mode) {
    const editor = document.querySelector('[data-slate-editor="true"]');
    if (!editor) {
      console.warn('[定時指令] 找不到輸入框，請先點選一個頻道');
      return false;
    }

    editor.focus();

    // 先清空輸入框內現有內容，避免前面多出雜字
    document.execCommand('selectAll', false, null);
    document.execCommand('delete', false, null);

    // 注入文字
    setTimeout(() => {
      injectText(editor, command);

      if (mode === 'bot') {
        // Bot 指令（slash command）：
        // 第一次 Enter 確認 Discord 自動補全選單
        // 第二次 Enter 才真正送出
        setTimeout(() => {
          pressEnter(editor);
          setTimeout(() => pressEnter(editor), 300);
        }, 150);
      } else {
        // 一般對話：單次 Enter 送出
        setTimeout(() => pressEnter(editor), 150);
      }
    }, 50);

    return true;
  }

  function injectText(editor, text) {
    // 優先用 paste 事件（對 React contenteditable 最穩定）
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
      // fallback
      document.execCommand('insertText', false, text);
    }
  }

  // ────────────────────────────────────────────
  //  定時器層
  // ────────────────────────────────────────────
  function startTask(task) {
    if (task.timerId) clearInterval(task.timerId);
    task.nextRun = Date.now() + task.intervalMs;
    task.timerId = setInterval(() => {
      if (!task.enabled) return;
      const ok = sendMessage(task.command, task.mode);
      task.nextRun = Date.now() + task.intervalMs;
      console.log(`[定時指令] ${task.label} → ${task.command} (${ok ? '✅' : '⚠️'})`);
    }, task.intervalMs);
  }

  function stopTask(task) {
    if (task.timerId) { clearInterval(task.timerId); task.timerId = null; }
    task.nextRun = null;
  }

  function startAllEnabled() {
    tasks.forEach(t => { if (t.enabled) startTask(t); });
  }

  // ────────────────────────────────────────────
  //  UI 層
  // ────────────────────────────────────────────
  const PANEL_ID = '__sch_panel__';
  const BTN_ID   = '__sch_mainbtn__';
  const STYLE_ID = '__sch_style__';

  function injectStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = `
      #${BTN_ID} {
        position: fixed; top: 8px; right: 56px; z-index: 9999;
        background: #5865F2; color: #fff; border: none;
        border-radius: 6px; padding: 5px 12px;
        font-size: 13px; font-weight: 600; cursor: pointer;
        font-family: 'gg sans','Noto Sans',sans-serif;
        transition: background .15s;
      }
      #${BTN_ID}:hover { background: #4752C4; }

      #${PANEL_ID} {
        display: none; position: fixed; top: 44px; right: 56px;
        z-index: 9998; width: 350px; max-height: 82vh;
        background: #2b2d31; border: 1px solid #1e1f22;
        border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.5);
        font-family: 'gg sans','Noto Sans',sans-serif;
        color: #dbdee1; flex-direction: column; overflow: hidden;
      }
      #${PANEL_ID}.open { display: flex; }

      .__sch_head {
        padding: 13px 16px 11px; font-size: 14px; font-weight: 700;
        color: #fff; border-bottom: 1px solid #1e1f22; letter-spacing: .4px;
      }

      .__sch_form {
        padding: 12px 14px; border-bottom: 1px solid #1e1f22;
        display: flex; flex-direction: column; gap: 8px;
      }

      .__sch_form input[type="text"],
      .__sch_form input[type="number"] {
        background: #1e1f22; border: 1px solid #3f4248;
        border-radius: 5px; color: #dbdee1;
        padding: 7px 10px; font-size: 13px;
        width: 100%; box-sizing: border-box;
        outline: none; transition: border .15s;
        font-family: inherit;
      }
      .__sch_form input:focus { border-color: #5865F2; }
      .__sch_form input::placeholder { color: #555861; }

      .__sch_row { display: flex; gap: 6px; align-items: center; }

      .__sch_form input[type="number"] { width: 80px; flex-shrink: 0; }

      .__sch_form select {
        background: #1e1f22; border: 1px solid #3f4248;
        border-radius: 5px; color: #dbdee1;
        padding: 7px 8px; font-size: 13px;
        flex: 1; outline: none; cursor: pointer; font-family: inherit;
      }

      /* 模式切換 toggle */
      .__sch_mode_wrap {
        display: flex; gap: 0; border: 1px solid #3f4248;
        border-radius: 5px; overflow: hidden;
      }
      .__sch_mode_btn {
        flex: 1; padding: 7px 6px; font-size: 12px; font-weight: 600;
        border: none; cursor: pointer; font-family: inherit;
        background: #1e1f22; color: #6d6f78;
        transition: background .15s, color .15s;
      }
      .__sch_mode_btn.active { background: #5865F2; color: #fff; }

      .__sch_add_btn {
        background: #5865F2; color: #fff; border: none;
        border-radius: 5px; padding: 8px; font-size: 13px;
        font-weight: 600; cursor: pointer;
        transition: background .15s; font-family: inherit;
      }
      .__sch_add_btn:hover { background: #4752C4; }

      .__sch_list {
        overflow-y: auto; flex: 1;
        padding: 8px 10px; display: flex;
        flex-direction: column; gap: 6px;
      }
      .__sch_list::-webkit-scrollbar { width: 4px; }
      .__sch_list::-webkit-scrollbar-thumb { background: #3f4248; border-radius: 2px; }

      .__sch_empty {
        color: #555861; font-size: 12px;
        text-align: center; padding: 20px 0;
      }

      .__sch_card {
        background: #1e1f22; border: 1px solid #3f4248;
        border-radius: 7px; padding: 10px 11px;
        display: flex; flex-direction: column; gap: 4px;
        transition: border-color .15s;
      }
      .__sch_card.active { border-color: #5865F2; }

      .__sch_card_top {
        display: flex; justify-content: space-between; align-items: center;
      }
      .__sch_card_label {
        font-size: 13px; font-weight: 600; color: #fff;
        white-space: nowrap; overflow: hidden;
        text-overflow: ellipsis; max-width: 170px;
      }
      .__sch_card_btns { display: flex; gap: 4px; flex-shrink: 0; }

      .__sch_card_meta {
        font-size: 11px; color: #6d6f78;
        display: flex; gap: 6px; align-items: center;
        flex-wrap: wrap;
      }
      .__sch_badge {
        font-size: 10px; padding: 1px 6px; border-radius: 3px;
        font-weight: 700; letter-spacing: .3px;
      }
      .__sch_badge.bot  { background: #4f46e5; color: #c7d2fe; }
      .__sch_badge.chat { background: #15803d; color: #bbf7d0; }

      .__sch_card_cmd {
        font-size: 11px; color: #949ba4;
        font-family: 'Consolas', monospace;
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .__sch_card_countdown { color: #23a55a; }
      .__sch_card_countdown.off { color: #f23f43; }

      .__sch_icon_btn {
        background: none; border: none; cursor: pointer;
        border-radius: 4px; padding: 3px 7px; font-size: 13px;
        color: #b5bac1; transition: background .15s, color .15s;
        line-height: 1;
      }
      .__sch_icon_btn:hover { background: #3f4248; color: #fff; }
      .__sch_icon_btn.is-on  { color: #23a55a; }
      .__sch_icon_btn.is-off { color: #f23f43; }
    `;
    document.head.appendChild(s);
  }

  function fmtMs(ms) {
    const s = ms / 1000;
    if (s < 60)   return `${s}秒`;
    if (s < 3600) return `${Math.round(s/60)}分鐘`;
    return `${+(s/3600).toFixed(1)}小時`;
  }

  function fmtCountdown(nextRun) {
    if (!nextRun) return '已停止';
    const diff = Math.max(0, nextRun - Date.now());
    const s = Math.floor(diff / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) return `${h}h ${m % 60}m 後`;
    if (m > 0) return `${m}m ${s % 60}s 後`;
    return `${s}s 後`;
  }

  // ── 渲染指令列表（純 DOM，不用 innerHTML onclick）──
  function renderTaskList() {
    const list = document.getElementById('__sch_list_inner__');
    if (!list) return;

    if (tasks.length === 0) {
      list.innerHTML = '<div class="__sch_empty">尚無定時指令</div>';
      return;
    }

    // 清空並重建（保留已有 DOM 避免閃爍可用 diff，這裡簡單重建）
    list.innerHTML = '';
    tasks.forEach(t => {
      const card = document.createElement('div');
      card.className = `__sch_card${t.enabled ? ' active' : ''}`;
      card.dataset.id = t.id;

      // 上排：名稱 + 按鈕群
      const top = document.createElement('div');
      top.className = '__sch_card_top';

      const label = document.createElement('span');
      label.className = '__sch_card_label';
      label.title = t.label;
      label.textContent = t.label;

      const btns = document.createElement('div');
      btns.className = '__sch_card_btns';

      // ▶ / ⏸ 按鈕
      const toggleBtn = document.createElement('button');
      toggleBtn.className = `__sch_icon_btn ${t.enabled ? 'is-on' : 'is-off'}`;
      toggleBtn.title = t.enabled ? '暫停' : '啟動';
      toggleBtn.textContent = t.enabled ? '⏸' : '▶';
      toggleBtn.addEventListener('click', () => schToggle(t.id));

      // ⚡ 立即執行
      const nowBtn = document.createElement('button');
      nowBtn.className = '__sch_icon_btn';
      nowBtn.title = '立即執行';
      nowBtn.textContent = '⚡';
      nowBtn.addEventListener('click', () => schNow(t.id));

      // ✕ 刪除
      const delBtn = document.createElement('button');
      delBtn.className = '__sch_icon_btn';
      delBtn.title = '刪除';
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => schDelete(t.id));

      btns.append(toggleBtn, nowBtn, delBtn);
      top.append(label, btns);

      // 指令文字
      const cmd = document.createElement('div');
      cmd.className = '__sch_card_cmd';
      cmd.textContent = t.command;

      // meta 行
      const meta = document.createElement('div');
      meta.className = '__sch_card_meta';

      const badge = document.createElement('span');
      badge.className = `__sch_badge ${t.mode === 'bot' ? 'bot' : 'chat'}`;
      badge.textContent = t.mode === 'bot' ? 'BOT' : '對話';

      const interval = document.createElement('span');
      interval.textContent = `每 ${fmtMs(t.intervalMs)}`;

      const countdown = document.createElement('span');
      countdown.className = `__sch_card_countdown${t.enabled ? '' : ' off'}`;
      countdown.dataset.nextrun = t.nextRun || '';
      countdown.textContent = t.enabled ? fmtCountdown(t.nextRun) : '已停止';

      meta.append(badge, interval, countdown);
      card.append(top, cmd, meta);
      list.appendChild(card);
    });
  }

  // 只更新倒數，不重建整個 DOM（效能優化）
  function updateCountdowns() {
    document.querySelectorAll('[data-nextrun]').forEach(el => {
      const id = el.closest('[data-id]')?.dataset.id;
      const task = tasks.find(t => t.id === id);
      if (!task) return;
      el.textContent = task.enabled ? fmtCountdown(task.nextRun) : '已停止';
      el.className = `__sch_card_countdown${task.enabled ? '' : ' off'}`;
    });
  }

  let countdownTimer = null;
  function startCountdownDisplay() {
    if (countdownTimer) return;
    countdownTimer = setInterval(updateCountdowns, 1000);
  }

  // ────────────────────────────────────────────
  //  操作函式（用閉包，不掛 window）
  // ────────────────────────────────────────────
  function schToggle(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    task.enabled = !task.enabled;
    task.enabled ? startTask(task) : stopTask(task);
    saveTasks();
    renderTaskList();
  }

  function schNow(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    sendMessage(task.command, task.mode);
    task.nextRun = Date.now() + task.intervalMs;
    updateCountdowns();
  }

  function schDelete(id) {
    const task = tasks.find(t => t.id === id);
    if (task) stopTask(task);
    tasks = tasks.filter(t => t.id !== id);
    saveTasks();
    renderTaskList();
  }

  // ────────────────────────────────────────────
  //  建立面板
  // ────────────────────────────────────────────
  function createPanel() {
    // 主按鈕
    const mainBtn = document.createElement('button');
    mainBtn.id = BTN_ID;
    mainBtn.textContent = '⏱ 定時指令';
    document.body.appendChild(mainBtn);

    // 面板容器
    const panel = document.createElement('div');
    panel.id = PANEL_ID;

    // ── 標題 ──
    const head = document.createElement('div');
    head.className = '__sch_head';
    head.textContent = '⏱ 定時指令';

    // ── 表單 ──
    const form = document.createElement('div');
    form.className = '__sch_form';

    // 名稱輸入
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.id = '__sch_inp_label__';
    labelInput.placeholder = '名稱（如：派遣領取）';
    labelInput.maxLength = 20;

    // 指令輸入
    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    cmdInput.id = '__sch_inp_cmd__';
    cmdInput.placeholder = '指令文字';

    // 模式切換
    const modeWrap = document.createElement('div');
    modeWrap.className = '__sch_mode_wrap';

    const botBtn = document.createElement('button');
    botBtn.className = '__sch_mode_btn active';
    botBtn.dataset.mode = 'bot';
    botBtn.textContent = '🤖 機器人指令';

    const chatBtn = document.createElement('button');
    chatBtn.className = '__sch_mode_btn';
    chatBtn.dataset.mode = 'chat';
    chatBtn.textContent = '💬 一般對話';

    let selectedMode = 'bot';
    [botBtn, chatBtn].forEach(btn => {
      btn.addEventListener('click', () => {
        selectedMode = btn.dataset.mode;
        botBtn.classList.toggle('active', selectedMode === 'bot');
        chatBtn.classList.toggle('active', selectedMode === 'chat');
      });
    });
    modeWrap.append(botBtn, chatBtn);

    // 時間列
    const timeRow = document.createElement('div');
    timeRow.className = '__sch_row';

    const timeInput = document.createElement('input');
    timeInput.type = 'number';
    timeInput.id = '__sch_inp_time__';
    timeInput.value = '23';
    timeInput.min = '1';
    timeInput.placeholder = '時間';

    const unitSel = document.createElement('select');
    unitSel.id = '__sch_inp_unit__';
    [['分鐘', '60000'], ['小時', '3600000'], ['秒', '1000']].forEach(([txt, val]) => {
      const opt = document.createElement('option');
      opt.value = val; opt.textContent = txt;
      unitSel.appendChild(opt);
    });

    timeRow.append(timeInput, unitSel);

    // 新增按鈕
    const addBtn = document.createElement('button');
    addBtn.className = '__sch_add_btn';
    addBtn.textContent = '＋ 新增定時指令';
    addBtn.addEventListener('click', () => {
      const label   = labelInput.value.trim();
      const command = cmdInput.value.trim();
      const time    = parseFloat(timeInput.value);
      const unit    = parseInt(unitSel.value);

      if (!label)           { alert('請輸入名稱'); return; }
      if (!command)         { alert('請輸入指令'); return; }
      if (!time || time<=0) { alert('請輸入有效時間'); return; }

      const task = {
        id: Date.now().toString(),
        label, command,
        mode: selectedMode,
        intervalMs: Math.round(time * unit),
        enabled: true,
        nextRun: Date.now() + Math.round(time * unit),
        timerId: null
      };

      tasks.push(task);
      saveTasks();
      startTask(task);
      renderTaskList();

      labelInput.value = '';
      cmdInput.value   = '';
      timeInput.value  = '23';
    });

    form.append(labelInput, cmdInput, modeWrap, timeRow, addBtn);

    // ── 指令列表 ──
    const listWrap = document.createElement('div');
    listWrap.className = '__sch_list';
    const listInner = document.createElement('div');
    listInner.id = '__sch_list_inner__';
    listInner.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
    listWrap.appendChild(listInner);

    panel.append(head, form, listWrap);
    document.body.appendChild(panel);

    // 開關面板
    mainBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('open');
    });

    // 新增按鈕阻止冒泡，避免觸發外部關閉
    addBtn.addEventListener('click', (e) => e.stopPropagation());

    // 點外部關閉：改用 mousedown 而非 click
    // 這樣在面板內拖曳選取文字時不會意外關閉
    let mousedownInPanel = false;
    panel.addEventListener('mousedown', () => { mousedownInPanel = true; });
    document.addEventListener('mousedown', (e) => {
      if (e.target !== mainBtn) mousedownInPanel = false;
    });
    document.addEventListener('click', (e) => {
      if (mousedownInPanel) return;         // mousedown 在面板內，忽略
      if (panel.contains(e.target)) return; // click 也在面板內，忽略
      if (e.target === mainBtn) return;     // 主按鈕自己處理
      panel.classList.remove('open');
    });

    renderTaskList();
    startCountdownDisplay();
  }

  // ────────────────────────────────────────────
  //  初始化
  // ────────────────────────────────────────────
  const observer = new MutationObserver(() => {
    const app = document.querySelector('[class*="app-"]');
    if (app && !document.getElementById(BTN_ID)) {
      observer.disconnect();
      setTimeout(() => {
        injectStyles();
        createPanel();
        startAllEnabled();
        console.log('[定時指令 v2] 已載入，共', tasks.length, '個指令');
      }, 3000);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
