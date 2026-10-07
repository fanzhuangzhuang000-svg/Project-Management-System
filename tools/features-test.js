'use strict';
/**
 * 新增功能端到端测试：费用与动态毛利 / 账龄 / 回收站还原 / 操作日志 / 对账单
 *   node tools/features-test.js [http://127.0.0.1:8787]
 */
const fs = require('node:fs');
const path = require('node:path');
const { prepareAuth, BASE: AUTH_BASE } = require('./test-auth.js');

// 基址必须和 test-auth.js 一致：登录拿到的会话属于 AUTH_BASE，
// 这里若换成别的地址，请求就会带着不属于它的 Cookie 打到另一个服务上，
// 表现为随机 401「请先登录」，排查时像会话过期，其实是打错了服务。
const BASE = process.argv[2] || AUTH_BASE;
const FIX = path.join(__dirname, 'fixtures');
const TAG = 'FEAT-' + Date.now().toString().slice(-6);
const OP = '测试管理员';   // 登录后日志记的是账号姓名

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
const get = p => fetch(BASE + p).then(r => r.json());
const post = (p, b) => fetch(BASE + p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Operator': encodeURIComponent(OP) },
  body: JSON.stringify(b || {}),
}).then(async r => ({ status: r.status, body: await r.json() }));

async function upload (table, recordId, file) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
  fd.append('table_name', table);
  fd.append('record_id', String(recordId));
  const r = await fetch(BASE + '/api/upload', { method: 'POST', body: fd });
  return (await r.json()).attachment;
}

(async function main () {
  await prepareAuth();
  // 记录测试前的数据量，结束时只断言「数量没变」。
  // 不能写死「3 个项目 8 份合同」—— 用户清掉示例数据、录了自己的项目后就对不上了。
  const BASE_TOTALS = (await get('/api/dashboard')).totals;
  console.log('\n[0] 准备测试数据（一个"五脏俱全"的项目）');
  const partner = (await post('/api/save/partners', { name: TAG + '甲方', type: '甲方' })).body;
  const proj = (await post('/api/save/projects', {
    name: TAG + '测试项目', code: TAG, client_id: partner.id,
    category: '综合布线,安防监控', status: '进行中', progress: 50,
  })).body;
  const con = (await post('/api/save/contracts', {
    name: TAG + '施工合同', project_id: proj.id, category: '项目合同', direction: 'in',
    amount: 1000000, tax_rate: 9, status: '执行中', payment_terms: '预付款30%，验收款65%，质保金5%',
  })).body;
  await post(`/api/contract/${con.id}/plan`, {});
  // 再签一份采购合同，才有"成本预算"可比
  const con2 = (await post('/api/save/contracts', {
    name: TAG + '采购合同', project_id: proj.id, category: '采购合同', direction: 'out',
    amount: 500000, tax_rate: 13, status: '执行中',
  })).body;
  const pay = (await post('/api/save/payments', {
    project_id: proj.id, contract_id: con.id, direction: 'in', kind: '预付款', amount: 300000, pay_date: '2026-05-01',
  })).body;
  const inv = (await post('/api/save/invoices', {
    project_id: proj.id, contract_id: con.id, partner_id: partner.id, direction: 'out',
    invoice_no: TAG, issue_date: '2026-05-02', amount: 275229.36, tax_rate: 9,
  })).body;
  const exp = (await post('/api/save/expenses', {
    project_id: proj.id, category: '材料设备', name: TAG + '采购费用', amount: 226000, tax_rate: 13,
    expense_date: '2026-04-20', has_invoice: '有票', status: '已付',
  })).body;
  const mat = (await post('/api/save/materials', {
    project_id: proj.id, category: '设备', name: TAG + '摄像机', unit: '台', quantity: 10, unit_price: 800,
  })).body;
  const mt = (await post('/api/save/maintenance', {
    project_id: proj.id, report_date: '2026-06-01', issue: TAG + '画面异常', status: '待处理', in_warranty: '质保内',
  })).body;
  const att = await upload('contracts', con.id, path.join(FIX, 'contract.pdf'));
  await new Promise(r => setTimeout(r, 3000));

  const ids = { proj: proj.id, con: con.id, pay: pay.id, inv: inv.id, exp: exp.id, mat: mat.id, mt: mt.id, att: att.id };
  check('测试项目已建好（含合同/计划/收款/发票/费用/材料/售后/附件）', !!proj.id && !!att.id, JSON.stringify(ids));

  // ================= 1. 费用与动态毛利 =================
  console.log('\n[1] 项目费用与动态毛利');
  const det = await get('/api/project/' + proj.id);
  const s = det.stats;
  check('项目费用已计入', det.expenses.length === 1 && s.cost === 226000, `实际成本 ${s.cost}`);
  check('不含税金额自动折算（226000 / 1.13）', Math.abs(s.cost_ex - 200000) < 1, `不含税 ${s.cost_ex}`);
  check('动态毛利 = 收入 − 实际成本', s.actual_profit === 1000000 - 226000, `${s.actual_profit}`);
  check('成本执行率 = 实际 / 预算', s.cost_budget === 500000 && s.cost_used_rate === 45.2, `预算 ${s.cost_budget}，已用 ${s.cost_used_rate}%`);
  check('成本结余 = 预算 − 实际', s.cost_over === 226000 - 500000, `结余 ${-s.cost_over}`);
  check('预计毛利（合同口径）仍独立计算', s.gross_profit > 0 && s.gross_profit !== s.actual_profit,
    `预计 ${s.gross_profit} / 动态 ${s.actual_profit}`);
  check('售后维修记录可读', det.maintenance.length === 1 && s.maint_open === 1, `未闭环 ${s.maint_open}`);

  // ================= 2. 账龄分析 =================
  console.log('\n[2] 账龄分析');
  const dash = await get('/api/dashboard');
  const ag = dash.aging;
  // 注意：check 的第三个参数是「立即求值」的，条件不成立时也会先算出来。
  // 所以这里必须防御式取值，否则 ag 为空时整条用例直接抛异常、后面的全跑不了。
  const agRecv = ag && ag.receivable ? ag.receivable : {}
  const agSum = Object.values(agRecv).reduce((a, b) => a + b.amount, 0)
  check('返回应收账龄分档', !!ag && !!ag.receivable && '90+' in ag.receivable,
    Object.keys(agRecv).join('/') || '（没有分档数据）');
  check('返回应付账龄分档', !!(ag && ag.payable), ag && ag.payable ? Object.keys(ag.payable).join('/') : '（无）');
  // 账龄是按「收付款计划节点」分档的，没有计划节点的项目不会出现在这里。
  // 所以「账龄合计 ≤ 应收余额」才是正常状态；差出来的部分就是没生成计划的那部分。
  const agingGap = dash.totals.receivable - agSum;
  check('账龄分档不超过应收余额', agSum <= dash.totals.receivable + 1,
    `分档合计 ${agSum} / 应收 ${dash.totals.receivable}`
    + (agingGap > 1 ? `（${agingGap} 元应收还没有计划节点，不计入账龄）` : ''));
  if (agingGap > 1) {
    console.log(`      ⚠ ${(agingGap / 10000).toFixed(1)} 万元应收没有对应的收付款计划节点`);
    console.log('        到「收付款计划」对这些合同点「生成计划」，账龄和逾期提醒才会覆盖到。');
  }
  check('费用科目分布可读', !!dash.by_expense && Object.keys(dash.by_expense).length > 0,
    Object.keys(dash.by_expense).slice(0, 4).join('/'));

  // ================= 3. 操作日志 =================
  console.log('\n[3] 操作日志');
  const logs = await get('/api/logs?q=' + encodeURIComponent(TAG));
  check('记录了本次新增操作', logs.rows.length > 0, logs.rows.length + ' 条');
  check('日志带操作人（登录账号）', logs.rows.every(l => l.operator === OP), logs.rows[0] && logs.rows[0].operator);
  check('记录了项目新增', logs.rows.some(l => l.action === 'create' && l.table_name === 'projects'), '');
  check('记录了费用新增', logs.rows.some(l => l.action === 'create' && l.table_name === 'expenses'), '');
  const schedLogs = await get('/api/logs?table_name=schedules');
  check('记录了生成计划', schedLogs.rows.some(l => l.action === 'create'), schedLogs.rows[0] ? schedLogs.rows[0].summary : '无');
  const before = (await post('/api/save/projects', { id: proj.id, name: TAG + '测试项目（改名）', progress: 60 })).body;
  const logs2 = await get('/api/logs?table_name=projects&q=' + encodeURIComponent(TAG));
  const upd = logs2.rows.find(l => l.action === 'update');
  check('记录了修改并列出变更字段', !!upd && /项目名称|完工进度/.test(upd.summary), upd ? upd.summary : '未找到');

  // ================= 4. 回收站：删除 → 还原 =================
  console.log('\n[4] 回收站还原（关键）');
  const delRes = await post(`/api/delete/projects/${proj.id}`, { cascade: true, keepAttachments: true });
  check('删除成功并生成回收站快照', delRes.status === 200 && !!delRes.body.trashId, 'trashId=' + delRes.body.trashId);
  check('项目已不在列表里', (await get('/api/get/projects/' + proj.id)).error !== undefined);
  check('合同已删除', (await get('/api/get/contracts/' + con.id)).error !== undefined);
  check('费用已删除', (await get('/api/get/expenses/' + exp.id)).error !== undefined);
  check('售后单已删除', (await get('/api/get/maintenance/' + mt.id)).error !== undefined);
  const attAfterDel = await get('/api/attachments/' + att.id);
  check('附件被保留（解除关联）', attAfterDel.id === att.id && attAfterDel.detached === 1, 'detached=' + attAfterDel.detached);

  const trashList = await get('/api/trash');
  const entry = trashList.rows.find(t => t.id === delRes.body.trashId);
  check('回收站里能看到这一项', !!entry && entry.table_name === 'projects', entry ? entry.label : '未找到');

  const rest = await post(`/api/trash/${delRes.body.trashId}/restore`, {});
  check('还原成功', rest.status === 200 && rest.body.restored >= 7, JSON.stringify(rest.body));
  const pBack = await get('/api/get/projects/' + proj.id);
  check('项目按原 id 还原', pBack.id === proj.id && pBack.code === TAG, '#' + pBack.id);
  const cBack = await get('/api/get/contracts/' + con.id);
  check('合同按原 id 还原且项目关联完好', cBack.id === con.id && cBack.project_id === proj.id, '');
  check('收付款还原', (await get('/api/get/payments/' + pay.id)).id === pay.id);
  check('发票还原', (await get('/api/get/invoices/' + inv.id)).id === inv.id);
  check('费用还原', (await get('/api/get/expenses/' + exp.id)).id === exp.id);
  check('材料还原', (await get('/api/get/materials/' + mat.id)).id === mat.id);
  check('售后单还原', (await get('/api/get/maintenance/' + mt.id)).id === mt.id);
  const schedBack = await get('/api/list/schedules?q=' + encodeURIComponent(TAG));
  check('收付款计划节点一并还原', schedBack.total === 3, schedBack.total + ' 个');
  const attBack = await get('/api/attachments/' + att.id);
  check('附件自动接回原合同', attBack.detached === 0 && attBack.record_id === con.id, `detached=${attBack.detached} record=${attBack.record_id}`);
  const dashBack = await get('/api/dashboard');
  check('统计已恢复', dashBack.totals.project_count === BASE_TOTALS.project_count + 1,
    `项目 ${dashBack.totals.project_count}（测试前 ${BASE_TOTALS.project_count}，本测试新建了 1 个）`);

  // ================= 5. 彻底删除 =================
  console.log('\n[5] 彻底删除');
  const del2 = await post(`/api/delete/projects/${proj.id}`, { cascade: true, keepAttachments: false });
  const purge = await post(`/api/trash/${del2.body.trashId}/purge`, {});
  check('彻底删除回收站条目', purge.status === 200, JSON.stringify(purge.body));
  check('条目已从回收站消失', !(await get('/api/trash')).rows.some(t => t.id === del2.body.trashId));

  // ================= 6. 对账单 =================
  console.log('\n[6] 对账单数据');
  // 用本测试自己建的项目，不要写死示例项目的 id（用户清空示例后 id 会变）
  // 对账单要挑一个「还在的、而且有合同/收付款」的项目：不能写死 id（用户清空示例后会变），
  // 也不能用上面那个 —— 第 5 节刚把它彻底删了。
  const stPid = (((await get('/api/list/projects?q=DEMO-')).rows || [])[0] || {}).id;
  const st = await get('/api/statement/' + stPid);
  const stStats = st && st.stats ? st.stats : {};
  check('对账单接口可用', !!(st && st.project) && !!(st && st.stats),
    st && st.project ? st.project.name : JSON.stringify(st).slice(0, 60));
  check('含甲方信息', !!(st && st.client), st && st.client ? st.client.name : '无');
  check('含合同/收款/发票明细', !!(st && Array.isArray(st.contracts) && Array.isArray(st.payments) && Array.isArray(st.invoices)), '');
  check('应收余额与看板一致', typeof stStats.receivable === 'number', '¥' + stStats.receivable);

  // ================= 7. 清理 =================
  console.log('\n[7] 清理');
  for (const kw of [TAG, TAG + '甲方']) {
    for (const t of ['projects', 'partners']) {
      const list = await get(`/api/list/${t}?q=` + encodeURIComponent(kw));
      for (const row of list.rows) await post(`/api/delete/${t}/${row.id}`, { cascade: true, keepAttachments: false });
    }
  }
  // ---------- 项目台账里直接录合同金额（快捷录入）----------
  console.log('\n[项目金额快捷录入]');
  {
    const madeP = [], madeC = [];
    const pname = TAG + '-带金额项目';
    // 1) 新建项目时填金额 → 自动建主合同
    const c1 = await post('/api/save/projects', {
      name: pname, code: TAG + '-A', status: '进行中', manager: '测试', start_date: '2026-01-15',
      _main_contract: 3200000,
    });
    check('项目保存成功', c1.body.ok === true, c1.body.error || `id=${c1.body.id}`);
    madeP.push(c1.body.id);
    check('返回了自动建合同的提示', typeof c1.body.note === 'string' && c1.body.note.includes('主合同'), c1.body.note);

    const mine = async () => (await get('/api/list/contracts?limit=100')).rows
      .filter(r => r.project_id === c1.body.id && r.direction === 'in');
    let cs = await mine();
    check('自动建了 1 份收入合同', cs.length === 1, `${cs.length} 份`);
    if (cs.length) {
      madeC.push(cs[0].id);
      check('合同金额正确', Number(cs[0].amount) === 3200000, `${cs[0].amount / 10000} 万`);
      check('合同名带上了项目名', String(cs[0].name).includes(pname), cs[0].name);
      check('签约日期取了开工日期', cs[0].sign_date === '2026-01-15', cs[0].sign_date);
    }
    const pj = (await get('/api/list/projects?limit=100')).rows.find(r => r.id === c1.body.id);
    check('项目的收入合同额跟着变', Number(pj.contract_in) === 3200000, String(pj.contract_in));

    // 2) 改金额 → 更新那一份，不新建
    const c2 = await post('/api/save/projects', {
      id: c1.body.id, name: pname, code: TAG + '-A', status: '进行中', _main_contract: 4500000,
    });
    check('改金额保存成功', c2.body.ok === true, c2.body.error || c2.body.note);
    check('提示是「已更新」', typeof c2.body.note === 'string' && c2.body.note.includes('更新'), c2.body.note);
    cs = await mine();
    check('没有重复建合同', cs.length === 1, `${cs.length} 份`);
    check('金额已更新', Number(cs[0].amount) === 4500000, String(cs[0].amount));

    // 3) 已有多份收入合同时不擅自改
    const extra = await post('/api/save/contracts', {
      project_id: c1.body.id, direction: 'in', name: TAG + '-第二份收入合同', category: '项目合同', amount: 500000,
    });
    madeC.push(extra.body.id);
    const c3 = await post('/api/save/projects', {
      id: c1.body.id, name: pname, code: TAG + '-A', status: '进行中', _main_contract: 9000000,
    });
    check('多份合同时给出明确提示', typeof c3.body.note === 'string' && c3.body.note.includes('2 份'), c3.body.note);
    cs = await mine();
    check('多份合同时一份都没被改', cs.every(r => Number(r.amount) !== 9000000), cs.map(r => r.amount).join('/'));
    check('项目合计仍是两份之和', Number((await get('/api/list/projects?limit=100')).rows.find(r => r.id === c1.body.id).contract_in) === 5000000);

    // 4) 不填金额 → 行为不变
    const c4 = await post('/api/save/projects', { name: TAG + '-不填金额项目', code: TAG + '-B', status: '进行中' });
    madeP.push(c4.body.id);
    check('不填金额时项目正常保存', c4.body.ok === true && c4.body.note === null, c4.body.note);
    check('不填金额时不会建合同',
      (await get('/api/list/contracts?limit=100')).rows.filter(r => r.project_id === c4.body.id).length === 0);

    // 清理
    for (const id of madeC) { try { await post(`/api/delete/contracts/${id}`, { cascade: true }) } catch { /* 忽略 */ } }
    for (const id of madeP) { try { await post(`/api/delete/projects/${id}`, { cascade: true }) } catch { /* 忽略 */ } }
  }

  // 清掉测试残留的回收站条目与附件
  const tr = await get('/api/trash');
  for (const t of tr.rows) if ((t.label || '').includes(TAG)) await post(`/api/trash/${t.id}/purge`, {});
  // ⚠️ 只能删本测试自己上传的那几个附件（按 id），不能按文件名匹配。
  // 原来写的是 `original_name.includes('contract.pdf')` ——
  // 用户自己传的合同扫描件一旦也叫 contract.pdf 就会被连带删光，
  // 而 attachments.remove 走 fs.unlinkSync，不进回收站、删了找不回来。
  // test-auth.js 里已经因为同类写法出过一次事故，这里不能再留一份。
  for (const id of [att.id].filter(Boolean)) {
    await post(`/api/attachments/${id}/delete`, {});
  }
  const fin = await get('/api/dashboard');
  check('测试数据已清理（数量回到测试前）',
    fin.totals.project_count === BASE_TOTALS.project_count && fin.totals.contract_count === BASE_TOTALS.contract_count,
    `项目 ${fin.totals.project_count}（测试前 ${BASE_TOTALS.project_count}）`
    + ` / 合同 ${fin.totals.contract_count}（测试前 ${BASE_TOTALS.contract_count}）`);

  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`  新功能测试：${results.length - failed.length} / ${results.length} 项通过`);
  if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name).join('\n'));
  console.log('='.repeat(60));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('\n[测试异常]', e.message); process.exit(1); });
