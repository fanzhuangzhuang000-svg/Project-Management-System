'use strict';
/**
 * 表格文件解析：CSV（自动识别 UTF-8 / GBK）与 XLSX（零依赖，内置 ZIP 解包）
 * 对外只暴露 readTable(buffer, filename) → { headers, rows }
 */
const zlib = require('node:zlib');

// ---------------- 文本解码 ----------------
/** 中文 Excel 另存的 CSV 常是 GBK，不能一律按 UTF-8 读 */
function decodeText (buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
    return buf.slice(3).toString('utf8');
  }
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.slice(2).toString('utf16le');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try { return new TextDecoder('gbk').decode(buf); }
    catch { return buf.toString('utf8'); }
  }
}

// ---------------- CSV ----------------
function parseCSV (text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const push = () => { row.push(field); field = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') {
      inQ = true;
    } else if (c === ',') {
      push();
    } else if (c === '\n') {
      push(); rows.push(row); row = [];
    } else if (c === '\r') {
      /* 忽略 */
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { push(); rows.push(row); }
  return rows.map(r => r.map(c => String(c).trim())).filter(r => r.some(c => c !== ''));
}

// ---------------- XLSX（零依赖最小实现） ----------------
function decodeXml (s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

function readZipEntries (buf) {
  let eocd = -1;
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('不是有效的 xlsx 文件（找不到 ZIP 结尾；如果是 .xls 老格式，请在 Excel 里另存为 .xlsx 或 CSV）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries[name] = { method, compSize, localOff };
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function extractEntry (buf, e) {
  const lo = e.localOff;
  if (buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('xlsx 内部结构异常');
  const nameLen = buf.readUInt16LE(lo + 26);
  const extraLen = buf.readUInt16LE(lo + 28);
  const start = lo + 30 + nameLen + extraLen;
  const comp = buf.slice(start, start + e.compSize);
  if (e.method === 0) return comp;
  if (e.method === 8) return zlib.inflateRawSync(comp);
  throw new Error('xlsx 使用了不支持的压缩方式');
}

function colToIndex (letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function readXlsx (buf) {
  const entries = readZipEntries(buf);
  const shared = [];
  if (entries['xl/sharedStrings.xml']) {
    const xml = extractEntry(buf, entries['xl/sharedStrings.xml']).toString('utf8');
    for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => decodeXml(x[1]));
      shared.push(parts.join(''));
    }
  }

  // 定位第一张工作表
  let sheetKey = null;
  if (entries['xl/workbook.xml'] && entries['xl/_rels/workbook.xml.rels']) {
    const wb = extractEntry(buf, entries['xl/workbook.xml']).toString('utf8');
    const rels = extractEntry(buf, entries['xl/_rels/workbook.xml.rels']).toString('utf8');
    const first = /<sheet[^>]*r:id="([^"]+)"/.exec(wb);
    if (first) {
      const rel = new RegExp(`<Relationship[^>]*Id="${first[1]}"[^>]*Target="([^"]+)"`).exec(rels);
      if (rel) {
        const target = rel[1].replace(/^\/?xl\//, '').replace(/^\//, '');
        const key = 'xl/' + target;
        if (entries[key]) sheetKey = key;
      }
    }
  }
  if (!sheetKey) sheetKey = Object.keys(entries).find(k => /^xl\/worksheets\/sheet\d+\.xml$/.test(k));
  if (!sheetKey) throw new Error('xlsx 里找不到工作表');

  const xml = extractEntry(buf, entries[sheetKey]).toString('utf8');
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cm of rm[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const ref = /r="([A-Z]+)\d+"/.exec(attrs);
      const idx = ref ? colToIndex(ref[1]) : cells.length;
      const t = (/t="([^"]+)"/.exec(attrs) || [])[1];
      let val = '';
      if (t === 's') {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = vm ? (shared[Number(vm[1])] ?? '') : '';
      } else if (t === 'inlineStr') {
        val = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => decodeXml(x[1])).join('');
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(body);
        val = vm ? decodeXml(vm[1]) : '';
      }
      while (cells.length < idx) cells.push('');
      cells[idx] = val;
    }
    const trimmed = cells.map(c => String(c ?? '').trim());
    if (trimmed.some(c => c !== '')) rows.push(trimmed);
  }
  return rows;
}

// ---------------- 统一入口 ----------------
function readTable (buffer, filename) {
  const name = String(filename || '').toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xlsm')) {
    const rows = readXlsx(buffer);
    if (!rows.length) throw new Error('表格里没有数据');
    return { headers: rows[0], rows: rows.slice(1), kind: 'xlsx' };
  }
  if (name.endsWith('.xls')) {
    throw new Error('不支持老版 .xls 格式，请在 Excel 里「另存为」.xlsx 或 CSV(逗号分隔) 后重试');
  }
  const rows = parseCSV(decodeText(buffer));
  if (!rows.length) throw new Error('文件里没有数据');
  return { headers: rows[0], rows: rows.slice(1), kind: 'csv' };
}

/** Excel 日期序列号 → YYYY-MM-DD（1900 日期系统） */
function excelSerialToDate (n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 20000 || v > 80000) return null;
  const ms = Date.UTC(1899, 11, 30) + Math.round(v) * 86400000;
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

module.exports = { readTable, parseCSV, readXlsx, decodeText, excelSerialToDate };
