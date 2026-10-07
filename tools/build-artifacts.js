'use strict';
/**
 * 按平台打交付包
 *
 *   node tools/build-artifacts.js            三平台全打
 *   node tools/build-artifacts.js windows    只打 Windows 单机版
 *   node tools/build-artifacts.js docker     只打 Docker 专业版
 *   node tools/build-artifacts.js linux      只打 Linux 裸装版
 *
 * 产物（dist-artifacts/）：
 *   elv-pms-1.0.0-windows-standalone.exe   32MB，自带 node，双击即装
 *   elv-pms-1.0.0-docker.zip                compose + 镜像 + 部署清单
 *   elv-pms-1.0.0-linux.tar.gz              systemd 一键部署包
 *
 * 为什么三套环境用三个包而不是三个仓库：
 *   三套共用同一份 server.js/db.js/public，拆仓库会制造三份要同步的代码。
 *   需要分开的只有**交付物**——客户各自只下载自己那一套。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, process.env.PMS_ARTIFACT_OUT || 'dist-artifacts');
const pkg = require(path.join(ROOT, 'package.json'));
const VER = process.env.PMS_VERSION || pkg.version || '1.0.0';

const say = s => console.log('  ' + s);
const mb = n => (n / 1024 / 1024).toFixed(1) + ' MB';
const exists = rel => fs.existsSync(path.join(ROOT, rel));

/** 从 require 反推后端真正需要的模块（与 build-installer.js 同一套逻辑） */
function collectRuntimeFiles () {
  const seen = new Set(['server.js']);
  const queue = ['server.js'];
  const toolFiles = new Set();
  while (queue.length) {
    const rel = queue.shift();
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const src = fs.readFileSync(abs, 'utf8');
    for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+?\.js)['"]\s*\)/g)) {
      const dep = m[1];
      if (dep.startsWith('tools/')) toolFiles.add(dep.slice(6));
      else if (!seen.has(dep)) { seen.add(dep); queue.push(dep); }
    }
  }
  return { appJs: [...seen].sort(), toolFiles: [...toolFiles].sort() };
}
const RUNTIME = collectRuntimeFiles();

/**
 * 扫描器看不见的 tools 依赖，必须显式补齐。
 *
 * 原因：ocr.js 顶层的 require('./ocr-backend.js') 带 ./ 前缀，扫描规则
 * 只认相对当前文件目录的 './x.js'，所以扫 tools/ocr.js 时把
 * './ocr-backend.js' 当成 tools 下的文件去找 —— 实际它在 tools/ 里，
 * 于是「恰好没被收录」。而 ocr-tesseract.js 是**分支内懒加载**
 * （ocr.js:80 `require('./ocr-tesseract.js')` 只在 Linux 路径执行），
 * 静态扫描根本扫不到。
 *
 * 后果：Linux 裸装包缺这两个文件 = 服务起不来或识别直接废掉，
 * 而 Windows 包是好的 —— 只在 Linux 上炸，最难查。
 */
const TOOL_EXTRA = [
  'ocr.js', 'ocr-backend.js', 'ocr-tesseract.js',   // OCR 全链路（含 Linux 后端）
  'ocr.ps1',                                          // Windows OCR 后端
  'pdftext.js',                                       // PDF 文字层提取
  'backup.js', 'restore-backup.js',
];

function rmrf (p) { fs.rmSync(p, { recursive: true, force: true }); }
function write (p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}
function copyFile (rel, to) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) throw new Error('缺少文件：' + rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(src, to);
}
function copyDir (from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
/** tar 能不能设置权限位：GNU tar 有 --mode，Windows 自带的 bsdtar 没有 */
function tarIsGnu () {
  const r = spawnSync('tar', ['--version'], { encoding: 'utf8', windowsHide: true });
  return /GNU tar/i.test(r.stdout || '');
}

/**
 * 打 tar.gz。
 *
 * deploy.sh 必须带执行位，客户才能 ./deploy/deploy.sh 直接跑。
 * 但 Windows 自带的是 **bsdtar**（libarchive），既不支持 --mode 也不支持
 * --transform —— 实测直接报 "Option --mode=755 is not supported"。
 * 而且 Windows 上 fs.chmod 本身是空操作，打出来的条目一律 666。
 *
 * 所以分两种情况：
 *   · GNU tar（本机装了 Git for Windows 的 GNU tar、或 CI 的 ubuntu）→ 用 --mode 设成 755
 *   · bsdtar → 设不了，改由包内说明引导用 `bash deploy/deploy.sh`（不依赖执行位）
 */
function tarGz (cwd, entry, out) {
  const gnu = tarIsGnu();
  const args = ['-czf', out];
  if (gnu) args.push('--mode=u+rw,go+r,go-w', '--owner=0', '--group=0', '--numeric-owner');
  args.push(entry);
  const r = spawnSync('tar', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('tar 失败：' + (r.stderr || '').slice(0, 200));
  if (!gnu) say('');
  return gnu;
}

function zip (cwd, entry, out) {
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
    `[System.IO.Compression.ZipFile]::CreateFromDirectory('${path.join(cwd, entry)}','${out}',` +
    `[System.IO.Compression.CompressionLevel]::Optimal,$false)`], { stdio: 'inherit' });
}

/* ══════════════════ ① Windows 单机版 ══════════════════ */
function buildWindows () {
  const name = `elv-pms-${VER}-windows-standalone.exe`;
  console.log('\n▌ Windows 单机版');
  const outDir = path.join(OUT, 'windows');
  rmrf(outDir);
  fs.mkdirSync(outDir, { recursive: true });
  // PMS_INSTALLER_OUT 让 build-installer.js 输出到我们指定的目录
  const r = spawnSync('node', [path.join('tools', 'build-installer.js')], {
    cwd: ROOT, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, PMS_INSTALLER_OUT: path.relative(ROOT, outDir) },
  });
  if (r.status !== 0) {
    console.log((r.stdout || '') + (r.stderr || ''));
    throw new Error('Windows 安装包打包失败');
  }
  const built = path.join(outDir, '弱电项目管理系统-安装程序.exe');
  if (!fs.existsSync(built)) throw new Error('安装包未生成');
  // 改名后**挪到 dist-artifacts 根目录**：三个产物平铺在一起，
  // 发布时 glob 'dist-artifacts/*' 才能一次全带上。
  const finalPath = path.join(OUT, name);
  rmrf(finalPath);
  fs.renameSync(built, finalPath);
  rmrf(outDir);                       // 中间目录不留残骸
  say(`${name}  ${mb(fs.statSync(finalPath).size)}`);
  return name;
}

/* ══════════════════ ② Docker 专业版 ══════════════════ */
function buildDocker () {
  console.log('\n▌ Docker 专业版');
  const name = `elv-pms-${VER}-docker.zip`;
  const stage = path.join(OUT, '_stage', 'docker');
  rmrf(stage);
  fs.mkdirSync(stage, { recursive: true });

  // 镜像构建所需
  copyFile('docker-compose.yml', path.join(stage, 'docker-compose.yml'));
  copyFile('Dockerfile', path.join(stage, 'Dockerfile'));
  copyFile('.env.example', path.join(stage, '.env.example'));
  copyDir(path.join(ROOT, 'public'), path.join(stage, 'public'));
  for (const f of RUNTIME.appJs) copyFile(f, path.join(stage, f));
  for (const f of new Set([...RUNTIME.toolFiles, ...TOOL_EXTRA])) copyFile(path.join('tools', f), path.join(stage, 'tools', f));
  // tools 下要整目录复制的子目录（pdfjs = PDF 文字层提取，Apache-2.0）
  for (const d of ['pdfjs']) {
    if (exists('tools/' + d)) copyDir(path.join(ROOT, 'tools', d), path.join(stage, 'tools', d));
  }
  // Dockerfile 里 `COPY *.js ./` + `COPY tools ./tools`，compose 侧 `npm install`
  // 靠 package.json 的 dependencies 装 pg —— 三个都要在
  write(path.join(stage, 'package.json'), JSON.stringify({ ...pkg, scripts: { start: 'node server.js' } }, null, 2));
  if (exists('package-lock.json')) copyFile('package-lock.json', path.join(stage, 'package-lock.json'));

  // 客户侧便利文件
  if (exists('tools/install-docker.bat')) {
    // ⚠ 该文件是 GBK 编码，原样复制，不要用 write()（会按 UTF-8 写坏）
    fs.copyFileSync(path.join(ROOT, 'tools', 'install-docker.bat'), path.join(stage, 'install-docker.bat'));
  }
  copyFile('部署检查清单.md', path.join(stage, '部署检查清单.md'));
  copyFile('README.md', path.join(stage, '使用说明.md'));

  const out = path.join(OUT, name);
  rmrf(out);
  zip(path.join(OUT, '_stage'), 'docker', out);
  say(`${name}  ${mb(fs.statSync(out).size)}`);
  return name;
}

/* ══════════════════ ③ Linux 裸装版 ══════════════════ */
function buildLinux () {
  console.log('\n▌ Linux 裸装版');
  const name = `elv-pms-${VER}-linux.tar.gz`;
  const dir = `elv-pms-${VER}-linux`;
  const stage = path.join(OUT, '_stage', dir);
  rmrf(stage);
  fs.mkdirSync(path.join(stage, 'tools'), { recursive: true });

  for (const f of RUNTIME.appJs) copyFile(f, path.join(stage, f));
  for (const f of new Set([...RUNTIME.toolFiles, ...TOOL_EXTRA])) copyFile(path.join('tools', f), path.join(stage, 'tools', f));
  for (const d of ['pdfjs']) {
    if (exists('tools/' + d)) copyDir(path.join(ROOT, 'tools', d), path.join(stage, 'tools', d));
  }
  copyDir(path.join(ROOT, 'public'), path.join(stage, 'public'));
  for (const f of ['package.json', 'package-lock.json', 'README.md']) {
    if (exists(f)) copyFile(f, path.join(stage, f));
  }
  copyDir(path.join(ROOT, 'deploy'), path.join(stage, 'deploy'));
  if (exists('docker-compose.yml')) copyFile('docker-compose.yml', path.join(stage, 'docker-compose.yml'));
  if (exists('.env.example')) copyFile('.env.example', path.join(stage, '.env.example'));

  // bsdtar 设不了执行位时，先把运行说明写进包里再打包（顺序不能反，
  // 写完再 tar 才会被收进去）。
  if (!tarIsGnu()) {
    write(path.join(stage, 'deploy', '怎么运行.txt'),
      '本包在 Windows 上打包，解压后 deploy.sh 可能没有执行权限。\n\n' +
      '两种方式任选其一：\n' +
      '  1) sudo bash deploy/deploy.sh        ← 不需要执行权限，推荐\n' +
      '  2) chmod +x deploy/deploy.sh && sudo ./deploy/deploy.sh\n');
    say('本机 tar 是 bsdtar，设不了执行位 —— 包内已附运行说明');
  }

  const out = path.join(OUT, name);
  rmrf(out);
  tarGz(path.join(OUT, '_stage'), dir, out);
  say(`${name}  ${mb(fs.statSync(out).size)}`);
  return name;
}

(async () => {
  console.log('  打交付包  ' + '═'.repeat(46));
  console.log(`  版本 ${VER}`);
  const which = (process.argv[2] || 'all').toLowerCase();
  const want = k => which === 'all' || which === k;
  fs.mkdirSync(OUT, { recursive: true });

  // 前端产物是三套的共同前提：Dockerfile COPY public、Linux 也用、exe 也打包
  if (!exists('public/index.html')) {
    throw new Error('前端还没构建（public/index.html 不存在），先在 web 目录跑 npm run build');
  }

  const made = [];
  try {
    if (want('windows')) made.push(buildWindows());
    if (want('docker')) made.push(buildDocker());
    if (want('linux')) made.push(buildLinux());
  } finally {
    rmrf(path.join(OUT, '_stage'));
  }

  console.log('\n  ' + '═'.repeat(50));
  console.log(`  ✓ 完成 ${made.length} 个包 → ${path.relative(ROOT, OUT)}/`);
  for (const m of made) console.log('    ' + m);
  console.log('');
  if (!made.some(m => m.endsWith('.exe'))) {
    console.log('  提示：Windows 包需要 .NET Framework 4.x（Win10/11 自带），其它平台用 tar 打的。');
  }
  process.exit(0);
})().catch(e => { console.error('\n  ✗ 打包失败：' + e.message); process.exit(1); });
