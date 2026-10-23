'use strict';
/**
 * 脏表收集（dirty.js）单元测试
 *
 * 看板缓存的失效判据从「请求方法不是 GET」换成了「这次请求真的改了哪张表」。
 * 这个改动唯一的风险是**漏埋点**：某个写路径忘了 mark，界面就会停在旧账上
 * （最多 20 秒，用户会以为没保存）。所以这里把每类写原语都过一遍：
 *   · 真的改了行 → 必须记上对应的表
 *   · 没改成（id 不存在 / 校验没过）→ 不许记
 *   · 只写日志 / 只更新登录时间 → 不许记（否则每次登录全站重算）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), 'elv-dirty-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.PMS_DATA_DIR = TMP;
process.env.PMS_NO_AUTO_BACKUP = '1';
process.env.PMS_MAINTENANCE_INTERVAL_MS = '0';

const dbf = require('../db.js');
const dirty = require('../dirty.js');

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
/** 在一个「请求作用域」里跑 fn，返回它记下的脏表 */
function scope (fn) {
  return dirty.run(() => {
    const out = fn();
    return { out, tables: dirty.end() };
  });
}
const sorted = (a) => [...new Set(a)].sort().join(',');

dbf.init();
const auth = require('../auth.js');
const logmod = require('../logs.js');
const attach = require('../attachments.js');
auth.createTable();
logmod.createTable();
attach.createTable();
require('../tenant.js').ensureColumns();
auth.ensureAdmin();

console.log('[1] 写原语：真的改了行才记账');
{
  const r = scope(() => dbf.insertRow('projects', { name: 'DIRTY-项目', status: '进行中' }));
  check('insertRow(projects) → projects', sorted(r.tables) === 'projects', sorted(r.tables));

  const up = scope(() => dbf.updateRow('projects', r.out.id, { name: 'DIRTY-项目改名' }));
  check('updateRow 命中 → projects', sorted(up.tables) === 'projects', sorted(up.tables));

  const miss = scope(() => dbf.updateRow('projects', 99_999_999, { name: 'X' }));
  check('updateRow 没命中（id 不存在）→ 不记账', miss.tables.length === 0 && !!miss.out.error, sorted(miss.tables));

  const del = scope(() => dbf.deleteRow('projects', r.out.id));
  check('deleteRow 命中 → projects', sorted(del.tables) === 'projects' && del.out.deleted === 1, sorted(del.tables));

  const delMiss = scope(() => dbf.deleteRow('projects', 99_999_999));
  check('deleteRow 没命中 → 不记账', delMiss.tables.length === 0, sorted(delMiss.tables));
}

console.log('\n[2] 日志与登录时间不能算脏（否则每次登录全站重算）');
{
  const lg = scope(() => logmod.log({ action: 'create', table_name: 'projects', label: 'DIRTY-日志' }));
  check('写操作日志 → 不记账（看板不读 logs）', lg.tables.length === 0, sorted(lg.tables));

  const u = auth.saveUser({ username: 'dirty-probe', name: '脏表探针', role: 'custom', password: 'Dirty@12345', status: '启用' }, null);
  const mk = scope(() => auth.saveUser({ username: 'dirty-probe2', name: '脏表探针2', role: 'custom', password: 'Dirty@12345', status: '启用' }, null));
  check('saveUser 建账号 → users', sorted(mk.tables) === 'users', sorted(mk.tables));

  const ml = scope(() => auth.markLogin(u.id));
  check('markLogin（只改 last_login_at）→ 不记账', ml.tables.length === 0, sorted(ml.tables));

  const du = scope(() => auth.deleteUser(u.id, null));
  check('deleteUser → users', sorted(du.tables) === 'users' && du.out.ok === true, sorted(du.tables));
}

console.log('\n[3] 附件（裸 SQL，不走 db.js）');
{
  const a = scope(() => attach.add({ buffer: Buffer.from('x'.repeat(64)), originalName: 'DIRTY.txt' }));
  check('附件上传 → attachments', sorted(a.tables) === 'attachments', sorted(a.tables));
  const rm = scope(() => attach.remove(a.out.id));
  check('附件删除 → attachments', sorted(rm.tables) === 'attachments' && rm.out.deleted === 1, sorted(rm.tables));
}

console.log('\n[4] 计划生成 / 快照 / 回收站');
{
  const pid = dbf.insertRow('projects', { name: 'DIRTY-计划项目', status: '进行中', start_date: '2026-01-01' }).id;
  const cid = dbf.insertRow('contracts', {
    name: 'DIRTY-计划合同', project_id: pid, direction: 'in', amount: 100000, tax_rate: 9,
    category: '项目合同', sign_date: '2026-01-05',
    payment_terms: '预付款30%，进度款40%，验收款25%，质保金5%',
  }).id;
  const gp = scope(() => dbf.generatePlan(cid));
  check('generatePlan → schedules', sorted(gp.tables) === 'schedules' && gp.out.created > 0,
    sorted(gp.tables) + ' / created=' + (gp.out.created || 0));

  const snap = require('../snapshots.js');
  snap.createTable();
  const cp = scope(() => snap.capture('2026-09', 'manual', 'DIRTY'));
  check('snapshot.capture → snapshots', sorted(cp.tables) === 'snapshots', sorted(cp.tables));
  const rm = scope(() => snap.remove('2026-09'));
  check('snapshot.remove → snapshots', sorted(rm.tables) === 'snapshots' && rm.out.deleted === 1, sorted(rm.tables));
}

console.log('\n[5] 只读操作不记账');
{
  const rd = scope(() => { dbf.dashboard(); dbf.listRows('payments', {}); dbf.projectStatsMany([1]); });
  check('看板/列表/统计 → 不记账', rd.tables.length === 0, sorted(rd.tables));
}

console.log('\n[6] 没有请求上下文时落到 pending（维护任务 / 后台 OCR）');
{
  dirty.takePending();                       // 清空历史
  const w = dbf.insertRow('partners', { name: 'DIRTY-后台写' });
  const pend = dirty.takePending();
  check('请求外写库 → pending 能取到', pend.includes('partners'), sorted(pend) + ' / insert=' + JSON.stringify(w));
  check('取过之后清空（不会重复失效）', dirty.takePending().length === 0);

  // 请求结束之后才发生的写（例如响应发完后 OCR 回填）也走 pending
  dirty.run(() => {
    dbf.insertRow('partners', { name: 'DIRTY-请求内' });
    dirty.end();
    dbf.insertRow('partners', { name: 'DIRTY-请求后' });
  });
  const late = dirty.takePending();
  check('请求作用域结束后的写 → pending', late.includes('partners'), sorted(late));
}

console.log('\n[7] end() 之后不再把新写记到已结算的请求上');
{
  const t = dirty.run(() => {
    dbf.insertRow('partners', { name: 'DIRTY-单位' });
    const before = dirty.end();
    dbf.insertRow('partners', { name: 'DIRTY-单位2' });
    return { before, after: dirty.end() };
  });
  check('end() 之前记到本次请求', t.before.includes('partners'), sorted(t.before));
  check('end() 之后再调返回空（新写已转 pending）', t.after.length === 0, sorted(t.after));
  dirty.takePending();
}

try { dbf.closeDb(); } catch { /* 已关 */ }
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 文件可能仍被占用 */ }
const pass = results.filter(r => r.ok).length;
console.log(`\n  脏表收集：${pass} / ${results.length} 项通过`);
process.exit(pass === results.length ? 0 : 1);
