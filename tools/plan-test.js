'use strict';
/**
 * 付款条款解析与收付款计划生成 —— 单元测试
 *   node tools/plan-test.js
 */
const path = require('node:path');
const { parsePaymentTerms } = require('./extract.js');

const CASES = [
  { text: '预付款 30%，进度款按月度完成量 40%，竣工验收 25%，质保金 5%',
    expect: [['预付款', 30], ['进度款', 40], ['验收款', 25], ['质保金', 5]], sum: 100 },
  { text: '签订后预付30%,货到验收付60%,质保金10%',
    expect: [['预付款', 30], ['验收款', 60], ['质保金', 10]], sum: 100 },
  { text: '合同签订后 7 个工作日内支付 30％；验收合格后支付 65％；质保金 5％一年后无息退还',
    expect: [['预付款', 30], ['验收款', 65], ['质保金', 5]], sum: 100 },
  { text: '预付款30%，进度款30%，进度款20%，验收款15%，质保金5%',
    expect: [['预付款', 30], ['进度款', 50], ['验收款', 15], ['质保金', 5]], sum: 100 },
  { text: '按月结算80%，验收后15%，质保金5%',
    expect: [['进度款', 80], ['验收款', 15], ['质保金', 5]], sum: 100 },
  { text: '下单预付 40%，到货 50%，质保 10%',
    expect: [['预付款', 40], ['到货款', 50], ['质保金', 10]], sum: 100 },
  { text: '货到付款 100%', expect: [['到货款', 100]], sum: 100 },
  { text: '预付30%，到货款40%，尾款25%，质保金5%',
    expect: [['预付款', 30], ['到货款', 40], ['尾款', 25], ['质保金', 5]], sum: 100 },
];

let pass = 0, fail = 0;
function check (name, ok, extra = '') {
  if (ok) { pass++; console.log('  ✓ ' + name + (extra ? '  — ' + extra : '')); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  — ' + extra : '')); }
}

console.log('\n[1] 比例型付款条款');
for (const c of CASES) {
  const r = parsePaymentTerms(c.text);
  const got = r.nodes.map(n => [n.phase, n.ratio]);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect) && Math.abs(r.sum - c.sum) < 0.01;
  check(c.text.slice(0, 26) + (c.text.length > 26 ? '…' : ''),
    ok, got.map(g => g[0] + g[1] + '%').join(' / '));
}

console.log('\n[2] 金额型付款条款');
const amt = parsePaymentTerms('预付176万，进度款234万，验收款147万，质保金29.3万');
check('万元金额条款可解析', amt.nodes.length === 4 && amt.nodes[0].amountWan === 176,
  amt.nodes.map(n => n.phase + n.amountWan + '万').join(' / '));
check('金额合计正确', Math.abs(amt.amountWan - 586.3) < 0.01, amt.amountWan + ' 万');

console.log('\n[3] 异常与边界');
check('空条款不报错', parsePaymentTerms('').nodes.length === 0);
check('无比例条款返回空', parsePaymentTerms('按合同约定执行').nodes.length === 0);
const partial = parsePaymentTerms('预付款30%，尾款20%');
check('合计不足 100% 时如实返回', Math.abs(partial.sum - 50) < 0.01, '合计 ' + partial.sum + '%');
check('超过 100% 的比例被拒绝', parsePaymentTerms('预付300%').nodes.length === 0);

console.log('\n' + '='.repeat(56));
console.log(`  付款条款解析测试：${pass} / ${pass + fail} 项通过`);
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
