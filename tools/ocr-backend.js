'use strict';
/**
 * 识别后端选择：按运行平台自动挑一个可用的引擎。
 *
 *   Windows → tools/ocr.ps1（PowerShell 5.1 + WinRT，内置中文 OCR，最快）
 *   Linux   → tesseract（chi_sim + eng）
 *
 * 两边输出**完全相同**的 JSON 结构，下游 extract.js / 前端一个字都不用改。
 *
 * 选引擎只看「可执行文件在不在 / 在不在 PATH 里」，不看 process.platform：
 * 客户可能把程序放在 Windows 上但通过 WSL/Git Bash 运行，也可能有客户
 * 自装的 Tesseract 装在自定义 PATH。探测失败就退回另一个。
 *
 * 环境变量：
 *   PMS_OCR_BACKEND=win|tesseract   强制指定（排障排错用）
 *   PMS_TESSERACT_PATH=<可执行路径>  Tesseract 不在 PATH 时指定
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PS1 = path.join(__dirname, 'ocr.ps1');
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const OCR_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp', '.gif'];

/** Tesseract CLI 的位置：环境变量优先，其次 PATH，最后试常见的安装位置 */
const TESSERACT_CANDIDATES = [
  process.env.PMS_TESSERACT_PATH,
  '/usr/bin/tesseract',
  '/usr/local/bin/tesseract',
  '/opt/homebrew/bin/tesseract',
  '/usr/local/opt/tesseract/bin/tesseract',
].filter(Boolean);

let cache = null;

/** 在 PATH 里找一个叫 tesseract 的可执行文件 */
function findOnPath (bin) {
  const key = process.platform === 'win32' ? 'Path' : 'PATH';
  const dirs = String(process.env[key] || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, bin + e);
      try { if (fs.existsSync(p)) return p; } catch { /* 忽略 */ }
    }
  }
  return null;
}

/** 找 Tesseract 可执行文件，找不到返回 null（不抛错，交给调用方决定怎么办） */
function findTesseract (opts = {}) {
  if (cache && !opts.force) return cache;
  for (const p of TESSERACT_CANDIDATES) {
    try { if (fs.existsSync(p)) return (cache = p); } catch { /* 忽略 */ }
  }
  return (cache = findOnPath('tesseract') || null);
}

/** Tesseract 支持的语言包（Linux 侧通常要另外装 chi_sim） */
function tesseractLangs (tess = findTesseract()) {
  if (!tess) return [];
  try {
    const r = spawnSync(tess, ['--list-langs'], {
      encoding: 'utf8', timeout: 10000,
      windowsHide: true,
      // tesseract 把列表打到 stdout，这里必须捕获输出才能拿到
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0 || !r.stdout) return [];
    // 行格式：纯语言名（chi_sim / eng / osd）。不能假设一定是 3 位——
    // tesseract 里 eng/osd/deu 这类就是 3 个字母，后面没有分隔符。
    return String(r.stdout).split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && /^[a-z]{3,}(?:_[a-z]{2,3})?$/i.test(s));
  } catch { return []; }
}

/**
 * 当前进程能用的后端。
 * @returns {{name:'powershell'|'tesseract'|null, exe?:string, langs?:string[], reason?:string}}
 */
function backend (opts = {}) {
  const forced = String(process.env.PMS_OCR_BACKEND || '').trim().toLowerCase();
  const win = {
    name: 'powershell',
    exe: PS_EXE,
    ok: fs.existsSync(PS_EXE) && fs.existsSync(PS1),
  };
  const tess = findTesseract(opts);
  const langs = tess ? tesseractLangs(tess) : [];

  if (forced === 'powershell' || forced === 'win') return { name: 'powershell', exe: PS_EXE, ok: win.ok };
  if (forced === 'tesseract' || forced === 'tess') return { name: 'tesseract', exe: tess, ok: !!tess, langs };

  // 没强制就按「谁先能用算谁」，两者都有就用 Windows 内置的（更快）
  if (win.ok) return { name: 'powershell', exe: PS_EXE, ok: true };
  if (tess) return { name: 'tesseract', exe: tess, ok: true, langs };
  return {
    name: null, ok: false,
    reason: process.platform === 'win32'
      ? '找不到可用的识别引擎：Windows OCR 不可用，也没找到 Tesseract'
      : '找不到可用的识别引擎：请先安装 Tesseract（apt install tesseract-ocr tesseract-ocr-chi-sim）',
  };
}

/** 给启动横幅/自检用的简短描述 */
function describe () {
  const b = backend();
  if (b.name === 'powershell') {
    const hasZh = windowsOcrLangs().some(l => /^zh/i.test(l));
    return hasZh ? 'Windows OCR (zh-Hans-CN)' : 'Windows OCR（缺中文语言包）';
  }
  if (b.name === 'tesseract') {
    const hasChi = b.langs.some(l => l.startsWith('chi_sim') || l.startsWith('chi_tra'));
    return 'Tesseract (' + (hasChi ? 'chi_sim+eng' : (b.langs.join('+') || '未装中文包')) + ')';
  }
  return '未检测到（识别功能不可用）';
}

let winOcrLangsCache;
let winOcrLangsFailAt = 0;
/**
 * 枚举 WinRT OCR 的可用识别语言（形如 en-US, zh-Hans-CN）。
 *
 * ⚠️ 「Windows 上有 ocr.ps1」不等于「能认中文」：GitHub 的 windows-latest、
 * 海外客户的英文系统都没有中文语言包，WinRT 会退回英文引擎 —— 引擎创建成功，
 * 中文扫描件识别出来全是空。以前 health() 对 powershell 后端无条件报 ok，
 * 界面显示「识别引擎可用」，用户传一张扫描件却什么都抽不出来。
 * 探测一次要一两秒，结果缓存住。
 */
function windowsOcrLangs () {
  if (winOcrLangsCache) return winOcrLangsCache;
  // 探测本身失败（超时 / 被安全软件拦）时也会得到空数组，但那个空数组
  // **不能**缓存：服务一开就是好几天，一次偶发超时会让它在整个进程生命周期里
  // 都认定「没有中文语言包」。失败只记 60 秒，下次请求再问一遍。
  if (winOcrLangsFailAt && Date.now() - winOcrLangsFailAt < 60000) return [];
  const script = [
    '[void][Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]',
    '[void][Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]',
    '([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag }) -join \',\'',
  ].join('; ');
  const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const langs = (r.stdout || '').split(',').map(s => s.trim()).filter(Boolean);
  // status === 0 且没有 error 才算"问到了答案"——此时空数组是真答案（系统没装识别语言）
  if (r && !r.error && r.status === 0) {
    winOcrLangsCache = langs;
    return langs;
  }
  winOcrLangsFailAt = Date.now();
  return langs;
}

/** 后端有没有装齐（含中文包）——给自检和 /api/meta 用 */
function health () {
  const b = backend();
  if (!b.name) return { ok: false, engine: null, reason: b.reason };
  if (b.name === 'powershell') {
    const langs = windowsOcrLangs();
    const hasZh = langs.some(l => /^zh/i.test(l));
    return {
      ok: hasZh,
      engine: 'powershell',
      label: hasZh ? 'Windows OCR' : 'Windows OCR（缺中文语言包）',
      langs,
      hint: hasZh ? null
        : '系统没有中文 OCR 语言包，扫描件认不出中文。设置 → 时间和语言 → 语言 → 添加中文（简体，中国）后重试。PDF 文字层不受影响。',
    };
  }
  const hasChi = b.langs.some(l => l.startsWith('chi_sim') || l.startsWith('chi_tra'));
  return {
    ok: hasChi,
    engine: 'tesseract',
    label: hasChi ? 'Tesseract chi_sim+eng' : 'Tesseract（缺中文语言包）',
    langs: b.langs,
    hint: hasChi ? null : '缺少中文语言包，扫描件几乎认不出中文：apt install tesseract-ocr-chi-sim',
  };
}

module.exports = { backend, describe, health, windowsOcrLangs, findTesseract, tesseractLangs, OCR_EXT, PS_EXE, PS1 };