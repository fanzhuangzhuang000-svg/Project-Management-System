'use strict';
/**
 * 看板缓存正确性（第 N 套）
 *
 * 缓存是性能手段，但它有三个能被搞坏的地方，每个都是真事故：
 *   1) 改了数据还返回旧账   —— 用户录完一笔收款回首页，数字没变，会以为没保存上
 *   2) 命中时内容变了       —— 缓存和实时计算的结果不一致
 *   3) 权限串了             —— 最严重：只有材料读权的账号，看到管理员视角的合同额
 *
 * 第 3 条是这套件存在的核心理由。缓存 key 必须带权限指纹；
 * 一旦有人图省事改成「所有用户共用一份」，本套件 [3][4] 立刻红。
 *
 * 自己起服务（要控制 PMS_DASH_TTL_MS 和独立数据目录）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'elv-dashcache-' + process.pid);
const DATADIR = path.join(WORK, 'data');
const PORT = 8930 + (process.pid % 40);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function startServer (extraEnv = {}) {
  fs.mkdirSync(DATADIR, { recursive: true });
  const env = {
    ...process.env,
    PMS_PORT: String(PORT),
    PMS_DATA_DIR: DATADIR,
    PMS_NO_AUTO_BACKUP: '1',
    PMS_MAINTENANCE_INTERVAL_MS: '0',
    PMS_DASH_TTL_MS: '20000',
    ...extraEnv,
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
  throw new Error('服务没起来：\n' + log.slice(-1200));
}
async function stopServer (srv) {
  if (!srv) return;
  srv.kill('SIGTERM');
  await sleep(500);
  try { srv.kill('SIGKILL'); } catch { /* 已退 */ }
}

/** 登录并返回带 cookie 的 headers */
async function login (username, password) {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!r.ok) throw new Error(`登录 ${username} 失败：HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  const cookie = raw.map(c => String(c).split(';')[0]).join('; ');
  return { Cookie: cookie, 'Content-Type': 'application/json' };
}

/** 请求看板，返回 {json, cache, ms} */
async function dash (headers) {
  const t0 = Date.now();
  const r = await fetch(`${BASE}/api/dashboard`, { headers });
  const json = await r.json();
  return { json, status: r.status, cache: r.headers.get('x-dash-cache'), ms: Date.now() - t0 };
}

async function main () {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(DATADIR, { recursive: true });

  // 先造一点业务数据：看板要对"有合同、有收款"的库才看得出差异
  process.env.PMS_DATA_DIR = DATADIR;
  process.env.PMS_NO_AUTO_BACKUP = '1';
  process.env.PMS_MAINTENANCE_INTERVAL_MS = '0';
  {
    const dbf = require('../db.js');
    dbf.init();
    require('../attachments.js').createTable();
    require('../logs.js').createTable();
    const pid = dbf.insertRow('projects', { name: 'CACHE-项目', status: '进行中', progress: 30 }).id;
    dbf.insertRow('contracts', {
      name: 'CACHE-合同', project_id: pid, amount: 1000000, tax_rate: 9,
      category: '项目合同', direction: 'in', sign_date: '2026-01-10',
    });
    dbf.insertRow('payments', {
      project_id: pid, direction: 'in', kind: '工程款', amount: 123456.78, pay_date: '2026-03-15', method: '银行转账',
    });
    global.__pid = pid;
    dbf.closeDb();
  }

  let srv = await startServer();
  try {
    const A = await login('admin', 'admin123');

    // ── [1] 命中与内容一致 ──
    console.log('\n[1] 缓存命中');
    const d1 = await dash(A);
    check('第一次是实时计算（miss）', d1.cache === 'miss', 'X-Dash-Cache: ' + d1.cache);
    const d2 = await dash(A);
    check('第二次走缓存（hit）', d2.cache === 'hit', 'X-Dash-Cache: ' + d2.cache);
    check('命中与实时的内容完全一致', JSON.stringify(d1.json) === JSON.stringify(d2.json));
    check('命中明显更快', d2.ms <= Math.max(20, d1.ms), `miss ${d1.ms}ms → hit ${d2.ms}ms`);

    // ── [2] 写操作后必须失效 ──
    console.log('\n[2] 写完数据不能给旧账');
    const before = d2.json.totals.payment_count;
    const paidBefore = d2.json.totals.paid_in;
    const sv = await fetch(`${BASE}/api/save/payments`, {
      method: 'POST', headers: A,
      body: JSON.stringify({
        project_id: global.__pid, direction: 'in', kind: '工程款',
        amount: 5000.5, pay_date: '2026-06-01', method: '银行转账',
      }),
    });
    check('保存收款成功', sv.status === 200, 'HTTP ' + sv.status);
    const d3 = await dash(A);
    check('写之后第一次请求重新计算（miss）', d3.cache === 'miss', 'X-Dash-Cache: ' + d3.cache);
    check('收款笔数 +1', d3.json.totals.payment_count === before + 1,
      `${before} → ${d3.json.totals.payment_count}`);
    check('已收金额增加 5000.5', Math.abs(d3.json.totals.paid_in - paidBefore - 5000.5) < 0.01,
      `${paidBefore} → ${d3.json.totals.paid_in}`);

    // ── [3] 权限隔离（最要紧） ──
    console.log('\n[3] 不同权限不能串缓存');
    // 建一个只能读 materials 的账号：它没有合同读权，看板里的合同额必须是 null
    const uname = 'cacheprobe_' + Date.now().toString(36);
    const cr = await fetch(`${BASE}/api/users`, {
      method: 'POST', headers: A,
      body: JSON.stringify({ username: uname, name: '缓存探测', role: 'custom', read: ['materials'], write: [], sys: [] }),
    });
    const cj = await cr.json().catch(() => ({}));
    if (cj.error) throw new Error('建账号失败：' + cj.error);
    const P = await login(uname, '123456');

    // 先让 admin 的缓存热起来，确保受限账号不是"捡了空缓存"
    await dash(A);
    const pd = await dash(P);
    check('受限账号能打开看板', pd.status === 200, 'HTTP ' + pd.status);
    check('受限账号看不到合同额（null）', pd.json.totals.contract_in === null,
      'contract_in = ' + JSON.stringify(pd.json.totals.contract_in));
    check('受限账号看不到已收款（null）', pd.json.totals.paid_in === null,
      'paid_in = ' + JSON.stringify(pd.json.totals.paid_in));
    check('受限账号的品类统计被清空', Object.keys(pd.json.by_category || {}).length === 0,
      'by_category ' + Object.keys(pd.json.by_category || {}).length + ' 项');

    const ad = await dash(A);
    check('admin 仍能看到合同额（没被受限账号的缓存覆盖）',
      typeof ad.json.totals.contract_in === 'number' && ad.json.totals.contract_in > 0,
      'contract_in = ' + JSON.stringify(ad.json.totals.contract_in));
    check('两个身份的响应体不同（说明各存各的）',
      JSON.stringify(ad.json) !== JSON.stringify(pd.json));

    // ── [4] 交替请求不串味 ──
    console.log('\n[4] 交替请求');
    let bad = 0;
    for (let i = 0; i < 6; i++) {
      const a = await dash(A);
      const p = await dash(P);
      if (!(typeof a.json.totals.contract_in === 'number')) bad++;
      if (p.json.totals.contract_in !== null) bad++;
    }
    check('6 轮交替请求，身份与内容始终对应', bad === 0, bad ? bad + ' 次串了' : '12 次请求全部正确');

    // ── [6] 失效面必须按「真的改了哪张表」收窄 ──
    //
    // 以前是「只要不是 GET 就全清」：登录、退出、备份、清日志、甚至 400/404
    // 都会把全公司的看板缓存打掉。下面是两个方向都要守：
    //   · 没改业务数据的请求 → 必须仍然命中（否则每次登录都全站重算一遍）
    //   · 改了业务数据的请求 → 必须立刻 miss（否则就是丢更新）
    console.log('\n[6] 失效面收窄（按脏表而不是按请求方法）');
    const post = async (p, body, headers) => {
      const r = await fetch(BASE + p, {
        method: 'POST',
        headers: headers || { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, json: await r.json().catch(() => null), headers: r.headers };
    };
    const hitOrMiss = async () => (await dash(A)).cache;

    await dash(A);                                  // 保证已有缓存
    check('基线：连续两次请求第二次命中', (await dash(A)).cache === 'hit', await hitOrMiss());

    // 重复登录：只写 sessions + logs
    await login('admin', 'admin123');
    check('重复登录不会打掉看板缓存', (await dash(A)).cache === 'hit', 'X-Dash-Cache: ' + await dash(A).then(r => r.cache));

    // 退出再登录：写 sessions
    await post('/api/logout', {}, A);
    const A2 = await login('admin', 'admin123');
    await dash(A2);
    check('退出/登录不会打掉看板缓存（同一账号仍命中）', (await dash(A2)).cache === 'hit');

    // 备份：只写文件 + 一条日志
    const bk = await post('/api/backup', {}, A2);
    check('备份接口可用', bk.status === 200, 'HTTP ' + bk.status);
    check('备份不会打掉看板缓存', (await dash(A2)).cache === 'hit');

    // 清日志：只动 logs 表
    const lp = await post('/api/logs/purge', { days: 3650 }, A2);
    check('清日志接口可用', lp.status === 200, 'HTTP ' + lp.status);
    check('清日志不会打掉看板缓存', (await dash(A2)).cache === 'hit');

    // 校验失败（400）：一个字都没写进库
    const badReq = await post('/api/save/payments', { direction: 'in', amount: 'not-a-number', pay_date: '' }, A2);
    check('非法收款被拒（400/422）', badReq.status >= 400 && badReq.status < 500, 'HTTP ' + badReq.status);
    check('被拒的写请求不会打掉看板缓存', (await dash(A2)).cache === 'hit');

    // 未知接口（404）
    const nf = await post('/api/does-not-exist', {}, A2);
    check('未知接口返回 404', nf.status === 404, 'HTTP ' + nf.status);
    check('404 不会打掉看板缓存', (await dash(A2)).cache === 'hit');

    // 建账号：改的是 users 表，「管理人员」要立刻变
    const nu = await post('/api/users', { username: 'cache-probe', name: '缓存探针', role: 'custom', status: '启用', password: 'Probe@12345' }, A2);
    check('建账号成功', nu.status === 200 && !(nu.json && nu.json.error), 'HTTP ' + nu.status);
    check('★ 建账号后看板必须重算（管理人员数变了）', (await dash(A2)).cache === 'miss');
  } finally {
    await stopServer(srv.srv);
  }

  // ── [5] TTL 到期后自动重算 ──
  console.log('\n[5] TTL 到期');
  try {
    srv = await startServer({ PMS_DASH_TTL_MS: '600' });
    const A2 = await login('admin', 'admin123');
    const a1 = await dash(A2);
    const a2 = await dash(A2);
    check('短 TTL 下先 miss 再 hit', a1.cache === 'miss' && a2.cache === 'hit', `${a1.cache} → ${a2.cache}`);
    await sleep(900);
    const a3 = await dash(A2);
    check('超过 TTL 后重新计算', a3.cache === 'miss', 'X-Dash-Cache: ' + a3.cache);
  } finally {
    await stopServer(srv && srv.srv);
    fs.rmSync(WORK, { recursive: true, force: true });
  }

  const pass = results.filter(r => r.ok).length;
  console.log(`\n  看板缓存正确性：${pass} / ${results.length} 项通过`);
  if (pass !== results.length) {
    console.log('  失败的项：' + results.filter(r => !r.ok).map(r => r.name).join('、'));
    process.exitCode = 1;
  }
}

main().catch(e => {
  console.error('\n  [套件异常] ' + e.message);
  try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 忽略 */ }
  process.exitCode = 1;
});
