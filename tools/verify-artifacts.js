'use strict';
/**
 * 校验交付包内容齐全
 *
 *   node tools/verify-artifacts.js
 *
 * 为什么不能只看"文件生成了"：
 *   打包脚本靠**扫描 require 语句**推后端要哪些文件，而扫描器看不见
 *   条件分支里的懒加载 require（ocr-tesseract.js 就是这种），
 *   也看不见相对路径写法。漏一个文件不会让打包失败，
 *   而是让客户装上以后"扫描件识别用不了"——最难查的一类问题。
 *
 * 所以这里逐个断言包里必须有那些**运行时真的会去 require 的文件**，
 * 并且断言包里**不能有** .env / data/ 之类的东西。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, process.env.PMS_ARTIFACT_OUT || 'dist-artifacts');
const VER = process.env.PMS_VERSION ||
  (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '1.0.0');
const WORK = path.join(OUT, '_verify');

let bad = 0;
const ok = (c, msg) => { console.log(`  ${c ? '✓' : '✗'} ${msg}`); if (!c) bad++; };
const rmrf = p => fs.rmSync(p, { recursive: true, force: true });

function extractZip (zip, to) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem;` +
    `[System.IO.Compression.ZipFile]::ExtractToDirectory('${zip}','${to}')`],
    { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error('解压失败：' + (r.stderr || '').slice(0, 200));
}
const countFiles = (dir) => {
  let n = 0;
  const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name); e.isDirectory() ? walk(p) : n++; } };
  walk(dir); return n;
};

(async () => {
  console.log('\n验证交付包  ' + '═'.repeat(46));
  rmrf(WORK);
  fs.mkdirSync(WORK, { recursive: true });

  /* ---------- Windows exe ---------- */
  const exe = path.join(OUT, `elv-pms-${VER}-windows-standalone.exe`);
  console.log('\n▌ Windows 单机版');
  ok(fs.existsSync(exe), `${path.basename(exe)} 存在`);
  if (fs.existsSync(exe)) {
    const mb = fs.statSync(exe).size / 1024 / 1024;
    // 自带 Node 运行时，装出来必然 30MB 上下；低于 20MB 说明 node.exe 没打进去
    ok(mb > 20, `体积合理 ${mb.toFixed(1)} MB（<20MB 说明没带上 node.exe）`);
    // PE 头：MZ 魔数
    const fd = fs.openSync(exe, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0); fs.closeSync(fd);
    ok(buf.toString('latin1') === 'MZ', '是合法的 Windows 可执行文件（MZ 头）');
  }

  /* ---------- Docker zip ---------- */
  console.log('\n▌ Docker 专业版');
  const dz = path.join(OUT, `elv-pms-${VER}-docker.zip`);
  const dtmp = path.join(WORK, 'docker');
  ok(fs.existsSync(dz), `${path.basename(dz)} 存在`);
  if (fs.existsSync(dz)) {
    extractZip(dz, dtmp);
    const D = p => fs.existsSync(path.join(dtmp, p));
    ok(D('docker-compose.yml'), 'docker-compose.yml');
    ok(D('Dockerfile'), 'Dockerfile');
    ok(D('.env.example'), '.env.example');
    ok(D('public/index.html'), 'public/index.html（Dockerfile 要 COPY public）');
    ok(D('server.js') && D('db.js') && D('schema.js'), 'server.js / db.js / schema.js');
    ok(D('adapter-pg.js'), 'adapter-pg.js（PG 驱动，专业版命脉）');
    ok(D('package.json'), 'package.json');
    ok(D('tools/pdfjs/pdf.worker.min.mjs'), 'tools/pdfjs（PDF 文字层）');
    ok(D('tools/ocr.js') && D('tools/ocr-backend.js'), 'tools/ocr.js + ocr-backend.js');
    ok(D('使用说明.md') || D('README.md'), '使用说明');
    // ★ 绝不能混进客户/运维的真实凭据
    ok(!D('.env'), '不含 .env（真实密码）');
    ok(!D('data'), '不含 data/（业务数据）');
    ok(!D('backup'), '不含 backup/');
    const dj = JSON.parse(fs.readFileSync(path.join(dtmp, 'package.json'), 'utf8'));
    ok(!!(dj.dependencies || {}).pg, 'package.json 保留 pg 依赖');
    console.log(`    文件数 ${countFiles(dtmp)}`);
  }

  /* ---------- Linux tar.gz ---------- */
  console.log('\n▌ Linux 裸装版');
  const lz = path.join(OUT, `elv-pms-${VER}-linux.tar.gz`);
  const dir = `elv-pms-${VER}-linux`;
  ok(fs.existsSync(lz), `${path.basename(lz)} 存在`);
  if (fs.existsSync(lz)) {
    const ex = spawnSync('tar', ['-xzf', lz, '-C', WORK], { encoding: 'utf8', windowsHide: true });
    ok(ex.status === 0, '解压成功' + (ex.status === 0 ? '' : ' ' + (ex.stderr || '').slice(0, 120)));
    const root = path.join(WORK, dir);
    const L = p => fs.existsSync(path.join(root, p));
    ok(L('deploy/deploy.sh'), 'deploy/deploy.sh');
    ok(L('deploy/elv-pms.service'), 'deploy/elv-pms.service');
    ok(L('deploy/elv-pms-backup.timer'), 'deploy/elv-pms-backup.timer');
    ok(L('server.js') && L('db.js'), 'server.js / db.js');
    ok(L('public/index.html'), 'public/index.html');
    // npm ci 需要 lock 文件，否则 deploy.sh 会退回 npm install（版本漂移）
    ok(L('package.json') && L('package-lock.json'), 'package.json + package-lock.json');
    // ★ 这两个最容易漏：ocr-backend 是顶层 require，ocr-tesseract 是分支懒加载
    ok(L('tools/ocr.js') && L('tools/ocr-backend.js'), 'tools/ocr.js + ocr-backend.js');
    ok(L('tools/ocr-tesseract.js'), 'tools/ocr-tesseract.js（Linux OCR 后端，扫描件识别靠它）');
    ok(L('tools/pdfjs/pdf.min.mjs'), 'tools/pdfjs');
    ok(!L('data'), '不含 data/');
    console.log(`    文件数 ${countFiles(root)}`);

    // deploy.sh 语法：优先用 Git Bash，其次 WSL
    const bash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe']
      .find(p => fs.existsSync(p));
    const script = path.join(root, 'deploy', 'deploy.sh');
    let shOk = null;
    if (bash) {
      shOk = spawnSync(bash, ['-n', script], { encoding: 'utf8', windowsHide: true }).status === 0;
    } else {
      // PATH 上的 bash.exe 是 WSL shim，直接跑会吐乱码警告并返回非 0，
      // 必须走 wsl.exe -e 才是真的检查语法
      const wslPath = script.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => '/mnt/' + d.toLowerCase());
      const r = spawnSync('wsl.exe', ['-e', 'bash', '-n', wslPath], { encoding: 'utf8', windowsHide: true });
      shOk = r.status === null ? null : r.status === 0;
    }
    if (shOk === null) console.log('    · 本机没有可用 bash，跳过 deploy.sh 语法检查');
    else ok(shOk, 'deploy.sh 语法通过（bash -n）');
  }

  rmrf(WORK);
  console.log('\n' + '═'.repeat(52));
  console.log(bad ? `  ✗ ${bad} 项不通过` : '  ✓ 交付包全部通过');
  console.log('');
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('  ✗ 校验失败：' + e.message); process.exit(1); });
