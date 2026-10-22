'use strict';
/**
 * 级联删除与回收站（第二十二套）
 *
 * 用法： node tools/cascade-trash-test.js
 *
 * 为什么自己起服务：这一套要反复「建数据 → 删 → 还原 → 再删」，
 * 而且要在同一个库里数各表的行数。共享测试实例上有别的套件同时在改数据，
 * 行数断言必然飘。所以自带一个独立实例 + 独立数据目录。
 *
 * 这一套盯的是「删除」这条链路的三个承诺：
 *   ① 删项目 = 把它下面所有子记录一起删干净，不留孤儿
 *   ② 删之前要如实告诉用户「会连带处理哪些东西」
 *   ③ 删掉的东西 30 天内真的能原样还原（含子记录、含附件）
 *
 * 2026-10 实测暴露的两个真实缺陷（都是这套用例先红后绿的）：
 *   · `dependents('projects')` 少列了 contract_changes ——
 *     确认框上写着「将同时处理：合同 1、收付款 2…」，实际连变更记录一起删了。
 *     用户以为变更还在，还原前根本不知道丢了什么。
 *   · `PROJECT_CHILD_TABLES` 少列了 contract_changes ——
 *     挂在变更记录上的扫描件在删项目时既没保留也没清理，
 *     变成 record_id 指向已删除行、purgeOrphans 又看不见的永久脏数据
 *     （文件留在磁盘上永远没人删）。这正是当初漏写 schedules 时的同一个坑。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const DATADIR = path.join(os.tmpdir(), 'elv-cascade-' + process.pid);

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && extra ? '  — ' + extra : ''}`);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

async function startServer (port) {
  fs.mkdirSync(DATADIR, { recursive: true });
  const logFile = path.join(DATADIR, 'run.log');
  const out = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PMS_PORT: String(port), PMS_DATA_DIR: DATADIR, PMS_NO_AUTO_BACKUP: '1' },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) break;
    try { const r = await fetch(base + '/api/health'); if (r.ok) return { child, base }; } catch { /* 等 */ }
    await sleep(200);
  }
  throw new Error('测试实例没起来：\n' + fs.readFileSync(logFile, 'utf8').slice(-1500));
}

async function stopServer (srv, port) {
  if (!srv) return;
  try { srv.child.kill(); } catch { /* 忽略 */ }
  for (let i = 0; i < 50; i++) {
    await sleep(150);
    try { await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(400) }); } catch { break; }
  }
}

let BASE = '';
let cookie = '';

async function login () {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  if (!r.ok) throw new Error('登录失败：HTTP ' + r.status);
  const m = /pms_session=([^;]+)/.exec(r.headers.get('set-cookie') || '');
  if (!m) throw new Error('登录没有拿到会话 Cookie');
  cookie = m[1];
}

/** 发请求：返回 {status, data}，永不抛 */
async function api (method, p, body) {
  const init = { method, headers: { Cookie: `pms_session=${cookie}` } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  try {
    const r = await fetch(BASE + p, init);
    let data = null;
    try { data = await r.json(); } catch { /* 非 JSON */ }
    return { status: r.status, data };
  } catch (e) {
    return { status: -1, data: null, err: e.message };
  }
}

/** 新建一条记录，返回 id（失败返回 0，并把原因带出来） */
async function save (table, body) {
  const r = await api('POST', `/api/save/${table}`, body);
  if (r.status !== 200 || !r.data) throw new Error(`新建 ${table} 失败：HTTP ${r.status} ${JSON.stringify(r.data)}`);
  const id = r.data.id || (r.data.row && r.data.row.id) || (r.data.data && r.data.data.id);
  if (!id) throw new Error(`新建 ${table} 没返回 id：` + JSON.stringify(r.data).slice(0, 200));
  return Number(id);
}

async function listRows (table, query = '') {
  const r = await api('GET', `/api/list/${table}?size=500${query}`);
  return (r.data && r.data.rows) || [];
}

async function countOf (table, projectId) {
  const rows = await listRows(table);
  return rows.filter(r => Number(r.project_id) === Number(projectId)).length;
}

async function trashList () {
  const r = await api('GET', '/api/trash');
  return (r.data && r.data.rows) || [];
}

async function upload (tableName, recordId, name, text = 'hello') {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(text, 'utf8')], { type: 'text/plain' }), name);
  fd.append('table_name', tableName);
  fd.append('record_id', String(recordId));
  const r = await fetch(BASE + '/api/upload', { method: 'POST', headers: { Cookie: `pms_session=${cookie}` }, body: fd });
  const data = await r.json().catch(() => null);
  if (!r.ok || !data || !data.attachment) throw new Error(`上传 ${name} 失败：HTTP ${r.status} ${JSON.stringify(data)}`);
  return Number(data.attachment.id);
}

async function attachRows () {
  const r = await api('GET', '/api/attachments');
  return (r.data && r.data.rows) || [];
}

/**
 * 悬空附件：record_id 非空，但它指向的记录已经不在了。
 * 这类数据界面上看不见（附件库按 record_id 找不到归属），purgeOrphans 也扫不到，
 * 文件会一直躺在磁盘上。判据用「记录是否还能读到」而不是数 id，避免误判。
 */
async function danglingAttachments () {
  const out = [];
  for (const a of await attachRows()) {
    if (!a.record_id) continue;
    const r = await api('GET', `/api/get/${a.table_name}/${a.record_id}`);
    if (r.status === 404) out.push(`${a.original_name}→${a.table_name}#${a.record_id}`);
  }
  return out;
}

async function main () {
  console.log('\n  级联删除与回收站');
  const port = await freePort();
  let srv = await startServer(port);
  BASE = srv.base;
  await login();

  const { TABLES } = require('../schema.js');
  // 所有「挂在项目下」的表 —— 从 schema 里枚举，不手写清单。
  // 手写清单的问题：将来加一张带 project_id 的表，测试照样绿，
  // 而级联删除/附件清理/删除提示三处都会漏掉它。
  const PROJECT_TABLES = Object.entries(TABLES)
    .filter(([, d]) => (d.fields || []).some(f => f.name === 'project_id' && f.refTable === 'projects'))
    .map(([t]) => t);

  try {
    /* ---------------- [1] 建一棵完整的项目数据树 ---------------- */
    console.log('\n  [1] 建数据');
    const pid = await save('projects', { name: 'CASCADE-级联测试项目', status: '进行中', category: '综合布线' });
    const cid = await save('contracts', {
      name: 'CASCADE-测试合同', project_id: pid, amount: 100000, tax_rate: 9,
      category: '项目合同', direction: 'in', status: '执行中',
    });
    const ch1 = await save('contract_changes', {
      contract_id: cid, project_id: pid, title: '增补门禁点位', change_type: '增补金额',
      change_date: '2026-10-01', amount_delta: 20000, status: '已确认',
    });
    const ch2 = await save('contract_changes', {
      contract_id: cid, project_id: pid, title: '削减桥架费用', change_type: '削减金额',
      change_date: '2026-10-02', amount_delta: -5000, status: '已确认',
    });
    await save('schedules', {
      project_id: pid, contract_id: cid, direction: 'in', phase: '预付款', amount: 30000, due_date: '2026-11-01',
    });
    await save('payments', {
      project_id: pid, contract_id: cid, direction: 'in', amount: 30000, pay_date: '2026-10-05', kind: '预付款',
    });
    await save('invoices', {
      project_id: pid, contract_id: cid, direction: 'out', invoice_no: 'CASCADE-0001',
      issue_date: '2026-10-06', amount: 10000, tax_rate: 9,
    });
    await save('expenses', {
      project_id: pid, contract_id: cid, name: 'CASCADE-线缆采购', amount: 5000,
      expense_date: '2026-10-07', category: '材料设备',
    });
    await save('materials', { project_id: pid, name: 'CASCADE-网络摄像机', quantity: 10, unit_price: 800 });
    await save('maintenance', { project_id: pid, report_date: '2026-10-08', issue: 'CASCADE-画面卡顿' });

    const aProj = await upload('projects', pid, 'CASCADE-项目附件.txt');
    const aCont = await upload('contracts', cid, 'CASCADE-合同扫描件.txt');
    const aChg = await upload('contract_changes', ch1, 'CASCADE-变更单.txt');
    check('建好 1 个项目 + 8 张子表 + 3 个附件', !!(pid && cid && ch1 && ch2 && aProj && aCont && aChg));

    /* ---------------- [2] 删除前的提示必须覆盖全部子表 ---------------- */
    console.log('\n  [2] 删除提示');
    const probe = await api('POST', `/api/delete/projects/${pid}`, {});
    check('有关联数据时回 409 而不是直接删', probe.status === 409, `实际 HTTP ${probe.status}`);
    const deps = (probe.data && probe.data.dependents) || {};
    const missing = PROJECT_TABLES.filter(t => !(t in deps));
    check('确认框覆盖 schema 里所有带 project_id 的表',
      missing.length === 0,
      '漏了：' + missing.map(t => `${t}(${TABLES[t].label})`).join('、'));
    check('合同变更的条数被如实报出来', Number(deps.contract_changes) === 2, `实际 ${deps.contract_changes}`);

    /* ---------------- [3] 级联删除 ---------------- */
    console.log('\n  [3] 级联删除');
    const del = await api('POST', `/api/delete/projects/${pid}`, { cascade: true });
    check('级联删除成功', del.status === 200 && del.data && del.data.ok === true, `HTTP ${del.status}`);
    const leftover = [];
    for (const t of PROJECT_TABLES) {
      const n = await countOf(t, pid);
      if (n) leftover.push(`${t} 剩 ${n}`);
    }
    const contractsLeft = (await listRows('contracts')).filter(r => Number(r.id) === cid).length;
    if (contractsLeft) leftover.push('合同本体还在');
    check('项目下 8 张子表全部清空（不留孤儿）', leftover.length === 0, leftover.join('、'));
    const orphRows = await listRows('contract_changes');
    check('变更记录随项目一起删掉了', orphRows.filter(r => Number(r.id) === ch1 || Number(r.id) === ch2).length === 0);

    const dangling = await danglingAttachments();
    check('没有指向已删除记录的悬空附件', dangling.length === 0, dangling.join('、'));
    // 默认删除策略：附件跟着记录进回收站（解除关联），不是在删除的当下就把文件毁掉。
    // 老代码这里会剩 0 个 —— 文件当场被 fs.unlink 了，30 天后想还原也没东西可还原。
    const attAfterDel = (await attachRows()).filter(a => [aProj, aCont, aChg].includes(Number(a.id)));
    check('附件没有在删除时被当场删掉（留在回收站等彻底删除）',
      attAfterDel.length === 3 && attAfterDel.every(a => Number(a.detached) === 1 && !a.record_id),
      `剩 ${attAfterDel.length} 个，detached=${attAfterDel.map(a => a.detached).join(',')}`);

    /* ---------------- [4] 回收站快照 ---------------- */
    console.log('\n  [4] 回收站');
    const trash = await trashList();
    check('回收站里有 1 条快照', trash.length === 1, `实际 ${trash.length} 条`);
    const entry = trash[0] || {};
    // 1 项目 + 1 合同 + 2 变更 + 1 计划 + 1 收款 + 1 发票 + 1 费用 + 1 材料 + 1 维修 = 10
    check('快照记录了全部 10 行（不是只存主记录）', Number(entry.row_count) === 10, `实际 ${entry.row_count}`);
    const tstats = await api('GET', '/api/trash');
    const bytes = tstats.data && tstats.data.stats && tstats.data.stats.bytes;
    check('回收站占用空间是数字而不是 NaN', typeof bytes === 'number' && bytes > 0, `实际 ${bytes}`);

    /* ---------------- [5] 还原 ---------------- */
    console.log('\n  [5] 还原');
    const rs = await api('POST', `/api/trash/${entry.id}/restore`, {});
    check('还原成功', rs.status === 200 && rs.data && rs.data.ok === true, `HTTP ${rs.status} ${JSON.stringify(rs.data)}`);
    check('还原了 10 行', Number(rs.data && rs.data.restored) === 10, `实际 ${rs.data && rs.data.restored}`);
    const back = {};
    for (const t of PROJECT_TABLES) back[t] = await countOf(t, pid);
    // 每张子表各建了 1 行；合同变更是 2 行（增补 + 削减，正好覆盖金额一正一负）
    const EXPECT = { contract_changes: 2 };
    const short = Object.entries(back).filter(([t, n]) => n !== (EXPECT[t] || 1));
    check('还原后每张子表的行数都跟删除前一模一样', short.length === 0,
      short.map(([t, n]) => `${t}=${n}（应为 ${EXPECT[t] || 1}）`).join('、'));
    const chgBack = (await listRows('contract_changes')).filter(r => r.id === ch1);
    check('变更记录还原后外键没断',
      chgBack.length === 1 && Number(chgBack[0].contract_id) === cid && Number(chgBack[0].project_id) === pid,
      JSON.stringify(chgBack[0] || {}).slice(0, 120));
    const att = await attachRows();
    const back3 = [aProj, aCont, aChg].filter(id => {
      const a = att.find(x => Number(x.id) === Number(id));
      return a && Number(a.record_id) > 0;
    });
    check('3 个附件全部接回原记录', back3.length === 3, `接回 ${back3.length} 个`);

    /* ---------------- [6] 删合同（变更跟着走） ---------------- */
    console.log('\n  [6] 删合同');
    const cProbe = await api('POST', `/api/delete/contracts/${cid}`, {});
    check('删合同也先 409 提示', cProbe.status === 409, `实际 HTTP ${cProbe.status}`);
    check('提示里含合同变更 2 条', Number((cProbe.data && cProbe.data.dependents || {}).contract_changes) === 2);
    const cDel = await api('POST', `/api/delete/contracts/${cid}`, { cascade: true });
    check('删合同成功', cDel.status === 200, `HTTP ${cDel.status}`);
    const chgAfter = (await listRows('contract_changes')).filter(r => [ch1, ch2].includes(Number(r.id))).length;
    check('变更记录随合同删除', chgAfter === 0, `还剩 ${chgAfter}`);
    const cTrash = await trashList();
    const cEntry = cTrash.find(t => t.table_name === 'contracts');
    const cRs = await api('POST', `/api/trash/${cEntry.id}/restore`, {});
    const chgRestored = (await listRows('contract_changes')).filter(r => [ch1, ch2].includes(Number(r.id)));
    check('还原合同后变更记录也回来了', cRs.status === 200 && chgRestored.length === 2, `回来 ${chgRestored.length} 条`);
    check('回来的变更记录还挂在原合同上',
      chgRestored.every(r => Number(r.contract_id) === cid));

    /* ---------------- [7] 删往来单位：只解关联，不删记录 ---------------- */
    console.log('\n  [7] 删往来单位');
    const partnerId = await save('partners', { name: 'CASCADE-测试甲方', type: '甲方' });
    const pid2 = await save('projects', { name: 'CASCADE-第二个项目', client_id: partnerId, status: '进行中' });
    const pDel = await api('POST', `/api/delete/partners/${partnerId}`, { cascade: true });
    check('删往来单位成功', pDel.status === 200, `HTTP ${pDel.status}`);
    const p2 = await listRows('projects').then(rows => rows.find(r => Number(r.id) === pid2));
    check('项目本身保留，只是甲方被解关联', !!p2 && !p2.client_id, JSON.stringify(p2 && p2.client_id));
    const pEntry = (await trashList()).find(t => t.table_name === 'partners');
    await api('POST', `/api/trash/${pEntry.id}/restore`, {});
    const p2b = await listRows('projects').then(rows => rows.find(r => Number(r.id) === pid2));
    check('还原往来单位后关联接回去', !!p2b && Number(p2b.client_id) === partnerId, `实际 ${p2b && p2b.client_id}`);

    /* ---------------- [8] 批量删除 ---------------- */
    console.log('\n  [8] 批量删除');
    const b1 = await save('projects', { name: 'CASCADE-批量一', status: '进行中' });
    const b2 = await save('projects', { name: 'CASCADE-批量二', status: '进行中' });
    const bDel = await api('POST', '/api/batch-delete', { table: 'projects', ids: [b1, b2], cascade: true });
    check('批量删除 2 个项目成功', bDel.status === 200, `HTTP ${bDel.status}`);
    const bTrash = (await trashList()).find(t => t.table_name === 'projects' && String(t.record_ids || '').includes(String(b1)));
    check('批量删除只留 1 条快照（不是每条一条）', !!bTrash);
    const bRs = await api('POST', `/api/trash/${bTrash.id}/restore`, {});
    const bBack = (await listRows('projects')).filter(r => [b1, b2].includes(Number(r.id))).length;
    check('一次还原把 2 个项目都带回来', bRs.status === 200 && bBack === 2, `回来 ${bBack} 个`);

    /* ---------------- [9] 收尾一致性 ---------------- */
    console.log('\n  [9] 收尾');
    const before = (await trashList()).length;
    const ghost = await api('POST', '/api/delete/projects/99999999', { cascade: true });
    check('删不存在的记录回 404', ghost.status === 404, `实际 HTTP ${ghost.status}`);
    check('删不存在的记录不会往回收站塞空条目', (await trashList()).length === before);
    const logs = await api('GET', '/api/logs?limit=20');
    check('日志页仍然正常（200）', logs.status === 200, `HTTP ${logs.status}`);
    const dash = await api('GET', '/api/dashboard');
    check('看板仍然算得出来（没有被孤儿数据拖崩）', dash.status === 200 && !!dash.data && !!dash.data.totals,
      `HTTP ${dash.status}`);
  } finally {
    await stopServer(srv, port);
    try { fs.rmSync(DATADIR, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length} / ${results.length} 项通过`);
  if (bad.length) {
    console.log('失败项：');
    for (const b of bad) console.log('  ✗ ' + b.name);
  }
  process.exit(bad.length ? 1 : 0);
}

main().catch(e => {
  console.error('\n  [套件异常] ' + e.message);
  process.exit(1);
});
