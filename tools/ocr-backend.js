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
  if (b.name === 'powershell') return 'Windows OCR (zh-Hans-CN)';
  if (b.name === 'tesseract') {
    const hasChi = b.langs.some(l => l.startsWith('chi_sim') || l.startsWith('chi_tra'));
    return 'Tesseract (' + (hasChi ? 'chi_sim+eng' : (b.langs.join('+') || '未装中文包')) + ')';
  }
  return '未检测到（识别功能不可用）';
}

/** 后端有没有装齐（含中文包）——给自检和 /api/meta 用 */
function health () {
  const b = backend();
  if (!b.name) return { ok: false, engine: null, reason: b.reason };
  if (b.name === 'powershell') return { ok: true, engine: 'powershell', label: 'Windows OCR' };
  const hasChi = b.langs.some(l => l.startsWith('chi_sim') || l.startsWith('chi_tra'));
  return {
    ok: hasChi,
    engine: 'tesseract',
    label: hasChi ? 'Tesseract chi_sim+eng' : 'Tesseract（缺中文语言包）',
    langs: b.langs,
    hint: hasChi ? null : '缺少中文语言包，扫描件几乎认不出中文：apt install tesseract-ocr-chi-sim',
  };
}

module.exports = { backend, describe, health, findTesseract, tesseractLangs, OCR_EXT, PS_EXE, PS1 };