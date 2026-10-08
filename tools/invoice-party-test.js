'use strict';
/**
 * 发票购销双方名称的边界测试（纯函数，不依赖服务）
 *
 * 起因（线上真实票据复现）：
 *   客户上传一张电子专票，识别出来的「购买方」是
 *     上海索杰电子信息系统有限公司销名称:上海颤维电子科技有限公司
 *   —— 购买方名称把销售方的标签和名字整段吞了进来。
 *
 * 根因：发票抬头是左右两栏并排的，PDF 文字层把同一行的两栏拼成一条
 *    购 名称：上海A公司 销 名称：上海B公司
 *   而归一化会删掉汉字之间的空格（那是为了修「发 票 号 码」这类 OCR 噪声），
 *   两栏于是连成一片，`名称[:：]?` 后面接 40 个非换行字符就把整行吞了。
 *
 * 所以名称一律在「下一个字段标签」处截断。这里把真实版式、反序版式、
 * 以及三种**不能被误截**的正常名字都钉住。
 *
 * 注意：素材里的公司名/税号/发票号/金额全部是**合成的**。
 *   仓库是公开的，真实票据里的税号和银行账号不能进代码库
 *   （版式结构与真实票据逐字一致，所以照样能复现这个 bug）。
 *
 * 用法： node tools/invoice-party-test.js
 */
const ex = require('./extract.js');

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}
const parties = (text) => ex.extract(text).parties || [];
const byRole = (text, role) => (parties(text).find(p => p.role === role) || {}).name || null;
const buyer = (text) => byRole(text, 'buyer');
const seller = (text) => byRole(text, 'seller');

const A = '上海甲杰电子信息系统有限公司';   // 购买方（14 字，与真实票据等长）
const B = '上海乙维电子科技有限公司';       // 销售方（12 字，与真实票据等长）

// ---------------- [1] 真实版式：左右两栏被拼成一行 ----------------
console.log('[1] 真实版式：两栏并排、汉字间空格又被删掉 → 购买方不得吞销售方');
const REAL_LAYOUT = [
  '电子发票（增值税专用发票） 发票号码：26312000006153870000',
  '开票日期：2026年09月28日',
  '共3页 第1页',
  `购 名称：${A} 销 名称：${B}`,
  '买 售',
  '方 方',
  '信 统一社会信用代码/纳税人识别号：9131012073900730XA 信 统一社会信用代码/纳税人识别号：91310120MA1HL11D0X',
  '息 息',
  '项目名称 规格型号 单 位 数 量 单 价 金 额 税率/征收率 税 额',
  '*公共安全设备*1080P网 台 24.00 268.8318584070796 6451.96 13% 838.76',
  '络型枪式摄像机',
  '合 计 ¥130000.00 ¥16900.00',
  '价税合计（大写） 壹拾肆万陆仟玖佰圆整 （小写） ¥146900.00',
  '销方开户银行:中国建设银行股份有限公司上海某某支行; 银行账号:31050182490000000000;',
  '备 项目材料款',
  '注',
  '开票人：张三',
].join('\n');

const r1 = ex.extract(REAL_LAYOUT);
const p1 = Object.fromEntries((r1.parties || []).map(p => [p.role, p.name]));
check('整行仍是发票', r1.kind === 'invoice', r1.kind);
check(`购买方 = ${A}`, p1.buyer === A, JSON.stringify(p1.buyer));
check(`销售方 = ${B}`, p1.seller === B, JSON.stringify(p1.seller));
check('购买方里没有「销名称」标签残留', !/名称/.test(p1.buyer || ''), JSON.stringify(p1.buyer));
check('购买方里没有销售方的名字', !(p1.buyer || '').includes(B), JSON.stringify(p1.buyer));
check('销售方里没有购买方的名字', !(p1.seller || '').includes(A), JSON.stringify(p1.seller));
// 顺手守住同一张票的其它字段：改名称规则不该动到金额/日期/号码
check('发票号码不受影响', r1.fields.invoice_no === '26312000006153870000', String(r1.fields.invoice_no));
check('开票日期不受影响', r1.fields.issue_date === '2026-09-28', String(r1.fields.issue_date));
check('价税合计不受影响', r1.fields.total_amount === 146900, String(r1.fields.total_amount));
check('不含税金额按 13% 反推', r1.fields.amount === 130000, String(r1.fields.amount));
check('税额按 13% 反推', r1.fields.tax_amount === 16900, String(r1.fields.tax_amount));

// ---------------- [2] 反序：销售方在左、购买方在右 ----------------
console.log('\n[2] 反序版式：销售方在左 → 销售方不得吞购买方');
const REVERSED = `销 名称：${B} 购 名称：${A}\n买 售\n方 方\n价税合计（小写） ¥1000.00`;
check(`购买方 = ${A}`, buyer(REVERSED) === A, JSON.stringify(buyer(REVERSED)));
check(`销售方 = ${B}`, seller(REVERSED) === B, JSON.stringify(seller(REVERSED)));

// ---------------- [3] 缺字标签各自占一行（原有能力，不许回归） ----------------
console.log('\n[3] 缺字标签分行：购名称 / 销名称 仍要认得出来');
// 注意必须带上发票特征词：只有「购名称/销名称」两行时 detectKind 判不出票种，
// 走的是 unknown 分支（parties 为空），那是另一回事，不是名称规则的问题。
const SPLIT_OK = `发票号码：26312000006153870001\n购名称：${A}\n销名称：${B}\n价税合计（小写） ¥1000.00`;
check('「购名称：」仍然抽得到', buyer(SPLIT_OK) === A, JSON.stringify(buyer(SPLIT_OK)));
check('「销名称：」仍然抽得到', seller(SPLIT_OK) === B, JSON.stringify(seller(SPLIT_OK)));

// ---------------- [4] 完整标签 + 括号注释 ----------------
console.log('\n[4] 完整标签与括号注释');
const FULL = `购买方名称：${A}（以下简称甲方）\n销售方名称：${B}`;
check('完整标签抽得到', buyer(FULL) === A, JSON.stringify(buyer(FULL)));
check('括号注释被截掉', !(buyer(FULL) || '').includes('甲方'), JSON.stringify(buyer(FULL)));

// ---------------- [5] 弱标签：必须带冒号才算标签 ----------------
console.log('\n[5] 「地址/电话」这类词：带冒号才当标签，否则可能是公司名的一部分');
const WITH_ADDR = `购买方名称：${A}地址：上海市某某区某某路1号\n销售方名称：${B}`;
check('地址带冒号 → 在地址处截断', buyer(WITH_ADDR) === A, JSON.stringify(buyer(WITH_ADDR)));

const TELCO = '上海电话设备厂有限公司';
const NO_COLON = `购买方名称：${TELCO}\n销售方名称：${B}`;
check(`公司名含「电话」且无冒号 → 完整保留（${TELCO}）`, buyer(NO_COLON) === TELCO, JSON.stringify(buyer(NO_COLON)));

const UNITY = '统一石油化工有限公司';
const UNITY_TXT = `购买方名称：${UNITY}\n销售方名称：${B}`;
check(`公司名以「统一」开头 → 完整保留（${UNITY}）`, buyer(UNITY_TXT) === UNITY, JSON.stringify(buyer(UNITY_TXT)));

// ---------------- [6] 截不出东西时宁可为空，不许给假名字 ----------------
console.log('\n[6] 购买方名字为空时：宁可不填，也不许编一个假名字');
const EMPTY_BUYER = `购买方名称：销名称：${B}\n价税合计（小写） ¥1000.00`;
check('购买方留空', buyer(EMPTY_BUYER) === null, JSON.stringify(buyer(EMPTY_BUYER)));
check('销售方仍能抽到', seller(EMPTY_BUYER) === B, JSON.stringify(seller(EMPTY_BUYER)));

// ---------------- 汇总 ----------------
const failed = results.filter(r => !r.ok);
console.log('\n' + '='.repeat(56));
console.log(`  发票购销双方：${results.length - failed.length} / ${results.length} 项通过`);
if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name).join('\n'));
console.log('='.repeat(56));
process.exit(failed.length ? 1 : 0);
