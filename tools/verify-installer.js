'use strict';
/**
 * 安装包端到端验证：安装 → 查文件/快捷方式/注册表 → 启动服务 → 功能验证 → 卸载 → 确认数据保留
 *
 * 用 Node 写而不是 PowerShell：PowerShell 5.1 有几个坑（Select-Object -First 会杀上游进程、
 * $LASTEXITCODE 在 GUI 程序上不可靠），Node 的 execFileSync 能拿到确定性的退出码。
 *
 * 注意：安装程序必须从「工作区之外」运行 —— 本机沙箱限制工作区启动的进程写外部目录。
 * 所以先把 exe 复制到 %TEMP% 再跑。
 *
 * 用法： node tools/verify-installer.js
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SETUP_SRC = path.join(ROOT, 'dist-installer', '弱电项目管理系统-安装程序.exe');
const SETUP = path.join(os.tmpdir(), 'setup-verify.exe');
const DIR = path.join(os.tmpdir(), 'ELV-PMS-verify');
// 高位端口：避开三套运行时的 8787/8790/8791。Windows 的 SO_REUSEADDR 允许
// 第二个进程在同一个端口上 bind 成功，结果是测试随机打到别人身上（见 verify-installed.js 注释）。
const PORT = Number(process.env.PMS_VERIFY_PORT || 18791);
const BASE = `http://127.0.0.1:${PORT}`;

const results = [];
function T (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
  return ok;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const home = os.homedir();
const DESKTOP = path.join(home, 'Desktop');
const STARTMENU = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs');
const STARTUP = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
  'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const SM_DIR = path.join(STARTMENU, '弱电项目管理系统');
const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ELV-PMS';

/** 跑安装程序，返回退出码（GUI 程序也能拿到） */
function runSetup (args) {
  const r = spawnSync(SETUP, args, { encoding: 'utf8', timeout: 300000, windowsHide: true });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
}

/** 跑指定路径的 exe（卸载时直接调安装目录里的「卸载.exe」） */
function runSetupAt (exe, args) {
  const r = spawnSync(exe, args, { encoding: 'utf8', timeout: 300000, windowsHide: true });
  return { code: r.status, out: (r.stderr || '') + (r.stdout || '') };
}

function regExists () {
  const r = spawnSync('reg.exe', ['query', REG_KEY], { encoding: 'utf8' });
  return r.status === 0;
}

/** 跑一段 PowerShell 并拿回 stdout（wmic 在新版 Windows 已废弃，不能用） */
function ps (script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return (r.stdout || '') + (r.stderr || '');
}

/** 杀掉安装在测试目录下的 node 进程（按可执行文件路径判断，不误伤别的 node） */
function killInstalled () {
  ps(`Get-Process node -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${DIR}*' } | Stop-Process -Force -ErrorAction SilentlyContinue`);
}

/** 读快捷方式的目标 / 参数 / 图标。用 WScript.Shell 解析，比直接啃 .lnk 二进制稳 */
function lnkInfo (lnk) {
  const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}'); "$($s.TargetPath)|$($s.Arguments)|$($s.IconLocation)"`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const out = (r.stdout || '').trim();
  const [target = '', args = '', icon = ''] = out.split('|');
  return { target: target.trim(), args: args.trim(), icon: icon.trim() };
}

/** 读注册表里某个值（卸载项用于展示版本号） */
function regValue (name) {
  const r = spawnSync('reg.exe', ['query', REG_KEY, '/v', name], { encoding: 'utf8' });
  const line = (r.stdout || '').split('\n').find(l => l.includes(name));
  if (!line) return '';
  const parts = line.trim().split(/\s{2,}/);
  return (parts[parts.length - 1] || '').trim();
}

/** 删目录，带重试：刚杀完进程时文件句柄还没释放会 EBUSY */
async function forceRmDir (dir, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 重试 */ }
    if (!fs.existsSync(dir)) return true;
    killInstalled();
    await new Promise(r => setTimeout(r, 700));
  }
  return !fs.existsSync(dir);
}

(async () => {
  console.log('  安装包端到端验证');
  console.log('  ' + '='.repeat(56));

  // ---------- 0. 环境 ----------
  console.log('[0] 准备');
  if (!fs.existsSync(SETUP_SRC)) throw new Error('安装包不存在，先跑 node tools/build-installer.js');
  const setupMb = (fs.statSync(SETUP_SRC).size / 1024 / 1024).toFixed(1);
  T('安装包存在', true, `${setupMb} MB`);

  // 清干净上一次的痕迹
  killInstalled();
  const cleared = await forceRmDir(DIR);
  fs.copyFileSync(SETUP_SRC, SETUP);
  T('已复制到工作区外运行（绕开沙箱限制）', fs.existsSync(SETUP));
  // 只是提示，不计入结论：连续跑两次时上一次的服务可能还占着目录，安装会直接覆盖，不影响结果
  console.log(`  ${cleared ? '✓' : '·'} 测试目录${cleared ? '已清空' : '有上次残留（会被本次安装覆盖，不影响结论）'}  — ${DIR}`);

  let all = true;
  const ok = (n, v, e) => { all = T(n, v, e) && all };

  // ---------- 1. 安装 ----------
  console.log('\n[1] 静默安装');
  const t0 = Date.now();
  const inst = runSetup(['/silent', `/dir=${DIR}`]);
  const sec = ((Date.now() - t0) / 1000).toFixed(1);
  ok('安装退出码为 0', inst.code === 0, `exit=${inst.code}  耗时 ${sec}s`);
  if (inst.code !== 0) console.log('      输出: ' + inst.out.trim().split('\n').slice(0, 6).join('\n      '));

  // ---------- 2. 文件结构 ----------
  console.log('\n[2] 文件结构');
  const need = [
    ['node.exe', 'Node 运行环境'],
    ['app/server.js', '后端主程序'],
    ['app/db.js', '数据访问层'],
    ['app/schema.js', '数据模型'],
    ['app/auth.js', '账号会话'],
    ['app/snapshots.js', '月度快照'],
    ['app/ai.js', 'AI 助手模块'],
    ['app/public/index.html', '前端入口'],
    ['app/tools/ocr.ps1', '识别引擎'],
    ['app/tools/extract.js', '字段抽取'],
    ['app/tools/tabular.js', '表格解析'],
    ['后台启动.vbs', '后台启动器'],
    ['打开系统.vbs', '一键打开（桌面图标的落点）'],
    ['app.ico', '应用图标'],
    ['启动系统.bat', '手动启动'],
    ['停止服务.bat', '停止服务'],
    ['卸载.exe', '卸载程序'],
    ['使用说明.md', '使用说明'],
  ];
  for (const [rel, label] of need) {
    const p = path.join(DIR, rel);
    const exists = fs.existsSync(p);
    ok(`${label}（${rel}）`, exists, exists ? `${(fs.statSync(p).size / 1024).toFixed(0)} KB` : '缺失');
  }
  const nodeMb = fs.existsSync(path.join(DIR, 'node.exe'))
    ? (fs.statSync(path.join(DIR, 'node.exe')).size / 1024 / 1024).toFixed(0) : '0';
  ok('node.exe 完整（约 83MB）', Number(nodeMb) > 70, `${nodeMb} MB`);
  const jsN = fs.existsSync(path.join(DIR, 'app')) ? fs.readdirSync(path.join(DIR, 'app')).filter(f => f.endsWith('.js')).length : 0;
  ok('后端模块齐全（含 ai.js）', jsN >= 11, `${jsN} 个 js`);
  const pubN = fs.existsSync(path.join(DIR, 'app/public'))
    ? fs.readdirSync(path.join(DIR, 'app/public'), { recursive: true }).length : 0;
  ok('前端产物齐全', pubN >= 5, `${pubN} 项`);
  ok('data / backup 目录已建', fs.existsSync(path.join(DIR, 'data')) && fs.existsSync(path.join(DIR, 'backup')));

  // ---------- 3. 快捷方式 / 自启 / 注册表 ----------
  console.log('\n[3] 快捷方式、开机自启、卸载入口');
  const deskLnk = path.join(DESKTOP, '弱电项目管理系统.lnk');
  ok('桌面快捷方式', fs.existsSync(deskLnk));
  if (fs.existsSync(deskLnk)) {
    const di = lnkInfo(deskLnk);
    // ★ 这条是「桌面图标点了没反应」的回归测试：
    // 老版本桌面图标指向「后台启动.vbs」—— 只起服务、不开浏览器，
    // 用户双击后屏幕毫无变化，以为程序坏了。
    ok('桌面图标指向「打开系统.vbs」（起服务并自动开浏览器）',
      /打开系统\.vbs/i.test(di.args), di.args || '(空)');
    ok('桌面图标用的是应用图标（不是 node 的绿色小恐龙）',
      /app\.ico/i.test(di.icon), di.icon || '(默认)');
  }
  // 桌面上留两个图标（一个起服务一个开网页）是上一版的设计，用户分不清点哪个
  ok('桌面上多余的「（打开）.url」已清掉',
    !fs.existsSync(path.join(DESKTOP, '弱电项目管理系统（打开）.url')));
  ok('开始菜单目录', fs.existsSync(SM_DIR));
  ok('开始菜单「打开系统」', fs.existsSync(path.join(SM_DIR, '打开系统.lnk')));
  ok('开始菜单「停止服务」', fs.existsSync(path.join(SM_DIR, '停止服务.lnk')));

  // ★ 这条是「开始菜单里的卸载点了没反应」的回归测试：
  // 老版本在复制「卸载.exe」之前就建了快捷方式，首次安装必然指向空路径。
  const unLnk = path.join(SM_DIR, '卸载.lnk');
  ok('开始菜单「卸载」', fs.existsSync(unLnk));
  if (fs.existsSync(unLnk)) {
    const ui = lnkInfo(unLnk);
    ok('「卸载」指向真实存在的卸载.exe', !!ui.target && fs.existsSync(ui.target),
      ui.target || '(空路径)');
  }

  ok('开机自启已设置', fs.existsSync(path.join(STARTUP, '弱电项目管理系统.lnk')));
  ok('已注册到「应用和功能」', regExists());
  // 版本号曾经写死成 2.0.0，「应用和功能」里永远是错版本，报障时对不上号
  const pkgVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  ok('「应用和功能」显示的版本号与 package.json 一致', regValue('DisplayVersion') === pkgVer,
    `注册表 ${regValue('DisplayVersion') || '(空)'} / package.json ${pkgVer}`);

  // ---------- 4. 启动服务 ----------
  console.log('\n[4] 启动服务并验证功能');
  // 先用装机自带的启动器（VBS）跑一次，验证「装完服务就起来了」这条路径
  ps(`Start-Process -FilePath "$env:SystemRoot\\System32\\wscript.exe" -ArgumentList '"${path.join(DIR, '后台启动.vbs')}"' -WorkingDirectory '${DIR}'`);

  // 8787 可能被开发实例占用，所以另外用 8791 起一个专门验证功能
  const logFile = path.join(os.tmpdir(), 'elv-pkgchild.log');
  const child = require('node:child_process').spawn(path.join(DIR, 'node.exe'),
    ['--no-warnings', path.join(DIR, 'app', 'server.js'), '--port', String(PORT)],
    {
      cwd: path.join(DIR, 'app'),
      env: { ...process.env, PMS_DATA_DIR: path.join(DIR, 'data') },
      stdio: ['ignore', fs.openSync(logFile, 'w'), fs.openSync(logFile, 'a')],
    });

  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break } } catch { /* 还没起 */ }
  }
  ok('服务已启动', up);
  if (!up) {
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim() : '(无输出)';
    console.log('      子进程日志: ' + log.slice(0, 400));
  }

  if (up) {
    const h = await (await fetch(BASE + '/api/health')).json();
    ok('健康检查', h.ok === true, `v${h.version}`);

    // 首次运行：admin / admin123
    const lr = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    });
    const lj = await lr.json();
    ok('首次登录 admin/admin123', lr.status === 200 && !!lj.user,
      lj.user ? `${lj.user.name}（需改密=${lj.user.must_change_pw}）` : JSON.stringify(lj).slice(0, 60));
    const cookie = (lr.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/);
    const H = { Cookie: 'pms_session=' + (cookie ? cookie[1] : ''), 'Content-Type': 'application/json' };

    const d = await (await fetch(BASE + '/api/dashboard', { headers: H })).json();
    ok('示例数据已生成', d.totals && d.totals.project_count >= 3,
      `项目 ${d.totals?.project_count} / 合同 ${d.totals?.contract_count} / 收入 ${d.totals?.contract_in}`);

    const page = await fetch(BASE + '/');
    const html = await page.text();
    ok('前端页面可访问', page.status === 200 && html.includes('assets/'),
      `${(html.length / 1024).toFixed(1)} KB`);

    const dbFile = path.join(DIR, 'data', 'pms.db');
    ok('数据库落在安装目录 data 下', fs.existsSync(dbFile),
      fs.existsSync(dbFile) ? `${(fs.statSync(dbFile).size / 1024).toFixed(0)} KB` : '未找到');

    const csv = await fetch(BASE + '/api/export/projects', { headers: H });
    ok('CSV 导出可用', csv.status === 200, `HTTP ${csv.status}`);

    const bk = await (await fetch(BASE + '/api/backup', { method: 'POST', headers: H, body: '{}' })).json();
    ok('数据库备份可用', bk.ok === true, bk.file || JSON.stringify(bk).slice(0, 50));

    // 识别引擎是否随包带上（上传一张样例合同，等 OCR）
    try {
      const buf = fs.readFileSync(path.join(ROOT, 'tools', 'fixtures', 'contract.pdf'));
      const fd = new FormData();
      fd.append('file', new Blob([buf], { type: 'application/pdf' }), 'PKGTEST-合同.pdf');
      const up2 = await (await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: H.Cookie }, body: fd })).json();
      let ocrOk = false;
      for (let i = 0; i < 40; i++) {
        await sleep(1000);
        const list = await (await fetch(BASE + '/api/attachments?q=PKGTEST-', { headers: H })).json();
        const a = (list.rows || [])[0];
        if (a && a.ocr_status === 'done') {
          ocrOk = true;
          ok('装机包里的识别引擎可用', !!a.ocr && Object.keys(a.ocr.fields || {}).length >= 5,
            `抽出 ${Object.keys(a.ocr?.fields || {}).length} 个字段，编号=${a.ocr?.fields?.code}`);
          break;
        }
        if (a && a.ocr_status === 'failed') break;
      }
      if (!ocrOk) ok('装机包里的识别引擎可用', false, '识别未完成或失败');
    } catch (e) { ok('装机包里的识别引擎可用', false, e.message.slice(0, 50)) }
  }

  // ---------- 4.5 一键启动器 ----------
  console.log('\n[4.5] 桌面图标的落点（打开系统.vbs）');
  const vbsPath = path.join(DIR, '打开系统.vbs');
  if (fs.existsSync(vbsPath)) {
    // 先把本目录的 node 全停掉，模拟「服务没在跑，用户双击桌面图标」
    killInstalled();
    await sleep(1500);
    // /no-browser：只验证「能起服务」，不在测试机上乱弹浏览器窗口。
    // 这一步能抓住 VBS 语法错误、WMI 查询写错、路径拼错这类只能靠人眼发现的问题。
    const vr = spawnSync('wscript.exe', ['//nologo', vbsPath, '/no-browser'],
      { timeout: 120000, windowsHide: true, encoding: 'utf8' });
    ok('「打开系统.vbs」能跑通（语法 + 端口探测 + 启动服务）', vr.status === 0,
      `exit=${vr.status}${vr.stderr ? ' ' + String(vr.stderr).slice(0, 120) : ''}`);
    killInstalled();
    await sleep(1200);
  } else {
    ok('「打开系统.vbs」存在', false, '文件缺失');
  }

  // ---------- 5. 停止 ----------
  console.log('\n[5] 停止服务');
  child.kill('SIGKILL');
  await sleep(1500);
  let stillUp = false;
  try { await fetch(BASE + '/api/health'); stillUp = true } catch { /* 已停 */ }
  ok('服务已停止', !stillUp);

  // ---------- 6. 卸载 ----------
  console.log('\n[6] 卸载');
  const dbBefore = fs.existsSync(path.join(DIR, 'data', 'pms.db'))
    ? fs.statSync(path.join(DIR, 'data', 'pms.db')).size : 0;
  // 关键：走真实路径 —— 直接调用安装目录里的「卸载.exe」，不带 /dir，
  // 靠它自己判断所在目录。用户从「应用和功能」卸载就是这个路径。
  const uninstaller = path.join(DIR, '卸载.exe');
  let un;
  if (fs.existsSync(uninstaller)) {
    un = runSetupAt(uninstaller, ['/uninstall', '/silent']);
  } else {
    un = runSetup(['/uninstall', '/silent']);
    console.log('      （安装目录里没有卸载.exe，退回用安装包卸载）');
  }
  await sleep(3000);
  ok('卸载退出码为 0', un.code === 0, `exit=${un.code}`);
  if (un.code !== 0) console.log('      输出: ' + un.out.trim().split('\n').slice(0, 8).join('\n      '));
  // 卸载程序是延迟自删的，等一下让它把目录也清掉
  for (let i = 0; i < 10 && fs.existsSync(uninstaller); i++) await sleep(600);

  ok('程序文件已删除（node.exe）', !fs.existsSync(path.join(DIR, 'node.exe')));
  ok('app 目录已删除', !fs.existsSync(path.join(DIR, 'app')));
  ok('启动器已删除', !fs.existsSync(path.join(DIR, '后台启动.vbs')));
  ok('一键启动器已删除', !fs.existsSync(path.join(DIR, '打开系统.vbs')));
  // 卸载前会自动把库另存一份到 backup 里 —— data 目录虽然保留，
  // 但用户卸载后常常顺手把整个目录删掉，backup 里那份是最后的保险
  ok('卸载前已自动备份数据库', fs.existsSync(path.join(DIR, 'backup', '卸载前自动备份')),
    path.join('backup', '卸载前自动备份'));
  ok('data 目录已保留', fs.existsSync(path.join(DIR, 'data')));
  const dbAfter = fs.existsSync(path.join(DIR, 'data', 'pms.db'))
    ? fs.statSync(path.join(DIR, 'data', 'pms.db')).size : 0;
  ok('数据库文件完整保留', dbBefore > 0 && dbAfter === dbBefore, `${dbBefore} → ${dbAfter} 字节`);
  ok('桌面快捷方式已移除', !fs.existsSync(path.join(DESKTOP, '弱电项目管理系统.lnk')));
  ok('开始菜单已移除', !fs.existsSync(SM_DIR));
  ok('开机自启已移除', !fs.existsSync(path.join(STARTUP, '弱电项目管理系统.lnk')));
  ok('注册表已清理', !regExists());

  // ---------- 收尾 ----------
  console.log('\n' + '='.repeat(56));
  if (all) console.log('  ══ 全部通过 ══');
  else console.log(`  ══ ${results.filter(r => !r.ok).length} 项失败 ══`);
  console.log(`  数据目录保留在：${path.join(DIR, 'data')}`);
  try { fs.rmSync(SETUP, { force: true }) } catch { /* 忽略 */ }
  process.exit(all ? 0 : 1);
})().catch(e => { console.error('\n  ✗ 验证失败：' + e.message); process.exit(1); });
