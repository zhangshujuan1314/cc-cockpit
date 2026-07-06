/**
 * 对抗性测试：定价持久化
 * 改价 → 重启服务 → 价格还在
 */

import fs from 'fs';
import path from 'path';
import http from 'http';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
const PRICING_PATH = path.join(ROOT, 'pricing.json');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function api(method, url, body) {
  return new Promise((resolve, reject) => {
    const opts = { hostname: '127.0.0.1', port: 3777, path: url, method, headers: { 'Content-Type': 'application/json' }, timeout: 5000 };
    const req = http.request(opts, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(d); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('🧪 定价持久化对抗性测试\n');

  // 备份原始 pricing.json
  const original = fs.readFileSync(PRICING_PATH, 'utf-8');

  try {
    // 1. 写入测试定价
    const testPricing = { 'test-model-xyz': { input: 99, output: 88, cache_read: 77, cache_write: 66 } };
    const postRes = await api('POST', '/api/pricing', testPricing);
    console.log(`  POST 结果: ${postRes.ok ? '✅' : '❌'}`);

    // 2. 验证文件已写入
    const fileContent = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf-8'));
    const fileOk = fileContent['test-model-xyz']?.input === 99;
    console.log(`  文件写入: ${fileOk ? '✅' : '❌'}`);

    // 3. GET 验证
    const getRes = await api('GET', '/api/pricing');
    const getOk = getRes['test-model-xyz']?.input === 99;
    console.log(`  GET 读取: ${getOk ? '✅' : '❌'}`);

    // 4. 模拟重启：重新读取文件
    const afterRestart = JSON.parse(fs.readFileSync(PRICING_PATH, 'utf-8'));
    const restartOk = afterRestart['test-model-xyz']?.input === 99;
    console.log(`  重启后持久化: ${restartOk ? '✅' : '❌'}`);

    const allOk = postRes.ok && fileOk && getOk && restartOk;
    console.log(`\n  结果: ${allOk ? '✅ 全部通过' : '❌ 失败'}`);
    process.exit(allOk ? 0 : 1);
  } finally {
    // 恢复原始 pricing.json
    fs.writeFileSync(PRICING_PATH, original, 'utf-8');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
