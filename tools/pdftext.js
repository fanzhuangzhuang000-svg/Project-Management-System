'use strict';
/**
 * PDF 文字层提取（不 OCR）
 *
 * 为什么需要它：
 *   电子发票这类**数字生成**的 PDF 内部本来就有完整、准确的文字，
 *   把它渲染成图片再 OCR，等于把准确数据换成有噪声的识别结果 ——
 *   发票种类会读成「电子发票（增值税专用发票）」的碎片、
 *   单价会粘成 1.007262.805309734514 这种。
 *   直接读文字层：100% 准确，而且快得多。
 *
 * 扫描件（拍照/复印的合同）没有文字层，这条路会返回 hasText=false，
 * 调用方继续走 OCR。
 *
 * 依赖：tools/pdfjs/ 下两个精简版文件（Apache-2.0），共 1.76 MB。
 */
const fs = require('node:fs');
const path = require('node:path');

const PDFJS_DIR = path.join(__dirname, 'pdfjs');

/** 少于这么多字就认为「没有文字层」（扫描件里偶尔会有几个页码之类的噪声字符） */
const MIN_CHARS = 80;

let pdfjsPromise = null;
function loadPdfjs () {
  if (!pdfjsPromise) {
    const entry = path.join(PDFJS_DIR, 'pdf.min.mjs').replace(/\\/g, '/');
    pdfjsPromise = import('file://' + entry).then(m => {
      // Node 里没有 Worker：用同目录的 worker 文件，pdfjs 会退化成主线程执行
      try {
        const w = path.join(PDFJS_DIR, 'pdf.worker.min.mjs').replace(/\\/g, '/');
        m.GlobalWorkerOptions.workerSrc = 'file://' + w;
      } catch { /* 退化成 fake worker 也能跑 */ }
      return m;
    });
  }
  return pdfjsPromise;
}

/**
 * 把一页的文字块按坐标拼回阅读顺序。
 *
 * 关键点：PDF 里文字块的顺序不等于人看到的顺序（发票上「购买方信息」这种
 * 竖排标签会被拆成单字、值又散在别处），所以必须按坐标重排。
 *
 * 另一个关键点：相邻单元格要按**间距**决定补不补空格。
 * 直接拼接会把 `台 1.00 7262.81` 粘成 `台1.007262.81`，下游正则就全废了。
 */
function layoutPage (items) {
  const blocks = items
    .filter(it => it.str && it.str.trim() && Array.isArray(it.transform))
    .map(it => ({
      s: it.str,
      x: it.transform[4],
      y: it.transform[5],
      w: typeof it.width === 'number' ? it.width : 0,
      h: Math.abs(it.transform[3]) || Math.abs(it.transform[0]) || 10,
    }));
  if (!blocks.length) return [];

  // 行高的一半作为同一行的容差，比写死 4px 稳
  const medH = blocks.map(b => b.h).sort((a, b) => a - b)[Math.floor(blocks.length / 2)] || 10;
  const lineTol = Math.max(2, medH * 0.5);

  blocks.sort((a, b) => (b.y - a.y) || (a.x - b.x));
  const lines = [];
  for (const b of blocks) {
    const cur = lines[lines.length - 1];
    if (cur && Math.abs(cur.y - b.y) <= lineTol) cur.parts.push(b);
    else lines.push({ y: b.y, parts: [b] });
  }

  const out = [];
  for (const L of lines) {
    L.parts.sort((a, b) => a.x - b.x);
    let text = '';
    let prevEnd = null;
    let prevW = 0;
    for (const p of L.parts) {
      if (prevEnd !== null) {
        const gap = p.x - prevEnd;
        // 间距超过一个字宽的一半 → 当成两个词，补空格；
        // 否则是同一个词被拆成了多个块，直接接上
        if (gap > Math.max(1, prevW * 0.25)) text += ' ';
      }
      text += p.s;
      prevEnd = p.x + p.w;
      prevW = p.w / Math.max(1, p.s.length);
    }
    const t = text.replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * 提取 PDF 文字层。
 * @returns {Promise<{hasText:boolean, text:string, normalized:string, pages:any[], pageCount:number, elapsedMs:number, reason?:string}>}
 */
async function pdfText (absPath, opts = {}) {
  const t0 = Date.now();
  const empty = (reason) => ({ hasText: false, text: '', normalized: '', pages: [], pageCount: 0, elapsedMs: Date.now() - t0, reason });

  if (!fs.existsSync(absPath)) return empty('文件不存在');
  const buf = fs.readFileSync(absPath);
  // 快速判断是不是 PDF（有些 .pdf 其实是图片，或者干脆是别的格式）
  if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') return empty('不是 PDF 文件');

  let pdfjs;
  try {
    pdfjs = await loadPdfjs();
  } catch (e) {
    return empty('pdfjs 加载失败：' + e.message);
  }

  let doc = null;
  try {
    // 不复制 buf：pdfjs 会 detach 传进去的 ArrayBuffer，直接给副本以免影响调用方
    doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      useSystemFonts: true,
      // 关掉不需要的网络/字体资源加载，避免离线环境卡住
      disableFontFace: true,
      useWorkerFetch: false,
      // 只输出错误：pdfjs 找不到 canvas 时会打一堆 DOMMatrix 告警，
      // 我们只取文字不渲染，那些告警只会让人以为出错了
      verbosity: 0,
    }).promise;

    const maxPages = Math.min(opts.maxPages || 40, doc.numPages);
    const pages = [];
    let total = 0;
    for (let p = 1; p <= maxPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      const lines = layoutPage(tc.items || []);
      const text = lines.join('\n');
      total += text.length;
      pages.push({ page: p, width: page.view[2], height: page.view[3], lines, text });
      page.cleanup();
    }

    if (total < MIN_CHARS) {
      return { ...empty('没有文字层（是扫描件）'), pageCount: doc.numPages };
    }

    // 走和 OCR 完全相同的归一化/抽取管线，下游不用改
    const { normalize } = require('./extract.js');
    const normalized = pages.map(p => (normalize ? normalize(p.text) : p.text)).join('\n\n');
    const text = pages.map(p => p.text).join('\n\n');

    return {
      hasText: true,
      text,
      normalized,
      pages,
      pageCount: doc.numPages,
      elapsedMs: Date.now() - t0,
    };
  } catch (e) {
    return empty('解析 PDF 失败：' + e.message);
  } finally {
    try { if (doc) await doc.destroy() } catch { /* 忽略 */ }
  }
}

module.exports = { pdfText, layoutPage, MIN_CHARS, PDFJS_DIR };
