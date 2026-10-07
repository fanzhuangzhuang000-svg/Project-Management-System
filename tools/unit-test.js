'use strict';
/**
 * 纯函数单元测试（不依赖服务、不碰数据库，跑得很快）
 *
 * 这里放的都是「一个正则改动就可能悄悄改坏、而且只有真实数据才会暴露」的地方。
 * 起因：修发票金额被算成 1e18 那个 bug 时，加了「多分隔符一律拒绝」的规则，
 * 结果把 OCR 读成 5,860000.00 的合法合同金额也一起拒了（扫描件识别率从 7/7 掉到 6/7）。
 * 两个方向都必须守住，所以单独测。
 *
 * 用法： node tools/unit-test.js
 */
const ex = require('./extract.js');

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
const near = (a, b, eps = 0.005) => typeof a === 'number' && Math.abs(a - b) < eps;

console.log('[1] parseMoney：必须救回合法金额');
const good = [
  ['5,860000.00', 5860000, 'OCR 少一个逗号（扫描件实测）'],
  ['5,860,000.00', 5860000, '规范千分位'],
  ['1,234,567.89', 1234567.89, '规范千分位带小数'],
  ['88194.34', 88194.34, '普通金额'],
  ['300000.00', 300000, '发票不含税金额'],
  ['78048.09', 78048.09, '发票明细合计'],
  ['7262.81', 7262.81, '明细行金额'],
  ['1.00', 1, '单价'],
  ['1234567', 1234567, '无分隔符整数'],
];
for (const [inp, want, desc] of good) {
  check(`${inp} → ${want}（${desc}）`, near(ex.parseMoney(inp), want), String(ex.parseMoney(inp)));
}

console.log('\n[2] parseMoney：必须拒绝垃圾');
const bad = [
  ['1.007262.805309734514', '发票单价+下一段粘连（曾算出 1e18）'],
  ['100000000000000000', '19 位整数，超过金额上限'],
  ['', '空字符串'],
  ['abc', '没有数字'],
];
for (const [inp, desc] of bad) {
  check(`拒绝 ${JSON.stringify(inp)}（${desc}）`, ex.parseMoney(inp) === null, String(ex.parseMoney(inp)));
}
// 千分位乱、但末段是明确分位的，按「前面的分隔符是噪声」读出来 —— 这是有意的：
// 扫描件常把 5,860,000.00 读成 5,860000.00，严格要求规范千分位会把合法金额也拒掉。
// 兜底靠金额上限，不靠格式。
check('千分位乱但分位明确时按噪声处理',
  near(ex.parseMoney('1,2345,678.90'), 12345678.9), String(ex.parseMoney('1,2345,678.90')));

console.log('\n[3] 金额上限');
check('9999 亿可以接受', near(ex.parseMoney('999900000000'), 999900000000), String(ex.parseMoney('999900000000')));
check('1.1 万亿要拒绝', ex.parseMoney('1100000000000') === null, String(ex.parseMoney('1100000000000')));

console.log('\n[4] cleanCode：OCR 的连字符噪声');
const codes = [
  ['HT.2026.088', 'HT-2026-088', '点号当连字符'],
  ['No. SJ 一 CL 一 202603 一 001', 'NO-SJ-CL-202603-001', '汉字「一」当连字符'],
  ['FB－2026－077', 'FB-2026-077', '全角横线'],
];
for (const [inp, want, desc] of codes) {
  const got = ex.cleanCode ? ex.cleanCode(inp) : null;
  check(`「${inp}」→ ${want}（${desc}）`, got === want, String(got));
}

console.log('\n[5] parsePaymentTerms：付款条款解析');
const terms = [
  ['预付款30%，进度款按月度完成量40%，竣工验收25%，质保金5%。', 4, '标准四段'],
  ['签订预付 30%，货到验收 60%，质保金 10%。', 3, '三段'],
  ['预付款30%,进度款40%,验收款25%,质保金5%', 4, '半角逗号'],
];
for (const [inp, wantN, desc] of terms) {
  const r = ex.parsePaymentTerms ? ex.parsePaymentTerms(inp) : { nodes: [] };
  check(`解析出 ${wantN} 个节点（${desc}）`, (r.nodes || []).length === wantN,
    `${(r.nodes || []).length} 个：${(r.nodes || []).map(n => n.phase).join('/')}`);
}

console.log('\n[6] PDF 文字层排版：按坐标还原 + 按间距补空格');
{
  const { layoutPage } = require('./pdftext.js');
  const mk = (s, x, y, w, h = 10) => ({ str: s, transform: [h, 0, 0, h, x, y], width: w });

  // 发票的单元格是分开画的，不补空格就会把「台 1.00 7262.81」粘成一坨
  const r1 = layoutPage([mk('台', 100, 700, 10), mk('1.00', 140, 700, 24), mk('7262.81', 180, 700, 44)]);
  check('相邻单元格之间补空格', r1[0] === '台 1.00 7262.81', JSON.stringify(r1[0]));

  // 同一个词被拆成多个块时不能乱插空格
  const r2 = layoutPage([mk('发票', 100, 700, 20), mk('号码', 120, 700, 20)]);
  check('紧挨着的不补空格', r2[0] === '发票号码', JSON.stringify(r2[0]));

  const r3 = layoutPage([mk('第一行', 100, 700, 30), mk('第二行', 100, 660, 30)]);
  check('不同 y 分成两行', r3.length === 2 && r3[0] === '第一行' && r3[1] === '第二行', JSON.stringify(r3));

  // PDF 里文字块的顺序不等于阅读顺序，必须按坐标重排
  const r4 = layoutPage([mk('C', 200, 700, 10), mk('A', 100, 700, 10), mk('B', 150, 700, 10)]);
  check('乱序输入按 x 坐标排回阅读顺序', r4[0] === 'A B C', JSON.stringify(r4[0]));

  check('空输入不炸', layoutPage([]).length === 0);
}
const failed = results.filter(r => !r.ok);
console.log('\n' + '='.repeat(56));
console.log(`  单元测试：${results.length - failed.length} / ${results.length} 项通过`);
if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name).join('\n'));
console.log('='.repeat(56));
process.exit(failed.length ? 1 : 0);
