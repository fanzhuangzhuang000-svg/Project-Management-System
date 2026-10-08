'use strict';
/**
 * 数据访问层：建表、通用增删改查、统计聚合、示例数据。
 * 仅使用 Node.js 内置 node:sqlite，无需安装任何第三方依赖。
 */
const path = require('node:path');
const fs = require('node:fs');
const { TABLES, TABLE_ORDER } = require('./schema.js');
// 多租户上下文。单机模式下它的 scope() 返回空串，对 SQL 没有任何影响。
const tenantCtx = require('./tenant.js');

// 连接交给驱动层：配了 DB_URL 就走 PostgreSQL，没配就是本地 SQLite。
// 业务代码只认 db 这个句柄的 prepare/exec，不关心底层是哪个数据库。
// 方言差异（占位符、自增主键、PRAGMA、布尔类型）全在 adapter 里处理。
const driver = require('./db-driver.js');

const DATA_DIR = driver.DATA_DIR;
const DB_FILE = driver.DB_FILE;
// 对外回显用：PG 下会抹掉密码。别拿它去连库，只用来显示。
const DB_FILE_SAFE = driver.DB_FILE_SAFE;
const DB_EXISTED = driver.DB_EXISTED;
const db = driver.db;

/** 把 WAL 内容合并回主库（PG 模式下是空操作，服务端自己会 checkpoint） */
function checkpoint (mode = 'PASSIVE') {
  try {
    return db.checkpoint(mode);
  } catch (e) {
    return { error: e.message };
  }
}

/** 生成一份完整、一致的数据库副本 */
function backupTo (destPath) {
  return db.backupTo(destPath);
}

/**
 * 当前后端的备份格式说明（界面如实显示用）。
 * 不能靠猜：pg_dump 缺失时 PG 会降级成只有数据的 JSON，
 * 用户必须知道这份备份到底能不能还原结构。
 */
function backupFormat () {
  return db.backupFormat ? db.backupFormat() : { format: 'unknown', restore: '' };
}

/** 优雅退出：先落盘，再关连接 */
function closeDb () {
  try { checkpoint('TRUNCATE'); } catch { /* 忽略 */ }
  try { db.close(); } catch { /* 忽略 */ }
}

// ---------------- 建表 ----------------
const SQL_TYPE = {
  money: 'REAL', number: 'REAL', percent: 'REAL',
  date: 'TEXT', text: 'TEXT', textarea: 'TEXT', select: 'TEXT', multi: 'TEXT', ref: 'INTEGER',
};

function columnDefs (table) {
  const def = TABLES[table];
  const cols = [];
  for (const f of def.fields) {
    if (f.virtual) continue;                 // 虚拟列不建库
    let type = SQL_TYPE[f.type] || 'TEXT';
    let c = `${f.name} ${type}`;
    if (f.required) c += ' NOT NULL';
    if (f.default !== undefined) {
      const d = f.default;
      c += typeof d === 'number' ? ` DEFAULT ${d}` : ` DEFAULT '${String(d).replace(/'/g, "''")}'`;
    }
    cols.push(c);
  }
  cols.push('is_demo INTEGER DEFAULT 0');
  cols.push('created_at TEXT');
  cols.push('updated_at TEXT');
  return cols;
}

function createTables () {
  for (const t of TABLE_ORDER) {
    const cols = columnDefs(t);
    db.exec(`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, ${cols.join(', ')});`);
    // 兼容老库：补齐缺失列（ALTER 不能带 NOT NULL，故只加裸列）
    // 列清单走适配器：SQLite 读 PRAGMA，PG 读 information_schema
    const existing = new Set(db.columns(t));
    for (const c of cols) {
      const name = c.split(' ')[0];
      if (existing.has(name)) continue;
      const type = c.split(' ')[1] || 'TEXT';
      db.exec(`ALTER TABLE ${t} ADD COLUMN ${name} ${type};`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_id ON ${t}(id);`);
  }
  for (const t of ['contracts', 'payments', 'invoices', 'materials']) {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_project ON ${t}(project_id);`);
  }

  // 系统设置（键值对）：欢迎语、公司名、系统名称、授权码…
  // 刻意不复用业务表那套列结构 —— 它不是业务数据，不需要 id/is_demo/审计列。
  db.exec(`CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT
  );`);
}

/**
 * 系统设置的默认值。
 *
 * 欢迎语里的 {公司名} 是占位符，渲染时替换成 company_name。
 * 默认值等于「没配置时看起来本来就是对的」，所以老用户升级后界面不变。
 */
const DEFAULT_SETTINGS = {
  company_name: '项目团队',
  system_name: '弱电智能化工程项目管理系统',
  welcome_morning: '上午好，{公司名} 👋',
  welcome_afternoon: '下午好，{公司名} ☕',
  welcome_evening: '晚上好，{公司名} 🌙',
  welcome_subtitle: '以下是您团队今日的工作概览',
  // 副标题模式：fixed=固定副标题（沿用 welcome_subtitle），daily=每日随机打工人语录
  subtitle_mode: 'fixed',
  // 授权码：由 tools/gen-license.js 生成。空 = 未授权（功能不限，只提示）
  license_key: '',
  // 操作日志保留天数。0 = 永久保留；超期在启动时和每天自动清理
  log_retention_days: '365',
  // 备份异地存放：off=只留本地，share=局域网共享目录，minio=传到 MinIO
  backup_remote: 'off',
  // 共享目录路径，形如 \\\\NAS\\backup\\elv-pms 或 Z:\\备份
  backup_share: '',
};

/** 读出全部系统设置（缺的用默认值补齐，保证前端拿到的永远是完整对象） */
function getSettings () {
  const out = { ...DEFAULT_SETTINGS };
  try {
    for (const r of db.prepare('SELECT key, value FROM settings').all()) {
      if (r.value !== null && r.value !== undefined && r.value !== '') out[r.key] = r.value;
    }
  } catch { /* 表还没建好时给默认值 */ }
  return out;
}

/** 只允许改这几个键，防止前端塞进来一堆垃圾 */
const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

/** 批量保存系统设置（只写传进来的键，其余不动） */
function saveSettings (patch) {
  if (!patch || typeof patch !== 'object') return { error: '参数不对' };
  const ts = nowISO();
  const saved = [];
  const skipped = [];
  db.exec('BEGIN');
  try {
    for (const k of Object.keys(patch)) {
      if (!SETTING_KEYS.includes(k)) { skipped.push(k); continue; }
      const v = patch[k] === null || patch[k] === undefined ? '' : String(patch[k]);
      db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
        .run(k, v, ts);
      saved.push(k);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { error: '保存失败：' + e.message };
  }
  return { ok: true, saved, skipped, settings: getSettings() };
}

// ---------------- 工具 ----------------
const nowISO = () => {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const round2 = v => Math.round((num(v) + Number.EPSILON) * 100) / 100;
const today = () => new Date().toLocaleDateString('sv-SE');   // YYYY-MM-DD，本地时区

function normalizeOption (o) { return typeof o === 'string' ? { value: o, label: o } : o; }

/** 把前端传来的原始对象清洗成可入库的行 */
function sanitize (table, input, { partial = false } = {}) {
  const def = TABLES[table];
  const row = {};
  for (const f of def.fields) {
    if (f.virtual) continue;
    const has = Object.prototype.hasOwnProperty.call(input, f.name);
    if (!has) {
      if (partial) continue;
      if (f.default !== undefined) row[f.name] = f.default;
      else if (f.type === 'money' || f.type === 'number' || f.type === 'percent') row[f.name] = 0;
      else row[f.name] = null;
      continue;
    }
    const v = input[f.name];
    switch (f.type) {
      case 'money': case 'number': case 'percent': {
        if (v === '' || v === null || v === undefined) { row[f.name] = 0; break; }
        row[f.name] = num(v); break;
      }
      case 'ref': {
        const n = parseInt(v, 10);
        row[f.name] = Number.isFinite(n) && n > 0 ? n : null;
        break;
      }
      case 'select': {
        if (v === '' || v === null || v === undefined) { row[f.name] = f.default !== undefined ? f.default : null; break; }
        const opts = (f.options || []).map(normalizeOption);
        const hit = opts.find(o => String(o.value) === String(v));
        row[f.name] = hit ? hit.value : String(v);
        break;
      }
      case 'multi': {
        // 多选：库内统一存成逗号分隔，去重、按选项归一
        let arr;
        if (Array.isArray(v)) arr = v;
        else if (v === '' || v === null || v === undefined) arr = [];
        else arr = String(v).split(/[,，、;；/|]+/);
        const opts = (f.options || []).map(normalizeOption);
        const out = [];
        for (const raw of arr) {
          const s = String(raw).trim();
          if (!s) continue;
          const hit = opts.find(o => String(o.value) === s || String(o.label) === s);
          const val = hit ? hit.value : s;
          if (!out.includes(val)) out.push(val);
        }
        if (!out.length && f.default !== undefined) out.push(...String(f.default).split(/[,，、;；/|]+/).map(s => s.trim()).filter(Boolean));
        row[f.name] = out.length ? out.join(',') : null;
        break;
      }
      default: {
        const s = (v === undefined || v === null) ? '' : String(v).trim();
        row[f.name] = s === '' ? null : s;
      }
    }
  }
  return row;
}

/** 派生字段（后端权威计算）。provided = 前端本次显式提交的字段名集合 */
function applyDerived (table, row, provided = new Set()) {
  // 通用：填了合同却没填项目 → 自动从合同带出所属项目，
  // 省一次选择，也避免同一笔业务在两张表里挂到不同项目上
  const hasProject = TABLES[table].fields.some(x => x.name === 'project_id');
  const hasContract = TABLES[table].fields.some(x => x.name === 'contract_id');
  if (hasProject && hasContract && !num(row.project_id) && num(row.contract_id)) {
    const c = db.prepare('SELECT project_id FROM contracts WHERE id = ?').get(parseInt(row.contract_id, 10));
    if (c && c.project_id) row.project_id = c.project_id;
  }
  if (table === 'contracts') {
    const rate = num(row.tax_rate);
    row.amount_ex_tax = round2(num(row.amount) / (1 + rate / 100));
  }
  if (table === 'expenses') {
    const rate = num(row.tax_rate);
    row.amount_ex_tax = round2(num(row.amount) / (1 + rate / 100));
  }
  if (table === 'materials') {
    const q = num(row.quantity), up = num(row.unit_price);
    row.amount = round2(q * up);
  }
  if (table === 'invoices') {
    const rate = num(row.tax_rate);
    const amountGiven = provided.has('amount');
    const totalGiven = provided.has('total_amount');
    let amount = num(row.amount);
    const totalIn = num(row.total_amount);
    if (amountGiven && amount > 0) {
      row.tax_amount = round2(amount * rate / 100);
      row.total_amount = round2(amount + row.tax_amount);
    } else if (totalGiven && totalIn > 0) {
      amount = round2(totalIn / (1 + rate / 100));
      row.amount = amount;
      row.tax_amount = round2(totalIn - amount);
      row.total_amount = round2(totalIn);
    } else if (amount > 0) {
      row.tax_amount = round2(amount * rate / 100);
      row.total_amount = round2(amount + row.tax_amount);
    } else {
      row.tax_amount = 0; row.total_amount = 0;
    }
  }
  return row;
}

function validate (table, row) {
  const def = TABLES[table];
  const errs = [];
  for (const f of def.fields) {
    if (!f.required) continue;
    const v = row[f.name];
    if (v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v))) {
      errs.push(`${f.label}不能为空`);
    }
  }
  return errs;
}

// ---------------- 查询 ----------------
function selectSQL (table) {
  const def = TABLES[table];
  const cols = ['t.id'];
  const joins = [];
  for (const f of def.fields) {
    if (f.virtual) continue;                 // 虚拟列由聚合结果填充，不从表里取
    cols.push(`t.${f.name}`);
    if (f.type === 'ref') {
      const rdef = TABLES[f.refTable];
      const alias = `r_${f.name}`;
      cols.push(`${alias}.${rdef.display} AS ${f.name}_name`);
      joins.push(`LEFT JOIN ${f.refTable} ${alias} ON ${alias}.id = t.${f.name}`);
    }
  }
  cols.push('t.is_demo', 't.created_at', 't.updated_at');
  return { cols, from: `${table} t ${joins.join(' ')}` };
}

function refFieldNames (table) { return TABLES[table].fields.filter(f => f.type === 'ref').map(f => f.name); }

function listRows (table, opts = {}) {
  const def = TABLES[table];
  const { cols, from } = selectSQL(table);
  const where = [];
  const params = [];

  
// ★ 多租户隔离：只在 MULTI_TENANT=1 时生效。
  
// 单机模式下 scope() 返回空串，这条 where 根本不会被加进去，
  
// 现有 SQL 和结果完全不变。
  
const tCond = tenantCtx.scope("t.");
  
if (tCond) where.push(tCond);

  const kw = opts.q === undefined || opts.q === null ? '' : String(opts.q).trim();
  if (kw) {
    const parts = def.searchFields.map(f => `t.${f} LIKE ?`);
    for (const f of def.fields) {
      if (f.type === 'ref') parts.push(`r_${f.name}.${TABLES[f.refTable].display} LIKE ?`);
    }
    parts.push('CAST(t.id AS TEXT) LIKE ?');
    where.push(`(${parts.join(' OR ')})`);
    const like = `%${kw}%`;
    for (let i = 0; i < parts.length; i++) params.push(like);
  }

  // 只取指定的若干条（列表页"导出所选"用）
  if (opts.ids) {
    const arr = String(opts.ids).split(',').map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
    if (arr.length) {
      where.push(`t.id IN (${arr.map(() => '?').join(',')})`);
      params.push(...arr);
    }
  }

  for (const f of def.fields) {
    if (f.type !== 'select' && f.type !== 'ref' && f.type !== 'multi') continue;
    const v = opts[f.name];
    if (v === undefined || v === null || v === '' || v === 'all') continue;
    if (f.type === 'multi') {
      // 多选列用「整词命中」而不是 LIKE 子串，避免"门禁"匹配到"门禁一卡通"之外的东西
      where.push(`(',' || IFNULL(t.${f.name}, '') || ',') LIKE ?`);
      params.push(`%,${String(v).trim()},%`);
      continue;
    }
    where.push(`t.${f.name} = ?`);
    params.push(f.type === 'ref' ? parseInt(v, 10) : String(v));
  }

  const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sortable = new Set([...def.fields.filter(f => !f.virtual).map(f => f.name), 'id']);
  const sort = sortable.has(opts.sort) ? opts.sort : (sortable.has('pay_date') ? 'pay_date' : 'id');
  const dir = String(opts.order).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const orderSQL = `ORDER BY t.${sort} ${dir}, t.id DESC`;

  // 总数用 SQL 数，不把整表读进来
  const total = db.prepare(`SELECT COUNT(*) AS n FROM ${from} ${whereSQL}`).get(...params).n;

  // 分页下推到 SQL：只把当前这一页读出来（以前是读全表再在内存里 slice）
  const limit = opts.limit ? Math.max(1, parseInt(opts.limit, 10)) : 0;
  const offset = opts.offset ? Math.max(0, parseInt(opts.offset, 10)) : 0;
  const pageSQL = limit ? ` LIMIT ${limit} OFFSET ${offset}` : '';

  const rows = db.prepare(`SELECT ${cols.join(', ')} FROM ${from} ${whereSQL} ${orderSQL}${pageSQL}`).all(...params);

  // ---------- 装饰「当前页」这几行 ----------
  // 项目台账：把合同额、已收款、应收余额、毛利率等实时汇总值填进虚拟列
  if (table === 'projects') {
    const map = projectStatsMany(rows.map(r => r.id));
    for (const r of rows) Object.assign(r, map[r.id] || {});
  }
  // 合同：把「变更增减 / 最终金额」算出来
  if (table === 'contracts') decorateContracts(rows);
  // 收付款计划：按计划日期先后自动冲抵实际收付款，算出已收付/未收付/状态
  if (table === 'schedules') decorateSchedules(rows);
  // 发票：算出这张票收/付了多少钱
  if (table === 'invoices') decorateInvoices(rows);

  // ---------- 合计 ----------
  // 合计的口径是「当前筛选条件下的全部记录」，不是只有本页 —— 界面上也这么标注。
  const moneyFields = def.fields.filter(f => f.type === 'money');
  const sums = {};
  if (moneyFields.length) {
    if (limit && total > rows.length) {
      // 分页时：真实列用 SQL 直接 SUM；虚拟列（projects 的金额列）需要全量算一次
      const virtuals = moneyFields.filter(f => f.virtual).map(f => f.name);
      const realFields = moneyFields.filter(f => !f.virtual);
      const alias = (n) => `${table === 'contracts' ? 't.' : 't.'}${n}`;

      if (realFields.length) {
        const sql = realFields
          .map(f => `COALESCE(SUM(${alias(f.name)}),0) AS "${f.name}"`)
          .join(', ');
        const r = db.prepare(`SELECT ${sql} FROM ${from} ${whereSQL}`).get(...params) || {};
        for (const f of realFields) sums[f.name] = round2(r[f.name] || 0);
      }

      // 虚拟金额列：合同表是 变更额/最终金额，其余表按项目汇总一次即可
      if (virtuals.length) {
        if (table === 'projects') {
          const ids = db.prepare(`SELECT t.id AS id FROM ${from} ${whereSQL}`).all(...params).map(r => r.id);
          const map = projectStatsMany(ids);
          for (const f of virtuals) {
            sums[f.name] = round2(ids.reduce((s, id) => s + num((map[id] || {})[f.name]), 0));
          }
        } else {
          // 其它表的虚拟金额列：把筛选结果的这几列轻量取出来，批量装饰后求和
          const light = db.prepare(`SELECT t.id AS id FROM ${from} ${whereSQL}`).all(...params).map(r => r.id);
          const decorated = light.map(id => getRow(table, id)).filter(Boolean);
          for (const f of virtuals) sums[f.name] = round2(decorated.reduce((s, r) => s + num(r[f.name]), 0));
        }
      }
    } else {
      // 没有分页（导出、或一页装得下）：直接对已取到的行求和
      for (const f of moneyFields) sums[f.name] = round2(rows.reduce((s, r) => s + num(r[f.name]), 0));
    }
  }

  return { rows, total, sums };
}

function getRow (table, id) {
  const { cols, from } = selectSQL(table);
  // 单条也要隔离：否则知道 id 就能跨租户读别人的数据
  const tCondG = tenantCtx.scope("t.");   const row = db.prepare(`SELECT ${cols.join(', ')} FROM ${from} WHERE t.id = ?` + (tCondG ? ` AND ${tCondG}` : '')).get(parseInt(id, 10)) || null;
  if (!row) return null;
  // 单条也要带上虚拟列，否则详情/编辑拿到的数据和列表里对不上
  if (table === 'contracts') decorateContracts([row]);
  if (table === 'invoices') decorateInvoices([row]);
  if (table === 'schedules') decorateSchedules([row]);
  if (table === 'projects') Object.assign(row, projectStats(row.id));
  return row;
}

/** 哪些表会被当成外键下拉的选项来源（由 schema 的 ref 字段反推，加字段自动跟上） */
function refTables () {
  const need = new Set();
  for (const t of TABLE_ORDER) {
    for (const f of TABLES[t].fields) {
      if (f.type === 'ref' && f.refTable) need.add(f.refTable);
    }
  }
  return need;
}

function refOptions () {
  // 只下发真正会被当下拉选项用的表。
  // 收付款、项目费用、材料设备这些表从来不作为外键目标，
  // 全量下发在数据多的时候能占到八成体积，白白拖慢每次打开系统。
  const need = refTables();
  const out = {};
  for (const t of TABLE_ORDER) {
    if (!need.has(t)) continue;
    const def = TABLES[t];
    const rows = db.prepare(`SELECT id, ${def.display} AS label FROM ${t} ORDER BY id DESC`).all();
    out[t] = rows.map(r => ({ value: r.id, label: r.label === null || r.label === undefined || r.label === '' ? `#${r.id}` : String(r.label) }));
  }
  return out;
}

/** 某张表在选项里的总数（前端据此判断要不要提示"用搜索找更多"） */
function refOptionsCount (table) {
  if (!refTables().has(table)) return 0;
  return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
}

// ---------------- 写入 ----------------
function insertRow (table, input) {
  const provided = new Set(Object.keys(input));
  const row = applyDerived(table, sanitize(table, input), provided);
  const errs = validate(table, row);
  if (errs.length) return { error: errs.join('；') };
  const keys = Object.keys(row);
  const ts = nowISO();
  // 打上租户标（单机模式下永远是 1）。必须放在 sanitize 之后加：
  // tenant_id 不在 schema 里，放前面会被过滤掉。
  row.tenant_id = tenantCtx.stampTenant();
  keys.push('tenant_id');
  const sql = `INSERT INTO ${table} (${keys.join(',')}, is_demo, created_at, updated_at) VALUES (${keys.map(() => '?').join(',')}, 0, ?, ?)`;
  const info = db.prepare(sql).run(...keys.map(k => row[k]), ts, ts);
  return { id: Number(info.lastInsertRowid) };
}

function updateRow (table, id, input) {
  const def = TABLES[table];
  // ★ 多租户隔离：先按 id + tenant_id 查，查不到就是「记录不存在」。
  // 单机模式下 scope() 是空串，SQL 与本改造前完全一致。
  const tCondU = tenantCtx.scope('');
  const cur = db.prepare(`SELECT * FROM ${table} WHERE id = ?` + (tCondU ? ` AND ${tCondU}` : '')).get(parseInt(id, 10));
  if (!cur) return { error: '记录不存在' };
  const patch = sanitize(table, input, { partial: true });
  const merged = {};
  for (const f of def.fields) merged[f.name] = Object.prototype.hasOwnProperty.call(patch, f.name) ? patch[f.name] : cur[f.name];
  applyDerived(table, merged, new Set(Object.keys(input)));
  const errs = validate(table, merged);
  if (errs.length) return { error: errs.join('；') };
  const keys = def.fields.filter(f => !f.virtual).map(f => f.name);
  // UPDATE 也带上 tenant_id 条件：上面已经查过一次，但写操作多一道保险，
  // 万一将来有人绕过 getRow 直接调这里，也不会改到别人的数据。
  const sql = `UPDATE ${table} SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`
    + (tCondU ? ` AND ${tCondU}` : '');
  db.prepare(sql).run(...keys.map(k => merged[k]), nowISO(), parseInt(id, 10));
  return { id: parseInt(id, 10) };
}

/** 只校验、不写库（批量导入预览用，保证预览结果与真实导入一致） */
function dryRunRow (table, input) {
  const provided = new Set(Object.keys(input));
  const row = applyDerived(table, sanitize(table, input), provided);
  const errs = validate(table, row);
  if (errs.length) return { error: errs.join('；') };
  return { row };
}

function deleteRow (table, id) {
  // ★ 多租户隔离：删别人的数据比看别人的数据更严重，必须带上 tenant_id。
  // 单机模式下 scope() 是空串，SQL 与本改造前完全一致。
  const tCondD = tenantCtx.scope('');
  const info = db.prepare(`DELETE FROM ${table} WHERE id = ?` + (tCondD ? ` AND ${tCondD}` : '')).run(parseInt(id, 10));
  return { deleted: Number(info.changes) };
}

/** 删除前的关联引用检查 */
function dependents (table, id) {
  const i = parseInt(id, 10);
  const count = (sql) => db.prepare(sql).get(i).n;
  if (table === 'projects') {
    return {
      contracts: count('SELECT COUNT(*) n FROM contracts WHERE project_id = ?'),
      schedules: count('SELECT COUNT(*) n FROM schedules WHERE project_id = ?'),
      payments: count('SELECT COUNT(*) n FROM payments WHERE project_id = ?'),
      invoices: count('SELECT COUNT(*) n FROM invoices WHERE project_id = ?'),
      expenses: count('SELECT COUNT(*) n FROM expenses WHERE project_id = ?'),
      materials: count('SELECT COUNT(*) n FROM materials WHERE project_id = ?'),
      maintenance: count('SELECT COUNT(*) n FROM maintenance WHERE project_id = ?'),
    };
  }
  if (table === 'contracts') {
    return {
      schedules: count('SELECT COUNT(*) n FROM schedules WHERE contract_id = ?'),
      payments: count('SELECT COUNT(*) n FROM payments WHERE contract_id = ?'),
      invoices: count('SELECT COUNT(*) n FROM invoices WHERE contract_id = ?'),
      expenses: count('SELECT COUNT(*) n FROM expenses WHERE contract_id = ?'),
      materials: count('SELECT COUNT(*) n FROM materials WHERE contract_id = ?'),
      contracts_changes: count('SELECT COUNT(*) n FROM contract_changes WHERE contract_id = ?'),
    };
  }
  if (table === 'partners') {
    return {
      projects: count('SELECT COUNT(*) n FROM projects WHERE client_id = ?'),
      contracts: count('SELECT COUNT(*) n FROM contracts WHERE partner_id = ?'),
      invoices: count('SELECT COUNT(*) n FROM invoices WHERE partner_id = ?'),
      expenses: count('SELECT COUNT(*) n FROM expenses WHERE payee_id = ?'),
      materials: count('SELECT COUNT(*) n FROM materials WHERE supplier_id = ?'),
    };
  }
  if (table === 'invoices') {
    // 删发票不删钱，只是解除"对应发票"的关联
    return { payments: count('SELECT COUNT(*) n FROM payments WHERE invoice_id = ?') };
  }
  if (table === 'contracts_changes') {
    return {};
  }
  return {};
}

/** 单表内删除一条（带级联）——必须在已开启的事务里调用。返回实际删掉的行数 */
function deleteOneInTx (table, id) {
  if (table === 'projects') {
    for (const t of ['materials', 'invoices', 'payments', 'expenses', 'maintenance', 'schedules', 'contracts']) {
      db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
    }
  }
  if (table === 'contracts') {
    for (const t of ['payments', 'invoices', 'materials', 'expenses']) {
      db.prepare(`UPDATE ${t} SET contract_id = NULL WHERE contract_id = ?`).run(id);
    }
    db.prepare('DELETE FROM schedules WHERE contract_id = ?').run(id);
    // 变更记录是独立事实：删合同不删变更，只解除关联（还原时再接回去）
    db.prepare('UPDATE contract_changes SET contract_id = NULL WHERE contract_id = ?').run(id);
  }
  if (table === 'partners') {
    db.prepare('UPDATE projects SET client_id = NULL WHERE client_id = ?').run(id);
    db.prepare('UPDATE contracts SET partner_id = NULL WHERE partner_id = ?').run(id);
    db.prepare('UPDATE invoices SET partner_id = NULL WHERE partner_id = ?').run(id);
    db.prepare('UPDATE materials SET supplier_id = NULL WHERE supplier_id = ?').run(id);
    db.prepare('UPDATE expenses SET payee_id = NULL WHERE payee_id = ?').run(id);
  }
  // 删发票只是把收付款上的"对应发票"解开，绝不连钱一起删
  if (table === 'invoices') {
    db.prepare('UPDATE payments SET invoice_id = NULL WHERE invoice_id = ?').run(id);
  }
  const info = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  return Number(info.changes);
}

/** 级联删除：删除项目时连带其下全部业务数据 */
function deleteCascade (table, id) {
  const i = parseInt(id, 10);
  db.exec('BEGIN');
  try {
    deleteOneInTx(table, i);
    db.exec('COMMIT');
    return { ok: true };
  } catch (e) {
    db.exec('ROLLBACK');
    return { error: e.message };
  }
}

/**
 * 批量删除（列表页勾选后使用）
 * @param {string} table
 * @param {number[]} ids
 * @param {{cascade?:boolean}} opts
 * @returns {{ok?:boolean, deleted?:number, needConfirm?:boolean, dependents?:object, affected?:number, total?:number, error?:string}}
 */
function batchDelete (table, ids, opts = {}) {
  const list = (ids || []).map(x => parseInt(x, 10)).filter(n => Number.isFinite(n) && n > 0);
  if (!list.length) return { error: '没有选中任何记录' };
  if (!TABLES[table]) return { error: '未知数据表' };

  // 先统计关联数据，交给前端二次确认
  const deps = {};
  let affected = 0;
  for (const id of list) {
    let has = false;
    for (const [k, v] of Object.entries(dependents(table, id))) {
      if (v > 0) { deps[k] = (deps[k] || 0) + v; has = true; }
    }
    if (has) affected++;
  }
  // 只做检查、绝不写库（服务端"先提示后确认"的第一步必须用这个模式）
  if (opts.dryRun) {
    return { dryRun: true, needConfirm: Object.keys(deps).length > 0, dependents: deps, affected, total: list.length };
  }
  if (Object.keys(deps).length && !opts.cascade) {
    return { needConfirm: true, dependents: deps, affected, total: list.length };
  }

  db.exec('BEGIN');
  try {
    let removed = 0;
    for (const id of list) removed += deleteOneInTx(table, id);
    db.exec('COMMIT');
    return { ok: true, deleted: removed, requested: list.length, dependents: deps, affected };
  } catch (e) {
    db.exec('ROLLBACK');
    return { error: '批量删除失败：' + e.message };
  }
}

// ---------------- 统计 ----------------
/**
 * 收付款计划节点的自动冲抵
 * 不做手工勾稽：同一个项目、同一方向的实际收付款，按计划日期先后依次冲抵各节点。
 * 这样任何时候都不会出现"计划没销账"的糊涂账，也省去用户逐笔关联的麻烦。
 * @returns {Map<number, number>} 节点id → 已冲抵金额
 */
function scheduleAllocation () {
  const nodes = db.prepare(`SELECT id, project_id, direction, amount FROM schedules
    ORDER BY project_id, direction, due_date, id`).all();
  const pool = {};
  for (const p of db.prepare('SELECT project_id, direction, amount FROM payments ORDER BY pay_date, id').all()) {
    const k = `${p.project_id}|${p.direction}`;
    pool[k] = (pool[k] || 0) + num(p.amount);
  }
  const out = new Map();
  let curKey = null, remain = 0;
  for (const n of nodes) {
    const k = `${n.project_id}|${n.direction}`;
    if (k !== curKey) { curKey = k; remain = pool[k] || 0; }
    const amt = num(n.amount);
    const got = Math.max(0, Math.min(remain, amt));
    remain -= got;
    out.set(n.id, round2(got));
  }
  return out;
}

function scheduleState (row, paid, todayStr) {
  const amount = num(row.amount);
  const remaining = round2(amount - paid);
  if (remaining <= 0.005) return '已完成';
  if (row.due_date && row.due_date < todayStr) return '已逾期';
  if (paid > 0) return '部分收付';
  return '待收付';
}

/** 给节点行补上已收付/未收付/状态（列表、项目详情、看板都用它） */
function decorateSchedules (rows) {
  const alloc = scheduleAllocation();
  const t = today();
  for (const r of rows) {
    const paid = alloc.get(r.id) || 0;
    r.paid_amount = paid;
    r.remaining = round2(num(r.amount) - paid);
    r.state = scheduleState(r, paid, t);
    r.overdue_days = (r.due_date && r.state === '已逾期')
      ? Math.round((new Date(t) - new Date(r.due_date)) / 86400000) : 0;
  }
  return rows;
}

function scheduleStats (projectId) {
  const pid = parseInt(projectId, 10);
  const rows = decorateSchedules(db.prepare('SELECT * FROM schedules WHERE project_id = ?').all(pid));
  const agg = (dir) => {
    const list = rows.filter(r => r.direction === dir);
    const plan = round2(list.reduce((s, r) => s + num(r.amount), 0));
    const paid = round2(list.reduce((s, r) => s + num(r.paid_amount), 0));
    const overdue = round2(list.filter(r => r.state === '已逾期').reduce((s, r) => s + num(r.remaining), 0));
    return { count: list.length, plan, paid, remaining: round2(plan - paid), overdue };
  };
  return { plan_in: agg('in'), plan_out: agg('out'), nodes: rows.length };
}

/**
 * 合同变更：已确认的增减额汇总。
 * 只有「已确认」的变更才计入最终金额；草稿和已作废都不算。
 */
function changeMap (table = 'contracts') {
  const map = new Map();
  for (const r of db.prepare(`SELECT contract_id, SUM(amount_delta) AS d, COUNT(*) AS n
      FROM contract_changes WHERE status = '已确认' AND contract_id IS NOT NULL GROUP BY contract_id`).all()) {
    map.set(r.contract_id, { delta: round2(r.d), count: r.n });
  }
  return map;
}

/** 给合同行补上「变更增减 / 最终金额」两个虚拟列 */
function decorateContracts (rows) {
  const ch = changeMap();
  for (const r of rows) {
    const c = ch.get(r.id) || { delta: 0, count: 0 };
    r.change_amount = c.delta;
    r.change_count = c.count;
    r.final_amount = round2(num(r.amount) + c.delta);
  }
  return rows;
}

/**
 * 发票 ↔ 收款勾稽
 * 收付款记录上有个「对应发票」字段，指向哪张票就算哪张票的已收款。
 * 填了这张票，就能看出：票开了钱没收 / 钱收了票没开。
 */
function invoicePaidMap () {
  const map = new Map();
  for (const r of db.prepare('SELECT invoice_id, SUM(amount) AS amt FROM payments WHERE invoice_id IS NOT NULL GROUP BY invoice_id').all()) {
    map.set(r.invoice_id, round2(r.amt));
  }
  return map;
}

function decorateInvoices (rows) {
  const paid = invoicePaidMap();
  for (const r of rows) {
    const p = round2(paid.get(r.id) || 0);
    r.paid_amount = p;
    // 未收付不取负：多收的部分在"已收付"里能看出来
    r.unpaid_amount = round2(Math.max(0, num(r.total_amount) - p));
  }
  return rows;
}

/**
 * 自动关联：把还没填「对应发票」的收付款，按 项目 + 方向（+合同）匹配到发票上。
 * 优先精确到合同，其次同项目；按开票日期从早到晚填，票有余额才挂。
 * 只动 invoice_id 这一个字段，不改金额。
 */
function backfillInvoiceLinks () {
  const pays = db.prepare(`SELECT id, project_id, contract_id, direction, amount, pay_date
    FROM payments WHERE invoice_id IS NULL ORDER BY pay_date, id`).all();
  const invs = db.prepare("SELECT id, project_id, contract_id, direction, total_amount, issue_date FROM invoices WHERE status <> '作废'").all();
  if (!pays.length || !invs.length) return { linked: 0, scanned: pays.length };

  const paid = invoicePaidMap();
  const room = new Map();
  for (const i of invs) room.set(i.id, round2(num(i.total_amount) - (paid.get(i.id) || 0)));

  const idx = (withContract) => {
    const m = new Map();
    for (const i of invs) {
      const want = i.direction === 'out' ? 'in' : 'out';         // 销项票由收款冲抵
      const k = `${i.project_id}|${want}|${withContract ? (i.contract_id || '') : ''}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(i);
    }
    for (const list of m.values()) list.sort((a, b) => String(a.issue_date).localeCompare(String(b.issue_date)) || a.id - b.id);
    return m;
  };
  const exact = idx(true), loose = idx(false);

  const t = nowISO();
  const stmt = db.prepare('UPDATE payments SET invoice_id = ?, updated_at = ? WHERE id = ?');
  let linked = 0, skipped = 0, amount = 0;
  for (const p of pays) {
    const want = p.direction === 'in' ? 'out' : 'in';
    const cands = (p.contract_id ? exact.get(`${p.project_id}|${want}|${p.contract_id}`) : null)
      || loose.get(`${p.project_id}|${want}|`) || [];
    // 只有"这张票还差的钱 ≥ 这笔款"才挂，避免一张票被挂进超额收款
    const need = num(p.amount);
    const target = cands.find(i => (room.get(i.id) || 0) + 0.005 >= need && need > 0);
    if (!target) { skipped++; continue; }
    stmt.run(target.id, t, p.id);
    room.set(target.id, round2((room.get(target.id) || 0) - need));
    linked++; amount = round2(amount + need);
  }
  return { linked, skipped, amount, scanned: pays.length, invoices: invs.length };
}

/**
 * 发票勾稽汇总。传 projectId 就只看该项目，不传就是全局。
 *
 * 主口径用「总额对总额」：开票总额 vs 收付款总额。
 *   已开票未收 = 开票额 − 已收款（不足 0 就是 0，说明票都收回来了）
 *   已收未开票 = 已收款 − 开票额
 * 这个口径不依赖逐笔关联，填不填都准。
 *
 * 次口径是「逐笔关联」的合计数，只在用户手工挂了「对应发票」时才有值，
 * 用来核对某几张票具体收了多少钱。
 */
function invoiceReconcile (projectId) {
  const pid = projectId ? parseInt(projectId, 10) : null;
  const wInv = pid ? 'WHERE project_id = ?' : '';
  const wPay = pid ? 'WHERE p.project_id = ?' : '';
  const args = pid ? [pid] : [];
  const inv = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction='out' THEN total_amount ELSE 0 END),0) AS out_total,
      COALESCE(SUM(CASE WHEN direction='in'  THEN total_amount ELSE 0 END),0) AS in_total
    FROM invoices ${wInv}`).get(...args);
  const linked = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN p.direction='in'  THEN p.amount ELSE 0 END),0) AS out_paid,
      COALESCE(SUM(CASE WHEN p.direction='out' THEN p.amount ELSE 0 END),0) AS in_paid,
      COUNT(*) AS linked_count
    FROM payments p JOIN invoices i ON i.id = p.invoice_id ${wPay}`).get(...args);
  const pay = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END),0) AS paid_in,
      COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS paid_out
    FROM payments ${pid ? 'WHERE project_id = ?' : ''}`).get(...args);

  const invOut = round2(inv.out_total), invIn = round2(inv.in_total);
  const paidIn = round2(pay.paid_in), paidOut = round2(pay.paid_out);

  return {
    inv_out: invOut, inv_in: invIn,
    // 逐笔关联到的金额（可能为 0，表示还没做逐笔挂账）
    inv_out_paid: round2(linked.out_paid), inv_in_paid: round2(linked.in_paid),
    linked_count: linked.linked_count,
    // 主口径：总额勾稽
    inv_out_unpaid: round2(Math.max(0, invOut - paidIn)),   // 票开了，钱还没收齐
    inv_in_unpaid: round2(Math.max(0, invIn - paidOut)),    // 票收了，钱还没付清
    paid_in_no_inv: round2(Math.max(0, paidIn - invOut)),   // 钱收了，票还没开够
    paid_out_no_inv: round2(Math.max(0, paidOut - invIn)),
    // 开票覆盖度：已开票额占已收款的比例
    inv_cover_rate: paidIn > 0 ? round2(Math.min(100, invOut / paidIn * 100)) : (invOut > 0 ? 100 : 0),
  };
}

/**
 * 批量版项目统计：把「每个项目跑一组查询」改成「每张表一条分组查询」。
 * 单项目版每次 10 条 SQL，400 个项目的总览就是 4000+ 条；
 * 批量版无论多少个项目都固定 8 条。
 * @param {number[]} ids 项目 id 数组
 * @returns {Record<number, object>} projectId -> 统计对象
 */
function projectStatsMany (ids) {
  const list = [...new Set((ids || []).map(x => parseInt(x, 10)).filter(Number.isFinite))];
  const out = {};
  if (!list.length) return out;
  const ph = list.map(() => '?').join(',');
  const groupOf = (sql) => {
    const m = new Map();
    for (const r of db.prepare(sql).all(...list)) m.set(Number(r.pid), r);
    return m;
  };

  const C = groupOf(`SELECT c.project_id AS pid,
      COALESCE(SUM(CASE WHEN c.direction='in'  THEN c.amount + COALESCE(ch.delta, 0) ELSE 0 END),0) AS contract_in,
      COALESCE(SUM(CASE WHEN c.direction='out' THEN c.amount + COALESCE(ch.delta, 0) ELSE 0 END),0) AS contract_out,
      COALESCE(SUM(CASE WHEN c.direction='in'  THEN c.amount_ex_tax ELSE 0 END),0) AS contract_in_ex,
      COALESCE(SUM(CASE WHEN c.direction='out' THEN c.amount_ex_tax ELSE 0 END),0) AS contract_out_ex,
      COALESCE(SUM(CASE WHEN c.direction='in'  THEN c.amount ELSE 0 END),0) AS contract_in_base,
      COALESCE(SUM(CASE WHEN c.direction='out' THEN c.amount ELSE 0 END),0) AS contract_out_base,
      COUNT(*) AS contract_count
    FROM contracts c
    LEFT JOIN (SELECT contract_id, SUM(amount_delta) AS delta FROM contract_changes
               WHERE status='已确认' AND contract_id IS NOT NULL GROUP BY contract_id) ch
      ON ch.contract_id = c.id
    WHERE c.project_id IN (${ph})
    GROUP BY c.project_id`);

  const P = groupOf(`SELECT project_id AS pid,
      COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END),0) AS paid_in,
      COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS paid_out,
      COUNT(*) AS payment_count
    FROM payments WHERE project_id IN (${ph}) GROUP BY project_id`);

  const I = groupOf(`SELECT project_id AS pid,
      COALESCE(SUM(CASE WHEN direction='out' THEN total_amount ELSE 0 END),0) AS inv_out,
      COALESCE(SUM(CASE WHEN direction='in'  THEN total_amount ELSE 0 END),0) AS inv_in,
      COUNT(*) AS invoice_count
    FROM invoices WHERE project_id IN (${ph}) GROUP BY project_id`);

  const M = groupOf(`SELECT project_id AS pid, COALESCE(SUM(amount),0) AS amt, COUNT(*) AS cnt
    FROM materials WHERE project_id IN (${ph}) GROUP BY project_id`);

  const E = groupOf(`SELECT project_id AS pid,
      COALESCE(SUM(amount),0) AS cost,
      COALESCE(SUM(amount_ex_tax),0) AS cost_ex,
      COALESCE(SUM(CASE WHEN status='未付' THEN amount ELSE 0 END),0) AS unpaid,
      COUNT(*) AS cnt
    FROM expenses WHERE project_id IN (${ph}) GROUP BY project_id`);

  const MT = groupOf(`SELECT project_id AS pid, COUNT(*) AS cnt,
      COALESCE(SUM(CASE WHEN status IN ('待处理','处理中') THEN 1 ELSE 0 END),0) AS open,
      COALESCE(SUM(cost),0) AS cost
    FROM maintenance WHERE project_id IN (${ph}) GROUP BY project_id`);

  // 无合同的未付费用（应付账款里单独一档）
  const PE = groupOf(`SELECT project_id AS pid, COALESCE(SUM(amount),0) AS v FROM expenses
    WHERE project_id IN (${ph}) AND status='未付' AND (contract_id IS NULL OR contract_id = 0)
    GROUP BY project_id`);

  // 发票逐笔挂账：需要 JOIN，单独一条
  const LK = groupOf(`SELECT p.project_id AS pid,
      COALESCE(SUM(CASE WHEN p.direction='in'  THEN p.amount ELSE 0 END),0) AS out_paid,
      COALESCE(SUM(CASE WHEN p.direction='out' THEN p.amount ELSE 0 END),0) AS in_paid,
      COUNT(*) AS linked_count
    FROM payments p JOIN invoices i ON i.id = p.invoice_id
    WHERE p.project_id IN (${ph})
    GROUP BY p.project_id`);

  const EMPTY = {
    contract_in: 0, contract_out: 0, contract_in_ex: 0, contract_out_ex: 0,
    contract_in_base: 0, contract_out_base: 0, contract_count: 0,
    paid_in: 0, paid_out: 0, payment_count: 0,
    inv_out: 0, inv_in: 0, invoice_count: 0,
    amt: 0, cnt: 0, cost: 0, cost_ex: 0, unpaid: 0, v: 0,
    open: 0, out_paid: 0, in_paid: 0, linked_count: 0,
  };

  for (const pid of list) {
    const c = C.get(pid) || EMPTY;
    const p = P.get(pid) || EMPTY;
    const i = I.get(pid) || EMPTY;
    const m = M.get(pid) || EMPTY;
    const e = E.get(pid) || EMPTY;
    const mt = MT.get(pid) || EMPTY;
    const lk = LK.get(pid) || EMPTY;

    const s = {
      contract_in: round2(c.contract_in), contract_out: round2(c.contract_out), contract_count: c.contract_count,
      contract_in_ex: round2(c.contract_in_ex), contract_out_ex: round2(c.contract_out_ex),
      // 原合同额与变更额分开留着，界面上能看出"加了多少"
      contract_in_base: round2(c.contract_in_base), contract_out_base: round2(c.contract_out_base),
      change_in: round2(c.contract_in - c.contract_in_base),
      change_out: round2(c.contract_out - c.contract_out_base),
      paid_in: round2(p.paid_in), paid_out: round2(p.paid_out), payment_count: p.payment_count,
      inv_out: round2(i.inv_out), inv_in: round2(i.inv_in), invoice_count: i.invoice_count,
      material_amount: round2(m.amt), material_count: m.cnt,
      // 实际成本（按「项目费用」录入的实际发生额）
      cost: round2(e.cost), cost_ex: round2(e.cost_ex), cost_unpaid: round2(e.unpaid), expense_count: e.cnt,
      maint_count: mt.cnt, maint_open: mt.open, maint_cost: round2(mt.cost),
    };
    s.receivable = round2(s.contract_in - s.paid_in);
    s.payable = round2(s.contract_out - s.paid_out);
    // 应付账款细分：合同未付 + 无合同的未付费用（避免与合同口径重复计算）
    s.payable_contract = s.payable;
    s.payable_expense = round2((PE.get(pid) || EMPTY).v);
    s.payable = round2(s.payable_contract + s.payable_expense);

    // 发票勾稽（口径与 invoiceReconcile 一致，这里直接用已取到的聚合值算，省两条查询）
    const invOut = s.inv_out, invIn = s.inv_in;
    const outPaid = round2(lk.out_paid), inPaid = round2(lk.in_paid);
    Object.assign(s, {
      inv_out_paid: outPaid, inv_in_paid: inPaid, linked_count: lk.linked_count,
      inv_out_unpaid: round2(Math.max(0, invOut - s.paid_in)),
      inv_in_unpaid: round2(Math.max(0, invIn - s.paid_out)),
      paid_in_no_inv: round2(Math.max(0, s.paid_in - invOut)),
      paid_out_no_inv: round2(Math.max(0, s.paid_out - invIn)),
      inv_cover_rate: s.paid_in > 0 ? round2(Math.min(100, invOut / s.paid_in * 100)) : (invOut > 0 ? 100 : 0),
    });

    // 预计毛利：合同口径（不含税），签约时的预期
    s.gross_profit = round2(s.contract_in_ex - s.contract_out_ex);
    s.gross_rate = s.contract_in_ex > 0 ? round2(s.gross_profit / s.contract_in_ex * 100) : 0;
    // 动态毛利：真账口径（含税收入 − 实际发生成本），随时反映项目赚不赚钱
    s.actual_profit = round2(s.contract_in - s.cost);
    s.actual_rate = s.contract_in > 0 ? round2(s.actual_profit / s.contract_in * 100) : 0;
    // 成本执行：实际成本 vs 支出合同预算
    s.cost_budget = s.contract_out;
    s.cost_over = round2(s.cost - s.contract_out);
    s.cost_used_rate = s.contract_out > 0 ? round2(s.cost / s.contract_out * 100) : 0;
    s.collect_rate = s.contract_in > 0 ? round2(s.paid_in / s.contract_in * 100) : 0;
    s.uninvoiced_out = round2(s.contract_in - s.inv_out);
    out[pid] = s;
  }
  return out;
}

/** 单个项目的统计（内部走批量版，口径完全一致） */
function projectStats (projectId) {
  const pid = parseInt(projectId, 10);
  return projectStatsMany([pid])[pid] || {};
}

function dashboard () {
  const projects = db.prepare('SELECT id, code, name, status, category, manager, progress, start_date, end_date, client_id FROM projects ORDER BY id DESC').all();
  const clientMap = {};
  for (const r of db.prepare('SELECT id, name FROM partners').all()) clientMap[r.id] = r.name;

  // 一次算完所有项目的统计（批量版固定 8 条 SQL，不再每个项目跑一遍）
  const statMap = projectStatsMany(projects.map(p => p.id));
  const perProject = projects.map(p => ({ ...p, client_name: clientMap[p.client_id] || '', ...(statMap[p.id] || {}) }));
  const sum = k => round2(perProject.reduce((s, r) => s + num(r[k]), 0));

  const totals = {
    project_count: perProject.length,
    project_active: perProject.filter(p => ['进行中', '未开工', '结算中'].includes(p.status)).length,
    project_done: perProject.filter(p => ['已完工', '已结清', '已归档'].includes(p.status)).length,
    contract_count: perProject.reduce((s, p) => s + p.contract_count, 0),
    contract_in: sum('contract_in'), contract_out: sum('contract_out'),
    contract_in_ex: sum('contract_in_ex'), contract_out_ex: sum('contract_out_ex'),
    contract_in_base: sum('contract_in_base'), contract_out_base: sum('contract_out_base'),
    change_in: sum('change_in'), change_out: sum('change_out'),
    change_count: db.prepare("SELECT COUNT(*) n FROM contract_changes WHERE status='已确认'").get().n,
    paid_in: sum('paid_in'), paid_out: sum('paid_out'),
    receivable: sum('receivable'),
    // 应付：合同未付 + 无合同的零星未付费用（两个口径分开统计，别重复加）
    payable: sum('payable'),
    payable_contract: sum('payable_contract'),
    payable_expense: sum('payable_expense'),
    gross_profit: sum('gross_profit'),
    inv_out: sum('inv_out'), inv_in: sum('inv_in'),
    material_amount: sum('material_amount'),
    material_count: perProject.reduce((s, p) => s + p.material_count, 0),
    cost: sum('cost'), cost_ex: sum('cost_ex'), cost_unpaid: sum('cost_unpaid'),
    expense_count: perProject.reduce((s, p) => s + p.expense_count, 0),
    maint_count: perProject.reduce((s, p) => s + p.maint_count, 0),
    maint_open: perProject.reduce((s, p) => s + p.maint_open, 0),
    maint_cost: sum('maint_cost'),
    payment_count: db.prepare('SELECT COUNT(*) n FROM payments').get().n,
    invoice_count: db.prepare('SELECT COUNT(*) n FROM invoices').get().n,
    partner_count: db.prepare('SELECT COUNT(*) n FROM partners').get().n,
  };
  // 动态毛利：含税收入 − 实际发生成本（真账口径）
  totals.actual_profit = round2(totals.contract_in - totals.cost);
  totals.actual_rate = totals.contract_in > 0 ? round2(totals.actual_profit / totals.contract_in * 100) : 0;
  totals.cost_over = round2(totals.cost - totals.contract_out);
  totals.cost_used_rate = totals.contract_out > 0 ? round2(totals.cost / totals.contract_out * 100) : 0;
  totals.gross_rate = totals.contract_in_ex > 0 ? round2(totals.gross_profit / totals.contract_in_ex * 100) : 0;
  totals.collect_rate = totals.contract_in > 0 ? round2(totals.paid_in / totals.contract_in * 100) : 0;
  totals.uninvoiced_out = round2(totals.contract_in - totals.inv_out);
  // 发票勾稽（全局）
  Object.assign(totals, invoiceReconcile(null));

  const byStatus = {};
  for (const p of perProject) byStatus[p.status] = (byStatus[p.status] || 0) + 1;

  const byCategory = {};
  const catTokens = (v) => {
    const list = String(v || '').split(',').map(s => s.trim()).filter(Boolean);
    return list.length ? list : ['未分类'];
  };
  for (const p of perProject) {
    // 一个项目可能涉及多个子系统，逐个计入；
    // 因此这张图的合计会大于总合同额，界面上要说明清楚
    for (const k of catTokens(p.category)) {
      byCategory[k] = byCategory[k] || { count: 0, contract_in: 0, gross_profit: 0 };
      byCategory[k].count++;
      byCategory[k].contract_in = round2(byCategory[k].contract_in + p.contract_in);
      byCategory[k].gross_profit = round2(byCategory[k].gross_profit + p.gross_profit);
    }
  }

  const monthly = db.prepare(`SELECT substr(pay_date,1,7) AS ym,
      COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END),0) AS inflow,
      COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS outflow
    FROM payments WHERE pay_date IS NOT NULL AND pay_date <> ''
    GROUP BY ym ORDER BY ym DESC LIMIT 12`).all().reverse();

  const t = today();
  const topReceivable = perProject.filter(p => p.receivable > 0)
    .sort((a, b) => b.receivable - a.receivable).slice(0, 10);
  const overdue = perProject.filter(p => p.receivable > 0 && p.end_date && p.end_date < t)
    .sort((a, b) => String(a.end_date).localeCompare(String(b.end_date)));
  const thisMonth = t.slice(0, 7);
  const monthIn = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE direction='in' AND substr(pay_date,1,7)=?").get(thisMonth).v;
  const monthOut = db.prepare("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE direction='out' AND substr(pay_date,1,7)=?").get(thisMonth).v;

  // ---- 收付款计划：节点冲抵、逾期预警、未来 6 个月排期 ----
  const allSched = decorateSchedules(db.prepare(`SELECT s.*, p.name AS project_name, p.code AS project_code,
      c.name AS contract_name
    FROM schedules s
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN contracts c ON c.id = s.contract_id`).all());
  const sIn = allSched.filter(r => r.direction === 'in');
  const sOut = allSched.filter(r => r.direction === 'out');
  const sumBy = (arr, k) => round2(arr.reduce((s, r) => s + num(r[k]), 0));
  const schedTotals = {
    node_count: allSched.length,
    plan_in: sumBy(sIn, 'amount'), plan_out: sumBy(sOut, 'amount'),
    paid_in: sumBy(sIn, 'paid_amount'), paid_out: sumBy(sOut, 'paid_amount'),
    overdue_in: sumBy(sIn.filter(r => r.state === '已逾期'), 'remaining'),
    overdue_out: sumBy(sOut.filter(r => r.state === '已逾期'), 'remaining'),
    overdue_count: allSched.filter(r => r.state === '已逾期').length,
  };
  schedTotals.remaining_in = round2(schedTotals.plan_in - schedTotals.paid_in);
  schedTotals.remaining_out = round2(schedTotals.plan_out - schedTotals.paid_out);

  const overdueSchedules = allSched.filter(r => r.state === '已逾期')
    .sort((a, b) => String(a.due_date).localeCompare(String(b.due_date)))
    .map(r => ({
      id: r.id, project_id: r.project_id, project_name: r.project_name, contract_name: r.contract_name,
      direction: r.direction, phase: r.phase, due_date: r.due_date, amount: round2(r.amount),
      paid_amount: r.paid_amount, remaining: r.remaining, overdue_days: r.overdue_days,
    }));

  const upcoming = [];
  const baseDate = new Date(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, 1);
  for (let i = 0; i < 6; i++) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth() + i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const inMonth = allSched.filter(r => String(r.due_date || '').slice(0, 7) === ym);
    upcoming.push({
      ym,
      plan_in: round2(inMonth.filter(r => r.direction === 'in').reduce((s, r) => s + num(r.amount), 0)),
      plan_out: round2(inMonth.filter(r => r.direction === 'out').reduce((s, r) => s + num(r.amount), 0)),
      unpaid_in: round2(inMonth.filter(r => r.direction === 'in').reduce((s, r) => s + num(r.remaining), 0)),
      unpaid_out: round2(inMonth.filter(r => r.direction === 'out').reduce((s, r) => s + num(r.remaining), 0)),
    });
  }

  // ---- 待办提醒 & 到期预警：把"要人去干活"的信号集中起来 ----
  const dayDiff = (d) => Math.round((new Date(d + 'T00:00:00') - new Date(t + 'T00:00:00')) / 86400000);
  const openSched = allSched.filter(r => num(r.remaining) > 0.005 && r.due_date);
  const dueSoon = openSched
    .map(r => ({ ...r, days: dayDiff(r.due_date) }))
    .filter(r => r.days >= 0 && r.days <= 30)
    .sort((a, b) => a.days - b.days)
    .map(r => ({
      id: r.id, project_id: r.project_id, project_name: r.project_name, contract_name: r.contract_name,
      direction: r.direction, phase: r.phase, due_date: r.due_date, days: r.days,
      amount: round2(r.amount), remaining: r.remaining,
    }));
  const dueBucket = (lo, hi) => {
    const list = dueSoon.filter(r => r.days >= lo && r.days <= hi);
    return { count: list.length, amount: round2(list.reduce((s, r) => s + num(r.remaining), 0)) };
  };
  // 质保金到期（未来 90 天）：一笔钱躺在那儿等着去收/去退
  const warrantyDue = openSched
    .map(r => ({ ...r, days: dayDiff(r.due_date) }))
    .filter(r => r.phase === '质保金' && r.days >= 0 && r.days <= 90)
    .sort((a, b) => a.days - b.days)
    .map(r => ({
      id: r.id, project_id: r.project_id, project_name: r.project_name,
      direction: r.direction, due_date: r.due_date, days: r.days, remaining: r.remaining,
    }));

  const reminders = [];
  const overdueIn = overdueSchedules.filter(r => r.direction === 'in');
  const overdueOut = overdueSchedules.filter(r => r.direction === 'out');
  if (overdueIn.length) {
    reminders.push({
      level: 'danger', kind: 'overdue_in', count: overdueIn.length,
      amount: round2(overdueIn.reduce((s, r) => s + num(r.remaining), 0)),
      title: `${overdueIn.length} 个收款节点已逾期`,
      detail: `最久的已逾期 ${Math.max(...overdueIn.map(r => r.overdue_days || 0))} 天`,
      href: '#/t/schedules',
    });
  }
  if (overdueOut.length) {
    reminders.push({
      level: 'danger', kind: 'overdue_out', count: overdueOut.length,
      amount: round2(overdueOut.reduce((s, r) => s + num(r.remaining), 0)),
      title: `${overdueOut.length} 个付款节点已逾期`,
      detail: `该付没付，注意供应商关系`,
      href: '#/t/schedules',
    });
  }
  const b7 = dueBucket(0, 7);
  if (b7.count) {
    reminders.push({
      level: 'warn', kind: 'due_7', count: b7.count, amount: b7.amount,
      title: `7 天内有 ${b7.count} 笔收付款到期`,
      detail: '提前准备资金 / 催款', href: '#/t/schedules',
    });
  }
  const b30 = dueBucket(8, 30);
  if (b30.count) {
    reminders.push({
      level: 'info', kind: 'due_30', count: b30.count, amount: b30.amount,
      title: `30 天内有 ${b30.count} 笔收付款到期`,
      detail: '可提前排资金计划', href: '#/t/schedules',
    });
  }
  if (warrantyDue.length) {
    reminders.push({
      level: 'info', kind: 'warranty', count: warrantyDue.length,
      amount: round2(warrantyDue.reduce((s, r) => s + num(r.remaining), 0)),
      title: `90 天内 ${warrantyDue.length} 笔质保金到期`,
      detail: '到期即可申请退回 / 需按期退还', href: '#/t/schedules',
    });
  }
  // 竣工已过、钱还没收齐的项目
  const doneUnpaid = perProject.filter(p => p.receivable > 0 && p.end_date && p.end_date < t);
  if (doneUnpaid.length) {
    reminders.push({
      level: 'danger', kind: 'done_unpaid', count: doneUnpaid.length,
      amount: round2(doneUnpaid.reduce((s, p) => s + num(p.receivable), 0)),
      title: `${doneUnpaid.length} 个项目已竣工但款未收齐`,
      detail: `合计应收 ${round2(doneUnpaid.reduce((s, p) => s + num(p.receivable), 0)).toLocaleString()} 元`,
      href: '#/t/projects',
    });
  }
  if (totals.maint_open) {
    reminders.push({
      level: 'warn', kind: 'maint', count: totals.maint_open,
      amount: round2(totals.maint_cost), title: `${totals.maint_open} 单售后待处理`,
      detail: '质保期内响应慢了影响口碑', href: '#/t/maintenance',
    });
  }
  // 发票勾稽：税务上要盯的两件事
  if (totals.inv_out_unpaid > 0.005) {
    reminders.push({
      level: 'warn', kind: 'inv_unpaid', amount: totals.inv_out_unpaid,
      title: `已开票未收款 ${round2(totals.inv_out_unpaid).toLocaleString()} 元`,
      detail: '票开出去了，钱还没到账', href: '#/t/invoices',
    });
  }
  if (totals.paid_in_no_inv > 0.005) {
    reminders.push({
      level: 'info', kind: 'no_inv', amount: totals.paid_in_no_inv,
      title: `已收款未开票 ${round2(totals.paid_in_no_inv).toLocaleString()} 元`,
      detail: '钱到了票没开，注意税务申报口径', href: '#/t/invoices',
    });
  }
  // 无合同的零星费用还没付：这也是要还的钱，别漏了
  if (totals.payable_expense > 0.005) {
    reminders.push({
      level: 'info', kind: 'exp_unpaid', amount: totals.payable_expense,
      title: `零星费用未付 ${round2(totals.payable_expense).toLocaleString()} 元`,
      detail: '没有合同的报销/人工等，已计入应付', href: '#/t/expenses',
    });
  }
  reminders.sort((a, b) => ({ danger: 0, warn: 1, info: 2 }[a.level] - { danger: 0, warn: 1, info: 2 }[b.level]));

  // ---- 账龄分析：未收清的收付款节点按计划日期分档 ----
  const AGING_KEYS = ['未到期', '1-30', '31-60', '61-90', '90+'];
  const bucketOf = (days) => {
    if (days <= 0) return '未到期';
    if (days <= 30) return '1-30';
    if (days <= 60) return '31-60';
    if (days <= 90) return '61-90';
    return '90+';
  };
  const agingFor = (dir) => {
    const out = {};
    for (const k of AGING_KEYS) out[k] = { count: 0, amount: 0 };
    for (const r of allSched) {
      if (r.direction !== dir || num(r.remaining) <= 0.005) continue;
      const days = r.due_date ? Math.round((new Date(t) - new Date(r.due_date)) / 86400000) : 0;
      const k = bucketOf(days);
      out[k].count++;
      out[k].amount = round2(out[k].amount + num(r.remaining));
    }
    return out;
  };
  const topOverdue = allSched
    .filter(r => num(r.remaining) > 0.005 && r.due_date && r.due_date < t)
    .map(r => ({
      id: r.id, project_id: r.project_id, project_name: r.project_name, contract_name: r.contract_name,
      direction: r.direction, phase: r.phase, due_date: r.due_date,
      remaining: round2(r.remaining),
      days: Math.round((new Date(t) - new Date(r.due_date)) / 86400000),
    }))
    .sort((a, b) => b.days - a.days)
    .slice(0, 12);

  // ---- 费用科目分布（成本结构） ----
  const byExpense = {};
  for (const r of db.prepare('SELECT category, amount FROM expenses').all()) {
    const k = r.category || '未分类';
    byExpense[k] = round2((byExpense[k] || 0) + num(r.amount));
  }

  return {
    today: t, this_month: thisMonth,
    month_in: round2(monthIn), month_out: round2(monthOut),
    totals, by_status: byStatus, by_category: byCategory, by_expense: byExpense,
    monthly, top_receivable: topReceivable, overdue,
    schedules: { totals: schedTotals, overdue: overdueSchedules, upcoming, month: upcoming[0], due_soon: dueSoon, buckets: { d7: b7, d30: b30 }, warranty_due: warrantyDue },
    aging: { receivable: agingFor('in'), payable: agingFor('out'), top_overdue: topOverdue },
    reminders,
    // ---- 首页 2.0（管理系统风格）新增数据块 ----
    week: weekFlows(t),
    extra: extraStats(t, thisMonth),
    collect_rank: collectRank(),
  };
}

/** 本周（周一起算）收付款合计 —— 数据统计卡的「本周」tab 用 */
function weekFlows (t) {
  const d = new Date(t + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7;           // 周一=0
  const mon = new Date(d.getTime() - dow * 86400000);
  const monISO = `${mon.getFullYear()}-${String(mon.getMonth() + 1).padStart(2, '0')}-${String(mon.getDate()).padStart(2, '0')}`;
  const r = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END),0) AS in_w,
      COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0) AS out_w
    FROM payments WHERE pay_date >= ?`).get(monISO);
  return { in: round2(r.in_w), out: round2(r.out_w) };
}

/** 六个小指标里没有现成值的几个：管理人员 / 本月新增项目 / 待办事项数 */
function extraStats (t, thisMonth) {
  let staff = 0, newProjects = 0, todoCount = 0;
  try { staff = db.prepare("SELECT COUNT(*) c FROM users WHERE status='启用'").get().c; } catch { /* 表不在就不给 */ }
  try { newProjects = db.prepare("SELECT COUNT(*) c FROM projects WHERE substr(created_at,1,7)=?").get(thisMonth).c; } catch { /* 同上 */ }
  try {
    const r = db.prepare(`SELECT
        (SELECT COUNT(*) FROM schedules WHERE remaining > 0.005 AND direction='in') AS a,
        (SELECT COUNT(*) FROM maintenance WHERE status <> '已完成' AND status <> '已关闭') AS b,
        (SELECT COUNT(*) FROM invoices WHERE direction='out' AND status='未回款') AS c
      `).get();
    todoCount = (r.a || 0) + (r.b || 0) + (r.c || 0);
  } catch { /* 同上 */ }
  return { staff, new_projects: newProjects, todo_count: todoCount };
}

/** 项目回款率排行 Top5（回款率 = 已收款 / 收入合同额，只统计有合同额的项目） */
function collectRank () {
  const rows = db.prepare(`SELECT p.id, p.name,
      COALESCE(s.contract_in,0) AS contract_in, COALESCE(pay.paid_in,0) AS paid_in
    FROM projects p
    LEFT JOIN (
      SELECT project_id, SUM(amount) AS contract_in FROM contracts WHERE direction='in' GROUP BY project_id
    ) s ON s.project_id = p.id
    LEFT JOIN (
      SELECT project_id, SUM(amount) AS paid_in FROM payments GROUP BY project_id
    ) pay ON pay.project_id = p.id
  `).all();
  return rows
    .filter(r => r.contract_in > 0)
    .map(r => ({ id: r.id, name: r.name, rate: Math.min(100, Math.round(r.paid_in / r.contract_in * 1000) / 10) }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 5);
}
/** 按账号权限过滤总览数据：看不到的模块，对应数字直接不给 */
function dashboardFor (perms) {
  if (!perms || perms.all) return dashboard();
  const can = t => perms.read && perms.read.includes(t);
  const d = dashboard();

  // 合同相关：没有合同读权，合同额/毛利/成本构成全都不给
  if (!can('contracts')) {
    for (const k of ['contract_count', 'contract_in', 'contract_out', 'contract_in_ex', 'contract_out_ex',
      'gross_profit', 'gross_rate', 'uninvoiced_out', 'cost_over', 'cost_used_rate']) d.totals[k] = null;
    d.by_category = {};
    d.top_receivable = [];
    d.overdue = [];
  }
  // 收付款：没有读权，资金流/回款/应收应付全不给
  if (!can('payments')) {
    for (const k of ['paid_in', 'paid_out', 'receivable', 'payable', 'payable_contract', 'collect_rate', 'month_in', 'month_out']) d.totals[k] = null;
    d.monthly = [];
  }
  // 收付款计划：计划、账龄、逾期清单
  if (!can('schedules')) {
    d.schedules = { totals: {}, overdue: [], upcoming: [], month: null, due_soon: [], buckets: {}, warranty_due: [] };
    d.aging = { receivable: {}, payable: {}, top_overdue: [] };
  }
  // 待办提醒：按内容所依赖的模块逐条过滤。
  // 每条提醒的「标题」里就直接写了金额，所以依赖要写全 ——
  // 比如 done_unpaid 的金额是 合同额−已回款 算出来的，缺任一权限都不能给。
  if (Array.isArray(d.reminders)) {
    const need = {
      overdue_in: 'schedules', overdue_out: 'schedules', due_7: 'schedules',
      due_30: 'schedules', warranty: 'schedules',
      done_unpaid: ['contracts', 'payments'],
      maint: 'maintenance',
      inv_unpaid: ['invoices', 'payments'],
      no_inv: ['invoices', 'payments'],
      exp_unpaid: 'expenses',
    };
    d.reminders = d.reminders.filter(r => {
      const req = need[r.kind] || 'projects';
      return Array.isArray(req) ? req.every(can) : can(req);
    });
  }
  // 项目费用：实际成本/动态毛利/科目构成
  if (!can('expenses')) {
    for (const k of ['cost', 'cost_ex', 'cost_unpaid', 'expense_count', 'actual_profit', 'actual_rate', 'payable_expense']) d.totals[k] = null;
    d.by_expense = {};
  }
  // 发票。注意 inv_out_unpaid / paid_in_no_inv 是「发票 − 收付款」算出来的派生值，
  // 只要发票或收付款任一没有读权就必须一起屏蔽，否则金额会漏出去。
  if (!can('invoices')) {
    for (const k of ['inv_out', 'inv_in', 'inv_out_unpaid', 'inv_in_unpaid', 'uninvoiced_out']) d.totals[k] = null;
  }
  if (!can('invoices') || !can('payments')) {
    d.totals.paid_in_no_inv = null;
    d.totals.paid_out_no_inv = null;
    d.totals.inv_cover_rate = null;
  }
  // 材料 / 售后 / 项目 / 往来单位：只影响计数
  if (!can('materials')) d.totals.material_count = null, d.totals.material_amount = null;
  if (!can('maintenance')) { d.totals.maint_count = null; d.totals.maint_open = null; d.totals.maint_cost = null; }
  if (!can('projects')) { d.totals.project_count = null; d.totals.project_active = null; d.totals.project_done = null; d.by_status = {}; }
  // ---- 首页 2.0 新数据块：沿用同样的权限口径 ----
  if (!can('payments')) d.week = null;
  if (!can('projects')) d.collect_rank = [];
  if (!can('payments') || !can('invoices')) d.extra = { ...d.extra, todo_count: null };
  return d;
}

function projectDetail (id) {
  const p = getRow('projects', id);
  if (!p) return null;
  const pid = parseInt(id, 10);
  const q = (table, order) => {
    const { cols, from } = selectSQL(table);
    return db.prepare(`SELECT ${cols.join(', ')} FROM ${from} WHERE t.project_id = ? ORDER BY ${order}`).all(pid);
  };
  const sched = (() => {
    const { cols, from } = selectSQL('schedules');
    return db.prepare(`SELECT ${cols.join(', ')} FROM ${from} WHERE t.project_id = ? ORDER BY t.direction, t.due_date, t.id`).all(pid);
  })();
  decorateSchedules(sched);
  const inv = q('invoices', 't.issue_date DESC, t.id DESC');
  decorateInvoices(inv);
  return {
    project: p,
    contracts: q('contracts', 't.direction ASC, t.id DESC'),
    schedules: sched,
    payments: q('payments', 't.pay_date DESC, t.id DESC'),
    invoices: inv,
    expenses: q('expenses', 't.expense_date DESC, t.id DESC'),
    materials: q('materials', 't.id DESC'),
    maintenance: q('maintenance', 't.report_date DESC, t.id DESC'),
    stats: { ...projectStats(pid), schedule: scheduleStats(pid) },
  };
}

// ---------------- 示例数据 ----------------
const DEMO_PREFIX = 'DEMO-';

function clearDemo () {
  const res = {};
  db.exec('BEGIN');
  try {
    const r = clearDemoInner();
    db.exec('COMMIT');
    return r;
  } catch (e) { db.exec('ROLLBACK'); return { error: e.message }; }
}

/**
 * 清掉示例数据（**不带自己的事务**）。
 *
 * 抽出来是为了让「清空 + 重建」能包在**同一个事务**里：
 * 以前是先 clear（一次事务）再 seed（另一次事务），两次之间有个空窗，
 * 别的请求撞进来就会看到「示例数据全没了」—— 实测偶发把 materials 读成 0，
 * 查了很久才知道是时序问题而不是数据真的丢了。
 */
function clearDemoInner () {
  const res = {};
  try {
    // 示例的收付款计划节点必须先清掉。
    //
    // 这里不能只看 schedules.is_demo —— 示例计划节点是 generatePlan() 生成的，
    // 走的是普通插入路径、没带 is_demo 标记，于是：
    //   「清空示例数据」清不掉它们 → 反复补写示例数据就不断累积
    //   （实测累积到 4 份 / 84 个节点，把账龄从 945 万撑到 3504 万）
    // 所以改成按「归属哪个示例项目/合同」删，不管它自己标没标。
    const demoPids = db.prepare('SELECT id FROM projects WHERE is_demo = 1').all().map(r => r.id);
    const demoCids = db.prepare('SELECT id FROM contracts WHERE is_demo = 1').all().map(r => r.id);
    let sched = Number(db.prepare('DELETE FROM schedules WHERE is_demo = 1').run().changes);
    if (demoCids.length) {
      sched += Number(db.prepare(
        `DELETE FROM schedules WHERE contract_id IN (${demoCids.map(() => '?').join(',')})`).run(...demoCids).changes);
    }
    if (demoPids.length) {
      sched += Number(db.prepare(
        `DELETE FROM schedules WHERE project_id IN (${demoPids.map(() => '?').join(',')})`).run(...demoPids).changes);
    }
    res.schedules = sched;
    for (const t of ['materials', 'invoices', 'payments', 'contracts']) {
      res[t] = Number(db.prepare('DELETE FROM ' + t + ' WHERE is_demo = 1').run().changes);
    }
    res.projects = Number(db.prepare('DELETE FROM projects WHERE is_demo = 1').run().changes);
    // 清理不再被引用的示例单位
    res.partners = 0;
    for (const r of db.prepare('SELECT id FROM partners WHERE is_demo = 1').all()) {
      const used =
        db.prepare('SELECT COUNT(*) n FROM projects WHERE client_id = ?').get(r.id).n +
        db.prepare('SELECT COUNT(*) n FROM contracts WHERE partner_id = ?').get(r.id).n +
        db.prepare('SELECT COUNT(*) n FROM invoices WHERE partner_id = ?').get(r.id).n +
        db.prepare('SELECT COUNT(*) n FROM materials WHERE supplier_id = ?').get(r.id).n;
      if (used === 0) { db.prepare('DELETE FROM partners WHERE id = ?').run(r.id); res.partners++; }
    }
    return res;
  } catch (e) { return { error: e.message }; }
}

/**
 * 清空并重建示例数据 —— **一个事务里做完**。
 *
 * 为什么要它：以前端点是先 clear 再 seed，两次独立事务，中间有极短空窗；
 * 并发请求撞进去就会读到「空库」。实测偶发把 materials 读成 0。
 * 包成一个事务之后，外部要么看到旧数据、要么看到完整的新数据，不存在中间态。
 */
/**
 * 清空并重建示例数据。
 *
 * ⚠️ **不能包在一个事务里**：seed() 内部会调 generatePlan()，而那个函数
 * 自己管 BEGIN/COMMIT。外层再套事务会直接报
 * "cannot start a transaction within a transaction"，导致整个补写接口失效
 * （返回 200 但其实什么都没做）—— 这个坑我踩过。
 *
 * 所以顺序仍是「先清后写」两次写。中间那个空窗由调用方兜：
 * test-auth 的 ensureDemoData 会**播完再校验、不齐重试**。
 */
function reseedDemo () {
  const removed = clearDemo();
  if (removed && removed.error) return { error: removed.error };
  const r = seed(true);
  return { ...(r || {}), removed };
}

function seed (force) {
  // force=true 时无视「已有项目」直接补写示例数据（测试套件依赖示例数据，
  // 用户清空示例之后需要能补回来）。写进去的记录都是 is_demo=1，不影响真实数据。
  if (!force && db.prepare('SELECT COUNT(*) n FROM projects').get().n > 0) return { seeded: false };
  const ts = nowISO();
  const ins = (t, obj) => {
    const row = applyDerived(t, sanitize(t, obj), new Set(Object.keys(obj)));
    const keys = Object.keys(row);
    const info = db.prepare(`INSERT INTO ${t} (${keys.join(',')}, is_demo, created_at, updated_at) VALUES (${keys.map(() => '?').join(',')}, 1, ?, ?)`)
      .run(...keys.map(k => row[k]), ts, ts);
    return Number(info.lastInsertRowid);
  };

  const pa = {
    hospital: ins('partners', { name: '市第一人民医院', type: '甲方', short_name: '市一院', contact: '陈主任', phone: '0571-88001234', tax_no: '12330100MB1A2B3C4D', address: '本市高新区文一西路 1000 号', remark: '财政资金项目，付款需走审计流程。' }),
    chengjian: ins('partners', { name: '城建集团置业有限公司', type: '甲方', short_name: '城建置业', contact: '刘经理', phone: '0571-86005678', tax_no: '91330100MA2XXXXX0K', address: '本市上城区解放东路 58 号' }),
    hikvision: ins('partners', { name: '杭州海康威视数字技术股份有限公司', type: '供应商', short_name: '海康威视', contact: '王销售', phone: '13800000001', tax_no: '913301007377795721' }),
    dahua: ins('partners', { name: '浙江大华技术股份有限公司', type: '供应商', short_name: '大华', contact: '赵销售', phone: '13800000002' }),
    hengtong: ins('partners', { name: '江苏亨通线缆科技有限公司', type: '供应商', short_name: '亨通线缆', contact: '孙经理', phone: '13800000003' }),
    zhongjian: ins('partners', { name: '中建八局智能工程分公司', type: '分包商', short_name: '中建八局', contact: '周工', phone: '13800000004' }),
    jianli: ins('partners', { name: '华信工程监理有限公司', type: '监理', contact: '吴总监', phone: '13800000005' }),
  };

  const p1 = ins('projects', { code: 'DEMO-2026-001', name: '市第一人民医院新院区智能化弱电工程', client_id: pa.hospital, category: '综合布线,安防监控,门禁一卡通,机房工程', status: '进行中', manager: '张伟', progress: 65, location: '本市高新区文一西路 1000 号', start_date: '2025-09-01', end_date: '2026-06-30', remark: '含综合布线、安防监控、门禁一卡通、机房工程四个子系统，分两期验收。' });
  const p2 = ins('projects', { code: 'DEMO-2026-002', name: '城建·云鼎广场弱电智能化工程', client_id: pa.chengjian, category: '安防监控,停车管理,网络通信', status: '进行中', manager: '李强', progress: 40, location: '本市滨江区江南大道 288 号', start_date: '2026-01-15', end_date: '2026-12-31', remark: '商场+写字楼综合体，视频监控、停车管理与网络通信。' });
  const p3 = ins('projects', { code: 'DEMO-2025-018', name: '城建集团办公楼机房改造工程', client_id: pa.chengjian, category: '机房工程', status: '已完工', manager: '王芳', progress: 100, location: '本市上城区解放东路 58 号', start_date: '2025-04-01', end_date: '2025-09-30', remark: '机房装修、精密空调、UPS、动环监控。质保金 5% 待退还。' });

  const c1 = ins('contracts', { code: 'HT-2025-091', name: '市一院新院区智能化工程施工合同', project_id: p1, category: '项目合同', direction: 'in', partner_id: pa.hospital, amount: 5860000, tax_rate: 9, sign_date: '2025-08-20', start_date: '2025-09-01', end_date: '2026-06-30', status: '执行中', payment_terms: '预付款 30%，进度款按月度完成量 40%，竣工验收 25%，质保金 5% 一年后无息退还。' });
  const c2 = ins('contracts', { code: 'CG-2025-112', name: '视频监控设备采购合同（海康）', project_id: p1, category: '采购合同', direction: 'out', partner_id: pa.hikvision, amount: 1680000, tax_rate: 13, sign_date: '2025-09-10', status: '执行中', payment_terms: '签订预付 30%，货到验收 60%，质保金 10%。' });
  const c3 = ins('contracts', { code: 'CG-2025-118', name: '综合布线线缆材料采购合同（亨通）', project_id: p1, category: '采购合同', direction: 'out', partner_id: pa.hengtong, amount: 760000, tax_rate: 13, sign_date: '2025-09-15', status: '已完成', payment_terms: '货到付款 100%。' });
  const c4 = ins('contracts', { code: 'FB-2025-006', name: '机房装修及桥架安装分包合同', project_id: p1, category: '分包合同', direction: 'out', partner_id: pa.zhongjian, amount: 520000, tax_rate: 9, sign_date: '2025-10-08', status: '执行中', payment_terms: '进度款按月结算 80%，验收后 15%，质保金 5%。' });
  const c5 = ins('contracts', { code: 'HT-2026-004', name: '云鼎广场弱电智能化工程施工合同', project_id: p2, category: '项目合同', direction: 'in', partner_id: pa.chengjian, amount: 3180000, tax_rate: 9, sign_date: '2026-01-05', start_date: '2026-01-15', end_date: '2026-12-31', status: '执行中', payment_terms: '预付 20%，设备进场 30%，验收 45%，质保金 5%。' });
  const c6 = ins('contracts', { code: 'CG-2026-021', name: '云鼎广场监控及停车设备采购合同', project_id: p2, category: '采购合同', direction: 'out', partner_id: pa.dahua, amount: 1120000, tax_rate: 13, sign_date: '2026-02-10', status: '执行中', payment_terms: '下单预付 40%，到货 50%，质保 10%。' });
  const c7 = ins('contracts', { code: 'HT-2025-058', name: '城建集团办公楼机房改造合同', project_id: p3, category: '项目合同', direction: 'in', partner_id: pa.chengjian, amount: 1420000, tax_rate: 9, sign_date: '2025-03-18', start_date: '2025-04-01', end_date: '2025-09-30', status: '已完成', payment_terms: '预付 30%，验收 65%，质保金 5%。' });
  const c8 = ins('contracts', { code: 'CG-2025-072', name: '机房精密空调及 UPS 采购合同', project_id: p3, category: '采购合同', direction: 'out', partner_id: pa.hikvision, amount: 610000, tax_rate: 13, sign_date: '2025-04-02', status: '已完成' });

  const P = (project_id, contract_id, direction, kind, amount, pay_date, method, voucher_no, remark) =>
    ins('payments', { project_id, contract_id, direction, kind, amount, pay_date, method, voucher_no, remark });
  P(p1, c1, 'in', '预付款', 1758000, '2025-09-05', '银行转账', 'SK20250905-01', '合同预付款 30%');
  P(p1, c1, 'in', '进度款', 1200000, '2025-12-20', '银行转账', 'SK20251220-03', '第一期进度款');
  P(p1, c1, 'in', '进度款', 900000, '2026-04-18', '银行转账', 'SK20260418-02', '第二期进度款');
  P(p1, c2, 'out', '预付款', 504000, '2025-09-12', '银行转账', 'FK20250912-01', '监控设备预付 30%');
  P(p1, c2, 'out', '到货款', 1008000, '2026-01-08', '银行承兑', 'FK20260108-02', '设备到货验款 60%');
  P(p1, c3, 'out', '到货款', 760000, '2025-10-20', '银行转账', 'FK20251020-01', '线缆全额结清');
  P(p1, c4, 'out', '进度款', 380000, '2026-02-28', '银行转账', 'FK20260228-01', '分包进度款');
  P(p2, c5, 'in', '预付款', 636000, '2026-01-20', '银行转账', 'SK20260120-01', '合同预付款 20%');
  P(p2, c5, 'in', '进度款', 954000, '2026-05-12', '银行转账', 'SK20260512-02', '设备进场款 30%');
  P(p2, c6, 'out', '预付款', 448000, '2026-02-15', '银行转账', 'FK20260215-01', '设备下单预付 40%');
  P(p3, c7, 'in', '预付款', 426000, '2025-04-10', '银行转账', 'SK20250410-01', '预付款 30%');
  P(p3, c7, 'in', '尾款', 923000, '2025-10-25', '银行转账', 'SK20251025-01', '验收款 65%');
  P(p3, c8, 'out', '到货款', 610000, '2025-05-18', '银行转账', 'FK20250518-01', '设备款结清');

  const I = (project_id, contract_id, partner_id, direction, invoice_type, invoice_no, issue_date, amount, tax_rate, status) =>
    ins('invoices', { project_id, contract_id, partner_id, direction, invoice_type, invoice_no, issue_date, amount, tax_rate, status });
  I(p1, c1, pa.hospital, 'out', '增值税专用发票', '24001234', '2025-09-28', 1612844.04, 9, '已认证');
  I(p1, c1, pa.hospital, 'out', '增值税专用发票', '24008871', '2026-01-15', 1100917.43, 9, '已认证');
  I(p1, c2, pa.hikvision, 'in', '增值税专用发票', '33005521', '2025-09-25', 448672.57, 13, '已认证');
  I(p1, c3, pa.hengtong, 'in', '增值税专用发票', '32007788', '2025-10-16', 672566.37, 13, '已认证');
  I(p2, c5, pa.chengjian, 'out', '增值税专用发票', '24013390', '2026-02-02', 583486.24, 9, '已认证');
  I(p2, c6, pa.dahua, 'in', '增值税专用发票', '33019902', '2026-02-20', 396460.18, 13, '已开具');
  I(p3, c7, pa.chengjian, 'out', '增值税专用发票', '24002210', '2025-04-20', 390825.69, 9, '已认证');
  I(p3, c7, pa.chengjian, 'out', '增值税专用发票', '24009988', '2025-11-05', 846788.99, 9, '已认证');
  I(p3, c8, pa.hikvision, 'in', '增值税专用发票', '33001221', '2025-04-15', 539823.01, 13, '已认证');

  const M = (project_id, category, name, brand, model, spec, unit, quantity, unit_price, supplier_id, contract_id, status) =>
    ins('materials', { project_id, category, name, brand, model, spec, unit, quantity, unit_price, supplier_id, contract_id, status });
  M(p1, '设备', '网络高清枪型摄像机', '海康威视', 'DS-2CD3T46', '400万 星光级 红外50m', '台', 186, 780, pa.hikvision, c2, '已到货');
  M(p1, '设备', '网络硬盘录像机', '海康威视', 'DS-8632N-K8', '32路 8盘位', '台', 6, 4600, pa.hikvision, c2, '已到货');
  M(p1, '设备', '监控级硬盘', '希捷', 'ST8000VX004', '8TB 监控专用', '块', 48, 1180, pa.hikvision, c2, '已到货');
  M(p1, '线缆', '六类非屏蔽网线', '亨通', 'HS-UTP6', '305m/箱 无氧铜', '箱', 120, 620, pa.hengtong, c3, '已到货');
  M(p1, '线缆', '室内单模光缆', '亨通', 'GJFJV-4B1', '4芯 单模', '米', 3000, 3.2, pa.hengtong, c3, '已到货');
  M(p1, '桥架', '热镀锌槽式桥架', '国产', '200x100', '含盖板吊架', '米', 860, 68, pa.zhongjian, c4, '已安装');
  M(p1, '机柜', '网络机柜', '图腾', 'G26642', '42U 600x1000', '台', 12, 1850, pa.hikvision, c2, '已到货');
  M(p2, '设备', '周界智能球机', '大华', 'DH-SD6C82', '800万 30倍变焦', '台', 42, 3200, pa.dahua, c6, '部分到货');
  M(p2, '设备', '车牌识别一体机', '大华', 'DH-ITC237', '含道闸 3 套', '套', 3, 26000, pa.dahua, c6, '已下单');
  M(p2, '辅材', 'PVC 线管及配件', '国产', 'Φ25', '阻燃', '米', 5200, 4.5, pa.dahua, c6, '待采购');
  M(p3, '设备', '精密空调', '艾默生', 'DME12MHP1', '12.5kW 上送风', '台', 2, 96000, pa.hikvision, c8, '已安装');
  M(p3, '设备', '模块化 UPS', '华为', 'UPS5000-A', '40kVA 含电池组', '套', 1, 268000, pa.hikvision, c8, '已安装');

  // 项目实际费用（用于算实际成本和动态毛利）
  const E = (project_id, contract_id, category, name, amount, tax_rate, expense_date, payee_id, has_invoice, status, remark) =>
    ins('expenses', { project_id, contract_id, category, name, amount, tax_rate, expense_date, payee_id, has_invoice, status, remark });
  E(p1, c2, '材料设备', '视频监控设备采购（第一批）', 1512000, 13, '2025-09-12', pa.hikvision, '有票', '已付', '含税，已取得专票');
  E(p1, c3, '材料设备', '六类网线及光缆材料款', 760000, 13, '2025-10-20', pa.hengtong, '有票', '已付');
  E(p1, c4, '分包费', '机房装修及桥架安装分包进度款', 380000, 9, '2026-02-28', pa.zhongjian, '有票', '已付');
  E(p1, null, '人工费', '现场施工班组人工费（1-3 月）', 268000, 0, '2026-03-31', null, '无票', '已付', '临时班组，无发票');
  E(p1, null, '机械租赁', '高空作业车及吊装租赁', 46000, 0, '2026-01-20', null, '有票', '已付');
  E(p1, null, '差旅交通', '项目组驻场差旅费', 38500, 0, '2026-02-10', null, '无票', '已付');
  E(p1, null, '现场经费', '临时用电、围挡及安全防护', 52000, 0, '2025-11-15', null, '无票', '未付');
  E(p2, c6, '材料设备', '监控及停车设备采购款', 784000, 13, '2026-02-15', pa.dahua, '有票', '已付');
  E(p2, null, '人工费', '现场安装人工费', 156000, 0, '2026-04-30', null, '无票', '已付');
  E(p2, null, '业务招待', '甲方对接招待费', 12800, 0, '2026-03-18', null, '无票', '已付');
  E(p3, c8, '材料设备', '精密空调及 UPS 设备款', 610000, 13, '2025-05-18', pa.hikvision, '有票', '已付');
  E(p3, null, '税费', '项目相关税费', 18600, 0, '2025-10-10', null, '有票', '已付');

  // 质保期售后维修记录
  const MT = (project_id, report_date, issue, reporter, handler, in_warranty, status, finish_date, cost, remark) =>
    ins('maintenance', { project_id, report_date, issue, reporter, handler, in_warranty, status, finish_date, cost, remark });
  MT(p3, '2026-03-12', '三楼弱电间精密空调告警，温度偏高', '城建物业 张工', '王芳', '质保内', '已完成', '2026-03-13', 0, '滤网堵塞，清洗后恢复正常，未收费');
  MT(p3, '2026-07-05', '机房 UPS 电池组续航不足', '城建物业 张工', '王芳', '质保内', '处理中', null, 0, '已联系厂家上门检测电池组');
  MT(p1, '2026-09-20', '门诊楼 3 层监控画面偶尔卡顿', '市一院 陈主任', '张伟', '质保内', '待处理', null, 0, '待现场排查交换机端口');

  // 按各合同的付款条款自动生成收付款计划节点
  let planCount = 0;
  for (const cid of [c1, c2, c3, c4, c5, c6, c7, c8]) {
    const r = generatePlan(cid);
    if (r.ok) planCount += r.created;
  }

  return { seeded: true, plans: planCount };
}

// ---------------- 收付款计划：按合同付款条款自动生成 ----------------
function addMonths (dateStr, months) {
  if (!dateStr) return null;
  const d = new Date(dateStr + 'T00:00:00');
  if (isNaN(d)) return dateStr;
  d.setMonth(d.getMonth() + months);
  return d.toLocaleDateString('sv-SE');
}

function midDate (a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ta = new Date(a + 'T00:00:00').getTime();
  const tb = new Date(b + 'T00:00:00').getTime();
  if (!(tb > ta)) return b;
  return new Date(ta + (tb - ta) / 2).toLocaleDateString('sv-SE');
}

function planDateFor (contract, phase) {
  const start = contract.start_date || contract.sign_date;
  const end = contract.end_date || start;
  switch (phase) {
    case '预付款': return contract.sign_date || start;
    case '进度款':
    case '到货款': return midDate(start, end);
    case '验收款':
    case '尾款': return end;
    case '质保金': return addMonths(end, 12);
    default: return end;
  }
}

/**
 * 按合同「付款条款」自动生成收付款计划节点
 * @returns {{ok?:boolean, created?:number, nodes?:any[], warnings?:string[], error?:string}}
 */
function generatePlan (contractId, opts = {}) {
  const c = db.prepare('SELECT * FROM contracts WHERE id = ?').get(parseInt(contractId, 10));
  if (!c) return { error: '合同不存在' };

  const { parsePaymentTerms } = require('./tools/extract.js');
  const parsed = parsePaymentTerms(c.payment_terms || '');
  if (!parsed.nodes.length) {
    return { error: '没有从「付款条款」里读到付款比例。请补充成像这样的内容：预付款30%，进度款40%，验收款25%，质保金5%' };
  }
  const existing = db.prepare('SELECT COUNT(*) n FROM schedules WHERE contract_id = ?').get(c.id).n;
  if (existing && !opts.force) {
    return { error: `该合同已有 ${existing} 个计划节点。如需重新生成，请先到「收付款计划」里删除原节点。`, existing };
  }

  const total = round2(num(c.amount));
  const t = today();
  const nodes = [];
  let allocated = 0;
  const ratioBased = parsed.nodes.some(n => n.ratio);
  parsed.nodes.forEach((n, i) => {
    let amount, ratio;
    if (n.ratio) {
      amount = round2(total * n.ratio / 100);
      ratio = n.ratio;
    } else {
      amount = round2(num(n.amountWan) * 10000);
      ratio = total > 0 ? round2(amount / total * 100) : null;
    }
    // 按比例且合计恰为 100% 时，让最后一个节点吸收四舍五入差额
    if (ratioBased && Math.abs(parsed.sum - 100) < 0.01 && i === parsed.nodes.length - 1) {
      amount = round2(total - allocated);
    }
    allocated = round2(allocated + amount);
    nodes.push({
      project_id: c.project_id,
      contract_id: c.id,
      direction: c.direction,
      phase: n.phase,
      ratio,
      amount,
      due_date: planDateFor(c, n.phase) || t,
      basis: n.basis || null,
      remark: '由合同付款条款自动生成',
    });
  });

  const warnings = [];
  if (ratioBased && Math.abs(parsed.sum - 100) > 0.01) {
    warnings.push(`付款条款里的比例合计是 ${parsed.sum}%，不是 100%，因此节点金额合计 ¥${allocated.toLocaleString('zh-CN')} 与合同额 ¥${total.toLocaleString('zh-CN')} 不一致，请核对后再用`);
  }

  db.exec('BEGIN');
  try {
    // is_demo 跟着合同走：示例合同生成的计划节点也算「示例」，
    // 否则「清空示例数据」清不掉它们，反复补写示例数据会不断累积。
    const demoFlag = c.is_demo ? 1 : 0;
    for (const n of nodes) {
      const row = applyDerived('schedules', sanitize('schedules', n), new Set(Object.keys(n)));
      const keys = Object.keys(row);
      const ts = nowISO();
      db.prepare(`INSERT INTO schedules (${keys.join(',')}, is_demo, created_at, updated_at) VALUES (${keys.map(() => '?').join(',')}, ?, ?, ?)`)
        .run(...keys.map(k => row[k]), demoFlag, ts, ts);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { error: '生成失败：' + e.message };
  }
  return { ok: true, created: nodes.length, nodes, warnings, contract: { id: c.id, name: c.name, amount: total, direction: c.direction } };
}

/**
 * 启动自检：清掉"父记录已不存在"的孤儿行。
 * 这类数据在界面上不可达，却会污染统计（比如计划收款合计虚高）。
 * 只会删父记录确实缺失的行，不会碰任何正常数据。
 */
// 项目下的子记录表。这是**唯一**维护点：级联删除、附件清理、孤儿清理都用它。
// 少写一张表，该表记录的附件就会在删父记录时悬空（record_id 指向已删除的行）。
const PROJECT_CHILD_TABLES = ['contracts', 'schedules', 'payments', 'invoices', 'expenses', 'materials', 'maintenance'];
function projectChildTables () { return PROJECT_CHILD_TABLES; }

function sweepOrphans () {
  const out = {};
  for (const t of PROJECT_CHILD_TABLES) {
    const r = db.prepare(`DELETE FROM ${t}
      WHERE project_id IS NOT NULL AND project_id NOT IN (SELECT id FROM projects)`).run();
    if (Number(r.changes)) out[t] = Number(r.changes);
  }
  // 合同被删后残留的计划节点 / 挂在不存在合同上的收付款、发票、材料、费用
  const r2 = db.prepare(`DELETE FROM schedules
    WHERE contract_id IS NOT NULL AND contract_id NOT IN (SELECT id FROM contracts)`).run();
  if (Number(r2.changes)) out.schedules_of_contract = Number(r2.changes);
  for (const t of ['payments', 'invoices', 'materials', 'expenses']) {
    const r = db.prepare(`UPDATE ${t} SET contract_id = NULL
      WHERE contract_id IS NOT NULL AND contract_id NOT IN (SELECT id FROM contracts)`).run();
    if (Number(r.changes)) out[`${t}_unlinked`] = Number(r.changes);
  }
  return out;
}

/** 备份文件名用的时间戳（本地时间，人看着方便） */
function dbfNow () {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `-`;
}

function init () {
  createTables();

  // 版本化迁移：加字段靠 createTables 就够了，但数据订正、建索引、
  // 依赖顺序的复杂变更必须有版本记录，否则没法判断客户的库是哪个版本。
  // 老库会被标成基线版本，数据不动。
  const mig = require("./migrations.js").migrate(db, {
    // 升级前自动备份，迁移写错了能退回去
    backup: () => {
      const dir = process.env.PMS_BACKUP_DIR || path.join(__dirname, "backup");
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, `pre-upgrade-${dbfNow()}.db`);
      return backupTo(dest);
    },
    log: (m) => console.log("  [迁移] " + m),
  });
  if (mig.error) console.error("  [迁移] ✗ " + mig.error);
  // 只在「全新的数据库文件」上写示例数据。
  // 老库即使一张业务表都没有，也绝不自动重播种——否则"数据被清空"会被伪装成"正常初始化"，
  // 真正的问题就被掩盖了（这一点踩过坑）。
  const r = DB_EXISTED ? { seeded: false, existed: true } : seed();
  r.swept = sweepOrphans();
  r.counts = recordCounts();
  return r;
}

/** 各表当前记录数（启动横幅与自检用） */
function recordCounts () {
  const out = {};
  for (const t of TABLE_ORDER) {
    try { out[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n; } catch { out[t] = 0; }
  }
  return out;
}

module.exports = {
  // 驱动信息透出去：server.js 判断「是不是 PG」要用。
  // 之前没透，导致 dbf.dialect 是 undefined，方言判断恒为假 ——
  // SQLite 专有的 PRAGMA 照样在 PG 上执行并报错。
  dialect: driver.dialect,
  isPg: driver.isPg,
  describeDb: driver.describe,
  db, DB_FILE, DB_FILE_SAFE, DATA_DIR, init, DB_FILE_NAME: path.basename(DB_FILE),
  // 连接串要透出去：pg_dump / pg_restore 这类外部工具必须用它。
  // 之前没导出，restore-backup.js 里 dbf.DB_URL 是 undefined，
  // pg_restore 收到 -d undefined 就退回 Unix socket + 当前 OS 用户，
  // 结果以 root 身份去连库直接 FATAL（真实踩过，备份还原跑不起来）。
  DB_URL: driver.DB_URL,
  checkpoint, backupTo, backupFormat, closeDb,
  listRows, getRow, insertRow, updateRow, deleteRow, dependents, deleteCascade, deleteOneInTx, batchDelete, dryRunRow,
  dashboard, dashboardFor, projectStats, projectStatsMany, projectDetail, refOptions, refOptionsCount, refTables, clearDemo, seed, reseedDemo,
  decorateInvoices, decorateContracts, invoiceReconcile, invoicePaidMap, backfillInvoiceLinks, changeMap,
  scheduleAllocation, decorateSchedules, scheduleStats, generatePlan, sweepOrphans, recordCounts,
  projectChildTables,
  num, round2, nowISO, today,
  getSettings, saveSettings, DEFAULT_SETTINGS, SETTING_KEYS,
};

// ---------------- 直接操作真实库时的自动备份 ----------------
//
// 教训：我在一个临时脚本里对真实库 data/pms.db 跑了破坏性测试，
// 一次删掉几千条操作日志，靠几分钟前的自动备份才捞回来。
// 恢复成功是运气 —— 如果备份间隔再长一点，丢的就不只是日志了。
//
// 所以定一条纪律：**不是服务端在跑、又确实用的是真实数据目录**时，
// require 这个模块就先自动备份一次再动手。
//
// 为什么不会拖慢一切：
//   · 服务端自己跑（server.js）直接跳过 —— 它有自己的备份策略；
//   · 测试进程都用 PMS_DATA_DIR 指向临时目录，也不会命中；
//   · 同一个脚本同一天只备一次，不会反复堆文件。
(function autoBackupForScripts () {
  try {
    if (process.env.PMS_NO_AUTO_BACKUP === '1') return;
    const entry = process.argv[1] || '';
    if (/server\.js$/i.test(entry)) return;                       // 服务端，跳过
    if (path.resolve(DATA_DIR) !== path.resolve(path.join(__dirname, 'data'))) return;  // 临时目录，跳过
    if (!DB_EXISTED) return;                                      // 库还没建，没什么可备

    const dir = path.join(__dirname, 'backup');
    fs.mkdirSync(dir, { recursive: true });
    const who = path.basename(entry || 'node').replace(/\.js$/i, '') || 'script';
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const ymd = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
    const tag = `pms_AUTO-${who}-${ymd}`;
    // 同一脚本同一天只备一次
    if (fs.readdirSync(dir).some(f => f.startsWith(tag))) return;

    const dest = path.join(dir, `${tag}.db`);
    backupTo(dest);
    console.log(`  [安全] 检测到直接操作真实数据库（${who}），已自动备份：${path.basename(dest)}`);
    console.log('         要跳过这个备份：设 PMS_NO_AUTO_BACKUP=1');
  } catch { /* 备份失败不能拦住脚本本身 */ }
})();
