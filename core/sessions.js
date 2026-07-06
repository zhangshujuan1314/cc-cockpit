import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

/**
 * 会话管理器
 *
 * 职责：
 * 1. 维护所有活跃会话的状态
 * 2. 聚合消息（user/assistant/tool_use/tool_result）
 * 3. 处理 sidechain 折叠
 * 4. 提供会话列表和消息流数据
 */
export class SessionManager extends EventEmitter {
  constructor(tailer) {
    super();
    this.tailer = tailer;

    // { sessionId: { messages: [], summary: '', lastActivity: Date, filePath: string, status: 'idle'|'running' } }
    this.sessions = new Map();

    // 绑定 tailer 事件
    this.tailer.on('session:discovered', ({ sessionId, filePath }) => {
      this._initSession(sessionId, filePath);
    });

    this.tailer.on('message', ({ sessionId, filePath, data, timestamp }) => {
      this._handleMessage(sessionId, data, timestamp);
    });
  }

  /**
   * 初始化会话
   */
  _initSession(sessionId, filePath) {
    if (this.sessions.has(sessionId)) return;

    // 从文件路径提取项目名
    const projectName = this._extractProjectName(filePath);

    this.sessions.set(sessionId, {
      sessionId,
      filePath,
      projectName,
      messages: [],
      summary: '',
      lastActivity: null,
      status: 'idle',
      cwd: null,
      gitBranch: null,
      tokenUsage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0
      }
    });

    this.emit('session:created', { sessionId, projectName });
  }

  /**
   * 处理单条消息
   */
  _handleMessage(sessionId, data, timestamp) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this._initSession(sessionId, this.tailer.sessionFiles.get(sessionId));
      return this._handleMessage(sessionId, data, timestamp);
    }

    // 更新最后活跃时间
    session.lastActivity = new Date(timestamp);
    session.status = 'running';

    // 提取元数据
    if (data.cwd) session.cwd = data.cwd;
    if (data.gitBranch) session.gitBranch = data.gitBranch;

    // 处理 usage（token 统计）
    if (data.message?.usage) {
      const u = data.message.usage;
      session.tokenUsage.input += u.input_tokens || 0;
      session.tokenUsage.output += u.output_tokens || 0;
      session.tokenUsage.cacheRead += u.cache_read_input_tokens || 0;
      session.tokenUsage.cacheWrite += u.cache_creation_input_tokens || 0;
    }

    // 处理 summary（会话摘要）
    if (data.type === 'summary') {
      session.summary = this._extractText(data);
      this.emit('session:updated', { sessionId, field: 'summary' });
    }

    // 处理消息内容
    const message = this._normalizeMessage(data, sessionId);
    if (message) {
      session.messages.push(message);
      this.emit('message', { sessionId, message });

      // 30 秒无活动标记为 idle
      clearTimeout(session._idleTimer);
      session._idleTimer = setTimeout(() => {
        session.status = 'idle';
        this.emit('session:updated', { sessionId, field: 'status' });
      }, 30000);
    }
  }

  /**
   * 标准化消息格式
   *
   * 真实 JSONL type 种类：
   * - user / assistant：对话消息
   * - summary：会话摘要
   * - mode / permission-mode / last-prompt / file-history-snapshot / attachment：
   *   元数据行，不渲染为对话卡片
   */
  _normalizeMessage(data, sessionId) {
    const type = data.type;
    const timestamp = data.timestamp || new Date().toISOString();
    const isSidechain = data.isSidechain || false;

    // 跳过 isMeta 消息（内部命令，非用户输入）
    if (data.isMeta) return null;

    if (type === 'user' || type === 'assistant') {
      const content = data.message?.content;
      if (!content) return null;

      const blocks = [];

      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            blocks.push({ type: 'text', text: block.text });
          } else if (block.type === 'thinking') {
            // 思考过程，折叠显示
            blocks.push({ type: 'thinking', text: this._truncateText(block.thinking || '', 300) });
          } else if (block.type === 'tool_use') {
            blocks.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: this._summarizeInput(block.name, block.input)
            });
          } else if (block.type === 'tool_result') {
            blocks.push({
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: this._truncateText(
                typeof block.content === 'string' ? block.content :
                Array.isArray(block.content) ? block.content.map(c => c.text || '').join('') :
                block.text || '', 500),
              is_error: block.is_error || false
            });
          } else {
            // 未知 block 类型，原样透传
            blocks.push({ type: 'unknown', raw: block });
          }
        }
      } else if (typeof content === 'string') {
        blocks.push({ type: 'text', text: content });
      }

      return {
        id: data.uuid || `${sessionId}-${Date.now()}`,
        type,
        timestamp,
        isSidechain,
        blocks,
        model: data.message?.model || null
      };
    }

    // system / summary
    if (type === 'system' || type === 'summary') {
      return {
        id: data.uuid || `${sessionId}-${Date.now()}`,
        type,
        timestamp,
        isSidechain: false,
        blocks: [{ type: 'text', text: this._extractText(data) }],
        model: null
      };
    }

    // 元数据 type（mode / permission-mode / last-prompt / attachment / file-history-snapshot）：
    // 不生成消息卡片，静默处理
    if (['mode', 'permission-mode', 'last-prompt', 'file-history-snapshot', 'attachment'].includes(type)) {
      return null;
    }

    // 未知 type：原样透传
    return {
      id: data.uuid || `${sessionId}-${Date.now()}`,
      type: type || 'unknown',
      timestamp,
      isSidechain,
      blocks: [{ type: 'raw', data }],
      model: null
    };
  }

  /**
   * 提取文本内容
   */
  _extractText(data) {
    if (typeof data.message?.content === 'string') return data.message.content;
    if (Array.isArray(data.message?.content)) {
      return data.message.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n');
    }
    if (typeof data.text === 'string') return data.text;
    return '';
  }

  /**
   * 摘要化 tool input（避免巨量数据）
   */
  _summarizeInput(toolName, input) {
    if (!input) return '(no input)';

    // 对于文件操作，只显示路径
    if (['Read', 'Write', 'Edit', 'MultiEdit'].includes(toolName)) {
      return input.file_path || input.path || JSON.stringify(input).slice(0, 200);
    }

    // 对于搜索，显示查询
    if (['Grep', 'Glob'].includes(toolName)) {
      return input.pattern || JSON.stringify(input).slice(0, 200);
    }

    // 对于 Bash，显示命令
    if (toolName === 'Bash') {
      return input.command || JSON.stringify(input).slice(0, 200);
    }

    // 其他：截断到 200 字符
    const str = JSON.stringify(input);
    return str.length > 200 ? str.slice(0, 200) + '...' : str;
  }

  /**
   * 截断文本
   */
  _truncateText(text, maxLen) {
    if (!text) return '';
    if (typeof text !== 'string') text = JSON.stringify(text);
    return text.length > maxLen ? text.slice(0, maxLen) + '...' : text;
  }

  /**
   * 从文件路径提取项目名
   */
  _extractProjectName(filePath) {
    // 路径格式: ~/.claude/projects/<project-dir>/<session>.jsonl
    const parts = filePath.split(path.sep);
    const projectsIdx = parts.indexOf('projects');
    if (projectsIdx >= 0 && parts.length > projectsIdx + 2) {
      return parts[projectsIdx + 1];
    }
    return 'unknown';
  }

  /**
   * 获取所有会话列表（用于 UI 初始化）
   */
  getSessionList() {
    const list = [];
    for (const [sessionId, session] of this.sessions) {
      list.push({
        sessionId,
        projectName: session.projectName,
        summary: session.summary,
        lastActivity: session.lastActivity,
        status: session.status,
        messageCount: session.messages.length,
        tokenUsage: session.tokenUsage
      });
    }
    // 按最后活跃时间排序
    list.sort((a, b) => {
      const ta = a.lastActivity ? a.lastActivity.getTime() : 0;
      const tb = b.lastActivity ? b.lastActivity.getTime() : 0;
      return tb - ta;
    });
    return list;
  }

  /**
   * 获取单个会话的消息流
   */
  getSessionMessages(sessionId, limit = 200) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages.slice(-limit);
  }

  /**
   * 获取单个会话详情
   */
  getSessionDetail(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      sessionId,
      projectName: session.projectName,
      summary: session.summary,
      lastActivity: session.lastActivity,
      status: session.status,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      tokenUsage: session.tokenUsage,
      messageCount: session.messages.length
    };
  }
}
