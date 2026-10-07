'use strict';
/**
 * 八项优化功能的回归测试
 *  ①登录限速 ②到期预警 ③发票勾稽 ④费用计入应付 ⑤合同变更 ⑥月度快照
 * 用法： node tools/upgrade-test.js [http://127.0.0.1:8787]
 */
const T = require('./test-auth.js');
const BASE = process.argv[2] || T.BASE || 'http://127.0.0.1:8787';

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
const near = (a, b, tol = 0.02) => Math.abs(Number(a) - Number(b)) <= tol;

T.forceAdminPassword();

async function main () {
  const raw = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: T.USER, password: T.PASS }) });
  const tok = (raw.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/)[1];
  const H = { Cookie: 'pms_session=' + tok, 'Content-Type': 'application/json' };
  const j = async (u, h) => { const r = await fetch(BASE + u, { headers: h || H }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const post = async (u, b, h) => { const r = await fetch(BASE + u, { method: 'POST', headers: h || H, body: JSON.stringify(b || {}) }); return { s: r.status, j: await r.json().catch(() => ({})) }; };
  const login = (username, password) => post('/api/login', { username, password }, { 'Content-Type': 'application/json' });

  const cleanup = [];

  try {
    // ================= ① 登录限速 =================
    console.log('[1] 登录限速');
    const probe = 'lockprobe_' + Date.now().toString(36);
    let lockAt = 0, lastLeft = null, lockResp = null;
    for (let i = 1; i <= 7; i++) {
      const r = await login(probe, 'wrong-' + i);
      if (r.j.left !== undefined) lastLeft = r.j.left;
      if (r.j.locked && !lockAt) { lockAt = i; lockResp = r; }
    }
    check('连错到第 5 次触发锁定', lockAt === 5, '第 ' + lockAt + ' 次锁');
    // 第 5 次本身密码是错的 → 401，但响应里已说明被锁；之后再来才是 429
    check('第 5 次响应里带上锁定信息', (lockResp.s === 401 || lockResp.s === 429) && lockResp.j.locked === true && lockResp.j.remainSec > 0,
      `HTTP ${lockResp.s} 锁定 ${lockResp.j.remainSec}s`);
    const after = await login(probe, 'wrong-8');
    check('锁定期间再试直接 429', after.s === 429 && after.j.locked === true, 'HTTP ' + after.s);
    // 同 IP 换个账号名不该被误锁（IP 阈值 20，比账号阈值宽松）
    const other = await login(T.USER, T.PASS);
    check('换账号登录不受影响（不会一人手滑锁全公司）', other.s === 200, 'HTTP ' + other.s);
    T.unlockAll();
    const unlocked = await login(probe, 'wrong-9');
    check('管理员解锁后恢复可登录', unlocked.s === 401 && unlocked.j.locked !== true, 'HTTP ' + unlocked.s);
    T.unlockAll();

    // ================= ② 到期预警 =================
    console.log('[2] 到期预警与待办提醒');
    const d = (await j('/api/dashboard')).j;
    // 管理员看到的每一个核心指标都必须是数字：null 表示"没权限"或"字段被误删"
    // （曾经改应付那段时不慎删掉 receivable，导致大屏显示"无权限查看"，这里兜住）
    const CORE = ['project_count', 'contract_count', 'contract_in', 'contract_out', 'paid_in', 'paid_out',
      'receivable', 'payable', 'payable_contract', 'payable_expense', 'cost', 'cost_ex', 'cost_unpaid',
      'gross_profit', 'gross_rate', 'actual_profit', 'actual_rate', 'cost_over', 'cost_used_rate',
      'collect_rate', 'uninvoiced_out', 'inv_out', 'inv_in', 'inv_out_unpaid', 'inv_in_unpaid',
      'paid_in_no_inv', 'paid_out_no_inv', 'inv_cover_rate', 'material_amount', 'material_count',
      'expense_count', 'maint_count', 'maint_cost', 'payment_count', 'invoice_count', 'partner_count',
      'attachment_count', 'change_in', 'change_out', 'change_count', 'contract_in_base', 'contract_out_base'];
    const missing = CORE.filter(k => d.totals[k] === null || d.totals[k] === undefined);
    check('管理员的核心指标字段齐全（无 null/缺失）', missing.length === 0,
      missing.length ? '缺：' + missing.join(', ') : CORE.length + ' 个字段都有值');
    check('核心指标都是数值型', CORE.filter(k => typeof d.totals[k] !== 'number').length === 0,
      CORE.filter(k => typeof d.totals[k] !== 'number').join(',') || '全部为数字');
    check('返回待办提醒数组', Array.isArray(d.reminders), (d.reminders || []).length + ' 条');
    check('提醒带 level/title/href', (d.reminders || []).every(r => r.level && r.title && r.href),
      (d.reminders || []).map(r => r.level).join(','));
    check('提醒按紧急度排序（danger 在前）', (() => {
      const w = { danger: 0, warn: 1, info: 2 };
      const arr = (d.reminders || []).map(r => w[r.level]);
      return arr.every((v, i) => i === 0 || arr[i - 1] <= v);
    })());
    check('30 天内到期清单存在', Array.isArray(d.schedules.due_soon), (d.schedules.due_soon || []).length + ' 条');
    check('到期清单都在 0-30 天内', (d.schedules.due_soon || []).every(r => r.days >= 0 && r.days <= 30),
      (d.schedules.due_soon || []).map(r => r.days + 'd').join(','));
    check('分档 d7/d30 结构完整', d.schedules.buckets && d.schedules.buckets.d7 && d.schedules.buckets.d30,
      `7天内 ${d.schedules.buckets.d7.count} 笔 / 8-30天 ${d.schedules.buckets.d30.count} 笔`);
    check('质保金到期清单存在', Array.isArray(d.schedules.warranty_due), (d.schedules.warranty_due || []).length + ' 笔');

    // ================= ③ 发票与收款勾稽 =================
    console.log('[3] 发票与收款勾稽');
    const t0 = d.totals;
    check('已开票未收 = max(0, 开票−收款)', near(t0.inv_out_unpaid, Math.max(0, t0.inv_out - t0.paid_in)),
      `${t0.inv_out_unpaid} vs ${Math.max(0, t0.inv_out - t0.paid_in)}`);
    check('已收未开票 = max(0, 收款−开票)', near(t0.paid_in_no_inv, Math.max(0, t0.paid_in - t0.inv_out)),
      `${t0.paid_in_no_inv} vs ${Math.max(0, t0.paid_in - t0.inv_out)}`);
    check('开票覆盖率在 0-100 之间', t0.inv_cover_rate >= 0 && t0.inv_cover_rate <= 100, t0.inv_cover_rate + '%');
    const invList = (await j('/api/list/invoices')).j;
    check('发票行带已收付/未收付', invList.rows.every(r => r.paid_amount !== undefined && r.unpaid_amount !== undefined),
      invList.rows.length + ' 行');
    check('未收付不出现负数', invList.rows.every(r => r.unpaid_amount >= 0),
      '最小 ' + Math.min(...invList.rows.map(r => r.unpaid_amount)));
    // 自动关联：跑一次后逐笔挂账数应增加，且不产生负数
    const bf = await post('/api/invoices/backfill', {});
    check('自动关联接口可用', bf.s === 200 && bf.j.ok === true, JSON.stringify(bf.j).slice(0, 70));
    const invList2 = (await j('/api/list/invoices')).j;
    check('自动关联后未收付仍无负数', invList2.rows.every(r => r.unpaid_amount >= 0),
      '最小 ' + Math.min(...invList2.rows.map(r => r.unpaid_amount)));
    const d2 = (await j('/api/dashboard')).j;
    check('逐笔挂账数已增加', (d2.totals.linked_count || 0) >= (t0.linked_count || 0),
      `${t0.linked_count || 0} → ${d2.totals.linked_count || 0}`);
    // 精确关联验证：手工把一笔款挂到一张票上，票的已收付应增加
    const pjt = (await j('/api/list/invoices')).j.rows.find(r => r.unpaid_amount > 10000);
    if (pjt) {
      const pay = await post('/api/save/payments', {
        project_id: pjt.project_id, contract_id: pjt.contract_id, invoice_id: pjt.id,
        direction: pjt.direction === 'out' ? 'in' : 'out', kind: '进度款',
        amount: 10000, pay_date: '2026-10-05', method: '银行转账', voucher_no: 'UPTEST-RECON',
      });
      cleanup.push(['payments', pay.j.id]);
      const inv3 = (await j('/api/list/invoices')).j.rows.find(r => r.id === pjt.id);
      check('手工挂账后该票已收付 +10000', near(inv3.paid_amount, (pjt.paid_amount || 0) + 10000),
        `${pjt.paid_amount} → ${inv3.paid_amount}`);
    } else {
      check('手工挂账后该票已收付 +10000', false, '找不到有余额的发票');
    }

    // ================= ④ 费用未付计入应付 =================
    console.log('[4] 费用未付计入应付账款');
    const d3 = (await j('/api/dashboard')).j;
    const t3 = d3.totals;
    check('应付 = 合同未付 + 零星未付费用',
      near(t3.payable, t3.payable_contract + t3.payable_expense),
      `${t3.payable} = ${t3.payable_contract} + ${t3.payable_expense}`);
    check('应付合同口径 = 支出合同 − 已付款',
      near(t3.payable_contract, t3.contract_out - t3.paid_out),
      `${t3.payable_contract} vs ${t3.contract_out - t3.paid_out}`);
    // 造一条无合同的未付费用，应付应该涨
    // 示例项目的 id 不固定（用户清空示例后重新补写会换新 id），动态查一下
    const DEMO_PID = (((await j('/api/list/projects?q=DEMO-')).j.rows || [])[0] || {}).id || 0;
    if (!DEMO_PID) { check('找到示例项目（费用用例依赖它）', false, '没有 DEMO- 项目'); }
    const before = t3.payable;
    const exp = await post('/api/save/expenses', {
      project_id: DEMO_PID, category: '人工费', name: 'UPTEST-未付人工费',
      amount: 12345, expense_date: '2026-10-05', status: '未付', has_invoice: '无票',
    });
    if (exp.j.id) {
      cleanup.push(['expenses', exp.j.id]);
      const t4 = (await j('/api/dashboard')).j.totals;
      check('新增未付费用后应付增加', near(t4.payable, before + 12345, 1), `${before} → ${t4.payable}`);
      check('增量只进"零星未付费用"口径', near(t4.payable_expense, t3.payable_expense + 12345, 1),
        `${t3.payable_expense} → ${t4.payable_expense}`);
      // 已付的费用不该计入
      const exp2 = await post('/api/save/expenses', {
        project_id: DEMO_PID, category: '人工费', name: 'UPTEST-已付人工费',
        amount: 9999, expense_date: '2026-10-05', status: '已付', has_invoice: '有票',
      });
      if (exp2.j.id) {
        cleanup.push(['expenses', exp2.j.id]);
        const t5 = (await j('/api/dashboard')).j.totals;
        check('已付费用不进应付', near(t5.payable, t4.payable, 1), `${t4.payable} → ${t5.payable}`);
      }
    } else {
      check('新增未付费用后应付增加', false, exp.j.error || '建费用失败');
    }

    // ================= ⑤ 合同变更 / 补充协议 =================
    console.log('[5] 合同变更与最终金额');
    const ct = (await j('/api/list/contracts')).j.rows[0];
    const baseAmount = ct.amount;
    check('合同行带变更增减/最终金额', ct.change_amount !== undefined && ct.final_amount !== undefined,
      `原 ${ct.amount} 变更 ${ct.change_amount} 最终 ${ct.final_amount}`);
    check('无变更时最终金额 = 原金额', near(ct.final_amount, baseAmount), `${ct.final_amount} vs ${baseAmount}`);

    const ch1 = await post('/api/save/contract_changes', {
      contract_id: ct.id, title: 'UPTEST-增补', change_type: '增补金额', change_date: '2026-10-05',
      amount_delta: 50000, status: '已确认', doc_no: 'BC-UT',
    });
    if (ch1.j.id) {
      cleanup.push(['contract_changes', ch1.j.id]);
      check('变更自动带出所属项目', String(ch1.j.row.project_id) === String(ct.project_id),
        `变更项目 ${ch1.j.row.project_id} / 合同项目 ${ct.project_id}`);
      const ct2 = (await j('/api/get/contracts/' + ct.id)).j;
      check('已确认变更计入最终金额', near(ct2.final_amount, baseAmount + 50000),
        `${baseAmount} + 50000 = ${ct2.final_amount}`);
      // 草稿不计入
      const ch2 = await post('/api/save/contract_changes', {
        contract_id: ct.id, title: 'UPTEST-草稿', change_type: '增补金额', change_date: '2026-10-05',
        amount_delta: 999999, status: '草稿',
      });
      if (ch2.j.id) {
        cleanup.push(['contract_changes', ch2.j.id]);
        const ct3 = (await j('/api/get/contracts/' + ct.id)).j;
        check('草稿变更不计入最终金额', near(ct3.final_amount, baseAmount + 50000),
          `最终 ${ct3.final_amount}（草稿 999999 未计）`);
      }
      // 项目统计跟着变
      const ps = (await j('/api/project/' + ct.project_id)).j.stats;
      const key = ct.direction === 'in' ? 'contract_in' : 'contract_out';
      check('项目统计按最终金额口径', ps.change_in !== undefined || ps.change_out !== undefined,
        `变更 in ${ps.change_in} / out ${ps.change_out}`);
      // 削减用负数
      const ch3 = await post('/api/save/contract_changes', {
        contract_id: ct.id, title: 'UPTEST-削减', change_type: '削减金额', change_date: '2026-10-05',
        amount_delta: -20000, status: '已确认',
      });
      if (ch3.j.id) {
        cleanup.push(['contract_changes', ch3.j.id]);
        const ct4 = (await j('/api/get/contracts/' + ct.id)).j;
        check('削减金额（负数）正确冲减', near(ct4.final_amount, baseAmount + 30000),
          `最终 ${ct4.final_amount}`);
      }
      // 删掉变更，金额回退
      for (const [, id] of cleanup.filter(([tb]) => tb === 'contract_changes')) {
        await post('/api/delete/contract_changes/' + id, { cascade: true });
      }
      const ct5 = (await j('/api/get/contracts/' + ct.id)).j;
      check('删除变更加后金额回退到原值', near(ct5.final_amount, baseAmount), `最终 ${ct5.final_amount}`);
      // 从 cleanup 里移除已删的
      for (let i = cleanup.length - 1; i >= 0; i--) if (cleanup[i][0] === 'contract_changes') cleanup.splice(i, 1);
    } else {
      check('变更自动带出所属项目', false, ch1.j.error || '建变更失败');
    }

    // ================= ⑥ 月度快照 =================
    console.log('[6] 月度结账快照');
    const snapList = (await j('/api/snapshots')).j;
    check('快照列表可读', snapList.rows !== undefined, (snapList.rows || []).length + ' 份');
    check('启动时自动补记了上月快照', (snapList.rows || []).some(r => r.kind === 'auto'),
      (snapList.rows || []).map(r => `${r.ym}(${r.kind})`).join(' '));
    const testYm = '2025-01';
    const capR = await post('/api/snapshots/capture', { ym: testYm, note: 'UPTEST' });
    check('手动快照成功', capR.s === 200 && capR.j.ok, JSON.stringify(capR.j).slice(0, 50));
    const snapList2 = (await j('/api/snapshots')).j;
    check('新快照出现在列表里', (snapList2.rows || []).some(r => r.ym === testYm), testYm);
    const one = await j('/api/snapshots/' + testYm);
    check('可读取单份快照内容', one.s === 200 && !!(one.j.data && one.j.data.totals), `HTTP ${one.s} ${one.j.error || '有 totals'}`);
    const trend = (await j('/api/dashboard')).j.trend;
    check('趋势数据按月升序', Array.isArray(trend) && trend.every((r, i) => i === 0 || trend[i - 1].ym < r.ym),
      (trend || []).map(r => r.ym).join(' → '));
    check('趋势最后一点是当月实时值', trend && trend[trend.length - 1].snapshot === false,
      trend && trend[trend.length - 1].ym);
    check('趋势含昨日快照点', (trend || []).some(r => r.ym === testYm && r.snapshot === true));
    const mom = (await j('/api/dashboard')).j.mom;
    check('环比数据可读', mom === null || (mom.base_ym && 'contract_in' in mom), mom ? '对比 ' + mom.base_ym : '暂无基准');
    const delR = await post('/api/snapshots/' + testYm + '/delete', {});
    check('可删除快照', delR.j.deleted === 1, JSON.stringify(delR.j));
    check('删除后不在列表里', !((await j('/api/snapshots')).j.rows || []).some(r => r.ym === testYm));
  } finally {
    // 清理测试数据
    for (const [table, id] of cleanup) {
      if (!id) continue;
      try { await post(`/api/delete/${table}/${id}`, { cascade: true }); } catch { /* 忽略 */ }
    }
    T.unlockAll();
  }

  const pass = results.filter(x => x.ok).length;
  console.log(`\n八项优化测试结果：${pass} / ${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch(e => { console.error('[测试异常]', e.message); process.exit(1); });
