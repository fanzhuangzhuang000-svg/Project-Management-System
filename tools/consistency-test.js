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

// 同一份合同不能生成两套计划节点。
// 单进程下靠"先查一次"就够；PG 多副本部署时两个副本会同时看到 0 个，
// 各插一套 → 回款计划金额翻倍。所以查和写必须在同一个事务里。
const again = dbf.generatePlan(C3);
const cnt3 = db.prepare('SELECT COUNT(*) n FROM schedules WHERE contract_id = ?').get(C3).n;
check('重复生成计划会被拦下', !!again.error, again.error || `又生成了 ${again.created} 个节点`);
check('节点数量没有翻倍', !plan.error && cnt3 === plan.created, `${cnt3} 个（首次生成 ${plan.created} 个）`);

// 静态复查：那次"再查一遍"必须落在 BEGIN 之后（放在事务外等于没加）
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  const s0 = src.indexOf('function generatePlan');
  const body = s0 >= 0 ? src.slice(s0, src.indexOf('\n/**', s0) > 0 ? src.indexOf('\n/**', s0) : s0 + 6000) : '';
  const iBegin = body.indexOf("db.exec('BEGIN')");
  const iRecheck = body.indexOf('SELECT COUNT(*) n FROM schedules WHERE contract_id = ?', iBegin + 1);
  check('重复检查落在事务内（不是事务外的空转）', iBegin > 0 && iRecheck > iBegin,
    iBegin < 0 ? '找不到 BEGIN' : (iRecheck < 0 ? '事务内没有再做一次计数' : 'OK'));
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
console.log('\n[6] 回收站：删掉的东西必须真的进得去');

require('../attachments.js').createTable();
const trash = require('../trash.js');
trash.createTable();

// push() 的 INSERT 里有 tenant_id，而这张表由 createTable() 自己建、多租户迁移
// 又没把它算进去 —— 列不存在时每次删除都在快照这一步抛错，server.js 的 catch
// 只打一行日志就接着删：数据没了、回收站是空的、还原无从谈起。
const tcols = db.prepare('PRAGMA table_info(trash)').all().map(c => c.name);
check('trash 表有 tenant_id 列（push 会写它）', tcols.includes('tenant_id'), tcols.join(','));

/**
 * 按 server.js 删除端点的顺序来：先快照、再删。
 * 有关联数据时线上走的是 deleteCascade（列表页点了「确定继续」之后），
 * 所以这里也用 deleteCascade —— 只测 deleteRow 的话，级联那半条路根本没人走。
 */
function snapshotAndDelete (table, id) {
  const before = db.prepare('SELECT COUNT(*) n FROM trash').get().n;
  let err = null, tid = null;
  try {
    const payload = trash.capture(table, [id]);
    tid = trash.push(table, [id], payload, 'consist', '口径测试');
  } catch (e) { err = e.message; }
  const added = db.prepare('SELECT COUNT(*) n FROM trash').get().n - before;
  const del = dbf.deleteCascade(table, id);
  return { err, tid, added, del };
}

const P6 = mkProject('口径-回收站');
const C6 = mkContract(P6, { amount: 300000, sign_date: '2025-01-05', end_date: '2025-09-30' });
const ch6 = dbf.insertRow('contract_changes', {
  project_id: P6, contract_id: C6, title: '追加门禁点位',
  change_type: '增补金额', change_date: '2025-05-01', amount: 20000,
});
if (ch6.error) throw new Error('建变更失败：' + ch6.error);

const d6 = snapshotAndDelete('contracts', C6);
// 撤销关联表的键名写成了 contracts_changes（表叫 contract_changes），
// capture() 直接拿键名拼 SQL → no such table → 快照整段失败。
check('删合同能进回收站', !d6.err && d6.added === 1, d6.err || `回收站新增 ${d6.added} 条`);
// 级联删除曾把变更记录的 contract_id 置 NULL，而那一列是 NOT NULL：
// 「删除带变更记录的合同」直接 constraint failed，用户怎么点都删不掉。
check('带变更记录的合同能删掉（级联不撞 NOT NULL）', !!d6.del && !d6.del.error,
  d6.del && d6.del.error ? d6.del.error : '删除成功');

const rs6 = trash.restore(d6.tid);
// 判据要带上 restored 条数：只看"库里有没有这条"会在删除本身失败时误判成通过
// （删除被回滚 → 合同还在 → 看起来还原成功了，其实一条都没还原）。
check('还原后合同回到库里', !!rs6 && rs6.ok && rs6.restored >= 1
  && !!db.prepare('SELECT 1 FROM contracts WHERE id = ?').get(C6),
  d6.tid ? JSON.stringify(rs6) : '没有可还原的快照');
const ch6back = db.prepare('SELECT contract_id FROM contract_changes WHERE id = ?').get(ch6.id);
check('还原后变更记录重新挂回合同', !!ch6back && ch6back.contract_id === C6,
  ch6back ? `contract_id=${ch6back.contract_id}（期望 ${C6}）` : '变更记录不见了');

// 删项目是级联最多的一条路：CASCADE_DELETE 里任何一张表名写错，整批快照就没了
const d7 = snapshotAndDelete('projects', P6);
check('删项目能进回收站', !d7.err && d7.added === 1, d7.err || `回收站新增 ${d7.added} 条`);
const snap7 = d7.tid ? trash.get(d7.tid) : null;
check('删项目时把子记录一起快照下来', !!snap7 && snap7.payload.rows.length > 1,
  snap7 ? `快照 ${snap7.payload.rows.length} 行` : '没有快照');
// restore() 按数组顺序逐行 INSERT。父记录排在子记录后面时，现在靠"没有外键"
// 侥幸能过；一旦 schema 补上 FOREIGN KEY，还原就会全线失败。
const pIdx = snap7 ? snap7.payload.rows.findIndex(r => r.table === 'projects') : -1;
check('快照里父记录排在子记录之前', pIdx === 0, `projects 在第 ${pIdx + 1} 条`);

// 真实可达的孤儿路径：变更记录的 project_id 是在**建记录那一刻**从合同带出来的
// （applyDerived 自动填），之后合同被换到别的项目，变更记录上的 project_id 不会跟着变。
// 这时删新项目 → 合同被删 → 变更记录成了指向已删合同的孤儿行。
// 所以删项目必须按「合同归属」再兜一遍，不能只按变更记录自己的 project_id。
const P8 = mkProject('口径-孤儿变更');
const P8b = mkProject('口径-孤儿变更B');
const C8 = mkContract(P8, { amount: 5000, sign_date: '2025-01-02', end_date: '2025-06-30' });
const ch8 = dbf.insertRow('contract_changes', {
  contract_id: C8, title: '只挂了合同', change_type: '增补金额',
  change_date: '2025-06-01', amount: 100,
});
if (ch8.error) throw new Error('建变更失败：' + ch8.error);
const moved8 = dbf.updateRow('contracts', C8, { project_id: P8b });
if (moved8 && moved8.error) throw new Error('改合同项目失败：' + moved8.error);

const d8 = snapshotAndDelete('projects', P8b);
const ch8left = db.prepare('SELECT contract_id FROM contract_changes WHERE id = ?').get(ch8.id);
check('删项目连带删掉「合同换过项目」的变更记录', !ch8left,
  ch8left ? `变更记录还在库里（指向已删除的合同 #${ch8left.contract_id}）` : '已随项目一起删除');
const snap8 = d8.tid ? trash.get(d8.tid) : null;
check('这类变更也进了快照（否则删了还原不回来）',
  !!snap8 && snap8.payload.rows.some(r => r.table === 'contract_changes' && r.data.id === ch8.id),
  snap8 ? `快照 ${snap8.payload.rows.length} 行` : '没有快照');

// 回收站页面的「占用空间」读的是 stats.bytes。
// 这个字段以前根本不存在，undefined/1024/1024 → "NaN" 直接显示在界面上；
// 因为回收站一直是空的，那个格子从来没人见过。
const st = trash.stats();
check('回收站统计带 bytes（占用空间不会算出 NaN）',
  typeof st.bytes === 'number' && st.bytes > 0, `bytes=${st.bytes}`);

// ---------------------------------------------------------------- 打包安全
// 真实事故：打包脚本曾经把**仓库根目录**整个删掉 —— package.json / server.js /
// db.js / .git 全没了，只剩一个 trash.js，未提交的改动全部丢失，只能重新 clone。
// 事后按代码逐行核对，所有 rmSync 的入参看起来都在 dist-artifacts 之下，
// **没能复现出是哪条路径拼成了空串**。所以改成结构性防护（tools/safe-dir.js）：
// 删除必须显式声明允许范围，越界直接抛错。下面这些断言就是那道防线的守门员。
{
  const { safeRm, assertNotLandmark } = require('./safe-dir.js');
  const ROOTDIR = path.join(__dirname, '..');
  const ART = path.join(TMP, 'fake-out');            // 假产物目录，随便删
  fs.mkdirSync(path.join(ART, 'stage'), { recursive: true });

  // 危险入参只喂给 "只判不删" 的 assertNotLandmark，绝不拿真实路径去试 safeRm。
  const mustReject = (name, fn) => {
    let threw = false;
    try { fn() } catch { threw = true }
    check(name, threw, threw ? '' : '没拦住 —— 防线失效');
  };
  mustReject('删除防线：仓库根目录被拦', () => assertNotLandmark(ROOTDIR));
  mustReject('删除防线：系统临时目录被拦', () => assertNotLandmark(os.tmpdir()));
  mustReject('删除防线：盘根被拦', () => assertNotLandmark(path.parse(ROOTDIR).root));
  mustReject('删除防线：空路径被拦', () => safeRm('', [ART]));
  mustReject('删除防线：越界目录被拦（同级的 tools/）',
    () => safeRm(path.join(ROOTDIR, 'tools'), [ART]));
  mustReject('删除防线：删允许范围本身要显式 self',
    () => safeRm(ART, [ART]));

  // 正常路径不能误伤：范围内的子目录该删就得删掉
  let okDel = false;
  try { safeRm(path.join(ART, 'stage'), [ART]); okDel = !fs.existsSync(path.join(ART, 'stage')) } catch { }
  check('删除防线：范围内的子目录照常删掉', okDel);

  // 静态复查：打包脚本里不该再有裸的递归删除
  for (const f of ['tools/build-artifacts.js', 'tools/build-installer.js']) {
    const src = fs.readFileSync(path.join(ROOTDIR, f), 'utf8');
    const bare = (src.match(/fs\.rmSync\([^)]*recursive:\s*true/g) || []).length;
    check(`${f} 的目录删除全部走 safeRm`, bare === 0, bare ? `还有 ${bare} 处裸 rmSync` : '');
  }
  check('仓库根关键文件完好', ['package.json', 'server.js', 'db.js', 'trash.js']
    .every(f => fs.existsSync(path.join(ROOTDIR, f))));
}

// ---------------------------------------------------------------- 交付包的 tar
// Linux 包改由 tools/tar-write.js 自己写（不再 spawn 外部 tar，原因见该文件）。
// 自己写的好处是确定的：同一份代码在哪台机器上都产出同样的包，执行位也能精确控制。
// 坏处是"格式写错了也没人管" —— 所以这里拿系统 tar 把包读回来验一遍。
{
  const { writeTarGz } = require('./tar-write.js');
  const { spawnSync } = require('node:child_process');
  const work = path.join(TMP, 'tarwork');
  const entry = 'pkg-1.0';
  fs.mkdirSync(path.join(work, entry, 'deploy'), { recursive: true });
  fs.writeFileSync(path.join(work, entry, 'deploy', 'deploy.sh'), '#!/bin/bash\necho hi\n');
  fs.writeFileSync(path.join(work, entry, 'server.js'), '// 后端入口\n');
  fs.writeFileSync(path.join(work, entry, '怎么运行.txt'), '中文文件名\n');

  const out = path.join(work, 'pkg.tar.gz');
  let made = null, err = '';
  try { made = writeTarGz(work, entry, out) } catch (e) { err = e.message }
  check('内置 tar 能写出包', !!made && fs.existsSync(out), err || (made ? `${made.files} 个文件` : ''));

  // 用系统 tar 读回：cwd + 相对文件名，避免 Windows 上 tar 把 C: 当远程主机
  const list = spawnSync('tar', ['-tzf', 'pkg.tar.gz'], { cwd: work, encoding: 'utf8', windowsHide: true });
  if (list.error || list.status !== 0) {
    skipCheck('内置 tar 的包能被系统 tar 读出', '本机没有可用的 tar（' + ((list.error && list.error.message) || list.stderr || '').slice(0, 60) + '）');
  } else {
    const names = list.stdout.split('\n').filter(Boolean);
    check('内置 tar 的包能被系统 tar 读出', names.length > 0, names.length + ' 个条目');
    check('中文文件名没被写坏', names.some(n => n.includes('怎么运行.txt')),
      names.filter(n => /txt$/.test(n)).join(', '));
    const tv = spawnSync('tar', ['-tvzf', 'pkg.tar.gz'], { cwd: work, encoding: 'utf8', windowsHide: true });
    const shLine = (tv.stdout || '').split('\n').find(l => l.includes('deploy.sh')) || '';
    check('deploy.sh 带执行位（客户能 ./deploy.sh 直接跑）', /^-rwxr-xr-x/.test(shLine.trim()), shLine.trim());
    const jsLine = (tv.stdout || '').split('\n').find(l => l.endsWith('server.js')) || '';
    check('普通文件不带执行位', /^-rw-r--r--/.test(jsLine.trim()), jsLine.trim());
  }
}

// ================================================================
const badRows = results.filter(r => !r.ok);
console.log(`\n${results.length - badRows.length} / ${results.length} 项通过${skipped ? `（另跳过 ${skipped} 条）` : ''}`);
if (badRows.length) {
  console.log('\n失败项：');
  for (const r of badRows) console.log('  ✗ ' + r.name);
}
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(badRows.length ? 1 : 0);
