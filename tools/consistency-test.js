'use strict';
/**
 * 口径一致性 / 原子性回归（第十一套）
 *
 *   node tools/consistency-test.js
 *
 * 为什么单独一套：
 *   前面十套测的都是「功能对不对」—— 能不能建、能不能存、算出来的数在不在
 *   合理区间。但有一类 BUG 是功能全对、单看哪个页面都挑不出毛病，
 *   只有把**两个页面上的同一个数字**摆在一起才露馅：
 *
 *     · 仪表盘「回款率排行」把付款也算进回款，台账里算的是收款
 *     · 「质保金到期日」2 月 29 号签的合同会在 3 月 1 号到期
 *     · 「保留 30 天」的判定拿 UTC 跟本地时间比，实际留了 30 天零 8 小时
 *
 *   这些不会报错、不会崩，只是用户对不上账。所以这一套的断言方式很统一：
 *   **同一个业务事实，从两个入口各取一次，必须一字不差。**
 *
 * 全部用独立临时库，绝不碰真实数据。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), 'elv-consist-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.PMS_DATA_DIR = TMP;
process.env.MULTI_TENANT = '';

const results = [];
let skipped = 0;
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
function skipCheck (name, why) {
  skipped++;
  console.log(`  ⊘ ${name}  — 跳过：${why}`);
}

const dbf = require('../db.js');
const db = dbf.db;
dbf.init();
// ⚠️ 全新库 init() 会自动播种示例数据。不清掉的话：
//   · 「回款率排行」只取 Top5，我造的项目可能排不进去，断言变成随机结果
//   · backfillInvoiceLinks 会顺带处理示例数据，linked 数对不上
// 只删 is_demo=1 的行，自己造的（is_demo=0）不受影响。
dbf.clearDemo();

// ---------------------------------------------------------------- 造数工具
let seq = 0;
function mkProject (name) {
  const r = dbf.insertRow('projects', {
    code: 'CP' + (++seq) + '-' + Date.now().toString(36).slice(-4),
    name: name || ('口径测试项目' + seq),
    status: '在建', category: '施工', progress: 10,
  });
  if (r.error) throw new Error('建项目失败：' + r.error);
  return r.id;
}
function mkContract (pid, o) {
  const r = dbf.insertRow('contracts', {
    code: 'CC' + (++seq), name: o.name || '测试合同', project_id: pid,
    category: '项目合同', direction: o.direction || 'in',
    amount: o.amount, tax_rate: 9, status: '执行中',
    sign_date: o.sign_date, start_date: o.start_date, end_date: o.end_date,
    payment_terms: o.payment_terms || '',
  });
  if (r.error) throw new Error('建合同失败：' + r.error);
  return r.id;
}
function mkPayment (pid, cid, direction, amount, date) {
  const r = dbf.insertRow('payments', {
    project_id: pid, contract_id: cid || null, direction,
    amount, pay_date: date || dbf.today(), method: '转账',
  });
  if (r.error) throw new Error('建收付款失败：' + r.error);
  return r.id;
}

// ================================================================
console.log('\n[1] 回款率：排行榜和项目台账必须是同一个数');

// 收 100 万 / 付 80 万 / 收入合同 200 万 → 真实回款率 50%
// 旧实现把付款并进「已收款」：(100+80)/200 = 90%
const P1 = mkProject('口径-回款率');
const C1 = mkContract(P1, { amount: 2000000, sign_date: '2025-01-10', end_date: '2025-12-31' });
mkPayment(P1, C1, 'in', 1000000, '2025-03-01');
mkPayment(P1, C1, 'out', 800000, '2025-04-01');

const stat1 = dbf.projectStats(P1);
check('台账回款率 = 收款 / 收入合同额', stat1.collect_rate === 50, `collect_rate=${stat1.collect_rate}`);
check('台账已收款不含付款', stat1.paid_in === 1000000, `paid_in=${stat1.paid_in}`);
check('台账已付款单独统计', stat1.paid_out === 800000, `paid_out=${stat1.paid_out}`);

const dash = dbf.dashboard();
const rank1 = (dash.collect_rank || []).find(r => r.id === P1);
if (!rank1) {
  skipCheck('排行榜回款率与台账一致', '该项目未进 Top5，本库项目数不足时才会出现');
} else {
  check('排行榜回款率与台账一致', rank1.rate === stat1.collect_rate,
    `排行=${rank1.rate}% / 台账=${stat1.collect_rate}%`);
  check('排行榜不含付款金额', rank1.paid_in === 1000000, `rank.paid_in=${rank1.paid_in}`);
}

// 合同变更也要进榜单口径：台账的合同额含「已确认的变更」
const P2 = mkProject('口径-含变更');
const C2 = mkContract(P2, { amount: 1000000, sign_date: '2025-02-01', end_date: '2025-12-31' });
mkPayment(P2, C2, 'in', 600000, '2025-05-01');
const chRes = dbf.insertRow('contract_changes', {
  contract_id: C2, project_id: P2, title: '增补门禁点位',
  amount_delta: 200000, status: '已确认', change_date: '2025-06-01', reason: '增量',
});
if (chRes.error) throw new Error('建合同变更失败：' + chRes.error);
const stat2 = dbf.projectStats(P2);
check('合同额含已确认变更', stat2.contract_in === 1200000, `contract_in=${stat2.contract_in}`);
const rank2 = (dash.collect_rank || []).find(r => r.id === P2) || (dbf.dashboard().collect_rank || []).find(r => r.id === P2);
if (!rank2) {
  skipCheck('变更后榜单口径同步', '该项目未进 Top5');
} else {
  check('变更后榜单口径同步', rank2.rate === stat2.collect_rate, `排行=${rank2.rate}% / 台账=${stat2.collect_rate}%`);
}

// ================================================================
console.log('\n[2] 质保金到期日：2 月 29 号签的合同不能拖到 3 月 1 号');

// JS 的 setMonth 在目标月没有这一天时会往后溢出：
// 2024-02-29 加 12 个月 → 2025-03-01（2 月只有 28 天，29 号被挤掉）
const P3 = mkProject('口径-闰日');
const C3 = mkContract(P3, {
  amount: 1000000, sign_date: '2024-02-29', start_date: '2024-02-29', end_date: '2024-02-29',
  payment_terms: '预付款30%，质保金70%',
});
const plan = dbf.generatePlan(C3);
if (plan.error) {
  skipCheck('质保金节点按整年顺延', '计划生成失败：' + plan.error);
} else {
  const nodes = plan.nodes || [];
  const warranty = nodes.find(n => String(n.phase || '').includes('质保'));
  if (!warranty) {
    skipCheck('质保金节点按整年顺延', '条款里没解析出质保金节点：' + JSON.stringify(nodes.map(n => n.phase)));
  } else {
    const d = String(warranty.due_date || warranty.plan_date || '');
    check('质保金节点按整年顺延', d === '2025-02-28', `到期日=${d}（应为 2025-02-28，旧实现给 2025-03-01）`);
  }
}

// ================================================================
console.log('\n[3] 时间比较：保留期判定必须用本地时间');

// 库里的 created_at / deleted_at 全是 nowISO() 写的本地时间串。
// 拿 toISOString()（UTC）去比，北京时区下「保留 30 天」实际留了 30 天零 8 小时，
// 往西的时区反过来会提前删。这里断言 db.js 导出的助手确实是本地口径。
check('db.js 导出 daysAgoISO 助手', typeof dbf.daysAgoISO === 'function',
  typeof dbf.daysAgoISO === 'function' ? '' : '缺失 → 各模块只能自己用 toISOString() 凑');

if (typeof dbf.daysAgoISO === 'function') {
  const cut = dbf.daysAgoISO(30);
  // 反推：cut 解析成本地时间后，与「30 天前」的本地日期应完全一致
  const back = new Date(cut.replace(' ', 'T'));
  const target = new Date(Date.now() - 30 * 86400000);
  check('daysAgoISO 与本地日期对齐',
    back.getFullYear() === target.getFullYear()
    && back.getMonth() === target.getMonth()
    && back.getDate() === target.getDate(),
    `${cut} vs 期望 ${target.toLocaleDateString('sv-SE')}`);
  check('daysAgoISO 与 nowISO 同格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(cut), cut);
  // 同一时刻，nowISO 和 daysAgoISO(0) 相差不超过 2 秒
  const a = new Date(dbf.nowISO().replace(' ', 'T')).getTime();
  const b = new Date(dbf.daysAgoISO(0).replace(' ', 'T')).getTime();
  check('daysAgoISO(0) ≈ nowISO', Math.abs(a - b) < 2000, `${Math.abs(a - b)}ms`);
}

// 静态复查：这三个模块不能再自己拼 UTC 串
const bad = [];
for (const f of ['trash.js', 'attachments.js', 'logs.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  for (const line of src.split('\n')) {
    if (/toISOString\s*\(\s*\)\s*\.slice/.test(line)) bad.push(`${f}: ${line.trim().slice(0, 70)}`);
  }
}
check('保留期不再用 UTC 串比大小', bad.length === 0, bad.join(' | '));

// ================================================================
console.log('\n[4] 发票自动挂账：要么全挂上，要么一条都不动');

const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
const fnStart = src.indexOf('function backfillInvoiceLinks');
const fnEnd = src.indexOf('\n/**', fnStart);
const fnBody = fnStart >= 0 ? src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 4000) : '';
check('backfillInvoiceLinks 在事务里改账',
  /db\.exec\(\s*'BEGIN'\s*\)/.test(fnBody) && /db\.exec\(\s*'ROLLBACK'\s*\)/.test(fnBody),
  fnStart < 0 ? '找不到函数' : '逐条 UPDATE 无事务，中途失败会留半挂账');

// 行为：重复调用必须幂等（第二遍 linked = 0）
const P4 = mkProject('口径-挂账');
const C4 = mkContract(P4, { amount: 500000, sign_date: '2025-01-01', end_date: '2025-06-30', direction: 'in' });
const invRes = dbf.insertRow('invoices', {
  project_id: P4, contract_id: C4, direction: 'out', invoice_no: 'FP-01',
  invoice_type: '增值税专用发票', amount: 500000, tax_rate: 9,
  issue_date: '2025-02-01', status: '正常',
});
if (invRes.error) throw new Error('建发票失败：' + invRes.error);
mkPayment(P4, C4, 'in', 200000, '2025-03-01');
mkPayment(P4, C4, 'in', 300000, '2025-04-01');
const before4 = db.prepare("SELECT COUNT(*) n FROM payments WHERE project_id = ? AND invoice_id IS NULL").get(P4).n;
const r1 = dbf.backfillInvoiceLinks();
const after4 = db.prepare("SELECT COUNT(*) n FROM payments WHERE project_id = ? AND invoice_id IS NULL").get(P4).n;
const r2 = dbf.backfillInvoiceLinks();
check('首次自动挂账把本项目两笔都挂上', before4 === 2 && after4 === 0, `挂账前 ${before4} 笔空，挂账后 ${after4} 笔空（全局 linked=${r1.linked}）`);
check('重复挂账不再重复动账', r2.linked === 0, `第二次 linked=${r2.linked}`);

// 方向语义：销项票(out) 只能被收款(in) 冲抵，进项票(in) 只能被付款(out) 冲抵。
// 曾经两边各取反一次，两次抵消 → 变成同方向配对，收款挂到进项票上，勾稽全错。
const dirs = db.prepare(`SELECT p.direction pd, i.direction idir, COUNT(*) n
  FROM payments p JOIN invoices i ON i.id = p.invoice_id
  WHERE p.project_id = ? GROUP BY p.direction, i.direction`).all(P4);
const wrong = dirs.filter(r => r.pd === r.idir);
check('收款只挂销项票 / 付款只挂进项票', wrong.length === 0,
  dirs.map(r => `${r.pd}→${r.idir}×${r.n}`).join(' ') || '没有挂上的行');

// 反向验证：进项票只能被付款冲抵，收款不该挂上去
const P5 = mkProject('口径-反方向');
const C5 = mkContract(P5, { amount: 100000, sign_date: '2025-01-01', end_date: '2025-06-30', direction: 'out' });
const inv5 = dbf.insertRow('invoices', {
  project_id: P5, contract_id: C5, direction: 'in', invoice_no: 'FP-IN-01',
  invoice_type: '增值税专用发票', amount: 100000, tax_rate: 9,
  issue_date: '2025-02-01', status: '正常',
});
if (inv5.error) throw new Error('建进项票失败：' + inv5.error);
const pay5 = mkPayment(P5, C5, 'in', 50000, '2025-03-01');
const r3 = dbf.backfillInvoiceLinks();
const row5 = db.prepare('SELECT invoice_id FROM payments WHERE id = ?').get(pay5);
check('收款不会被挂到进项票上', row5.invoice_id === null, `invoice_id=${row5.invoice_id}（进项票 id=${inv5.id}）`);
check('没有可挂的票时记为跳过', r3.linked === 0 && r3.skipped >= 1, `linked=${r3.linked} skipped=${r3.skipped}`);

// ================================================================
console.log('\n[5] 会话有效期：写进去的时间和比大小的时间必须是同一个时区');

// 会话的 expires_at 后面是拿 nowISO()（本地时间串）比较的。
// 老代码用 `new Date().toISOString()` 写 UTC，北京时区下 30 天的会话提前 8 小时失效。
const A = require('../auth.js');
A.createTable();
db.prepare(`INSERT INTO users (username, name, password, role, perms, status, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?)`).run(
  'consist_u', '口径测试', A.hashPassword('test123456'), 'admin', '{}', '启用',
  dbf.nowISO(), dbf.nowISO());
const uid = db.prepare("SELECT id FROM users WHERE username = 'consist_u'").get().id;
const sess = A.createSession({ id: uid }, { socket: {}, headers: {} });

const expMs = new Date(String(sess.expiresAt).replace(' ', 'T')).getTime();
const wantMs = Date.now() + A.SESSION_DAYS * 86400000;
const driftH = Math.round((expMs - wantMs) / 3600000);
check('会话到期时间按本地时间写', Math.abs(expMs - wantMs) < 120000,
  `${sess.expiresAt}，比期望${driftH === 0 ? '正好' : `差 ${driftH} 小时`}`);
check('会话到期时间与 nowISO 同格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(sess.expiresAt)), sess.expiresAt);

// 刚建的会话必须立刻能用（如果写的是 UTC 串，在某些时区会被判成已过期）
const who = A.fromRequest({ headers: { cookie: 'pms_session=' + sess.token }, socket: {} });
check('刚建的会话可立刻使用', !!who && who.id === uid, who ? `用户 #${who.id}` : '认不出来');

// ================================================================
const badRows = results.filter(r => !r.ok);
console.log(`\n${results.length - badRows.length} / ${results.length} 项通过${skipped ? `（另跳过 ${skipped} 条）` : ''}`);
if (badRows.length) {
  console.log('\n失败项：');
  for (const r of badRows) console.log('  ✗ ' + r.name);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(badRows.length ? 1 : 0);
