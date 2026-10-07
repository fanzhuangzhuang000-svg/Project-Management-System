'use strict';
/**
 * 月度结账快照
 *
 * 为什么要它：账龄、应收、成本这些都是"按今天实时算"的，
 * 到了下个月，上个月的数就再也算不出来了。存一份快照，才能看出趋势。
 *
 * 取数时机：服务启动时，如果上个月还没有快照，就用当前账面补记一份
 * （标注为自动补记）。服务天天开着的话，就是月末那天的状态；偶尔开一次，
 * 也至少留个锚点，界面上会写清楚是哪天记的。
 */
const { db, dashboard, nowISO, today, round2, num } = require('./db.js');

const KEEP_MONTHS = 60;          // 最多留 5 年

const safeParse = (s, dflt) => { try { return JSON.parse(s); } catch { return dflt; } };

function createTable () {
  db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ym TEXT NOT NULL UNIQUE,
    kind TEXT DEFAULT 'manual',
    note TEXT,
    data TEXT,
    captured_at TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_snapshots_ym ON snapshots(ym);');
}

/** 把"现在这一刻"的经营数据打包存下来 */
function capture (ym, kind = 'manual', note = null) {
  const d = dashboard();
  const payload = {
    totals: d.totals,
    aging: d.aging,
    by_status: d.by_status,
    by_category: d.by_category,
    by_expense: d.by_expense,
    schedules_totals: d.schedules && d.schedules.totals,
    reminder_count: (d.reminders || []).length,
    today: d.today,
  };
  db.prepare(`INSERT INTO snapshots (ym, kind, note, data, captured_at) VALUES (?,?,?,?,?)
    ON CONFLICT(ym) DO UPDATE SET kind = excluded.kind, note = excluded.note, data = excluded.data, captured_at = excluded.captured_at`)
    .run(ym, kind, note, JSON.stringify(payload), nowISO());
  db.prepare(`DELETE FROM snapshots WHERE id NOT IN (
      SELECT id FROM snapshots ORDER BY ym DESC LIMIT ?)`).run(KEEP_MONTHS);
  return { ok: true, ym, kind, note };
}

function get (ym) {
  const r = db.prepare('SELECT * FROM snapshots WHERE ym = ?').get(String(ym || ''));
  if (!r) return null;
  return { id: r.id, ym: r.ym, kind: r.kind, note: r.note, captured_at: r.captured_at, data: safeParse(r.data, {}) };
}

function list (limit = 24) {
  return db.prepare('SELECT id, ym, kind, note, captured_at FROM snapshots ORDER BY ym DESC LIMIT ?')
    .all(Math.max(1, parseInt(limit, 10) || 24));
}

function remove (ym) {
  return { deleted: Number(db.prepare('DELETE FROM snapshots WHERE ym = ?').run(String(ym || '')).changes) };
}

/** 启动时补记上个月的快照（已经有了就跳过） */
function ensureMonthly () {
  const t = today();
  const [y, m] = t.split('-').map(Number);
  if (!y || !m) return null;
  const prev = new Date(y, m - 2, 1);
  const ym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  if (db.prepare('SELECT id FROM snapshots WHERE ym = ?').get(ym)) return null;
  capture(ym, 'auto', `${t} 自动补记，代表 ${ym} 月末的账面状态`);
  return ym;
}

/**
 * 历史趋势：快照按月升序 + 当月实时值，
 * 用于大屏的趋势线（没有快照时只有当月一个点）
 */
function trend (limit = 12) {
  const rows = db.prepare('SELECT ym, data FROM snapshots ORDER BY ym DESC LIMIT ?')
    .all(Math.max(1, parseInt(limit, 10) || 12)).reverse();
  const pick = (d) => {
    const t = (d && d.totals) || {};
    return {
      contract_in: t.contract_in ?? null,
      contract_out: t.contract_out ?? null,
      cost: t.cost ?? null,
      paid_in: t.paid_in ?? null,
      paid_out: t.paid_out ?? null,
      receivable: t.receivable ?? null,
      payable: t.payable ?? null,
      actual_profit: t.actual_profit ?? null,
      inv_out: t.inv_out ?? null,
    };
  };
  const out = rows.map(r => ({ ym: r.ym, snapshot: true, ...pick(safeParse(r.data, {})) }));

  // 当月实时值补在最后（当月还没结账，用实时数）
  const curYm = today().slice(0, 7);
  const live = pick(dashboard());
  const last = out[out.length - 1];
  if (last && last.ym === curYm) out[out.length - 1] = { ym: curYm, snapshot: false, ...live };
  else out.push({ ym: curYm, snapshot: false, ...live });
  return out;
}

/** 环比：本月 vs 上一条快照 */
function mom () {
  const rows = db.prepare('SELECT ym, data FROM snapshots ORDER BY ym DESC LIMIT 1').all();
  const cur = dashboard().totals;
  if (!rows.length) return null;
  const prev = (safeParse(rows[0].data, {}).totals) || {};
  const diff = (k) => (prev[k] == null || cur[k] == null) ? null : round2(num(cur[k]) - num(prev[k]));
  return {
    base_ym: rows[0].ym, base_captured_at: rows[0].captured_at,
    contract_in: diff('contract_in'), cost: diff('cost'),
    paid_in: diff('paid_in'), receivable: diff('receivable'),
    actual_profit: diff('actual_profit'),
  };
}

module.exports = { createTable, capture, get, list, remove, ensureMonthly, trend, mom, KEEP_MONTHS };
