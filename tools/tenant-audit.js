'use strict';
/**
 * 多租户隔离审计 —— 把所有「查业务表却没带 tenant_id」的 SQL 全找出来
 *
 * 为什么需要这个而不是人眼看：
 *   多租户的错不是「条件写错」，是「**漏写**」。二十多张表、几百条 SQL，
 *   漏一条就在那条路径上跨租户读数据；而单机模式下 scope() 返回空串，
 *   漏不漏完全看不出来 —— 本地怎么测都是对的，一到客户那边就是数据串号。
 *
 * 做法：开 MULTI_TENANT=1，把 db.prepare 包一层，
 * 凡是 SELECT/UPDATE/DELETE 碰到业务表、SQL 里又没有 tenant_id 的，全部记下来
 * （只记录、不抛错，这样能一次跑完收集全量清单）。
 * 然后逐个 dbf 导出函数跑一遍，按「函数 → 缺条件的表」归总。
 *
 * 用法：
 *   node tools/tenant-audit.js                 # 默认数据目录
 *   PMS_DATA_DIR=C:/pms-load-data node tools/tenant-audit.js
 *
 * 退出码：有漏点 → 1（可以挂到 CI 上，防止以后新增查询又漏）
 */
const path = require('node:path');
const os = require('node:os');

process.env.MULTI_TENANT = '1';
process.env.PMS_NO_AUTO_BACKUP = '1';
process.env.PMS_MAINTENANCE_INTERVAL_MS = '0';
if (!process.env.PMS_DATA_DIR) {
  process.env.PMS_DATA_DIR = path.join(os.tmpdir(), 'pms-load');
}

const dbf = require('../db.js');
const db = dbf.db;

const TENANT_TABLES = ['projects', 'contracts', 'contract_changes', 'schedules', 'payments',
  'invoices', 'expenses', 'materials', 'partners', 'maintenance', 'attachments', 'logs',
  'snapshots', 'trash'];

// ── 只记录不抛错（要一次收集全量漏点）──
let bucket = null;               // 当前正在测的函数名
const found = new Map();         // "函数|表" -> { n, sample }
const origPrepare = db.prepare.bind(db);

db.prepare = function (sql) {
  const s = String(sql || '');
  // /* tenant-global */：孤儿清理、快照容量回收这类「有意的跨租户全局操作」豁免
  if (/tenant-global/i.test(s)) return origPrepare(sql);
  if (/sqlite_master|information_schema/i.test(s)) return origPrepare(sql);   // 目录/元数据查询不碰业务行
  const touchesRows = /\b(from|update)\b/i.test(s) || /^\s*delete\s+from/i.test(s);
  if (touchesRows && !/tenant_id/i.test(s)) {
    const hit = TENANT_TABLES.find(t => new RegExp(`\\b${t}\\b`, 'i').test(s));
    if (hit) {
      const key = (bucket || '(未归类)') + '|' + hit;
      const e = found.get(key) || { n: 0, sample: s.replace(/\s+/g, ' ').trim().slice(0, 150) };
      e.n++;
      found.set(key, e);
    }
  }
  return origPrepare(sql);
};

function probe (label, fn) {
  bucket = label;
  try { fn(); } catch (e) {
    // 审计过程中允许别的错误（参数不对等），只要 SQL 漏点被记下来就够了
    if (!/租户守卫/.test(e.message)) {
      console.log(`  ! ${label} 执行出错：${e.message.slice(0, 80)}`);
    }
  }
  bucket = null;
}

function main () {
  dbf.init();
  require('../attachments.js').createTable();
  require('../logs.js').createTable();
  require('../snapshots.js').createTable();
  require('../trash.js').createTable();

  // 取样查询是审计工具自己拿 id 用的，故意全局（带豁免标记，别把自己算进漏点）
  const pj = db.prepare('SELECT id FROM projects /* tenant-global */ ORDER BY id LIMIT 1').get();
  const ct = db.prepare('SELECT id FROM contracts /* tenant-global */ ORDER BY id LIMIT 1').get();
  const pid = pj ? pj.id : 1;
  const cid = ct ? ct.id : 1;

  console.log('多租户审计：MULTI_TENANT=1，按「函数 → 缺 tenant_id 的表」收集\n');

  // 只读路径（这些是泄漏面最大的：列表、详情、看板、对账、导出）
  for (const t of ['projects', 'contracts', 'payments', 'invoices', 'schedules',
    'expenses', 'materials', 'maintenance', 'partners', 'contract_changes']) {
    probe('listRows(' + t + ')', () => dbf.listRows(t, { limit: 20 }));
  }
  probe('getRow(projects)', () => dbf.getRow('projects', pid));
  probe('getRow(contracts)', () => dbf.getRow('contracts', cid));
  probe('dependents(projects)', () => dbf.dependents('projects', pid));
  probe('dependents(contracts)', () => dbf.dependents('contracts', cid));
  probe('dashboard()', () => dbf.dashboard());
  probe('dashboardFor()', () => dbf.dashboardFor({ all: true }));
  probe('projectStats()', () => dbf.projectStats(pid));
  probe('projectStatsMany()', () => dbf.projectStatsMany([pid]));
  probe('projectDetail()', () => dbf.projectDetail(pid));
  probe('refOptions()', () => dbf.refOptions('contracts'));
  probe('refOptionsCount()', () => dbf.refOptionsCount('contracts'));
  probe('invoiceReconcile()', () => dbf.invoiceReconcile(null));
  probe('invoicePaidMap()', () => dbf.invoicePaidMap([pid]));
  probe('changeMap()', () => dbf.changeMap([cid]));
  probe('scheduleAllocation()', () => dbf.scheduleAllocation());
  probe('scheduleStats()', () => dbf.scheduleStats(pid));
  probe('decorateSchedules()', () => dbf.decorateSchedules([{ id: 1, project_id: pid, direction: 'in', amount: 100, due_date: '2026-01-01' }]));
  probe('decorateInvoices()', () => dbf.decorateInvoices([{ id: 1, project_id: pid, direction: 'in' }]));
  probe('recordCounts()', () => dbf.recordCounts());

  // 各模块自己的列表
  try { probe('attach.list()', () => require('../attachments.js').list({ limit: 20 })); } catch { /* 忽略 */ }
  try { probe('attach.stats()', () => require('../attachments.js').stats()); } catch { /* 忽略 */ }
  try { probe('logs.list()', () => require('../logs.js').list({ limit: 20 })); } catch { /* 忽略 */ }
  try { probe('trash.list()', () => require('../trash.js').list({ limit: 20 })); } catch { /* 忽略 */ }
  try { probe('snap.trend()', () => require('../snapshots.js').trend(12)); } catch { /* 忽略 */ }

  // ── 报告 ──
  const rows = [...found.entries()].map(([k, v]) => {
    const [fn, table] = k.split('|');
    return { fn, table, ...v };
  }).sort((a, b) => (a.fn === b.fn ? a.table.localeCompare(b.table) : a.fn.localeCompare(b.fn)));

  console.log('\n' + '='.repeat(80));
  if (!rows.length) {
    console.log('没有发现漏点：所有涉及业务表的查询都带了 tenant_id。');
    console.log('='.repeat(80));
    return 0;
  }
  console.log(`共 ${rows.length} 个「函数 × 表」组合缺 tenant_id 条件`);
  console.log('='.repeat(80));

  let lastFn = '';
  for (const r of rows) {
    if (r.fn !== lastFn) { console.log(`\n${r.fn}`); lastFn = r.fn; }
    console.log(`    ${r.table.padEnd(18)} ${String(r.n).padStart(3)} 次   ${r.sample.slice(0, 100)}`);
  }

  const byTable = {};
  for (const r of rows) byTable[r.table] = (byTable[r.table] || 0) + 1;
  console.log('\n按表汇总（数字 = 有多少个函数漏了这张表的条件）：');
  Object.entries(byTable).sort((a, b) => b[1] - a[1])
    .forEach(([t, n]) => console.log(`    ${t.padEnd(18)} ${n}`));

  console.log('\n结论：以上每一处，在多租户部署下都会把别的部门/分公司的数据算进来。');
  console.log('修法不是逐条补条件，而是统一收口（见 db.js 里 selectSQL / 各聚合函数的改法）。');
  return 1;
}

process.exitCode = main();
