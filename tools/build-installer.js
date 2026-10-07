'use strict';
/**
 * 打 Windows 安装包
 *
 * 产物： dist-installer\弱电项目管理系统-安装程序.exe
 *
 * 做法：
 *   1. 把 Node 运行环境 + 程序文件暂存到 payload 目录
 *   2. 压成一个 zip（node.exe 83MB → 压缩后约 25MB）
 *   3. 用 Windows 自带的 csc 编译安装程序，把 zip 作为内嵌资源打进去
 *
 * 不需要装 Inno Setup / NSIS，只要有 .NET Framework（Win10/11 自带）。
 *
 * 用法： node tools/build-installer.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, process.env.PMS_INSTALLER_OUT || 'dist-installer');
const STAGE = path.join(OUT, 'payload');
const ZIP = path.join(OUT, 'payload.zip');
const CS = path.join(__dirname, 'installer', 'Installer.cs');
const ICON = path.join(__dirname, 'installer', 'app.ico');
const CSC = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

/** tools 里除被 require 之外的辅助文件 */
// 注意：collectRuntimeFiles 扫到 tools/xxx.js 就停了，不会再跟进它内部的 require，
// 所以 tools 里被 tools 内部引用的模块必须写在这里（pdftext.js 就属于这种）
// ocr-tesseract.js 是 Linux 后端，Windows 包里用不到，但一并带上以免手工同步漏文件
const TOOL_EXTRA = ['ocr.ps1', 'backup.js', 'pdftext.js', 'ocr-backend.js', 'ocr-tesseract.js'];
/** tools 下要整目录复制的子目录（pdfjs = PDF 文字层提取，Apache-2.0，1.76MB） */
const TOOL_DIRS = ['pdfjs'];

/**
 * 自动扫出后端真正需要的模块。
 *
 * 以前这里是手写清单，加了 ai.js 之后忘了同步，打出来的安装包一启动就崩。
 * 改成从 require 反推，加新模块不用记得改这里。
 */
function collectRuntimeFiles () {
  const seen = new Set(['server.js']);
  const queue = ['server.js'];
  const toolFiles = new Set();
  const missing = [];

  while (queue.length) {
    const rel = queue.shift();
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) { missing.push(rel); continue }
    const src = fs.readFileSync(abs, 'utf8');
    // 匹配 require('./x.js') / require("./x.js")，跳过 node: 内置模块
    for (const m of src.matchAll(/require\(\s*['"]\.\/([^'"]+?\.js)['"]\s*\)/g)) {
      const dep = m[1];
      if (dep.startsWith('tools/')) {
        if (!toolFiles.has(dep.slice(6))) toolFiles.add(dep.slice(6));
      } else if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return { appJs: [...seen].sort(), toolFiles: [...toolFiles].sort(), missing };
}

const RUNTIME = collectRuntimeFiles();

const log = (s) => console.log('  ' + s);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

function copyDir (from, to) {
  fs.mkdirSync(to, { recursive: true });
  let n = 0, bytes = 0;
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) { const r = copyDir(src, dst); n += r.n; bytes += r.bytes; }
    else { fs.copyFileSync(src, dst); n++; bytes += fs.statSync(dst).size; }
  }
  return { n, bytes };
}

(async () => {
  console.log('  打安装包');
  console.log('  ' + '='.repeat(52));

  if (!fs.existsSync(CSC)) throw new Error('找不到 csc.exe（需要 .NET Framework 4.x）');
  if (!fs.existsSync(CS)) throw new Error('找不到安装程序源码：' + CS);

  // ---------- 1. 暂存 ----------
  // --reuse：改 Installer.cs 时复用已有压缩包，省掉每次 4 秒的压缩。
  // 注意要先判断再清目录，否则 rmSync 会把 zip 一起删掉，复用永远不生效。
  const reuse = process.argv.includes('--reuse') && fs.existsSync(ZIP);
  let nodeSize = fs.statSync(process.execPath).size;

  if (reuse) {
    log('复用已有压缩包（跳过错暂存与压缩）');
  } else {
    log('清理暂存目录…');
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(STAGE, { recursive: true });

    // node.exe：用当前正在跑的这个 node，保证版本一致
    const nodeExe = process.execPath;
    log('复制 Node 运行环境…  ' + path.basename(nodeExe) + '  ' + mb(nodeSize));
    fs.copyFileSync(nodeExe, path.join(STAGE, 'node.exe'));

    // 后端模块（从 require 自动推出来的）
    const appDir = path.join(STAGE, 'app');
    fs.mkdirSync(path.join(appDir, 'tools'), { recursive: true });
    const missing = [...RUNTIME.missing];
    for (const f of RUNTIME.appJs) {
      const src = path.join(ROOT, f);
      if (!fs.existsSync(src)) { missing.push(f); continue; }
      fs.copyFileSync(src, path.join(appDir, f));
    }
    const toolFiles = [...new Set([...RUNTIME.toolFiles, ...TOOL_EXTRA])];
    for (const f of toolFiles) {
      const src = path.join(ROOT, 'tools', f);
      if (!fs.existsSync(src)) { missing.push('tools/' + f); continue; }
      fs.copyFileSync(src, path.join(appDir, 'tools', f));
    }
    // tools 下的子目录整份复制（pdfjs 这类带多个文件的库）
    let dirCount = 0;
    for (const d of TOOL_DIRS) {
      const src = path.join(ROOT, 'tools', d);
      if (!fs.existsSync(src)) { missing.push('tools/' + d + '/'); continue; }
      fs.cpSync(src, path.join(appDir, 'tools', d), { recursive: true });
      dirCount += fs.readdirSync(src).length;
    }
    if (missing.length) throw new Error('缺少运行时文件：' + missing.join(', '));
    log(`复制后端模块…  ${RUNTIME.appJs.length} 个 js（自动扫描依赖）：${RUNTIME.appJs.join(', ')}`);
    log(`复制 tools…  ${toolFiles.length} 个文件` + (dirCount ? ` + ${dirCount} 个子目录文件` : ''));

    // 前端构建产物
    if (!fs.existsSync(path.join(ROOT, 'public', 'index.html'))) {
      throw new Error('前端还没构建（public/index.html 不存在），先在 web 目录跑 npm run build');
    }
    const pub = copyDir(path.join(ROOT, 'public'), path.join(appDir, 'public'));
    log(`复制前端产物…  ${pub.n} 个文件  ${mb(pub.bytes)}`);

    // 使用说明
    if (fs.existsSync(path.join(ROOT, 'README.md'))) {
      fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(STAGE, '使用说明.md'));
    }

    // ---------- 2. 压缩 ----------
    log('压缩…（这一步最慢，请稍等）');
    const t0 = Date.now();
    execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
      `[System.IO.Compression.ZipFile]::CreateFromDirectory('${STAGE}', '${ZIP}', ` +
      `[System.IO.Compression.CompressionLevel]::Optimal, $false)`,
    ], { stdio: 'inherit' });
    log(`压缩完成  ${mb(nodeSize)} → ${mb(fs.statSync(ZIP).size)}  （耗时 ${((Date.now() - t0) / 1000).toFixed(0)}s）`);
  }
  const zipSize = fs.statSync(ZIP).size;

  // ---------- 3. 编译 ----------
  const exe = path.join(OUT, '弱电项目管理系统-安装程序.exe');
  log('编译安装程序…');
  const fw = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319');
  const refs = [
    path.join(fw, 'System.dll'),
    path.join(fw, 'System.Core.dll'),
    path.join(fw, 'System.Drawing.dll'),
    path.join(fw, 'System.Windows.Forms.dll'),
    path.join(fw, 'System.IO.Compression.dll'),
    path.join(fw, 'System.IO.Compression.FileSystem.dll'),
  ];
  for (const r of refs) if (!fs.existsSync(r)) throw new Error('缺少程序集：' + r);

  // 注意：stdio 用 inherit 时 execFileSync 返回 null，不能对它调 .toString()
  execFileSync(CSC, [
    '/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
    '/out:' + exe,
    ...(fs.existsSync(ICON) ? ['/win32icon:' + ICON] : []),
    ...refs.map(r => '/reference:' + r),
    '/resource:' + ZIP + ',Payload',
    CS,
  ], { stdio: 'inherit' });

  const exeSize = fs.statSync(exe).size;
  log('');
  console.log('  ' + '='.repeat(52));
  console.log('  ✓ 安装包已生成');
  console.log('    ' + exe);
  console.log('    大小 ' + mb(exeSize));
  console.log('');
  console.log('  双击即可安装。静默安装（自动化用）：');
  console.log('    "弱电项目管理系统-安装程序.exe" /silent /dir=路径');
  console.log('  卸载：');
  console.log('    "弱电项目管理系统-安装程序.exe" /uninstall');
  console.log('');

  // 清理中间产物（zip 已经打进 exe，payload 目录也不需要）
  fs.rmSync(ZIP, { force: true });
  fs.rmSync(STAGE, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('\n  ✗ 打包失败：' + e.message); process.exit(1); });
