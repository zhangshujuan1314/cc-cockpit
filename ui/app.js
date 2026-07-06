/**
 * CC Cockpit - 前端应用（M3/M4 完整版）
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
  hooksInstalled: false
};

const dom = {
  sessionItems: document.getElementById('session-items'),
  messageFlow: document.getElementById('message-flow'),
  emptyState: document.getElementById('empty-state'),
  fileItems: document.getElementById('file-items'),
  fileCount: document.getElementById('file-count'),
  wsDot: document.getElementById('ws-dot'),
  wsStatus: document.getElementById('ws-status'),
  costInput: document.getElementById('cost-input'),
  costOutput: document.getElementById('cost-output'),
  costCacheRead: document.getElementById('cost-cache-read'),
  costCacheWrite: document.getElementById('cost-cache-write'),
  costTotal: document.getElementById('cost-total'),
  hooksStatus: document.getElementById('hooks-status')
};

// ═══════════ WebSocket ═══════════

function connectWebSocket() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}`);

  state.ws.onopen = () => {
    state.reconnectAttempts = 0;
    updateConnectionStatus(true);
  };
  state.ws.onclose = () => {
    updateConnectionStatus(false);
    scheduleReconnect();
  };
  state.ws.onerror = () => {};
  state.ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch (err) { console.error('[ws]', err); }
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), 30000);
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connectWebSocket(); }, delay);
}

function updateConnectionStatus(ok) {
  dom.wsDot.classList.toggle('connected', ok);
  dom.wsStatus.textContent = ok ? '已连接' : '断开';
}

// ═══════════ 消息处理 ═══════════

function handleMessage(msg) {
  switch (msg.type) {
    case 'init': handleInit(msg); break;
    case 'session:created': handleSessionCreated(msg); break;
    case 'session:updated': handleSessionUpdated(msg); break;
    case 'message': handleNewMessage(msg); break;
    case 'messages': handleMessagesBulk(msg); break;
    case 'files': handleFilesUpdate(msg.files); break;
    case 'file:changed': handleFileChanged(msg); break;
    case 'file:diff': handleFileDiff(msg); break;
    case 'hook': handleHook(msg); break;
  }
}

function handleInit(msg) {
  state.config = msg.config || state.config;
  for (const s of msg.sessions) {
    state.sessions.set(s.sessionId, { ...s, messages: [], sidechains: new Map() });
  }
  if (msg.files) handleFilesUpdate(msg.files);
  renderSessionList();
  if (msg.sessions.length > 0 && !state.activeSessionId) selectSession(msg.sessions[0].sessionId);
  updateCostBar();
  checkHooksStatus();
}

function handleSessionCreated(msg) {
  if (state.sessions.has(msg.sessionId)) return;
  state.sessions.set(msg.sessionId, {
    sessionId: msg.sessionId, projectName: msg.projectName, summary: '',
    lastActivity: new Date(), status: 'running', messageCount: 0,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    modelBreakdown: {}, messages: [], sidechains: new Map()
  });
  renderSessionList();
  if (!state.activeSessionId) selectSession(msg.sessionId);
}

function handleSessionUpdated(msg) {
  const s = state.sessions.get(msg.sessionId);
  if (!s) return;
  if (msg.detail) Object.assign(s, msg.detail);
  renderSessionList();
  updateCostBar();
}

function handleNewMessage(msg) {
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
    appendMessage(message);
    if (state.autoScroll) scrollToBottom();
  }
  renderSessionList();
  updateCostBar();
}

function handleMessagesBulk(msg) {
  const s = state.sessions.get(msg.sessionId);
  if (!s) return;
  s.messages = msg.messages || [];
  s.messageCount = s.messages.length;
  if (msg.sessionId === state.activeSessionId) renderAllMessages();
}

function handleHook(msg) {
  console.log('[hook]', msg.event);
}

// ═══════════ 文件面板 ═══════════

function handleFilesUpdate(files) {
  state.files = files || [];
  renderFilePanel();
}

function handleFileChanged(data) {
  const idx = state.files.findIndex(f => f.filePath === data.filePath);
  const entry = {
    filePath: data.filePath,
    basename: data.filePath.split(/[/\\]/).pop(),
    status: data.status,
    timestamp: data.timestamp,
    isToolWritten: data.isToolWritten || false,
    toolCall: data.toolCall || null,
    diff: null, diffSkipped: false, diffSkipReason: ''
  };
  if (idx >= 0) state.files[idx] = { ...state.files[idx], ...entry };
  else state.files.unshift(entry);
  renderFilePanel();
}

function handleFileDiff(data) {
  const idx = state.files.findIndex(f => f.filePath === data.filePath);
  if (idx >= 0) {
    state.files[idx].diff = data.diff;
    state.files[idx].diffSkipped = data.diffSkipped;
    state.files[idx].diffSkipReason = data.diffSkipReason;
  }
  renderFilePanel();
}

function renderFilePanel() {
  dom.fileCount.textContent = state.files.length;
  if (state.files.length === 0) {
    dom.fileItems.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-muted);font-size:11px">尚无文件改动</div>';
    return;
  }

  const html = state.files.map((f, i) => {
    const icon = f.isToolWritten ? '⚡' : (f.status === 'deleted' ? '🗑️' : f.status === 'created' ? '✨' : '📝');
    const iconClass = f.isToolWritten ? 'tool' : '';
    const statusClass = f.isToolWritten ? 'tool-written' : f.status;
    const timeStr = f.timestamp ? formatTime(new Date(f.timestamp)) : '';
    const toolInfo = f.toolCall ? ` · ${f.toolCall.toolName}` : '';
    const diffHtml = f.diffSkipped
      ? `<div class="diff-skipped">⏭️ ${escapeHtml(f.diffSkipReason || '跳过 diff')}</div>`
      : (f.diff ? renderDiff(f.diff) : '<div class="diff-skipped" style="color:var(--text-muted)">无 diff 数据</div>');

    return `<div class="file-card" data-idx="${i}">
      <div class="file-header">
        <span class="file-icon ${iconClass}">${icon}</span>
        <span class="file-name" title="${escapeHtml(f.filePath)}">${escapeHtml(f.basename)}</span>
        <span class="file-status ${statusClass}">${f.status}</span>
      </div>
      <div class="file-meta">${timeStr}${toolInfo}</div>
      <div class="diff-view">${diffHtml}</div>
    </div>`;
  }).join('');

  dom.fileItems.innerHTML = html;
  dom.fileItems.querySelectorAll('.file-card').forEach(el => {
    el.addEventListener('click', () => el.classList.toggle('expanded'));
  });
}

function renderDiff(diff) {
  if (!diff) return '';
  const lines = diff.split('\n');
  return lines.map(line => {
    const escaped = escapeHtml(line);
    if (line.startsWith('@@')) return `<div class="diff-line header">${escaped}</div>`;
    if (line.startsWith('+')) return `<div class="diff-line add">${escaped}</div>`;
    if (line.startsWith('-')) return `<div class="diff-line del">${escaped}</div>`;
    return `<div class="diff-line ctx">${escaped}</div>`;
  }).join('');
}

// ═══════════ Hooks 状态 ═══════════

async function checkHooksStatus() {
  try {
    const res = await fetch('/api/hooks/status');
    const data = await res.json();
    state.hooksInstalled = data.hooksInstalled;
    renderHooksStatus(data);
  } catch {}
}

function renderHooksStatus(data) {
  if (data.hooksInstalled) {
    dom.hooksStatus.innerHTML = '<span class="hook-badge ok">✓ Hooks</span>';
  } else {
    dom.hooksStatus.innerHTML = '<span class="hook-badge missing" id="install-hooks">⚠ 安装 Hooks</span>';
    document.getElementById('install-hooks')?.addEventListener('click', installHooks);
  }
}

async function installHooks() {
  try {
    const res = await fetch('/api/hooks/install', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      checkHooksStatus();
      alert(`Hooks 已安装\n备份: ${data.backupPath}\n变更: ${data.changes.join(', ')}`);
    } else {
      alert('安装失败: ' + (data.error || '未知错误'));
    }
  } catch (err) {
    alert('安装失败: ' + err.message);
  }
}

// ═══════════ 会话列表 ═══════════

function renderSessionList() {
  const sorted = [...state.sessions.values()].sort((a, b) => {
    return (new Date(b.lastActivity || 0)) - (new Date(a.lastActivity || 0));
  });

  dom.sessionItems.innerHTML = sorted.map(s => {
    const isActive = s.sessionId === state.activeSessionId;
    const statusClass = s.status === 'running' ? 'running' : 'idle';
    const timeStr = s.lastActivity ? formatTime(new Date(s.lastActivity)) : '--';
    const tu = s.tokenUsage || {};
    const totalTok = (tu.input || 0) + (tu.output || 0);
    const tokStr = totalTok > 0 ? ' · ' + formatTokens(totalTok) + ' tok' : '';
    const summary = s.summary || `${s.messageCount || 0} 条消息`;

    return `<div class="session-item ${isActive ? 'active' : ''}" data-sid="${s.sessionId}">
      <div class="session-header">
        <span class="status-dot ${statusClass}"></span>
        <span class="project-name">${escapeHtml(s.projectName || 'unknown')}</span>
      </div>
      <div class="session-meta"><span>${timeStr}</span><span>${s.messageCount || 0} msgs${tokStr}</span></div>
      <div class="summary">${escapeHtml(summary)}</div>
    </div>`;
  }).join('');

  dom.sessionItems.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => selectSession(el.dataset.sid));
  });
}

function selectSession(sid) {
  state.activeSessionId = sid;
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'getMessages', sessionId: sid }));
  }
  renderSessionList();
  renderAllMessages();
}

// ═══════════ 消息流 ═══════════

function renderAllMessages() {
  const s = state.sessions.get(state.activeSessionId);
  dom.messageFlow.innerHTML = '';
  if (!s || s.messages.length === 0) {
    dom.messageFlow.innerHTML = '<div class="empty-state"><div class="icon">📡</div><div class="title">等待消息...</div></div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const m of s.messages) { const el = createMessageEl(m); if (el) frag.appendChild(el); }
  dom.messageFlow.appendChild(frag);
  scrollToBottom();
}

function appendMessage(message) {
  dom.messageFlow.querySelector('.empty-state')?.remove();
  const el = createMessageEl(message);
  if (el) dom.messageFlow.appendChild(el);
}

function createMessageEl(message) {
  if (message.isSidechain) return createSidechainEl(message);

  const card = document.createElement('div');
  card.className = `message-card ${message.type}`;
  card.innerHTML = `<div class="message-header">
    <span class="message-role">${message.type.toUpperCase()}</span>
    ${message.model ? `<span class="message-model">${escapeHtml(message.model)}</span>` : ''}
    <span class="message-time">${formatTime(new Date(message.timestamp))}</span>
  </div>`;

  const body = document.createElement('div');
  body.className = 'message-body';

  for (const block of message.blocks) {
    if (block.type === 'text') {
      const d = document.createElement('div');
      d.textContent = block.text;
      body.appendChild(d);
    } else if (block.type === 'thinking') {
      const det = document.createElement('details');
      det.style.cssText = 'margin:4px 0;font-size:11px;color:var(--text-muted)';
      det.innerHTML = `<summary style="cursor:pointer">💭 思考过程...</summary>
        <pre style="white-space:pre-wrap;margin:4px 0;padding:6px;background:var(--bg-tertiary);border-radius:3px;font-size:11px">${escapeHtml(block.text)}</pre>`;
      body.appendChild(det);
    } else if (block.type === 'tool_use') {
      body.appendChild(createToolCard(block));
    } else if (block.type === 'tool_result') {
      body.appendChild(createToolResultEl(block));
    } else if (block.type === 'raw') {
      const pre = document.createElement('pre');
      pre.style.cssText = 'font-size:11px;color:var(--text-muted)';
      pre.textContent = JSON.stringify(block.data, null, 2);
      body.appendChild(pre);
    }
  }
  card.appendChild(body);
  return card;
}

function createToolCard(block) {
  const tool = document.createElement('div');
  tool.className = 'tool-card';
  tool.innerHTML = `<div class="tool-header">
    <span class="tool-name">🔧 ${escapeHtml(block.name)}</span>
    <span class="tool-input-preview">${escapeHtml(block.input || '')}</span>
    <span class="tool-toggle">▶</span>
  </div>
  <div class="tool-body">${escapeHtml(block.input || '(no input)')}</div>`;

  tool.querySelector('.tool-header').addEventListener('click', () => {
    tool.classList.toggle('expanded');
    tool.querySelector('.tool-toggle').textContent = tool.classList.contains('expanded') ? '▼' : '▶';
  });
  return tool;
}

function createToolResultEl(block) {
  const r = document.createElement('div');
  r.className = 'tool-result';
  if (block.is_error) {
    r.style.color = 'var(--danger)';
    r.innerHTML = `<strong>❌ Error:</strong> ${escapeHtml(block.content || '')}`;
  } else {
    r.innerHTML = `<strong>Result:</strong> ${escapeHtml(block.content || '(empty)')}`;
  }
  return r;
}

function createSidechainEl(message) {
  const g = document.createElement('div');
  g.className = 'sidechain-group';
  g.innerHTML = `<div class="sidechain-header">🔀 子任务 (${message.blocks.length} 条消息)</div>
    <div class="sidechain-messages">${message.blocks.map(b => `<div>${escapeHtml(b.text || JSON.stringify(b))}</div>`).join('')}</div>`;
  g.querySelector('.sidechain-header').addEventListener('click', () => g.classList.toggle('expanded'));
  return g;
}

// ═══════════ 成本计算 ═══════════

function getModelPricing(model) {
  if (!model) return null;
  const pricing = state.config.pricing || {};
  const m = model.toLowerCase();
  if (pricing[m]) return pricing[m];
  const keys = Object.keys(pricing).sort((a, b) => b.length - a.length);
  for (const k of keys) { if (m.startsWith(k.toLowerCase())) return pricing[k]; }
  return null;
}

function updateCostBar() {
  let ti = 0, to = 0, tr = 0, tw = 0;
  let costUsd = 0, hasUnknown = false;

  for (const s of state.sessions.values()) {
    const u = s.tokenUsage || {};
    ti += u.input || 0; to += u.output || 0; tr += u.cacheRead || 0; tw += u.cacheWrite || 0;

    if (s.modelBreakdown) {
      for (const [model, usage] of Object.entries(s.modelBreakdown)) {
        const p = getModelPricing(model);
        if (p) {
          costUsd += ((usage.input || 0) / 1e6) * p.input +
                     ((usage.output || 0) / 1e6) * p.output +
                     ((usage.cacheRead || 0) / 1e6) * p.cache_read +
                     ((usage.cacheWrite || 0) / 1e6) * p.cache_write;
        } else {
          hasUnknown = true;
        }
      }
    }
  }

  dom.costInput.textContent = formatTokens(ti);
  dom.costOutput.textContent = formatTokens(to);
  dom.costCacheRead.textContent = formatTokens(tr);
  dom.costCacheWrite.textContent = formatTokens(tw);

  if (hasUnknown && costUsd === 0) {
    dom.costTotal.textContent = '未知定价 ⚙️';
    dom.costTotal.className = 'cost-total unknown';
    dom.costTotal.title = '点击设置定价';
    dom.costTotal.onclick = () => showPricingModal();
  } else {
    const cny = costUsd * state.config.usd_to_cny;
    const tag = hasUnknown ? ' ⚠️' : '';
    dom.costTotal.textContent = `$${costUsd.toFixed(4)} (¥${cny.toFixed(2)})${tag}`;
    dom.costTotal.className = `cost-total${cny >= state.config.cost_warning_threshold_cny ? ' warning' : ''}`;
    dom.costTotal.onclick = hasUnknown ? () => showPricingModal() : null;
  }
}

function showPricingModal() {
  // 收集所有使用的模型
  const models = new Set();
  for (const s of state.sessions.values()) {
    if (s.modelBreakdown) Object.keys(s.modelBreakdown).forEach(m => models.add(m));
  }

  const existing = state.config.pricing || {};
  const rows = [...models].map(m => {
    const p = existing[m] || {};
    return `<tr>
      <td style="padding:4px 8px;font-weight:600">${escapeHtml(m)}</td>
      <td><input data-model="${m}" data-field="input" value="${p.input || ''}" style="width:60px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);padding:2px 4px;border-radius:3px" placeholder="USD/M"></td>
      <td><input data-model="${m}" data-field="output" value="${p.output || ''}" style="width:60px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);padding:2px 4px;border-radius:3px" placeholder="USD/M"></td>
      <td><input data-model="${m}" data-field="cache_read" value="${p.cache_read || ''}" style="width:60px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);padding:2px 4px;border-radius:3px" placeholder="USD/M"></td>
      <td><input data-model="${m}" data-field="cache_write" value="${p.cache_write || ''}" style="width:60px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);padding:2px 4px;border-radius:3px" placeholder="USD/M"></td>
    </tr>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.7);z-index:100;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `<div style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:20px;max-width:500px;width:90%">
    <h3 style="margin-bottom:12px;color:var(--accent)">设置模型定价 (USD / 百万 token)</h3>
    <table style="width:100%;font-size:12px;border-collapse:collapse">
      <tr style="color:var(--text-muted)"><th style="text-align:left;padding:4px 8px">模型</th><th>Input</th><th>Output</th><th>Cache-R</th><th>Cache-W</th></tr>
      ${rows}
    </table>
    <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end">
      <button id="pricing-cancel" style="padding:6px 16px;background:var(--bg-tertiary);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;cursor:pointer">取消</button>
      <button id="pricing-save" style="padding:6px 16px;background:var(--accent);color:#000;border:none;border-radius:4px;cursor:pointer;font-weight:600">保存</button>
    </div>
  </div>`;

  document.body.appendChild(overlay);
  overlay.querySelector('#pricing-cancel').onclick = () => overlay.remove();
  overlay.querySelector('#pricing-save').onclick = () => {
    const inputs = overlay.querySelectorAll('input[data-model]');
    for (const inp of inputs) {
      const model = inp.dataset.model;
      const field = inp.dataset.field;
      const val = parseFloat(inp.value);
      if (!state.config.pricing[model]) state.config.pricing[model] = {};
      if (!isNaN(val)) state.config.pricing[model][field] = val;
    }
    overlay.remove();
    updateCostBar();
    // 保存到后端 pricing.json
    fetch('/api/pricing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.config.pricing)
    }).catch(err => console.warn('[pricing] 保存失败:', err));
  };
}

// ═══════════ 自动滚动 ═══════════

function scrollToBottom() {
  requestAnimationFrame(() => { dom.messageFlow.scrollTop = dom.messageFlow.scrollHeight; });
}

dom.messageFlow.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = dom.messageFlow;
  state.autoScroll = scrollHeight - scrollTop - clientHeight < 50;
  dom.messageFlow.classList.toggle('paused', !state.autoScroll);
});

dom.messageFlow.addEventListener('click', (e) => {
  if (dom.messageFlow.classList.contains('paused') && e.target === dom.messageFlow) {
    state.autoScroll = true;
    dom.messageFlow.classList.remove('paused');
    scrollToBottom();
  }
});

// ═══════════ 工具函数 ═══════════

function formatTime(d) {
  if (!d || isNaN(d.getTime())) return '--:--';
  return `${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`;
}

function formatTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return n.toString();
}

function escapeHtml(s) {
  if (!s) return '';
  const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

// ═══════════ 启动 ═══════════

// 从后端加载定价
fetch('/api/pricing').then(r => r.json()).then(p => {
  state.config.pricing = p;
  updateCostBar();
}).catch(() => {});

connectWebSocket();
