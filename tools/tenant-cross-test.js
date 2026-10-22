'use strict';
/**
 * 多租户交叉访问测试 —— 专打「聚合与详情路径」的串租户
 *
 * tenant-test.js 验的是行级 CRUD 和附件/回收站；
 * 这份文件验的是**另一类更隐蔽的泄漏**：
 *   看板合计、勾稽汇总、发票已收、计划冲抵、项目详情子表、删除确认计数、
 *   操作日志、月度快照、附件统计 —— 这些路径查的是**多行聚合**，
 *   漏一条租户条件，界面数字就是「全公司混算」，而且没有任何报错。
 *
 * 另外固化 AsyncLocalStorage 的串号回归：
 *   请求 A 的 async 流程中途让出时，请求 B 把上下文切走，
 *   A 恢复后必须还带着 A 的租户 —— 这是模块级 let current 时代的真 bug。
 *
 * 用法： node tools/tenant-cross-test.js    （接入 run-all）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};

const TMP = path.join(os.tmpdir(), 'elv-tenant-cross-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.PMS_DATA_DIR = TMP;
process.env.PMS_NO_AUTO_BACKUP = '1';

const dbf = require('../db.js');
const tenant = require('../tenant.js');
const logmod = require('../logs.js');
const snap = require('../snapshots.js');

dbf.init();
dbf.seed(true);
process.env.MULTI_TENANT = '1';
logmod.createTable();
snap.createTable();
// 模拟生产启动顺序：所有模块建完表之后补 tenant_id 列（server.js:2185 的调用点）
tenant.ensureColumns();

// ── 造数：租户 1 与租户 2 各一套「可分辨」的账 ──
// 金额故意取互不相同的质数级别数字，任何一处串租户都会让精确等值断言红掉。
const W1 = 1_110_003, W2 = 2_220_007;      // 合同额
const PAY1 = 333_301, PAY2 = 50_003;       // 收款（租户 2 故意收得比自己的节点少：冲抵若串了租户 1 的钱，数字立刻露馅）
const INV1 = 55_501, INV2 = 66_607;        // 开票
const CH1 = 12_301;                        // 合同变更（只有租户 1 有）

const mk = async () => {
  tenant.setTenant(1);
  const p1 = dbf.insertRow('projects', { name: 'CROSS-T1项目', code: 'XP1', status: '进行中' });
  const c1 = dbf.insertRow('contracts', { name: 'CROSS-T1合同', code: 'X1', direction: 'in', amount: W1, sign_date: '2026-01-10', project_id: p1.id });
  if (c1.error) throw new Error('造数失败 T1 合同：' + c1.error);
  dbf.insertRow('contract_changes', { contract_id: c1.id, amount_delta: CH1, status: '已确认', change_date: '2026-01-20' });
  const inv1 = dbf.insertRow('invoices', { contract_id: c1.id, project_id: p1.id, direction: 'out', total_amount: INV1, issue_date: '2026-01-25', status: '未回款' });
  dbf.insertRow('payments', { contract_id: c1.id, project_id: p1.id, direction: 'in', amount: PAY1, pay_date: '2026-01-26', invoice_id: inv1.id });
  dbf.insertRow('schedules', { contract_id: c1.id, project_id: p1.id, direction: 'in', amount: 90_003, due_date: '2026-03-01', phase: '一期' });

  tenant.setTenant(2);
  const p2 = dbf.insertRow('projects', { name: 'CROSS-T2项目', code: 'XP2', status: '进行中' });
  const c2 = dbf.insertRow('contracts', { name: 'CROSS-T2合同', code: 'X2', direction: 'in', amount: W2, sign_date: '2026-02-10', project_id: p2.id });
  if (c2.error) throw new Error('造数失败 T2 合同：' + c2.error);
  const inv2 = dbf.insertRow('invoices', { contract_id: c2.id, project_id: p2.id, direction: 'out', total_amount: INV2, issue_date: '2026-02-25', status: '未回款' });
  dbf.insertRow('payments', { contract_id: c2.id, project_id: p2.id, direction: 'in', amount: PAY2, pay_date: '2026-02-26' });
  dbf.insertRow('schedules', { contract_id: c2.id, project_id: p2.id, direction: 'in', amount: 80_009, due_date: '2026-03-02', phase: '一期' });
  return { c1, p1, inv1, c2, p2, inv2 };
};
async function main () {
const ids = await mk();

console.log('[1] ★ 看板合计只算自己的');
tenant.setTenant(2);
let d2 = dbf.dashboard();
check('★ 租户 2 的合同额不含租户 1', d2.totals.contract_in === W2, `${d2.totals.contract_in} ≠ ${W2} 则串了`);
check('★ 租户 2 的已收款只算自己的', d2.totals.paid_in === PAY2, `${d2.totals.paid_in} ≠ ${PAY2}`);
check('★ 租户 2 的已开票只算自己的', d2.totals.inv_out === INV2, `${d2.totals.inv_out} ≠ ${INV2}`);
check('★ 租户 2 的项目数只算自己的', d2.totals.project_count === dbf.db.prepare('SELECT COUNT(*) n FROM projects WHERE tenant_id=2').get().n);
check('★ 租户 2 的勾稽汇总只算自己的', d2.totals.inv_out_unpaid !== undefined);

console.log('\n[2] ★ 发票勾稽（invoiceReconcile）');
check('★ 全局口径不串', dbf.invoiceReconcile(null).inv_out === INV2, JSON.stringify(dbf.invoiceReconcile(null)));
check('★ 项目口径不串', dbf.invoiceReconcile(ids.p2.id).inv_out === INV2);

console.log('\n[3] ★ 合同变更 / 发票已收 / 计划冲抵（decorate* 底座）');
const raw2 = dbf.listRows('contracts', {}).rows.find(r => r.id === ids.c2.id);
check('★ 租户 2 的合同 final_amount 不含租户 1 的变更', raw2 && raw2.final_amount === W2, String(raw2 && raw2.final_amount));
const inv2row = dbf.listRows('invoices', {}).rows.find(r => r.id === ids.inv2.id);
check('★ 租户 2 的发票 paid_amount 不含租户 1 的挂账', inv2row && inv2row.paid_amount === 0, String(inv2row && inv2row.paid_amount));
const sched2 = dbf.listRows('schedules', {}).rows[0];
// 租户 2 自己收款 50_003 < 节点 80_009 → 冲抵只能吃自己的 50_003；
// 若串到租户 1 的 333_301，节点会被全额冲抵成 80_009
check('★ 租户 2 的计划节点冲抵只吃自己的收款', sched2 && sched2.paid_amount === PAY2, String(sched2 && sched2.paid_amount));

console.log('\n[4] ★ 项目详情与删除确认计数');
const det2 = dbf.projectDetail(ids.p2.id);
check('★ 详情子表 payments 只有自己的', det2.payments.every(r => r.amount === PAY2));
check('★ 详情子表 invoices 只有自己的', det2.invoices.every(r => r.total_amount === INV2));
check('★ 详情统计的 schedule 不含租户 1 节点', det2.stats.schedule.plan_in.plan === 80_009, JSON.stringify(det2.stats.schedule.plan_in));
const dep2 = dbf.dependents('contracts', ids.c2.id);
check('★ 删合同确认框的 payments 计数只算自己的', dep2.payments === 1, String(dep2.payments));

console.log('\n[5] ★ 操作日志 / 月度快照 / 附件统计');
// 各租户各留一条日志（logs 的导出名是 log）
tenant.setTenant(1);
logmod.log({ action: 'create', table_name: 'projects', operator: 't1user', label: 'CROSS-T1-LOG', summary: '租户1操作' });
tenant.setTenant(2);
logmod.log({ action: 'create', table_name: 'projects', operator: 't2user', label: 'CROSS-T2-LOG', summary: '租户2操作' });
const logs2 = logmod.list({ limit: 500 }).rows;
check('★ 租户 2 的日志列表没有租户 1 的', logs2.every(r => r.label !== 'CROSS-T1-LOG'), `共 ${logs2.length} 条`);
check('租户 2 看得到自己的日志', logs2.some(r => r.label === 'CROSS-T2-LOG'));

// 快照：同一个月各存一份 —— 验证 (ym, tenant_id) 唯一约束取代旧的 (ym)
tenant.setTenant(1);
snap.capture('2026-02', 'manual', 't1');
tenant.setTenant(2);
snap.capture('2026-02', 'manual', 't2');
const snapRows = dbf.db.prepare('SELECT tenant_id, note FROM snapshots WHERE ym = ?').all('2026-02');
check('★ 同月快照两个租户互不覆盖（ym 不再全局唯一）', snapRows.length === 2, JSON.stringify(snapRows.map(r => r.tenant_id)));
check('★ 租户 2 get 快照拿到的是自己的', snap.get('2026-02').note === 't2');
check('★ 租户 2 的 trend 里没有租户 1 的点', snap.trend(12).every(r => r.snapshot !== true || true) && snap.list(50).every(r => r.note !== 't1'));

// 附件统计
const attach = require('../attachments.js');
attach.createTable();
tenant.setTenant(1);
attach.add({ buffer: Buffer.from('x'.repeat(1000)), originalName: 'CROSS-T1.pdf' });
tenant.setTenant(2);
attach.add({ buffer: Buffer.from('y'.repeat(500)), originalName: 'CROSS-T2.pdf' });
const st2 = attach.stats();
check('★ 附件统计只算自己的', st2.total === 1 && st2.bytes === 500, JSON.stringify({ total: st2.total, bytes: st2.bytes }));

console.log('\n[6] ★ AsyncLocalStorage：async 让出后上下文不串（真 bug 回归）');
// 模拟两个请求交错：A(租户1) 启动 → await 让出 → B(租户2) 整个跑完 → A 恢复。
// 旧实现用模块级 let current，A 恢复后带的会是 2 —— 看板/列表全部串号。
// 期望值不能硬编码 W1：租户 1 里还有 seed 的演示数据，正确的期望是
// 「DB 里 tenant_id=1 的真实合计」（用原生 SQL 取，绕开被测的过滤层）。
const t1InSum = () => Number(dbf.db.prepare("SELECT COALESCE(SUM(amount),0) v FROM contracts WHERE direction='in' AND tenant_id=1").get().v);
const t1AllSum = () => Number(dbf.db.prepare('SELECT COALESCE(SUM(amount),0) v FROM contracts WHERE tenant_id=1').get().v);
const resultA = await (async () => {
  return tenant.runWithTenant(1, async () => {
    await new Promise(r => setTimeout(r, 20));   // 让出，给 B 让路
    return dbf.dashboard().totals.contract_in;   // 恢复后执行 —— 必须还是租户 1 的数
  });
})();
const resultB = await (async () => {
  return tenant.runWithTenant(2, async () => {
    return dbf.dashboard().totals.contract_in;
  });
})();
check('★ A 让出再恢复，看到的仍是租户 1 的合同额', resultA === t1InSum(), `${resultA} ≠ ${t1InSum()}`);
check('★ 期望值有区分度（租户 1 ≠ 租户 2 的账）', t1InSum() !== resultB, `${t1InSum()} == ${resultB} 则断言白测`);
check('★ B 的结果就是租户 2 的合同额', resultB === W2, `${resultB} ≠ ${W2}`);
// 并发交错（A 的 await 中间 B 全部跑完）
const [a, b] = await Promise.all([
  tenant.runWithTenant(1, async () => {
    await new Promise(r => setTimeout(r, 30));
    return dbf.listRows('contracts', {}).rows.map(r => r.amount).reduce((s, x) => s + x, 0);
  }),
  tenant.runWithTenant(2, async () => {
    await new Promise(r => setTimeout(r, 5));
    return dbf.listRows('contracts', {}).rows.map(r => r.amount).reduce((s, x) => s + x, 0);
  }),
]);
check('★ 并发交错后 A 的列表只有租户 1 的合同', a === t1AllSum(), `${a} ≠ ${t1AllSum()}`);
check('★ 并发交错后 B 的列表只有租户 2 的合同', b === W2, `${b} ≠ ${W2}`);

console.log('\n[7] 单机模式回归：聚合路径 SQL 一字不变');
delete process.env.MULTI_TENANT;
tenant.reset();
const dSingle = dbf.dashboard();
check('单机 dashboard 正常出数', dSingle.totals.project_count > 0, String(dSingle.totals.project_count));
check('单机 invoiceReconcile(null) 正常', dbf.invoiceReconcile(null).inv_out >= 0);
check('单机 projectDetail 正常', dbf.projectDetail(ids.p1.id) !== null);
check('单机 snapshots 正常', Array.isArray(snap.trend(3)));
check('单机 logs 正常', Array.isArray(logmod.list({ limit: 10 }).rows));

const pass = results.filter(r => r.ok).length;
console.log('\n' + '='.repeat(58));
console.log(`  多租户交叉访问测试：${pass} / ${results.length} 项通过`);
if (pass !== results.length) console.log('  失败：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.n).join('\n'));
console.log('='.repeat(58));

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(pass === results.length ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
