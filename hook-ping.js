/**
 * hook-ping.js — CC hooks 通知脚本
 *
 * 用法：node hook-ping.js <event>
 * 示例：node hook-ping.js stop
 *       node hook-ping.js notification
 *
 * 替代 curl，避免 Windows cmd/JSON 双重转义问题。
 * 读取 config.json 中的端口配置。
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取端口配置
let PORT = 3777;
try {
  const configPath = path.join(__dirname, 'config.json');
  if (fs.existsSync(configPath)) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    PORT = config.port || 3777;
  }
} catch {}

const event = process.argv[2] || 'unknown';

const postData = JSON.stringify({ event });
const req = http.request({
  hostname: '127.0.0.1',
  port: PORT,
  path: '/hook',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(postData)
  },
  timeout: 3000
}, (res) => {
  // 成功，静默退出
  process.exit(0);
});

req.on('error', () => {
  // 服务未启动，静默退出（不报错，不打扰用户）
  process.exit(0);
});

req.on('timeout', () => {
  req.destroy();
  process.exit(0);
});

req.write(postData);
req.end();
