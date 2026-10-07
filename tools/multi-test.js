'use strict';
/**
 * 子系统多选（multi 字段类型）单元测试
 *   node tools/multi-test.js
 * 使用独立的临时数据目录，不会影响正式数据。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = path.join(os.tmpdir(), 'pms_multi_test_' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.PMS_DATA_DIR = TMP;

const dbf = require('../db.js');
const importer = require('../import.js');
dbf.init();
// 清掉自动写入的示例数据，让断言只针对本测试建的数据
dbf.clearDemo();

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

console.log('\n[1] 取值清洗与归一');
const c1 = dbf.dryRunRow('projects', { name: 'x', category: '综合布线,安防监控' });
check('英文逗号分隔', c1.row.category === '综合布线,安防监控', c1.row.category);
const c2 = dbf.dryRunRow('projects', { name: 'x', category: '综合布线、安防监控、门禁一卡通' });
check('中文顿号分隔', c2.row.category === '综合布线,安防监控,门禁一卡通', c2.row.category);
const c3 = dbf.dryRunRow('projects', { name: 'x', category: ['综合布线', '安防监控', '综合布线'] });
check('数组入参且自动去重', c3.row.category === '综合布线,安防监控', c3.row.category);
const c4 = dbf.dryRunRow('projects', { name: 'x', category: '' });
check('留空回落到默认值', c4.row.category === '综合布线', c4.row.category);
const c5 = dbf.dryRunRow('projects', { name: 'x', category: '综合布线 / 安防监控' });
check('斜杠分隔也认', c5.row.category === '综合布线,安防监控', c5.row.category);

console.log('\n[2] 列表筛选（整词命中）');
const ins = (name, cat) => dbf.insertRow('projects', { name, code: 'MT-' + name, category: cat, status: '进行中' }).id;
const a = ins('甲', '综合布线,安防监控');
const b = ins('乙', '安防监控,门禁一卡通');
const c = ins('丙', '机房工程');
const f = (cat) => dbf.listRows('projects', { category: cat, q: 'MT-' }).rows.length;
check('按「安防监控」筛出 2 个', f('安防监控') === 2, String(f('安防监控')));
check('按「综合布线」筛出 1 个', f('综合布线') === 1, String(f('综合布线')));
check('按「机房工程」筛出 1 个', f('机房工程') === 1, String(f('机房工程')));
check('不相关的筛出 0 个', f('会议系统') === 0, String(f('会议系统')));
const partial = dbf.listRows('projects', { category: '门禁', q: 'MT-' }).rows.length;
check('不完整名称不会被误命中', partial === 0, String(partial));

console.log('\n[3] 总览的子系统分布（一个项目计入多个子系统）');
// 给这几个项目各挂一份收入合同，便于验证合同额分摊
for (const id of [a, b, c]) {
  dbf.insertRow('contracts', { name: '合同' + id, project_id: id, category: '项目合同', direction: 'in', amount: 1000000, tax_rate: 9, status: '执行中' });
}
const dash = dbf.dashboard();
const cat = dash.by_category;
check('「安防监控」计入 2 个项目', cat['安防监控'] && cat['安防监控'].count === 2, cat['安防监控'] && String(cat['安防监控'].count));
check('「安防监控」合同额 = 200 万', cat['安防监控'] && cat['安防监控'].contract_in === 2000000, cat['安防监控'] && String(cat['安防监控'].contract_in));
check('「综合布线」合同额 = 100 万', cat['综合布线'] && cat['综合布线'].contract_in === 1000000, cat['综合布线'] && String(cat['综合布线'].contract_in));
check('「机房工程」合同额 = 100 万', cat['机房工程'] && cat['机房工程'].contract_in === 1000000, cat['机房工程'] && String(cat['机房工程'].contract_in));

console.log('\n[4] 批量导入的多选解析');
const hdr = ['项目名称', '子系统类别'];
const imp = (v) => importer.runImport('projects', hdr, [['导入测试项目', v]], { preview: true }).preview[0].row.category;
check('导入「综合布线、安防监控」', imp('综合布线、安防监控') === '综合布线,安防监控', imp('综合布线、安防监控'));
check('导入「门禁一卡通/机房工程」', imp('门禁一卡通/机房工程') === '门禁一卡通,机房工程', imp('门禁一卡通/机房工程'));
check('导入单个值', imp('安防监控') === '安防监控', imp('安防监控'));
const tpl = importer.buildTemplate('projects');
check('导入模板给出多选示例', /综合布线、安防监控/.test(tpl), (tpl.split('\r\n')[1] || '').slice(0, 40) + '…');

console.log('\n[5] 导出与视图');
const allRows = dbf.listRows('projects', { q: 'MT-' }).rows;
const withMulti = allRows.find(r => String(r.category).includes(','));
check('多值在库内是逗号分隔字符串', !!withMulti, withMulti && withMulti.category);
check('单值与多值可以共存', allRows.some(r => !String(r.category).includes(',')) && !!withMulti,
  allRows.map(r => r.category).join(' | '));

dbf.closeDb();
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Windows 上偶尔延迟释放，忽略 */ }

const failed = results.filter(r => !r.ok);
console.log('\n' + '='.repeat(56));
console.log(`  子系统多选测试：${results.length - failed.length} / ${results.length} 项通过`);
console.log('='.repeat(56));
process.exit(failed.length ? 1 : 0);
