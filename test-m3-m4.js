/**
 * M3/M4 对抗性测试
 *
 * M3:
 * - CRLF 陷阱：编辑单行，diff 只显示该行
 * - 二进制/超大文件跳过 diff
 * - 文件删除有独立状态
 *
 * M4:
 * - hook-ping.js 可执行
 * - settings.json 合并只增不改
 * - .bak 存在
 * - config.json 在 .gitignore
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { FileWatcher } from './core/watcher.js';
import { HookInstaller } from './core/hooks.js';

const BASE = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mkDir(name) {
  const d = path.join(BASE, `_test_${name}_${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function rmDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

// ── M3-1: CRLF 陷阱 ──
async function test_m3_crlf() {
  console.log('\n=== M3-1: CRLF 陷阱 ===');
  const dir = mkDir('m3crlf');
  const fp = path.join(dir, 'test.txt');
  try {
    // 写入 10 行 CRLF 文件
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(fp, lines.join('\r\n') + '\r\n');

    const watcher = new FileWatcher({ usePolling: false });
    const diffs = [];
    watcher.on('file:diff', d => diffs.push(d));

    // 首次见到文件，建立快照（模拟 _handleFileChange）
    watcher._handleFileChange(fp, 'created');

    // 修改第 5 行
    const newLines = [...lines];
    newLines[4] = 'line 5 MODIFIED';
    fs.writeFileSync(fp, newLines.join('\r\n') + '\r\n');

    watcher._handleFileChange(fp, 'modified');
    await sleep(200);

    const diff = diffs[0]?.diff || '';
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));

    console.log(`  diff 变更行数: +${addedLines.length} -${removedLines.length}`);
    console.log(`  结果: ${addedLines.length <= 2 && removedLines.length <= 2 ? '✅ 只显示变更行' : '❌ 显示过多行'}`);

    await watcher.stop();
    return addedLines.length <= 2 && removedLines.length <= 2;
  } finally { rmDir(dir); }
}

// ── M3-2: 超大文件跳过 ──
async function test_m3_large_file() {
  console.log('\n=== M3-2: 超大文件(>2MB)跳过 diff ===');
  const dir = mkDir('m3large');
  const fp = path.join(dir, 'large.bin');
  try {
    // 写入 3MB 文件
    const buf = Buffer.alloc(3 * 1024 * 1024, 0x41);
    fs.writeFileSync(fp, buf);

    const watcher = new FileWatcher({ usePolling: false });
    const diffs = [];
    watcher.on('file:diff', d => diffs.push(d));

    watcher._generateDiff(fp, 'modified');
    await sleep(200);

    const d = diffs[0];
    console.log(`  skipped: ${d?.diffSkipped}, reason: ${d?.diffSkipReason}`);
    const ok = d?.diffSkipped === true && d?.diffSkipReason?.includes('过大');
    console.log(`  结果: ${ok ? '✅ 跳过' : '❌ 未跳过'}`);

    await watcher.stop();
    return ok;
  } finally { rmDir(dir); }
}

// ── M3-3: 二进制文件跳过 ──
async function test_m3_binary() {
  console.log('\n=== M3-3: 二进制文件跳过 ===');
  const dir = mkDir('m3bin');
  const fp = path.join(dir, 'test.bin');
  try {
    // 写入含 null 字节的文件
    const buf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x00, 0x00, 0x00, 0x00]);
    fs.writeFileSync(fp, buf);

    const watcher = new FileWatcher({ usePolling: false });
    const diffs = [];
    watcher.on('file:diff', d => diffs.push(d));

    watcher._generateDiff(fp, 'modified');
    await sleep(200);

    const d = diffs[0];
    const ok = d?.diffSkipped === true && d?.diffSkipReason?.includes('二进制');
    console.log(`  结果: ${ok ? '✅ 跳过' : '❌ 未跳过'}`);

    await watcher.stop();
    return ok;
  } finally { rmDir(dir); }
}

// ── M3-4: 文件删除状态 ──
async function test_m3_delete() {
  console.log('\n=== M3-4: 文件删除有独立状态 ===');
  const dir = mkDir('m3del');
  const fp = path.join(dir, 'to-delete.txt');
  try {
    fs.writeFileSync(fp, 'will be deleted');

    const watcher = new FileWatcher({ usePolling: false });
    const events = [];
    watcher.on('file:changed', e => events.push(e));
    watcher.on('file:diff', e => events.push({ ...e, event: 'diff' }));

    // 模拟删除
    watcher._updateFileStatus(fp, 'deleted');
    watcher._generateDiff(fp, 'deleted');
    await sleep(200);

    const deletedEvent = events.find(e => e.status === 'deleted');
    const diffEvent = events.find(e => e.event === 'diff');

    console.log(`  deleted 状态: ${deletedEvent ? '✅' : '❌'}`);
    console.log(`  diff 生成: ${diffEvent?.diff ? '✅' : '❌'}`);

    await watcher.stop();
    return !!deletedEvent;
  } finally { rmDir(dir); }
}

// ── M4-1: hook-ping.js 可执行 ──
async function test_m4_hook_ping() {
  console.log('\n=== M4-1: hook-ping.js 可执行 ===');
  try {
    const out = execSync('node hook-ping.js test', {
      cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log(`  执行成功: ✅`);
    return true;
  } catch (err) {
    // hook-ping 在服务未启动时也会静默退出 0
    console.log(`  退出码: ${err.status}`);
    const ok = err.status === 0;
    console.log(`  结果: ${ok ? '✅ 静默退出' : '❌ 异常退出'}`);
    return ok;
  }
}

// ── M4-2: settings.json 合并只增不改 ──
async function test_m4_merge_safety() {
  console.log('\n=== M4-2: settings.json 合并安全性 ===');
  const testDir = mkDir('m4merge');
  const settingsPath = path.join(testDir, 'settings.json');

  try {
    // 写入含敏感键的 settings.json
    const original = {
      env: {
        ANTHROPIC_BASE_URL: 'https://custom.api.com',
        ANTHROPIC_AUTH_TOKEN: 'secret-token-123'
      },
      permissions: { allow: ['Read', 'Write'] }
    };
    fs.writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const installer = new HookInstaller({ settingsPath });

    // 1. 演练
    const dry = installer.dryRun(path.join(testDir, 'hook-ping.js'));
    console.log(`  演练变更: ${dry.changes.join(', ')}`);
    console.log(`  丢失键: ${dry.lostKeys.length === 0 ? '无 ✅' : dry.lostKeys.join(', ') + ' ❌'}`);

    // 2. 安装
    const result = installer.install(path.join(testDir, 'hook-ping.js'));
    console.log(`  .bak 存在: ${fs.existsSync(settingsPath + '.bak') ? '✅' : '❌'}`);

    // 3. 验证原内容不丢
    const merged = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const envPreserved = merged.env?.ANTHROPIC_BASE_URL === 'https://custom.api.com' &&
                         merged.env?.ANTHROPIC_AUTH_TOKEN === 'secret-token-123';
    const permsPreserved = JSON.stringify(merged.permissions) === JSON.stringify(original.permissions);
    const hooksAdded = !!merged.hooks?.Stop?.[0]?.hooks?.[0]?.command;

    console.log(`  env 保留: ${envPreserved ? '✅' : '❌'}`);
    console.log(`  permissions 保留: ${permsPreserved ? '✅' : '❌'}`);
    console.log(`  hooks 添加: ${hooksAdded ? '✅' : '❌'}`);

    // 4. 验证 hook 命令是 node 脚本（不用 curl）
    const hookCmd = merged.hooks?.Stop?.[0]?.hooks?.[0]?.command || '';
    const usesNode = hookCmd.startsWith('node ');
    const noCurl = !hookCmd.includes('curl');
    console.log(`  用 node 脚本: ${usesNode ? '✅' : '❌'}`);
    console.log(`  不用 curl: ${noCurl ? '✅' : '❌'}`);

    return envPreserved && permsPreserved && hooksAdded && usesNode && noCurl;
  } finally { rmDir(testDir); }
}

// ── M4-3: config.json 在 .gitignore ──
async function test_m4_gitignore() {
  console.log('\n=== M4-3: config.json 在 .gitignore ===');
  const gitignorePath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '.gitignore');
  try {
    const content = fs.readFileSync(gitignorePath, 'utf-8');
    const ok = content.includes('config.json');
    console.log(`  config.json 被忽略: ${ok ? '✅' : '❌'}`);
    return ok;
  } catch {
    console.log('  ❌ .gitignore 不存在');
    return false;
  }
}

// ── Run ──
async function main() {
  console.log('🧪 M3/M4 对抗性测试\n');

  const results = [
    await test_m3_crlf(),
    await test_m3_large_file(),
    await test_m3_binary(),
    await test_m3_delete(),
    await test_m4_hook_ping(),
    await test_m4_merge_safety(),
    await test_m4_gitignore()
  ];

  const names = [
    'M3-1 CRLF陷阱', 'M3-2 超大文件', 'M3-3 二进制文件', 'M3-4 文件删除',
    'M4-1 hook-ping', 'M4-2 合并安全', 'M4-3 gitignore'
  ];

  console.log('\n' + '='.repeat(40));
  let pass = 0;
  results.forEach((ok, i) => { console.log(`  ${names[i]}: ${ok ? '✅' : '❌'}`); if (ok) pass++; });
  console.log(`\n  总计: ${pass}/${results.length}`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
