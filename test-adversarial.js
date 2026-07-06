import fs from 'fs';
import path from 'path';
import { Tailer } from './core/tailer.js';
import { SessionManager } from './core/sessions.js';

const BASE = path.join(process.env.USERPROFILE || process.env.HOME, '.claude', 'projects');
const sleep = ms => new Promise(r => setTimeout(r, ms));

function mkDir(name) {
  const d = path.join(BASE, `_test_${name}_${Date.now()}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function rmDir(d) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }

// Helper: write line + poke tailer (bypass chokidar timing issues)
function appendLine(tailer, fp, obj) {
  fs.appendFileSync(fp, JSON.stringify(obj) + '\n');
  tailer.poke(fp);
}

// ─── Test 1: 大文件追加 1 行 ───
async function test1() {
  console.log('\n=== 测试 1: 大文件追加 1 行 ===');
  const dir = mkDir('t1');
  const fp = path.join(dir, 's1.jsonl');
  try {
    // 500 行预填充
    const filler = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(500) }] }, sessionId: 's1', timestamp: new Date().toISOString() }) + '\n';
    fs.writeFileSync(fp, filler.repeat(500));
    console.log(`  文件大小: ${(fs.statSync(fp).size / 1024).toFixed(1)} KB`);

    const tailer = new Tailer({ projectsDir: dir, usePolling: true, pollingInterval: 200 });
    const msgs = [];
    tailer.on('message', m => msgs.push(m));
    await tailer.start();
    console.log(`  启动后消息数: ${msgs.length}`);

    // 追加 1 行
    appendLine(tailer, fp, { type: 'user', message: { content: [{ type: 'text', text: '新消息！' }] }, sessionId: 's1', timestamp: new Date().toISOString() });
    await sleep(500); // 给 chokidar 一个机会，但 poke 已经处理了

    console.log(`  追加后消息数: ${msgs.length}`);
    const ok = msgs.length === 501;
    console.log(`  结果: ${ok ? '✅ 通过' : '❌ 失败'}`);
    await tailer.stop();
    return ok;
  } finally { rmDir(dir); }
}

// ─── Test 2: 半行 ───
async function test2() {
  console.log('\n=== 测试 2: 行写一半（无 \\n） ===');
  const dir = mkDir('t2');
  const fp = path.join(dir, 's2.jsonl');
  try {
    const tailer = new Tailer({ projectsDir: dir, usePolling: true, pollingInterval: 200 });
    const msgs = [];
    tailer.on('message', m => msgs.push(m));
    await tailer.start();

    // 完整行
    appendLine(tailer, fp, { type: 'user', message: { content: [{ type: 'text', text: '完整' }] }, sessionId: 's2', timestamp: new Date().toISOString() });
    console.log(`  完整行后: ${msgs.length}`);

    // 半行
    const full = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '半行消息' }] }, sessionId: 's2', timestamp: new Date().toISOString() });
    fs.appendFileSync(fp, full.slice(0, 50));
    tailer.poke(fp);
    console.log(`  半行后: ${msgs.length}（应=1，缓存中）`);

    // 补全
    fs.appendFileSync(fp, full.slice(50) + '\n');
    tailer.poke(fp);
    console.log(`  补全后: ${msgs.length}（应=2）`);

    const ok = msgs.length === 2;
    console.log(`  结果: ${ok ? '✅ 通过' : '❌ 失败'}`);
    await tailer.stop();
    return ok;
  } finally { rmDir(dir); }
}

// ─── Test 3: 非法 JSON / 未知 type ───
async function test3() {
  console.log('\n=== 测试 3: 非法 JSON / 未知 type ===');
  const dir = mkDir('t3');
  const fp = path.join(dir, 's3.jsonl');
  try {
    const tailer = new Tailer({ projectsDir: dir, usePolling: true, pollingInterval: 200 });
    const msgs = [];
    const warns = [];
    tailer.on('message', m => msgs.push(m));
    const orig = console.warn;
    console.warn = (...a) => { warns.push(a.join(' ')); orig(...a); };
    await tailer.start();

    fs.appendFileSync(fp, '这不是JSON\n');
    tailer.poke(fp);
    fs.appendFileSync(fp, '{"bad":\n');
    tailer.poke(fp);
    appendLine(tailer, fp, {});
    appendLine(tailer, fp, { type: 'weird_thing', data: 1, sessionId: 's3', timestamp: new Date().toISOString() });
    appendLine(tailer, fp, { type: 'user', message: { content: [{ type: 'text', text: '正常' }] }, sessionId: 's3', timestamp: new Date().toISOString() });

    console.warn = orig;
    // {} 是合法 JSON → unknown type 消息 + weird_thing + 正常 = 3
    console.log(`  消息数: ${msgs.length}（应=3: {} + unknown type + 正常）`);
    console.log(`  警告数: ${warns.length}（应=2: 两行非法JSON）`);
    console.log(`  进程存活: ✅`);
    const ok = msgs.length === 3 && warns.length >= 2;
    console.log(`  结果: ${ok ? '✅ 通过' : '❌ 失败'}`);
    await tailer.stop();
    return ok;
  } finally { rmDir(dir); }
}

// ─── Test 4: 两个会话并发写 ───
async function test4() {
  console.log('\n=== 测试 4: 两个 CC 会话并发写 ===');
  const dir = mkDir('t4');
  const fpA = path.join(dir, 'a.jsonl');
  const fpB = path.join(dir, 'b.jsonl');
  try {
    const tailer = new Tailer({ projectsDir: dir, usePolling: true, pollingInterval: 200 });
    const bySid = { a: [], b: [] };
    tailer.on('message', m => { if (bySid[m.sessionId]) bySid[m.sessionId].push(m); });
    await tailer.start();

    for (let i = 0; i < 10; i++) {
      appendLine(tailer, fpA, { type: 'user', message: { content: [{ type: 'text', text: `A-${i}` }] }, sessionId: 'a', timestamp: new Date().toISOString() });
      appendLine(tailer, fpB, { type: 'assistant', message: { content: [{ type: 'text', text: `B-${i}` }] }, sessionId: 'b', timestamp: new Date().toISOString() });
    }

    console.log(`  A: ${bySid.a.length}（应=10）  B: ${bySid.b.length}（应=10）`);
    const cross = bySid.a.some(m => m.data.message.content[0].text.startsWith('B-')) ||
                  bySid.b.some(m => m.data.message.content[0].text.startsWith('A-'));
    console.log(`  交叉污染: ${cross ? '❌' : '✅ 无'}`);
    const ok = bySid.a.length === 10 && bySid.b.length === 10 && !cross;
    console.log(`  结果: ${ok ? '✅ 通过' : '❌ 失败'}`);
    await tailer.stop();
    return ok;
  } finally { rmDir(dir); }
}

// ─── Test 5: sidechain ───
async function test5() {
  console.log('\n=== 测试 5: sidechain 消息 ===');
  const dir = mkDir('t5');
  const fp = path.join(dir, 's5.jsonl');
  try {
    const tailer = new Tailer({ projectsDir: dir, usePolling: true, pollingInterval: 200 });
    const sm = new SessionManager(tailer);
    const all = [];
    sm.on('message', ({ message }) => all.push(message));
    await tailer.start();

    appendLine(tailer, fp, { type: 'user', message: { content: [{ type: 'text', text: '主消息' }] }, sessionId: 's5', timestamp: new Date().toISOString() });
    appendLine(tailer, fp, { type: 'assistant', message: { content: [{ type: 'text', text: '子1' }] }, sessionId: 's5', isSidechain: true, uuid: 'sc1', timestamp: new Date().toISOString() });
    appendLine(tailer, fp, { type: 'assistant', message: { content: [{ type: 'text', text: '子2' }] }, sessionId: 's5', isSidechain: true, uuid: 'sc1', timestamp: new Date().toISOString() });
    appendLine(tailer, fp, { type: 'assistant', message: { content: [{ type: 'text', text: '回复' }] }, sessionId: 's5', timestamp: new Date().toISOString() });

    const main = all.filter(m => !m.isSidechain);
    const sc = all.filter(m => m.isSidechain);
    console.log(`  总: ${all.length}（应=4）  主: ${main.length}（应=2）  SC: ${sc.length}（应=2）`);
    const ok = all.length === 4 && main.length === 2 && sc.length === 2;
    console.log(`  结果: ${ok ? '✅ 通过' : '❌ 失败'}`);
    await tailer.stop();
    return ok;
  } finally { rmDir(dir); }
}

// ─── Run ───
async function main() {
  console.log('🧪 对抗性测试清单 1-5 号\n');
  const r = [await test1(), await test2(), await test3(), await test4(), await test5()];
  const names = ['1.大文件追加', '2.半行缓存', '3.非法JSON', '4.并发写入', '5.sidechain'];
  console.log('\n' + '='.repeat(40));
  let pass = 0;
  r.forEach((ok, i) => { console.log(`  ${names[i]}: ${ok ? '✅' : '❌'}`); if (ok) pass++; });
  console.log(`\n  总计: ${pass}/5`);
  process.exit(pass === 5 ? 0 : 1);
}
main().catch(e => { console.error(e); process.exit(1); });
