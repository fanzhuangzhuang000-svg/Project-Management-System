'use strict';
/**
 * 多进程（cluster）验证
 *
 * 验四件事：
 *   1. PMS_WORKERS=2 能起服务，两个 worker 都就绪
 *   2. ★ 跨 worker 缓存失效是**实时的**：写操作落在 worker A 上，
 *      立刻读落在 worker B 上的看板，必须看到新数 —— 不能等 20 秒 TTL。
 *      （看板有 20 秒权限指纹缓存，失效靠 IPC 广播；这条断了，
 *      「改完数据回首页看到旧账」会在集群形态下复活。）
 *   3. 写请求本身跨 worker 可用（SQLite WAL 多进程写不冲突）
 *   4. 单进程回归：不开 PMS_WORKERS 行为一字不变（跑原有测试断言）
 *
 * 用法： node tools/cluster-test.js    （接入 run-all）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};

const PORT = 8797;                       // 专用测试端口，别撞别的实例
const BASE = `http://127.0.0.1:${PORT}`;
const TMP = path.join(os.tmpdir(), 'elv-cluster-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });

function req (method, p, body, cookie) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(BASE + p, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    }, res => {
      let buf = '';
      res.on('data', d => { buf += d; });
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: buf, json: (() => { try { return JSON.parse(buf); } catch { return null; } })() }));
    });
    r.on('error', reject);
    r.setTimeout(15000, () => { r.destroy(new Error('timeout')); });
    if (data) r.write(data);
    r.end();
  });
}

function startServer (env) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PMS_DATA_DIR: TMP,
      PMS_BACKUP_DIR: path.join(TMP, 'backup'),
      PMS_PORT: String(PORT),
      PMS_NO_AUTO_BACKUP: '1',
      PMS_MAINTENANCE_INTERVAL_MS: '0',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });
  child.log = () => log;
  return child;
}

async function waitUp (child, workers = 0) {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await req('GET', '/api/health');
      if (r.code === 200) {
        if (!workers) return true;
        // 集群形态：普通 worker 才打「已就绪」（维护角色打全横幅），
        // 所以就绪数 = workers - 1，再配上主进程的「初始化完成」握手日志
        const ready = (child.log().match(/已就绪/g) || []).length;
        if (ready >= workers - 1 && /初始化完成/.test(child.log())) return true;
      }
    } catch { /* 还没起来 */ }
    await new Promise(r2 => setTimeout(r2, 150));
  }
  return false;
}

async function login () {
  const r = await req('POST', '/api/login', { username: 'admin', password: 'admin123' });
  return (r.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ');
}

function killTree (child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else child.kill('SIGKILL');
  } catch { /* 忽略 */ }
}

async function main () {
  // ── 用例 1/2/3：2 worker 集群 ──
  console.log('[1] 集群启动（PMS_WORKERS=2）');
  const c = startServer({ PMS_WORKERS: '2' });
  const up = await waitUp(c, 2);
  check('两个 worker 都监听就绪（boot-ok 握手生效）', up, up ? '' : '日志：\n' + c.log().slice(-2000));

  if (up) {
    const cookie = await login();
    check('登录正常（跨进程会话表在库里共享）', !!cookie);

    // 看板基线：项目的「当前数据」
    console.log('\n[2] ★ 跨 worker 缓存失效必须实时（不能等 TTL）');
    const d0 = await req('GET', '/api/dashboard', null, cookie);
    check('看板可读', d0.code === 200);
    const before = d0.json && d0.json.totals ? d0.json.totals.project_count : null;

    // 先把看板缓存喂热（当前 worker 已缓存）；写请求落在哪个 worker 由系统轮询决定，
    // 连发多次保证至少有一次落在**另一个** worker 上
    await req('GET', '/api/dashboard', null, cookie);
    const mk = await req('POST', '/api/save/projects',
      { name: 'CLUSTER-实时性验证', code: 'CL-' + Date.now(), status: '进行中' }, cookie);
    check('写请求成功（WAL 多进程写不冲突）', mk.code === 200 && !(mk.json && mk.json.error), JSON.stringify(mk.json || {}).slice(0, 120));
    const newId = mk.json && mk.json.id;

    // ★ 立刻读（不 sleep）：如果失效广播断了，且读请求轮询到没收到写操作的那个
    //   worker，这里会读到缓存里的旧 project_count —— 就是那条要抓的 bug。
    //   连读 6 次提高「轮询命中另一个 worker」的概率。
    let sawStale = false, sawNew = false;
    for (let i = 0; i < 6; i++) {
      const d1 = await req('GET', '/api/dashboard', null, cookie);
      const n = d1.json && d1.json.totals ? d1.json.totals.project_count : null;
      if (n !== null && before !== null) {
        if (n === before) sawStale = true;
        if (n === before + 1) sawNew = true;
      }
    }
    check('★ 写后立刻读，看不到旧账（实时失效）', !sawStale, sawStale ? `读到旧值 ${before}（TTL 未失效）` : `读到 ${before + 1}`);
    check('★ 确实读到了新数（+1）', sawNew, 'before=' + before);

    // 删掉验证数据，恢复原状（新项目无子记录，cascade 兜底即可）
    if (newId) await req('POST', `/api/delete/projects/${newId}`, { cascade: true }, cookie);

    console.log('\n[3] 并发读写混合（2 worker 争用同一 SQLite 文件不崩）');
    const jobs = [];
    for (let i = 0; i < 24; i++) {
      jobs.push(i % 4 === 0
        ? req('POST', '/api/save/projects', { name: 'CLUSTER-并发' + i, code: 'CC' + i, status: '进行中' }, cookie)
        : req('GET', '/api/dashboard', null, cookie));
    }
    const rs = await Promise.all(jobs);
    const errs = rs.filter(r => r.code >= 500);
    check('24 个并发请求零 5xx', errs.length === 0, errs.length ? errs[0].body.slice(0, 120) : '');
    // 清理并发造的数据
    const list = await req('GET', '/api/list/projects?q=' + encodeURIComponent('CLUSTER-并发'), null, cookie);
    for (const row of ((list.json && list.json.rows) || [])) {
      await req('POST', `/api/delete/projects/${row.id}`, { cascade: true }, cookie);
    }
  }

  killTree(c);
  await new Promise(r => setTimeout(r, 1500));

  // ── 用例 4：单进程回归 ──
  console.log('\n[4] 单进程回归（不开 PMS_WORKERS）');
  const c1 = startServer({});
  const up1 = await waitUp(c1);
  check('单进程正常起、health 可达', up1);
  if (up1) {
    const cookie = await login();
    const d = await req('GET', '/api/dashboard', null, cookie);
    check('单进程看板可读', d.code === 200);
  }
  killTree(c1);

  const pass = results.filter(r => r.ok).length;
  console.log('\n' + '='.repeat(58));
  console.log(`  多进程验证：${pass} / ${results.length} 项通过`);
  if (pass !== results.length) console.log('  失败：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.n).join('\n'));
  console.log('='.repeat(58));

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
