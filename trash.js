'use strict';
/**
 * 回收站：删除前把整批数据快照存下来，30 天内可一键还原。
 *
 * 设计取舍：不改动各表的查询语句（不给每张表加 deleted_at 过滤），
 * 而是删除前把「本次会被删掉的全部行」序列化成 JSON 存进 trash 表。
 * 好处是业务查询零改动、还原时原样写回（保留原 id，外键关系不断）。
 */
const { db, nowISO } = require('./db.js');
// 多租户：只在 MULTI_TENANT=1 时生效，单机模式下 scope() 返回空串（SQL 一字不改）
const tenantCtx = require('./tenant.js');

// 级联删除时，这些子表会跟着一起被删
const CASCADE_DELETE = {
  projects: ['contract_changes', 'materials', 'invoices', 'payments', 'expenses', 'maintenance', 'schedules', 'contracts'],
};
// 删除主记录时，这些子表只是解除关联（记录保留），还原时要把关联接回去
const UNLINK_FIELD = {
  contracts: {
    payments: 'contract_id', invoices: 'contract_id', materials: 'contract_id',
    expenses: 'contract_id', contracts_changes: 'contract_id',
  },
  partners: {
    projects: 'client_id', contracts: 'partner_id', invoices: 'partner_id',
    materials: 'supplier_id', expenses: 'payee_id',
  },
  // 删发票只是解开收付款上的"对应发票"，钱不动，还原时再挂回去
  invoices: { payments: 'invoice_id' },
};

const KEEP_DAYS = 30;
const safeParse = (s, dflt) => { try { return JSON.parse(s); } catch { return dflt; } };

function createTable () {
  db.exec(`CREATE TABLE IF NOT EXISTS trash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT,
    record_ids TEXT,
    label TEXT,
    row_count INTEGER DEFAULT 0,
    payload TEXT,
    operator TEXT,
    deleted_at TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_trash_time ON trash(deleted_at);');
}

/**
 * 收集"本次删除会波及的全部行 + 相关附件"，只读不写
 * @returns {{rows:Array, unlinked:Array, attachRefs:Array}}
 */
function capture (table, ids) {
  const attach = require('./attachments.js');
  const rows = [];
  const unlinked = [];
  const attachRefs = [];
  const seenRow = new Set();
  const seenAttach = new Set();

  const addRow = (t, row) => {
    const key = `${t}:${row.id}`;
    if (seenRow.has(key)) return;
    seenRow.add(key);
    rows.push({ table: t, data: row });
  };
  const addAttach = (a) => {
    if (seenAttach.has(a.id)) return;
    seenAttach.add(a.id);
    attachRefs.push({ id: a.id, table_name: a.table_name, record_id: a.record_id });
  };

  for (const id of ids) {
    const self = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
    if (!self) continue;
    for (const child of CASCADE_DELETE[table] || []) {
      for (const r of db.prepare(`SELECT * FROM ${child} WHERE project_id = ?`).all(id)) addRow(child, r);
    }
    if (table === 'contracts') {
      for (const r of db.prepare('SELECT * FROM schedules WHERE contract_id = ?').all(id)) addRow('schedules', r);
    }
    for (const [child, field] of Object.entries(UNLINK_FIELD[table] || {})) {
      for (const r of db.prepare(`SELECT id FROM ${child} WHERE ${field} = ?`).all(id)) {
        unlinked.push({ table: child, id: r.id, field, ref: id });
      }
    }
    addRow(table, self);
  }

  // 收集这些记录身上的附件（含项目级附件）
  for (const item of rows) {
    for (const a of attach.list({ table_name: item.table, record_id: item.data.id }).rows) addAttach(a);
  }
  if (table === 'projects') {
    for (const id of ids) for (const a of attach.list({ project_id: id }).rows) addAttach(a);
  }

  return { rows, unlinked, attachRefs };
}

/** 写入回收站，返回回收站记录 id */
function push (table, ids, payload, operator, label) {
  const info = db.prepare(`INSERT INTO trash (table_name, record_ids, label, row_count, payload, operator, deleted_at, tenant_id)
    VALUES (?,?,?,?,?,?,?,?)`).run(
    table, JSON.stringify(ids), label || null, payload.rows.length,
    JSON.stringify(payload), operator || null, nowISO(),
    tenantCtx.stampTenant(),     // 单机模式下永远是 1
  );
  return Number(info.lastInsertRowid);
}

function list (limit = 100) {
  // ★ 多租户：回收站里装着被删的记录，不隔离的话别人删了什么一目了然。
  // 单机模式下 scope() 是空串，SQL 与本改造前完全一致。
  const tcL = tenantCtx.scope('');
  return db.prepare(`SELECT id, table_name, record_ids, label, row_count, operator, deleted_at
    FROM trash ${tcL ? 'WHERE ' + tcL : ''} ORDER BY id DESC LIMIT ?`).all(parseInt(limit, 10) || 100)
    .map(r => ({ ...r, record_ids: safeParse(r.record_ids, []) }));
}

function get (id) {
  // ★ 多租户：restore() 和 purge() 都走这里 —— 不隔离的话，
  // 不仅能看别人的数据，**恢复时还会把别的租户的记录注入进来**。
  const tcG = tenantCtx.scope('');
  const r = db.prepare('SELECT * FROM trash WHERE id = ?' + (tcG ? ` AND ${tcG}` : '')).get(parseInt(id, 10));
  if (!r) return null;
  return { ...r, payload: safeParse(r.payload, { rows: [], unlinked: [], attachRefs: [] }) };
}

/**
 * 还原一条回收站记录
 * @returns {{ok?:boolean, restored?:number, skipped?:number, error?:string}}
 */
function restore (id) {
  const entry = get(id);
  if (!entry) return { error: '回收站里没有这条记录' };
  const { rows = [], unlinked = [], attachRefs = [] } = entry.payload || {};
  const attach = require('./attachments.js');
  let restored = 0;
  let skipped = 0;

  db.exec('BEGIN');
  try {
    for (const item of rows) {
      const exists = db.prepare(`SELECT 1 FROM ${item.table} WHERE id = ?`).get(item.data.id);
      if (exists) { skipped++; continue; }   // id 已被占用（极少见），跳过而不是覆盖
      const cols = Object.keys(item.data);
      db.prepare(`INSERT INTO ${item.table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`)
        .run(...cols.map(c => item.data[c]));
      restored++;
    }
    // 把"只解除关联"的接回去
    for (const u of unlinked) {
      if (!db.prepare(`SELECT 1 FROM ${u.table} WHERE id = ?`).get(u.id)) continue;
      db.prepare(`UPDATE ${u.table} SET ${u.field} = ? WHERE id = ?`).run(u.ref, u.id);
    }
    db.prepare('DELETE FROM trash WHERE id = ?').run(entry.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    return { error: '还原失败：' + e.message };
  }
  // 附件接回（失败不影响数据还原结果）
  let reattached = 0;
  for (const ref of attachRefs) {
    try { reattached += attach.reattach(ref); } catch { /* 忽略 */ }
  }
  return { ok: true, restored, skipped, reattached };
}

/** 彻底删除（同时删掉当时保留的附件文件） */
function purge (id) {
  const entry = get(id);
  if (!entry) return { error: '回收站里没有这条记录' };
  const attach = require('./attachments.js');
  let files = 0;
  for (const ref of entry.payload.attachRefs || []) {
    try { files += attach.remove(ref.id).deleted; } catch { /* 忽略 */ }
  }
  db.prepare('DELETE FROM trash WHERE id = ?').run(entry.id);
  return { ok: true, removedFiles: files };
}

function purgeAll () {
  let n = 0, files = 0;
  for (const r of list(1000)) {
    const res = purge(r.id);
    if (res.ok) { n++; files += res.removedFiles || 0; }
  }
  return { ok: true, purged: n, removedFiles: files };
}

/** 超过保留期的自动清理 */
function autoPurge (days = KEEP_DAYS) {
  const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const old = db.prepare('SELECT id FROM trash WHERE deleted_at < ?').all(cut);
  let files = 0;
  for (const r of old) { const res = purge(r.id); files += res.removedFiles || 0; }
  return { purged: old.length, removedFiles: files };
}

function stats () {
  // ★ 多租户：条数也不能跨租户统计
  const tcS = tenantCtx.scope('');
  const r = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(row_count),0) c FROM trash'
    + (tcS ? ` WHERE ${tcS}` : '')).get();
  return { entries: r.n, rows: r.c, keepDays: KEEP_DAYS };
}

module.exports = { createTable, capture, push, list, get, restore, purge, purgeAll, autoPurge, stats, KEEP_DAYS };
