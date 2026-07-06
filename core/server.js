import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { Tailer } from './tailer.js';
import { SessionManager } from './sessions.js';
import { CostCalculator } from './cost.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = process.env.PORT || 3777;

// 加载配置
function loadConfig() {
  const configPath = path.join(ROOT, 'config.json');
  const examplePath = path.join(ROOT, 'config.example.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    }
    if (fs.existsSync(examplePath)) {
      return JSON.parse(fs.readFileSync(examplePath, 'utf-8'));
    }
  } catch (err) {
    console.warn('[server] 配置加载失败，使用默认值:', err.message);
  }
  return { pricing: {}, usd_to_cny: 7.25, cost_warning_threshold_cny: 50 };
}

// MIME 类型
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml'
};

// 静态文件服务
function serveStatic(req, res) {
  let filePath = path.join(ROOT, 'ui', req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);

  // 安全检查：不允许跳出 ui 目录
  if (!filePath.startsWith(path.join(ROOT, 'ui'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch (err) {
    res.writeHead(500);
    res.end('Internal Server Error');
  }
}

// WebSocket 广播
function broadcast(wss, data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // OPEN
      client.send(msg);
    }
  }
}

// 启动服务
async function main() {
  const config = loadConfig();

  // 初始化 tailer
  const tailer = new Tailer({
    projectsDir: path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects'),
    usePolling: config.tailer?.use_polling || false,
    pollingInterval: config.tailer?.polling_interval_ms || 1000
  });

  // 初始化 session manager
  const sessionManager = new SessionManager(tailer);

  // 创建 HTTP 服务器
  const server = http.createServer((req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API 路由
    if (req.url === '/api/sessions' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessionManager.getSessionList()));
      return;
    }

    if (req.url.startsWith('/api/session/') && req.method === 'GET') {
      const sessionId = req.url.split('/api/session/')[1];
      const detail = sessionManager.getSessionDetail(sessionId);
      if (detail) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(detail));
      } else {
        res.writeHead(404);
        res.end('Session not found');
      }
      return;
    }

    if (req.url.startsWith('/api/messages/') && req.method === 'GET') {
      const sessionId = req.url.split('/api/messages/')[1];
      const messages = sessionManager.getSessionMessages(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(messages));
      return;
    }

    if (req.url === '/api/config' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(config));
      return;
    }

    // 成本汇总 API
    if (req.url === '/api/cost' && req.method === 'GET') {
      const sessions = sessionManager.getSessionList();
      const costCalc = new CostCalculator(config);
      let totalTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let totalCost = { usd: 0, cny: 0 };
      let hasUnknown = false;

      for (const s of sessions) {
        totalTokens.input += s.tokenUsage.input;
        totalTokens.output += s.tokenUsage.output;
        totalTokens.cacheRead += s.tokenUsage.cacheRead;
        totalTokens.cacheWrite += s.tokenUsage.cacheWrite;

        const cost = costCalc.calculateSession(s.tokenUsage, s.modelBreakdown);
        totalCost.usd += cost.usd;
        totalCost.cny += cost.cny;
        if (cost.hasUnknown) hasUnknown = true;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tokens: totalTokens, cost: totalCost, hasUnknown }));
      return;
    }

    // Hooks 端点
    if (req.url === '/hook' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => body += chunk);
      req.on('end', () => {
        try {
          const hookData = JSON.parse(body);
          broadcast(wss, { type: 'hook', event: hookData.event, timestamp: new Date().toISOString() });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400);
          res.end('Invalid JSON');
        }
      });
      return;
    }

    // 静态文件
    serveStatic(req, res);
  });

  // WebSocket 服务器
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('[server] 新 WebSocket 连接');

    // 发送初始状态
    ws.send(JSON.stringify({
      type: 'init',
      sessions: sessionManager.getSessionList(),
      config: {
        pricing: config.pricing,
        usd_to_cny: config.usd_to_cny,
        cost_warning_threshold_cny: config.cost_warning_threshold_cny
      }
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        // 客户端请求会话消息
        if (msg.type === 'getMessages' && msg.sessionId) {
          const messages = sessionManager.getSessionMessages(msg.sessionId);
          ws.send(JSON.stringify({ type: 'messages', sessionId: msg.sessionId, messages }));
        }
      } catch (err) {
        console.warn('[server] WebSocket 消息解析失败:', err.message);
      }
    });
  });

  // 转发 session manager 事件到 WebSocket
  sessionManager.on('session:created', (data) => {
    broadcast(wss, { type: 'session:created', ...data });
  });

  sessionManager.on('session:updated', (data) => {
    const detail = sessionManager.getSessionDetail(data.sessionId);
    broadcast(wss, { type: 'session:updated', ...data, detail });
  });

  sessionManager.on('message', (data) => {
    broadcast(wss, { type: 'message', ...data });
  });

  // 启动 tailer
  await tailer.start();

  // 启动 HTTP 服务器（仅绑定 127.0.0.1，拒绝局域网访问）
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[cc-cockpit] 服务启动: http://127.0.0.1:${PORT}`);
    console.log(`[cc-cockpit] 监听目录: ${tailer.projectsDir}`);
  });
}

main().catch(err => {
  console.error('[server] 启动失败:', err);
  process.exit(1);
});
