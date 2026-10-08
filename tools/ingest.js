'use strict';
/**
 * 单据进件：把「识别结果」翻译成「待确认录入方案」
 *
 * 用途：用户在 AI 助手面板里甩一张发票/合同/收据的图片或 PDF 进来，
 * 系统识别完要回答一个问题 —— **这份东西该录到哪张表、每个字段填什么**。
 * 答案就是这里产出的「录入参数」，交给 ai.proposeWrite() 变成待确认方案，
 * 用户点确认才落库（见 ai.js 的 stashProposal / applyProposal）。
 *
 * 为什么单独一个文件：
 *   这段映射是纯函数（不碰库、不碰网络），可以脱离 HTTP 与识别引擎单测 ——
 *   而它恰好是整条链路里最容易错的地方（字段名对不对、金额口径对不对）。
 *
 * 两条通道（对应两种可信度）：
 *   ① 确定性：识别出 kind=invoice/contract 且置信度够 → 直接按字段映射，不花 token、可复现
 *   ② 交给模型：认不出类型（收据、对账单、送货单…）或置信度太低时，
 *      把「结构化字段 + 截断摘要」交给大模型判断该录哪张表（见 ai.classifyDocument）
 *
 * ⚠️ 摘要只带字段和截断文本，绝不把整份识别原文（几万字）发给模型。
 */

const { TABLES } = require('../schema.js');

/** 表格类文件不走单据进件，引导去「批量导入」（那里有字段映射 + 预览，不做第二套） */
const SHEET_EXT = new Set(['.xlsx', '.xls', '.xlsm', '.csv']);

/** 进件可能用到的写入工具 → 目标表（必须与 ai.js 的 WRITE_TOOLS 一致） */
const TOOL_TABLE = {
  create_invoice: 'invoices',
  create_contract: 'contracts',
  create_payment: 'payments',
  create_expense: 'expenses',
  create_project: 'projects',
};

/** 识别出的类型 → 默认走哪个写入工具 */
const KIND_TOOL = { invoice: 'create_invoice', contract: 'create_contract' };

/** 置信度低于这个值就别硬套模板了，先问问模型 */
const WEAK_CONFIDENCE = 40;

// ---------------- 取值小工具 ----------------

/** 金额/数字字符串 → 数字（识别结果里常带千分位、¥、%、单位） */
function num (v) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(String(v).replace(/[,，\s¥￥元%％]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}

/** 文本清洗：折叠空白 + 限长（OCR 出来的值可能带一串换行） */
function text (v, max = 200) {
  if (v === undefined || v === null) return undefined;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : undefined;
}

/** schema 的 options 支持 ['a','b'] 与 [{value,label}] 两种写法 */
function optList (options) {
  return (options || []).map(o => (typeof o === 'string'
    ? { value: o, label: o }
    : { value: o.value, label: o.label || o.value }));
}

const isBlank = v => v === undefined || v === null || v === '';

// ---------------- ① 确定性通道：发票 / 合同 ----------------

/**
 * 发票：识别字段 → create_invoice 参数
 *
 * 口径提醒（很容易搞错）：invoices.amount 是**不含税**金额，
 * total_amount 是价税合计。识别结果里 amount 也是不含税，可以直接透传。
 */
function invoiceArgs (ocr) {
  const f = (ocr && ocr.fields) || {};
  const s = (ocr && ocr.suggest) || {};
  const h = (ocr && ocr.hints) || {};
  const a = {};
  const put = (k, v) => { if (!isBlank(v)) a[k] = v; };

  put('invoice_no', text(f.invoice_no, 40));
  put('issue_date', text(f.issue_date, 20));
  put('invoice_type', text(f.invoice_type, 40));
  if (s.direction === 'in' || s.direction === 'out') a.direction = s.direction;
  put('amount', num(f.amount) !== undefined ? num(f.amount) : num(f.amount_ex_tax));
  put('tax_rate', num(f.tax_rate));
  put('tax_amount', num(f.tax_amount));
  put('total_amount', num(f.total_amount));
  // partner 传 id：buildSuggestions 已经匹配过，传 id 不会再被模糊匹配歪掉
  put('partner', s.partner_id);
  put('remark', text(h.remark, 200));
  put('project', text(s.project_name, 120));
  return a;
}

/** 合同：识别字段 → create_contract 参数 */
function contractArgs (ocr) {
  const f = (ocr && ocr.fields) || {};
  const s = (ocr && ocr.suggest) || {};
  const a = {};
  const put = (k, v) => { if (!isBlank(v)) a[k] = v; };

  put('name', text(f.name, 160));
  put('code', text(f.code, 60));
  put('sign_date', text(f.sign_date, 20));
  put('payment_terms', text(f.payment_terms, 300));
  put('category', text(f.category, 40));
  put('amount', num(f.amount));
  if (s.direction === 'in' || s.direction === 'out') a.direction = s.direction;
  put('partner', s.partner_id);
  put('project', text(s.project_name, 120));

  // 识别不出合同名时给个能用的（不然「合同名称」必填挡着，用户还得自己想一个）
  if (!a.name) {
    const who = text((ocr.hints || {}).project_text, 40);
    const part = [who, a.sign_date].filter(Boolean).join(' ');
    if (part) a.name = text(part + ' 合同', 160);
  }
  return a;
}

// ---------------- ② 交给模型：摘要 ----------------

/**
 * 给大模型看的「单据摘要」—— 只带结构化字段和一小段文本。
 *
 * 为什么要截断：一张发票的识别原文可以有几万字，整份发过去既慢又贵，
 * 而模型判断「这是不是该录进发票表」只需要字段 + 抬头 + 一点上下文。
 */
function docSummary ({ ocr, attachment, projects, partners, hint } = {}) {
  const o = ocr || {};
  const f = o.fields || {};
  const s = o.suggest || {};
  const h = o.hints || {};
  const L = [];

  L.push('文件名：' + ((attachment && attachment.original_name) || '未知'));
  L.push(`识别类型：${o.kind || 'unknown'}，置信度 ${o.confidence === undefined ? '未知' : o.confidence + '%'}`
    + `，字段 ${o.fieldCount || 0}/${o.expectedCount || 0}`);

  const fieldLines = Object.entries(f)
    .filter(([k, v]) => !k.endsWith('_value') && !isBlank(v))
    .map(([k, v]) => `  ${k}: ${String(v).slice(0, 120)}`);
  if (fieldLines.length) L.push('识别到的字段：\n' + fieldLines.join('\n'));

  const parties = (o.parties || []).map(p => `  ${p.label || p.role}：${p.name}`).join('\n');
  if (parties) L.push('甲乙方：\n' + parties);

  const hints = Object.entries(h).filter(([, v]) => !isBlank(v)).map(([k, v]) => `  ${k}: ${String(v).slice(0, 160)}`);
  if (hints.length) L.push('其他线索：\n' + hints.join('\n'));

  if (s.project_name) L.push(`已匹配到系统里的项目：${s.project_name}（id=${s.project_id}）`);
  if (s.partner_role) L.push(`单位匹配建议：${s.partner_role}（id=${s.partner_id}）`);

  // 文本片段：只给头 700 字（抬头、票号、金额都在最前面）
  const excerpt = String(o.normalized || '').replace(/\s+/g, ' ').trim().slice(0, 700);
  if (excerpt) L.push('文本片段（已截断）：\n' + excerpt);

  if (projects && projects.length) {
    L.push('系统里的项目（录单据必须挂到其中一个）：\n'
      + projects.slice(0, 60).map(p => `  ${p.id}: ${p.name}`).join('\n'));
  }
  if (partners && partners.length) {
    L.push('系统里的往来单位（可选）：\n'
      + partners.slice(0, 60).map(p => `  ${p.id}: ${p.name}`).join('\n'));
  }
  if (hint) L.push('用户附言（优先采信）：' + String(hint).slice(0, 300));

  return L.join('\n');
}

// ---------------- 缺字段 / 可编辑字段 ----------------

/**
 * 必填但没填的字段（要弹给用户补）。
 *
 * 不是简单查 schema.required —— 有些必填字段后端会派生出来：
 *   发票：给了价税合计（total_amount）时，不含税金额（amount）由 db.applyDerived 反算，
 *         这时不该再让用户手填一遍 amount。
 */
function missingRequired (table, fields) {
  const def = TABLES[table];
  if (!def) return [];
  const f = fields || {};
  const out = [];
  for (const fd of def.fields) {
    if (!fd.required || fd.virtual || fd.calc) continue;
    if (!isBlank(f[fd.name])) continue;
    if (table === 'invoices' && fd.name === 'amount' && num(f.total_amount) > 0) continue;
    out.push({ name: fd.name, label: fd.label, kind: fd.type, refTable: fd.refTable || null });
  }
  return out;
}

/**
 * 可编辑字段说明：告诉前端这些字段能在确认卡片上直接改（下拉/输入框）。
 *
 * @param {object} refOptions { projects: [{value,label}], partners: [...] }
 *        下拉选项由调用方查库给出 —— 这里保持纯函数，不碰数据库。
 */
function buildEditable (table, fieldNames, refOptions = {}) {
  const def = TABLES[table];
  if (!def || !fieldNames || !fieldNames.length) return {};
  const byName = Object.fromEntries(def.fields.map(f => [f.name, f]));
  const out = {};
  for (const name of fieldNames) {
    const fd = byName[name];
    if (!fd) continue;
    if (fd.type === 'ref') {
      out[name] = { label: fd.label, kind: 'select', options: refOptions[fd.refTable] || [] };
    } else if (fd.type === 'select') {
      out[name] = { label: fd.label, kind: 'select', options: optList(fd.options) };
    } else {
      out[name] = { label: fd.label, kind: fd.type === 'money' || fd.type === 'number' ? 'number' : 'text' };
    }
  }
  return out;
}

// ---------------- 表格：猜目标表 ----------------

/**
 * 按表头猜这份表格该导到哪张表。
 *
 * 刻意复用导入模块自己的表头映射（import.js 的 mapHeaders）：别名表只有一份，
 * 猜出来的目标表必须和**真正导入时的判定**一致 —— 否则会出现"猜的是发票、
 * 导进去一片未识别"这种自相矛盾，比不猜还糟。
 * 评分：命中列数 ×2 − 未识别列数（命中越多越好，陌生列越少越好）。
 * 拿不到导入模块时退回按字段名简单匹配（保持这个文件在纯函数单测里能独立跑）。
 */
function guessSheetTable (headers) {
  const cols = (headers || []).map(h => String(h === null || h === undefined ? '' : h).trim()).filter(Boolean);
  if (!cols.length) return null;

  try {
    const imp = require('../import.js');
    let best = null;
    for (const t of imp.importMeta()) {
      const { cols: mapped, unknown } = imp.mapHeaders(t.table, cols);
      const hit = mapped.filter(Boolean).length;
      if (hit < 2) continue;                     // 只对上 1 列基本等于没认出来
      const score = hit * 2 - unknown.length;
      if (!best || score > best.score) {
        best = { table: t.table, label: t.label, score, hit, unknown: unknown.length };
      }
    }
    if (best) return best;
  } catch { /* 下面走简单匹配 */ }

  let best = null;
  for (const [name, def] of Object.entries(TABLES)) {
    let score = 0;
    for (const fd of def.fields) {
      if (fd.virtual || fd.calc) continue;
      const label = String(fd.label || '').replace(/[\s\u3000（）()*:：%/]/g, '').toLowerCase();
      const fname = String(fd.name || '').toLowerCase();
      for (const c of cols) {
        const cc = c.replace(/[\s\u3000（）()*:：%/]/g, '').toLowerCase();
        if (cc === label || cc === fname) score += 3;
        else if (label && Math.min(cc.length, label.length) >= 2 && (cc.includes(label) || label.includes(cc))) score += 1;
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { table: name, label: def.label, score };
  }
  return best;
}

// ---------------- 清洗模型给的参数 ----------------

/**
 * 清洗「模型给的录入参数」。
 *
 * 模型有三类常见毛病，必须在这里拦住，否则会变成用户看不懂的报错或脏数据：
 *   1. 编一个系统里不存在的项目名 → proposeWrite 的 findProject 会直接返回错误，
 *      整份方案就废了（其他字段明明是对的）。这里丢掉项目，让用户在下拉里选。
 *   2. 金额写成 "1,234.00 元" / "约 12 万" → Number() 得到 NaN。NaN 进库前会被
 *      校验拦下，但那时缺字段提示又算不出它是空的，用户就卡死了。
 *   3. 塞进这张表没有的列名 → 一律忽略。
 *
 * @returns {{ args: object, dropped: string[] }} dropped 是要说给用户听的理由
 */
function sanitizeArgs (table, args, opts = {}) {
  const def = TABLES[table];
  const out = {};
  const dropped = [];
  if (!def) return { args: out, dropped };
  const byName = Object.fromEntries(def.fields.map(f => [f.name, f]));
  const projects = opts.projects || [];

  for (const [k, v] of Object.entries(args || {})) {
    if (v === undefined || v === null || v === '') continue;

    // 项目不是表字段，是 proposeWrite 的参数（可以给名字或 id）
    if (k === 'project') {
      const s = String(v).trim();
      if (!s) continue;
      if (projects.some(p => String(p.id) === s || String(p.name) === s)) { out.project = s; continue; }
      const hit = projects.find(p => String(p.name).includes(s) || s.includes(String(p.name)));
      if (hit) { out.project = hit.name; continue; }
      dropped.push(`提到的项目「${s}」在系统里没有，请在下面选一个`);
      continue;
    }

    const fd = byName[k];
    if (!fd || fd.virtual) continue;

    if (fd.type === 'money' || fd.type === 'number' || fd.type === 'percent') {
      const n = num(v);
      if (n === undefined) {
        dropped.push(`「${fd.label}」识别到的值「${String(v).slice(0, 20)}」不是有效数字，已忽略`);
        continue;
      }
      out[k] = n;
      continue;
    }
    out[k] = typeof v === 'string' ? text(v, 300) : v;
  }
  return { args: out, dropped };
}

// ---------------- 对外入口 ----------------

/**
 * 主入口：识别结果 → 进件计划
 *
 * @returns {{
 *   action: 'propose'|'model'|'import'|'none',
 *   tool?: string, args?: object,   // action=propose
 *   weak?: boolean,                 // 确定性通道但置信度低（建议再问一次模型）
 *   reason?: string,                // action=import/none 的原因说明
 *   table?: string,
 * }}
 */
function planFromOcr ({ ocr, ext, name } = {}) {
  const e = String(ext || '').toLowerCase();

  // 表格：引导去批量导入
  if (SHEET_EXT.has(e)) {
    return {
      action: 'import',
      reason: '这是一份表格文件，用「批量导入」比逐条录入快得多（还能先预览再导）。',
      table: guessSheetTable((ocr && ocr.sheetHeaders) || [])?.table || null,
    };
  }

  const o = ocr || {};
  const tool = KIND_TOOL[o.kind];
  const expected = o.expectedCount || 0;
  const got = o.fieldCount || 0;
  const confidence = o.confidence === undefined ? (expected ? Math.round(got / expected * 100) : 0) : o.confidence;

  // 认不出类型 → 交给模型
  if (!tool) return { action: 'model', reason: '没能判断这是哪类单据' };

  const args = o.kind === 'invoice' ? invoiceArgs(o) : contractArgs(o);
  const table = TOOL_TABLE[tool];

  // 置信度太低（比如收据被当成了发票）→ 先让模型看一眼，模型不在再用确定性结果兜底
  if (confidence < WEAK_CONFIDENCE) {
    return { action: 'model', tool, args, table, weak: true, confidence, reason: `识别置信度只有 ${confidence}%` };
  }

  return { action: 'propose', tool, table, args, confidence };
}

module.exports = {
  SHEET_EXT, TOOL_TABLE, KIND_TOOL, WEAK_CONFIDENCE,
  num, text, optList, isBlank,
  invoiceArgs, contractArgs,
  docSummary, missingRequired, buildEditable, guessSheetTable,
  sanitizeArgs, planFromOcr,
};
