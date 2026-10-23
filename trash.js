'use strict';
/**
 * 回收站：删除前把整批数据快照存下来，30 天内可一键还原。
 *
 * 设计取舍：不改动各表的查询语句（不给每张表加 deleted_at 过滤），
 * 而是删除前把「本次会被删掉的全部行」序列化成 JSON 存进 trash 表。
 * 好处是业务查询零改动、还原时原样写回（保留原 id，外键关系不断）。
 */
const { db, nowISO, daysAgoISO } = require('./db.js');
// 还原会把行写回原来的表（跨表、说不清是哪张）→ 记 '*'，宁可多失效一次
const dirty = require('./dirty.js');
// 多租户：只在 MULTI_TENANT=1 时生效，单机模式下 scope() 返回空串（SQL 一字不改）
const tenantCtx = require('./tenant.js');

// 级联删除时，这些子表会跟着一起被删
const CASCADE_DELETE = {
  projects: ['contract_changes', 'materials', 'invoices', 'payments', 'expenses', 'maintenance', 'schedules', 'contracts'],
};
// 删除主记录时，这些子表只是解除关联（记录保留），还原时要把关联接回去
// ⚠️ 这里的 key 必须**就是真实表名** —— 下面 capture() 直接把它拼进 SQL：
//    `SELECT id FROM ${child} WHERE ${field} = ?`。
//    原来合同那一行写成了 contracts_changes（表叫 contract_changes，没有 s），
//    于是删任何一份合同时 capture() 都抛 no such table，快照整段失败；
//    而 server.js 那个 catch 只打一行日志就继续删 —— 合同删掉了、回收站里却没有，
//    「30 天内可一键还原」对这最常用的一张表根本不成立。实测：删完回收站 0 条。
//
// ⚠️ contract_changes 不在这张表里：它的 contract_id 是 NOT NULL，
//    没法"只解除关联"。删合同时变更记录跟着删，快照按**整行**保存（见 capture）。
const UNLINK_FIELD = {
  contracts: {
    payments: 'contract_id', invoices: 'contract_id', materials: 'contract_id',
    expenses: 'contract_id',
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
  // ⚠️ tenant_id 必须在这里建出来。push() 的 INSERT 里有这一列，
  //    而多租户迁移（migrations v4）的表清单里**没有 trash** ——
  //    也就是说这个列从来没被建过，push() 每次都报
  //    "table trash has no column named tenant_id"：
  //    删除照样执行，快照一条也存不进去，「30 天内可还原」全程是句空话。
  //    老库靠 migrations v7 补列，新库靠这里。
  db.exec(`CREATE TABLE IF NOT EXISTS trash (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT,
    record_ids TEXT,
    label TEXT,
    row_count INTEGER DEFAULT 0,
    payload TEXT,
    operator TEXT,
    deleted_at TEXT,
    tenant_id BIGINT DEFAULT 1
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_trash_time ON trash(deleted_at);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_trash_tenant ON trash(tenant_id);');
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
    // ⚠️ 父记录先入数组。restore() 是按数组顺序 INSERT 的 ——
    //    子表排在父表前面的话，一旦以后给 schema 加上外键约束，还原就会全部失败。
    //    现在没有 FOREIGN KEY 才侥幸没事，别把这个侥幸写成设计。
    addRow(table, self);
    for (const child of CASCADE_DELETE[table] || []) {
      for (const r of db.prepare(`SELECT * FROM ${child} WHERE project_id = ?`).all(id)) addRow(child, r);
    }
    if (table === 'projects') {
      // 变更记录的 project_id 是选填的：只按 project_id 收集会漏掉「只关联了合同」
      // 的那部分 —— 它们会被 deleteOneInTx 一起删掉，却没进快照，还原时就丢了。
      for (const r of db.prepare(`SELECT * FROM contract_changes
        WHERE contract_id IN (SELECT id FROM contracts WHERE project_id = ?)`).all(id)) addRow('contract_changes', r);
    }
    if (table === 'contracts') {
      for (const r of db.prepare('SELECT * FROM schedules WHERE contract_id = ?').all(id)) addRow('schedules', r);
      // 变更记录会被一起删掉（contract_id 是 NOT NULL，没法只解关联），
      // 所以必须按整行存进快照，还原时才回得来。
      for (const r of db.prepare('SELECT * FROM contract_changes WHERE contract_id = ?').all(id)) addRow('contract_changes', r);
    }
    for (const [child, field] of Object.entries(UNLINK_FIELD[table] || {})) {
      for (const r of db.prepare(`SELECT id FROM ${child} WHERE ${field} = ?`).all(id)) {
        unlinked.push({ table: child, id: r.id, field, ref: id });
      }
    }
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
    dirty.mark('*');
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
  // ⚠️ 必须用本地时间串：deleted_at 是 nowISO() 写的本地时间。
  // 用 toISOString() 会差一个时区偏移（北京 8 小时），保留 30 天变 30 天零 8 小时。
  const cut = daysAgoISO(days);
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
  // bytes 是回收站页面「占用空间」那一格用的。
  // 以前这里没返回它，前端写的是 (stats.bytes/1024/1024).toFixed(1) ——
  // undefined 算出来是 NaN，界面上直接显示「NaN MB」。
  // 回收站一直是空的，所以这个格子从来没人见过。
  // 口径：快照 JSON 的体积（就是回收站这张表占的空间）+ 引用到的附件文件体积。
  // 附件按 best-effort 统计，取不到就算 0，不让统计本身把页面搞挂。
  let bytes = 0;
  try {
    const attach = require('./attachments.js');
    const rows = db.prepare('SELECT payload FROM trash' + (tcS ? ` WHERE ${tcS}` : '')).all();
    for (const row of rows) {
      const text = row.payload || '';
      bytes += Buffer.byteLength(text, 'utf8');
      const p = safeParse(text, null);
      for (const ref of (p && p.attachRefs) || []) {
        try {
          const a = attach.get(ref.id);
          if (a && a.size) bytes += Number(a.size) || 0;
        } catch { /* 附件已被清理，不算 */ }
      }
    }
  } catch { /* 统计失败不影响条目数 */ }
  return { entries: r.n, rows: r.c, keepDays: KEEP_DAYS, bytes };
}

module.exports = { createTable, capture, push, list, get, restore, purge, purgeAll, autoPurge, stats, KEEP_DAYS };
