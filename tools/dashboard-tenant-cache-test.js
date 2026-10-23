'use strict';
/**
 * 多租户下的看板缓存隔离（HTTP 级）
 *
 * 为什么单独一套
 *   tenant-cross-test 直接调 dbf.dashboard()，**绕过了 HTTP 缓存层**，
 *   所以它测不到「两个租户共用一份缓存」这种事。而这正是真实泄漏路径：
 *   缓存 key 只有权限指纹、没有 tenant_id 时，租户 2 里权限和租户 1 管理员
 *   相同的账号会直接命中租户 1 的那份 JSON —— 看到的是别家公司的账。
 *
 * 判定标准（严格按"用户视角"）：
 *   · 租户 2 第一次请求必须是 miss（修复前会是 hit）
 *   · 租户 2 的金额/项目数只能是自己那份
 *   · 响应全文不能出现租户 1 的项目名
 *   · 交替请求 4 轮，身份与数字始终对应
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'elv-dashtenant-' + process.pid);
const DATADIR = path.join(WORK, 'data');
const PORT = 8990 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;

const W1 = 1_110_003;      // 租户 1 的合同额
const W2 = 2_220_007;      // 租户 2 的合同额

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** 先把两个租户和各自的数据造好，再起服务 */
function prepare () {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(DATADIR, { recursive: true });

  process.env.PMS_DATA_DIR = DATADIR;
  process.env.PMS_NO_AUTO_BACKUP = '1';
  process.env.PMS_MAINTENANCE_INTERVAL_MS = '0';
  process.env.MULTI_TENANT = '1';

  const dbf = require('../db.js');
  const tenant = require('../tenant.js');
  dbf.init();
  // 这几张表都是各自模块在 init() 之后才建的（服务启动时那次顺序也在这里复刻）
  require('../auth.js').createTable();
  require('../logs.js').createTable();
  require('../snapshots.js').createTable();
  require('../attachments.js').createTable();
  tenant.ensureColumns();
  require('../auth.js').ensureAdmin();   // admin / admin123（租户 1）

  // 租户 1：一个带名字的项目 + 一份合同
  tenant.setTenant(1);
  const p1 = dbf.insertRow('projects', { name: 'T1-CACHE-项目', code: 'T1C-1', status: '进行中' });
  dbf.insertRow('contracts', {
    name: 'T1-CACHE-合同', project_id: p1.id, direction: 'in',
    amount: W1, tax_rate: 9, category: '项目合同', sign_date: '2026-01-10',
  });

  // 租户 2：管理员账号 + 自己的项目与合同
  const c2 = tenant.create({ name: '缓存隔离二公司', adminUser: 'admin2', adminPassword: 'admin2-pass-123' });
  if (!c2.ok) throw new Error('建租户 2 失败：' + c2.error);
  tenant.setTenant(2);
  const p2 = dbf.insertRow('projects', { name: 'T2-CACHE-项目', code: 'T2C-1', status: '进行中' });
  dbf.insertRow('contracts', {
    name: 'T2-CACHE-合同', project_id: p2.id, direction: 'in',
    amount: W2, tax_rate: 9, category: '项目合同', sign_date: '2026-02-10',
  });

  dbf.closeDb();
}

async function startServer () {
  const env = {
    ...process.env,
    PMS_PORT: String(PORT),
    PMS_DATA_DIR: DATADIR,
    PMS_NO_AUTO_BACKUP: '1',
    PMS_MAINTENANCE_INTERVAL_MS: '0',
    PMS_DASH_TTL_MS: '20000',
    MULTI_TENANT: '1',
  };
  const srv = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d.toString(); });
  srv.stderr.on('data', d => { log += d.toString(); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1200) });
      if (r.ok) return { srv, log: () => log };
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('服务没起来：\n' + log.slice(-1500));
}

async function stopServer (srv) {
  if (!srv) return;
  srv.kill('SIGTERM');
  await sleep(500);
  try { srv.kill('SIGKILL'); } catch { /* 已退出 */ }
}

async function login (username, password) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`登录 ${username} 失败：HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  return { Cookie: raw.map(c => String(c).split(';')[0]).join('; '), 'Content-Type': 'application/json' };
}

async function dash (headers) {
  const r = await fetch(`${BASE}/api/dashboard`, { headers });
  const json = await r.json();
  return { json, status: r.status, cache: r.headers.get('x-dash-cache'), body: JSON.stringify(json) };
}

async function main () {
  prepare();
  const srv = await startServer();
  try {
    const A1 = await login('admin', 'admin123');
    const A2 = await login('admin2', 'admin2-pass-123');

    console.log('\n[1] 两个租户各自的首次请求都必须是实时计算');
    const t1a = await dash(A1);
    check('租户 1 首请求 miss', t1a.cache === 'miss', 'X-Dash-Cache: ' + t1a.cache);
    check('租户 1 的合同额含自己那份', t1a.json.totals.contract_in >= W1 - 0.01,
      'contract_in = ' + t1a.json.totals.contract_in);

    const t2a = await dash(A2);
    check('★ 租户 2 首请求必须 miss（修复前会命中租户 1 的缓存）', t2a.cache === 'miss', 'X-Dash-Cache: ' + t2a.cache);
    check('★ 租户 2 看到的是自己的合同额', Math.abs(t2a.json.totals.contract_in - W2) < 0.01,
      'contract_in = ' + t2a.json.totals.contract_in + '，应为 ' + W2);
    check('★ 租户 2 的项目数只算自己的', t2a.json.totals.project_count === 1,
      'project_count = ' + t2a.json.totals.project_count);
    check('★ 租户 2 的响应里没有租户 1 的项目名', !t2a.body.includes('T1-CACHE-项目'));
    check('★ 租户 2 的响应里没有租户 1 的合同名', !t2a.body.includes('T1-CACHE-合同'));

    console.log('\n[2] 第二次请求各自命中自己的缓存');
    const t1b = await dash(A1);
    const t2b = await dash(A2);
    check('租户 1 第二次命中', t1b.cache === 'hit', 'X-Dash-Cache: ' + t1b.cache);
    check('租户 2 第二次命中', t2b.cache === 'hit', 'X-Dash-Cache: ' + t2b.cache);
    check('两份缓存内容不同（不是共用一份）', t1b.body !== t2b.body);

    console.log('\n[3] 交替 4 轮，身份与数字始终对应');
    let bad = 0;
    for (let i = 0; i < 4; i++) {
      const a = await dash(A1);
      const b = await dash(A2);
      if (!(Math.abs(b.json.totals.contract_in - W2) < 0.01)) bad++;
      if (a.body.includes('T2-CACHE-项目') || b.body.includes('T1-CACHE-项目')) bad++;
      if (a.json.totals.project_count >= t2b.json.totals.project_count + 1 && b.json.totals.project_count === a.json.totals.project_count) bad++;
    }
    check('4 轮交替不串（8 次请求）', bad === 0, bad ? bad + ' 次异常' : '');

    console.log('\n[4] 租户 1 写完，租户 2 的缓存不受影响但也不会读到脏数据');
    const save = await fetch(`${BASE}/api/save/projects`, {
      method: 'POST', headers: A1,
      body: JSON.stringify({ name: 'T1-CACHE-新项目', code: 'T1C-2', status: '进行中' }),
    });
    check('租户 1 写项目成功', save.status === 200, 'HTTP ' + save.status);
    const t1c = await dash(A1);
    check('租户 1 立刻看到新项目（写后必 miss）', t1c.cache === 'miss' &&
      t1c.json.totals.project_count === t1b.json.totals.project_count + 1,
      'project_count ' + t1b.json.totals.project_count + ' → ' + t1c.json.totals.project_count);
    const t2c = await dash(A2);
    check('★ 租户 2 没被带脏（项目数不变、合同额不变）',
      t2c.json.totals.project_count === 1 && Math.abs(t2c.json.totals.contract_in - W2) < 0.01,
      'project_count = ' + t2c.json.totals.project_count + ' / contract_in = ' + t2c.json.totals.contract_in);
  } finally {
    await stopServer(srv.srv);
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  const pass = results.filter(r => r.ok).length;
  console.log(`\n  多租户看板缓存隔离：${pass} / ${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
