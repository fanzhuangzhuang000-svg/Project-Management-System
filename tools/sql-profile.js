'use strict';
/**
 * SQL 画像 —— 找出「哪个接口慢、慢在哪条 SQL」
 *
 * 起源：压测发现看板单请求要 1.4 秒（列表只要 27ms）。
 * 一个接口里塞了十几条 SQL，光看代码看不出哪条慢，必须逐条计时。
 *
 * 用法：
 *   node tools/sql-profile.js dashboard
 *   node tools/sql-profile.js dashboard project/3 list
 *   node tools/sql-profile.js --all            # 跑一遍常用只读接口
 *
 * 用 PMS_DATA_DIR 指向压测数据目录，才不会在空库上测出「都很快」的假象。
 */
const path = require('node:path');
const os = require('node:os');

const DIR = process.env.PMS_DATA_DIR || path.join(os.tmpdir(), 'pms-load');
if (!process.env.PMS_DATA_DIR) process.env.PMS_DATA_DIR = DIR;
process.env.PMS_NO_AUTO_BACKUP = '1';
process.env.PMS_MAINTENANCE_INTERVAL_MS = '0';

const dbf = require('../db.js');
const db = dbf.db;

// ── 埋点：拦截 prepare，给 all/get/run 计时 ──
const TIMED = new Set(['all', 'get', 'run']);
let records = [];
let armed = false;

const origPrepare = db.prepare.bind(db);
db.prepare = function (sql) {
  const stmt = origPrepare(sql);
  if (!armed) return stmt;
  return new Proxy(stmt, {
    get (target, prop) {
      const v = target[prop];
      if (typeof v === 'function' && TIMED.has(prop)) {
        return function (...args) {
          const t0 = process.hrtime.bigint();
          try {
            return v.apply(target, args);
          } finally {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            records.push({ sql, kind: prop, ms });
          }
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
};

function profile (label, fn) {
  records = [];
  armed = true;
  const t0 = process.hrtime.bigint();
  let out;
  try { out = fn(); } finally { armed = false; }
  const total = Number(process.hrtime.bigint() - t0) / 1e6;

  // 按 SQL 聚合（同一条 SQL 可能被调用多次）
  const bySql = new Map();
  for (const r of records) {
    const key = r.sql;
    let e = bySql.get(key);
    if (!e) { e = { sql: key, n: 0, ms: 0, max: 0, kind: r.kind }; bySql.set(key, e); }
    e.n++; e.ms += r.ms; if (r.ms > e.max) e.max = r.ms;
  }
  const list = [...bySql.values()].sort((a, b) => b.ms - a.ms);

  console.log('\n' + '='.repeat(78));
  console.log(`${label}  ——  总耗时 ${total.toFixed(1)} ms，${records.length} 次查询，${bySql.size} 条不同 SQL`);
  console.log('='.repeat(78));
  const sqlMs = list.reduce((s, e) => s + e.ms, 0);
  console.log(`SQL 合计 ${sqlMs.toFixed(1)} ms（占 ${(sqlMs / total * 100).toFixed(0)}%），JS 计算 ${(total - sqlMs).toFixed(1)} ms\n`);
  console.log('   耗时    次数   单次均   最慢    SQL');
  for (const e of list.slice(0, 14)) {
    const brief = e.sql.replace(/\s+/g, ' ').trim().slice(0, 88);
    console.log(
      (e.ms.toFixed(1) + 'ms').padStart(9) +
      String(e.n).padStart(6) +
      (e.ms / e.n).toFixed(1).padStart(8) +
      e.max.toFixed(0).padStart(7) +
      '  ' + brief
    );
  }
  if (list.length > 14) console.log(`   … 还有 ${list.length - 14} 条更快的，已省略`);
  return { total, sqlMs, list, out };
}

function main () {
  dbf.init();
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const targets = args.length ? args : ['dashboard'];

  if (process.argv.includes('--all')) targets.push('dashboard', 'list', 'project', 'logs', 'invoice', 'statement', 'snapshot');

  const pj = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get();
  const pid = pj ? pj.id : 1;

  console.log('数据目录：' + DIR);
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM projects) p, (SELECT COUNT(*) FROM payments) pay, (SELECT COUNT(*) FROM invoices) inv, (SELECT COUNT(*) FROM logs) lg').get();
  console.log(`数据规模：项目 ${counts.p} · 收付款 ${counts.pay} · 发票 ${counts.inv} · 日志 ${counts.lg}`);

  const slowest = [];
  for (const t of targets) {
    try {
      let r;
      if (t === 'dashboard') r = profile('看板 dashboard()', () => dbf.dashboard());
      else if (t === 'list') {
        // 用最大的表，才看得出分页和装饰的真实成本
        r = profile('收付款列表 listRows(payments)', () => dbf.listRows('payments', { limit: 50 }));
      } else if (t === 'project') r = profile('项目详情 projectDetail(' + pid + ')', () => dbf.projectDetail(pid));
      else if (t === 'logs') {
        const logmod = require('../logs.js');
        r = profile('操作日志 list()', () => logmod.list({ limit: 50 }));
      } else if (t === 'invoice') r = profile('发票列表 listRows(invoices)', () => dbf.listRows('invoices', { limit: 50 }));
      else if (t === 'statement') r = profile('对账单 statement(' + pid + ')', () => dbf.projectStatement ? dbf.projectStatement(pid) : null);
      else if (t === 'snapshot') r = profile('月度快照 ensureMonthly()', () => require('../snapshots.js').ensureMonthly());
      else {
        console.log('\n不认识的接口：' + t + '（可选 dashboard / list / project / logs / invoice / statement / snapshot）');
        continue;
      }
      if (r && r.total > 200) slowest.push([t, r.total]);
    } catch (e) {
      console.log(`\n[${t}] 跑失败：${e.message}`);
    }
  }

  if (slowest.length) {
    console.log('\n' + '='.repeat(78));
    console.log('超过 200ms 的接口（这几条是真正的瓶颈）');
    console.log('='.repeat(78));
    for (const [t, ms] of slowest.sort((a, b) => b[1] - a[1])) {
      console.log(`  ${t.padEnd(12)} ${ms.toFixed(0)} ms`);
    }
    console.log('\n下一步：对最慢的那条 SQL 跑 EXPLAIN QUERY PLAN，看是不是全表扫。');
  }
}

main();
