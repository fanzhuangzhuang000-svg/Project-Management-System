'use strict';
/**
 * 性能与规模回归测试
 *
 * 这里防的是「悄悄退化成 N+1」这类问题：
 *   - 每个项目跑一组查询 → 项目越多越慢
 *   - 分页在内存里切片 → 表越大越慢
 * 这类退化功能上完全正确、测试全绿，只有数据量上来才暴露，所以单独守一道。
 *
 * 用法： node tools/perf-test.js
 */
const dbf = require('../db.js');
const { db } = dbf;

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

/** 统计一段代码里执行了多少条 SQL，以及都执行了什么 */
function traceSql (fn) {
  const orig = db.prepare.bind(db);
  const sqls = [];
  db.prepare = (sql) => { sqls.push(sql); return orig(sql); };
  try { return { ret: fn(), sqls }; } finally { db.prepare = orig; }
}

const tempProjects = [];

console.log('[1] 总览不能退化成 N+1');
try {
  const base = traceSql(() => dbf.dashboard());
  const baseCount = base.sqls.length;
  const baseProjects = dbf.dashboard().totals.project_count;

  // 再塞 40 个项目，如果实现是「每项目一组查询」，SQL 条数会线性涨上去
  const ts = dbf.nowISO();
  const ins = db.prepare(`INSERT INTO projects (code,name,category,status,manager,progress,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,0,?,?)`);
  db.exec('BEGIN');
  for (let i = 0; i < 40; i++) {
    const r = ins.run(`PERF-${String(i).padStart(3, '0')}`, `性能测试项目 ${i}`, '综合布线', '进行中', `经理${i}`, 10, ts, ts);
    tempProjects.push(Number(r.lastInsertRowid));
  }
  db.exec('COMMIT');

  const after = traceSql(() => dbf.dashboard());
  const afterCount = after.sqls.length;
  const afterProjects = dbf.dashboard().totals.project_count;
  const grew = afterProjects - baseProjects;

  check('新增项目后项目数确实变了', grew === 40, `${baseProjects} → ${afterProjects}`);
  // 关键断言：SQL 条数不应随项目数线性增长。允许固定开销有几个的浮动。
  check('SQL 条数不随项目数增长（无 N+1）', afterCount - baseCount <= 5,
    `项目 +${grew} 个，SQL ${baseCount} → ${afterCount} 条`);

  // 时间也不能线性涨
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 5; i++) dbf.dashboard();
  const msWhenMore = Number(process.hrtime.bigint() - t0) / 1e6 / 5;
  check('总览耗时仍在可接受范围（< 80ms）', msWhenMore < 80, `${msWhenMore.toFixed(1)} ms`);
} catch (e) {
  check('总览不能退化成 N+1', false, e.message);
} finally {
  if (tempProjects.length) {
    const ph = tempProjects.map(() => '?').join(',');
    db.prepare(`DELETE FROM projects WHERE id IN (${ph})`).run(...tempProjects);
  }
}

console.log('[2] 分页要下推到 SQL');
try {
  const paged = traceSql(() => dbf.listRows('payments', { limit: 20, offset: 0 }));
  check('分页查询里带了 LIMIT', paged.sqls.some(s => /\bLIMIT\b/i.test(s)),
    paged.sqls.some(s => /\bLIMIT\b/i.test(s)) ? '有 LIMIT' : '没找到 LIMIT（说明在内存里切片）');
  check('分页时只取回一页数据', paged.ret.rows.length <= 20, `${paged.ret.rows.length} 行`);
  check('仍然返回正确的总数', paged.ret.total === db.prepare('SELECT COUNT(*) n FROM payments').get().n,
    `total=${paged.ret.total}`);

  const all = traceSql(() => dbf.listRows('payments', {}));
  check('不传 limit 时返回全部', all.ret.rows.length === all.ret.total, `${all.ret.rows.length} 行`);
  check('不分页时不加 LIMIT', !all.sqls.some(s => /\bLIMIT\b/i.test(s)), '未加 LIMIT');
} catch (e) {
  check('分页要下推到 SQL', false, e.message);
}

console.log('[3] 项目台账不再逐行查库');
try {
  const r = traceSql(() => dbf.listRows('projects', { limit: 5, offset: 0 }));
  check('取 5 个项目时 SQL 条数受控（< 20）', r.sqls.length < 20, `${r.sqls.length} 条`);
  check('返回的是 5 行', r.ret.rows.length <= 5, `${r.ret.rows.length} 行`);
  check('虚拟列仍被填上', r.ret.rows.every(x => x.contract_in !== undefined && x.receivable !== undefined),
    'contract_in / receivable 都有值');
} catch (e) {
  check('项目台账不再逐行查库', false, e.message);
}

console.log('[4] 统计口径与逐项计算一致');
try {
  const ids = db.prepare('SELECT id FROM projects ORDER BY id').all().map(r => r.id);
  const many = dbf.projectStatsMany(ids);
  check('每个项目都有统计结果', Object.keys(many).length === ids.length, `${Object.keys(many).length} / ${ids.length}`);

  let bad = 0;
  for (const id of ids) {
    const s = many[id];
    const ok = Math.abs(s.receivable - (s.contract_in - s.paid_in)) < 0.02
      && Math.abs(s.actual_profit - (s.contract_in - s.cost)) < 0.02
      && Math.abs(s.payable - (s.payable_contract + s.payable_expense)) < 0.02
      && Math.abs(s.change_in - (s.contract_in - s.contract_in_base)) < 0.02
      && Math.abs(s.gross_profit - (s.contract_in_ex - s.contract_out_ex)) < 0.02;
    if (!ok) bad++;
  }
  check('单项目内部口径自洽', bad === 0, bad ? `${bad} 个项目对不上` : `${ids.length} 个项目全部自洽`);

  // 汇总口径 = 各项目之和（虚拟列不能串）
  const d = dbf.dashboard();
  const sumOf = (k) => ids.reduce((s, id) => s + (many[id][k] || 0), 0);
  const pairs = [['contract_in', 'contract_in'], ['paid_in', 'paid_in'], ['cost', 'cost'], ['receivable', 'receivable']];
  let mismatch = [];
  for (const [totalKey, statKey] of pairs) {
    const a = d.totals[totalKey], b = Math.round(sumOf(statKey) * 100) / 100;
    if (Math.abs(a - b) > 0.5) mismatch.push(`${totalKey}: ${a} vs ${b}`);
  }
  check('总览合计 = 各项目之和', mismatch.length === 0, mismatch.join('；') || '四项金额都对得上');
} catch (e) {
  check('统计口径与逐项计算一致', false, e.message);
}

console.log('[5] 下拉选项只下发用得到的表');
try {
  const opts = dbf.refOptions();
  const need = dbf.refTables();
  const keys = Object.keys(opts);
  check('只包含被引用的表', keys.every(k => need.has(k)),
    `下发了 ${keys.join(', ')}（共 ${keys.length} 张）`);
  const notNeeded = Object.keys(require('../schema.js').TABLES).filter(t => !need.has(t) && keys.includes(t));
  check('未被当作外键的表不下发', notNeeded.length === 0,
    notNeeded.length ? '多余：' + notNeeded.join(',') : `省掉了 ${Object.keys(require('../schema.js').TABLES).length - keys.length} 张表`);
  const size = JSON.stringify(opts).length;
  check('选项体积受控（< 400KB）', size < 400 * 1024, `${(size / 1024).toFixed(0)} KB`);
} catch (e) {
  check('下拉选项只下发用得到的表', false, e.message);
}

const pass = results.filter(r => r.ok).length;
console.log(`\n性能回归测试结果：${pass} / ${results.length} 项通过`);
process.exit(pass === results.length ? 0 : 1);
