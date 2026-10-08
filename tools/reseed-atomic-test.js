'use strict';
/**
 * 验证「清空+重建示例数据」的一致性
 *
 * 背景：以前端点是先 clear（一次事务）再 seed（另一次事务），
 * 中间有个极短空窗，并发读取会看到「示例数据全没了」——
 * 实测偶发把 materials 读成 0，查了很久才定位到时序问题。
 *
 * 现在收敛成 reseedDemo()：仍是「先清后写」两次写（seed 内部嵌套调用
 * 不允许外层再包事务，详见 db.js 第 1540 行注释），但把"清完立即重播"
 * 收敛在 db.js 一个函数里，调用方（含 ensureDemoData）做"播完再校验、
 * 不齐重试"兜底。这个测试压的是反复重建是否**幂等**与**并发读不到空窗**。
 */
const T = require('./test-auth.js');

(async () => {
  T.forceAdminPassword();
  await T.login();
  const H = { Cookie: T.cookieHeader(), 'Content-Type': 'application/json' };
  const B = T.BASE;

  const dash = async () => {
    const r = await fetch(B + '/api/dashboard', { headers: H });
    return r.json();
  };

  // 先确保有数据
  await fetch(B + '/api/demo/seed', { method: 'POST', headers: H });
  const first = await dash();
  console.log(`  [1] 初始材料数 ${first.totals.material_count}`);

  console.log('  [2] 一边反复重建、一边并发读（看会不会读到中间态）');
  let reads = 0, zeros = 0, minSeen = Infinity;
  const rebuild = async () => {
    for (let i = 0; i < 30; i++) await fetch(B + '/api/demo/seed', { method: 'POST', headers: H });
  };
  const reader = async () => {
    for (let i = 0; i < 120; i++) {
      const d = await dash();
      const n = d.totals.material_count;
      reads++;
      if (n < minSeen) minSeen = n;
      if (!(n > 0)) zeros++;
    }
  };
  await Promise.all([rebuild(), reader(), reader()]);

  console.log(`      读了 ${reads} 次，最小值 ${minSeen}，读到 0 的次数 ${zeros}`);
  console.log(`      ${zeros === 0 ? '✓ 并发读不到中间空窗' : '✗ 仍有 ' + zeros + ' 次读到空窗'}`);

  console.log('  [3] 数据仍然完整');
  const after = await dash();
  const ok = after.totals.material_count > 0 && after.totals.project_count > 0 && after.totals.contract_count > 0;
  console.log(`      项目 ${after.totals.project_count} / 合同 ${after.totals.contract_count} / 材料 ${after.totals.material_count}  ${ok ? '✓' : '✗'}`);

  // 顺带确认：反复重建不会累积（之前踩过 material 累积的坑）
  //
  // ⚠️ 这里原来是写死的 `project_count === 4`，从一开始就是错的：
  //    种子函数（db.js 的 reseedDemo）只建 **3** 个示例项目（DEMO-2026-001/002/2025-018），
  //    历史上也从没出现过第 4 个（git log -S 'DEMO-2026-003' 为空）。
  //    "期望 4" 之所以有时能过，是因为它数的是**全库**项目数 ——
  //    前一个套件（界面/新功能测试）留下的测试项目没被清掉，正好凑够 4 个。
  //    结果就是：单跑必红、夹在一串套件后面跑偶尔绿，纯粹看执行顺序。
  //    真正要压的是"反复重建不会越建越多"，所以改成和自己比，不再依赖那个魔法数。
  console.log('  [4] 反复重建不会累积重复数据');
  const before4 = await dash();
  for (let i = 0; i < 3; i++) await fetch(B + '/api/demo/seed', { method: 'POST', headers: H });
  const d4 = await dash();
  const p0 = before4.totals.project_count, m0 = before4.totals.material_count;
  const noDup = p0 > 0 && m0 > 0
    && d4.totals.project_count === p0 && d4.totals.material_count === m0;
  console.log(`      连播 3 次后：项目 ${d4.totals.project_count}（播前 ${p0}）/ 材料 ${d4.totals.material_count}（播前 ${m0}）  ${noDup ? '✓' : '✗'}`);

  const pass = zeros === 0 && ok && noDup;
  console.log('\n  ' + '='.repeat(52));
  console.log(`  一致性验证：${pass ? '通过' : '不通过'}`);
  console.log('  ' + '='.repeat(52));
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('  ✗ ' + e.message); process.exit(1) });
