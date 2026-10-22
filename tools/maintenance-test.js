'use strict';
/**
 * 日常维护（第二十三套）
 *
 * 用法： node tools/maintenance-test.js
 *
 * 盯的是「那些每天该做一次的事，在**不重启**的情况下也会做」。
 *
 * 真实缺口（2026-10 发现）：
 *   过期会话、暂存附件回收、回收站超期清理、月度快照、每日自动备份，
 *   这五件事原来全写在 server.js 的启动流程里 —— 只有进程启动那一刻会跑。
 *   单机版的典型用法是装完就一直开着（关浏览器 ≠ 关服务），
 *   于是一台连续开一个月的机器上：
 *     · 回收站永远不清理，「保留 30 天」形同虚设，附件文件跟着一起占着磁盘
 *     · 自动备份只有装完那天的一份，之后再也没有第二份
 *     · 超过 7 天的暂存附件、过期会话一直不回收
 *
 * 现在这些集中在 maintenance.runDaily()，启动跑一次，之后每小时再跑（幂等）。
 * 测试为了不等一小时，用 PMS_MAINTENANCE_INTERVAL_MS 把间隔压到 800ms，
 * 然后造一份「40 天前删的」回收站条目，看它会不会在**服务运行期间**被清掉。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const WORK = path.join(os.tmpdir(), 'elv-maint-' + process.pid);
const DATADIR = path.join(WORK, 'data');
const BACKUPDIR = path.join(WORK, 'backup');
// ⚠️ 必须在 require('../db.js') 之前设好：db.js 在 require 那一刻就定下了库文件路径。
//    漏了这一行的症状很有迷惑性 —— 测试改的是仓库里的 data/pms.db，
//    被测服务读的是临时目录，断言全飘，看起来像"维护没生效"。
process.env.PMS_DATA_DIR = DATADIR;

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && extra ? '  — ' + extra : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer (port) {
  fs.mkdirSync(DATADIR, { recursive: true });
  const logFile = path.join(WORK, 'run.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PMS_PORT: String(port),
      PMS_DATA_DIR: DATADIR,
      PMS_NO_AUTO_BACKUP: '1',
      // 把"每小时"压成 0.8 秒，否则这条断言只能靠人肉等一小时
      PMS_MAINTENANCE_INTERVAL_MS: '800',
    },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(base + '/api/health'); if (r.ok) return { child, base }; } catch { /* 等 */ }
    await sleep(200);
  }
  throw new Error('测试实例没起来：\n' + fs.readFileSync(logFile, 'utf8').slice(-1200));
}

async function stopServer (srv, port) {
  if (!srv) return;
  try { srv.child.kill(); } catch { /* 忽略 */ }
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) }); } catch { break; }
  }
}

let BASE = '';
let cookie = '';
async function login () {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  if (!r.ok) throw new Error('登录失败：HTTP ' + r.status);
  cookie = /pms_session=([^;]+)/.exec(r.headers.get('set-cookie') || '')[1];
}
async function api (method, p, body) {
  const init = { method, headers: { Cookie: `pms_session=${cookie}` } };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  const r = await fetch(BASE + p, init);
  let data = null;
  try { data = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, data };
}
async function save (t, body) {
  const r = await api('POST', `/api/save/${t}`, body);
  if (r.status !== 200 || !r.data || !r.data.id) throw new Error(`新建 ${t} 失败：${r.status} ${JSON.stringify(r.data)}`);
  return Number(r.data.id);
}
async function upload (tableName, recordId, name) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from('hello', 'utf8')], { type: 'text/plain' }), name);
  fd.append('table_name', tableName);
  fd.append('record_id', String(recordId));
  const r = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: `pms_session=${cookie}` }, body: fd });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('上传失败：' + JSON.stringify(j));
  return j.attachment;
}

/** 等某个异步结果出现（最多 ms 毫秒）。返回 true=出现了 */
async function waitFor (ms, fn) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await sleep(300);
  }
  return false;
}

const backups = () => {
  try { return fs.readdirSync(BACKUPDIR).filter(n => /^pms_\d{8}_\d{6}/.test(n)); } catch { return []; }
};

async function main () {
  console.log('\n  日常维护');
  const port = await freePort();
  const srv = await startServer(port);
  BASE = srv.base;
  await login();

  // 服务进程和本测试进程共用同一个库：改数据用 HTTP，改时间戳只能直接动库
  const dbf = require('../db.js');
  const trash = require('../trash.js');
  const attach = require('../attachments.js');
  const { storage } = require('../storage.js');

  try {
    /* ---------------- [1] 造一条「40 天前删的」回收站条目 ---------------- */
    console.log('\n  [1] 造一条超期的删除记录');
    const pid = await save('projects', { name: 'MAINT-超期项目', status: '进行中' });
    const att = await upload('projects', pid, 'MAINT-扫描件.txt');
    // 带着附件删，必须 cascade —— 否则 409 等二次确认，拿不到 trashId
    const del = await api('POST', `/api/delete/projects/${pid}`, { cascade: true });
    check('删掉项目后有回收站条目', del.status === 200 && !!del.data.trashId, `HTTP ${del.status}`);
    const old = trash.list(50).find(t => t.id === del.data.trashId);
    // 把删除时间改成 40 天前（只有超过 30 天的才会被自动清理）
    const past = new Date(Date.now() - 40 * 86400000);
    const pad = n => String(n).padStart(2, '0');
    const pastStr = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())} ${pad(past.getHours())}:${pad(past.getMinutes())}:${pad(past.getSeconds())}`;
    dbf.db.prepare('UPDATE trash SET deleted_at = ? WHERE id = ?').run(pastStr, del.data.trashId);
    check('已把它改成 40 天前删的', !!old && Number(old.row_count) > 0, 'row_count=' + (old && old.row_count));

    const attStored = attach.get(att.id);
    // 用存储层判断文件在不在，别直接 fs.existsSync（MinIO 模式下文件根本不在本地目录）
    const fileExists = () => !!(attStored && storage.exists(attStored.stored_name));
    check('它的附件文件还在存储里（删记录时只是解除关联）', fileExists(), attStored && attStored.stored_name);

    /* ---------------- [2] 不重启，等服务自己清 ---------------- */
    console.log('\n  [2] 不重启，等运行期维护把超期条目清掉');
    const gone = await waitFor(6000, async () => {
      const r = await api('GET', '/api/trash');
      return !((r.data && r.data.rows) || []).some(t => t.id === del.data.trashId);
    });
    check('超期条目在服务运行期间被清掉了（不是只有重启才清）', gone);
    const fileGone = await waitFor(3000, async () => !fileExists());
    check('它的附件文件也一起删了（不然磁盘只涨不落）', fileGone);

    /* ---------------- [3] 未超期的不能被误删 ---------------- */
    console.log('\n  [3] 刚删的条目要留着');
    const p2 = await save('projects', { name: 'MAINT-新删项目', status: '进行中' });
    const del2 = await api('POST', `/api/delete/projects/${p2}`, { cascade: true });
    await sleep(2500);          // 让维护至少跑两轮
    const still = ((await api('GET', '/api/trash')).data.rows || []).some(t => t.id === del2.data.trashId);
    check('刚删的条目还在（30 天保留期没被提前打破）', still);

    /* ---------------- [4] 自动备份：运行期也会补 ---------------- */
    console.log('\n  [4] 自动备份');
    check('启动时已经备过一份', backups().length > 0, `备份目录 ${BACKUPDIR}`);
    // 把今天的备份删掉，模拟"这台机器已经开了好几天、今天还没备"
    for (const f of backups()) { try { fs.unlinkSync(path.join(BACKUPDIR, f)); } catch { /* 占用中 */ } }
    const backAgain = await waitFor(6000, async () => backups().length > 0);
    check('删掉备份后，运行期会自己补一份（不用重启服务）', backAgain, '备份目录里还是空的');
    const before = backups().length;
    await sleep(2500);
    check('同一天不会重复备份（幂等）', backups().length === before, `${before} → ${backups().length}`);

    /* ---------------- [5] 维护失败不能拖垮服务 ---------------- */
    console.log('\n  [5] 维护出问题也不影响服务');
    const h = await api('GET', '/api/health');
    check('服务仍在正常应答', h.status === 200);
    const dash = await api('GET', '/api/dashboard');
    check('业务接口照常', dash.status === 200 && !!(dash.data && dash.data.totals), `HTTP ${dash.status}`);
    const logs = await api('GET', '/api/logs?limit=5');
    check('日志接口照常', logs.status === 200, `HTTP ${logs.status}`);
  } finally {
    await stopServer(srv, port);
    try { dbf.closeDb && dbf.closeDb(); } catch { /* 忽略 */ }
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length} / ${results.length} 项通过`);
  if (bad.length) {
    console.log('失败项：');
    for (const b of bad) console.log('  ✗ ' + b.name);
  }
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => {
  console.error('\n  [套件异常] ' + e.message);
  process.exit(1);
});
