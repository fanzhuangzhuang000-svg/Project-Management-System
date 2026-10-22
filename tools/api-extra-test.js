'use strict';
/**
 * 边角接口 + 越权回归（第十套）
 *
 * 用法： node tools/api-extra-test.js [http://127.0.0.1:8792]
 *
 * 为什么单独一套：
 *   tools/ 下原有的 28 个套件把主要业务都测了，但有一批接口**从来没有任何
 *   断言碰过** —— 它们要么是低频操作（解锁账号、清理日志、清空示例数据），
 *   要么只有前端某个按钮会调（重新匹配、计划预览、批量删除的 dryRun）。
 *   低频不等于低风险：删审计日志、清空数据这两件事恰恰是最需要留痕的，
 *   而它们之前既不校验表级权限，也不写日志。
 *
 * 这一套同时充当安全回归：
 *   · 暂存附件能不能被别人删 / 被别人挂走
 *   · 有回收站权限但没有该表写权限的人，能不能把记录"还原"回来
 *   · 有导入权限但没有目标表写权限的人，能不能往任意表灌数据
 *   · 普通账号能不能读到授权码和内网备份路径
 */
const T = require('./test-auth.js');
const BASE = process.argv[2] || T.BASE;

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

T.forceAdminPassword();

const j = async (r) => { try { return await r.json() } catch { return {} } };

(async () => {
  await T.login();
  const adminTok = await T.login();
  const A = { Cookie: 'pms_session=' + adminTok, 'Content-Type': 'application/json' };

  const af = (path, opt = {}) => fetch(BASE + path, { headers: A, ...opt });
  const apost = (path, body) => af(path, { method: 'POST', body: JSON.stringify(body || {}) }).then(j);
  // ⚠️ 用**指定账号**发请求。
  //    这里踩过一次：一开始所有 POST 都走上面的 apost（固定带管理员 Cookie），
  //    于是「非上传人挂不走别人的附件」那条实际上是管理员自己挂自己的附件，
  //    产品明明拦住了，测试却报错 —— 错的是测试，不是代码。
  const postAs = (H, path, body) => fetch(BASE + path, {
    method: 'POST', headers: H, body: JSON.stringify(body || {}),
  }).then(j);

  /** 建一个只有指定权限的账号，返回它的请求头 */
  async function mkUser (perm, tag) {
    const uname = 'probe_' + tag + '_' + Date.now().toString(36).slice(-5);
    const cr = await apost('/api/users', {
      username: uname, name: '探测-' + tag, role: 'custom',
      read: perm.read || [], write: perm.write || [], sys: perm.sys || [],
    });
    if (cr.error) throw new Error('建账号失败：' + cr.error);
    const lr = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: uname, password: '123456' }),
    });
    const tok = (lr.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/)[1];
    return { id: cr.id, username: uname, H: { Cookie: 'pms_session=' + tok, 'Content-Type': 'application/json' } };
  }

  try {
    // ================= 1. 暂存附件的归属 =================
    console.log('\n[1] 暂存附件：别人不能删、不能挂走');
    const pdf = require('node:fs').readFileSync(require('node:path').join(__dirname, 'fixtures', 'contract.pdf'));
    const fd = new FormData();
    fd.append('file', new Blob([pdf], { type: 'application/pdf' }), 'EXTRA-归属测试.pdf');
    const up = await fetch(BASE + '/api/upload', {
      method: 'POST', headers: { Cookie: A.Cookie }, body: fd,
    }).then(j);
    check('上传暂存附件', !!up.attachment?.id, 'id=' + (up.attachment?.id || '-'));
    const attId = up.attachment?.id;

    const u1 = await mkUser({ read: ['projects', 'contracts'], write: ['projects', 'contracts'] }, 'att');
    let r = await fetch(BASE + '/api/attachments/' + attId + '/delete', { method: 'POST', headers: u1.H, body: '{}' });
    check('非上传人删除暂存附件被拒', r.status === 403, 'HTTP ' + r.status);

    // 试着把它挂到自己新建的合同上（用 u1 自己的身份）
    const p = await postAs(u1.H, '/api/save/projects', { code: 'EXTRA-P1', name: 'EXTRA 附件归属项目', status: '未开工' });
    check('探测账号可以建自己的项目', !!p.id, 'id=' + (p.id || JSON.stringify(p).slice(0, 40)));
    const c = await postAs(u1.H, '/api/save/contracts', {
      code: 'EXTRA-C1', name: 'EXTRA 合同', project_id: p.id, direction: 'in',
      amount: 1000, partner_id: null, __attach_ids: [attId],
    });
    check('非上传人挂不走别人的暂存附件', c.ok && !c.linkedAttachments,
      `linked=${c.linkedAttachments}`);
    const still = await (await af('/api/attachments?q=EXTRA-归属测试')).json();
    check('附件仍是暂存状态（没被挂走）', (still.rows || [])[0]?.record_id === null,
      'record_id=' + (still.rows || [])[0]?.record_id);

    r = await fetch(BASE + '/api/attachments/' + attId + '/delete', { method: 'POST', headers: A, body: '{}' });
    check('上传人自己可以删除', r.status === 200, 'HTTP ' + r.status);

    // ================= 2. 回收站还原 =================
    console.log('\n[2] 回收站：还原必须校验原表写权限');
    const m = await apost('/api/save/materials', { project_id: p.id, name: 'EXTRA-材料-待删', qty: 1, price: 1 });
    const del = await apost('/api/delete/materials/' + m.id, {});
    check('删除一条材料（进回收站）', del.ok === true, JSON.stringify(del).slice(0, 60));
    const trashList = await (await af('/api/trash')).json();
    const entry = (trashList.rows || []).find(x => x.table_name === 'materials');
    check('回收站里能找到它', !!entry, entry ? '#' + entry.id + ' ' + entry.label : '（没找到）');

    // sys:trash 但没有 materials 写权限
    const u2 = await mkUser({ read: [], write: [], sys: ['trash'] }, 'trash');
    if (entry) {
      r = await fetch(BASE + '/api/trash/' + entry.id + '/restore', { method: 'POST', headers: u2.H, body: '{}' });
      check('无该表写权限的账号还原被拒', r.status === 403, 'HTTP ' + r.status);
      // 管理员可以还原
      const rr = await apost('/api/trash/' + entry.id + '/restore', {});
      check('管理员可以还原', rr.ok === true, JSON.stringify(rr).slice(0, 50));
    } else skipCheck('回收站还原越权', '没拿到回收站条目');

    // ================= 3. 导入的表级写权限 =================
    console.log('\n[3] 导入：必须按目标表校验写权限');
    const u3 = await mkUser({ read: ['partners'], write: ['partners'], sys: ['import'] }, 'imp');
    const csv = '收款日期,收款金额\n2026-01-01,100\n';
    const fd2 = new FormData();
    fd2.append('file', new Blob([csv], { type: 'text/csv' }), 'x.csv');
    r = await fetch(BASE + '/api/import/payments', { method: 'POST', headers: { Cookie: u3.H.Cookie }, body: fd2 });
    check('无权往 payments 导入被拒', r.status === 403, 'HTTP ' + r.status);

    const fd3 = new FormData();
    fd3.append('file', new Blob([csv], { type: 'text/csv' }), 'x.csv');
    r = await fetch(BASE + '/api/import/partners', { method: 'POST', headers: { Cookie: u3.H.Cookie }, body: fd3 });
    check('有权往 partners 导入放行（不因加校验而误伤）', r.status !== 403, 'HTTP ' + r.status);

    // ================= 4. 设置脱敏 =================
    console.log('\n[4] 系统设置：普通账号读不到授权码与备份路径');
    await apost('/api/settings', { settings: { backup_share: '\\\\NAS-OFFICE\\backup\\elv-pms', license_key: 'TEST-LICENSE-TOKEN' } });
    const adminSet = await (await af('/api/settings')).json();
    check('管理员能看到 backup_share', adminSet.settings?.backup_share === '\\\\NAS-OFFICE\\backup\\elv-pms',
      String(adminSet.settings?.backup_share));

    const u4 = await mkUser({ read: ['materials'], write: [] }, 'set');
    const limSet = await (await fetch(BASE + '/api/settings', { headers: u4.H })).json();
    check('普通账号读到的 backup_share 被清空', limSet.settings?.backup_share === '',
      JSON.stringify(limSet.settings?.backup_share));
    check('普通账号读到的 license_key 被清空', limSet.settings?.license_key === '',
      JSON.stringify(limSet.settings?.license_key));
    check('普通账号仍能读到标题与公司名',
      !!limSet.settings?.system_name && !!limSet.settings?.company_name,
      limSet.settings?.system_name);

    const limMe = await (await fetch(BASE + '/api/me', { headers: u4.H })).json();
    check('/api/me 同样脱敏', limMe.settings?.license_key === '' && limMe.settings?.backup_share === '');

    // 复原，别把测试值留在库里
    await apost('/api/settings', { settings: { backup_share: '', license_key: '' } });

    // ================= 4.5 驾驶舱按权限裁剪 =================
    //
    // 这一节盯的是一类「正则表达式的错别字」型 BUG：
    // dashboardFor() 里原本写着
    //   for (const k of [... 'month_in', 'month_out']) d.totals[k] = null;
    // 但 month_in / month_out 是**顶层**字段，压根不在 totals 里 ——
    // 于是循环什么也没清，没有收付款读权限的账号照样在首页看到「本月已回款 X 万」。
    // 代码不报错、页面上也没异常，只有拿受限账号请求一次才看得出来。
    console.log('\n[4.5] 驾驶舱：没有收付款读权限就看不到金额');
    const u4b = await mkUser({ read: ['projects', 'contracts'], write: [] }, 'dash');
    const dashLim = await (await fetch(BASE + '/api/dashboard', { headers: u4b.H })).json();
    const LT = dashLim.totals || {};
    check('没有收付款读权限 → 本月回款不给', dashLim.month_in === null || dashLim.month_in === undefined,
      JSON.stringify(dashLim.month_in));
    check('没有收付款读权限 → 本月付款不给', dashLim.month_out === null || dashLim.month_out === undefined,
      JSON.stringify(dashLim.month_out));
    check('没有收付款读权限 → 已收款/应收为 null', LT.paid_in === null && LT.receivable === null,
      `paid_in=${JSON.stringify(LT.paid_in)} receivable=${JSON.stringify(LT.receivable)}`);
    check('没有收付款读权限 → 月度资金流清空', Array.isArray(dashLim.monthly) && dashLim.monthly.length === 0,
      `${(dashLim.monthly || []).length} 个月`);
    // 反面对照：管理员同一次请求里必须拿得到，证明上面不是「字段本来就没有」
    const dashAdmin = await (await af('/api/dashboard')).json();
    check('管理员同名字段有值（对照）',
      typeof dashAdmin.month_in === 'number' && typeof dashAdmin.totals?.paid_in === 'number',
      `month_in=${dashAdmin.month_in} paid_in=${dashAdmin.totals?.paid_in}`);

    // ================= 5. 破坏性操作必须留痕 =================
    console.log('\n[5] 破坏性操作写审计日志');
    await apost('/api/logs/purge', { days: 3650 });
    let logs = await (await af('/api/logs?limit=50')).json();
    check('清理日志本身被记了一笔',
      (logs.rows || []).some(x => String(x.label || '').includes('清理操作日志')),
      (logs.rows || []).find(x => String(x.label || '').includes('清理操作日志'))?.summary || '没找到');

    const before = await (await af('/api/dashboard')).json();
    await apost('/api/demo/clear', {});
    logs = await (await af('/api/logs?limit=50')).json();
    check('清空示例数据被记了一笔',
      (logs.rows || []).some(x => String(x.label || '').includes('清空示例数据')),
      (logs.rows || []).find(x => String(x.label || '').includes('清空示例数据'))?.summary || '没找到');
    check('清空确实生效（示例数据没了）',
      (await (await af('/api/dashboard')).json()).totals.project_count < before.totals.project_count,
      `${before.totals.project_count} → 待确认`);
    // 补回示例数据，后面的套件和人工点开都要用
    await apost('/api/demo/seed', {});

    // ================= 6. 从未被覆盖的接口 =================
    console.log('\n[6] 低频接口');
    const p2 = await apost('/api/save/projects', {
      code: 'EXTRA-P2', name: 'EXTRA 低频接口项目', status: '进行中', client_id: null,
    });
    check('保存项目', !!p2.id, 'id=' + p2.id);

    const sc = await apost('/api/save/schedules', {
      project_id: p2.id, direction: 'in', phase: '进度款',
      amount: 5000, due_date: '2026-12-01',
    });
    check('保存收付款计划（此前零覆盖）', !!sc.id, 'id=' + sc.id);

    const c2 = await apost('/api/save/contracts', {
      code: 'EXTRA-C2', name: 'EXTRA 计划预览合同', project_id: p2.id, direction: 'in',
      amount: 100000, payment_terms: '预付款30%，验收款65%，质保金5%',
    });
    const pv = await apost('/api/contract/' + c2.id + '/plan', { preview: true });
    check('付款条款预览返回节点但不写库', Array.isArray(pv.nodes) && pv.nodes.length >= 2,
      (pv.nodes || []).map(n => n.phase).join('/'));
    const beforePlan = (await (await af('/api/list/schedules?q=EXTRA')).json()).total;
    const gen = await apost('/api/contract/' + c2.id + '/plan', {});
    const afterPlan = (await (await af('/api/list/schedules?q=EXTRA')).json()).total;
    check('正式生成计划会写库', gen.ok && afterPlan > beforePlan, `${beforePlan} → ${afterPlan}`);

    const dry = await apost('/api/batch-delete', { table: 'materials', ids: [m.id], dryRun: true });
    check('批量删除 dryRun 只探测不改数据', dry.dryRun === true, JSON.stringify(dry.affected || {}));
    const stillThere = await (await af('/api/get/materials/' + m.id)).json();
    check('dryRun 之后记录还在', !!stillThere.id, 'id=' + stillThere.id);

    // 批量删除的回收站标签（回归：曾经全是 "#12"）
    const m2 = await apost('/api/save/materials', { project_id: p2.id, name: 'EXTRA-标签材料', qty: 2, price: 3 });
    await apost('/api/batch-delete', { table: 'materials', ids: [m2.id], cascade: true });
    const tl = await (await af('/api/trash')).json();
    const ent2 = (tl.rows || []).find(x => x.table_name === 'materials' && String(x.label || '').includes('EXTRA-标签材料'));
    check('批量删除后回收站里显示的是名称而不是 #id',
      !!ent2, ent2 ? ent2.label : ((tl.rows || [])[0] || {}).label);

    // 附件 inline 预览
    const fd4 = new FormData();
    fd4.append('file', new Blob([pdf], { type: 'application/pdf' }), 'EXTRA-inline.pdf');
    const up2 = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: A.Cookie }, body: fd4 }).then(j);
    r = await af('/api/file/' + up2.attachment.id + '?inline=1');
    check('附件按 inline 方式预览', r.status === 200 && /inline/i.test(r.headers.get('content-disposition') || ''),
      'HTTP ' + r.status + ' ' + String(r.headers.get('content-disposition') || '').slice(0, 40));
    // 重新匹配依赖识别结果，先等 OCR 跑完（数字版 PDF，通常一两秒）
    let ocrReady = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 500));
      const l = await (await af('/api/attachments?q=EXTRA-inline')).json();
      if ((l.rows || [])[0]?.ocr_status === 'done') { ocrReady = true; break }
    }
    if (ocrReady) {
      // 这个接口返回的是更新后的附件行（不是 {ok:true}），
      // 断言要看它有没有把 parties/suggest 重新算出来。
      const rm = await apost('/api/attachments/' + up2.attachment.id + '/rematch', {});
      check('重新匹配单位/项目（此前零覆盖）',
        rm && rm.id === up2.attachment.id && Array.isArray(rm.ocr?.parties) && !!rm.ocr?.suggest,
        `parties=${(rm.ocr?.parties || []).length} suggest=${!!rm.ocr?.suggest}`);
    } else {
      skipCheck('重新匹配单位/项目', 'OCR 未在 10 秒内完成');
    }
    await fetch(BASE + '/api/attachments/' + up2.attachment.id + '/delete', { method: 'POST', headers: A, body: '{}' });

    // 解除登录锁定
    const ul = await apost('/api/users/unlock', { username: 'nobody-at-all' });
    check('解除登录锁定（此前零覆盖）', ul.ok === true, 'cleared=' + ul.cleared);

    // 重置密码
    const u5 = await mkUser({ read: ['materials'] }, 'pw');
    const rp = await apost('/api/users/' + u5.id + '/reset', { password: 'NewPw-9182' });
    check('重置密码接口可用', rp.ok === true, JSON.stringify(rp).slice(0, 40));
    const nr = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u5.username, password: 'NewPw-9182' }),
    });
    check('重置后的新密码能登录', nr.status === 200, 'HTTP ' + nr.status);

    // 清理测试数据
    for (const id of [p.id, p2.id]) await apost('/api/delete/projects/' + id, { cascade: true });
    await fetch(BASE + '/api/trash/purge-all', { method: 'POST', headers: A, body: '{}' });
    // 探测账号也删掉，别留在账号列表里
    for (const u of [u1, u2, u3, u4, u5]) {
      await fetch(BASE + '/api/users/' + u.id + '/delete', { method: 'POST', headers: A, body: '{}' });
    }
  } catch (e) {
    check('测试执行', false, e.message.slice(0, 80));
  }

  const pass = results.filter(x => x.ok).length;
  console.log(`\n  边角接口与越权回归：${pass} / ${results.length} 项通过`
    + (skipped ? `（另有 ${skipped} 条未执行）` : ''));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('  ✗ ' + e.message); process.exit(1) });
