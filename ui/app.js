/**
 * CC Cockpit — Grafana-style monitoring dashboard
 */

const S = {
  ws: null, sessions: new Map(), activeSid: null, files: [],
  cfg: { pricing: {}, usd_to_cny: 7.25, cost_warning_threshold_cny: 50 },
  autoScroll: true, rcTimer: null, rcCount: 0,
};

const $ = id => document.getElementById(id);
const D = {
  sList: $('s-list'), sCnt: $('s-cnt'),
  mFlow: $('m-flow'), mCnt: $('m-cnt'),
  fList: $('f-list'), fCnt: $('f-cnt'),
  mIn: $('m-in'), mOut: $('m-out'), mCache: $('m-cache'),
  mCost: $('m-cost'), mCostCard: $('m-cost-card'),
  wsRing: $('ws-ring'), wsTxt: $('ws-txt'),
  hooksEl: $('hooks-el'),
};

// ── WebSocket ──

function wsConnect() {
  const p = location.protocol === 'https:' ? 'wss:' : 'ws:';
  S.ws = new WebSocket(`${p}//${location.host}`);
  S.ws.onopen = () => { S.rcCount = 0; wsOk(true); };
  S.ws.onclose = () => { wsOk(false); wsRetry(); };
  S.ws.onmessage = e => { try { route(JSON.parse(e.data)); } catch {} };
}

function wsRetry() {
  if (S.rcTimer) return;
  S.rcTimer = setTimeout(() => { S.rcTimer = null; wsConnect(); }, Math.min(1000 * 2 ** S.rcCount++, 30000));
}

function wsOk(ok) {
  D.wsRing.classList.toggle('on', ok);
  D.wsTxt.textContent = ok ? '已连接' : '断开';
}

// ── Router ──

function route(m) {
  const h = {
    'init': onInit, 'session:created': onNewSession, 'session:updated': onUpdSession,
    'message': onMsg, 'messages': onBulk, 'files': f => { S.files = f || []; drawFiles(); },
    'file:changed': onFileChg, 'file:diff': onFileDiff,
  };
  h[m.type]?.(m);
}

function onInit(m) {
  S.cfg = m.config || S.cfg;
  for (const s of m.sessions) S.sessions.set(s.sessionId, { ...s, messages: [], sc: new Map() });
  if (m.files) S.files = m.files;
  drawSessions();
  if (m.sessions.length && !S.activeSid) pickSession(m.sessions[0].sessionId);
  drawFiles();
  calcCost();
  loadHooks();
}

function onNewSession(m) {
  if (S.sessions.has(m.sessionId)) return;
  S.sessions.set(m.sessionId, {
    sessionId: m.sessionId, projectName: m.projectName, summary: '',
    lastActivity: new Date(), status: 'running', messageCount: 0,
    tokenUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    modelBreakdown: {}, messages: [], sc: new Map()
  });
  drawSessions();
  if (!S.activeSid) pickSession(m.sessionId);
}

function onUpdSession(m) {
  const s = S.sessions.get(m.sessionId);
  if (!s) return;
  if (m.detail) Object.assign(s, m.detail);
  drawSessions();
  calcCost();
}

function onMsg(m) {
  const s = S.sessions.get(m.sessionId);
  if (!s) return;
  s.messages.push(m.message);
  s.messageCount = s.messages.length;
  s.lastActivity = new Date(m.message.timestamp);
  if (m.message.isSidechain) {
    if (!s.sc.has(m.message.id)) s.sc.set(m.message.id, []);
    s.sc.get(m.message.id).push(m.message);
  }
  if (m.sessionId === S.activeSid) {
    appendMsg(m.message);
    D.mCnt.textContent = s.messages.length;
    if (S.autoScroll) goBottom();
  }
  drawSessions();
  calcCost();
}

function onBulk(m) {
  const s = S.sessions.get(m.sessionId);
  if (!s) return;
  s.messages = m.messages || [];
  s.messageCount = s.messages.length;
  if (m.sessionId === S.activeSid) { drawAllMsgs(); D.mCnt.textContent = s.messages.length; }
}

// ── Files ──

function onFileChg(d) {
  const i = S.files.findIndex(f => f.filePath === d.filePath);
  const e = { filePath: d.filePath, basename: d.filePath.split(/[/\\]/).pop(), status: d.status, timestamp: d.timestamp, isToolWritten: d.isToolWritten||false, toolCall: d.toolCall||null, diff: null, diffSkipped: false, diffSkipReason: '' };
  if (i >= 0) S.files[i] = { ...S.files[i], ...e }; else S.files.unshift(e);
  drawFiles();
}

function onFileDiff(d) {
  const i = S.files.findIndex(f => f.filePath === d.filePath);
  if (i >= 0) { S.files[i].diff = d.diff; S.files[i].diffSkipped = d.diffSkipped; S.files[i].diffSkipReason = d.diffSkipReason; }
  drawFiles();
}

function drawFiles() {
  D.fCnt.textContent = S.files.length;
  if (!S.files.length) { D.fList.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted);font-size:12px">尚无改动</div>'; return; }
  D.fList.innerHTML = S.files.map((f, i) => {
    const ico = f.isToolWritten ? '⚡' : f.status === 'deleted' ? '🗑' : f.status === 'created' ? '✨' : '📄';
    const icoC = f.isToolWritten ? 'tool' : '';
    const tagC = f.isToolWritten ? 'tool-written' : f.status;
    const t = f.timestamp ? fmtT(new Date(f.timestamp)) : '';
    const tool = f.toolCall ? ` · ${f.toolCall.toolName}` : '';
    const diff = f.diffSkipped ? `<div class="diff-skip">⏭ ${esc(f.diffSkipReason||'跳过')}</div>` : f.diff ? mkDiff(f.diff) : '<div class="diff-skip">无 diff</div>';
    return `<div class="file" data-i="${i}">
      <div class="file-row"><span class="file-icon ${icoC}">${ico}</span><span class="file-name" title="${esc(f.filePath)}">${esc(f.basename)}</span><span class="file-tag ${tagC}">${f.status}</span></div>
      <div class="file-meta">${t}${tool}</div>
      <div class="diff">${diff}</div>
    </div>`;
  }).join('');
  D.fList.querySelectorAll('.file').forEach(el => el.addEventListener('click', () => el.classList.toggle('open')));
}

function mkDiff(d) {
  if (!d) return '';
  let h = '<table class="diff-tbl">', n = 0;
  for (const l of d.split('\n')) {
    n++;
    const e = esc(l);
    if (l.startsWith('@@')) h += `<tr><td class="diff-ln"></td><td class="diff-c hdr">${e}</td></tr>`;
    else if (l.startsWith('+')) h += `<tr><td class="diff-ln">${n}</td><td class="diff-c add">${e}</td></tr>`;
    else if (l.startsWith('-')) h += `<tr><td class="diff-ln">${n}</td><td class="diff-c del">${e}</td></tr>`;
    else h += `<tr><td class="diff-ln">${n}</td><td class="diff-c ctx">${e}</td></tr>`;
  }
  return h + '</table>';
}

// ── Hooks ──

async function loadHooks() {
  try { const r = await fetch('/api/hooks/status'); drawHooks(await r.json()); } catch {}
}

function drawHooks(d) {
  D.hooksEl.innerHTML = d.hooksInstalled
    ? '<span class="badge ok">✓ Hooks</span>'
    : '<span class="badge missing" id="h-btn">⚠ 安装</span>';
  $('h-btn')?.addEventListener('click', async () => {
    try { const r = await fetch('/api/hooks/install', { method: 'POST' }); const j = await r.json();
      if (j.success) { loadHooks(); alert(`已安装\n备份: ${j.backupPath}`); } else alert('失败: ' + (j.error||''));
    } catch (e) { alert('失败: ' + e.message); }
  });
}

// ── Sessions ──

function drawSessions() {
  const sorted = [...S.sessions.values()].sort((a, b) => new Date(b.lastActivity||0) - new Date(a.lastActivity||0));
  D.sCnt.textContent = sorted.length;
  D.sList.innerHTML = sorted.map(s => {
    const act = s.sessionId === S.activeSid;
    const st = s.status === 'running' ? 'on' : 'off';
    const t = s.lastActivity ? fmtT(new Date(s.lastActivity)) : '--';
    const tu = s.tokenUsage || {};
    const tok = (tu.input||0) + (tu.output||0);
    const models = Object.keys(s.modelBreakdown || {});
    const mdl = models[0]?.replace(/^claude-/, '').replace(/-\d{8}$/, '').slice(0, 12) || '';
    return `<div class="session ${act?'active':''}" data-sid="${s.sessionId}">
      <div class="session-row1"><span class="status ${st}"></span><span class="name">${esc(s.projectName||'')}</span>${mdl?`<span class="model">${esc(mdl)}</span>`:''}</div>
      <div class="session-row2"><span>💬 ${s.messageCount||0}</span>${tok?`<span>🔤 ${fmtK(tok)}</span>`:''}<span>🕐 ${t}</span></div>
      ${s.summary?`<div class="summary">${esc(s.summary)}</div>`:''}
    </div>`;
  }).join('');
  D.sList.querySelectorAll('.session').forEach(el => el.addEventListener('click', () => pickSession(el.dataset.sid)));
}

function pickSession(sid) {
  S.activeSid = sid;
  if (S.ws?.readyState === 1) S.ws.send(JSON.stringify({ type: 'getMessages', sessionId: sid }));
  drawSessions();
  drawAllMsgs();
}

// ── Messages ──

function drawAllMsgs() {
  const s = S.sessions.get(S.activeSid);
  D.mFlow.innerHTML = '';
  if (!s?.messages.length) { D.mFlow.innerHTML = '<div class="empty"><div class="ico">📡</div><div class="ttl">等待消息</div></div>'; D.mCnt.textContent = '0'; return; }
  const f = document.createDocumentFragment();
  for (const m of s.messages) { const el = mkMsg(m); if (el) f.appendChild(el); }
  D.mFlow.appendChild(f);
  D.mCnt.textContent = s.messages.length;
  goBottom();
}

function appendMsg(m) {
  D.mFlow.querySelector('.empty')?.remove();
  const el = mkMsg(m); if (el) D.mFlow.appendChild(el);
}

function mkMsg(m) {
  if (m.isSidechain) return mkSC(m);
  const c = document.createElement('div');
  c.className = `msg ${m.type}`;
  c.innerHTML = `<div class="msg-head"><span class="msg-tag">${m.type}</span>${m.model?`<span class="msg-model">${esc(m.model)}</span>`:''}<span class="msg-time">${fmtT(new Date(m.timestamp))}</span></div>`;
  const b = document.createElement('div'); b.className = 'msg-body';
  for (const bl of m.blocks) {
    if (bl.type === 'text') { const d = document.createElement('div'); d.textContent = bl.text; b.appendChild(d); }
    else if (bl.type === 'thinking') b.appendChild(mkThink(bl));
    else if (bl.type === 'tool_use') b.appendChild(mkTool(bl));
    else if (bl.type === 'tool_result') b.appendChild(mkRes(bl));
    else if (bl.type === 'raw') { const pre = document.createElement('pre'); pre.style.cssText='font-size:11px;color:var(--text-muted)'; pre.textContent=JSON.stringify(bl.data,null,2); b.appendChild(pre); }
  }
  c.appendChild(b); return c;
}

function mkThink(b) {
  const el = document.createElement('div'); el.className = 'think';
  el.innerHTML = `<div class="think-head">💭 思考 <span style="float:right">▶</span></div><div class="think-body">${esc(b.text)}</div>`;
  el.querySelector('.think-head').addEventListener('click', () => {
    el.classList.toggle('open');
    el.querySelector('.think-head span').textContent = el.classList.contains('open') ? '▼' : '▶';
  });
  return el;
}

function toolTag(n) {
  if (['Read'].includes(n)) return 'read';
  if (['Write','Edit','MultiEdit'].includes(n)) return 'write';
  if (['Grep','Glob'].includes(n)) return 'search';
  if (['Bash','Agent'].includes(n)) return 'exec';
  return 'other';
}

function mkTool(b) {
  const t = toolTag(b.name);
  const el = document.createElement('div'); el.className = 'tool';
  el.innerHTML = `<div class="tool-head"><span class="tool-badge ${t}">${b.name}</span><span class="tool-preview">${esc(b.input||'')}</span><span class="tool-arrow">▶</span></div><div class="tool-body">${esc(b.input||'(no input)')}</div>`;
  el.querySelector('.tool-head').addEventListener('click', () => {
    el.classList.toggle('open');
    el.querySelector('.tool-arrow').textContent = el.classList.contains('open') ? '▼' : '▶';
  });
  return el;
}

function mkRes(b) {
  const el = document.createElement('div');
  el.className = 'tool-result' + (b.is_error ? ' err' : '');
  el.innerHTML = b.is_error ? `<strong>❌</strong> ${esc(b.content||'')}` : `<strong>→</strong> ${esc(b.content||'(empty)')}`;
  return el;
}

function mkSC(m) {
  const el = document.createElement('div'); el.className = 'sc';
  el.innerHTML = `<div class="sc-head">🔀 子任务 · ${m.blocks.length} 条 <span style="float:right">▶</span></div><div class="sc-body">${m.blocks.map(b=>`<div style="font-size:11px;padding:3px 0;color:var(--text-secondary)">${esc(b.text||JSON.stringify(b))}</div>`).join('')}</div>`;
  el.querySelector('.sc-head').addEventListener('click', () => {
    el.classList.toggle('open');
    el.querySelector('.sc-head span').textContent = el.classList.contains('open') ? '▼' : '▶';
  });
  return el;
}

// ── Cost ──

function getMP(m) {
  if (!m) return null;
  const p = S.cfg.pricing||{}, ml = m.toLowerCase();
  if (p[ml]) return p[ml];
  for (const k of Object.keys(p).sort((a,b)=>b.length-a.length)) if (ml.startsWith(k.toLowerCase())) return p[k];
  return null;
}

function calcCost() {
  let ti=0,to=0,tr=0,usd=0,unk=false;
  for (const s of S.sessions.values()) {
    const u=s.tokenUsage||{}; ti+=u.input||0; to+=u.output||0; tr+=u.cacheRead||0;
    if (s.modelBreakdown) for (const [m,u2] of Object.entries(s.modelBreakdown)) {
      const p=getMP(m);
      if (p) usd+=((u2.input||0)/1e6)*p.input+((u2.output||0)/1e6)*p.output+((u2.cacheRead||0)/1e6)*p.cache_read+((u2.cacheWrite||0)/1e6)*p.cache_write;
      else unk=true;
    }
  }
  D.mIn.textContent = fmtK(ti); D.mOut.textContent = fmtK(to); D.mCache.textContent = fmtK(tr);
  if (unk && usd===0) {
    D.mCost.textContent = '未知定价 ⚙'; D.mCostCard.className = 'metric clickable unknown'; D.mCostCard.onclick = pricingModal;
  } else {
    const cny = usd * S.cfg.usd_to_cny;
    D.mCost.textContent = `$${usd.toFixed(4)} (¥${cny.toFixed(2)})`;
    D.mCostCard.className = `metric clickable${cny>=S.cfg.cost_warning_threshold_cny?' warn':''}`;
    D.mCostCard.onclick = unk ? pricingModal : null;
  }
}

function pricingModal() {
  const models = new Set();
  for (const s of S.sessions.values()) if (s.modelBreakdown) Object.keys(s.modelBreakdown).forEach(m=>models.add(m));
  const ex = S.cfg.pricing||{};
  const rows = [...models].map(m=>{ const p=ex[m]||{}; return `<tr><td style="font-weight:600;font-family:monospace">${esc(m)}</td><td><input data-m="${m}" data-f="input" value="${p.input||''}"></td><td><input data-m="${m}" data-f="output" value="${p.output||''}"></td><td><input data-m="${m}" data-f="cache_read" value="${p.cache_read||''}"></td><td><input data-m="${m}" data-f="cache_write" value="${p.cache_write||''}"></td></tr>`; }).join('');
  const ov = document.createElement('div'); ov.className = 'overlay';
  ov.innerHTML = `<div class="modal"><h3>⚙ 设置定价</h3><p class="sub">USD / 百万 token</p><table><tr><th>模型</th><th>Input</th><th>Output</th><th>Cache-R</th><th>Cache-W</th></tr>${rows}</table><div class="modal-actions"><button class="btn btn-ghost" id="pc">取消</button><button class="btn btn-primary" id="ps">保存</button></div></div>`;
  document.body.appendChild(ov);
  ov.querySelector('#pc').onclick = () => ov.remove();
  ov.addEventListener('click', e => { if (e.target === ov) ov.remove(); });
  ov.querySelector('#ps').onclick = () => {
    for (const inp of ov.querySelectorAll('input[data-m]')) { const m=inp.dataset.m,f=inp.dataset.f,v=parseFloat(inp.value); if(!S.cfg.pricing[m])S.cfg.pricing[m]={}; if(!isNaN(v))S.cfg.pricing[m][f]=v; }
    ov.remove(); calcCost();
    fetch('/api/pricing',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(S.cfg.pricing)}).catch(()=>{});
  };
}

// ── Scroll ──

function goBottom() { requestAnimationFrame(()=>{ D.mFlow.scrollTop = D.mFlow.scrollHeight; }); }
D.mFlow.addEventListener('scroll', () => {
  const {scrollTop,scrollHeight,clientHeight} = D.mFlow;
  S.autoScroll = scrollHeight-scrollTop-clientHeight < 50;
  if (!S.autoScroll && !D.mFlow.querySelector('.paused-bar')) {
    const bar = document.createElement('div'); bar.className = 'paused-bar'; bar.textContent = '⏸ 自动滚动已暂停';
    bar.onclick = () => { S.autoScroll=true; bar.remove(); goBottom(); };
    D.mFlow.appendChild(bar);
  }
});

// ── Util ──

function fmtT(d) { return isNaN(d)?'--:--':`${d.getHours().toString().padStart(2,'0')}:${d.getMinutes().toString().padStart(2,'0')}:${d.getSeconds().toString().padStart(2,'0')}`; }
function fmtK(n) { return n>=1e6?(n/1e6).toFixed(1)+'M':n>=1e3?(n/1e3).toFixed(1)+'K':n.toString(); }
function esc(s) { if(!s)return''; const d=document.createElement('div');d.textContent=s;return d.innerHTML; }

// ── Init ──

fetch('/api/pricing').then(r=>r.json()).then(p=>{S.cfg.pricing=p;calcCost();}).catch(()=>{});
wsConnect();
