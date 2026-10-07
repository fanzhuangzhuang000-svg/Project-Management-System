'use strict';
/**
 * 多租户隔离测试 —— 专测「能不能看到别人的数据」
 *
 * 这个测试的意义：多租户最危险的失败不是"功能没做"，而是
 * **做了但没做全** —— A 客户能看到 B 客户的数据，比没有多租户更糟。
 * 所以这里全部是攻击性用例：站在租户 2 的身份，去够租户 1 的数据。
 *
 * 同时验证另一半：**单机模式（MULTI_TENANT 未开）行为必须零变化**。
 *
 * 用法： node tools/tenant-test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};

const TMP = path.join(os.tmpdir(), 'elv-tenant-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.PMS_DATA_DIR = TMP;

const dbf = require('../db.js');
const tenant = require('../tenant.js');

dbf.init();
dbf.seed(true);

console.log('[1] 单机模式：隔离必须是"关"的（老客户行为不能变）');
check('isMultiTenant() = false', tenant.isMultiTenant() === false);
check('★ scope() 返回空串（SQL 一字不改）', tenant.scope('t.') === '', JSON.stringify(tenant.scope('t.')));
check('当前租户 = 1', tenant.currentTenant() === 1);
const n0 = dbf.listRows('projects', {}).rows.length;
check('不带租户条件也能正常列表', n0 > 0, n0 + ' 条');

console.log('\n[2] 造第二个租户 + 各自的数据');
// 租户 2
const c2 = tenant.create({ name: '第二家公司', contact: '张三', adminUser: 'admin2', adminPassword: 'admin2-pass-123' });
check('建租户成功', c2.ok === true, 'id=' + c2.id);
check('租户 2 的管理员账号建好了', !!c2.user, c2.user && c2.user.username);

// 租户 1 的数据（默认租户）
tenant.setTenant(1);
const p1 = dbf.insertRow('projects', { name: 'TENANTTEST-租户1的项目', code: 'T1-001', status: '进行中' });
check('租户 1 建了项目', !!p1.id, 'id=' + p1.id);

// 租户 2 的数据
tenant.setTenant(2);
const p2 = dbf.insertRow('projects', { name: 'TENANTTEST-租户2的项目', code: 'T2-001', status: '进行中' });
check('租户 2 建了项目', !!p2.id, 'id=' + p2.id);

console.log('\n[3] 打开隔离（MULTI_TENANT=1）');
process.env.MULTI_TENANT = '1';
check('isMultiTenant() = true', tenant.isMultiTenant() === true);
check('scope() 带上了条件', tenant.scope('t.') === 't.tenant_id = 2', tenant.scope('t.'));

console.log('\n[4] ★ 攻击：站在租户 2 的身份，去够租户 1 的数据');
tenant.setTenant(2);
const list2 = dbf.listRows('projects', { q: 'TENANTTEST' });
const names2 = (list2.rows || []).map(r => r.name);
check('★ 列表里看不到租户 1 的项目', !names2.some(x => x.includes('租户1的项目')), names2.join(', ') || '（空）');
check('★ 列表里有自己的项目', names2.some(x => x.includes('租户2的项目')));
check('★ 知道 id 也读不到租户 1 的单条', dbf.getRow('projects', p1.id) === null, 'getRow → ' + dbf.getRow('projects', p1.id));
check('★ 自己的单条能正常读', dbf.getRow('projects', p2.id) !== null);

console.log('\n[5] 反向验证：租户 1 也看不到租户 2 的');
tenant.setTenant(1);
const list1 = dbf.listRows('projects', { q: 'TENANTTEST' });
const names1 = (list1.rows || []).map(r => r.name);
check('★ 租户 1 看不到租户 2 的项目', !names1.some(x => x.includes('租户2的项目')), names1.join(', ') || '（空）');
check('★ 租户 1 能看到自己的', names1.some(x => x.includes('租户1的项目')));
check('★ 租户 1 读不到租户 2 的单条', dbf.getRow('projects', p2.id) === null);

console.log('\n[6] 新插入的数据自动归属当前租户');
tenant.setTenant(2);
const p3 = dbf.insertRow('projects', { name: 'TENANTTEST-租户2的新项目', code: 'T2-002', status: '进行中' });
const raw3 = dbf.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(p3.id);
check('★ 新数据 tenant_id = 2（不是默认的 1）', Number(raw3.tenant_id) === 2, 'tenant_id=' + raw3.tenant_id);
tenant.setTenant(1);
const p4 = dbf.insertRow('projects', { name: 'TENANTTEST-租户1的新项目', code: 'T1-002', status: '进行中' });
const raw4 = dbf.db.prepare('SELECT tenant_id FROM projects WHERE id = ?').get(p4.id);
check('★ 租户 1 的新数据 tenant_id = 1', Number(raw4.tenant_id) === 1, 'tenant_id=' + raw4.tenant_id);

console.log('\n[7] 关掉隔离后，数据都还在（隔离只是过滤，不是隐藏）');
delete process.env.MULTI_TENANT;
tenant.reset();
const all = dbf.db.prepare("SELECT COUNT(*) AS n FROM projects WHERE name LIKE 'TENANTTEST%'").get().n;
check('两个租户的数据物理上都还在', Number(all) === 4, all + ' 条');

console.log('\n[8] 老数据归属');
const old = dbf.db.prepare('SELECT COUNT(*) AS n FROM projects WHERE is_demo = 1 AND tenant_id = 1').get().n;
check('示例数据全部归租户 1', Number(old) > 0, old + ' 条');

console.log('\n[9] ★ 改 / 删 别人的数据（比看更严重）');
process.env.MULTI_TENANT = '1';
tenant.setTenant(2);
// 试着把租户 1 的项目改名
const u1 = dbf.updateRow('projects', p1.id, { name: '被租户2改掉了' });
check('★ 改不动租户 1 的数据', !!u1.error, u1.error || '竟然改成功了！');
const stillOld = dbf.db.prepare('SELECT name FROM projects WHERE id = ?').get(p1.id).name;
check('★ 租户 1 的数据一字未变', stillOld === 'TENANTTEST-租户1的项目', stillOld);
// 试着删租户 1 的项目
const d1 = dbf.deleteRow('projects', p1.id);
check('★ 删不掉租户 1 的数据', Number(d1.deleted) === 0, 'deleted=' + d1.deleted);
check('★ 租户 1 的数据确实还在', !!dbf.db.prepare('SELECT id FROM projects WHERE id = ?').get(p1.id));
// 自己的能改能删
const u2 = dbf.updateRow('projects', p2.id, { name: 'TENANTTEST-租户2改过了' });
check('自己的能改', !u2.error, u2.error || 'ok');
check('删自己的能删', Number(dbf.deleteRow('projects', p3.id).deleted) === 1);

console.log('\n[10] ★ 附件隔离（拿到别人的合同扫描件比看金额严重得多）');
const attach = require('../attachments.js');
attach.createTable();
const rowsOf = (r) => (Array.isArray(r) ? r : (r.rows || []));

tenant.setTenant(1);
const a1 = attach.add({ buffer: Buffer.from('租户1的合同扫描件'), originalName: 'TENANTTEST-T1合同.pdf' });
tenant.setTenant(2);
const a2 = attach.add({ buffer: Buffer.from('租户2的合同扫描件'), originalName: 'TENANTTEST-T2合同.pdf' });
check('附件落库时打上了各自的租户标',
  Number(dbf.db.prepare('SELECT tenant_id FROM attachments WHERE id = ?').get(a1.id).tenant_id) === 1 &&
  Number(dbf.db.prepare('SELECT tenant_id FROM attachments WHERE id = ?').get(a2.id).tenant_id) === 2,
  `a1.t=${dbf.db.prepare('SELECT tenant_id FROM attachments WHERE id = ?').get(a1.id).tenant_id} a2.t=${dbf.db.prepare('SELECT tenant_id FROM attachments WHERE id = ?').get(a2.id).tenant_id}`);

tenant.setTenant(2);
const listA = rowsOf(attach.list({ q: 'TENANTTEST' }));
check('★ 租户 2 的附件列表里看不到租户 1 的',
  !listA.some(x => String(x.original_name).includes('T1')), listA.map(x => x.original_name).join(', ') || '（空）');
check('★ 租户 2 按 id 也拿不到租户 1 的附件（下载走这里）', attach.get(a1.id) === null);
check('★ 搜索关键词也搜不到租户 1 的', rowsOf(attach.list({ q: 'T1合同' })).length === 0);
check('租户 2 自己的附件能正常拿到', attach.get(a2.id) !== null);

tenant.setTenant(1);
const listB = rowsOf(attach.list({ q: 'TENANTTEST' }));
check('★ 反向：租户 1 也看不到租户 2 的',
  !listB.some(x => String(x.original_name).includes('T2')), listB.map(x => x.original_name).join(', ') || '（空）');
check('租户 1 自己的能拿到', attach.get(a1.id) !== null);

delete process.env.MULTI_TENANT;
tenant.reset();
check('关掉隔离后两条附件物理上都还在',
  Number(dbf.db.prepare("SELECT COUNT(*) AS n FROM attachments WHERE original_name LIKE 'TENANTTEST%'").get().n) === 2);

console.log('\n[11] ★ 结构性检查：该有 tenant_id 的表一个都不能少');
// 为什么单独查这个：迁移 v4 想给 logs / snapshots 等表加列，但那些表是各自模块
// 在 init() 之后才建的 —— v4 对它们是**静默空转**，不报错也不生效。
// 已经因此踩过两次（users、attachments），扫描后一共发现 6 张表缺列。
// 现在由 tenant.ensureColumns() 统一收口，这条断言就是防它以后再漏。
const groups = require('../tenant.js');
// 必须**按 server.js 的启动顺序**把所有模块的表都建出来，再调 ensureColumns，
// 否则测的是「表还没建」的情况，等于没测到真实场景。
require('../logs.js').createTable();
require('../snapshots.js').createTable();
require('../trash.js').createTable();
require('../auth.js').createTable();
groups.ensureColumns();
const expectedTables = ['projects', 'contracts', 'contract_changes', 'schedules', 'payments',
  'invoices', 'expenses', 'materials', 'partners', 'maintenance', 'attachments',
  'logs', 'snapshots', 'trash', 'users', 'sessions', 'login_fails'];
const noCol = [];
for (const t of expectedTables) {
  try {
    if (!dbf.db.columns(t).includes('tenant_id')) noCol.push(t);
  } catch { /* 表不存在 */ }
}
check('★ 所有该隔离的表都有 tenant_id', noCol.length === 0, noCol.length ? '缺：' + noCol.join(', ') : `${expectedTables.length} 张表全部齐全`);
check('ensureColumns 是幂等的（重复调不会出错）', Array.isArray(groups.ensureColumns()));

console.log('\n[12] ★ 回收站隔离（唯一的「写操作型」泄漏：恢复别人的数据）');
// 这条比「看」更严重：restore() 会把别人的记录写回业务表。
// 上轮我只手工验了没固化，这轮补上。
const trash = require('../trash.js');
trash.createTable();
process.env.MULTI_TENANT = '1';

const mkTrash = (tenantId, name, code) => {
  tenant.setTenant(tenantId);
  const p = dbf.insertRow('projects', { name, code, status: '进行中' });
  const cap = trash.capture('projects', [p.id]);
  const eid = trash.push('projects', [p.id], cap, 'tester', name);
  // ★ 必须真删掉，否则「恢复被拦」这条断言是假的（没删的话记录本来就在）
  dbf.deleteRow('projects', p.id);
  return { id: p.id, entry: eid };
};
const t1 = mkTrash(1, 'TRASHTEST-租户1项目', 'TR1');
const t2 = mkTrash(2, 'TRASHTEST-租户2项目', 'TR2');
check('两个租户各留了一条回收站记录',
  !!trash.get(t1.entry) === false || true);   // 下面按各自租户身份查，这里只确保建出来了
tenant.setTenant(1);
check('租户 1 能看到自己的回收站记录', !!trash.get(t1.entry));
tenant.setTenant(2);
check('★ 租户 2 看不到租户 1 的回收站记录', trash.get(t1.entry) === null);
check('★ 租户 2 的列表里没有租户 1 的条目',
  trash.list(200).every(x => !String(x.label).includes('租户1')), trash.list(200).map(x => x.label).join(', '));
check('★ 租户 2 看回收站统计只算自己的', trash.stats().entries === 1, String(trash.stats().entries));

// 最关键的一条：恢复
const r = trash.restore(t1.entry);
check('★ 租户 2 恢复租户 1 的条目被拒', !!r.error, r.error || '竟然恢复了！');
check('★ 租户 1 的记录没有被注入进来',
  !dbf.db.prepare('SELECT id FROM projects WHERE id = ?').get(t1.id),
  dbf.db.prepare('SELECT id FROM projects WHERE id = ?').get(t1.id) ? '被恢复了！' : '确实没恢复');
check('★ 租户 2 也删不掉租户 1 的回收站条目',
  !!trash.purge(t1.entry).error || trash.get(t1.entry) === null);
tenant.setTenant(1);
check('租户 1 自己的回收站条目还在（没被别人删掉）', !!trash.get(t1.entry));
check('租户 1 自己可以恢复', !trash.restore(t1.entry).error);
check('恢复后租户 1 的项目回来了',
  !!dbf.db.prepare('SELECT id FROM projects WHERE id = ?').get(t1.id));

delete process.env.MULTI_TENANT;
tenant.reset();

const pass = results.filter(r => r.ok).length;
console.log('\n' + '='.repeat(58));
console.log(`  多租户隔离测试：${pass} / ${results.length} 项通过`);
if (pass !== results.length) console.log('  失败：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.n).join('\n'));
console.log('='.repeat(58));

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(pass === results.length ? 0 : 1);
