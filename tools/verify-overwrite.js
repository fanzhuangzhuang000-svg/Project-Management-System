'use strict';
/**
 * 覆盖安装验证：装好 → 服务跑着 → 再覆盖装一次
 *
 * 这是最容易被忽略、也最容易出事的使用场景：
 * 用户装过一次，想装新版，直接双击安装包覆盖。
 * 如果安装程序不停掉正在运行的服务，node.exe 被占用，文件覆盖不进去，
 * 装完会变成一个半新半旧、起不来的程序。
 *
 * 用法： node tools/verify-overwrite.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
// 同 verify-installed.js：必须指向打包脚本的默认产物目录，不要指向 -new 副本，
// 否则验的是某个历史包（本项目因此把"授权有 bug"误判了很久）。
const SETUP_SRC = path.join(ROOT, process.env.PMS_INSTALLER_OUT || 'dist-installer', '弱电项目管理系统-安装程序.exe');
const SETUP = path.join(os.tmpdir(), 'setup-overwrite.exe');
const DIR = path.join(os.tmpdir(), 'ELV-PMS-overwrite');
// 高位端口，避开运行时端口（Windows SO_REUSEADDR 会让两个进程同时"在"一个端口上）
const PORT = Number(process.env.PMS_VERIFY_PORT || 18797);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`); };

function ps (s) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', s], { encoding: 'utf8', windowsHide: true });
  return (r.stdout || '') + (r.stderr || '');
}
const run = (exe, args) => {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
};
const killInstalled = () => ps(`Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${DIR}*' } | Stop-Process -Force -ErrorAction SilentlyContinue`);

async function waitUp (ms = 45000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return true } catch { /* 还没起 */ }
    await sleep(500);
  }
  return false;
}

function startInstalled (logFile) {
  // 把子进程输出留下来：起不来的时候要能看到原因，而不是只说"服务没起来"
  const out = logFile ? fs.openSync(logFile, 'w') : 'ignore';
  return spawn(path.join(DIR, 'node.exe'),
    ['--no-warnings', path.join(DIR, 'app', 'server.js'), '--port', String(PORT)],
    {
      cwd: path.join(DIR, 'app'),
      env: { ...process.env, PMS_DATA_DIR: path.join(DIR, 'data') },
      stdio: ['ignore', out, out],
    });
}

/** 起不来时打印子进程日志，便于定位 */
function dumpChildLog (logFile) {
  try {
    if (fs.existsSync(logFile)) {
      const t = fs.readFileSync(logFile, 'utf8').trim();
      if (t) console.log('      子进程日志：' + t.split('\n').slice(0, 5).join(' | ').slice(0, 400));
      else console.log('      子进程没有任何输出');
    }
  } catch { /* 忽略 */ }
}

(async () => {
  if (!fs.existsSync(SETUP_SRC)) throw new Error('安装包不存在：' + SETUP_SRC);
  console.log('  覆盖安装验证');
  console.log('  ' + '='.repeat(52));

  // 清干净
  try { if (fs.existsSync(DIR)) run(SETUP, ['/uninstall', '/silent', '/dir=' + DIR]) } catch { /* 忽略 */ }
  killInstalled();
  await sleep(1200);
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
  fs.copyFileSync(SETUP_SRC, SETUP);

  console.log('[1] 第一次安装');
  const i1 = run(SETUP, ['/silent', '/dir=' + DIR, '/no-desktop', '/no-autostart']);
  check('首次安装成功', i1.code === 0, `exit=${i1.code}`);
  check('node.exe 完整', fs.existsSync(path.join(DIR, 'node.exe')) && fs.statSync(path.join(DIR, 'node.exe')).size > 70 * 1024 * 1024);

  console.log('\n[2] 启动服务并写入一条业务数据');
  const LOG1 = path.join(os.tmpdir(), 'elv-overwrite-1.log');
  startInstalled(LOG1);
  const up = await waitUp();
  check('服务已启动', up);
  if (!up) dumpChildLog(LOG1);
  let cookie = '';
  if (up) {
    const lr = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    cookie = ((lr.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/) || [])[1] || '';
    const H = { Cookie: 'pms_session=' + cookie, 'Content-Type': 'application/json' };
    const mk = await (await fetch(BASE + '/api/save/partners', {
      method: 'POST', headers: H, body: JSON.stringify({ name: '覆盖安装测试单位', type: '甲方' }),
    })).json();
    check('写入一条测试数据', !!mk.id, 'id=' + mk.id);
  }

  console.log('\n[3] ★ 服务还在跑的时候直接覆盖安装');
  const i2 = run(SETUP, ['/silent', '/dir=' + DIR, '/no-desktop', '/no-autostart']);
  check('覆盖安装成功（安装程序应自动停掉旧服务）', i2.code === 0, `exit=${i2.code}`);
  if (i2.code !== 0) console.log('      ' + i2.out.trim().split('\n').slice(0, 6).join('\n      '));

  console.log('\n[4] 覆盖后程序是新的、数据还在');
  check('node.exe 仍在且完整', fs.existsSync(path.join(DIR, 'node.exe')) && fs.statSync(path.join(DIR, 'node.exe')).size > 70 * 1024 * 1024);
  const jsN = fs.existsSync(path.join(DIR, 'app')) ? fs.readdirSync(path.join(DIR, 'app')).filter(f => f.endsWith('.js')).length : 0;
  check('后端模块齐全', jsN >= 11, `${jsN} 个 js`);
  check('data 目录保留', fs.existsSync(path.join(DIR, 'data')));

  killInstalled();
  await sleep(1200);
  const LOG2 = path.join(os.tmpdir(), 'elv-overwrite-2.log');
  const child2 = startInstalled(LOG2);
  const up2 = await waitUp();
  check('覆盖后服务能正常起来', up2);
  if (!up2) dumpChildLog(LOG2);
  if (up2 && cookie) {
    const l = await (await fetch(BASE + '/api/list/partners?q=' + encodeURIComponent('覆盖安装测试'), {
      headers: { Cookie: 'pms_session=' + cookie },
    })).json();
    check('★ 覆盖安装后业务数据完好', (l.rows || []).length === 1, `${(l.rows || []).length} 条`);
  }

  console.log('\n[5] 清理');
  try { child2.kill() } catch { /* 忽略 */ }
  killInstalled();
  await sleep(800);
  run(SETUP, ['/uninstall', '/silent', '/dir=' + DIR]);
  await sleep(1500);
  ps(`Remove-Item '${DIR}' -Recurse -Force -ErrorAction SilentlyContinue`);
  try { fs.rmSync(SETUP, { force: true }) } catch { /* 忽略 */ }
  check('已清理测试环境', !fs.existsSync(path.join(DIR, 'node.exe')));

  const pass = results.filter(Boolean).length;
  console.log('\n' + '='.repeat(52));
  console.log(`  ══ ${pass === results.length ? '全部通过' : (results.length - pass) + ' 项失败'}（${pass}/${results.length}）══`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('\n  ✗ 验证失败：' + e.message); process.exit(1) });
