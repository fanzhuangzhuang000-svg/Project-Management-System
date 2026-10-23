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
const tenantCtx = require('./tenant.js');

const KEEP_MONTHS = 60;          // 最多留 5 年
// 孤儿/容量清理类语句的豁免标记：跨租户全局执行是有意的（见 db.js sweepOrphans）
const GLOBAL = '/* tenant-global */';
// 看板的趋势/环比读 snapshots：结账或删快照都要让缓存失效
const dirty = require('./dirty.js');

// 租户条件：scope() 返回裸条件（不带 WHERE），这里统一补前缀。
// 已有 WHERE 的语句用 snapTenantAnd()，没有的用 snapTenantWhere()。
// 单机模式两者都返回 ''，SQL 逐字不变。
const snapCond = () => tenantCtx.scope();
const snapTenantAnd = () => { const c = snapCond(); return c ? ' AND ' + c : ''; };
const snapTenantWhere = () => { const c = snapCond(); return c ? ' WHERE ' + c : ''; };

const safeParse = (s, dflt) => { try { return JSON.parse(s); } catch { return dflt; } };

function createTable () {
  db.exec(`CREATE TABLE IF NOT EXISTS snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ym TEXT NOT NULL,
    tenant_id BIGINT DEFAULT 1,
    kind TEXT DEFAULT 'manual',
    note TEXT,
    data TEXT,
    captured_at TEXT
  );`);
  // ── 老库升级：原来 ym 是列级 UNIQUE ──
  // 多租户下两个租户给同一个月结账，ON CONFLICT(ym) 会让租户 B 覆盖租户 A 的
  // 快照 —— 趋势线悄悄变成别人的账。SQLite 改不了列约束，只能重建表搬数据。
  // 唯一性从 (ym) 变成 (ym, tenant_id)：单机模式 tenant_id 恒为 1，行为不变。
  try {
    // sqlite_master 只在 SQLite 有；PG 的列级约束用 pg_constraint 摘掉
    if (db.dialect === 'postgres') {
      db.exec("ALTER TABLE snapshots DROP CONSTRAINT IF EXISTS snapshots_ym_key");
    } else {
      const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='snapshots'").get();
      if (row && /ym\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i.test(String(row.sql))) {
      const hasTenant = db.columns('snapshots').includes('tenant_id');
      db.exec('BEGIN');
      try {
        db.exec(`CREATE TABLE snapshots_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ym TEXT NOT NULL,
          tenant_id BIGINT DEFAULT 1,
          kind TEXT DEFAULT 'manual',
          note TEXT,
          data TEXT,
          captured_at TEXT
        );`);
        db.exec(`INSERT INTO snapshots_new (id, ym, ${hasTenant ? 'tenant_id, ' : ''}kind, note, data, captured_at)
          SELECT id, ym, ${hasTenant ? 'COALESCE(tenant_id, 1), ' : ''}kind, note, data, captured_at FROM snapshots`);
        db.exec('DROP TABLE snapshots');
        db.exec('ALTER TABLE snapshots_new RENAME TO snapshots');
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
      }
    }
  } catch (e) {
    // 诚实抛错：吞掉的话，后面 capture 的 ON CONFLICT(ym, tenant_id) 找不到
    // 匹配的约束会崩，而且错因藏得更深。
    throw new Error('[快照] 唯一约束迁移失败：' + e.message);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_ym_tenant ON snapshots(ym, tenant_id);');
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
  // 快照内容来自 dashboard()，它已经按当前租户取数；
  // 但 snapshots 表本身也要按租户各存一份，否则租户 B 结账会覆盖租户 A 的快照
  db.prepare(`INSERT INTO snapshots (ym, tenant_id, kind, note, data, captured_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(ym, tenant_id) DO UPDATE SET kind = excluded.kind, note = excluded.note, data = excluded.data, captured_at = excluded.captured_at`)
    .run(ym, tenantCtx.stampTenant(), kind, note, JSON.stringify(payload), nowISO());
  // 容量上限按全局算：这是存储保护，不是业务口径
  db.prepare(`DELETE FROM snapshots ${GLOBAL} WHERE id NOT IN (
      SELECT id FROM snapshots ORDER BY ym DESC LIMIT ?)`).run(KEEP_MONTHS);
  dirty.mark('snapshots');
  return { ok: true, ym, kind, note };
}

function get (ym) {
  const r = db.prepare(`SELECT * FROM snapshots WHERE ym = ?${snapTenantAnd()}`).get(String(ym || ''));
  if (!r) return null;
  return { id: r.id, ym: r.ym, kind: r.kind, note: r.note, captured_at: r.captured_at, data: safeParse(r.data, {}) };
}

function list (limit = 24) {
  return db.prepare(`SELECT id, ym, kind, note, captured_at FROM snapshots${snapTenantWhere()} ORDER BY ym DESC LIMIT ?`)
    .all(Math.max(1, parseInt(limit, 10) || 24));
}

function remove (ym) {
  const deleted = Number(db.prepare(`DELETE FROM snapshots WHERE ym = ?${snapTenantAnd()}`).run(String(ym || '')).changes);
  if (deleted > 0) dirty.mark('snapshots');
  return { deleted };
}

/** 启动时补记上个月的快照（已经有了就跳过） */
function ensureMonthly () {
  const t = today();
  const [y, m] = t.split('-').map(Number);
  if (!y || !m) return null;
  const prev = new Date(y, m - 2, 1);
  const ym = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
  if (db.prepare(`SELECT id FROM snapshots WHERE ym = ?${snapTenantAnd()}`).get(ym)) return null;
  capture(ym, 'auto', `${t} 自动补记，代表 ${ym} 月末的账面状态`);
  return ym;
}

/**
 * 历史趋势：快照按月升序 + 当月实时值，
 * 用于大屏的趋势线（没有快照时只有当月一个点）
 */
/**
 * 近 N 个月的走势。
 * @param {number} limit 月数
 * @param {object} [curTotals] 调用方已算好的总览合计；不传则内部自己算一次
 */
function trend (limit = 12, curTotals) {
  const rows = db.prepare(`SELECT ym, data FROM snapshots${snapTenantWhere()} ORDER BY ym DESC LIMIT ?`)
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
  // 调用方已经算过总览时直接复用，别为了拿 9 个数字把整套 dashboard() 再跑一遍
  const live = pick(curTotals ? { totals: curTotals } : dashboard());
  const last = out[out.length - 1];
  if (last && last.ym === curYm) out[out.length - 1] = { ym: curYm, snapshot: false, ...live };
  else out.push({ ym: curYm, snapshot: false, ...live });
  return out;
}

/** 环比：本月 vs 上一条快照 */
function mom (curTotals) {
  const rows = db.prepare(`SELECT ym, data FROM snapshots${snapTenantWhere()} ORDER BY ym DESC LIMIT 1`).all();
  // 没有快照就没有环比，**先返回**再算总览 —— 否则新装的库每次开首页都白算一遍
  if (!rows.length) return null;
  const cur = curTotals || dashboard().totals;
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
