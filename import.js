'use strict';
/**
 * 批量导入：把 Excel/CSV 里的历史台账导入系统
 *  - 表头按「字段中文名 / 字段英文名 / 常用别名」匹配
 *  - 外键列填名称即可（所属项目填项目名、对方单位填单位名），自动解析成 id；找不到会明确报错
 *  - 日期支持 2026-03-05 / 2026/3/5 / 2026年3月5日 / 20260305 / Excel 日期序列号
 */
const { TABLES, TABLE_ORDER } = require('./schema.js');
const dbf = require('./db.js');
const { excelSerialToDate } = require('./tools/tabular.js');

// 常用别名（用户自己的叫法）
const ALIASES = {
  projects: {
    '项目': 'name', '工程名称': 'name', '工程': 'name',
    '甲方': 'client_id', '甲方单位': 'client_id', '建设单位': 'client_id', '业主': 'client_id',
    '子系统': 'category', '系统类别': 'category', '专业': 'category',
    '状态': 'status', '项目状态': 'status', '进度': 'progress', '完工进度': 'progress',
    '负责人': 'manager', '项目经理': 'manager', '地点': 'location', '工程地点': 'location',
    '开工日期': 'start_date', '竣工日期': 'end_date', '备注': 'remark',
  },
  contracts: {
    '合同名': 'name', '合同名称': 'name',
    '所属项目': 'project_id', '项目': 'project_id', '项目名称': 'project_id',
    '对方单位': 'partner_id', '乙方': 'partner_id', '甲方': 'partner_id', '供应商': 'partner_id', '单位': 'partner_id',
    '合同金额': 'amount', '合同额': 'amount', '金额': 'amount', '含税金额': 'amount',
    '类别': 'category', '收支': 'direction', '收支方向': 'direction', '方向': 'direction',
    '签订日期': 'sign_date', '签约日期': 'sign_date', '付款条款': 'payment_terms', '付款方式': 'payment_terms',
    '开始日期': 'start_date', '结束日期': 'end_date', '合同状态': 'status',
  },
  payments: {
    '项目': 'project_id', '项目名称': 'project_id', '所属项目': 'project_id',
    '合同': 'contract_id', '合同名称': 'contract_id', '关联合同': 'contract_id',
    '收付': 'direction', '方向': 'direction', '收支方向': 'direction', '类型': 'direction',
    '金额': 'amount', '发生日期': 'pay_date', '日期': 'pay_date', '付款日期': 'pay_date', '收款日期': 'pay_date',
    '方式': 'method', '结算方式': 'method', '款项性质': 'kind', '性质': 'kind',
    '凭证号': 'voucher_no', '流水号': 'voucher_no', '凭证': 'voucher_no', '备注': 'remark',
  },
  invoices: {
    '项目': 'project_id', '项目名称': 'project_id', '所属项目': 'project_id',
    '合同': 'contract_id', '合同名称': 'contract_id', '关联合同': 'contract_id',
    '单位': 'partner_id', '对方单位': 'partner_id', '客户': 'partner_id', '供应商': 'partner_id',
    '销项进项': 'direction', '方向': 'direction', '销项': 'direction',
    '种类': 'invoice_type', '发票种类': 'invoice_type', '票种': 'invoice_type',
    '发票号': 'invoice_no', '号码': 'invoice_no', '开票日期': 'issue_date', '开票年月': 'issue_date',
    '不含税金额': 'amount', '金额': 'amount', '税率': 'tax_rate', '状态': 'status', '备注': 'remark',
  },
  materials: {
    '项目': 'project_id', '项目名称': 'project_id', '所属项目': 'project_id',
    '合同': 'contract_id', '采购合同': 'contract_id', '关联采购合同': 'contract_id',
    '类别': 'category', '分类': 'category', '名称': 'name', '设备名称': 'name', '材料名称': 'name',
    '品牌': 'brand', '厂家': 'brand', '型号': 'model', '规格': 'spec', '规格参数': 'spec',
    '单位': 'unit', '数量': 'quantity', '单价': 'unit_price',
    '供应商': 'supplier_id', '供货商': 'supplier_id', '状态': 'status', '采购状态': 'status', '备注': 'remark',
  },
  schedules: {
    '项目': 'project_id', '项目名称': 'project_id', '所属项目': 'project_id',
    '合同': 'contract_id', '合同名称': 'contract_id', '关联合同': 'contract_id',
    '收付': 'direction', '方向': 'direction', '节点': 'phase', '节点名称': 'phase', '款项性质': 'phase',
    '比例': 'ratio', '占合同比例': 'ratio', '计划金额': 'amount', '金额': 'amount',
    '计划日期': 'due_date', '日期': 'due_date', '触发条件': 'basis', '备注': 'remark',
  },
  partners: {
    '单位': 'name', '名称': 'name', '单位名称': 'name', '公司名称': 'name',
    '类型': 'type', '单位类型': 'type', '简称': 'short_name', '联系人': 'contact', '电话': 'phone',
    '联系电话': 'phone', '手机': 'phone', '税号': 'tax_no', '纳税人识别号': 'tax_no',
    '开户行': 'bank', '银行': 'bank', '账号': 'account', '银行账号': 'account',
    '地址': 'address', '单位地址': 'address', '备注': 'remark',
  },
};

const REF_LOOKUP = {
  partners: ['name', 'short_name'],
  projects: ['name', 'code'],
  contracts: ['name', 'code'],
  // 收付款上的「对应发票」用发票号来匹配
  invoices: ['invoice_no'],
};

const VIRTUAL_SKIP = new Set(['amount_ex_tax', 'tax_amount', 'total_amount', 'paid_amount', 'remaining', 'state']);

const norm = s => String(s == null ? '' : s)
  .replace(/[\s\u3000（）()【】\[\]{}:：*、,，.。]/g, '')
  .toLowerCase();

/** 该表可导入的字段（排除虚拟列和自动计算列） */
function importableFields (table) {
  return TABLES[table].fields.filter(f => !f.virtual && !(f.calc && VIRTUAL_SKIP.has(f.name)));
}

// ---------------- 表头映射 ----------------
function buildHeaderMap (table) {
  const exact = new Map();
  const base = new Map();
  for (const f of importableFields(table)) {
    exact.set(norm(f.label), f.name);
    exact.set(norm(f.name), f.name);
    const b = norm(f.label).replace(/\(.*?\)/g, '').replace(/[（(].*$/g, '');
    if (b && !base.has(b)) base.set(b, f.name);
  }
  for (const [alias, field] of Object.entries(ALIASES[table] || {})) {
    exact.set(norm(alias), field);
    const b = norm(alias);
    if (b && !base.has(b)) base.set(b, field);
  }
  return { exact, base };
}

function mapHeaders (table, headers) {
  const { exact, base } = buildHeaderMap(table);
  const cols = [];
  const unknown = [];
  for (const h of headers) {
    const k = norm(h);
    let name = exact.get(k);
    if (!name) name = base.get(k.replace(/\(.*?\)/g, '').replace(/[（(].*$/g, ''));
    if (!name && k) {
      // 宽松匹配：表头包含字段名 或 字段名包含表头
      for (const [kk, vv] of base) {
        if (kk && (k.includes(kk) || kk.includes(k)) && Math.min(k.length, kk.length) >= 2) { name = vv; break; }
      }
    }
    cols.push(name || null);
    if (!name && String(h).trim()) unknown.push(String(h).trim());
  }
  return { cols, unknown };
}

// ---------------- 外键解析 ----------------
const refCache = new Map();
function buildRefIndex (refTable) {
  if (refCache.has(refTable)) return refCache.get(refTable);
  const cols = REF_LOOKUP[refTable] || ['name'];
  const rows = dbf.db.prepare(`SELECT id, ${cols.join(', ')} FROM ${refTable}`).all();
  const exact = new Map();
  for (const r of rows) {
    for (const c of cols) {
      const k = norm(r[c]);
      if (k && !exact.has(k)) exact.set(k, r.id);
    }
  }
  const idx = { rows, exact };
  refCache.set(refTable, idx);
  return idx;
}
function invalidateRefCache () { refCache.clear(); }

function resolveRef (refTable, value, opts = {}) {
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return { id: null };
  const idx = buildRefIndex(refTable);
  const k = norm(raw);
  if (idx.exact.has(k)) return { id: idx.exact.get(k) };

  // 宽松匹配：互相包含
  let best = null, bestLen = 0;
  for (const r of idx.rows) {
    const cols = REF_LOOKUP[refTable] || ['name'];
    for (const c of cols) {
      const n = norm(r[c]);
      if (!n) continue;
      if (n.includes(k) || k.includes(n)) {
        if (n.length > bestLen) { bestLen = n.length; best = r.id; }
      }
    }
  }
  if (best) return { id: best, fuzzy: true };

  // 往来单位允许自动新建
  if (refTable === 'partners' && opts.autoCreatePartners) {
    const r = dbf.insertRow('partners', { name: raw, type: '其他' });
    if (!r.error) { invalidateRefCache(); return { id: r.id, created: true }; }
  }
  const label = TABLES[refTable].label;
  const hint = idx.rows.slice(0, 3).map(r => r[REF_LOOKUP[refTable][0]]).filter(Boolean).join('、');
  return { error: `找不到${label}「${raw}」${hint ? '（系统里现有：' + hint + '…）' : '（请先在「' + label + '」里建好，或勾选"自动新建往来单位"）'}` };
}

// ---------------- 值解析 ----------------
function normalizeDate (raw) {
  const s = String(raw).trim();
  if (!s) return null;
  let m = s.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{4})[-/.年](\d{1,2})$/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-01`;
  if (/^\d+(\.\d+)?$/.test(s)) {
    const d = excelSerialToDate(s);
    if (d) return d;
  }
  const d2 = new Date(s);
  if (!isNaN(d2)) return d2.toLocaleDateString('sv-SE');
  return null;
}

function parseNum (raw) {
  let s = String(raw).trim().replace(/[¥￥,\s]/g, '');
  if (!s) return null;
  let mul = 1;
  if (/万$/.test(s)) { mul = 10000; s = s.replace(/万$/, ''); }
  if (/亿$/.test(s)) { mul = 100000000; s = s.replace(/亿$/, ''); }
  if (/%$/.test(s)) s = s.replace(/%$/, '');
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * mul * 100) / 100 : null;
}

function normalizeSelect (field, raw) {
  const s = String(raw).trim();
  const opts = (field.options || []).map(o => typeof o === 'string' ? o : o.label);
  if (opts.includes(s)) return s;
  const hit = opts.find(o => o.includes(s) || s.includes(o));
  return hit || s;
}

/** 处理一行 */
function processRow (table, cells, cols, opts = {}) {
  const out = {};
  const errors = [];
  const notes = [];
  cols.forEach((fieldName, i) => {
    if (!fieldName) return;
    const f = TABLES[table].fields.find(x => x.name === fieldName);
    if (!f) return;
    const raw = String(cells[i] == null ? '' : cells[i]).trim();
    if (raw === '') return;

    if (f.type === 'ref') {
      const r = resolveRef(f.refTable, raw, opts);
      if (r.error) errors.push(`${f.label}：${r.error}`);
      else { out[fieldName] = r.id; if (r.created) notes.push(`${f.label}「${raw}」已自动新建`); }
      return;
    }
    if (f.type === 'date') {
      const d = normalizeDate(raw);
      if (!d) errors.push(`${f.label}「${raw}」不是可识别的日期（建议写成 2026-03-05）`);
      else out[fieldName] = d;
      return;
    }
    if (f.type === 'money' || f.type === 'number' || f.type === 'percent') {
      const n = parseNum(raw);
      if (n === null) errors.push(`${f.label}「${raw}」不是数字`);
      else out[fieldName] = n;
      return;
    }
    if (f.type === 'select') { out[fieldName] = normalizeSelect(f, raw); return; }
    if (f.type === 'multi') {
      // 多选：接受顿号、逗号、斜杠等常见分隔写法
      const opts = (f.options || []).map(o => typeof o === 'string' ? o : o.label);
      const parts = String(raw).split(/[,，、;；/|]+/).map(s => s.trim()).filter(Boolean);
      const vals = [];
      for (const part of parts) {
        const hit = opts.find(o => o === part) || opts.find(o => o.includes(part) || part.includes(o));
        const v = hit || part;
        if (!vals.includes(v)) vals.push(v);
      }
      out[fieldName] = vals.join(',');
      return;
    }
    out[fieldName] = raw;
  });

  // 收支方向容错：收/收款/收入 → in；付/付款/支出 → out
  if (TABLES[table].fields.some(f => f.name === 'direction') && out.direction) {
    const v = String(out.direction).trim();
    if (/^(收|收款|收入|进|销项)/.test(v)) out.direction = table === 'invoices' ? 'out' : 'in';
    else if (/^(付|付款|支出|出|进项)/.test(v)) out.direction = table === 'invoices' ? 'in' : 'out';
  }
  return { row: out, errors, notes };
}

// ---------------- 模板与导入 ----------------
function buildTemplate (table) {
  const def = TABLES[table];
  const fields = importableFields(table);
  const headers = fields.map(f => f.label);
  const example = fields.map(f => {
    if (f.type === 'ref') {
      const idx = buildRefIndex(f.refTable);
      const first = idx.rows[0];
      const sample = first ? String(first[REF_LOOKUP[f.refTable][0]] || '') : '';
      return sample || `（请填${TABLES[f.refTable].label}）`;
    }
    if (f.type === 'date') return '2026-03-05';
    if (f.type === 'money') return '100000';
    if (f.type === 'number' || f.type === 'percent') return '10';
    if (f.type === 'select') {
      const o = (f.options || [])[0];
      return typeof o === 'string' ? o : (o ? o.label : '');
    }
    if (f.type === 'multi') {
      // 示例给出两个值，提示这一列可以多选
      const opts = (f.options || []).slice(0, 2).map(o => typeof o === 'string' ? o : o.label);
      return opts.join('、');
    }
    if (f.name === 'name') return '示例名称（此行请删除）';
    return '';
  });
  const cell = v => /[",\r\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  return '\uFEFF' + [headers, example].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/**
 * 导入
 * @param {string} table
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {object} opts { preview:boolean, autoCreatePartners:boolean, skipFirstExample:boolean }
 */
function runImport (table, headers, rows, opts = {}) {
  invalidateRefCache();
  const { cols, unknown } = mapHeaders(table, headers);
  const mapped = cols.filter(Boolean);

  if (!mapped.length) {
    return {
      ok: false,
      error: '表头一行都对不上。请先下载模板，按模板的中文表头填写（第一行必须是表头）',
      unknownHeaders: unknown,
      templateHeaders: importableFields(table).map(f => f.label),
    };
  }

  const results = { ok: true, table, mapped, unknownHeaders: unknown, inserted: 0, skipped: 0, errors: [], notes: [], preview: [] };
  const limit = opts.preview ? Math.min(rows.length, 30) : rows.length;

  for (let i = 0; i < limit; i++) {
    const cells = rows[i];
    const { row, errors, notes } = processRow(table, cells, cols, opts);
    if (errors.length) {
      results.errors.push({ line: i + 2, messages: errors });
      results.skipped++;
      if (results.preview.length < 30) results.preview.push({ line: i + 2, ok: false, messages: errors });
      continue;
    }
    if (opts.preview) {
      // 预览必须走和真实导入一样的校验，否则会把必填缺失的行也算成"可导入"
      const chk = dbf.dryRunRow(table, row);
      if (chk.error) {
        results.errors.push({ line: i + 2, messages: [chk.error] });
        results.skipped++;
        if (results.preview.length < 30) results.preview.push({ line: i + 2, ok: false, messages: [chk.error] });
      } else {
        results.inserted++;
        if (results.preview.length < 30) results.preview.push({ line: i + 2, ok: true, row });
      }
      continue;
    }
    const r = opts.dryRun ? dbf.dryRunRow(table, row) : dbf.insertRow(table, row);
    if (r.error) {
      results.errors.push({ line: i + 2, messages: [r.error] });
      results.skipped++;
      if (results.preview.length < 30) results.preview.push({ line: i + 2, ok: false, messages: [r.error] });
    } else {
      results.inserted++;
      if (results.preview.length < 30) results.preview.push({ line: i + 2, ok: true, row });
    }
    for (const n of notes) if (results.notes.length < 20) results.notes.push(`第 ${i + 2} 行：${n}`);
  }
  if (opts.preview && rows.length > limit) results.truncated = rows.length - limit;
  if (results.errors.length > 30) results.errors = results.errors.slice(0, 30);
  return results;
}

/** 导入页需要的元信息 */
function importMeta () {
  const ORDER_HINT = { partners: 1, projects: 2, contracts: 3, schedules: 4, payments: 5, invoices: 6, materials: 7 };
  return TABLE_ORDER
    .map(t => ({
      table: t,
      label: TABLES[t].label,
      icon: TABLES[t].icon,
      order: ORDER_HINT[t] || 99,
      fields: importableFields(t).map(f => ({
        name: f.name, label: f.label, type: f.type, required: !!f.required,
        refTable: f.refTable || null,
        options: (f.options || []).map(o => typeof o === 'string' ? o : o.label),
      })),
    }))
    .sort((a, b) => a.order - b.order);
}

module.exports = { buildTemplate, runImport, importMeta, mapHeaders, importableFields, normalizeDate, parseNum, invalidateRefCache };
