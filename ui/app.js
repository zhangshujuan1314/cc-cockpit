/**
 * CC Cockpit - 前端应用
 *
 * 纯 ES modules，无构建步骤
 * WebSocket 实时通信
 */

// 状态
const state = {
  ws: null,
  sessions: new Map(),
  activeSessionId: null,
  config: { pricing: {}, usd_to_cny: 7.25, cost_warning_threshold_cny: 50 },
  autoScroll: true,
  reconnectTimer: null,
  reconnectAttempts: 0
};

// DOM 缓存
const dom = {
  sessionItems: document.getElementById('session-items'),
  messageFlow: document.getElementById('message-flow'),
  emptyState: document.getElementById('empty-state'),
  wsDot: document.getElementById('ws-dot'),
  wsStatus: document.getElementById('ws-status'),
  costInput: document.getElementById('cost-input'),
  costOutput: document.getElementById('cost-output'),
  costCacheRead: document.getElementById('cost-cache-read'),
  costCacheWrite: document.getElementById('cost-cache-write'),
  costTotal: document.getElementById('cost-total')
};

// ============= WebSocket =============

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${location.host}`;

  state.ws = new WebSocket(wsUrl);

  state.ws.onopen = () => {
    console.log('[ws] 已连接');
    state.reconnectAttempts = 0;
    updateConnectionStatus(true);
  };

  state.ws.onclose = () => {
    console.log('[ws] 断开');
    updateConnectionStatus(false);
    scheduleReconnect();
  };

  state.ws.onerror = (err) => {
    console.error('[ws] 错误:', err);
  };

  state.ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (err) {
      console.error('[ws] 消息解析失败:', err);
    }
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), 30000);
  state.reconnectAttempts++;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connectWebSocket();
  }, delay);
}

function updateConnectionStatus(connected) {
  dom.wsDot.classList.toggle('connected', connected);
  dom.wsStatus.textContent = connected ? '已连接' : '断开';
}

// ============= 消息处理 =============

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      handleInit(msg);
      break;
    case 'session:created':
      handleSessionCreated(msg);
      break;
    case 'session:updated':
      handleSessionUpdated(msg);
      break;
    case 'message':
      handleNewMessage(msg);
      break;
    case 'messages':
      handleMessagesBulk(msg);
      break;
    case 'hook':
      handleHook(msg);
      break;
  }
}

function handleInit(msg) {
  // 初始化配置
  state.config = msg.config || state.config;

  // 初始化会话列表
  for (const session of msg.sessions) {
    state.sessions.set(session.sessionId, {
      ...session,
      messages: [],
      sidechains: new Map()
    });
  }

  renderSessionList();

  // 自动选中第一个会话
  if (msg.sessions.length > 0 && !state.activeSessionId) {
    selectSession(msg.sessions[0].sessionId);
  }
}

function handleSessionCreated(msg) {
  if (state.sessions.has(msg.sessionId)) return;

  state.sessions.set(msg.sessionId, {
    sessionId: msg.sessionId,
    projectName: msg.projectName,
    summary: '',
    lastActivity: new Date(),
    status: 'running',
    messageCount: 0,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    messages: [],
    sidechains: new Map()
  });

  renderSessionList();

  // 如果当前没有选中会话，自动选中新的
  if (!state.activeSessionId) {
    selectSession(msg.sessionId);
  }
}

function handleSessionUpdated(msg) {
  const session = state.sessions.get(msg.sessionId);
  if (!session) return;

  if (msg.detail) {
    Object.assign(session, msg.detail);
  }

  renderSessionList();
  updateCostBar();
}

function handleNewMessage(msg) {
  const { sessionId, message } = msg;
  const session = state.sessions.get(sessionId);
  if (!session) return;

  // 添加消息到会话
  session.messages.push(message);
  session.messageCount = session.messages.length;
  session.lastActivity = new Date(message.timestamp);

  // 处理 sidechain
  if (message.isSidechain) {
    if (!session.sidechains.has(message.id)) {
      session.sidechains.set(message.id, []);
    }
    session.sidechains.get(message.id).push(message);
  }

  // 如果是当前活跃会话，渲染新消息
  if (sessionId === state.activeSessionId) {
    appendMessage(message);
    if (state.autoScroll) {
      scrollToBottom();
    }
  }

  // 更新会话列表中的计数
  renderSessionList();
  updateCostBar();
}

function handleMessagesBulk(msg) {
  const session = state.sessions.get(msg.sessionId);
  if (!session) return;

  session.messages = msg.messages || [];
  session.messageCount = session.messages.length;

  if (msg.sessionId === state.activeSessionId) {
    renderAllMessages();
  }
}

function handleHook(msg) {
  // Hook 事件（如 Stop），可以显示通知
  console.log('[hook]', msg.event);
}

// ============= 会话列表渲染 =============

function renderSessionList() {
  const items = [];

  // 按最后活跃时间排序
  const sorted = Array.from(state.sessions.values())
    .sort((a, b) => {
      const ta = a.lastActivity ? new Date(a.lastActivity).getTime() : 0;
      const tb = b.lastActivity ? new Date(b.lastActivity).getTime() : 0;
      return tb - ta;
    });

  for (const session of sorted) {
    const isActive = session.sessionId === state.activeSessionId;
    const statusClass = session.status === 'running' ? 'running' : 'idle';
    const timeStr = session.lastActivity ? formatTime(new Date(session.lastActivity)) : '--';
    const summary = session.summary || `${session.messageCount || 0} 条消息`;

    items.push(`
      <div class="session-item ${isActive ? 'active' : ''}" data-session-id="${session.sessionId}">
        <div class="session-header">
          <span class="status-dot ${statusClass}"></span>
          <span class="project-name">${escapeHtml(session.projectName || 'unknown')}</span>
        </div>
        <div class="session-meta">
          <span>${timeStr}</span>
          <span>${session.messageCount || 0} msgs</span>
        </div>
        <div class="summary">${escapeHtml(summary)}</div>
      </div>
    `);
  }

  dom.sessionItems.innerHTML = items.join('');

  // 绑定点击事件
  dom.sessionItems.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', () => {
      selectSession(el.dataset.sessionId);
    });
  });
}

function selectSession(sessionId) {
  state.activeSessionId = sessionId;

  // 请求该会话的消息
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'getMessages', sessionId }));
  }

  renderSessionList();
  renderAllMessages();
}

// ============= 消息流渲染 =============

function renderAllMessages() {
  const session = state.sessions.get(state.activeSessionId);

  // 清空
  dom.messageFlow.innerHTML = '';

  if (!session || session.messages.length === 0) {
    dom.messageFlow.innerHTML = `
      <div class="empty-state">
        <div class="icon">📡</div>
        <div class="title">等待消息...</div>
        <div class="desc">会话建立后，消息将实时显示</div>
      </div>
    `;
    return;
  }

  // 渲染所有消息
  const fragment = document.createDocumentFragment();
  for (const message of session.messages) {
    const el = createMessageElement(message);
    if (el) fragment.appendChild(el);
  }
  dom.messageFlow.appendChild(fragment);

  scrollToBottom();
}

function appendMessage(message) {
  // 移除空状态
  const empty = dom.messageFlow.querySelector('.empty-state');
  if (empty) empty.remove();

  const el = createMessageElement(message);
  if (el) {
    dom.messageFlow.appendChild(el);
  }
}

function createMessageElement(message) {
  if (message.isSidechain) {
    return createSidechainElement(message);
  }

  const card = document.createElement('div');
  card.className = `message-card ${message.type}`;
  card.dataset.messageId = message.id;

  // Header
  const header = document.createElement('div');
  header.className = 'message-header';

  const role = document.createElement('span');
  role.className = 'message-role';
  role.textContent = message.type === 'user' ? 'USER' : message.type === 'assistant' ? 'ASSISTANT' : 'SYSTEM';

  const time = document.createElement('span');
  time.className = 'message-time';
  time.textContent = formatTime(new Date(message.timestamp));

  header.appendChild(role);
  if (message.model) {
    const model = document.createElement('span');
    model.className = 'message-model';
    model.textContent = message.model;
    header.appendChild(model);
  }
  header.appendChild(time);

  // Body
  const body = document.createElement('div');
  body.className = 'message-body';

  for (const block of message.blocks) {
    if (block.type === 'text') {
      const p = document.createElement('div');
      p.textContent = block.text;
      body.appendChild(p);
    } else if (block.type === 'tool_use') {
      body.appendChild(createToolCard(block, false));
    } else if (block.type === 'tool_result') {
      body.appendChild(createToolResult(block));
    } else if (block.type === 'raw') {
      const pre = document.createElement('pre');
      pre.style.fontSize = '11px';
      pre.style.color = 'var(--text-muted)';
      pre.textContent = JSON.stringify(block.data, null, 2);
      body.appendChild(pre);
    }
  }

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function createToolCard(block, isResult) {
  const tool = document.createElement('div');
  tool.className = 'tool-card';

  const header = document.createElement('div');
  header.className = 'tool-header';

  const name = document.createElement('span');
  name.className = 'tool-name';
  name.textContent = `🔧 ${block.name}`;

  const preview = document.createElement('span');
  preview.className = 'tool-input-preview';
  preview.textContent = block.input || '';

  const toggle = document.createElement('span');
  toggle.className = 'tool-toggle';
  toggle.textContent = '▶';

  header.appendChild(name);
  header.appendChild(preview);
  header.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'tool-body';
  body.textContent = block.input || '(no input)';

  header.addEventListener('click', () => {
    tool.classList.toggle('expanded');
    toggle.textContent = tool.classList.contains('expanded') ? '▼' : '▶';
  });

  tool.appendChild(header);
  tool.appendChild(body);
  return tool;
}

function createToolResult(block) {
  const result = document.createElement('div');
  result.className = 'tool-result';
  result.innerHTML = `<strong>Result:</strong> ${escapeHtml(block.content || '(empty)')}`;
  return result;
}

function createSidechainElement(message) {
  const group = document.createElement('div');
  group.className = 'sidechain-group';

  const header = document.createElement('div');
  header.className = 'sidechain-header';
  header.textContent = `🔀 子任务 (${message.blocks.length} 条消息)`;

  const messages = document.createElement('div');
  messages.className = 'sidechain-messages';

  for (const block of message.blocks) {
    const div = document.createElement('div');
    div.textContent = block.text || JSON.stringify(block);
    messages.appendChild(div);
  }

  header.addEventListener('click', () => {
    group.classList.toggle('expanded');
  });

  group.appendChild(header);
  group.appendChild(messages);
  return group;
}

// ============= 成本计算 =============

function updateCostBar() {
  let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;

  for (const session of state.sessions.values()) {
    if (session.tokenUsage) {
      totalInput += session.tokenUsage.input || 0;
      totalOutput += session.tokenUsage.output || 0;
      totalCacheRead += session.tokenUsage.cacheRead || 0;
      totalCacheWrite += session.tokenUsage.cacheWrite || 0;
    }
  }

  dom.costInput.textContent = formatTokens(totalInput);
  dom.costOutput.textContent = formatTokens(totalOutput);
  dom.costCacheRead.textContent = formatTokens(totalCacheRead);
  dom.costCacheWrite.textContent = formatTokens(totalCacheWrite);

  // 计算费用（需要知道模型，这里简化处理）
  const costUsd = estimateCost(totalInput, totalOutput, totalCacheRead, totalCacheWrite);
  const costCny = costUsd * state.config.usd_to_cny;

  dom.costTotal.textContent = `$${costUsd.toFixed(4)} (¥${costCny.toFixed(2)})`;

  // 超阈值警告
  if (costCny >= state.config.cost_warning_threshold_cny) {
    dom.costTotal.classList.add('warning');
  } else {
    dom.costTotal.classList.remove('warning');
  }
}

function estimateCost(input, output, cacheRead, cacheWrite) {
  // 使用 sonnet 价格作为默认估算
  const pricing = state.config.pricing['claude-sonnet-4'] || { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 };

  const cost = (input / 1_000_000) * pricing.input +
               (output / 1_000_000) * pricing.output +
               (cacheRead / 1_000_000) * pricing.cache_read +
               (cacheWrite / 1_000_000) * pricing.cache_write;

  return cost;
}

// ============= 自动滚动 =============

function scrollToBottom() {
  requestAnimationFrame(() => {
    dom.messageFlow.scrollTop = dom.messageFlow.scrollHeight;
  });
}

// 监听用户滚动，暂停自动滚动
dom.messageFlow.addEventListener('scroll', () => {
  const { scrollTop, scrollHeight, clientHeight } = dom.messageFlow;
  const isAtBottom = scrollHeight - scrollTop - clientHeight < 50;
  state.autoScroll = isAtBottom;
  dom.messageFlow.classList.toggle('paused', !isAtBottom);
});

// 点击恢复自动滚动
dom.messageFlow.addEventListener('click', (e) => {
  if (dom.messageFlow.classList.contains('paused') && e.target === dom.messageFlow) {
    state.autoScroll = true;
    dom.messageFlow.classList.remove('paused');
    scrollToBottom();
  }
});

// ============= 工具函数 =============

function formatTime(date) {
  if (!date || isNaN(date.getTime())) return '--:--';
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  const s = date.getSeconds().toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

function formatTokens(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toString();
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============= 启动 =============

connectWebSocket();
