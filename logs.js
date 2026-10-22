'use strict';
/**
 * 操作日志：谁在什么时候新增/修改/删除了什么。
 * 目前没有登录体系，操作人由前端在「系统设置」里填一次名字（存本机），
 * 通过 X-Operator 请求头带上来；没填就记 IP。
 */
const { db, nowISO, daysAgoISO } = require('./db.js');
const tenantCtx = require('./tenant.js');
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
// ── 批量异步写入 ──────────────────────────────────────────────
// 以前每条日志一次独立 INSERT（一次落盘提交）。压测里每个写请求都要付这笔钱：
// 录一笔收付款 = 业务 INSERT + 日志 INSERT 两次提交，日志占了一半的写开销。
// 改成内存队列，攒够条数或定时统一在一个事务里提交：
//  · 租户标在【入队时】打（stampTenant 读的是当前请求的 AsyncLocalStorage），
//    攒队期间上下文早就换了 —— 冲刷时再打必然串租户。
//  · 读侧（list）先同步冲刷，用户录完账立刻打开日志页能看到自己那条。
//  · 冲刷失败（多半是写锁竞争）塞回队头下个周期重试，超上限丢最旧并告警。
const LOG_FLUSH_MS = 250;
const LOG_FLUSH_N = 32;
const LOG_QUEUE_MAX = 20000;
let logQueue = [];
let logTimer = null;

function scheduleFlush () {
  if (logTimer) return;
  logTimer = setTimeout(() => { logTimer = null; flushLogs(); }, LOG_FLUSH_MS);
  if (logTimer.unref) logTimer.unref();
}

/** 把队列里的日志在一个事务里落盘。可随时同步调用（读前冲刷/退出前冲刷）。 */
function flushLogs () {
  if (logTimer) { clearTimeout(logTimer); logTimer = null; }
  if (!logQueue.length) return;
  const batch = logQueue;
  logQueue = [];
  const stmt = db.prepare(`INSERT INTO logs (at, operator, action, table_name, record_id, label, summary, detail, tenant_id)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  try {
    db.exec('BEGIN');
    try {
      for (const row of batch) stmt.run(...row);
      db.exec('COMMIT');
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* 忽略 */ }
      throw e;
    }
  } catch {
    // 批量失败：整批塞回队头，下个周期重试（busy_timeout 8 秒，基本都能等到锁）
    logQueue = batch.concat(logQueue);
    if (logQueue.length > LOG_QUEUE_MAX) {
      logQueue = logQueue.slice(-LOG_QUEUE_MAX);
      console.warn(`[日志] 队列积压超过 ${LOG_QUEUE_MAX} 条，丢弃最旧的日志`);
    }
  }
}

function log (entry) {
  try {
    // record_id 必须落在 JS 安全整数范围内。
    // 超过 2^53 的值（比如 URL 里写 9007199254740993）会被 parseInt 舍入成
    // 9007199254740992 存进库；之后 list() 读回来时 node:sqlite 直接抛
    // "Value is too large to be represented as a JavaScript number" ——
    // 一条日志就能让整个日志页 / 系统通知永久 500。
    const rid = Number(entry.record_id);
    // 多租户：写入时打上当前租户标。漏了的话租户 2 的操作日志全归租户 1 ——
    // 租户 2 查不到自己的操作，租户 1 却能看到别人的，两头都错。
    // 注意必须在入队这一刻取（AsyncLocalStorage 还在当前请求里）。
    logQueue.push([
      nowISO(),
      entry.operator || null,
      entry.action || 'other',
      entry.table_name || null,
      Number.isSafeInteger(rid) && rid > 0 ? rid : null,
      entry.label || null,
      entry.summary || null,
      entry.detail ? JSON.stringify(entry.detail).slice(0, 4000) : null,
      tenantCtx.stampTenant(),
    ]);
    if (logQueue.length >= LOG_FLUSH_N) flushLogs();
    else scheduleFlush();
  } catch { /* 忽略 */ }
}

// 进程正常退出前冲一把（定时器是 unref 的，事件循环空了会触发 beforeExit）
try { process.on('beforeExit', flushLogs); } catch { /* 某些嵌入环境没有 process */ }

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
  flushLogs();   // 读前冲刷：用户录完账立刻打开日志页，必须能看到自己那条
  const where = [];
  const params = [];
  // 多租户：日志按租户隔离（单机模式 scope 返回空串，SQL 不变）
  const tenantScope = tenantCtx.scope('');
  if (tenantScope) where.push(tenantScope);
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
  let rows;
  try {
    rows = db.prepare(`SELECT * FROM logs ${whereSQL} ORDER BY id DESC LIMIT ?`).all(...params, limit);
  } catch (e) {
    /**
     * 历史脏数据兜底：万一库里已经存了超过 2^53 的 record_id（旧版本没有上限校验，
     * 一次带超大 id 的请求就能写进去），node:sqlite 转换时会抛错，
     * 一条记录就让整个日志页 500，而且重启也不会好 —— 脏数据在库里。
     * 这里退回"按文本读 record_id"的查询，页面照常可用；
     * 迁移 v8 会把这类脏值清成 NULL。
     */
    if (!/too large|JavaScript number/i.test(String(e && e.message))) throw e;
    console.log('[日志] 检测到超范围的 record_id，已按文本读取（迁移 v8 会清理）');
    rows = db.prepare(`SELECT id, at, operator, action, table_name,
        CAST(record_id AS TEXT) AS record_id, label, summary, detail
      FROM logs ${whereSQL} ORDER BY id DESC LIMIT ?`).all(...params, limit);
  }
  return { rows: rows.map(r => ({ ...r, actionLabel: ACTION_LABEL[r.action] || r.action })), total: rows.length };
}

function stats () {
  flushLogs();   // 读前冲刷：统计数字要包含刚入队还没落盘的
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
  flushLogs();   // 先落盘再删，否则队列里的日志躲过这次清理、下次冲刷又冒出来
  const cut = daysAgoISO(d);   // at 字段是本地时间串，不能用 UTC 比
  return Number(db.prepare('DELETE FROM logs WHERE at < ?').run(cut).changes);
}

module.exports = { createTable, log, list, stats, purge, diffFields, summarize, ACTION_LABEL, flushLogs };
