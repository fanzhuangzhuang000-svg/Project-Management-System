'use strict';
/**
 * 批量导入端到端测试
 *   node tools/import-test.js [http://127.0.0.1:8787]
 *
 * 覆盖：xlsx 解析、GBK/UTF-8 CSV、表头自动对应、外键按名称解析、
 *       Excel 日期序列号、金额千分位、收支方向容错、错误行定位、清理。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { prepareAuth, BASE: AUTH_BASE } = require('./test-auth.js');

// 基址必须和 test-auth.js 一致：登录会话属于 AUTH_BASE，
// 这里换成别的地址就会带着不属于它的 Cookie 打过去，表现为随机 401。
const BASE = process.argv[2] || AUTH_BASE;
const FIX = path.join(__dirname, 'fixtures');
const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

async function upload (table, filePath, preview, autoCreate) {
  const fd = new FormData();
  fd.append('file', new Blob([fs.readFileSync(filePath)]), path.basename(filePath));
  if (autoCreate) fd.append('auto_create_partners', '1');
  const res = await fetch(`${BASE}/api/import/${table}${preview ? '?preview=1' : ''}`, { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error || '导入失败'), { data });
  return data;
}
const getJSON = p => fetch(BASE + p).then(r => r.json());
const postJSON = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());

async function cleanup () {
  return postJSONTest();
}
async function postJSONTest () {
  const out = { partners: 0, projects: 0, contracts: 0 };
  for (const t of ['contracts', 'projects', 'partners']) {
    const list = await getJSON(`/api/list/${t}?q=${encodeURIComponent(t === 'partners' ? '测试' : '测试')}`);
    for (const row of list.rows) {
      if (t === 'contracts' && !/^TEST-/.test(row.code || '')) continue;
      if (t === 'projects' && !/^TEST-IMP/.test(row.code || '')) continue;
      if (t === 'partners' && !/^测试/.test(row.name || '')) continue;
      await postJSON(`/api/delete/${t}/${row.id}`, { cascade: true });
      out[t]++;
    }
  }
  return out;
}

(async function main () {
  await prepareAuth();
  console.log('\n[0] 准备：清理历史测试数据');
  const pre = await cleanup();
  // 记录测试前的数据量，结束时只断言「数量没变」（不假设一定有 3 个项目 8 份合同）
  const BASE_TOTALS = (await getJSON('/api/dashboard')).totals;
  console.log(`  （合同 ${pre.contracts} / 项目 ${pre.projects} / 单位 ${pre.partners}）`);

  // ================= 1. 表头与预览 =================
  console.log('\n[1] 上传 xlsx 并预览');
  const pv = await upload('partners', path.join(FIX, 'import-partners.xlsx'), true);
  check('识别到正确的列', pv.mapped.includes('name') && pv.mapped.includes('type') && pv.mapped.includes('phone'),
    pv.mapped.join(','));
  check('没有无法识别的列', (pv.unknownHeaders || []).length === 0, (pv.unknownHeaders || []).join(',') || '无');
  check('预览到 3 行数据', pv.inserted === 3 && pv.totalRows === 3, `inserted=${pv.inserted} totalRows=${pv.totalRows}`);
  check('预览不会真的写入', (await getJSON('/api/list/partners?q=' + encodeURIComponent('测试甲方建设集团'))).total === 0);

  // ================= 2. 正式导入往来单位 =================
  console.log('\n[2] 导入往来单位');
  const r1 = await upload('partners', path.join(FIX, 'import-partners.xlsx'), false);
  check('导入 3 条往来单位', r1.inserted === 3 && r1.skipped === 0, `成功 ${r1.inserted}，跳过 ${r1.skipped}`);
  const partners = await getJSON('/api/list/partners?q=' + encodeURIComponent('测试'));
  check('数据已落库', partners.total === 3, `查到 ${partners.total} 条`);
  const pA = partners.rows.find(r => r.name === '测试甲方建设集团有限公司');
  check('单位类型正确', pA && pA.type === '甲方', pA ? pA.type : '—');

  // ================= 3. 导入项目（含日期） =================
  console.log('\n[3] 导入项目（含 Excel 日期单元格）');
  const r2 = await upload('projects', path.join(FIX, 'import-projects.xlsx'), false);
  check('导入 2 条项目', r2.inserted === 2, `成功 ${r2.inserted}，跳过 ${r2.skipped}`);
  const projs = await getJSON('/api/list/projects?q=TEST-IMP');
  check('项目已落库', projs.total === 2, `查到 ${projs.total} 条`);
  const p1 = projs.rows.find(r => r.code === 'TEST-IMP-001');
  check('所属项目按名称对应到单位', p1 && String(p1.client_id) === String(pA.id), p1 ? p1.client_id_name : '—');
  check('Excel 日期序列号转成了日期', p1 && p1.start_date === '2026-01-10' && p1.end_date === '2026-11-30',
    p1 ? `${p1.start_date} ~ ${p1.end_date}` : '—');
  const p2 = projs.rows.find(r => r.code === 'TEST-IMP-002');
  check('文字日期也支持（2026/3/1 与 2026年9月30日）', p2 && p2.start_date === '2026-03-01' && p2.end_date === '2026-09-30',
    p2 ? `${p2.start_date} ~ ${p2.end_date}` : '—');

  // ================= 4. 导入合同（GBK 编码 CSV） =================
  console.log('\n[4] 导入合同（中文 Excel 另存的 GBK 编码 CSV）');
  const r3 = await upload('contracts', path.join(FIX, 'import-contracts-gbk.csv'), false);
  check('GBK 编码 CSV 能正确读中文', r3.inserted === 2, `成功 ${r3.inserted}，跳过 ${r3.skipped}`);
  const cs = await getJSON('/api/list/contracts?q=TEST-');
  check('合同已落库', cs.total === 2, `查到 ${cs.total} 条`);
  const c1 = cs.rows.find(r => r.code === 'TEST-HT-001');
  check('项目按名称对应', c1 && String(c1.project_id) === String(p1.id), c1 ? c1.project_id_name : '—');
  check('对方单位按名称对应', c1 && c1.partner_id_name === '测试甲方建设集团有限公司', c1 ? c1.partner_id_name : '—');
  check('带千分位的金额解析正确', c1 && c1.amount === 2180000, c1 ? String(c1.amount) : '—');
  check('「收入」容错成 in', c1 && c1.direction === 'in', c1 ? c1.direction : '—');
  check('含税率自动折算不含税', c1 && Math.abs(c1.amount_ex_tax - 2000000) < 1, c1 ? String(c1.amount_ex_tax) : '—');
  const c2 = cs.rows.find(r => r.code === 'TEST-CG-001');
  check('「支出」容错成 out', c2 && c2.direction === 'out', c2 ? c2.direction : '—');
  check('付款条款完整读入', c2 && /预付40%/.test(c2.payment_terms || ''), c2 ? c2.payment_terms : '—');

  // ================= 5. UTF-8 CSV 预览 =================
  console.log('\n[5] UTF-8 CSV（带 BOM，Excel 的「CSV UTF-8」）');
  const r4 = await upload('contracts', path.join(FIX, 'import-contracts-utf8.csv'), true);
  check('UTF-8 CSV 也能正确解析', r4.inserted === 2 && r4.mapped.includes('code'),
    `预览 ${r4.inserted} 行，对应 ${r4.mapped.length} 列`);

  // ================= 6. 错误行定位 =================
  console.log('\n[6] 错误行定位与容错');
  const badPath = path.join(os.tmpdir(), 'pms_bad_import.csv');
  fs.writeFileSync(badPath, '\uFEFF' + [
    '项目编号,项目名称,甲方单位,子系统类别,项目状态,完工进度,开工日期',
    'BAD-001,正常的一行,测试甲方建设集团有限公司,综合布线,进行中,10,2026-05-01',
    'BAD-002,,测试甲方建设集团有限公司,综合布线,进行中,10,2026-05-01',
    'BAD-003,日期写错了,测试甲方建设集团有限公司,综合布线,进行中,10,去年下半年',
    'BAD-004,单位不存在,这个单位根本不存在,综合布线,进行中,10,2026-05-01',
  ].join('\r\n'), 'utf8');
  const bad = await upload('projects', badPath, true);
  check('错误行被准确跳过', bad.skipped === 3 && bad.inserted === 1, `成功 ${bad.inserted}，跳过 ${bad.skipped}`);
  const lines = bad.errors.map(e => e.line).sort();
  check('报错的正是第 3/4/5 行', JSON.stringify(lines) === '[3,4,5]', '出错行号 ' + lines.join(','));
  const msgs = bad.errors.map(e => e.messages.join('')).join(' | ');
  check('提示了缺失必填项', /名称不能为空/.test(msgs));
  check('提示了日期格式问题', /不是可识别的日期/.test(msgs));
  check('提示了找不到往来单位并给出建议', /找不到往来单位/.test(msgs), (msgs.match(/找不到往来单位[^|]{0,60}/) || [''])[0]);
  fs.unlinkSync(badPath);

  // ================= 7. 自动新建往来单位 =================
  console.log('\n[7] 勾选「自动新建往来单位」');
  const autoPath = path.join(os.tmpdir(), 'pms_auto_import.csv');
  fs.writeFileSync(autoPath, '\uFEFF' + [
    '项目编号,项目名称,甲方单位,子系统类别,项目状态,开工日期',
    'BAD-009,自动建单位的项目,从没见过的甲方单位,综合布线,进行中,2026-05-01',
  ].join('\r\n'), 'utf8');
  const auto = await upload('projects', autoPath, false, true);
  check('导入成功而不是报错', auto.inserted === 1 && auto.skipped === 0, `成功 ${auto.inserted}，跳过 ${auto.skipped}`);
  const autoPartner = await getJSON('/api/list/partners?q=' + encodeURIComponent('从没见过的甲方单位'));
  check('往来单位被自动新建', autoPartner.total === 1, `查到 ${autoPartner.total} 条`);
  fs.unlinkSync(autoPath);

  // ================= 8. 模板 =================
  console.log('\n[8] 导入模板');
  for (const t of ['partners', 'projects', 'contracts', 'payments', 'invoices', 'materials', 'schedules']) {
    const res = await fetch(`${BASE}/api/import/template/${t}`);
    const txt = await res.text();
    const firstLine = txt.replace(/^\uFEFF/, '').split('\r\n')[0];
    check(`${t} 模板可下载且含中文表头`, res.ok && /[\u4e00-\u9fff]/.test(firstLine), firstLine.slice(0, 58));
  }

  // ================= 9. 清理 =================
  console.log('\n[9] 清理测试数据');
  const autoProj = await getJSON('/api/list/projects?q=BAD-009');
  for (const row of autoProj.rows) await postJSON(`/api/delete/projects/${row.id}`, { cascade: true });
  for (const row of (await getJSON('/api/list/partners?q=' + encodeURIComponent('从没见过的甲方单位'))).rows) {
    await postJSON(`/api/delete/partners/${row.id}`, {});
  }
  const after = await cleanup();
  const finalCheck = await getJSON('/api/dashboard');
  check('测试数据已清理（数量回到测试前）',
    finalCheck.totals.project_count === BASE_TOTALS.project_count
    && finalCheck.totals.contract_count === BASE_TOTALS.contract_count,
    `项目 ${finalCheck.totals.project_count}（测试前 ${BASE_TOTALS.project_count}）`
    + ` / 合同 ${finalCheck.totals.contract_count}（测试前 ${BASE_TOTALS.contract_count}）`
    + `（清理了 ${after.contracts + after.projects + after.partners} 条）`);

  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(58));
  console.log(`  批量导入测试：${results.length - failed.length} / ${results.length} 项通过`);
  if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name + (f.extra ? ' (' + f.extra + ')' : '')).join('\n'));
  console.log('='.repeat(58));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('\n[测试异常]', e.message); process.exit(1); });
