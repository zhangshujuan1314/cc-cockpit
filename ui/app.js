/**
 * CC Cockpit v0.1.0 — 重新设计的 UI
 */

const state = {
  ws: null,
  sessions: new Map(),
  activeSessionId: null,
  files: [],
  config: { pricing: {}, usd_to_cny: 7.25, cost_warning_threshold_cny: 50 },
  autoScroll: true,
  reconnectTimer: null,
  reconnectAttempts: 0,
};

const dom = {
  sessionItems: document.getElementById('session-items'),
  sessionCount: document.getElementById('session-count'),
  messageFlow: document.getElementById('message-flow'),
  fileItems: document.getElementById('file-items'),
  fileCount: document.getElementById('file-count'),
  wsDot: document.getElementById('ws-dot'),
  wsStatus: document.getElementById('ws-status'),
  costInput: document.getElementById('cost-input'),
  costOutput: document.getElementById('cost-output'),
  costCacheRead: document.getElementById('cost-cache-read'),
  costTotal: document.getElementById('cost-total'),
  costCard: document.getElementById('cost-card'),
  hooksStatus: document.getElementById('hooks-status'),
};

// ═══════════ WebSocket ═══════════

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}`);
  state.ws.onopen = () => { state.reconnectAttempts = 0; wsStatus(true); };
  state.ws.onclose = () => { wsStatus(false); scheduleReconnect(); };
  state.ws.onerror = () => {};
  state.ws.onmessage = e => { try { handle(JSON.parse(e.data)); } catch {} };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), 30000);
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connect(); }, delay);
}

function wsStatus(ok) {
  dom.wsDot.classList.toggle('connected', ok);
  dom.wsStatus.textContent = ok ? '已连接' : '断开';
}

// ═══════════ Message Router ═══════════

function handle(msg) {
  switch (msg.type) {
    case 'init': onInit(msg); break;
    case 'session:created': onSessionCreated(msg); break;
    case 'session:updated': onSessionUpdated(msg); break;
    case 'message': onMessage(msg); break;
    case 'messages': onMessagesBulk(msg); break;
    case 'files': onFilesUpdate(msg.files); break;
    case 'file:changed': onFileChanged(msg); break;
    case 'file:diff': onFileDiff(msg); break;
    case 'hook': console.log('[hook]', msg.event); break;
  }
}

function onInit(msg) {
  state.config = msg.config || state.config;
  for (const s of msg.sessions) state.sessions.set(s.sessionId, { ...s, messages: [], sidechains: new Map() });
  if (msg.files) onFilesUpdate(msg.files);
  renderSessions();
  if (msg.sessions.length > 0 && !state.activeSessionId) selectSession(msg.sessions[0].sessionId);
  updateCost();
  checkHooks();
}

function onSessionCreated(msg) {
  if (state.sessions.has(msg.sessionId)) return;
  state.sessions.set(msg.sessionId, {
    sessionId: msg.sessionId, projectName: msg.projectName, summary: '',
    lastActivity: new Date(), status: 'running', messageCount: 0,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    modelBreakdown: {}, messages: [], sidechains: new Map()
  });
  renderSessions();
  if (!state.activeSessionId) selectSession(msg.sessionId);
}

function onSessionUpdated(msg) {
  const s = state.sessions.get(msg.sessionId);
  if (!s) return;
  if (msg.detail) Object.assign(s, msg.detail);
  renderSessions();
  updateCost();
}

function onMessage(msg) {
  const { sessionId, message } = msg;
  const s = state.sessions.get(sessionId);
  if (!s) return;
  s.messages.push(message);
  s.messageCount = s.messages.length;
  s.lastActivity = new Date(message.timestamp);
  if (message.isSidechain) {
    if (!s.sidechains.has(message.id)) s.sidechains.set(message.id, []);
    s.sidechains.get(message.id).push(message);
  }
  if (sessionId === state.activeSessionId) {
    appendMsg(message);
    if (state.autoScroll) scrollBottom();
  }
  renderSessions();
  updateCost();
}

function onMessagesBulk(msg) {
  const s = state.sessions.get(msg.sessionId);
  if (!s) return;
  s.messages = msg.messages || [];
  s.messageCount = s.messages.length;
  if (msg.sessionId === state.activeSessionId) renderAllMessages();
}

// ═══════════ File Panel ═══════════

function onFilesUpdate(files) { state.files = files || []; renderFiles(); }

function onFileChanged(data) {
  const idx = state.files.findIndex(f => f.filePath === data.filePath);
  const entry = {
    filePath: data.filePath, basename: data.filePath.split(/[/\\]/).pop(),
    status: data.status, timestamp: data.timestamp,
    isToolWritten: data.isToolWritten || false, toolCall: data.toolCall || null,
    diff: null, diffSkipped: false, diffSkipReason: ''
  };
  if (idx >= 0) state.files[idx] = { ...state.files[idx], ...entry };
  else state.files.unshift(entry);
  renderFiles();
}

function onFileDiff(data) {
  const idx = state.files.findIndex(f => f.filePath === data.filePath);
  if (idx >= 0) {
    state.files[idx].diff = data.diff;
    state.files[idx].diffSkipped = data.diffSkipped;
    state.files[idx].diffSkipReason = data.diffSkipReason;
  }
  renderFiles();
}

function renderFiles() {
  dom.fileCount.textContent = state.files.length;
  if (!state.files.length) {
    dom.fileItems.innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted);font-size:12px">尚无文件改动</div>';
    return;
  }
  dom.fileItems.innerHTML = state.files.map((f, i) => {
    const icon = f.isToolWritten ? '⚡' : f.status === 'deleted' ? '🗑️' : f.status === 'created' ? '✨' : '📄';
    const iconClass = f.isToolWritten ? 'tool' : '';
    const statusClass = f.isToolWritten ? 'tool-written' : f.status;
    const time = f.timestamp ? fmtTime(new Date(f.timestamp)) : '';
    const tool = f.toolCall ? ` · ${f.toolCall.toolName}` : '';
    const diff = f.diffSkipped
      ? `<div class="diff-skipped">⏭️ ${esc(f.diffSkipReason || '跳过')}</div>`
      : f.diff ? renderDiff(f.diff) : '<div class="diff-skipped">无 diff</div>';
    return `<div class="file-card" data-i="${i}">
      <div class="file-top">
        <span class="file-icon ${iconClass}">${icon}</span>
        <span class="file-name" title="${esc(f.filePath)}">${esc(f.basename)}</span>
        <span class="file-status ${statusClass}">${f.status}</span>
      </div>
      <div class="file-meta"><span>${time}</span>${tool ? `<span>${tool}</span>` : ''}</div>
      <div class="diff-view">${diff}</div>
    </div>`;
  }).join('');
  dom.fileItems.querySelectorAll('.file-card').forEach(el =>
    el.addEventListener('click', () => el.classList.toggle('expanded'))
  );
}

function renderDiff(diff) {
  if (!diff) return '';
  const lines = diff.split('\n');
  let html = '<table class="diff-table">';
  let lineNum = 0;
  for (const line of lines) {
    lineNum++;
    const escLine = esc(line);
    if (line.startsWith('@@')) {
      html += `<tr><td class="diff-line-num"></td><td class="diff-line-code header">${escLine}</td></tr>`;
    } else if (line.startsWith('+')) {
      html += `<tr><td class="diff-line-num">${lineNum}</td><td class="diff-line-code add">${escLine}</td></tr>`;
    } else if (line.startsWith('-')) {
      html += `<tr><td class="diff-line-num">${lineNum}</td><td class="diff-line-code del">${escLine}</td></tr>`;
    } else {
      html += `<tr><td class="diff-line-num">${lineNum}</td><td class="diff-line-code ctx">${escLine}</td></tr>`;
    }
  }
  html += '</table>';
  return html;
}

// ═══════════ Hooks ═══════════

async function checkHooks() {
  try {
    const r = await fetch('/api/hooks/status');
    const d = await r.json();
    renderHooks(d);
  } catch {}
}

function renderHooks(d) {
  if (d.hooksInstalled) {
    dom.hooksStatus.innerHTML = '<span class="hooks-badge ok">✓ Hooks 已安装</span>';
  } else {
    dom.hooksStatus.innerHTML = '<span class="hooks-badge missing" id="install-hooks">⚠ 安装 Hooks</span>';
    document.getElementById('install-hooks')?.addEventListener('click', installHooks);
  }
}

async function installHooks() {
  try {
    const r = await fetch('/api/hooks/install', { method: 'POST' });
    const d = await r.json();
    if (d.success) { checkHooks(); alert(`Hooks 已安装\n备份: ${d.backupPath}`); }
    else alert('安装失败: ' + (d.error || '未知'));
  } catch (e) { alert('安装失败: ' + e.message); }
}

// ═══════════ Sessions ═══════════

function renderSessions() {
  const sorted = [...state.sessions.values()].sort((a, b) =>
    new Date(b.lastActivity || 0) - new Date(a.lastActivity || 0)
  );
  dom.sessionCount.textContent = sorted.length;

  dom.sessionItems.innerHTML = sorted.map(s => {
    const active = s.sessionId === state.activeSessionId;
    const status = s.status === 'running' ? 'running' : 'idle';
    const time = s.lastActivity ? fmtTime(new Date(s.lastActivity)) : '--';
    const tu = s.tokenUsage || {};
    const total = (tu.input || 0) + (tu.output || 0);
    const tokStr = total > 0 ? fmtTok(total) : '';
    const msgs = s.messageCount || 0;
    // 获取主要模型
    const models = Object.keys(s.modelBreakdown || {});
    const model = models[0] || '';
    const modelShort = model.replace(/^claude-/, '').replace(/-\d{8}$/, '').slice(0, 12);

    return `<div class="session-item ${active ? 'active' : ''}" data-sid="${s.sessionId}">
      <div class="session-top">
        <span class="status-indicator ${status}"></span>
        <span class="project-name">${esc(s.projectName || 'unknown')}</span>
        ${modelShort ? `<span class="model-badge">${esc(modelShort)}</span>` : ''}
      </div>
      <div class="session-stats">
        <span class="stat">💬 ${msgs}</span>
        ${tokStr ? `<span class="stat">🔤 ${tokStr}</span>` : ''}
        <span class="stat">🕐 ${time}</span>
      </div>
      ${s.summary ? `<div class="summary">${esc(s.summary)}</div>` : ''}
    </div>`;
  }).join('');

  dom.sessionItems.querySelectorAll('.session-item').forEach(el =>
    el.addEventListener('click', () => selectSession(el.dataset.sid))
  );
}

function selectSession(sid) {
  state.activeSessionId = sid;
  if (state.ws?.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify({ type: 'getMessages', sessionId: sid }));
  renderSessions();
  renderAllMessages();
}

// ═══════════ Messages ═══════════

function renderAllMessages() {
  const s = state.sessions.get(state.activeSessionId);
  dom.messageFlow.innerHTML = '';
  if (!s?.messages.length) {
    dom.messageFlow.innerHTML = '<div class="empty-state"><div class="icon">📡</div><div class="title">等待消息...</div><div class="desc">选择一个会话查看消息流</div></div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const m of s.messages) { const el = createMsgEl(m); if (el) frag.appendChild(el); }
  dom.messageFlow.appendChild(frag);
  scrollBottom();
}

function appendMsg(message) {
  dom.messageFlow.querySelector('.empty-state')?.remove();
  const el = createMsgEl(message);
  if (el) dom.messageFlow.appendChild(el);
}

function createMsgEl(m) {
  if (m.isSidechain) return createSidechain(m);
  const card = document.createElement('div');
  card.className = `msg ${m.type}`;
  card.innerHTML = `<div class="msg-header">
    <span class="msg-role">${m.type}</span>
    ${m.model ? `<span class="msg-model">${esc(m.model)}</span>` : ''}
    <span class="msg-time">${fmtTime(new Date(m.timestamp))}</span>
  </div>`;
  const body = document.createElement('div');
  body.className = 'msg-body';
  for (const b of m.blocks) {
    if (b.type === 'text') { const d = document.createElement('div'); d.textContent = b.text; body.appendChild(d); }
    else if (b.type === 'thinking') body.appendChild(createThinking(b));
    else if (b.type === 'tool_use') body.appendChild(createTool(b));
    else if (b.type === 'tool_result') body.appendChild(createResult(b));
    else if (b.type === 'raw') { const pre = document.createElement('pre'); pre.style.cssText = 'font-size:11px;color:var(--text-muted)'; pre.textContent = JSON.stringify(b.data, null, 2); body.appendChild(pre); }
  }
  card.appendChild(body);
  return card;
}

function createThinking(b) {
  const el = document.createElement('div');
  el.className = 'thinking-block';
  el.innerHTML = `<div class="thinking-header">💭 思考过程 <span style="float:right">▶</span></div>
    <div class="thinking-body">${esc(b.text)}</div>`;
  el.querySelector('.thinking-header').addEventListener('click', () => {
    el.classList.toggle('expanded');
    el.querySelector('.thinking-header span').textContent = el.classList.contains('expanded') ? '▼' : '▶';
  });
  return el;
}

function getToolTag(name) {
  if (['Read'].includes(name)) return 'read';
  if (['Write', 'Edit', 'MultiEdit'].includes(name)) return 'write';
  if (['Grep', 'Glob'].includes(name)) return 'search';
  if (['Bash', 'Agent'].includes(name)) return 'exec';
  return 'other';
}

function createTool(b) {
  const tag = getToolTag(b.name);
  const el = document.createElement('div');
  el.className = 'tool-card';
  el.innerHTML = `<div class="tool-header">
    <span class="tool-tag ${tag}">${b.name}</span>
    <span class="tool-preview">${esc(b.input || '')}</span>
    <span class="tool-toggle">▶</span>
  </div>
  <div class="tool-body">${esc(b.input || '(no input)')}</div>`;
  el.querySelector('.tool-header').addEventListener('click', () => {
    el.classList.toggle('expanded');
    el.querySelector('.tool-toggle').textContent = el.classList.contains('expanded') ? '▼' : '▶';
  });
  return el;
}

function createResult(b) {
  const el = document.createElement('div');
  el.className = 'tool-result' + (b.is_error ? ' error' : '');
  el.innerHTML = b.is_error
    ? `<strong>❌ Error:</strong> ${esc(b.content || '')}`
    : `<strong>→</strong> ${esc(b.content || '(empty)')}`;
  return el;
}

function createSidechain(m) {
  const el = document.createElement('div');
  el.className = 'sidechain';
  el.innerHTML = `<div class="sidechain-header">🔀 子任务 · ${m.blocks.length} 条消息 <span style="margin-left:auto">▶</span></div>
    <div class="sidechain-body">${m.blocks.map(b => `<div style="font-size:11px;padding:4px 0;color:var(--text-secondary)">${esc(b.text || JSON.stringify(b))}</div>`).join('')}</div>`;
  el.querySelector('.sidechain-header').addEventListener('click', () => {
    el.classList.toggle('expanded');
    el.querySelector('.sidechain-header span').textContent = el.classList.contains('expanded') ? '▼' : '▶';
  });
  return el;
}

// ═══════════ Cost ═══════════

function getModelPricing(model) {
  if (!model) return null;
  const p = state.config.pricing || {};
  const m = model.toLowerCase();
  if (p[m]) return p[m];
  for (const k of Object.keys(p).sort((a, b) => b.length - a.length))
    if (m.startsWith(k.toLowerCase())) return p[k];
  return null;
}

function updateCost() {
  let ti = 0, to = 0, tr = 0, costUsd = 0, hasUnknown = false;
  for (const s of state.sessions.values()) {
    const u = s.tokenUsage || {};
    ti += u.input || 0; to += u.output || 0; tr += u.cacheRead || 0;
    if (s.modelBreakdown) {
      for (const [model, usage] of Object.entries(s.modelBreakdown)) {
        const p = getModelPricing(model);
        if (p) costUsd += ((usage.input||0)/1e6)*p.input + ((usage.output||0)/1e6)*p.output + ((usage.cacheRead||0)/1e6)*p.cache_read + ((usage.cacheWrite||0)/1e6)*p.cache_write;
        else hasUnknown = true;
      }
    }
  }
  dom.costInput.textContent = fmtTok(ti);
  dom.costOutput.textContent = fmtTok(to);
  dom.costCacheRead.textContent = fmtTok(tr);

  if (hasUnknown && costUsd === 0) {
    dom.costTotal.textContent = '未知定价 ⚙️';
    dom.costCard.className = 'metric-card cost unknown';
    dom.costCard.onclick = () => showPricingModal();
  } else {
    const cny = costUsd * state.config.usd_to_cny;
    dom.costTotal.textContent = `$${costUsd.toFixed(4)} (¥${cny.toFixed(2)})`;
    dom.costCard.className = `metric-card cost${cny >= state.config.cost_warning_threshold_cny ? ' warning' : ''}`;
    dom.costCard.onclick = hasUnknown ? () => showPricingModal() : null;
  }
}

function showPricingModal() {
  const models = new Set();
  for (const s of state.sessions.values()) if (s.modelBreakdown) Object.keys(s.modelBreakdown).forEach(m => models.add(m));
  const existing = state.config.pricing || {};
  const rows = [...models].map(m => {
    const p = existing[m] || {};
    return `<tr>
      <td style="font-weight:600;font-family:'Cascadia Code',monospace">${esc(m)}</td>
      <td><input data-m="${m}" data-f="input" value="${p.input||''}" placeholder="USD/M"></td>
      <td><input data-m="${m}" data-f="output" value="${p.output||''}" placeholder="USD/M"></td>
      <td><input data-m="${m}" data-f="cache_read" value="${p.cache_read||''}" placeholder="USD/M"></td>
      <td><input data-m="${m}" data-f="cache_write" value="${p.cache_write||''}" placeholder="USD/M"></td>
    </tr>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <h3>⚙️ 设置模型定价</h3>
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:16px">价格单位：USD / 百万 token</p>
    <table>
      <tr><th>模型</th><th>Input</th><th>Output</th><th>Cache-R</th><th>Cache-W</th></tr>
      ${rows}
    </table>
    <div class="modal-btns">
      <button class="btn btn-cancel" id="p-cancel">取消</button>
      <button class="btn btn-primary" id="p-save">保存</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#p-cancel').onclick = () => overlay.remove();
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#p-save').onclick = () => {
    for (const inp of overlay.querySelectorAll('input[data-m]')) {
      const m = inp.dataset.m, f = inp.dataset.f, v = parseFloat(inp.value);
      if (!state.config.pricing[m]) state.config.pricing[m] = {};
      if (!isNaN(v)) state.config.pricing[m][f] = v;
    }
    overlay.remove();
    updateCost();
    fetch('/api/pricing', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.config.pricing) }).catch(() => {});
  };
}

// ═══════════ Scroll ═══════════

function scrollBottom() {
  requestAnimationFrame(() => { dom.messageFlow.scrollTop = dom.messageFlow.scrollHeight; });
}
dom.messageFlow.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = dom.messageFlow;
  state.autoScroll = scrollHeight - scrollTop - clientHeight < 50;
  dom.messageFlow.classList.toggle('paused', !state.autoScroll);
});
dom.messageFlow.addEventListener('click', e => {
  if (dom.messageFlow.classList.contains('paused') && e.target === dom.messageFlow) {
    state.autoScroll = true; dom.messageFlow.classList.remove('paused'); scrollBottom();
  }
});

// ═══════════ Util ═══════════

function fmtTime(d) {
  if (!d || isNaN(d)) return '--:--';
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
}
function fmtTok(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'K';
  return n.toString();
}
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ═══════════ Init ═══════════

fetch('/api/pricing').then(r => r.json()).then(p => { state.config.pricing = p; updateCost(); }).catch(() => {});
connect();
