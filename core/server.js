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

// ── 配置加载 ──

function loadConfig() {
  const configPath = path.join(ROOT, 'config.json');
  try {
    if (fs.existsSync(configPath)) return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {}
  return { usd_to_cny: 7.25, cost_warning_threshold_cny: 50 };
}

const PRICING_PATH = path.join(ROOT, 'pricing.json');

function loadPricing() {
  try {
    if (fs.existsSync(PRICING_PATH)) return JSON.parse(fs.readFileSync(PRICING_PATH, 'utf-8'));
  } catch {}
  return {};
}

function savePricing(pricing) {
  fs.writeFileSync(PRICING_PATH, JSON.stringify(pricing, null, 2), 'utf-8');
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
  // __dirname 定位，禁止 process.cwd()
  let filePath = path.join(ROOT, 'ui', req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);
  if (!filePath.startsWith(path.join(ROOT, 'ui'))) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  try {
    if (!fs.existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  } catch { res.writeHead(500); res.end('Internal Server Error'); }
}

function broadcast(wss, data) {
  const msg = JSON.stringify(data);
  for (const c of wss.clients) { if (c.readyState === 1) c.send(msg); }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
  });
}

// ── 主服务 ──

async function main() {
  const config = loadConfig();
  let pricing = loadPricing();

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

  sessionManager.on('message', ({ sessionId, message }) => {
    if (message.type !== 'assistant') return;
    for (const block of message.blocks) {
      if (block.type === 'tool_use') {
        fileWatcher.registerToolCall(block.name, { file_path: block.input, path: block.input }, sessionId);
      }
    }
  });

  sessionManager.on('session:created', ({ sessionId }) => {
    const detail = sessionManager.getSessionDetail(sessionId);
    if (detail?.cwd) fileWatcher.watchDirectory(detail.cwd);
  });

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    // ── Sessions ──
    if (req.url === '/api/sessions' && req.method === 'GET') return json(res, sessionManager.getSessionList());
    if (req.url.startsWith('/api/session/') && req.method === 'GET') {
      const d = sessionManager.getSessionDetail(req.url.split('/api/session/')[1]);
      return d ? json(res, d) : (res.writeHead(404), res.end('Not found'));
    }
    if (req.url.startsWith('/api/messages/') && req.method === 'GET') {
      return json(res, sessionManager.getSessionMessages(req.url.split('/api/messages/')[1]));
    }

    // ── Pricing (持久化到 pricing.json) ──
    if (req.url === '/api/pricing' && req.method === 'GET') {
      return json(res, pricing);
    }
    if (req.url === '/api/pricing' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return json(res, { error: 'Invalid JSON' }, 400);
      pricing = body;
      savePricing(pricing);
      return json(res, { ok: true, pricing });
    }

    // ── Config (不含 pricing) ──
    if (req.url === '/api/config' && req.method === 'GET') {
      return json(res, { ...config, pricing });
    }

    // ── Cost ──
    if (req.url === '/api/cost' && req.method === 'GET') {
      const sessions = sessionManager.getSessionList();
      const mergedConfig = { ...config, pricing };
      const costCalc = new CostCalculator(mergedConfig);
      let tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let cost = { usd: 0, cny: 0 };
      let hasUnknown = false;
      for (const s of sessions) {
        tokens.input += s.tokenUsage.input; tokens.output += s.tokenUsage.output;
        tokens.cacheRead += s.tokenUsage.cacheRead; tokens.cacheWrite += s.tokenUsage.cacheWrite;
        const c = costCalc.calculateSession(s.tokenUsage, s.modelBreakdown);
        cost.usd += c.usd; cost.cny += c.cny;
        if (c.hasUnknown) hasUnknown = true;
      }
      return json(res, { tokens, cost, hasUnknown });
    }

    // ── Files ──
    if (req.url === '/api/files' && req.method === 'GET') return json(res, fileWatcher.getRecentFiles(50));

    // ── Hooks ──
    if (req.url === '/api/hooks/install' && req.method === 'POST') {
      // npx 场景：复制 hook-ping.js 到稳定位置
      const stableHookDir = path.join(process.env.USERPROFILE || process.env.HOME, '.claude');
      const stableHookPath = path.join(stableHookDir, 'cc-cockpit-hook.js');
      try {
        if (!fs.existsSync(stableHookDir)) fs.mkdirSync(stableHookDir, { recursive: true });
        fs.copyFileSync(path.join(ROOT, 'hook-ping.js'), stableHookPath);
      } catch (err) {
        return json(res, { error: `无法复制 hook 脚本: ${err.message}` }, 500);
      }
      try {
        const result = hookInstaller.install(stableHookPath);
        return json(res, result);
      } catch (err) {
        return json(res, { error: err.message }, 500);
      }
    }
    if (req.url === '/api/hooks/status' && req.method === 'GET') return json(res, hookInstaller.verify());
    if (req.url === '/api/hooks/dry-run' && req.method === 'GET') {
      const stableHookPath = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'cc-cockpit-hook.js');
      return json(res, hookInstaller.dryRun(stableHookPath));
    }

    // ── Hook 推送 ──
    if (req.url === '/hook' && req.method === 'POST') {
      const body = await readBody(req);
      if (body) {
        broadcast(wss, { type: 'hook', event: body.event, timestamp: new Date().toISOString() });
        return json(res, { ok: true });
      }
      return json(res, { error: 'Invalid JSON' }, 400);
    }

    serveStatic(req, res);
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    ws.send(JSON.stringify({
      type: 'init',
      sessions: sessionManager.getSessionList(),
      files: fileWatcher.getRecentFiles(30),
      config: { pricing, usd_to_cny: config.usd_to_cny, cost_warning_threshold_cny: config.cost_warning_threshold_cny }
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
      } catch {}
    });
  });

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
    console.log(`[cc-cockpit] 定价: ${PRICING_PATH}`);
  });
}

main().catch(err => { console.error('[server] 启动失败:', err); process.exit(1); });
