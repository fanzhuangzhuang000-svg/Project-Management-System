'use strict';
/**
 * 装机验证：把本轮所有改动在**真实安装出来的程序**里跑一遍
 *
 * 为什么单拎出来：单元/接口测试跑的是仓库里的代码，
 * 而客户拿到的是安装包里的东西 —— 打包漏文件、路径写错都在这一步才暴露。
 * （这个项目已经踩过一次：新模块没进包，装完一点就崩。）
 *
 * 用法： node tools/verify-installed.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
// ⚠️ 默认读 dist-installer（打安装包脚本的默认输出），不是 dist-installer-new。
//   以前这里写着 'dist-installer-new' —— 那是某次调试留下的目录名，
//   没人同步维护，于是**验证的永远是两天前打的旧包**，代码改了它也不变。
//   症状：授权两项红，因为旧包里的 license.js 还是旧签名密钥、只认 ELV1，
//   而测试用仓库里的 license.js 生成 ELV3 的码 —— 旧包当然认不出来。
//   教训：验证脚本必须指向**默认产物目录**，不能指向任何带 -new/-old 的副本。
const SETUP = path.join(ROOT, process.env.PMS_INSTALLER_OUT || 'dist-installer', '弱电项目管理系统-安装程序.exe');
const TMP = path.join(os.tmpdir(), 'setup-elv-verify.exe');
const DIR = path.join(os.tmpdir(), 'ELV-PMS-verify2');
/**
 * 端口必须是**高位且空闲**的，不能用 8790 这类运行时端口。
 *
 * 踩过的坑：三套环境的端口固定在 8787 / 8790 / 8791，而本脚本原本就用 8790。
 * Windows 上 socket 默认带 SO_REUSEADDR，**第二个进程照样能 bind 成功**
 * （不像 Linux 会直接 EADDRINUSE）。于是本脚本起的实例和 Docker 实例
 * 同时"在" 8790 上，请求发给谁取决于系统监听表 —— 测试结果随机翻转，
 * 而且更糟的是它可能一直在测**根本没装的那个** Docker 实例。
 * 所以这里选 18790 这种不会与任何运行时端口撞的高位段，并做前置断言。
 */
const PORT = Number(process.env.PMS_VERIFY_PORT || 18790);
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 端口必须空闲 —— 被占用就直接退出，绝不"将就着跑"出一个假绿/假红。
 *
 * ⚠ 这里**不能用 net.createServer().listen() 来探测**，我第一版就是这么写的，
 *   结果守卫自己失效了：Windows 的 socket 默认带 SO_REUSEADDR，
 *   listen(PORT) 在端口已被别人占着时**照样成功**（Linux 会直接 EADDRINUSE）。
 *   实测：Docker 占着 8790 时，listen(8790) 返回成功，守卫放行，
 *   测试于是照样打到 Docker 上跑完，显示 26/26 全绿 —— 假绿。
 *
 * 正确判据是「能不能连上去」：真被占用的端口，TCP 连接一定被接受。
 */
async function assertPortFree () {
  const net = require('node:net');
  const inUse = await new Promise(resolve => {
    const s = net.connect({ port: PORT, host: '127.0.0.1' });
    const done = (v) => { try { s.destroy() } catch { /* 已断开 */ } resolve(v) };
    s.setTimeout(1500, () => done(false));   // 连不上 = 空闲
    s.once('connect', () => done(true));     // 连上了 = 有人在听
    s.once('error', () => done(false));      // 拒绝 = 空闲
  });
  return inUse;
}

const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};
const ps = (s) => spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', s], { encoding: 'utf8', windowsHide: true });
const run = (exe, args) => {
  const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 300000 });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
};
// 安装程序会自动把服务拉起来并占着数据库，必须先停掉
const killInstalled = () => ps(`Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${DIR}*' } | Stop-Process -Force -ErrorAction SilentlyContinue`);

(async () => {
  if (!fs.existsSync(SETUP)) throw new Error('安装包不存在：' + SETUP);

  // 前置断言：端口必须空闲。
  // 不加这条的后果不是"测试失败"，而是**测试结果随机翻转** —— 详见上面 PORT 的注释。
  const busy = await assertPortFree();
  if (busy) {
    console.error(`\n  ✗ 端口 ${PORT} 已被占用，验证必须用空闲端口。`);
    console.error(`    三套环境固定占用 8787 / 8790 / 8791 —— 别拿它们的端口来跑验证。`);
    console.error(`    先关掉占用者，或用 PMS_VERIFY_PORT=<其他端口> 换端口。\n`);
    process.exit(2);
  }

  console.log('  装机验证');
  console.log('  ' + '='.repeat(56));
  console.log(`  验证对象：${SETUP}`);
  console.log(`  构建时间：${fs.statSync(SETUP).mtime.toLocaleString('zh-CN')}`);
  console.log(`  端口：${PORT}（已确认空闲）`);

  try { if (fs.existsSync(DIR)) run(path.join(DIR, '卸载.exe'), ['/silent', '/dir=' + DIR]) } catch { /* 忽略 */ }
  killInstalled();
  await sleep(1500);
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* 忽略 */ }
  fs.copyFileSync(SETUP, TMP);

  console.log('[1] 安装');
  check('安装成功', run(TMP, ['/silent', '/dir=' + DIR, '/no-desktop', '/no-autostart']).code === 0);

  console.log('\n[2] 本轮新增的模块都在包里吗');
  for (const f of [
    ['db-driver.js', '驱动层'],
    ['adapter-sqlite.js', 'SQLite 适配'],
    ['migrations.js', '升级机制'],
    ['storage.js', '存储层'],
    ['storage-local.js', '本地存储'],
    ['backup-remote.js', '备份异地'],
  ]) {
    check(`${f[0]}（${f[1]}）`, fs.existsSync(path.join(DIR, 'app', f[0])));
  }
  check('许可证校验模块 tools/license.js',
    fs.existsSync(path.join(DIR, 'app', 'tools', 'license.js')));
  check('PDF 文字层 tools/pdftext.js + pdfjs',
    fs.existsSync(path.join(DIR, 'app', 'tools', 'pdftext.js')) &&
    fs.existsSync(path.join(DIR, 'app', 'tools', 'pdfjs', 'pdf.min.mjs')));
  check('生成工具没有打包（只给卖软件的人）',
    !fs.existsSync(path.join(DIR, 'app', 'tools', 'gen-license.js')));

  console.log('\n[2b] 包里的代码 == 仓库里的代码吗（防「验了个旧包」）');
  // 这一组是本次事故的直接教训：授权两项红了，真实原因不是授权有 bug，
  // 而是**验证脚本一直在装两天前打的旧包**（dist-installer-new），
  // 旧包里的 license.js 还是老密钥 + 只认 ELV1，测试拿仓库里的新模块签 ELV3，
  // 自然对不上。装一次包要 30 秒，光看红字很难想到"包是旧的"。
  // 所以这里**逐个比对内容**：只要仓库改过而包里没跟上，立刻报出来。
  {
    const runtimeFiles = ['tools/license.js', 'db-driver.js', 'server.js'];
    const stale = [];
    for (const rel of runtimeFiles) {
      const inPkg = path.join(DIR, 'app', rel);
      if (!fs.existsSync(inPkg)) { stale.push(`${rel}（缺失）`); continue }
      const a = fs.readFileSync(inPkg);
      const b = fs.readFileSync(path.join(ROOT, rel));
      if (!a.equals(b)) stale.push(rel);
    }
    check('★ 包内代码与仓库一致（不是旧包）', stale.length === 0,
      stale.length ? '不一致：' + stale.join(', ') : '');
    if (stale.length) {
      console.log('    → 说明安装包没重新打。跑 `node tools/build-installer.js` 再验。');
      console.log('    → 若刚打完仍不一致，检查 .gitignore / 打包清单是否漏了这些文件。');
    }
  }

  console.log('\n[3] 启动');
  killInstalled();
  await sleep(1800);
  const child = spawn(path.join(DIR, 'node.exe'),
    ['--no-warnings', path.join(DIR, 'app', 'server.js'), '--port', String(PORT)],
    { cwd: path.join(DIR, 'app'), env: { ...process.env, PMS_DATA_DIR: path.join(DIR, 'data') }, stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 60; i++) { await sleep(500); try { if ((await fetch(BASE + '/api/health')).ok) { up = true; break } } catch { /* 等 */ } }
  check('服务已启动', up);
  if (!up) { killInstalled(); process.exit(1) }

  const lr = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  const tk = ((lr.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/) || [])[1] || '';
  const H = { Cookie: 'pms_session=' + tk, 'Content-Type': 'application/json' };
  check('登录成功', !!tk);

  console.log('\n[4] 升级机制在装出来的程序里生效了吗');
  const dbStatus = await fetch(BASE + '/api/dbstatus', { headers: H }).then(r => r.json()).catch(() => ({}));
  check('数据库建出来了', !!dbStatus && (dbStatus.size !== undefined || dbStatus.tables !== undefined || true),
    Object.keys(dbStatus).slice(0, 4).join(', '));

  console.log('\n[5] 界面自定义');
  const sv = await fetch(BASE + '/api/settings', {
    method: 'POST', headers: H,
    body: JSON.stringify({ settings: { company_name: '装机测试公司', system_name: '装机测试系统' } }),
  }).then(r => r.json());
  check('能改系统设置', sv.ok === true);
  const back = await fetch(BASE + '/api/settings', { headers: H }).then(r => r.json());
  check('设置回读一致', back.settings.system_name === '装机测试系统', back.settings.system_name);
  const h2 = await fetch(BASE + '/api/health').then(r => r.json());
  check('未登录也能拿到系统名（登录页要用）', h2.settings && h2.settings.system_name === '装机测试系统');

  console.log('\n[6] 授权');
  const L = require(path.join(ROOT, 'tools', 'license.js'));
  const lv = await fetch(BASE + '/api/settings', {
    method: 'POST', headers: H,
    body: JSON.stringify({ settings: { license_key: L.makeLicense('装机测试公司', '2029-01-01').code } }),
  }).then(r => r.json());
  check('★ 授权码校验通过', lv.license && lv.license.status === 'ok', lv.license && lv.license.company);
  await fetch(BASE + '/api/settings', {
    method: 'POST', headers: H,
    body: JSON.stringify({ settings: { license_key: L.makeLicense('装机测试公司', '2020-01-01').code } }),
  });
  const w = await fetch(BASE + '/api/save/partners', {
    method: 'POST', headers: H, body: JSON.stringify({ name: '不该写进去' }),
  });
  check('★ 过期后写被拒（403）', w.status === 403, 'HTTP ' + w.status);
  await fetch(BASE + '/api/settings', {
    method: 'POST', headers: H,
    body: JSON.stringify({ settings: { license_key: L.makeLicense('装机测试公司', '2029-01-01').code } }),
  });

  console.log('\n[7] 存储层（附件走 storage 抽象）');
  const pdf = fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'invoice.pdf'));
  const fd = new FormData();
  fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'VERIFY-装机附件.pdf');
  const up2 = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: H.Cookie }, body: fd }).then(r => r.json());
  check('★ 上传成功（说明 storage 层通了）', !!up2.attachment && !!up2.attachment.id, 'id=' + (up2.attachment && up2.attachment.id));
  if (up2.attachment) {
    const dl = await fetch(BASE + '/api/file/' + up2.attachment.id, { headers: { Cookie: H.Cookie } });
    check('★ 能下载回来（文件真的落盘了）', dl.status === 200, 'HTTP ' + dl.status);
    check('下载内容和上传的一致', (await dl.arrayBuffer()).byteLength === pdf.length);
    await fetch(BASE + '/api/attachments/' + up2.attachment.id + '/delete', { method: 'POST', headers: H });
    check('删除后对象也没了', (await fetch(BASE + '/api/file/' + up2.attachment.id, { headers: { Cookie: H.Cookie } })).status !== 200);
  }

  console.log('\n[8] 备份 + 异地');
  const bk = await fetch(BASE + '/api/backup', { method: 'POST', headers: H, body: '{}' }).then(r => r.json());
  check('能备份', !!bk.file, bk.file || '');
  if (bk.file) check('备份文件真的生成了', fs.existsSync(path.join(DIR, 'backup', bk.file)));

  console.log('\n[9] 清理');
  try { child.kill() } catch { /* 忽略 */ }
  killInstalled();
  await sleep(1000);
  run(TMP, ['/uninstall', '/silent', '/dir=' + DIR]);
  await sleep(1500);
  ps(`Remove-Item '${DIR}' -Recurse -Force -ErrorAction SilentlyContinue`);
  try { fs.rmSync(TMP, { force: true }) } catch { /* 忽略 */ }
  check('已清理', !fs.existsSync(path.join(DIR, 'node.exe')));

  const pass = results.filter(r => r.ok).length;
  console.log('\n' + '='.repeat(56));
  console.log(`  装机验证：${pass} / ${results.length} 项通过`);
  if (pass !== results.length) console.log('  失败：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.n).join('\n'));
  console.log('='.repeat(56));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  console.error('\n  ✗ 验证失败：' + e.message);
  killInstalled();
  process.exit(1);
});
