'use strict';
/**
 * 操作日志：谁在什么时候新增/修改/删除了什么。
 * 目前没有登录体系，操作人由前端在「系统设置」里填一次名字（存本机），
 * 通过 X-Operator 请求头带上来；没填就记 IP。
 */
const { db, nowISO } = require('./db.js');
const { TABLES } = require('./schema.js');

const ACTION_LABEL = {
  create: '新增', update: '修改', delete: '删除', batch_delete: '批量删除',
  restore: '还原', purge: '彻底删除', import: '批量导入', backup: '备份',
  plan: '生成计划', recognize: '识别', upload: '上传附件',
  login: '登录', logout: '退出',
};

function createTable () {
  db.exec(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT,
    operator TEXT,
    action TEXT,
    table_name TEXT,
    record_id INTEGER,
    label TEXT,
    summary TEXT,
    detail TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(at);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_logs_table ON logs(table_name, record_id);');
}

/** 记录一条日志（永远不抛错，日志失败不能影响业务） */
function log (entry) {
  try {
    db.prepare(`INSERT INTO logs (at, operator, action, table_name, record_id, label, summary, detail)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      nowISO(),
      entry.operator || null,
      entry.action || 'other',
      entry.table_name || null,
      entry.record_id ? parseInt(entry.record_id, 10) : null,
      entry.label || null,
      entry.summary || null,
      entry.detail ? JSON.stringify(entry.detail).slice(0, 4000) : null,
    );
  } catch { /* 忽略 */ }
}

/** 比较修改前后，列出变化的字段 */
function diffFields (table, before, after) {
  const def = TABLES[table];
  if (!def || !before || !after) return null;
  const changes = [];
  for (const f of def.fields) {
    if (f.virtual) continue;
    const a = before[f.name];
    const b = after[f.name];
    if (String(a ?? '') === String(b ?? '')) continue;
    changes.push({ field: f.label, from: a ?? null, to: b ?? null });
  }
  return changes.length ? changes : null;
}

/** 把变更摘要压成一行中文，便于列表直接看 */
function summarize (action, table, label, detail) {
  const t = TABLES[table] ? TABLES[table].label : (table || '');
  const head = `${ACTION_LABEL[action] || action}${t}`;
  if (!detail) return `${head}：${label || ''}`.trim();
  if (Array.isArray(detail)) {
    const parts = detail.slice(0, 4).map(c => `${c.field} ${fmt(c.from)}→${fmt(c.to)}`);
    return `${head}「${label || ''}」：${parts.join('，')}${detail.length > 4 ? ` 等 ${detail.length} 项` : ''}`;
  }
  return `${head}：${label || ''}`;
}
function fmt (v) {
  if (v === null || v === undefined || v === '') return '空';
  const s = String(v);
  return s.length > 18 ? s.slice(0, 18) + '…' : s;
}

function list (opts = {}) {
  const where = [];
  const params = [];
  if (opts.table_name) { where.push('table_name = ?'); params.push(opts.table_name); }
  if (opts.action) { where.push('action = ?'); params.push(opts.action); }
  if (opts.operator) { where.push('operator = ?'); params.push(opts.operator); }
  if (opts.q) {
    where.push('(summary LIKE ? OR label LIKE ? OR operator LIKE ?)');
    const like = `%${opts.q}%`;
    params.push(like, like, like);
  }
  if (opts.since) { where.push('at >= ?'); params.push(opts.since); }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const limit = Math.min(parseInt(opts.limit, 10) || 200, 1000);
  const rows = db.prepare(`SELECT * FROM logs ${whereSQL} ORDER BY id DESC LIMIT ?`).all(...params, limit);
  return { rows: rows.map(r => ({ ...r, actionLabel: ACTION_LABEL[r.action] || r.action })), total: rows.length };
}

function stats () {
  const r = db.prepare(`SELECT COUNT(*) n,
      SUM(CASE WHEN action IN ('delete','batch_delete') THEN 1 ELSE 0 END) dels,
      MAX(at) last
    FROM logs`).get();
  return { total: r.n, deletes: r.dels || 0, last: r.last || null };
}

/**
 * 清理太久远的日志
 *
 * ⚠️ days <= 0 表示「永久保留」，**必须直接返回 0，绝不能算出一条截止时间**。
 * 以前这里没判断：purge(0) 会算出 cut = 当前时间，然后
 * 「删掉所有 at < 现在 的日志」—— 等于把日志清空。
 * 而系统设置里「永久保留」正好就是存 0，一旦有人不带判断地调它，日志全没了。
 * （这不是假设：实测 purge(0) 一次删掉了 6800+ 条。）
 */
function purge (days = 365) {
  const d = Number(days);
  if (!Number.isFinite(d) || d <= 0) return 0;   // 0 / 负数 / 非法值 = 永久保留
  const cut = new Date(Date.now() - d * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  return Number(db.prepare('DELETE FROM logs WHERE at < ?').run(cut).changes);
}

module.exports = { createTable, log, list, stats, purge, diffFields, summarize, ACTION_LABEL };
