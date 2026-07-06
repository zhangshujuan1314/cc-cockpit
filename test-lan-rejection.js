/**
 * 对抗性测试：局域网 IP 访问 3777 应被拒绝
 *
 * 原理：server.listen(PORT, '127.0.0.1') 只绑定 loopback，
 * 从其他 IP（包括本机局域网 IP）访问应 connection refused。
 */

import http from 'http';
import { execSync } from 'child_process';

const PORT = 3777;

// 获取本机局域网 IP
function getLocalIPs() {
  const out = execSync('ipconfig', { encoding: 'utf-8' });
  const ips = [];
  // 匹配 IPv4 地址
  const re = /IPv4[^:]*:\s*([\d.]+)/g;
  let m;
  while ((m = re.exec(out))) {
    const ip = m[1];
    if (ip !== '127.0.0.1') ips.push(ip);
  }
  return ips;
}

function tryConnect(host) {
  return new Promise((resolve) => {
    const req = http.get(`http://${host}:${PORT}/api/sessions`, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => resolve({ ok: true, status: res.statusCode }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.code }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false, error: 'TIMEOUT' }); });
  });
}

async function main() {
  console.log('🧪 对抗性测试：局域网 IP 访问 3777\n');

  // 确认 127.0.0.1 可达
  const local = await tryConnect('127.0.0.1');
  console.log(`  127.0.0.1:${PORT} → ${local.ok ? '✅ 可达' : '❌ 不可达'} ${local.ok ? `(HTTP ${local.status})` : `(${local.error})`}`);

  if (!local.ok) {
    console.log('\n  ⚠️ 服务未启动，请先运行: npm run web');
    process.exit(2);
  }

  // 获取局域网 IP 并测试
  const lanIPs = getLocalIPs();
  console.log(`  检测到局域网 IP: ${lanIPs.join(', ') || '(无)'}`);

  let allBlocked = true;
  for (const ip of lanIPs) {
    const result = await tryConnect(ip);
    const blocked = !result.ok;
    console.log(`  ${ip}:${PORT} → ${blocked ? '✅ 拒绝连接' : '❌ 可达！安全风险！'} ${result.ok ? `(HTTP ${result.status})` : `(${result.error})`}`);
    if (!blocked) allBlocked = false;
  }

  // 测试 0.0.0.0 不应绑定（从 localhost 以外不可达即为通过）
  const anyAddr = await tryConnect('0.0.0.0');
  // 0.0.0.0 从本机访问实际走 loopback，不算测试

  console.log('\n' + '='.repeat(40));
  if (lanIPs.length === 0) {
    console.log('  结果: ⚠️ 无局域网 IP 可测试（单网卡或仅 loopback）');
    console.log('  127.0.0.1 绑定确认: ✅');
  } else {
    console.log(`  结果: ${allBlocked ? '✅ 全部拒绝' : '❌ 存在可达 IP！'}`);
  }

  process.exit(allBlocked ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
