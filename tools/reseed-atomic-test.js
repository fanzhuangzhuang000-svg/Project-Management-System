'use strict';
/**
 * 验证「清空+重建示例数据」的原子性
 *
 * 背景：以前端点是先 clear（一次事务）再 seed（另一次事务），
 * 中间有个极短空窗，并发读取会看到「示例数据全没了」——
 * 实测偶发把 materials 读成 0，查了很久才定位到时序问题。
 *
 * 现在改成 reseedDemo()：一个事务里做完。这个测试就是压它。
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
  console.log(`      ${zeros === 0 ? '✓ 原子化生效，读不到中间态' : '✗ 仍有 ' + zeros + ' 次读到空窗'}`);

  console.log('  [3] 数据仍然完整');
  const after = await dash();
  const ok = after.totals.material_count > 0 && after.totals.project_count > 0 && after.totals.contract_count > 0;
  console.log(`      项目 ${after.totals.project_count} / 合同 ${after.totals.contract_count} / 材料 ${after.totals.material_count}  ${ok ? '✓' : '✗'}`);

  // 顺带确认：反复重建不会累积（之前踩过 material 累积的坑）
  console.log('  [4] 反复重建不会累积重复数据');
  for (let i = 0; i < 3; i++) await fetch(B + '/api/demo/seed', { method: 'POST', headers: H });
  const d4 = await dash();
  const noDup = d4.totals.project_count === 4 && d4.totals.material_count === 12;
  console.log(`      连播 3 次后：项目 ${d4.totals.project_count}（期望 4）/ 材料 ${d4.totals.material_count}（期望 12）  ${noDup ? '✓' : '✗'}`);

  const pass = zeros === 0 && ok && noDup;
  console.log('\n  ' + '='.repeat(52));
  console.log(`  原子性验证：${pass ? '通过' : '不通过'}`);
  console.log('  ' + '='.repeat(52));
  process.exit(pass ? 0 : 1);
})().catch(e => { console.error('  ✗ ' + e.message); process.exit(1) });
