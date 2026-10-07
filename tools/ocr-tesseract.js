'use strict';
/**
 * 独立识别引擎（Linux / 无 Windows OCR 的环境）：Tesseract 后端。
 *
 * 直接由 tools/ocr.js 调用（不是独立 CLI），负责把文件转成 tesseract 能吃的
 * 输入，再把结果拼成和 ocr.ps1 **完全相同**的结构。
 *
 * 为什么不用 shell 脚本：Windows 那边是 .ps1，这边如果再拆一个 .sh，
 * 两边的参数解析/错误处理/临时文件清理就要写两遍并各自腐烂。
 *
 * PDF 光栅化用 poppler 的 pdftoppm（apt install poppler-utils）；
 * 没有 pdftoppm 时图片仍可识别，只是扫描版 PDF 不行。
 */
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IMG_EXT = ['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp', '.gif'];

function firstExisting (cands) {
  for (const c of cands.filter(Boolean)) {
    try { if (fs.existsSync(c)) return c; } catch { /* 忽略 */ }
  }
  return null;
}

function onPath (bin) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, bin);
    try { if (fs.existsSync(p)) return p; } catch { /* 忽略 */ }
  }
  return null;
}

/** tesseract 不支持 webp，需要先转格式 */
function needsConvert (ext) {
  return ext === '.webp';
}

function convertToPng (src, outPng) {
  // 优先 magick（ImageMagick 7），退回 convert（6）
  const tool = firstExisting(['/usr/bin/magick', '/usr/local/bin/magick', '/opt/homebrew/bin/magick'])
    || onPath('magick') || onPath('convert');
  if (!tool) return { ok: false, error: '无法转换 .webp：未安装 ImageMagick（apt install imagemagick）' };
  const bin = tool.endsWith('convert') && !tool.endsWith('magick') ? tool : tool;
  const args = tool.endsWith('convert') ? [src, outPng] : [src, outPng];
  const r = spawnSync(bin, args, { timeout: 30000, windowsHide: true });
  if (r.status !== 0 || !fs.existsSync(outPng)) {
    return { ok: false, error: '图片格式转换失败（' + path.basename(bin) + '）' };
  }
  return { ok: true };
}

function spawnRun (exe, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e && e.message || e) }); }

    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 忽略 */ } }, opts.timeout || 120000);
    child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: String(e && e.message || e) }); });
    child.on('exit', code => { clearTimeout(timer); resolve({ code, stdout: out, stderr: err }); });
  });
}

/** PNG/JPEG 头里读宽高，tesseract 不给尺寸，这里补上让 pages 结构与 Windows 一致 */
function imageSize (p) {
  const b = readHeader(p);
  if (!b) return { width: 0, height: 0 };
  return b;
}
function readHeader (p) {
  let fd;
  try { fd = fs.openSync(p, 'r'); } catch { return null; }
  try {
    const buf = Buffer.alloc(65536);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const b = buf.subarray(0, n);
    // PNG: 8 字节签名 + IHDR
    if (n > 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    // JPEG: 逐段找 SOFn
    let i = 2;
    while (i + 9 < n && b[i] === 0xff) {
      const m = b[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
      }
      const len = b.readUInt16BE(i + 2);
      if (len < 2) break;
      i += 2 + len;
    }
  } catch { /* 忽略 */ } finally { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  return null;
}

/** 数字白名单：只认数字、逗号、点 —— 让 eng 模型专心认数字，不被汉字干扰 */
const DIGIT_WHITELIST = '0123456789,.%';

/**
 * 从数字通道结果里，挑出「最可能是金额」的候选。
 *
 * 为什么要单独挑：数字通道会认出合同编号、日期、页码，混在一起没法直接用。
 * 金额的特征最好认 —— 带千分位逗号、且带小数点、位数够大。
 *   5,860,000.00  ✓
 *   20260305      ✗（纯整数，无分隔符）
 *   30,40,1325,5. ✗（多个逗号碎片，明显是粘连噪声）
 *
 * 只在中文通道**没抽出金额**时用（见 recognize()），所以这里宁缺毋滥：
 * 挑不出像样的就返回空，让上层走"请手工填写"的既有提示。
 */
function pickAmountCandidates (digitLines, opts = {}) {
  const min = opts.minAmount || 1000;      // 小于一千的"金额"多半是编号碎片
  const out = [];
  for (const raw of digitLines || []) {
    const s = String(raw).trim();
    // 只要一个完整的 1,234.56 形态；允许前面带少量噪声字符
    const m = s.match(/(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{4,}\.\d{1,2})/);
    if (!m) continue;
    const v = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(v) || v < min) continue;
    out.push({ text: m[1], value: v });
  }
  // 大的优先（合同/发票金额总是主要金额），同值去重
  const seen = new Set();
  return out.sort((a, b) => b.value - a.value).filter(x => {
    if (seen.has(x.value)) return false;
    seen.add(x.value);
    return true;
  });
}

/**
 * 把一页图交给 tesseract，返回行数组。
 *
 * extraArgs 用来加 --psm / 数字白名单等参数。
 */
async function ocrImage (tess, lang, imgPath, workDir, opts = {}) {
  const outBase = path.join(workDir, 'txt_' + Math.random().toString(36).slice(2));
  const args = [imgPath, outBase, '-l', lang];
  // Windows 那边的做法是放大后再认（SourceWidth = 页宽 * 4）。
  // Linux 侧用 --dpi 提示 + tesseract 自带的缩放，先不额外插值，
  // 因为 tesseract 5 对已渲染的 300dpi 图识别率已经很高，插值反而糊。
  if (opts.psm) args.push('--psm', String(opts.psm));
  if (opts.whitelist) args.push('-c', 'tessedit_char_whitelist=' + opts.whitelist);
  const r = await spawnRun(tess, args, { timeout: opts.timeout || 180000 });
  const txtFile = outBase + '.txt';
  let text = '';
  try { text = fs.readFileSync(txtFile, 'utf8'); } catch { /* 识别失败时可能没有输出 */ }
  try { fs.unlinkSync(txtFile); } catch { /* 忽略 */ }
  if (r.code !== 0 && !text) {
    return { ok: false, error: 'tesseract 执行失败：' + (String(r.stderr).trim().split('\n').pop() || ('退出码 ' + r.code)) };
  }
  const lines = text.split(/\r?\n/).map(s => s.replace(/\s+$/, '')).filter(s => s.trim());
  return { ok: true, lines };
}

/**
 * 数字通道：只用 eng + 数字白名单再认一遍。
 *
 * 为什么需要它（实测，3400x4661 的合同扫描件）：
 *   chi_sim 读金额 → "人民币 9,.860,000.00元"   ← 5 被认成 9，逗号位置也错
 *   eng+白名单     → "5,860,000.00"              ← 与原件完全一致
 *
 * tesseract 的 chi_sim 语言包会带自己的数字模型，在中英混排的小字号金额上
 * 反而不如纯 eng 稳。
 *
 * 关键设计：**结果不合并进主文本**。实测把数字串裸拼到文本末尾会污染
 * extract 的日期/编号正则（三个日期被合并成同一个、金额反而不抽），
 * 所以这里只把数字通道结果**单独返回**，由 recognize() 针对金额做兜底。
 */
async function ocrDigits (tess, imgPath, workDir, opts = {}) {
  const r = await ocrImage(tess, 'eng', imgPath, workDir, {
    psm: opts.psm || 6,
    whitelist: DIGIT_WHITELIST,
    timeout: opts.timeout || 180000,
  });
  return r.ok ? r.lines : [];
}

/**
 * @returns {Promise<{ok:boolean, kind?:string, engine?:string, pages?:any[], lines?:string[], text?:string, elapsedMs?:number, error?:string}>}
 */
async function runTesseract (filePath, opts = {}) {
  const t0 = Date.now();
  const { backend } = require('./ocr-backend.js');
  const b = backend({ force: true });
  if (b.name !== 'tesseract' || !b.ok) {
    return { ok: false, error: 'Tesseract 不可用：' + (b.reason || '未找到可执行文件') };
  }
  const tess = b.exe;
  // 中文通道**只用 chi_sim，不要加 eng**（实测，非常重要）：
  //   -l chi_sim      --psm 6 → 「甲方 (发包方) : 市第一人民医院」「乙方 (承包方) : …」全对
  //   -l chi_sim+eng  --psm 6 → 中文标签崩坏成「FS (RBA)」「ABSA (AR)」，甲乙方全丢
  // tesseract 的多语言组合会在字符集上互相干扰，中文表单项千万别混 eng。
  // 数字由独立的 eng 数字通道负责（见 ocrDigits），两条路各司其职。
  const lang = opts.lang || 'chi_sim';
  const avail = b.langs || [];
  const useLang = avail.length ? (lang.split('+').filter(l => avail.includes(l)).join('+') || 'eng') : lang;
  if (avail.length && !useLang.includes('chi_sim') && !useLang.includes('chi_tra')) {
    return { ok: false, error: '缺少中文语言包（tesseract-ocr-chi-sim），扫描件认不出中文' };
  }

  if (!fs.existsSync(filePath)) return { ok: false, error: '文件不存在：' + filePath };

  const ext = path.extname(String(filePath)).toLowerCase();
  const kind = ext === '.pdf' ? 'pdf' : (IMG_EXT.includes(ext) ? 'image' : '');
  if (!kind) return { ok: false, kind: 'unsupported', error: '不支持的文件类型：' + ext };

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pms_ocr_'));
  const lines = [];
  const digitLines = [];
  const pageInfo = [];
  const temps = [];
  // 双通道：默认开。PMS_OCR_SINGLE_CHANNEL=1 可关掉（只用中文通道，省一半耗时）
  const dualChannel = process.env.PMS_OCR_SINGLE_CHANNEL !== '1';

  try {
    let inputs = [];
    if (kind === 'image') {
      if (needsConvert(ext)) {
        const png = path.join(workDir, 'conv.png');
        const c = convertToPng(filePath, png);
        if (!c.ok) return { ok: false, error: c.error };
        inputs = [png];
        temps.push(png);
      } else {
        inputs = [filePath];
      }
    } else {
      const ppm = firstExisting(['/usr/bin/pdftoppm', '/usr/local/bin/pdftoppm']) || onPath('pdftoppm');
      if (!ppm) {
        return {
          ok: false,
          error: '识别 PDF 需要 poppler-utils（提供 pdftoppm）：apt install poppler-utils',
        };
      }
      const prefix = path.join(workDir, 'page');
      const dpi = opts.scale ? Math.round(72 * Number(opts.scale) / 2) : 300;
      // Windows 那边页宽 * 4 ≈ 288dpi，这里取 300dpi 上下等价
      // 参数顺序很重要：pdftoppm [选项] <源PDF> <输出前缀>
      // （源文件漏传的话，pdftoppm 会把前缀当输入，报 "Couldn't open file"）
      const r = await spawnRun(ppm, ['-r', String(Math.max(150, Math.min(400, dpi))), '-png',
        '-f', '1', '-l', String(Math.min(opts.maxPages || 40, 400)),
        filePath, prefix], { timeout: opts.timeout || 180000 });
      if (r.code !== 0) {
        return { ok: false, error: 'PDF 转图片失败（pdftoppm）：' + (String(r.stderr).trim().split('\n').pop() || ('退出码 ' + r.code)) };
      }
      // poppler 固定输出 <prefix>-<页码>.png（单页时可能是 prefix-1.png）
      inputs = fs.readdirSync(workDir)
        .filter(f => /^page-\d+\.png$/i.test(f))
        .sort((a, b2) => Number(a.match(/\d+/)[0]) - Number(b2.match(/\d+/)[0]))
        .map(f => path.join(workDir, f));
      if (!inputs.length) return { ok: false, error: 'PDF 转图片没有产出页面' };
      temps.push(...inputs);
    }

    for (let i = 0; i < inputs.length; i++) {
      const img = inputs[i];
      // --psm 6（统一文本块）是这里的关键，实测：
      //   默认 psm 3 → 中文标签被切碎成「FS (RBA)」「ABSA (AR)」，甲方乙方全丢
      //   psm 6      → 「甲方 (发包方) : 市第一人民医院」「乙方 (承包方) : …」全对
      // 合同/发票都是表单式排版，不是杂志多栏，psm 6 最合适。
      const res = await ocrImage(tess, useLang, img, workDir, {
        psm: opts.psm || 6,
        timeout: opts.timeout || 180000,
      });
      if (!res.ok) return { ok: false, error: res.error };
      for (const l of res.lines) lines.push(l);

      // 数字通道（实测能救回金额）：eng + 数字白名单，独立于中文通道
      if (dualChannel && avail.includes('eng')) {
        const dl = await ocrDigits(tess, img, workDir, { timeout: opts.timeout || 180000 });
        digitLines.push(...dl);
      }

      const sz = imageSize(img);
      pageInfo.push({ page: i + 1, width: sz ? sz.width : 0, height: sz ? sz.height : 0, lines: res.lines.length });
    }

    // 主文本只用中文通道，保持干净。数字通道单独返回，供 recognize() 做金额兜底
    const text = lines.join('\n');

    return {
      ok: true,
      kind,
      engine: 'tesseract-' + useLang + (dualChannel && avail.includes('eng') ? '+eng' : ''),
      scale: opts.scale || null,
      pages: pageInfo,
      lines,
      text,
      // 数字通道输出（形如 ['5,860,000.00', '20260305', ...]），可能为空数组
      digitLines: dualChannel ? digitLines : [],
      elapsedMs: Date.now() - t0,
    };
  } finally {
    for (const f of temps) { try { fs.unlinkSync(f); } catch { /* 忽略 */ } }
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
}

module.exports = { runTesseract, imageSize, pickAmountCandidates };