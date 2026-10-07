'use strict';
/**
 * 批量删除 + 附件处理 端到端测试
 *   node tools/batch-test.js [http://127.0.0.1:8787]
 *
 * 覆盖：无关联直接删、有关联给提示、级联删（含收付款计划节点）、
 *       "保留附件"路径（文件留下且不被自动清理）、非法入参、数据清理。
 */
const fs = require('node:fs');
const path = require('node:path');
 const { prepareAuth } = require('./test-auth.js');

// ⚠️ 基址必须和 test-auth.js 完全一致，否则会话会"打到另一个服务"上去。
// 之前这里是 `process.argv[2] || 8787`，而 test-auth 用 PMS_BASE；
// 设了 PMS_BASE 指向别的实例时，登录拿到的 Cookie 属于 PMS_BASE，
// 请求却发往 argv/8787 —— 表现为随机的 401「请先登录」，
// 排查时极具迷惑性（看起来像会话过期，其实是打错了服务）。
const { BASE: AUTH_BASE } = require('./test-auth.js');
const BASE = process.argv[2] || AUTH_BASE;
const FIX = path.join(__dirname, 'fixtures');
const TAG = 'BATCHTEST-' + Date.now().toString().slice(-6);

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
const get = p => fetch(BASE + p).then(r => r.json());
const post = (p, b) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}),
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
  console.log('\n[0] 准备测试数据');
  const partner = (await post('/api/save/partners', { name: TAG + '甲方', type: '甲方' })).body;
  const proj = (await post('/api/save/projects', { name: TAG + '项目', code: TAG, client_id: partner.id, category: '综合布线,安防监控', status: '进行中' })).body;
  const con = (await post('/api/save/contracts', {
    name: TAG + '施工合同', project_id: proj.id, category: '项目合同', direction: 'in',
    amount: 1000000, tax_rate: 9, status: '执行中', payment_terms: '预付款30%，验收款65%，质保金5%',
  })).body;
  await post(`/api/contract/${con.id}/plan`, {});
  await post('/api/save/payments', { project_id: proj.id, contract_id: con.id, direction: 'in', amount: 300000, pay_date: '2026-05-01' });
  await post('/api/save/invoices', { project_id: proj.id, direction: 'out', invoice_no: TAG, issue_date: '2026-05-02', amount: 100000, tax_rate: 9 });

  const before = await get('/api/list/schedules?q=' + encodeURIComponent(TAG));
  check('测试合同已生成收付款计划节点', before.total === 3, before.total + ' 个节点');

  const att = await upload('contracts', con.id, path.join(FIX, 'contract.pdf'));
  const att2 = await upload('projects', proj.id, path.join(FIX, 'invoice.pdf'));
  await new Promise(r => setTimeout(r, 3500));
  check('附件已上传', !!att.id && !!att2.id, `#${att.id} / #${att2.id}`);

  // ================= 1. 无关联记录直接删 =================
  console.log('\n[1] 无关联的记录：直接删除');
  const solo = (await post('/api/save/partners', { name: TAG + '孤立单位', type: '其他' })).body;
  const r1 = await post('/api/batch-delete', { table: 'partners', ids: [solo.id] });
  check('无关联时不需二次确认', r1.status === 200 && r1.body.deleted === 1, JSON.stringify(r1.body));

  // ================= 2. 有关联记录：先给提示 =================
  console.log('\n[2] 有关联的记录：先提示再确认');
  const r2 = await post('/api/batch-delete', { table: 'projects', ids: [proj.id] });
  check('返回 409 并需要确认', r2.status === 409 && r2.body.needConfirm === true, 'status=' + r2.status);
  const dep = r2.body.dependents || {};
  check('提示里列出合同数', dep.contracts === 1, '合同 ' + dep.contracts);
  check('提示里列出收付款计划节点数', dep.schedules === 3, '计划节点 ' + dep.schedules);
  check('提示里列出发票数', dep.invoices === 1, '发票 ' + dep.invoices);
  check('提示里列出发票/合同附件数', dep.attachments >= 2, '附件 ' + dep.attachments);
  check('未确认时数据没有被删', (await get('/api/get/projects/' + proj.id)).id === proj.id);

  // ================= 3. 保留附件：只删记录 =================
  console.log('\n[3] 选择「保留附件」：只删记录，扫描件留下');
  // 先记下 orphan 基线：用户库里可能有他自己上传、还没保存到表单的暂存文件，
  // 那是正常数据，本测试只能断言「没有被本测试抬高」，不能断言它是 0。
  const orphanBefore = (await get('/api/attachments/stats')).orphan;
  const r3 = await post('/api/batch-delete', { table: 'projects', ids: [proj.id], cascade: true, keepAttachments: true });
  check('删除成功', r3.status === 200 && r3.body.deleted === 1, JSON.stringify(r3.body));
  check('报告保留了 2 个附件', r3.body.removedFiles === 2, '保留 ' + r3.body.removedFiles);
  check('项目已删除', (await get('/api/get/projects/' + proj.id)).error !== undefined);
  const schedLeft = await get('/api/list/schedules?q=' + encodeURIComponent(TAG));
  check('收付款计划节点被一并删除（不留孤儿）', schedLeft.total === 0, schedLeft.total + ' 个残留');
  const attLeft = await get('/api/attachments');
  const kept = attLeft.rows.filter(a => a.id === att.id || a.id === att2.id);
  check('附件记录仍在', kept.length === 2, kept.length + ' 个');
  check('附件已标记为解除关联', kept.every(a => a.detached === 1 && !a.record_id), kept.map(a => `detached=${a.detached}`).join(','));
  // 用存储层判断，而不是直接查 data/attachments 目录：
  // MinIO 模式下文件根本不在本地那个目录里，fs.existsSync 会误报成「文件丢了」。
  const storageNow = require('../storage.js').storage;
  check('文件仍在存储里', storageNow.exists(kept[0].stored_name),
    kept[0].stored_name + '（驱动 ' + storageNow.driver + '）');
  const stAfter = await get('/api/attachments/stats');
  check('统计里区分了"已解除关联"', stAfter.detached >= 2, 'detached=' + stAfter.detached);
  // ★ 这里必须比「增量」，不能断言 orphan === 0。
  // 用户自己上传了还没保存到任何表单的暂存文件（例如随手传了个报价表），
  // 它本来就该计入 orphan —— 那是正确行为，不是缺陷。
  // 之前这条断言写成 `orphan === 0`，等于要求「用户库里不许有任何暂存文件」，
  // 于是用户正常用一次系统，测试就红了。查库确认那条 orphan 是 is_demo=0 的真实用户文件，
  // 与本次删除无关。这里改成：本测试不能把 orphan 抬高。
  const stBefore = orphanBefore;
  check('保留的附件不计入"待自动清理"', stAfter.orphan <= stBefore, `orphan=${stAfter.orphan}（删除前 ${stBefore}）`);

  // ================= 4. 批量删多条 =================
  console.log('\n[4] 一次勾选多条一起删');
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    const p = (await post('/api/save/partners', { name: TAG + '批量' + i, type: '其他' })).body;
    ids.push(p.id);
  }
  const r4 = await post('/api/batch-delete', { table: 'partners', ids });
  check('一次删掉 3 条', r4.status === 200 && r4.body.deleted === 3, JSON.stringify(r4.body));
  check('确认已删干净', (await get('/api/list/partners?q=' + encodeURIComponent(TAG + '批量'))).total === 0);

  // ================= 5. 非法入参 =================
  console.log('\n[5] 异常入参');
  check('空 ids 被拒绝', (await post('/api/batch-delete', { table: 'partners', ids: [] })).status === 400);
  check('未知表被拒绝', (await post('/api/batch-delete', { table: 'nope', ids: [1] })).status === 404);
  const rBad = await post('/api/batch-delete', { table: 'partners', ids: [99999999] });
  check('不存在的 id 不报错且不计入删除数', rBad.status === 200 && rBad.body.deleted === 0,
    `deleted=${rBad.body.deleted} requested=${rBad.body.requested}`);

  // ================= 6. 计划节点上的附件（回归测试）=================
  // 真实踩过的坑：删项目时，收付款计划节点（schedules）上的附件既没被保留、也没被删除，
  // 变成 record_id 指向一条已经不存在的记录 —— 而 purgeOrphans 只清 record_id IS NULL 的，
  // 所以这种脏数据永远不会被清理，也不会出现在附件库里。
  // 根因有两条：① 项目子表枚举漏了 schedules；② 直接上传时 project_id 没有自动推导。
  // 下面这组断言专门盯这两条，任何一条回退都会红。
  console.log('\n[6] 计划节点上的附件：删项目时必须被正确处理');
  {
    const p6 = (await post('/api/save/projects', { name: TAG + '节点项目', code: TAG + 'N', status: '进行中' })).body;
    const c6 = (await post('/api/save/contracts', {
      name: TAG + '节点合同', project_id: p6.id, direction: 'in', amount: 500000, status: '执行中',
      payment_terms: '预付款50%，验收款50%',
    })).body;
    await post(`/api/contract/${c6.id}/plan`, {});
    const node = (await get('/api/list/schedules?q=' + encodeURIComponent(TAG))).rows[0];
    check('拿到了收付款计划节点', !!node, node ? `#${node.id}` : '没拿到');

    const nodeAtt = await upload('schedules', node.id, path.join(FIX, 'invoice.pdf'));
    check('附件挂到计划节点上', !!nodeAtt.id && nodeAtt.table_name === 'schedules',
      `#${nodeAtt.id} table_name=${nodeAtt.table_name}`);
    // 关键：没传 project_id 也必须自动推导出来
    check('上传时自动推导出 project_id', !!nodeAtt.project_id, 'project_id=' + nodeAtt.project_id);

    const r6 = await post('/api/batch-delete', { table: 'projects', ids: [p6.id], cascade: true, keepAttachments: true });
    check('删除项目', r6.status === 200 && r6.body.deleted === 1, JSON.stringify(r6.body));
    check('报告保留了计划节点上的附件', r6.body.removedFiles >= 1, '保留 ' + r6.body.removedFiles);

    const a6 = (await get('/api/attachments')).rows.find(x => x.id === nodeAtt.id);
    check('附件被标记为已解除关联（不再是悬空引用）',
      !!a6 && a6.detached === 1 && !a6.record_id,
      a6 ? `detached=${a6.detached} record_id=${a6.record_id}` : '附件不见了');
    const storage6 = require('../storage.js').storage;
    check('扫描件文件仍在', !!a6 && storage6.exists(a6.stored_name),
      a6 ? a6.stored_name : '');
    await post(`/api/attachments/${nodeAtt.id}/delete`, {});
  }

  // ================= 7. 清理 =================
  console.log('\n[7] 清理');
  for (const kw of [TAG, TAG + '甲方', TAG + '孤立单位', TAG + '批量', TAG + '节点项目', TAG + '节点合同']) {
    for (const t of ['contracts', 'projects', 'partners', 'invoices', 'payments', 'schedules']) {
      const list = await get(`/api/list/${t}?q=` + encodeURIComponent(kw));
      for (const row of list.rows) await post(`/api/delete/${t}/${row.id}`, { cascade: true, keepAttachments: false });
    }
  }
  for (const a of [att, att2]) await post(`/api/attachments/${a.id}/delete`, {});
  const d = await get('/api/dashboard');
  const st2 = await get('/api/attachments/stats');
  check('测试数据已清理（数量回到测试前）',
    d.totals.project_count === BASE_TOTALS.project_count
    && d.totals.contract_count === BASE_TOTALS.contract_count && st2.detached === 0,
    `项目 ${d.totals.project_count}（测试前 ${BASE_TOTALS.project_count}）`
    + ` / 合同 ${d.totals.contract_count}（测试前 ${BASE_TOTALS.contract_count}） / detached ${st2.detached}`);

  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(58));
  console.log(`  批量删除测试：${results.length - failed.length} / ${results.length} 项通过`);
  if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name).join('\n'));
  console.log('='.repeat(58));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('\n[测试异常]', e.message); process.exit(1); });
