'use strict';
/**
 * 弱电智能化工程项目管理系统 —— 后端服务
 * 零第三方依赖：node:http + node:sqlite
 * 启动： node server.js [--port 8787]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { URL } = require('node:url');
const dbf = require('./db.js');
const auth = require('./auth.js');
const attach = require('./attachments.js');
const bk = require('./backup.js');
const importer = require('./import.js');
const trash = require('./trash.js');
const logmod = require('./logs.js');
const snap = require('./snapshots.js');
const ai = require('./ai.js');
const license = require('./tools/license.js');
const docx = require('./tools/docx.js');
const tabular = require('./tools/tabular.js');
const { recognize, health: ocrHealth, describeBackend: describeOcrBackend } = require('./tools/ocr.js');
const ingest = require('./tools/ingest.js');
const { TABLES, TABLE_ORDER } = require('./schema.js');

const PUBLIC_DIR = path.join(__dirname, 'public');
const APP_NAME = '弱电智能化工程项目管理系统';

/**
 * 版本号。
 *
 * 踩过的坑：这里原来写死 '1.0.0'，于是 1.0.1 / 1.0.2 的安装包启动横幅、
 * /api/health、/api/meta 全都报 v1.0.0 —— 客户报障时问「你装的哪一版」，
 * 两边看到的版本号对不上，只能靠翻文件时间猜。
 *
 * 所以改成运行时读随包的 package.json（Linux 包和 Docker 包都会带上它）。
 * Windows 单机版是按 require 依赖图打包的，package.json 不一定在包里，
 * 读不到就走下面的兜底常量。
 *
 * ⚠️ 兜底常量必须和 package.json 的 version 一致 —— 由
 *    tools/version-consistency-test.js 断言，对不上 CI 直接红。
 */
const VERSION_FALLBACK = '1.1.0';
function detectVersion () {
  for (const f of [path.join(__dirname, 'package.json'), path.join(__dirname, '..', 'package.json')]) {
    try {
      // 去掉 BOM：带 BOM 的 package.json 会让 JSON.parse 直接抛错。
      // 这份仓库里的 package.json 没有 BOM，但编辑器「另存为 UTF-8」很容易加上，
      // 那时会静默落到兜底值 —— 版本号又对不上了，且看不出为什么。
      const raw = fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '');
      const v = JSON.parse(raw).version;
      if (v) return v;
    } catch { /* 打包后可能没有 package.json，用兜底 */ }
  }
  return VERSION_FALLBACK;
}
const VERSION = detectVersion();

// ---------------- 参数 ----------------
function argVal (name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return fallback;
}
/**
 * 取监听地址。
 *
 * HOST 这个环境变量**不能**直接用：Node 的 http.listen() 有自己的保留环境变量
 * HOST=0.0.0.0 之类的值会被 npm/部分运行时改写。更坑的是，如果部署环境里
 * HOST 恰好是某个具体 IP 或主机名（有些云主机会设），程序就会只监听那一个地址，
 * 局域网里别人访问不到，症状是「本机能开，同事打不开」——极难排查。
 *
 * 所以：只有当 PMS_HOST 明确给了才用它，否则一律监听 0.0.0.0。
 */
function listenHost () {
  const explicit = String(process.env.PMS_HOST || '').trim();
  if (explicit) return explicit;
  return '0.0.0.0';
}
const PORT = parseInt(argVal('port', process.env.PMS_PORT || process.env.PMS_LISTEN_PORT || process.env.PORT || '8787'), 10);
const HOST = listenHost();

// ---------------- 工具 ----------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

function sendJSON (res, code, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody (req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('JSON 格式错误')); }
    });
    req.on('error', reject);
  });
}

function csvCell (v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCSV (table, data) {
  const def = TABLES[table];
  const headers = def.fields.map(f => f.label);
  const lines = [headers.map(csvCell).join(',')];
  for (const r of data.rows) {
    lines.push(def.fields.map(f => {
      const isRef = f.type === 'ref';
      const v = isRef ? (r[`${f.name}_name`] ?? '') : r[f.name];
      return csvCell(v);
    }).join(','));
  }
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

function queryOf (url) {
  const q = {};
  for (const [k, v] of url.searchParams.entries()) q[k] = v;
  return q;
}

// ---------------- 附件上传：multipart/form-data 解析（零依赖） ----------------
const MAX_UPLOAD = 40 * 1024 * 1024;

function readRaw (req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error(`文件超过 ${Math.round(limit / 1024 / 1024)} MB 上限`), { code: 'TOOBIG' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parsePartHeaders (text) {
  const h = {};
  for (const line of text.split('\r\n')) {
    const i = line.indexOf(':');
    if (i > 0) h[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const cd = h['content-disposition'] || '';
  h.name = (/name="([^"]*)"/.exec(cd) || [])[1];
  h.filename = (/filename="([^"]*)"/.exec(cd) || [])[1];
  return h;
}

function parseMultipart (buf, boundary) {
  const delim = Buffer.from('--' + boundary);
  const parts = [];
  let pos = buf.indexOf(delim);
  if (pos === -1) return parts;
  pos += delim.length;
  while (pos < buf.length) {
    if (buf[pos] === 0x2d && buf[pos + 1] === 0x2d) break;      // 结束标记 "--"
    if (buf[pos] === 0x0d && buf[pos + 1] === 0x0a) pos += 2;   // 跳过 CRLF
    const headerEnd = buf.indexOf('\r\n\r\n', pos);
    if (headerEnd === -1) break;
    const headers = parsePartHeaders(buf.slice(pos, headerEnd).toString('utf8'));
    const contentStart = headerEnd + 4;
    const next = buf.indexOf(delim, contentStart);
    if (next === -1) break;
    let contentEnd = next;
    if (buf[contentEnd - 2] === 0x0d && buf[contentEnd - 1] === 0x0a) contentEnd -= 2;
    parts.push({ headers, data: buf.slice(contentStart, contentEnd) });
    pos = next + delim.length;
  }
  return parts;
}

// ---------------- 名称模糊匹配（用于识别后自动关联往来单位/项目） ----------------
function normName (s) {
  return String(s || '')
    .replace(/[（(][^)）]*[)）]/g, '')
    .replace(/[\s·、,，.。:：;；'"“”‘’\-_/\\]/g, '')
    .toLowerCase();
}

function scoreName (a, b) {
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return 82;
  const setB = new Set(b);
  let common = 0;
  for (const ch of new Set(a)) if (setB.has(ch)) common++;
  return Math.round(common / Math.max(a.length, b.length) * 70);
}

function matchPartners (name) {
  const n = normName(name);
  if (n.length < 2) return null;
  let best = null, bestScore = 0;
  for (const p of dbf.db.prepare('SELECT id, name, short_name, type FROM partners').all()) {
    const s = Math.max(scoreName(n, normName(p.name)), scoreName(n, normName(p.short_name)));
    if (s > bestScore) { bestScore = s; best = p; }
  }
  return best && bestScore >= 55
    ? { id: best.id, name: best.name, type: best.type, score: bestScore }
    : null;
}

function matchProjects (text, limit = 3) {
  const n = normName(text);
  if (n.length < 4) return [];
  const scored = [];
  for (const p of dbf.db.prepare('SELECT id, name, code FROM projects').all()) {
    const s = Math.max(scoreName(n, normName(p.name)), scoreName(n, normName(p.code)));
    if (s >= 45) scored.push({ id: p.id, name: p.name, code: p.code, score: s });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 根据识别出的甲乙方/购销方，推断收支方向、建议关联的单位与项目 */
function buildSuggestions (r) {
  const parties = (r.parties || []).map(p => ({ ...p, match: matchPartners(p.name) }));
  const suggest = {};
  const CUSTOMER = ['甲方'];
  const VENDOR = ['供应商', '分包商', '劳务队'];

  if (r.kind === 'invoice') {
    const buyer = parties.find(p => p.role === 'buyer');
    const seller = parties.find(p => p.role === 'seller');
    if (buyer && buyer.match && CUSTOMER.includes(buyer.match.type)) {
      suggest.direction = 'out'; suggest.partner_id = buyer.match.id; suggest.partner_role = '购买方';
    } else if (seller && seller.match && VENDOR.includes(seller.match.type)) {
      suggest.direction = 'in'; suggest.partner_id = seller.match.id; suggest.partner_role = '销售方';
    } else if (buyer && buyer.match && !(seller && seller.match)) {
      suggest.direction = 'out'; suggest.partner_id = buyer.match.id; suggest.partner_role = '购买方';
    } else if (seller && seller.match && !(buyer && buyer.match)) {
      suggest.direction = 'in'; suggest.partner_id = seller.match.id; suggest.partner_role = '销售方';
    } else if (seller && seller.match) {
      suggest.partner_id = seller.match.id; suggest.partner_role = '销售方';
    }
  } else if (r.kind === 'contract') {
    const a = parties.find(p => p.role === 'party_a');
    const b = parties.find(p => p.role === 'party_b');
    if (a && a.match && CUSTOMER.includes(a.match.type)) {
      suggest.direction = 'in'; suggest.partner_id = a.match.id; suggest.partner_role = '甲方';
    } else if (a && a.match) {
      suggest.direction = 'out'; suggest.partner_id = a.match.id; suggest.partner_role = '甲方';
    } else if (b && b.match) {
      suggest.partner_id = b.match.id; suggest.partner_role = '乙方';
    }
  }

  // 项目线索：优先识别到的项目名称，其次备注
  const hintTexts = [r.hints && r.hints.project_name, r.hints && r.hints.project_text, r.hints && r.hints.remark].filter(Boolean);
  let candidates = [];
  for (const h of hintTexts) {
    candidates = matchProjects(h);
    if (!candidates.length) {
      for (const seg of String(h).split(/[，,。;；、\s]+/)) {
        if (seg.length >= 4) { candidates = matchProjects(seg); if (candidates.length) break; }
      }
    }
    if (candidates.length) break;
  }
  if (candidates.length) {
    suggest.project_id = candidates[0].id;
    suggest.project_name = candidates[0].name;
    suggest.project_score = candidates[0].score;
  }
  suggest.project_candidates = candidates;
  return { parties, suggest };
}

/**
 * 附件对外字段。
 *
 * @param {object} row
 * @param {boolean} [withText] 是否带上「识别原文 + 归一化文本」。
 *
 * 默认不带，因为列表里这几样特别占地方（单个附件 21KB）：
 *   - ocr_fields   原始 JSON 字符串 10.7KB —— 和下面解析好的 ocr 是同一份数据，重复发
 *   - ocr.normalized  归一化全文 8.9KB —— 前端列表用不到
 *   - ocr_text     原始识别文本（几万字）
 * 列表只给长度，要看原文时前端单独取这一条（「查看识别原文」）。
 */
function decorateAttachment (row, withText) {
  if (!row) return row;
  const out = { ...row };
  try { out.ocr = row.ocr_fields ? JSON.parse(row.ocr_fields) : null; } catch { out.ocr = null; }
  out.ocr_text_length = (row.ocr_text || '').length;
  // ocr_fields 是 ocr 的原始字符串形式，前端只用 ocr，不重复下发
  delete out.ocr_fields;
  if (out.ocr) {
    out.ocr.normalized_length = (out.ocr.normalized || '').length;
    if (!withText) delete out.ocr.normalized;
  }
  if (!withText) delete out.ocr_text;
  out.url = `/api/file/${row.id}`;
  out.preview_url = `/api/file/${row.id}?inline=1`;
  if (out.ocr) {
    if (!out.ocr.parties) out.ocr.parties = [];
    if (!out.ocr.suggest) out.ocr.suggest = {};
    if (!out.ocr.checks) out.ocr.checks = [];
  }
  return out;
}

// ---------------- 识别任务队列（串行，避免同时拉起多个 PowerShell） ----------------
const ocrQueue = [];
const ocrState = { running: false, currentId: null, done: 0, failed: 0 };

function queueOcr (id, opts = {}) {
  const row = attach.get(id);
  if (!row) return false;
  if (!attach.isOcrExt(row.ext)) { attach.update(id, { ocr_status: 'unsupported' }); return false; }
  if (ocrState.running && ocrState.currentId === row.id) return true;
  if (!ocrQueue.includes(row.id)) ocrQueue.push(row.id);
  attach.update(id, { ocr_status: 'pending', ocr_error: null });
  setImmediate(pumpOcr);
  return true;
}

async function pumpOcr () {
  if (ocrState.running) return;
  const id = ocrQueue.shift();
  if (id === undefined) return;
  const row = attach.get(id);
  if (!row) return pumpOcr();

  ocrState.running = true;
  ocrState.currentId = id;
  attach.update(id, { ocr_status: 'running' });
  try {
    const res = await recognize(attach.absPathOf(row.stored_name), { docKind: 'auto', maxPages: 40 });
    if (res.ok) {
      const { parties, suggest } = buildSuggestions(res);
      const payload = {
        kind: res.kind,
        fields: res.fields,
        hits: res.hits,
        hints: res.hints || {},
        checks: res.checks,
        parties,
        suggest,
        confidence: res.confidence,
        fieldCount: res.fieldCount,
        expectedCount: res.expectedCount,
        normalized: res.normalized,
      };
      attach.update(id, {
        ocr_status: 'done',
        ocr_kind: res.kind,
        ocr_confidence: res.confidence,
        ocr_engine: res.engine,
        ocr_text: res.text,
        ocr_fields: JSON.stringify(payload),
        ocr_error: null,
        ocr_at: dbf.nowISO(),
      });
      ocrState.done++;
      console.log(`[识别完成] 附件#${id} ${row.original_name} → ${res.kind} 置信度 ${res.confidence}%（${res.fieldCount}/${res.expectedCount} 字段）`);
    } else {
      attach.update(id, { ocr_status: 'failed', ocr_error: res.error, ocr_at: dbf.nowISO() });
      ocrState.failed++;
      console.log(`[识别失败] 附件#${id} ${row.original_name} → ${res.error}`);
    }
  } catch (e) {
    attach.update(id, { ocr_status: 'failed', ocr_error: e.message, ocr_at: dbf.nowISO() });
    ocrState.failed++;
    console.log(`[识别异常] 附件#${id} → ${e.message}`);
  } finally {
    ocrState.running = false;
    ocrState.currentId = null;
    setImmediate(pumpOcr);
  }
}

// ---------------- 权限小工具 ----------------
const deny = (res, msg) => { sendJSON(res, 403, { error: msg || '没有操作权限' }); return true; };
const anyRead = (perms) => !!(perms && (perms.all || perms.read.length));
const anyWrite = (perms) => !!(perms && (perms.all || perms.write.length));

/** 数据表读写权限 */
function guardTable (req, res, table, mode) {
  if (!TABLES[table]) { sendJSON(res, 404, { error: '未知数据表' }); return false; }
  const ok = mode === 'write' ? auth.canWrite(req.user.perms, table) : auth.canRead(req.user.perms, table);
  if (!ok) {
    sendJSON(res, 403, { error: `没有${mode === 'write' ? '编辑' : '查看'}「${TABLES[table].label}」的权限` });
    return false;
  }
  return true;
}
function guardSys (req, res, key, label) {
  if (!auth.canSys(req.user.perms, key)) { sendJSON(res, 403, { error: `没有${label || key}的权限` }); return false; }
  return true;
}

// ---------------- 操作人 / 记录名（日志用） ----------------
/** 取客户端 IP（去掉 IPv6 映射前缀），用于登录限速与日志 */
function clientIp (req) {
  const raw = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  return raw ? raw.replace(/^::ffff:/, '') : '本机';
}
function operatorOf (req) {
  // 已登录就用账号名，没登录（登录接口等）才回落到请求头 / IP
  if (req.user) return req.user.name || req.user.username;
  const h = req.headers['x-operator'];
  if (h) {
    try { return decodeURIComponent(String(h)).slice(0, 40) || '未署名'; }
    catch { return String(h).slice(0, 40); }
  }
  return clientIp(req);
}

function recordLabel (table, row) {
  if (!row) return null;
  const def = TABLES[table];
  if (!def) return `#${row.id}`;
  const v = row[def.display];
  return v === null || v === undefined || v === '' ? `#${row.id}` : String(v);
}

function writeLog (req, action, table, recordId, label, detail) {
  logmod.log({
    operator: operatorOf(req), action, table_name: table,
    record_id: recordId, label,
    summary: logmod.summarize(action, table, label, detail),
    detail,
  });
}

// ---------------- 全局搜索 ----------------
const money = v => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const shortDate = v => (v ? String(v).slice(0, 10) : '');

function rowTitle (t, row) {
  if (t === 'payments') {
    return `${row.direction === 'in' ? '收款' : '付款'} ¥${money(row.amount)}${row.pay_date ? ' · ' + shortDate(row.pay_date) : ''}`;
  }
  if (t === 'invoices') {
    return `${row.direction === 'out' ? '销项' : '进项'}发票${row.invoice_no ? ' ' + row.invoice_no : ''} ¥${money(row.total_amount)}`;
  }
  const def = TABLES[t];
  return row[def.display] || `#${row.id}`;
}

function rowSubtitle (t, row) {
  const parts = [row.project_id_name, row.contract_id_name, row.code, row.kind, row.manager, row.contact, row.phone, row.model, row.client_id_name];
  if (t === 'invoices') parts.push(shortDate(row.issue_date));
  return parts.filter(Boolean).join(' · ');
}

function globalSearch (kw) {
  if (!kw) return [];
  const hits = [];
  for (const t of TABLE_ORDER) {
    const def = TABLES[t];
    const r = dbf.listRows(t, { q: kw, limit: 6 });
    for (const row of r.rows) {
      hits.push({
        table: t, tableLabel: def.label, icon: def.icon, id: row.id,
        title: rowTitle(t, row), subtitle: rowSubtitle(t, row),
      });
    }
  }
  // 附件也纳入全局搜索（能搜到识别出来的文字）
  for (const a of attach.search(kw, 8)) {
    hits.push({
      table: 'attachments', tableLabel: '附件', icon: '📎', id: a.id,
      title: a.original_name,
      subtitle: [a.ocr_kind === 'invoice' ? '发票' : a.ocr_kind === 'contract' ? '合同' : '',
        a.ocr_status === 'done' ? '已识别' : '未识别', a.created_at ? String(a.created_at).slice(0, 10) : ''].filter(Boolean).join(' · '),
    });
  }
  return hits.slice(0, 40);
}

/**
 * 能公开给未登录用户看的设置。
 * 只有品牌相关（登录页要显示系统名），不含授权码、密钥这类敏感项。
 */
/** 当前授权状态（从 settings 里的 license_key 算出来） */
function licenseNow () {
  const s = dbf.getSettings();
  const r = license.licenseStatus(s.license_key);

  // 账号数上限：纯离线可校验，零依赖。达上限只禁「新建账号」，
  // 已有账号照常登录 —— 绝不能因为额度用完把人锁在门外。
  if (r && r.seats > 0) {
    const used = auth.countActiveUsers();
    r.usedSeats = used;
    r.seatsExceeded = used >= r.seats;
  }

  // ★ 授权码里的公司名必须和系统设置里的公司名对得上。
  //
  // 以前这里只校验签名和日期，**根本没有比对公司名** ——
  // 结果「绑定公司名」形同虚设：发给 A 公司的码，装到 B 公司电脑上照样通过。
  // 而 gen-license.js 的注释里明写着「它拦的是把授权码复制给别家公司用」，
  // 所以这是漏实现的，不是设计如此。
  //
  // 对不上只降级成 invalid（界面提示、**不锁写**），不升级成 expired：
  // 客户完全可能先填了码、后来又改了公司名，直接锁死写权限太粗暴。
  // 只有真正过期才只读。
  if (r && (r.status === 'ok' || r.status === 'warn') && r.company) {
    const norm = (x) => String(x || '').replace(/[\s　]+/g, '').toLowerCase();
    if (norm(r.company) !== norm(s.company_name)) {
      return {
        ...r,
        status: 'invalid',
        companyMismatch: true,
        licensedTo: r.company,
        // 报错要直接给出解决办法 —— 客户看到「无效」会以为码有问题，
        // 实际往往只是公司名没填成和授权一致。
        error: '这个授权码是发给「' + r.company + '」的，但本系统的公司名是「'
          + (s.company_name || '未填') + '」。'
          + '请到「系统设置 → 界面自定义 → 公司名称」改成「' + r.company + '」，或联系我方按贵司名称重新出码。',
      };
    }
  }
  return r;
}
function publicSettings () {
  const s = dbf.getSettings();
  return { system_name: s.system_name, company_name: s.company_name };
}
// ---------------- 路由 ----------------
async function handleApi (req, res, url) {
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const [head, a, b] = seg;
  const q = queryOf(url);
  const method = req.method.toUpperCase();

  if (head === 'health') {
    return sendJSON(res, 200, { ok: true, app: APP_NAME, version: VERSION, db: dbf.DB_FILE_SAFE, time: dbf.nowISO(), needLogin: true, settings: publicSettings() });
  }

  // ---------------- 登录 / 会话 ----------------
  if (head === 'login' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return sendJSON(res, 400, { error: '请输入账号和密码' });

    // 先看这个 IP / 账号是不是刚被锁了
    const ip = clientIp(req);
    const lock = auth.loginLock(ip, username);
    if (lock.locked) {
      console.log(`[登录锁定] ${username} 来自 ${ip}，还需等待 ${lock.remainSec} 秒`);
      return sendJSON(res, 429, {
        error: `密码连续输错 ${auth.LOGIN_MAX_FAILS} 次，已临时锁定。请 ${Math.ceil(lock.remainSec / 60)} 分钟后再试`,
        locked: true, remainSec: lock.remainSec,
      });
    }

    const u = auth.getUserByName(username);
    // 不区分"账号不存在"和"密码错误"，避免被用来枚举账号
    if (!u || !auth.verifyPassword(password, u.password)) {
      const after = auth.recordLoginFail(ip, username);
      console.log(`[登录失败] ${username} 来自 ${ip}（剩余尝试 ${after.left} 次）`);
      return sendJSON(res, 401, {
        error: after.locked
          ? `密码连续输错 ${auth.LOGIN_MAX_FAILS} 次，已临时锁定 ${auth.LOGIN_LOCK_MIN} 分钟`
          : '账号或密码不正确',
        left: after.left, locked: !!after.locked, remainSec: after.remainSec || 0,
      });
    }
    if (u.status !== '启用') return sendJSON(res, 403, { error: '该账号已被停用，请联系管理员' });
    // 登录成功，清掉失败计数
    auth.clearLoginFails(ip, username);
    const s = auth.createSession(u, req);
    auth.markLogin(u.id);
    writeLog(req, 'login', null, u.id, u.name || u.username, null);
    console.log(`[登录] ${u.username}（${u.name || ''}）来自 ${ip}`);
    res.setHeader('Set-Cookie', auth.cookieHeader(s.token, auth.SESSION_DAYS * 86400));
    return sendJSON(res, 200, { ok: true, user: auth.publicUser(u) });
  }

  if (head === 'logout' && method === 'POST') {
    if (req.user) writeLog(req, 'logout', null, req.user.id, req.user.name || req.user.username, null);
    auth.destroySession(req);
    res.setHeader('Set-Cookie', auth.clearCookieHeader());
    return sendJSON(res, 200, { ok: true });
  }

  if (head === 'me' && method === 'GET') {
    return sendJSON(res, 200, {
      user: auth.publicUser(req.user),
      tables: TABLE_ORDER,
      sysKeys: auth.SYS_KEYS,
      settings: dbf.getSettings(),
      license: licenseNow(),
    });
  }

  // ---------------- 系统设置（界面自定义等） ----------------
  if (head === 'settings') {
    // 读：登录用户都能读（前端要拿它渲染欢迎语和标题）
    if (method === 'GET') {
      return sendJSON(res, 200, { settings: dbf.getSettings(), defaults: dbf.DEFAULT_SETTINGS, license: licenseNow() });
    }
    // 写：需要系统设置权限
    if (method === 'POST') {
      if (!guardSys(req, res, 'settings', '系统设置')) return;
      let body;
      try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      const patch = body.settings || body;
      const r = dbf.saveSettings(patch);
      if (r.error) return sendJSON(res, 400, r);
      writeLog(req, 'update', null, null, '修改系统设置',
        (r.saved || []).map(k => `${k}=${String(patch[k]).slice(0, 24)}`).join('；') || '无变化');
      // 必须回带最新的授权状态：前端粘贴授权码后要靠它给成功/失败反馈
      return sendJSON(res, 200, { ok: true, settings: r.settings, saved: r.saved, license: licenseNow() });
    }
  }

  if (head === 'me' && a === 'password' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const r = auth.changeOwnPassword(req.user, body.old, body.new);
    if (r.error) return sendJSON(res, 400, r);
    writeLog(req, 'update', null, req.user.id, req.user.name || req.user.username, '修改密码');
    return sendJSON(res, 200, r);
  }

  // ---------------- 账号管理 ----------------
  if (head === 'users') {
    if (!guardSys(req, res, 'users', '账号管理')) return;
    if (method === 'GET') return sendJSON(res, 200, {
      rows: auth.listUsers(),
      sysKeys: auth.SYS_KEYS,
      tables: TABLE_ORDER,
      loginGuard: auth.loginLockStats(),
      // 账号数上限：让界面能**提前**提示「已达上限」，而不是等用户填完表单才报错
      license: licenseNow(),
    });
    // 管理员一键解除登录锁定（同事连错密码把自己锁了，不用等 10 分钟）
    if (method === 'POST' && a === 'unlock') {
      let body = {};
      try { body = await readBody(req); } catch { /* 允许空体 */ }
      const n = body.all ? auth.clearAllLoginFails() : auth.clearLoginFails(body.ip || '', body.username || '');
      writeLog(req, 'update', null, null, body.all ? '解除全部登录锁定' : (body.username || body.ip || '解除登录锁定'), `清除 ${n} 条失败记录`);
      return sendJSON(res, 200, { ok: true, cleared: n });
    }
    if (method === 'POST' && a && b === 'delete') {
      const r = auth.deleteUser(a, req.user);
      if (r.error) return sendJSON(res, 400, r);
      const u = dbf.db.prepare('SELECT username FROM users WHERE id = ?').get(parseInt(a, 10));
      writeLog(req, 'delete', null, parseInt(a, 10), u ? u.username : '#' + a, '删除账号');
      return sendJSON(res, 200, r);
    }
    if (method === 'POST' && a && b === 'reset') {
      let body = {};
      try { body = await readBody(req); } catch { /* 允许空体 */ }
      const r = auth.resetPassword(a, body.password, true);
      if (r.error) return sendJSON(res, 400, r);
      writeLog(req, 'update', null, parseInt(a, 10), '#' + a, '重置密码');
      return sendJSON(res, 200, r);
    }
    if (method === 'POST') {
      let body;
      try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
      // 授权的账号数上限：只拦「新建」，改已有账号（改名/改权限/停用）一律放行。
      // 达上限就停手 —— 不能因为额度用完把客户锁在门外。
      if (!body.id && licenseNow().seatsExceeded) {
        return sendJSON(res, 400, {
          error: `已达到授权的账号数上限（${licenseNow().usedSeats} 个），不能再新建账号。`
            + '已有的账号可以继续正常使用。'
            + '需要增加账号请联系我方升级授权。',
          seatsExceeded: true,
        });
      }
      const r = auth.saveUser(body, req.user);
      if (r.error) return sendJSON(res, 400, r);
      writeLog(req, body.id ? 'update' : 'create', null, r.id, body.username, body.id ? '修改账号' : '新建账号');
      return sendJSON(res, 200, r);
    }
  }

  if (head === 'meta') {
    return sendJSON(res, 200, {
      app: APP_NAME, version: VERSION,
      tables: TABLES, order: TABLE_ORDER,
      options: dbf.refOptions(),
      dbFile: dbf.DB_FILE_SAFE,
      dataDir: dbf.DATA_DIR,
      port: PORT,
      lan: lanAddresses(),
      trashKeepDays: trash.KEEP_DAYS,
      upload: {
        maxMB: Math.round(MAX_UPLOAD / 1024 / 1024),
        accept: Array.from(attach.ALLOW_EXT).join(','),
        ocrExt: attach.OCR_EXT.slice(),
        attachDir: attach.ATTACH_DIR,
      },
      // ⚠️ 必须调用 ocrHealth()：require 时拿到的是**函数**本身，不是探测结果。
      //    直接读 ocrHealth.ok 会得到 undefined，表现为「识别功能不可用」
      //    的警告永远出现、/api/meta 里 ocr.ok 恒为空。
      ocr: (() => {
        const h = ocrHealth();
        return {
          ok: h.ok, engine: h.engine,
          label: h.label || h.reason || describeOcrBackend(),
          langs: h.langs, hint: h.hint,
        };
      })(),
    });
  }

  if (head === 'dashboard') {
    // 驾驶舱按权限过滤：看不到的模块，对应数字直接不返回
    if (!anyRead(req.user.perms)) return sendJSON(res, 403, { error: '没有查看经营总览的权限' });
    const d = dbf.dashboardFor(req.user.perms);
    d.totals.attachment_count = attach.stats().total;
    // 历史趋势（来自月度快照），没权限看钱就不给
    if (anyRead(req.user.perms)) {
      d.trend = snap.trend(12);
      d.mom = snap.mom();
    }
    return sendJSON(res, 200, d);
  }

  // 首页右侧栏「通知公告」：系统通知取最近的登录/备份/升级日志，
  // 公司公告 / 放假通知目前没有独立模块，先空着（前端会显示「暂无」），
  // 结构留好 —— 以后加公告表时直接往两个数组里塞就行。
  if (head === 'notices') {
    const sysRows = (() => {
      try { return logmod.list({ limit: 12 }).rows || []; } catch { return []; }
    })().filter(l => ['登录', '备份', '升级'].some(k => String(l.summary || '').includes(k)) === false)
      .slice(0, 5)
      .map(l => ({
        title: l.summary || l.action,
        tag: '三级', date: String(l.at || '').slice(0, 10), kind: 'sys',
      }));
    return sendJSON(res, 200, { company: [], holiday: [], system: sysRows });
  }

  // ---------------- 月度结账快照 ----------------
  if (head === 'snapshots') {
    if (!guardSys(req, res, 'settings', '数据快照')) return;
    if (method === 'GET' && !a) {
      return sendJSON(res, 200, { rows: snap.list(36), keepMonths: snap.KEEP_MONTHS, currentYm: dbf.today().slice(0, 7) });
    }
    if (method === 'POST' && a === 'capture') {
      let body = {};
      try { body = await readBody(req); } catch { /* 允许空体 */ }
      const ym = body.ym || dbf.today().slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) return sendJSON(res, 400, { error: '月份格式应为 YYYY-MM' });
      const r = snap.capture(ym, 'manual', body.note || '手动快照');
      writeLog(req, 'create', null, null, `快照 ${ym}`, '手动生成月度快照');
      return sendJSON(res, 200, r);
    }
    if (method === 'POST' && a && b === 'delete') {
      const r = snap.remove(a);
      writeLog(req, 'delete', null, null, `快照 ${a}`, null);
      return sendJSON(res, 200, r);
    }
    if (method === 'GET' && a) {
      const s = snap.get(a);
      if (!s) return sendJSON(res, 404, { error: '没有这个月的快照' });
      return sendJSON(res, 200, s);
    }
  }

  // ---------------- 数据安全：状态与备份 ----------------
  if (head === 'dbstatus') {
    // 顺带把数据库版本带上：客户报问题时让他截图这个就够了
    const migInfo = (() => {
      try {
        const m = require('./migrations.js');
        return { current: m.currentVersion(dbf.db), latest: m.LATEST, applied: m.applied(dbf.db) };
      } catch { return null }
    })();
    if (!guardSys(req, res, 'settings', '查看系统设置')) return;
    const fp = bk.dbFootprint();
    const counts = {};
    for (const t of TABLE_ORDER) counts[t] = dbf.db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    counts.attachments = dbf.db.prepare('SELECT COUNT(*) n FROM attachments').get().n;
    return sendJSON(res, 200, {
      dbFile: dbf.DB_FILE_SAFE,
      // 数据库版本：客户报问题时让他截图这个就够了（之前算好了却没放进响应，白算）
      dbVersion: migInfo ? migInfo.current : null,
      dbVersionLatest: migInfo ? migInfo.latest : null,
      migrations: migInfo ? migInfo.applied : [],
      footprint: fp,
      counts,
      attachments: attach.stats(),
      backups: bk.listBackups().slice(0, 8),
      backupDir: bk.BACKUP_DIR,
      lastBackup: bk.lastBackup(),
      // 备份格式要如实告诉用户：pg_dump 缺失时退化成 JSON，
      // 只看「备份成功」会让人以为结构也保住了。
      backupFormat: bk.backupFormatInfo(),
      // WAL / synchronous 是 SQLite 专有的 PRAGMA，PG 上根本没有这两个概念。
      // 以前是无条件执行，结果**整个「数据库状态」接口在 PG 模式下直接 500**
      // （syntax error at or near "PRAGMA"）—— 专业版客户点开这个页面就是一片报错。
      //
      // 注意：db-driver.js 并没有导出 isPg，写 dbf.isPg 会是 undefined（假值），
      // 那 PRAGMA 照样会执行 —— 这个坑我第一次改就踩了。用 dialect 判断才可靠。
      walMode: dbf.dialect === 'postgres' ? null : dbf.db.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: dbf.dialect === 'postgres' ? null : dbf.db.prepare('PRAGMA synchronous').get().synchronous,
      ocr: { queue: ocrQueue.length, running: ocrState.running, currentId: ocrState.currentId, done: ocrState.done, failed: ocrState.failed },
      loginGuard: { maxFails: auth.LOGIN_MAX_FAILS, lockMin: auth.LOGIN_LOCK_MIN, windowMin: auth.LOGIN_WINDOW_MIN, active: auth.loginLockStats() },
      uptimeSec: Math.round(process.uptime()),
    });
  }

  if (head === 'backup' && method === 'POST') {
    if (!guardSys(req, res, 'backup', '数据备份')) return;
    const r = bk.makeBackup();
    if (!r.ok) return sendJSON(res, 500, { error: r.error });
    console.log(`[备份] 已生成 ${r.file}（${(r.size / 1024).toFixed(1)} KB，格式 ${r.format}）`);
    writeLog(req, 'backup', null, null, r.file, `${(r.size / 1024).toFixed(1)} KB · ${r.format}`);
    return sendJSON(res, 200, r);
  }

  // 发票自动关联：把没填「对应发票」的收付款按项目+合同匹配上
  if (head === 'invoices' && a === 'backfill' && method === 'POST') {
    if (!guardTable(req, res, 'invoices', 'write')) return;
    const r = dbf.backfillInvoiceLinks();
    writeLog(req, 'update', 'invoices', null, `自动关联 ${r.linked} 笔`, `扫描 ${r.scanned} 笔未关联收付款`);
    return sendJSON(res, 200, { ok: true, ...r });
  }

  // ---------------- AI 助手 ----------------
  if (head === 'ai') {
    // 配置读取：普通成员只需要知道「能不能用」，厂商清单只发给有系统设置权限的人
    if (!a && method === 'GET') {
      return sendJSON(res, 200, { ...ai.publicConfig(req.user.perms), quick: ai.QUICK_PROMPTS });
    }

    // 保存配置（API 密钥只进不出，前端只会收到掩码）
    if (a === 'config' && method === 'POST') {
      if (!guardSys(req, res, 'settings', '系统设置')) return;
      let body;
      try { body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || '{}'); }
      catch { return sendJSON(res, 400, { error: '请求格式不对' }); }
      try {
        const saved = ai.saveConfig(body, req.user.perms);
        const p = ai.PROVIDERS[saved.provider] || {};
        writeLog(req, 'update', null, null, 'AI 助手配置',
          `${p.label || saved.provider} / ${saved.model}${saved.enabled ? '（已启用）' : '（未启用）'}`);
        return sendJSON(res, 200, { ok: true, ...saved });
      } catch (e) {
        return sendJSON(res, e.status || 400, { error: e.message });
      }
    }

    // 测试连接：支持「边填边测」，请求里带的配置只在本次生效，不落盘
    if (a === 'test' && method === 'POST') {
      if (!guardSys(req, res, 'settings', '系统设置')) return;
      let body;
      try { body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || '{}'); }
      catch { body = {}; }
      const override = {};
      for (const k of ['provider', 'baseUrl', 'model', 'apiKey']) {
        if (body[k] !== undefined && String(body[k]).trim() !== '') override[k] = String(body[k]).trim();
      }
      if (override.provider) {
        const p = ai.PROVIDERS[override.provider];
        if (p) {
          override.protocol = p.protocol;
          if (!override.baseUrl) override.baseUrl = p.baseUrl;
          if (!override.model) override.model = p.defaultModel;
        }
      }
      // 没带新密钥就用已保存的那把
      if (!override.apiKey) delete override.apiKey;
      try {
        return sendJSON(res, 200, await ai.testConnection(override));
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message });
      }
    }

    // 流式对话
    if (a === 'chat' && method === 'POST') {
      if (!anyRead(req.user.perms)) return deny(res, '没有查看任何模块的权限');
      let body;
      try { body = JSON.parse((await readRaw(req, 256 * 1024)).toString('utf8') || '{}'); }
      catch { return sendJSON(res, 400, { error: '请求格式不对' }); }

      const cfg = ai.publicConfig(req.user.perms);
      if (!cfg.ready) {
        return sendJSON(res, 400, {
          error: cfg.canEdit
            ? 'AI 助手还没配置好，请到「系统设置 → 智能助手」里选模型、填密钥并启用'
            : 'AI 助手还没配置好，请联系管理员在「系统设置」里配置',
        });
      }

      const rl = ai.rateCheck(req.user.id);
      if (!rl.ok) return sendJSON(res, 429, { error: `问得有点快，请等 ${rl.wait} 秒再试` });

      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      const push = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* 客户端已断开 */ } };
      push({ type: 'status', text: '正在整理经营数据…' });

      // 客户端关掉页面就中止上游请求，别白花 token
      const ac = new AbortController();
      req.on('close', () => ac.abort());

      try {
        const out = await ai.chatStream({
          messages: body.messages,
          question: body.question,
          perms: req.user.perms,
          signal: ac.signal,
          onContext: (c) => push({ type: 'status', text: `已带上 ${c.length} 字经营数据，正在思考…` }),
          onTool: (name, label) => push({ type: 'tool', name, label }),
          onProposal: (pp) => push({ type: 'proposal', prop: pp }),
          onDelta: (d) => push({ type: 'delta', text: d }),
        });
        push({ type: 'done', usage: out.usage || null, tools: out.usedTools || 0 });
        const tk = out.usage && (out.usage.total_tokens || out.usage.output_tokens);
        writeLog(req, 'ai', null, null, String(body.question || '').slice(0, 40),
          `${out.text.length} 字回复${tk ? `，${tk} tokens` : ''}${out.usedTools ? `，查了 ${out.usedTools} 次明细` : ''}`);
      } catch (e) {
        push({ type: 'error', error: e.message });
      }
      return res.end();
    }

    // 确认录入：AI 生成的方案，用户点确认后才真正落库
    if (a === 'apply' && method === 'POST') {
      if (!anyRead(req.user.perms)) return deny(res, '没有查看任何模块的权限');
      let body;
      try { body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || '{}'); }
      catch { return sendJSON(res, 400, { error: '请求格式不对' }); }
      const token = String(body.token || '');
      if (!token) return sendJSON(res, 400, { error: '缺少方案凭证' });
      // patch：用户在确认卡片上补充/修改的字段（比如选了个所属项目）
      const r = ai.applyProposal(token, req.user.perms, body.patch);
      if (r.error) return sendJSON(res, r.error.includes('权限') ? 403 : 400, r);
      writeLog(req, 'create', r.table, r.id, recordLabel(r.table, r.row), 'AI 助手录入（人工确认）');
      return sendJSON(res, 200, r);
    }

    // 单据进件：面板里传进来的图片 / PDF，识别完生成「待确认录入方案」
    //
    // 这里只负责「判断该录到哪张表」，判断逻辑在 tools/ingest.js（纯函数，可单测）。
    // 两条通道：
    //   ① 标准发票/合同 → 按字段直接映射，不花 token
    //   ② 认不出类型或置信度太低 → 把摘要交给模型判断（需管理员开启「AI 录入数据」）
    if (a === 'ingest' && method === 'POST') {
      if (!anyRead(req.user.perms)) return deny(res, '没有查看任何模块的权限');
      let body;
      try { body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || '{}'); }
      catch { return sendJSON(res, 400, { error: '请求格式不对' }); }

      const attId = parseInt(body.attachment_id, 10);
      if (!attId) return sendJSON(res, 400, { error: '缺少附件 id' });
      const row = attach.get(attId);
      if (!row) return sendJSON(res, 404, { error: '附件不存在' });
      // 只能给自己刚传上来的暂存件进件：别人的附件不受理（否则把别人的扫描件
      // 挂到自己记录上，就等于拿到了原件的读取权），已经挂到记录上的也不受理
      if (!req.user.perms.all && row.uploaded_by != null && Number(row.uploaded_by) !== Number(req.user.id)) {
        return sendJSON(res, 403, { error: '这不是你上传的附件' });
      }
      if (row.table_name) return sendJSON(res, 409, { error: '这个附件已经挂在别的记录上了，请到附件中心查看' });

      // 表格类文件不走识别，所以**必须排在识别状态判断之前** ——
      // 否则会走到"这种文件不做文字识别"那条分支，用户就看不懂该干嘛了。
      if (ingest.SHEET_EXT.has(String(row.ext || '').toLowerCase())) {
        const plan = ingest.planFromOcr({ ext: row.ext });
        // 顺便读一下表头，把目标表猜出来，用户少点一次（猜错也没关系，导入页能改）
        let headers = null;
        let rowCount = 0;
        try {
          const buf = fs.readFileSync(attach.absPathOf(row.stored_name));
          const t = tabular.readTable(buf, row.original_name);
          headers = t.headers || [];
          rowCount = (t.rows || []).length;
        } catch { /* .xls 之类读不了就只做引导，不猜表 */ }
        const guess = headers && headers.length ? ingest.guessSheetTable(headers) : null;
        return sendJSON(res, 200, {
          ok: true, action: 'import',
          table: guess ? guess.table : null,
          tableLabel: guess ? guess.label : null,
          headers: (headers || []).slice(0, 12),
          rowCount,
          message: plan.reason + (rowCount ? ` 这份表有 ${rowCount} 行数据。` : ''),
        });
      }

      // 识别还在跑：如实回状态，前端接着轮询（不强等，免得多占一个请求）
      if (row.ocr_status === 'pending' || row.ocr_status === 'running') {
        return sendJSON(res, 200, { ok: true, status: row.ocr_status });
      }
      if (row.ocr_status === 'failed') {
        return sendJSON(res, 400, { error: `识别失败：${row.ocr_error || '未知原因'}。可以到附件中心重试，或手工录入。` });
      }
      if (!row.ocr_fields) {
        return sendJSON(res, 200, {
          ok: true, action: 'none', attachmentId: row.id,
          message: `这种文件（${row.ext || '未知类型'}）不做文字识别，可以到附件中心直接归档。`,
        });
      }

      let ocr;
      try { ocr = JSON.parse(row.ocr_fields); } catch { return sendJSON(res, 400, { error: '识别结果已损坏，请重新识别' }); }

      const hint = String(body.hint || '').slice(0, 300);
      // 用户附言里提到项目名时先自己匹配一次 —— 比让模型猜准得多
      if (hint && !(ocr.suggest && ocr.suggest.project_id)) {
        const hit = matchProjects(hint);
        if (hit.length) {
          ocr.suggest = { ...(ocr.suggest || {}), project_id: hit[0].id, project_name: hit[0].name, project_score: hit[0].score };
        }
      }

      const projects = dbf.db.prepare('SELECT id, name FROM projects ORDER BY id').all();
      const partners = dbf.db.prepare('SELECT id, name FROM partners ORDER BY id').all();
      const refOptions = {
        projects: projects.map(p => ({ value: p.id, label: p.name })),
        partners: partners.map(p => ({ value: p.id, label: p.name })),
      };
      // 识别过程中的校验提示（金额大小写不一致之类）要带给用户，别让它们烂在库里
      const checks = (ocr.checks || [])
        .filter(c => c && c.level && c.level !== 'info' && c.text)
        .map(c => c.text).slice(0, 4);

      const buildProp = (tool, args, note, extraWarnings) => ai.proposeFromPlan(
        { tool, args }, req.user.perms,
        { attachIds: [row.id], refOptions, warnings: [...checks, ...extraWarnings], note },
      );

      /** 方案生成失败（权限、字段实在不够）也要让用户看到抽出来的字段，而不是一句报错 */
      const replyNone = (message, extra = {}) => sendJSON(res, 200, {
        ok: true, action: 'none', attachmentId: row.id,
        fields: ocr.fields || {}, hints: ocr.hints || {}, checks,
        message, ...extra,
      });
      const replyProp = (prop, plan, source) => {
        if (prop && prop.error) return replyNone(prop.error);
        writeLog(req, 'ai', null, null, String(row.original_name || '').slice(0, 40),
          `单据进件：识别为${plan.table || plan.tool}，生成待确认录入方案`);
        return sendJSON(res, 200, {
          ok: true, action: 'propose', source,
          proposal: prop, attachment: decorateAttachment(row),
        });
      };

      const plan = ingest.planFromOcr({ ocr, ext: row.ext, name: row.original_name });

      const cfg = ai.getConfig();
      const modelReady = !!(cfg.enabled && cfg.apiKey && cfg.baseUrl && cfg.model);

      // ---- 认出类型且置信度够：直接映射，不问模型 ----
      if (plan.action === 'propose') {
        return replyProp(buildProp(plan.tool, plan.args, '这是从你上传的原件里识别出来的录入方案。请核对，不对的地方可以直接在卡片上改。', []), plan, 'ingest');
      }

      // ---- 认不出类型 / 置信度太低：交给模型判断 ----
      const modelUsable = modelReady && cfg.allowWrite === true && anyWrite(req.user.perms);

      if (!modelUsable) {
        if (plan.args) {
          // 模型用不了（没配 / 没开「AI 录入数据」），确定性结果虽然弱，也好过什么都没有
          const w = [plan.confidence === undefined
            ? '识别置信度偏低，请逐项核对原件'
            : `识别置信度只有 ${plan.confidence}%，请逐项核对原件`];
          return replyProp(buildProp(plan.tool, plan.args, '识别置信度不高，我按最接近的模板填了一份，请对照原件核对。', w), plan, 'ingest-weak');
        }
        return replyNone(
          modelReady
            ? '这份文件我没认出是发票还是合同。让管理员在「系统设置 → 智能助手」里打开「AI 录入数据」，我就能判断它该录到哪张表。'
            : '这份文件我没认出是发票还是合同。到「系统设置 → 智能助手」接上大模型后，我就能判断它该录到哪张表。',
          { needModel: !modelReady, needAllowWrite: modelReady && cfg.allowWrite !== true },
        );
      }

      try {
        const summary = ingest.docSummary({ ocr, attachment: row, projects, partners, hint });
        const cls = await ai.classifyDocument({ summary, perms: req.user.perms, hint });
        if (cls.none) {
          return replyNone('这份文件看起来不是要录入系统的单据。'
            + (cls.text ? `模型说：${cls.text}` : ''), { modelSaid: cls.text || '' });
        }
        const table = ingest.TOOL_TABLE[cls.tool];
        const { args, dropped } = ingest.sanitizeArgs(table, cls.args, { projects, partners });
        return replyProp(
          buildProp(cls.tool, args, '这是让大模型看过原件后给出的录入方案。请核对，不对的地方可以直接在卡片上改。', dropped),
          { tool: cls.tool, table }, 'ai',
        );
      } catch (e) {
        // 模型这一路失败：有确定性兜底就用兜底，并如实说明
        if (plan.args) {
          const w = [`模型判断失败（${e.message}），已按识别结果填了一份，请核对`];
          return replyProp(buildProp(plan.tool, plan.args, '模型没判断成功，我按识别结果填了一份，请对照原件核对。', w), plan, 'ingest-weak');
        }
        return sendJSON(res, e.status || 502, { error: e.message });
      }
    }
    // 导出 Word 报告
    if (a === 'export' && method === 'POST') {
      if (!anyRead(req.user.perms)) return deny(res, '没有查看任何模块的权限');
      let body;
      try { body = JSON.parse((await readRaw(req, 512 * 1024)).toString('utf8') || '{}'); }
      catch { return sendJSON(res, 400, { error: '请求格式不对' }); }
      const answer = String(body.answer || '').trim();
      if (!answer) return sendJSON(res, 400, { error: '没有可导出的内容' });

      const cfg = ai.getConfig();
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

      // 附录放一份「分析所依据的数据」，报告才站得住脚
      let appendix = '';
      if (body.includeData !== false) {
        try { appendix = ai.buildContext(req.user.perms, String(body.question || '')); } catch { appendix = ''; }
      }

      let buf;
      try {
        buf = docx.buildDocx({
          title: String(body.title || '经营分析报告'),
          subtitle: `生成时间 ${stamp}`
            + (cfg.enabled && cfg.model ? ` · ${(ai.PROVIDERS[cfg.provider] || {}).label || cfg.provider} / ${cfg.model}` : '')
            + ` · 分析人 ${req.user.name || req.user.username}`,
          question: String(body.question || ''),
          answer,
          appendix,
        });
      } catch (e) {
        return sendJSON(res, 500, { error: '生成 Word 失败：' + e.message });
      }

      const fname = encodeURIComponent(`${String(body.title || '经营分析报告').replace(/[\\/:*?"<>|]/g, '')}_${stamp.replace(/[: ]/g, '-')}.docx`);
      writeLog(req, 'export', null, null, String(body.question || '').slice(0, 40), `导出 Word 报告（${(buf.length / 1024).toFixed(0)} KB）`);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="report.docx"; filename*=UTF-8''${fname}`,
      });
      return res.end(buf);
    }

    // 每日经营简报：缓存当天，同一天只生成一次
    if (a === 'briefing' && method === 'GET') {
      if (!anyRead(req.user.perms)) return deny(res, '没有查看任何模块的权限');
      try {
        return sendJSON(res, 200, await ai.getBriefing(req.user.perms, { force: q.refresh === '1' }));
      } catch (e) {
        return sendJSON(res, e.status || 500, { error: e.message });
      }
    }

    // 简报推送配置（注意要 !b：否则 /api/ai/push/test 会被这一块先吃掉）
    if (a === 'push' && !b) {
      if (method === 'GET') {
        if (!guardSys(req, res, 'settings', '系统设置')) return;
        const p = ai.getPushConfig();
        return sendJSON(res, 200, {
          ...p,
          types: Object.entries(ai.PUSH_TYPES).map(([k, v]) => ({ value: k, ...v })),
          today: dbf.today(),
        });
      }
      if (method === 'POST') {
        if (!guardSys(req, res, 'settings', '系统设置')) return;
        let body;
        try { body = JSON.parse((await readRaw(req, 64 * 1024)).toString('utf8') || '{}'); }
        catch { return sendJSON(res, 400, { error: '请求格式不对' }); }
        try {
          const saved = ai.savePushConfig(body, req.user.perms);
          writeLog(req, 'update', null, null, '简报推送设置',
            `${saved.enabled ? '已启用' : '未启用'}，每天 ${saved.time}，${saved.channels.length} 个渠道`);
          return sendJSON(res, 200, { ok: true, ...saved });
        } catch (e) {
          return sendJSON(res, e.status || 400, { error: e.message });
        }
      }
    }

    // 试推一次
    if (a === 'push' && b === 'test' && method === 'POST') {
      if (!guardSys(req, res, 'settings', '系统设置')) return;
      try {
        const r = await ai.pushNow(req.user.perms);
        writeLog(req, 'ai', null, null, '试推经营简报',
          r.results.map(x => `${x.label}:${x.ok ? '成功' : '失败'}`).join('、'));
        return sendJSON(res, 200, r);
      } catch (e) {
        return sendJSON(res, e.status || 502, { error: e.message });
      }
    }

    return sendJSON(res, 404, { error: '未知的 AI 接口' });
  }

  if (head === 'search') {
    // 全局搜索按各表权限过滤：没有查看权限的模块，搜到也不给看
    const hits = globalSearch(q.q).filter(h => {
      if (h.table === 'attachments') return anyRead(req.user.perms);
      return auth.canRead(req.user.perms, h.table);
    });
    return sendJSON(res, 200, { hits });
  }

  if (head === 'project' && a) {
    if (!guardTable(req, res, 'projects', 'read')) return;
    const d = dbf.projectDetail(a);
    if (!d) return sendJSON(res, 404, { error: '项目不存在' });
    const att = attach.list({ project_id: a });
    d.attachments = att.rows.map(r => decorateAttachment(r));
    d.attachment_total = att.total;
    return sendJSON(res, 200, d);
  }

  // 按合同付款条款生成收付款计划节点
  if (head === 'contract' && a && b === 'plan' && method === 'POST') {
    if (!guardTable(req, res, 'contracts', 'write')) return;
    let body = {};
    try { body = await readBody(req); } catch { /* 允许空体 */ }
    if (body.preview) {
      const c = dbf.db.prepare('SELECT * FROM contracts WHERE id = ?').get(parseInt(a, 10));
      if (!c) return sendJSON(res, 404, { error: '合同不存在' });
      const { parsePaymentTerms } = require('./tools/extract.js');
      const p = parsePaymentTerms(c.payment_terms || '');
      return sendJSON(res, 200, {
        ok: true, preview: true,
        contract: { id: c.id, name: c.name, amount: dbf.round2(c.amount), direction: c.direction, terms: c.payment_terms },
        nodes: p.nodes, sum: p.sum, amountWan: p.amountWan,
        existing: dbf.db.prepare('SELECT COUNT(*) n FROM schedules WHERE contract_id = ?').get(c.id).n,
      });
    }
    const r = dbf.generatePlan(a, { force: !!body.force });
    if (r.error) return sendJSON(res, 400, r);
    console.log(`[计划] 合同#${a} 生成 ${r.created} 个收付款计划节点`);
    const cName = (dbf.db.prepare('SELECT name FROM contracts WHERE id = ?').get(parseInt(a, 10)) || {}).name;
    writeLog(req, 'create', 'schedules', null,
      `${r.created} 个计划节点${cName ? '（' + cName + '）' : ''}`, `由合同付款条款自动生成`);
    return sendJSON(res, 200, r);
  }

  if (head === 'list' && a) {
    if (!guardTable(req, res, a, 'read')) return;
    if (!TABLES[a]) return sendJSON(res, 404, { error: '未知数据表' });
    const data = dbf.listRows(a, q);
    // 每行带上附件数量，列表页显示回形针
    const counts = attach.countsFor(a, data.rows.map(r => r.id));
    for (const r of data.rows) r.attach_count = counts[r.id] || 0;
    data.with_attachments = data.rows.filter(r => r.attach_count > 0).length;
    return sendJSON(res, 200, { table: a, ...data });
  }

  if (head === 'record-attachments' && a && b) {
    if (!guardTable(req, res, a, 'read')) return;
    if (!TABLES[a]) return sendJSON(res, 404, { error: '未知数据表' });
    const r = attach.list({ table_name: a, record_id: b });
    return sendJSON(res, 200, { ...r, rows: r.rows.map(r => decorateAttachment(r)) });
  }

  if (head === 'export' && a) {
    if (!guardTable(req, res, a, 'read')) return;
    if (!TABLES[a]) return sendJSON(res, 404, { error: '未知数据表' });
    const data = dbf.listRows(a, { ...q, limit: 0, offset: 0 });
    const csv = toCSV(a, data);
    const fname = encodeURIComponent(`${TABLES[a].label}_${dbf.today()}.csv`);
    const buf = Buffer.from(csv, 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Length': buf.length,
      'Content-Disposition': `attachment; filename="${fname}"; filename*=UTF-8''${fname}`,
    });
    return res.end(buf);
  }

  // ---------------- 附件与识别 ----------------
  // 附件访问权：管理员任意看；普通用户对附件所属的表有查看权限即可。
  // 暂存附件（还没挂到记录上）**属于上传者自己**。
  function canSeeAttachment (row) {
    if (!row) return false;
    if (req.user.perms.all) return true;
    // 暂存 / 已解除关联：没有归属表可以判权限，按上传者隔离。
    // 这里原来是不管三七二十一 `return true` —— 等于公司里谁都能翻到别人传的
    // 发票原图（票面含税号、开户行、银行账号）。平时偶尔传一份还不显眼，
    // 一旦"随手把发票丢给 AI 助手"成为习惯，这就是个持续的数据泄漏口子。
    // uploaded_by 为空的是升级前的老数据，无法归属，只能继续放行（暂存件 7 天后自动清理）。
    if (!row.table_name) {
      return row.uploaded_by === null || row.uploaded_by === undefined
        || Number(row.uploaded_by) === Number(req.user.id);
    }
    return auth.canRead(req.user.perms, row.table_name);
  }

  if (head === 'upload' && method === 'POST') {
    const ct = req.headers['content-type'] || '';
    const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct);
    if (!bm) return sendJSON(res, 400, { error: '上传请求格式不正确（需要 multipart/form-data）' });
    let buf;
    try {
      buf = await readRaw(req, MAX_UPLOAD);
    } catch (e) {
      return sendJSON(res, e.code === 'TOOBIG' ? 413 : 400, { error: e.message });
    }
    const parts = parseMultipart(buf, (bm[1] || bm[2]).trim());
    let filePart = null;
    const fields = {};
    for (const p of parts) {
      if (p.headers.filename !== undefined) filePart = p;
      else if (p.headers.name) fields[p.headers.name] = p.data.toString('utf8');
    }
    if (!filePart || !filePart.headers.filename) return sendJSON(res, 400, { error: '没有收到文件' });
    if (!filePart.data.length) return sendJSON(res, 400, { error: '文件内容为空' });

    const tableName = fields.table_name && TABLES[fields.table_name] ? fields.table_name : null;
    // 直接往某张表的记录上传附件 = 写操作，必须先有该表的写权限；暂存（不带表）放行
    if (tableName && !auth.canWrite(req.user.perms, tableName)) {
      return sendJSON(res, 403, { error: `没有上传到「${TABLES[tableName].label}」的权限` });
    }
    let row;
    try {
      row = attach.add({
        buffer: filePart.data,
        originalName: filePart.headers.filename,
        tableName,
        recordId: fields.record_id ? parseInt(fields.record_id, 10) : null,
        token: fields.token || null,
        category: fields.category || null,
        projectId: fields.project_id ? parseInt(fields.project_id, 10) : null,
        uploadedBy: req.user.id,
      });
    } catch (e) {
      return sendJSON(res, 400, { error: e.message });
    }
    if (attach.isOcrExt(row.ext)) queueOcr(row.id);
    return sendJSON(res, 200, { ok: true, attachment: decorateAttachment(attach.get(row.id)) });
  }

  if (head === 'file' && a) {
    const row = attach.get(a);
    if (!row) return sendJSON(res, 404, { error: '附件不存在' });
    if (!canSeeAttachment(row)) return sendJSON(res, 403, { error: '没有查看这个附件所属模块的权限' });
    let abs;
    try { abs = attach.absPathOf(row.stored_name); } catch { return sendJSON(res, 400, { error: '非法路径' }); }
    if (!fs.existsSync(abs)) return sendJSON(res, 404, { error: '文件已丢失（可能被手工删除）' });
    const st = fs.statSync(abs);
    const fname = encodeURIComponent(row.original_name || 'file');
    const inline = q.inline === '1';
    res.writeHead(200, {
      'Content-Type': row.mime || 'application/octet-stream',
      'Content-Length': st.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${fname}"; filename*=UTF-8''${fname}`,
      'Cache-Control': 'private, max-age=3600',
    });
    return fs.createReadStream(abs).pipe(res);
  }

  if (head === 'attachments') {
    if (!a && method === 'GET') {
      const data = attach.list(q);
      // 按权限过滤：只能看到自己有查看权的模块的附件
      const rows = data.rows.filter(r => canSeeAttachment(r));
      return sendJSON(res, 200, { ...data, rows: rows.map(r => decorateAttachment(r)), total: rows.length });
    }
    if (a === 'stats' && method === 'GET') {
      return sendJSON(res, 200, { ...attach.stats(), queue: ocrQueue.length, running: ocrState.running, currentId: ocrState.currentId });
    }
    if (a && b === 'delete' && method === 'POST') {
      const row = attach.get(a);
      if (!row) return sendJSON(res, 404, { error: '附件不存在' });
      // 删除比查看严：要么管理员，要么对该附件所属表有写权限
      if (!req.user.perms.all && row.table_name && !auth.canWrite(req.user.perms, row.table_name)) {
        return sendJSON(res, 403, { error: '没有删除这个附件的权限' });
      }
      const r = attach.remove(a);
      writeLog(req, 'delete', null, parseInt(a, 10), row.original_name, '删除附件');
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (a && b === 'recognize' && method === 'POST') {
      const row = attach.get(a);
      if (!row) return sendJSON(res, 404, { error: '附件不存在' });
      if (!canSeeAttachment(row)) return sendJSON(res, 403, { error: '没有查看这个附件所属模块的权限' });
      if (!attach.isOcrExt(row.ext)) return sendJSON(res, 400, { error: `该类型（${row.ext}）不支持识别` });
      queueOcr(row.id);
      return sendJSON(res, 200, { ok: true, status: 'pending' });
    }
    // 新建了往来单位 / 项目之后，重新跑一遍自动关联（让"未匹配"变成"已匹配"）
    if (a && b === 'rematch' && method === 'POST') {
      const row = attach.get(a);
      if (!row) return sendJSON(res, 404, { error: '附件不存在' });
      if (!canSeeAttachment(row)) return sendJSON(res, 403, { error: '没有查看这个附件所属模块的权限' });
      if (!row.ocr_fields) return sendJSON(res, 409, { error: '这个附件还没有识别结果' });
      let payload;
      try { payload = JSON.parse(row.ocr_fields); } catch { return sendJSON(res, 400, { error: '识别结果已损坏，请重新识别' }); }
      const { parties, suggest } = buildSuggestions(payload);
      payload.parties = parties;
      payload.suggest = suggest;
      attach.update(a, { ocr_fields: JSON.stringify(payload) });
      return sendJSON(res, 200, decorateAttachment(attach.get(a)));
    }
    // 单条查询：这条要带上识别原文（前端「查看识别原文」用）
    if (a && !b && method === 'GET') {
      const row = attach.get(a);
      if (!row) return sendJSON(res, 404, { error: '附件不存在' });
      if (!canSeeAttachment(row)) return sendJSON(res, 403, { error: '没有查看这个附件所属模块的权限' });
      return sendJSON(res, 200, decorateAttachment(row, true));
    }
  }

  // ---------------- 批量导入 ----------------
  if (head === 'import') {
    if (!guardSys(req, res, 'import', '数据导入')) return;
    if (a === 'meta' && method === 'GET') {
      return sendJSON(res, 200, {
        tables: importer.importMeta(),
        maxMB: Math.round(MAX_UPLOAD / 1024 / 1024),
        accept: '.csv,.xlsx,.xlsm',
        order: ['partners', 'projects', 'contracts', 'schedules', 'payments', 'invoices', 'materials'],
      });
    }
    if (a === 'template' && b && TABLES[b]) {
      const csv = importer.buildTemplate(b);
      const fname = encodeURIComponent(`${TABLES[b].label}_导入模板.csv`);
      const buf = Buffer.from(csv, 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Length': buf.length,
        'Content-Disposition': `attachment; filename="${fname}"; filename*=UTF-8''${fname}`,
      });
      return res.end(buf);
    }
    if (a && TABLES[a] && method === 'POST') {
      const bm = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] || '');
      if (!bm) return sendJSON(res, 400, { error: '请以表单方式上传文件' });
      let buf;
      try { buf = await readRaw(req, MAX_UPLOAD); }
      catch (e) { return sendJSON(res, e.code === 'TOOBIG' ? 413 : 400, { error: e.message }); }
      const parts = parseMultipart(buf, (bm[1] || bm[2]).trim());
      const filePart = parts.find(p => p.headers.filename !== undefined);
      if (!filePart) return sendJSON(res, 400, { error: '没有收到文件' });
      let parsed;
      try {
        parsed = tabular.readTable(filePart.data, filePart.headers.filename);
      } catch (e) {
        return sendJSON(res, 400, { error: e.message });
      }
      const table = a;
      const label = TABLES[table].label;
      let autoCreate = false;
      for (const p of parts) {
        if (p.headers.name === 'auto_create_partners') autoCreate = p.data.toString('utf8') === '1';
      }
      const out = importer.runImport(table, parsed.headers, parsed.rows, {
        preview: q.preview === '1',
        autoCreatePartners: autoCreate,
      });
      if (!out.ok) return sendJSON(res, 400, out);
      if (q.preview !== '1') {
        console.log(`[导入] ${label}：成功 ${out.inserted} 条，跳过 ${out.skipped} 条${out.unknownHeaders.length ? '，忽略列 ' + out.unknownHeaders.join('/') : ''}`);
        writeLog(req, 'import', table, null, `${out.inserted} 条`, `${parsed.kind} 文件，跳过 ${out.skipped} 条`);
      }
      return sendJSON(res, 200, { ...out, kind: parsed.kind, totalRows: parsed.rows.length, label, headers: parsed.headers });
    }
  }

  // 批量删除（列表页勾选后使用）
  if (head === 'batch-delete' && method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    const table = body.table;
    if (!guardTable(req, res, table, 'write')) return;
    if (!TABLES[table]) return sendJSON(res, 404, { error: '未知数据表' });
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(x => parseInt(x, 10)).filter(Boolean);
    if (!ids.length) return sendJSON(res, 400, { error: '没有选中任何记录' });

    // 附件数量一并统计，让确认提示更完整
    const attCount = table === 'projects'
      ? ids.reduce((s, id) => s + attach.countForProject(id), 0)
      : ids.reduce((s, id) => s + attach.list({ table_name: table, record_id: id }).total, 0);

    // 只探测、不改数据：前端据此弹出"确认删除 + 是否连附件一起删"
    if (body.dryRun) {
      const dry = dbf.batchDelete(table, ids, { dryRun: true });
      if (dry.error) return sendJSON(res, 400, dry);
      const deps = Object.assign({}, dry.dependents || {});
      if (attCount) deps.attachments = attCount;
      return sendJSON(res, 200, {
        ok: true, dryRun: true, dependents: deps,
        affected: dry.affected, total: dry.total,
        hasDeps: Object.keys(deps).length > 0,
      });
    }

    if (!body.cascade) {
      // 注意：这里必须用 dryRun，否则"检查阶段"就把数据删掉了
      const dry = dbf.batchDelete(table, ids, { dryRun: true });
      if (dry.error) return sendJSON(res, 400, dry);
      if (dry.needConfirm || attCount) {
        const deps = Object.assign({}, dry.dependents || {});
        if (attCount) deps.attachments = attCount;
        return sendJSON(res, 409, {
          error: '选中的记录存在关联数据，请确认后删除',
          needConfirm: true,
          dependents: deps,
          affected: dry.affected,
          total: dry.total,
        });
      }
    }

    // 先做快照存进回收站（30 天内可还原）
    let trashId = null;
    try {
      const label = ids.map(id => recordLabel(a, dbf.db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id))).filter(Boolean).join('、').slice(0, 80);
      const payload = trash.capture(table, ids);
      trashId = trash.push(table, ids, payload, operatorOf(req), label);
    } catch (e) { console.log('[回收站] 快照失败：' + e.message); }

    // 附件必须在删业务数据之前处理：子记录删掉后就找不到挂在它们身上的附件了
    const keep = !!body.keepAttachments;
    let removedFiles = 0;
    for (const id of ids) {
      try {
        if (keep) removedFiles += table === 'projects' ? attach.detachForProject(id) : attach.detachForRecord(table, id);
        else removedFiles += table === 'projects' ? attach.removeForProject(id) : attach.removeForRecord(table, id);
      } catch { /* 单个失败不影响整体 */ }
    }

    const r = dbf.batchDelete(table, ids, { cascade: true });
    if (r.error) return sendJSON(res, 400, r);
    writeLog(req, 'batch_delete', table, null, `${ids.length} 条`, keep ? `保留附件 ${removedFiles} 个` : `含附件 ${removedFiles} 个`);
    console.log(`[批量删除] ${TABLES[table].label}：${r.deleted} 条，${keep ? '保留' : '删除'}附件 ${removedFiles} 个`);
    return sendJSON(res, 200, { ...r, removedFiles, keptAttachments: keep, trashId });
  }

  if (head === 'get' && a && b) {
    if (!guardTable(req, res, a, 'read')) return;
    if (!TABLES[a]) return sendJSON(res, 404, { error: '未知数据表' });
    const row = dbf.getRow(a, b);
    if (!row) return sendJSON(res, 404, { error: '记录不存在' });
    return sendJSON(res, 200, row);
  }

  if (head === 'save' && a && method === 'POST') {
    if (!guardTable(req, res, a, 'write')) return;
    if (!TABLES[a]) return sendJSON(res, 404, { error: '未知数据表' });
    let body;
    try { body = await readBody(req); } catch (e) { return sendJSON(res, 400, { error: e.message }); }
    // 表单里上传的暂存附件：保存后自动挂到这条记录上
    const attachToken = body.__attach_token || null;
    delete body.__attach_token;
    // 识别后"新建合同/发票并填入"时，直接把附件挂到新记录上
    const attachIds = Array.isArray(body.__attach_ids) ? body.__attach_ids : [];
    delete body.__attach_ids;
    // 项目台账表单里的「收入合同额」快捷录入：填了顺便建/更新这个项目的主合同。
    // 金额的唯一来源仍然是合同表，这里只是把「建项目 + 录金额」合成一步。
    const mainContract = a === 'projects' && body._main_contract !== undefined && body._main_contract !== ''
      ? Number(body._main_contract) : null;
    delete body._main_contract;
    const id = body.id ? parseInt(body.id, 10) : 0;
    const before = id ? dbf.db.prepare(`SELECT * FROM ${a} WHERE id = ?`).get(id) : null;
    const r = id ? dbf.updateRow(a, id, body) : dbf.insertRow(a, body);
    if (r.error) return sendJSON(res, 400, r);

    // 快捷录金额。必须再查一次合同写权限，不能让「能改项目」变成「能改合同」。
    let note = null;
    if (mainContract !== null && Number.isFinite(mainContract) && mainContract > 0) {
      if (!auth.canWrite(req.user.perms, 'contracts')) {
        note = '项目已保存。但没有编辑「合同管理」的权限，合同金额没录进去，请联系管理员。';
      } else {
        try {
          const row = dbf.db.prepare(`SELECT * FROM ${a} WHERE id = ?`).get(r.id) || {};
          const existing = dbf.db.prepare(
            "SELECT id, amount FROM contracts WHERE project_id = ? AND direction = 'in' ORDER BY id").all(r.id);
          if (existing.length === 0) {
            const cr = dbf.insertRow('contracts', {
              project_id: r.id,
              direction: 'in',
              name: (row.name || '项目') + ' 主合同',
              category: '项目合同',
              amount: mainContract,
              partner_id: row.client_id || null,
              sign_date: row.start_date || dbf.today(),
              status: '执行中',
            });
            if (cr.error) {
              note = '项目已保存，但主合同没建成：' + cr.error;
            } else {
              note = `项目已保存，并自动建了一份主合同（${(mainContract / 10000).toFixed(1)} 万元）。`
                + '分包、采购等支出合同请到「合同管理」里录。';
              writeLog(req, 'create', 'contracts', cr.id, (row.name || '') + ' 主合同', '由项目台账自动创建');
            }
          } else if (existing.length === 1) {
            if (Number(existing[0].amount) !== mainContract) {
              dbf.updateRow('contracts', existing[0].id, { amount: mainContract });
              note = `主合同金额已更新为 ${(mainContract / 10000).toFixed(1)} 万元。`;
              writeLog(req, 'update', 'contracts', existing[0].id, (row.name || '') + ' 主合同',
                `金额 ${Number(existing[0].amount)} → ${mainContract}（由项目台账修改）`);
            }
          } else {
            note = `项目已保存。这个项目已经有 ${existing.length} 份收入合同，`
              + '金额请到「合同管理」里逐份修改，这里没有动它们。';
          }
        } catch (e) {
          note = '项目已保存，但处理合同金额时出错：' + e.message;
        }
      }
    }

    let linked = 0;
    if (attachToken) linked += attach.linkByToken(attachToken, a, r.id);
    if (attachIds.length) linked += attach.linkIds(attachIds, a, r.id);
    const after = dbf.db.prepare(`SELECT * FROM ${a} WHERE id = ?`).get(r.id);
    const label = recordLabel(a, after);
    if (id) {
      const diff = logmod.diffFields(a, before, after);
      if (diff) writeLog(req, 'update', a, r.id, label, diff);
    } else {
      writeLog(req, 'create', a, r.id, label, null);
    }
    const atts = attach.list({ table_name: a, record_id: r.id });
    return sendJSON(res, 200, { ok: true, id: r.id, row: dbf.getRow(a, r.id), linkedAttachments: linked, attachments: atts.rows.map(r => decorateAttachment(r)), note });
  }

  if (head === 'delete' && a && b && method === 'POST') {
    if (!guardTable(req, res, a, 'write')) return;
    if (!TABLES[a]) return sendJSON(res, 404, { error: '未知数据表' });
    let body = {};
    try { body = await readBody(req); } catch { /* 允许空体 */ }
    const deps = dbf.dependents(a, b);
    const attCount = a === 'projects' ? attach.countForProject(b) : attach.list({ table_name: a, record_id: b }).total;
    if (attCount) deps.attachments = attCount;
    const blockers = Object.entries(deps).filter(([, n]) => n > 0);
    if (blockers.length && !body.cascade) {
      return sendJSON(res, 409, {
        error: '存在关联数据，请确认后删除',
        needConfirm: true,
        dependents: Object.fromEntries(blockers),
      });
    }
    // 附件必须先于业务数据处理：子记录删掉后就找不到挂在它们身上的附件了。
    // keepAttachments=1 表示只删记录、把扫描件留在附件库里（解除关联，不会被自动清理）
    const keep = !!body.keepAttachments;
    const numId = parseInt(b, 10);
    const label = recordLabel(a, dbf.db.prepare(`SELECT * FROM ${a} WHERE id = ?`).get(numId));

    // 先做快照存进回收站（30 天内可还原）
    let trashId = null;
    try {
      const payload = trash.capture(a, [numId]);
      trashId = trash.push(a, [numId], payload, operatorOf(req), label);
    } catch (e) { console.log('[回收站] 快照失败：' + e.message); }

    let removedAttachments = 0;
    if (keep) {
      removedAttachments = a === 'projects' ? attach.detachForProject(b) : attach.detachForRecord(a, b);
    } else {
      removedAttachments = a === 'projects' ? attach.removeForProject(b) : attach.removeForRecord(a, b);
    }
    const r = blockers.length ? dbf.deleteCascade(a, b) : dbf.deleteRow(a, b);
    if (r.error) return sendJSON(res, 400, r);
    writeLog(req, 'delete', a, numId, label, keep ? '保留附件' : `含附件 ${removedAttachments} 个`);
    return sendJSON(res, 200, { ok: true, removedAttachments, keptAttachments: keep, trashId });
  }

  // ---------------- 回收站 ----------------
  if (head === 'trash') {
    if (!guardSys(req, res, 'trash', '回收站')) return;
    if (!a && method === 'GET') {
      return sendJSON(res, 200, { rows: trash.list(200), stats: trash.stats() });
    }
    if (a === 'purge-all' && method === 'POST') {
      const r = trash.purgeAll();
      writeLog(req, 'purge', null, null, '清空回收站', `彻底删除 ${r.purged} 项`);
      return sendJSON(res, 200, r);
    }
    if (a && b === 'restore' && method === 'POST') {
      const entry = trash.get(a);
      const r = trash.restore(a);
      if (r.error) return sendJSON(res, 400, r);
      writeLog(req, 'restore', entry ? entry.table_name : null, null, entry ? entry.label : null, `还原 ${r.restored} 条`);
      console.log(`[回收站] 已还原 ${r.restored} 条（${entry ? entry.label : '#' + a}）`);
      return sendJSON(res, 200, r);
    }
    if (a && b === 'purge' && method === 'POST') {
      const entry = trash.get(a);
      const r = trash.purge(a);
      if (r.error) return sendJSON(res, 400, r);
      writeLog(req, 'purge', entry ? entry.table_name : null, null, entry ? entry.label : null, null);
      return sendJSON(res, 200, r);
    }
  }

  // ---------------- 操作日志 ----------------
  if (head === 'logs' && method === 'GET') {
    if (!guardSys(req, res, 'logs', '操作日志')) return;
    return sendJSON(res, 200, { ...logmod.list(q), stats: logmod.stats() });
  }
  if (head === 'logs' && a === 'purge' && method === 'POST') {
    if (!guardSys(req, res, 'logs', '操作日志')) return;
    let body = {};
    try { body = await readBody(req); } catch { /* 允许空体 */ }
    const n = logmod.purge(body.days || 365);
    return sendJSON(res, 200, { ok: true, purged: n });
  }

  // ---------------- 对账单数据 ----------------
  if (head === 'statement' && a && method === 'GET') {
    if (!guardTable(req, res, 'projects', 'read')) return;
    const d = dbf.projectDetail(a);
    if (!d) return sendJSON(res, 404, { error: '项目不存在' });
    const client = d.project.client_id
      ? dbf.db.prepare('SELECT * FROM partners WHERE id = ?').get(d.project.client_id)
      : null;
    return sendJSON(res, 200, {
      project: d.project,
      client,
      contracts: d.contracts,
      payments: d.payments,
      invoices: d.invoices,
      schedules: d.schedules,
      stats: d.stats,
      generatedAt: dbf.nowISO(),
    });
  }

  // 补写示例数据（用户清空后想再看示例、或测试套件需要基线数据时用）
  if (head === 'demo' && a === 'seed' && method === 'POST') {
    if (!guardSys(req, res, 'settings', '系统设置')) return;
    // 清空 + 重建包在一个事务里做完：以前分两次调用，中间有极短空窗，
    // 并发请求会读到「示例数据全没了」（实测偶发把 materials 读成 0）。
    const r = dbf.reseedDemo();
    const removed = (r && r.removed) || {};
    return sendJSON(res, 200, { ok: true, removed, ...r });
  }

  if (head === 'demo' && a === 'clear' && method === 'POST') {
    if (!req.user.perms.all) return sendJSON(res, 403, { error: '只有管理员可以清空示例数据' });
    return sendJSON(res, 200, { ok: true, removed: dbf.clearDemo() });
  }

  return sendJSON(res, 404, { error: '接口不存在: ' + url.pathname });
}

function serveStatic (req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(abs, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ---------------- 启动 ----------------
function lanAddresses () {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('Bad Request'); }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  if (url.pathname.startsWith('/api/')) {
    // 免登录接口：健康检查与登录本身
    const OPEN = new Set(['/api/health', '/api/login']);
    if (!OPEN.has(url.pathname)) {
      let user = null;
      // Cookie 值损坏等情况绝不能让请求挂死（异常 = 不带身份继续走 401）
      try { user = auth.fromRequest(req); } catch (e) { console.log('[会话解析失败]', e.message); }
      // 未登录时也带上品牌信息：登录页要显示系统名称，不能等登录后才渲染
      if (!user) return sendJSON(res, 401, { error: '请先登录', needLogin: true, firstRun: auth.firstRunPending(), settings: publicSettings() });
      req.user = user;

      // 授权过期 → 只读：数据一条不删，但不能再录入。
      // 这几个必须放行，否则客户连续费都做不了：
      //   粘贴新授权码 / 改密码 / 备份数据 / 退出登录
      // 注意：这里在分发层，method 是 handleApi 里的局部变量（L477），这里要用 req.method
      if (req.method.toUpperCase() === 'POST' && licenseNow().readOnly) {
        const ALLOW = new Set(['/api/settings', '/api/me/password', '/api/logout', '/api/backup', '/api/login']);
        if (!ALLOW.has(url.pathname)) {
          return sendJSON(res, 403, {
            error: '授权已到期，当前为只读模式（数据都在，可以查看和导出）。在「系统设置 → 授权」里填入新的授权码即可继续录入。',
            licenseExpired: true,
          });
        }
      }
    }
    Promise.resolve()
      .then(() => handleApi(req, res, url))
      .catch(e => {
        console.error('[API 错误]', e);
        if (!res.headersSent) sendJSON(res, 500, { error: e.message || '服务器内部错误' });
      });
    return;
  }
  serveStatic(req, res, url);
});

const seedResult = dbf.init();

  // 网络版：.env 里配了公司名 / 初始密码就写进去，客户打开即看到自己的名字。
  // 只在**库是新建的**时候写，不覆盖客户后来在界面上改过的值。
  try {
    if (!seedResult.existed) {
      const patch = {};
      if (process.env.PMS_COMPANY_NAME) {
        patch.company_name = process.env.PMS_COMPANY_NAME;
        patch.system_name = process.env.PMS_COMPANY_NAME + '工程项目管理系统';
      }
      if (Object.keys(patch).length) dbf.saveSettings(patch);
      if (process.env.PMS_ADMIN_PASSWORD) {
        const u = auth.getUserByName('admin');
        if (u) auth.resetPassword(u.id, process.env.PMS_ADMIN_PASSWORD, false);
      }

      // AI 助手的默认配置也从 .env 读。
      //
      // 注意 AI 的配置**不在 settings 表里**，而是存在 data/ai-config.json
      // （ai.js 自己管的），所以这里走 saveConfig 而不是 saveSettings。
      //
      // 需求里点名要「是否开启AI助手默认配置」这一项，之前完全没接，
      // 客户装完得自己进界面开。现在 .env 里写一行就行。
      if (process.env.PMS_AI_ENABLED !== undefined || process.env.PMS_AI_API_KEY) {
        const aiPatch = {};
        if (process.env.PMS_AI_ENABLED !== undefined) {
          aiPatch.enabled = String(process.env.PMS_AI_ENABLED).toLowerCase() !== 'false'
            && String(process.env.PMS_AI_ENABLED) !== '0';
        }
        if (process.env.PMS_AI_PROVIDER) aiPatch.provider = process.env.PMS_AI_PROVIDER;
        if (process.env.PMS_AI_API_KEY) aiPatch.apiKey = process.env.PMS_AI_API_KEY;
        if (process.env.PMS_AI_MODEL) aiPatch.model = process.env.PMS_AI_MODEL;
        ai.saveConfig(aiPatch, null);
        console.log('  [初始配置] 已按 .env 设置 AI 助手'
          + (aiPatch.enabled === undefined ? '' : (aiPatch.enabled ? '（开启）' : '（关闭）')));
      }
    }
  } catch (e) { console.log('  [初始配置] 写入失败：' + e.message); }
attach.ensureDir();
attach.createTable();
trash.createTable();
logmod.createTable();
auth.createTable();
snap.createTable();

// 统一补 tenant_id：迁移 v4 对「比自己晚建的表」是空转的（logs / snapshots / trash 等
// 都会漏），所以必须在**所有模块建完表之后**统一收口补一次。幂等，单机模式无影响。
const tenantColsAdded = require("./tenant.js").ensureColumns();
if (tenantColsAdded.length) console.log("  [多租户] 已补 tenant_id 列：" + tenantColsAdded.join(", "));
// 首次启动自动创建管理员账号
const adminInit = auth.ensureAdmin();
// 清理过期会话
const sessionsPurged = auth.purgeExpired();

// 启动清理：删掉超过 7 天仍未归属任何记录的暂存附件
const purged = attach.purgeOrphans(7);
// 回收站只保留 30 天，过期自动彻底删除（连附件文件）
const trashPurged = trash.autoPurge(trash.KEEP_DAYS);
// 上个月还没结账快照的话，补记一份（用于事后看趋势）
const snapMade = snap.ensureMonthly();
// 断点续跑：上次没跑完的识别任务重新入队
for (const r of attach.list({ status: 'pending' }).rows) queueOcr(r.id);
for (const r of attach.list({ status: 'running' }).rows) queueOcr(r.id);

// 启动时如果今天还没备份过，自动备一份（防止误删/误操作）
let autoBackup = null;
if (!bk.hasBackupToday()) autoBackup = bk.makeBackup('auto');

server.listen(PORT, HOST, () => {
  const ips = lanAddresses();
  const line = '='.repeat(58);
  console.log(line);
  console.log('  ' + APP_NAME + '  v' + VERSION);
  console.log(line);
  console.log('  本机访问:   http://127.0.0.1:' + PORT);
  for (const ip of ips) console.log('  同事访问:   http://' + ip + ':' + PORT + '   (同一局域网)');
  console.log('  数据库:     ' + dbf.DB_FILE);
  console.log('  附件目录:   ' + attach.ATTACH_DIR);
  console.log('  备份目录:   ' + bk.BACKUP_DIR + (autoBackup && autoBackup.ok ? '  (今日已自动备份)' : ''));
  // 同上：ocrHealth 是函数，要调用才有结果。
  {
    const h = ocrHealth();
    console.log('  识别引擎:   ' + (h.label || h.reason || describeOcrBackend() || '未知') + '，支持 PDF / 图片');
    if (!h.ok) console.log('               ⚠ ' + (h.hint || '识别功能不可用，请检查引擎安装'));
  }
  // 写入模式只在 SQLite 下有意义 —— PG 有自己的 WAL 和崩溃恢复机制，
// 照抄这句话会让人以为 PG 也在用 synchronous=FULL（其实那是 SQLite 的 PRAGMA）。
console.log('  写入模式:   ' + (dbf.dialect === 'postgres'
    ? 'PostgreSQL（服务端 WAL + 崩溃恢复由数据库负责）'
    : 'WAL + synchronous=FULL（掉电/强杀不丢数据）'));
  if (adminInit.created) {
    console.log('');
    console.log('  ┌────────────────────────────────────────────────────┐');
    console.log('  │  首次启动，已创建管理员账号：                      │');
    console.log('  │      账号： admin                                  │');
    console.log('  │      密码： admin123                               │');
    console.log('  │  登录后会要求你立刻改成自己的密码。                │');
    console.log('  └────────────────────────────────────────────────────┘');
    console.log('');
  }
  if (sessionsPurged) console.log('  已清理 ' + sessionsPurged + ' 个过期登录会话');
  if (purged) console.log('  已清理 ' + purged + ' 个无归属的暂存附件');
  if (trashPurged.purged) console.log('  回收站：已清理超过 ' + trash.KEEP_DAYS + ' 天的 ' + trashPurged.purged + ' 项');
  const ts = trash.stats();
  if (ts.entries) console.log('  回收站：现有 ' + ts.entries + ' 项（' + ts.rows + ' 条数据），' + trash.KEEP_DAYS + ' 天内可还原');
  if (snapMade) console.log('  月度快照：已补记 ' + snapMade + ' 的经营数据（用于看趋势）');
  if (seedResult.swept && Object.keys(seedResult.swept).length) {
    const detail = Object.entries(seedResult.swept).map(([k, v]) => k + ' ' + v).join('、');
    console.log('  数据自检：已清理孤儿数据（' + detail + '）');
  }
  if (seedResult.seeded) console.log('  已写入示例数据（项目编号以 DEMO- 开头，可在“系统设置”一键清空）');
  if (seedResult.counts) {
    const c = seedResult.counts;
    const total = Object.values(c).reduce((a, b) => a + b, 0);
    console.log('  当前数据:   项目 ' + c.projects + ' · 合同 ' + c.contracts + ' · 收付款 ' + c.payments +
      ' · 发票 ' + c.invoices + ' · 费用 ' + c.expenses + ' · 材料 ' + c.materials + ' · 单位 ' + c.partners);
    // 老库却是空的：这不是正常状态，明确警告而不是悄悄补示例数据
    if (seedResult.existed && c.projects === 0 && total === 0) {
      console.log('  ⚠️  警告: 数据库里一条业务数据都没有。若非你主动清空，请立即到「系统设置」查看备份，');
      console.log('      或从 backup 目录复制一份 .db 文件回 data 目录恢复。');
    }
    try {
      const audit = require('node:path').join(dbf.DATA_DIR, 'startup.log');
      require('node:fs').appendFileSync(audit,
        `${dbf.nowISO()}  项目${c.projects} 合同${c.contracts} 收付款${c.payments} 发票${c.invoices} 费用${c.expenses} 材料${c.materials} 单位${c.partners} 售后${c.maintenance}\n`);
    } catch { /* 忽略 */ }
  }
  console.log(line);
  console.log('  关闭本窗口即停止服务。');
});

// 每 15 分钟做一次 PASSIVE checkpoint，避免 WAL 一直增长（不影响读写）
setInterval(() => { dbf.checkpoint('PASSIVE'); }, 15 * 60 * 1000).unref();

server.on('error', e => {
  if (e.code === 'EADDRINUSE') {
    console.error(`\n[错误] 端口 ${PORT} 已被占用。请改用其它端口，例如：node server.js --port 8899\n`);
  } else {
    console.error('[错误]', e.message);
  }
  process.exit(1);
});

// 优雅退出：先把 WAL 落盘并关闭连接，再退出。正常关窗口不会丢任何数据。
let shuttingDown = false;
function shutdown (sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n收到 ${sig}，正在保存数据…`);
  try { server.close(); } catch { /* 忽略 */ }
  try { dbf.closeDb(); } catch (e) { console.error('关闭数据库出错：' + e.message); }
  console.log('数据已保存，服务停止。');
  process.exit(0);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  process.on(sig, () => shutdown(sig));
}
process.on('uncaughtException', e => {
  console.error('[未捕获异常]', e);
  try { dbf.checkpoint('FULL'); } catch { /* 忽略 */ }
});

/* ---------------- 后台定时任务 ---------------- */

// 每日经营简报推送：每 10 分钟看一次到点没有（靠 lastSent 保证一天只发一次）
let pushBusy = false;
setInterval(async () => {
  if (pushBusy) return;                     // 上次还没跑完就跳过
  pushBusy = true;
  try {
    const r = await ai.maybePushDaily();
    if (r.sent) {
      const ok = r.results.filter(x => x.ok).length;
      console.log(`[推送] ${r.day} 经营简报已推送到 ${ok}/${r.results.length} 个渠道`);
      for (const x of r.results.filter(y => !y.ok)) console.log(`[推送] ${x.label} 失败：${x.error}`);
    }
  } catch (e) {
    console.error('[推送] 出错：' + e.message);
  } finally {
    pushBusy = false;
  }
}, 10 * 60 * 1000).unref?.();

// 简报缓存清理：每天清一次超过 60 天的
setInterval(() => {
  try { ai.pruneBriefings(60) } catch { /* 忽略 */ }
}, 24 * 60 * 60 * 1000).unref?.();

// 启动后 30 秒先看一眼（服务刚起来时如果已经过了推送时间，当天补推）
setTimeout(async () => {
  try { await ai.maybePushDaily() } catch { /* 忽略 */ }
}, 30000).unref?.();

// ---------------- 多租户实验性警告 ----------------
// 隔离只覆盖了核心读写路径，统计/附件/日志/回收站/各模块 SQL 都还没有。
// 这种情况下打开多租户，不同租户之间反而会互相看到数据 —— 比不开更糟。
// 所以启动时必须**主动、显眼**地警告，不能只写在 .env 注释里等人去翻。
if (require('./tenant.js').isMultiTenant()) {
  console.log('');
  console.log('  ' + '!'.repeat(62));
  console.log('  !! 警告：MULTI_TENANT=1 是【实验性】功能，请勿用于生产 !!');
  console.log('  !!');
  console.log('  !! 隔离目前只覆盖：列表 / 单条读取 / 新增 / 修改 / 删除');
  console.log('  !! 尚未隔离：首页统计、附件、操作日志、回收站、快照、');
  console.log('  !!           对账单、账龄、批量导入导出');
  console.log('  !!');
  console.log('  !! 在补齐之前，不同租户之间会互相看到数据 —— 比不开多租户更危险。');
  console.log('  !! 私有化部署请把 MULTI_TENANT 去掉或设为 0。');
  console.log('  ' + '!'.repeat(62));
  console.log('');
}
// ---------------- 操作日志保留期清理 ----------------
// 保留多久由「系统设置」里的 log_retention_days 决定（0 = 永久保留）。
// 启动后 1 分钟跑一次，之后每天一次。
function sweepLogs () {
  try {
    const days = Number(dbf.getSettings().log_retention_days);
    if (!days || days <= 0) return;
    const n = logs.purge(days);
    if (n) console.log(`[日志] 已清理 ${n} 条超过 ${days} 天的操作日志`);
  } catch (e) { console.log('[日志] 清理失败：' + e.message); }
}
setTimeout(sweepLogs, 60 * 1000).unref?.();
setInterval(sweepLogs, 24 * 60 * 60 * 1000).unref?.();
