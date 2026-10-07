'use strict';
/**
 * OCR 调用封装：自动选后端，输出统一结构。
 *
 *   Windows → ocr.ps1（PowerShell 5.1 + WinRT 内置 OCR）
 *   Linux   → ocr-tesseract.js（Tesseract + poppler）
 *
 * 引擎选择和探测在 ocr-backend.js，这里只负责分派。
 *
 * 刻意使用 stdio:'ignore' + 结果写文件的方式，而不是捕获子进程 stdout：
 * 一是避免 PowerShell 的编码问题，二是避免管道在某些受限环境下不可用。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { backend, describe: describeBackend, health } = require('./ocr-backend.js');

const PS1 = path.join(__dirname, 'ocr.ps1');
const PS_EXE = path.join(process.env.SystemRoot || 'C:\\Windows',
  'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const OCR_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp', '.gif'];

function isSupported (filePath) {
  return OCR_EXT.includes(path.extname(String(filePath)).toLowerCase());
}

/** Windows PowerShell 后端：逻辑与原来完全一致 */
function runPowershell (filePath, opts = {}) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(PS1)) return reject(new Error('缺少识别脚本 tools/ocr.ps1'));
    if (!fs.existsSync(PS_EXE)) return reject(new Error('找不到 Windows PowerShell'));
    if (!fs.existsSync(filePath)) return reject(new Error('文件不存在：' + filePath));

    const outFile = path.join(os.tmpdir(), `pms_ocr_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-Path', filePath, '-OutFile', outFile];
    if (opts.scale) args.push('-Scale', String(opts.scale));
    if (opts.maxPages) args.push('-MaxPages', String(opts.maxPages));
    if (opts.lang) args.push('-Lang', String(opts.lang));

    const cleanup = () => { try { if (fs.existsSync(outFile)) fs.unlinkSync(outFile); } catch { /* 忽略 */ } };
    let child;
    try {
      child = spawn(PS_EXE, args, { stdio: 'ignore', windowsHide: true });
    } catch (e) { cleanup(); return reject(e); }

    const timeout = opts.timeout || 180000;
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 忽略 */ }
      cleanup();
      reject(new Error(`识别超时（超过 ${Math.round(timeout / 1000)} 秒）`));
    }, timeout);

    child.on('error', e => { clearTimeout(timer); cleanup(); reject(e); });
    child.on('exit', () => {
      clearTimeout(timer);
      let raw;
      try {
        raw = fs.readFileSync(outFile, 'utf8');
      } catch {
        cleanup();
        return reject(new Error('识别进程未产出结果（可能被安全软件拦截或文件损坏）'));
      }
      cleanup();
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('识别结果解析失败')); }
    });
  });
}

/**
 * 统一入口：按可用后端分派。
 * @returns {Promise<{ok:boolean, kind?:string, lines?:string[], text?:string, pages?:any[], elapsedMs?:number, error?:string}>}
 */
async function runOcr (filePath, opts = {}) {
  const b = backend();
  if (b.name === 'powershell') return runPowershell(filePath, opts);
  if (b.name === 'tesseract') {
    const { runTesseract } = require('./ocr-tesseract.js');
    return runTesseract(filePath, opts);
  }
  throw new Error(b.reason || '没有可用的识别引擎');
}

/** OCR + 字段抽取，一步到位 */
async function recognize (filePath, opts = {}) {
  const { extract } = require('./extract.js');

  // 先试文字层：电子发票这类数字生成的 PDF 本来就有准确文字，
  // 渲染成图再 OCR 反而把「电子发票（增值税专用发票）」读成碎片、
  // 把单价粘成 1.007262.805309734514。
  // 扫描件（拍照的合同）没有文字层，这里会立刻返回，继续走 OCR。
  if (path.extname(String(filePath)).toLowerCase() === '.pdf') {
    try {
      const { pdfText } = require('./pdftext.js');
      const pt = await pdfText(filePath, { maxPages: opts.maxPages });
      if (pt.hasText) {
        const ex = extract(pt.text, { kind: opts.docKind || 'auto' });
        return {
          ok: true,
          kind: ex.kind,
          text: pt.text,
          normalized: ex.normalized,
          fields: ex.fields,
          hits: ex.hits,
          hints: ex.hints || {},
          checks: ex.checks,
          parties: ex.parties,
          confidence: ex.confidence,
          fieldCount: ex.fieldCount,
          expectedCount: ex.expectedCount,
          pages: pt.pages,
          engine: 'pdf-text',
          pageCount: pt.pageCount,
          elapsedMs: pt.elapsedMs,
        };
      }
    } catch { /* 文字层提取失败就照样走 OCR，不让它挡住主流程 */ }
  }

  const ocr = await runOcr(filePath, opts);
  if (!ocr.ok) {
    const msg = ocr.kind === 'unsupported' ? '该文件类型不支持识别' : (ocr.error || '识别失败');
    return { ok: false, error: msg, ocr };
  }
  const ex = extract(ocr.text || '', { kind: opts.docKind || 'auto' });

  // ---- 金额兜底（仅 Tesseract 后端）----
  // 实测：chi_sim 会把小字号金额读错（5,860,000.00 → 9,.860,000.00），
  // 而同一张图的 eng+数字白名单通道读得完全正确。
  // 但数字通道输出一律不带上下文，所以只在「中文通道确实没抽出金额」时
  // 才拿来补，且必须挂一个校验提示让用户核对 —— 绝不能悄悄填一个可能错的数。
  const fields = { ...ex.fields };
  const hits = { ...ex.hits };
  const checks = Array.isArray(ex.checks) ? ex.checks.slice() : [];
  if (ocr.digitLines && ocr.digitLines.length && !fields.amount && !fields.total_amount) {
    const { pickAmountCandidates } = require('./ocr-tesseract.js');
    const cands = pickAmountCandidates(ocr.digitLines);
    if (cands.length) {
      const top = cands[0];
      fields.amount = top.value.toFixed(2);
      hits.amount = top.text + '（数字通道复核）';
      // 撤掉原来的"没识别出金额"警告，换成"已识别但请核对"
      const drop = checks.filter(c => !/识别出合同金额|识别到合同金额|没能识别|未识别到合同金额|请手动填写/.test(c.text));
      checks.length = 0;
      checks.push(...drop);
      checks.unshift({
        level: 'warn',
        text: `合同金额 ¥${top.value.toLocaleString('zh-CN')} 来自数字通道复核（中文识别把数字读错了），请照着原件核对后再保存。`,
      });
    }
  }

  return {
    ok: true,
    kind: ex.kind,
    text: ocr.text || '',
    normalized: ex.normalized,
    fields,
    hits,
    hints: ex.hints || {},
    checks,
    parties: ex.parties,
    confidence: ex.confidence,
    fieldCount: ex.fieldCount,
    expectedCount: ex.expectedCount,
    pages: ocr.pages || [],
    engine: ocr.engine,
    elapsedMs: ocr.elapsedMs,
  };
}
module.exports = { runOcr, runPowershell, recognize, isSupported, OCR_EXT, PS_EXE, PS1, describeBackend, health };
