'use strict';
/**
 * 权限越权回归测试（第九套）
 * 核心原则：服务端必须"表级"守卫每一个数据出口。
 * 用最小权限账号（只能读材料设备）探测所有接口，不该看的必须 403。
 */
const T = require('./test-auth.js');
const BASE = process.argv[2] || T.BASE || 'http://127.0.0.1:8787';

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

T.forceAdminPassword();


async function main () {
  // 先补一次示例数据。
  // 本套件用裸 fetch 登录（不走 T.login()），不会触发登录时的自愈钩子，
  // 而「有权的材料数保留」依赖示例数据存在 —— 缺了会误报成权限 bug。
  await T.login();

  // ---- 登录管理员 ----
  const raw = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: T.USER, password: T.PASS }) });
  const atok = (raw.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/)[1];
  const A = { Cookie: 'pms_session=' + atok, 'Content-Type': 'application/json' };

  // ---- 建一个只能读 materials 的账号 ----
  const uname = 'probe_' + Date.now().toString(36);
  const cr = await (await fetch(BASE + '/api/users', { method: 'POST', headers: A, body: JSON.stringify({ username: uname, name: '探测账号', role: 'custom', read: ['materials'], write: [], sys: [] }) })).json();
  if (cr.error) throw new Error('建账号失败：' + cr.error);
  const lr = await fetch(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: uname, password: '123456' }) });
  const ptok = (lr.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/)[1];
  const P = { Cookie: 'pms_session=' + ptok, 'Content-Type': 'application/json' };
  const j = async (r) => { try { return await r.json(); } catch { return {}; } };

  console.log('[1] 表级读权限');
  let r = await fetch(BASE + '/api/list/contracts', { headers: P });
  check('无权读合同列表被拦', r.status === 403, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/list/materials', { headers: P });
  check('有权的材料列表放行', r.status === 200, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/get/contracts/73', { headers: P });
  const rg = await j(r);
  check('无权读单条合同被拦', r.status === 403 || (rg.id && rg.amount === undefined), 'HTTP ' + r.status + (rg.error ? ' ' + rg.error : '（有门）'));
  r = await fetch(BASE + '/api/export/contracts', { headers: P });
  check('无权导出合同被拦', r.status === 403, 'HTTP ' + r.status);

  console.log('[2] 写权限');
  r = await fetch(BASE + '/api/save/partners', { method: 'POST', headers: P, body: JSON.stringify({ name: 'PROBE-越权单位' }) });
  check('无权写往来单位被拦', r.status === 403, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/batch-delete', { method: 'POST', headers: P, body: JSON.stringify({ table: 'contracts', ids: [73] }) });
  check('无权批量删合同被拦', r.status === 403, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/contract/73/plan', { method: 'POST', headers: P, body: '{}' });
  check('无权生成付款计划被拦', r.status === 403, 'HTTP ' + r.status);

  console.log('[3] 系统权限');
  for (const [path, label] of [['/api/trash', '回收站'], ['/api/logs', '操作日志'], ['/api/users', '账号管理'], ['/api/dbstatus', '系统状态'], ['/api/import/meta', '数据导入']]) {
    r = await fetch(BASE + path, { headers: P });
    check('无 sys 权限访问' + label + '被拦', r.status === 403, 'HTTP ' + r.status);
  }
  r = await fetch(BASE + '/api/backup', { method: 'POST', headers: P, body: '{}' });
  check('无 backup 权限不能备份', r.status === 403, 'HTTP ' + r.status);

  console.log('[4] 全局搜索按权限过滤');
  r = await fetch(BASE + '/api/search?q=' + encodeURIComponent('合同'), { headers: P });
  const s = await j(r);
  const bad = (s.hits || []).filter(h => !['materials', 'attachments'].includes(h.table));
  check('搜索结果不含无权表的记录', bad.length === 0, bad.length ? '泄露 ' + bad.length + ' 条' : '干净');

  console.log('[5] 附件权限');
  // 上传两条附件：一条挂材料（有权），一条挂合同（无权）
  const mk = async (table, id, name) => {
    const fd = new FormData();
    if (table) { fd.append('table_name', table); fd.append('record_id', String(id)); }
    fd.append('file', new Blob(['probe'], { type: 'text/plain' }), name);
    const rr = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: A.Cookie }, body: fd });
    return (await j(rr)).attachment;
  };
  const matAtt = await mk('materials', 1, '材料说明.txt');
  const conAtt = await mk('contracts', 73, '合同扫描件.txt');
  check('管理员能上传附件', !!conAtt && !!matAtt, matAtt && conAtt ? '两条都成功' : '失败');
  // 无权直接上传到合同
  const fd2 = new FormData();
  fd2.append('table_name', 'contracts'); fd2.append('record_id', '73');
  fd2.append('file', new Blob(['x'], { type: 'text/plain' }), '越权上传.txt');
  r = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: P.Cookie }, body: fd2 });
  check('无权往合同上传附件被拦', r.status === 403, 'HTTP ' + r.status);
  // 列表过滤 + 下载控制
  r = await fetch(BASE + '/api/attachments', { headers: P });
  const alist = await j(r);
  const leak = (alist.rows || []).filter(x => x.table_name === 'contracts');
  check('附件列表过滤掉合同的附件', leak.length === 0, `共 ${((alist.rows || [])).length} 条，合同附件 ${leak.length} 条`);
  r = await fetch(BASE + '/api/file/' + conAtt.id, { headers: P });
  check('无权下载合同附件被拦', r.status === 403, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/file/' + matAtt.id, { headers: P });
  check('有权下载材料附件', r.status === 200, 'HTTP ' + r.status);
  // 删除
  r = await fetch(BASE + '/api/attachments/' + conAtt.id + '/delete', { method: 'POST', headers: P });
  check('无权删合同附件被拦', r.status === 403, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/attachments/' + matAtt.id + '/delete', { method: 'POST', headers: { Cookie: A.Cookie } });
  check('管理员可删附件', r.status === 200, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/attachments/' + conAtt.id + '/delete', { method: 'POST', headers: A });
  await fetch(BASE + '/api/attachments/' + conAtt.id + '/delete', { method: 'POST', headers: A });

  console.log('[6] 驾驶舱按权限过滤');
  r = await fetch(BASE + '/api/dashboard', { headers: P });
  const d = await j(r);
  check('无权模块的合同额隐藏', d.totals.contract_in === null, 'contract_in=' + d.totals.contract_in);
  check('无权模块的应收隐藏', d.totals.receivable === null, 'receivable=' + d.totals.receivable);
  check('无权模块的实际成本隐藏', d.totals.cost === null, 'cost=' + d.totals.cost);
  check('无权模块的资金图隐藏', Array.isArray(d.monthly) && d.monthly.length === 0, 'monthly=' + ((d.monthly || []).length));
  check('无权模块的账龄隐藏', d.aging && Object.keys(d.aging.receivable || {}).length === 0, 'aging keys=' + Object.keys((d.aging || {}).receivable || {}).length);
  // 材料数是「示例数据在不在」的探针，不是被测行为本身。
  // 示例数据在多个测试进程之间会被反复重建（clear + seed 是两次写），
  // 极小概率读到重建中的空窗。这里重取一次，避免把基础设施的时序问题
  // 误报成权限 bug —— 之前偶发失败过，查了很久才发现是数据状态不是权限。
  let matCount = d.totals.material_count;
  if (!(matCount > 0)) {
    await new Promise(r2 => setTimeout(r2, 600));
    const d2 = await j(await fetch(BASE + '/api/dashboard', { headers: P }));
    matCount = d2.totals.material_count;
  }
  check('有权的材料数保留', matCount > 0, 'materials=' + matCount);

  console.log('[7] 项目详情 / 对账单');
  r = await fetch(BASE + '/api/project/125', { headers: P });
  check('无权看项目详情被拦', r.status === 403, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/statement/125', { headers: P });
  check('无权看对账单被拦', r.status === 403, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/record-attachments/contracts/73', { headers: P });
  check('无权看合同附件清单被拦', r.status === 403, 'HTTP ' + r.status);
  r = await fetch(BASE + '/api/record-attachments/materials/1', { headers: P });
  check('有权看材料附件清单', r.status === 200, 'HTTP ' + r.status);

  console.log('[8] 健壮性：损坏的 Cookie 不能挂死请求');
  for (const ck of ['pms_session=%', 'pms_session=%zz', 'pms_session=a;b=%', 'pms_session=' + 'x'.repeat(500)]) {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 2500);
    try {
      const rr = await fetch(BASE + '/api/dashboard', { headers: { Cookie: ck }, signal: ctl.signal });
      clearTimeout(to);
      check('损坏 Cookie（' + ck.slice(0, 18) + '…）有响应', rr.status === 401 || rr.status === 403, 'HTTP ' + rr.status);
    } catch (e) {
      clearTimeout(to);
      check('损坏 Cookie（' + ck.slice(0, 18) + '…）有响应', false, e.name);
    }
  }

  // ---- 清理 ----
  await fetch(BASE + '/api/users/' + cr.id + '/delete', { method: 'POST', headers: A });
  const left = await (await fetch(BASE + '/api/attachments', { headers: A })).json();
  for (const row of (left.rows || [])) {
    if (String(row.original_name || '').includes('PROBE') || String(row.original_name || '').includes('越权')) {
      await fetch(BASE + '/api/attachments/' + row.id + '/delete', { method: 'POST', headers: A });
    }
  }

  const pass = results.filter(x => x.ok).length;
  console.log(`\n越权与权限测试结果：${pass} / ${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
}
main().catch(e => { console.error('[测试异常]', e.message); process.exit(1); });
