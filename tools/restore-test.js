'use strict';
/**
 * 备份与还原（第二十一套）
 *
 * 用法： node tools/restore-test.js
 *
 * 为什么自己起服务：还原这条链路要求"先停服务再还原"，共享测试实例不能停，
 * 所以整套流程自带一个独立实例和一个独立数据目录。
 *
 * 真实故障（2026-10 实测，不是假设）：
 *   备份 → 删一个项目 → 停服务 → `node tools/restore-backup.js`
 *     → 打印「✓ 已还原到 …」「现在可以启动服务了」
 *     → 启动服务，项目数还是删除后的 2，**备份里的那个项目没回来**。
 *
 *   原因有两层：
 *   ① 还原脚本自己 require 了 db.js，等于自己开着这个库。
 *      Windows 上只要还有句柄，unlink 就 EBUSY —— 而那个 unlink 被
 *      `catch {}` 空吞了：pms.db 没删掉，pms.db-wal 也没删掉。
 *   ② 旧的 -wal 里装的正是"还原前"的那次删除。文件拷过去后，服务一启动
 *      就把 WAL 回放进去 —— 数据回到还原前，而用户看到的是"还原成功"。
 *
 * 现在：先关掉自己的连接 → 探测有没有别人占着（HTTP 探活比 dbId / 改名 /
 * 排他锁）→ 有就拒绝并说清怎么停服务 → 文件删不掉也拒绝，绝不半途往前走。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const TMPROOT = path.join(os.tmpdir(), 'elv-restore-test-' + process.pid);

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

async function startServer (dataDir, port) {
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'run.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PMS_PORT: String(port), PMS_DATA_DIR: dataDir },
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

/** 停服务，并且**等到文件真的松手**（不然下一步还原会被自己的残留句柄挡住） */
async function stopServer (srv, port) {
  if (!srv) return;
  try { srv.child.kill(); } catch { /* 忽略 */ }
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    let alive = false;
    try { const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(500) }); alive = r.ok; } catch { alive = false }
    if (!alive) break;
  }
  await sleep(600);   // 端口没应答之后句柄通常几十毫秒内释放，多等一会儿更稳
}

function runTool (args, dataDir, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--no-warnings', ...args], {
      cwd: ROOT,
      env: { ...process.env, PMS_DATA_DIR: dataDir, PMS_NO_AUTO_BACKUP: '1', ...env },
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', d => { out += d });
    child.stderr.on('data', d => { out += d });
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } }, 120000);
    child.on('close', code => { clearTimeout(timer); resolve({ code, out }) });
  });
}

/** 直接读库（不经过 HTTP），避免"服务缓存/回放 WAL"干扰判断 */
function countProjects (file) {
  const { DatabaseSync } = require('node:sqlite');
  const d = new DatabaseSync(file);
  try { return d.prepare('SELECT COUNT(*) n FROM projects').get().n } finally { d.close() }
}

(async () => {
  const dataDir = path.join(TMPROOT, 'data');
  const dbFile = path.join(dataDir, 'pms.db');
  const port = await freePort();
  let srv = null;

  try {
    srv = await startServer(dataDir, port);
    const cookie = await (async () => {
      const r = await fetch(srv.base + '/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'admin123' }),
      });
      return 'pms_session=' + /pms_session=([^;]+)/.exec(r.headers.get('set-cookie') || '')[1];
    })();
    const api = (p, body) => fetch(srv.base + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(r => r.json());

    const before = countProjects(dbFile);
    console.log(`  [准备] 初始项目数 ${before}`);
    check('测试实例里有示例数据', before > 0, '项目数 ' + before);

    // ── 1. 备份 ──
    console.log('\n [1] 生成一份备份');
    const bk = await api('/api/backup', {});
    check('备份成功且报的是 SQLite 原生副本', bk.ok === true && bk.format === 'sqlite-vacuum-into',
      `${bk.ok} / ${bk.format || bk.error}`);
    const bkFile = bk.path;
    check('备份文件确实落在硬盘上', !!bkFile && fs.existsSync(bkFile), bkFile);
    check('备份里的项目数和当前一致', !!bkFile && countProjects(bkFile) === before,
      bkFile ? `${countProjects(bkFile)} vs ${before}` : '');

    // ── 2. 服务在跑时必须拒绝还原 ──
    console.log('\n [2] 服务还在跑：必须拒绝，不能"假成功"');
    {
      const r = await runTool(['tools/restore-backup.js'], dataDir, { PMS_PORT: String(port) });
      check('服务在跑时还原被拒绝（退出码非 0）', r.code !== 0, '退出码 ' + r.code);
      check('拒绝的理由说清楚是谁占着库', /占着这个数据库|正跑着|被占用/.test(r.out), r.out.slice(-160).replace(/\s+/g, ' '));
      check('拒绝时提示了怎么停服务', /停止系统\.bat|停掉服务|关掉那个/.test(r.out));
      check('拒绝时没有动数据（项目数没变）', countProjects(dbFile) === before, '现在 ' + countProjects(dbFile));
    }

    // ── 3. 制造数据差异 ──
    console.log('\n [3] 删一个项目，制造"和备份不一样"的现状');
    const list = await api('/api/list/projects?limit=1');
    const victim = list.rows[0].id;
    await api('/api/delete/projects/' + victim, { cascade: true });
    const afterDelete = countProjects(dbFile);
    check('删除后项目数少了 1', afterDelete === before - 1, `${before} → ${afterDelete}`);

    // ── 4. 停服后还原 ──
    console.log('\n [4] 停服务 → 还原 → 数据必须回来');
    await stopServer(srv, port); srv = null;
    const r = await runTool(['tools/restore-backup.js'], dataDir);
    check('还原命令成功', r.code === 0, r.out.slice(-200).replace(/\s+/g, ' '));
    check('还原后项目数回到备份时的值', countProjects(dbFile) === before, '现在 ' + countProjects(dbFile));
    check('还原后没有残留的 -wal（否则旧数据会被回放）',
      !fs.existsSync(dbFile + '-wal') || fs.statSync(dbFile + '-wal').size === 0,
      fs.existsSync(dbFile + '-wal') ? fs.statSync(dbFile + '-wal').size + ' 字节' : '没有');

    // ── 5. 起服务复查（防止"文件对了、服务读到的还是旧数据"）──
    console.log('\n [5] 重新起服务，从界面的角度看数据回来了没有');
    srv = await startServer(dataDir, port);
    {
      const ck = await (async () => {
        const rr = await fetch(srv.base + '/api/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ username: 'admin', password: 'admin123' }),
        });
        return 'pms_session=' + /pms_session=([^;]+)/.exec(rr.headers.get('set-cookie') || '')[1];
      })();
      const dash = await fetch(srv.base + '/api/dashboard', { headers: { Cookie: ck } }).then(x => x.json());
      check('服务读到的项目数也是还原后的值', Number(dash.totals.project_count) === before,
        `接口 ${dash.totals.project_count} / 期望 ${before}`);

      // 删掉的那个项目应该能重新查到（不只是数量对得上）
      const again = await fetch(srv.base + '/api/get/projects/' + victim, { headers: { Cookie: ck } }).then(x => x.json());
      // /api/get/<table>/<id> 直接返回行对象本身，不是 {row}
      check('被删的那个项目确实回来了（按 id 查得到）', !!(again && again.id), JSON.stringify(again).slice(0, 120));
    }
  } catch (e) {
    check('测试过程未抛异常', false, e.message);
  } finally {
    if (srv) { try { srv.child.kill() } catch { /* 忽略 */ } }
    await sleep(800);
    try { fs.rmSync(TMPROOT, { recursive: true, force: true }) } catch { /* 忽略 */ }
  }

  const bad = results.filter(x => !x.ok);
  console.log(`\n${results.length - bad.length} / ${results.length} 项通过`);
  if (bad.length) {
    console.log('失败项：');
    for (const b of bad) console.log('  ✗ ' + b.name);
  }
  process.exit(bad.length ? 1 : 0);
})();
