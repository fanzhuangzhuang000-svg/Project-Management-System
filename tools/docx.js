'use strict';
/**
 * 零依赖生成 Word 文档（.docx）
 *
 * 后端没有任何第三方库，所以：
 *   - 自己写最小 ZIP 打包器（zlib 提供 deflateRaw，CRC32 手写）
 *   - 自己拼 OOXML（Word 的文档格式就是一堆 XML 打进 zip）
 *
 * .docx 的最小可用结构：
 *   [Content_Types].xml           声明各部件类型
 *   _rels/.rels                   根关系，指向主文档
 *   word/document.xml             正文
 *   word/styles.xml               样式（中文字体、标题、表格）
 *   word/_rels/document.xml.rels  文档关系（引用样式）
 */

const zlib = require('node:zlib');

/* ==================== ZIP ==================== */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32 (buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 把 [{name, data}] 打成一个 zip（deflate 压缩） */
function makeZip (files) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  // DOS 时间格式（固定一个合理值，省得每次生成都变）
  const dosTime = 0x6000;               // 12:00:00
  const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const crc = crc32(raw);
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    // 压不动就原样存，避免变大
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);      // 签名
    lh.writeUInt16LE(20, 4);              // 需要版本
    lh.writeUInt16LE(0x0800, 6);          // 标志（UTF-8 文件名）
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, eocd]);
}

/* ==================== XML 小工具 ==================== */

function esc (s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
    // 去掉 XML 不接受的非法控制字符，否则 Word 会打不开
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** 行内 Markdown → Word 的 run（粗体、行内代码） */
function inlineRuns (text, base = '') {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  const push = (t, extra) => {
    if (!t) return;
    out.push(`<w:r><w:rPr>${base}${extra || ''}</w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`);
  };
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) push(tok.slice(2, -2), '<w:b/>');
    else push(tok.slice(1, -1), '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:shd w:val="clear" w:fill="F1F5F9"/>');
    last = m.index + tok.length;
  }
  if (last < text.length) push(text.slice(last));
  if (!out.length) push(' ');
  return out.join('');
}

/** 段落 */
function para (text, { style = '', align = '', runs = null, spaceBefore = 0 } = {}) {
  const pPr = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    align ? `<w:jc w:val="${align}"/>` : '',
    spaceBefore ? `<w:spacing w:before="${spaceBefore}"/>` : '',
  ].join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs !== null ? runs : inlineRuns(text)}</w:p>`;
}

/** 表格：head + rows 都是字符串数组 */
function table (head, rows) {
  const borders = `<w:tblBorders>
    <w:top w:val="single" w:sz="4" w:color="CBD5E1"/>
    <w:left w:val="single" w:sz="4" w:color="CBD5E1"/>
    <w:bottom w:val="single" w:sz="4" w:color="CBD5E1"/>
    <w:right w:val="single" w:sz="4" w:color="CBD5E1"/>
    <w:insideH w:val="single" w:sz="4" w:color="E2E8F0"/>
    <w:insideV w:val="single" w:sz="4" w:color="E2E8F0"/>
  </w:tblBorders>`;
  // w:tblGrid 是 Word 规范的必需子元素，缺了 python-docx 之类的工具会直接拒绝打开。
  // 正文宽度 = 页面 11906 − 左右边距 1134×2 = 9638 twips，列宽平均分。
  const cols = Math.max(head.length, ...rows.map(r => r.length), 1);
  const colW = Math.floor(9638 / cols);
  const grid = `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join('')}</w:tblGrid>`;
  const cell = (text, isHead) => `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>
    ${isHead ? '<w:shd w:val="clear" w:fill="F1F5F9"/>' : ''}</w:tcPr>
    <w:p><w:pPr><w:spacing w:before="40" w:after="40"/></w:pPr>${inlineRuns(text, isHead ? '<w:b/>' : '')}</w:p></w:tc>`;
  // 补齐每行的列数，否则 Word 会按缺列渲染
  const pad = (cells) => { const c = cells.slice(); while (c.length < cols) c.push(''); return c };
  const row = (cells, isHead) => `<w:tr>${pad(cells).map(c => cell(c, isHead)).join('')}</w:tr>`;
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/>${borders}</w:tblPr>
    ${grid}${row(head, true)}${rows.map(r => row(r, false)).join('')}</w:tbl>${para('')}`;
}

/* ==================== Markdown → Word 正文 ==================== */

/** 把模型输出的 Markdown 转成 Word 正文 XML */
function markdownToBody (md) {
  const lines = String(md || '').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 代码块
    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++;
      for (const l of buf) out.push(para(l, { style: 'Code' }));
      continue;
    }

    // 表格
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const split = s => s.trim().replace(/^\||\|$/g, '').split('|').map(x => x.trim());
      const head = split(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(split(lines[i])); i++ }
      out.push(table(head, rows));
      continue;
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = Math.min(h[1].length, 3);
      out.push(para(h[2], { style: 'Heading' + lv }));
      i++; continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:color="CBD5E1"/></w:pBdr></w:pPr></w:p>');
      i++; continue;
    }

    // 有序列表：用原文里的序号，不自己从头数
    // （否则「1. … 2. …」中间被其他内容隔开时，第二段会又从 1 开始）
    if (/^\s*\d+[.)]\s+/.test(line)) {
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        const m = /^\s*(\d+)[.)]\s+(.*)$/.exec(lines[i]);
        out.push(para(`${m[1]}. ${m[2]}`, { style: 'ListParagraph' }));
        i++;
      }
      continue;
    }

    // 无序列表（保留两级缩进）
    if (/^\s*[-*+]\s+/.test(line)) {
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const indent = lines[i].length - lines[i].replace(/^\s*/, '').length;
        const text = lines[i].replace(/^\s*[-*+]\s+/, '');
        out.push(para((indent >= 2 ? '◦ ' : '• ') + text, { style: 'ListParagraph' }));
        i++;
      }
      continue;
    }

    if (!line.trim()) { i++; continue }

    // 普通段落
    const buf = [];
    while (i < lines.length && lines[i].trim()
      && !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|\|)/.test(lines[i])) {
      buf.push(lines[i]); i++;
    }
    out.push(para(buf.join('')));
  }
  return out.join('');
}

/* ==================== 组装 docx ==================== */

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

const FONT = '<w:rFonts w:ascii="Segoe UI" w:hAnsi="Segoe UI" w:eastAsia="微软雅黑" w:cs="Segoe UI"/>';

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="21"/><w:color w:val="334155"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:after="200"/></w:pPr><w:rPr>${FONT}<w:b/><w:sz w:val="40"/><w:color w:val="0F172A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr>${FONT}<w:b/><w:sz w:val="28"/><w:color w:val="1E293B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:before="220" w:after="100"/></w:pPr><w:rPr>${FONT}<w:b/><w:sz w:val="24"/><w:color w:val="1E293B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:spacing w:before="180" w:after="80"/></w:pPr><w:rPr>${FONT}<w:b/><w:sz w:val="22"/><w:color w:val="334155"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:ind w:left="420"/><w:spacing w:after="60"/></w:pPr></w:style>
<w:style w:type="paragraph" w:styleId="Sub"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>
  <w:rPr>${FONT}<w:sz w:val="18"/><w:color w:val="94A3B8"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
  <w:pPr><w:ind w:left="360"/><w:spacing w:after="120"/></w:pPr>
  <w:rPr>${FONT}<w:i/><w:color w:val="64748B"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>
  <w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/><w:color w:val="334155"/></w:rPr></w:style>
</w:styles>`;

/**
 * 生成 .docx
 * @param {object} o
 * @param {string} o.title     标题
 * @param {string} [o.subtitle] 副标题（日期、系统名等）
 * @param {string} [o.question] 提问
 * @param {string} o.answer     模型回答（Markdown）
 * @param {string} [o.appendix] 附录（Markdown）
 * @returns {Buffer}
 */
function buildDocx (o) {
  const body = [];

  body.push(para(o.title || '经营分析报告', { style: 'Title' }));
  if (o.subtitle) body.push(para(o.subtitle, { style: 'Sub' }));

  if (o.question) {
    body.push(para('分析问题', { style: 'Heading1' }));
    body.push(para(o.question, { style: 'Quote' }));
  }

  body.push(para('分析结论', { style: 'Heading1' }));
  body.push(markdownToBody(o.answer || ''));

  if (o.appendix) {
    body.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    body.push(para('附录：分析所依据的经营数据', { style: 'Heading1' }));
    body.push(markdownToBody(o.appendix));
  }

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}
<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>
<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr>
</w:body></w:document>`;

  return makeZip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: doc },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
  ]);
}

module.exports = { buildDocx, makeZip, markdownToBody, crc32 };
