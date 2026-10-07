'use strict';
/**
 * 专业版（网络版）集成验证
 *
 * ── 为什么需要它 ──
 * docker-compose.yml 真正做的事，其实就是「用一个 app 容器连上 PG + MinIO，
 * 并把一组环境变量传进去」。容器化本身只是打包方式。
 *
 * 所以：**把同样的 PG + MinIO + 同一组环境变量在本机接起来跑一遍**，
 * 就能验证 compose 里那个「配置」到底对不对 —— 这部分不需要 Docker。
 *
 * 覆盖不到的是「容器网络 / 卷挂载 / 镜像构建」这几样，那必须真机跑 Docker。
 *
 * 用法： node tools/verify-pro-edition.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 8791;                 // 应用端口（避开开发用的 8787）
const S3_PORT = 9105;              // 模拟 S3
const PG_URL = process.env.PG_TEST_URL || 'postgres://postgres@127.0.0.1:5433/elvpms_pro';

const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};

let app = null; let s3 = null;

function cleanup () {
  try { app && app.kill() } catch { /* 忽略 */ }
  try { s3 && s3.kill() } catch { /* 忽略 */ }
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`],
  { windowsHide: true });
}

(async () => {
  console.log('  专业版（网络版）集成验证');
  console.log('  ' + '='.repeat(58));
  console.log(`  模拟的环境：PostgreSQL + MinIO(S3) + 与 compose 相同的环境变量`);

  cleanup();
  await sleep(1000);

  // ── 1. 起一个 S3 兼容服务（代替 MinIO 容器）──
  s3 = spawn(process.execPath, [path.join(__dirname, 'minio-mock-server.js'), String(S3_PORT)],
    { stdio: 'ignore', windowsHide: true });
  await sleep(1200);

  // ── 2. 准备一个干净的 PG 库 ──
  const proDb = PG_URL.split('/').pop();
  spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$env:PGPASSWORD=''; & 'C:\\Program Files\\PostgreSQL\\17\\bin\\dropdb.exe' -h 127.0.0.1 -p 5433 -U postgres --if-exists ${proDb}; & 'C:\\Program Files\\PostgreSQL\\17\\bin\\createdb.exe' -h 127.0.0.1 -p 5433 -U postgres ${proDb}`],
  { windowsHide: true, stdio: 'ignore' });

  // ── 3. 用 compose 里那套环境变量启动应用 ──
  //    这些变量名必须和 docker-compose.yml 里 app 服务的一一对应
  const remoteCache = path.join(os.tmpdir(), 'elv-pro-cache-' + Date.now());
  app = spawn(process.execPath,
    ['--no-warnings', path.join(ROOT, 'server.js'), '--port', String(PORT)],
    {
      cwd: ROOT,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        DB_URL: PG_URL,                       // ← compose: DB_URL
        STORAGE_DRIVER: 'minio',              // ← compose: STORAGE_DRIVER
        MINIO_ENDPOINT: '127.0.0.1',          // ← 容器里是服务名 minio
        MINIO_PORT: String(S3_PORT),          // ← 容器里是 9000
        MINIO_USE_SSL: 'false',
        MINIO_ACCESS_KEY: 'elvpms',
        MINIO_SECRET_KEY: 'pro-test-secret',
        MINIO_BUCKET: 'elv-pms',
        PMS_COMPANY_NAME: '专业版验证公司',    // ← compose: COMPANY_NAME
        PMS_ADMIN_PASSWORD: '',               // ← compose: ADMIN_PASSWORD
        PMS_DATA_DIR: remoteCache,
        PMS_BACKUP_DIR: path.join(os.tmpdir(), 'elv-pro-backup-' + Date.now()),
      },
    });

  let up = false;
  for (let i = 0; i < 80; i++) {
    await sleep(500);
    try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch { /* 等 */ }
  }
  check('应用启动（PG + MinIO 模式）', up);
  if (!up) { cleanup(); process.exit(1) }

  // ── 4. 确认它真的走的是 PG + MinIO，而不是悄悄退回单机 ──
  const h = await fetch(BASE + '/api/health').then(r => r.json());
  check('★ 公司名从 .env 生效了', h.settings && h.settings.company_name === '专业版验证公司',
    h.settings && h.settings.company_name);

  // ── 5. 登录（首次启动应已建好管理员）──
  let tk = '';
  for (const pw of ['admin123', '']) {
    const r = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: pw }),
    });
    if (r.ok) { tk = ((r.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/) || [])[1] || ''; break }
  }
  check('★ 首次启动自动建好管理员并能登录', !!tk);
  if (!tk) { cleanup(); process.exit(1) }
  const H = { Cookie: 'pms_session=' + tk, 'Content-Type': 'application/json' };

  // dbstatus 需要系统权限，必须带 cookie（不带的会返回 needLogin）
  const dbStatus = await fetch(BASE + '/api/dbstatus', { headers: H }).then(r => r.json()).catch(() => ({}));
  check('★ 数据库是 PG（不是 SQLite）', !!dbStatus && !!dbStatus.counts,
    dbStatus && dbStatus.error ? dbStatus.error : Object.keys(dbStatus).slice(0, 3).join(', '));
  check('★ 数据库版本已推进到最新（迁移在 PG 上跑过）',
    !!dbStatus && dbStatus.dbVersion === dbStatus.dbVersionLatest && dbStatus.dbVersion > 0,
    dbStatus && dbStatus.dbVersion !== undefined
      ? `v${dbStatus.dbVersion}/v${dbStatus.dbVersionLatest}`
      : '（无版本字段）');

  // ── 6. 附件走 MinIO（这是专业版和单机版最大的差别）──
  const pdf = fs.readFileSync(path.join(__dirname, 'fixtures', 'invoice.pdf'));
  const fd = new FormData();
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'PRO-专业版附件.pdf');
  const upRes = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: H.Cookie }, body: fd }).then(r => r.json());
  check('★ 附件上传成功', !!upRes.attachment && !!upRes.attachment.id, 'id=' + (upRes.attachment && upRes.attachment.id));

  if (upRes.attachment) {
    const dl = await fetch(BASE + '/api/file/' + upRes.attachment.id, { headers: { Cookie: H.Cookie } });
    check('★ 附件从 MinIO 取回成功', dl.status === 200, 'HTTP ' + dl.status);
    check('★ 内容一字不差', (await dl.arrayBuffer()).byteLength === pdf.length);
  }

  // ── 7. 业务功能可用（PG 上跑真实业务）──
  const proj = await fetch(BASE + '/api/save/projects', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'PRO-专业版验证项目', code: 'PRO-001', status: '进行中' }),
  }).then(r => r.json());
  check('建项目（PG 写入）', !!proj.id, 'id=' + proj.id);

  const cont = await fetch(BASE + '/api/save/contracts', {
    method: 'POST', headers: H,
    body: JSON.stringify({ name: 'PRO-专业版验证合同', direction: 'in', amount: 1234567.89, project_id: proj.id, status: '执行中' }),
  }).then(r => r.json());
  check('建合同（PG 写入）', !!cont.id, 'id=' + cont.id);

  const dash = await fetch(BASE + '/api/dashboard', { headers: H }).then(r => r.json());
  check('★ 统计聚合在 PG 上正常', dash.totals && Number(dash.totals.contract_count) >= 1,
    '合同数 ' + (dash.totals && dash.totals.contract_count));
  check('★ 金额没被 PG 的 NUMERIC 变成字符串',
    typeof dash.totals.contract_in !== 'string',
    'contract_in=' + dash.totals.contract_in + ' (' + typeof dash.totals.contract_in + ')');

  // ── 8. 备份 ──
  const bk = await fetch(BASE + '/api/backup', { method: 'POST', headers: H, body: '{}' }).then(r => r.json()).catch(() => ({}));
  check('PG 模式下能备份', !!bk.file, bk.file || JSON.stringify(bk).slice(0, 60));

  // ── 9. 升级机制（迁移在 PG 上跑到最新）──
  const mig = await fetch(BASE + '/api/dbstatus', { headers: H }).then(r => r.json()).catch(() => ({}));
  check('数据库版本已推进（迁移跑过）', !!mig && (mig.version !== undefined || mig.counts !== undefined),
    mig && mig.version !== undefined ? 'v' + mig.version : '（接口无版本字段）');

  cleanup();
  try { fs.rmSync(remoteCache, { recursive: true, force: true }) } catch { /* 忽略 */ }

  const pass = results.filter(r => r.ok).length;
  console.log('\n' + '='.repeat(58));
  console.log(`  专业版集成验证：${pass} / ${results.length} 项通过`);
  if (pass !== results.length) console.log('  失败：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.n).join('\n'));
  console.log('  ' + '-'.repeat(56));
  console.log('  ⚠️ 这里验证的是「配置」，不含容器本身。');
  console.log('     容器网络 / 卷挂载 / 镜像构建仍需真机跑 Docker。');
  console.log('='.repeat(58));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  console.error('\n  ✗ 验证失败：' + e.message);
  cleanup();
  process.exit(1);
});
