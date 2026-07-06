import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Tailer } from './tailer.js';
import { SessionManager } from './sessions.js';
import { CostCalculator } from './cost.js';
import { FileWatcher } from './watcher.js';
import { HookInstaller } from './hooks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3777;

function loadConfig() {
  const configPath = path.join(ROOT, 'config.json');
  const examplePath = path.join(ROOT, 'config.example.json');
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (fs.existsSync(examplePath)) return JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
  } catch (err) {
    console.warn('[server] 配置加载失败:', err.message);
  }
  return { pricing: {}, usd_to_cny: 7.25, cost_warning_threshold_cny: 50 };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

function serveStatic(req, res) {
  let filePath = path.join(ROOT, 'ui', req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(path.join(ROOT, 'ui'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return; }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  } catch { res.writeHead(500); res.end('Internal Server Error'); }
}

function broadcast(wss, data) {
  const msg = JSON.stringify(data);
  for (const c of wss.clients) {
    if (c.readyState === 1) c.send(msg);
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function main() {
  const config = loadConfig();

  // 初始化各模块
  const tailer = new Tailer({
    projectsDir: path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects'),
    usePolling: config.tailer?.use_polling ?? true,
    pollingInterval: config.tailer?.polling_interval_ms || 500
  });
  const sessionManager = new SessionManager(tailer);
  const fileWatcher = new FileWatcher({
    projectsDir: tailer.projectsDir,
    usePolling: config.tailer?.use_polling ?? true,
    pollingInterval: config.tailer?.polling_interval_ms || 500
  });
  const hookInstaller = new HookInstaller();

  // 拦截 session manager 的消息，捕获 tool call
  sessionManager.on('message', ({ sessionId, message }) => {
    if (message.type !== 'assistant') return;
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        fileWatcher.registerToolCall(block.name, { file_path: block.input, path: block.input }, sessionId);
      }
    }
  });

  // 监听活跃会话的 cwd
  sessionManager.on('session:created', ({ sessionId }) => {
    const detail = sessionManager.getSessionDetail(sessionId);
    if (detail?.cwd) fileWatcher.watchDirectory(detail.cwd);
  });

  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── API 路由 ──
    if (req.url === '/api/sessions' && req.method === 'GET') {
      return json(res, sessionManager.getSessionList());
    }
    if (req.url.startsWith('/api/session/') && req.method === 'GET') {
      const detail = sessionManager.getSessionDetail(req.url.split('/api/session/')[1]);
      return detail ? json(res, detail) : (res.writeHead(404), res.end('Not found'));
    }
    if (req.url.startsWith('/api/messages/') && req.method === 'GET') {
      return json(res, sessionManager.getSessionMessages(req.url.split('/api/messages/')[1]));
    }
    if (req.url === '/api/config' && req.method === 'GET') {
      return json(res, config);
    }

    // 成本 API
    if (req.url === '/api/cost' && req.method === 'GET') {
      const sessions = sessionManager.getSessionList();
      const costCalc = new CostCalculator(config);
      let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let cost = { usd: 0, cny: 0 };
      let hasUnknown = false;
      for (const s of sessions) {
        tokens.input += s.tokenUsage.input;
        tokens.output += s.tokenUsage.output;
        tokens.cacheRead += s.tokenUsage.cacheRead;
        tokens.cacheWrite += s.tokenUsage.cacheWrite;
        const c = costCalc.calculateSession(s.tokenUsage, s.modelBreakdown);
        cost.usd += c.usd; cost.cny += c.cny;
        if (c.hasUnknown) hasUnknown = true;
      }
      return json(res, { tokens, cost, hasUnknown });
    }

    // 文件改动 API
    if (req.url === '/api/files' && req.method === 'GET') {
      return json(res, fileWatcher.getRecentFiles(50));
    }

    // Hooks 安装 API
    if (req.url === '/api/hooks/install' && req.method === 'POST') {
      const hookScript = path.join(ROOT, 'hook-ping.js');
      try {
        const result = hookInstaller.install(hookScript);
        return json(res, result);
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }
    if (req.url === '/api/hooks/status' && req.method === 'GET') {
      return json(res, hookInstaller.verify());
    }
    if (req.url === '/api/hooks/dry-run' && req.method === 'GET') {
      const hookScript = path.join(ROOT, 'hook-ping.js');
      return json(res, hookInstaller.dryRun(hookScript));
    }

    // Hook 推送端点
    if (req.url === '/hook' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const hookData = JSON.parse(body);
          broadcast(wss, { type: 'hook', event: hookData.event, timestamp: new Date().toISOString() });
          json(res, { ok: true });
        } catch { res.writeHead(400); res.end('Invalid JSON'); }
      });
      return;
    }

    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'init',
      sessions: sessionManager.getSessionList(),
      files: fileWatcher.getRecentFiles(30),
      config: {
        pricing: config.pricing,
        usd_to_cny: config.usd_to_cny,
        cost_warning_threshold_cny: config.cost_warning_threshold_cny
      }
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        if (msg.type === 'getMessages' && msg.sessionId) {
          ws.send(JSON.stringify({ type: 'messages', sessionId: msg.sessionId, messages: sessionManager.getSessionMessages(msg.sessionId) }));
        }
        if (msg.type === 'getFiles') {
          ws.send(JSON.stringify({ type: 'files', files: fileWatcher.getRecentFiles(50) }));
        }
      } catch (err) { console.warn('[ws] 解析失败:', err.message); }
    });
  });

  // 广播事件
  sessionManager.on('session:created', (data) => broadcast(wss, { type: 'session:created', ...data }));
  sessionManager.on('session:updated', (data) => {
    broadcast(wss, { type: 'session:updated', ...data, detail: sessionManager.getSessionDetail(data.sessionId) });
  });
  sessionManager.on('message', (data) => broadcast(wss, { type: 'message', ...data }));

  fileWatcher.on('file:changed', (data) => broadcast(wss, { type: 'file:changed', ...data }));
  fileWatcher.on('file:diff', (data) => broadcast(wss, { type: 'file:diff', ...data }));

  await tailer.start();

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[cc-cockpit] http://127.0.0.1:${PORT}`);
    console.log(`[cc-cockpit] 监听: ${tailer.projectsDir}`);
  });
}

main().catch(err => { console.error('[server] 启动失败:', err); process.exit(1); });
