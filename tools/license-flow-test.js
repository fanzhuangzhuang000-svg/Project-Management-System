'use strict';
/**
 * 授权码闭环测试 —— 卖软件的人真正依赖的机制
 *
 * 授权码是这个产品唯一「收钱」的闸门，比任何业务功能都更该被验证。
 * 这里验的不是「能生成」，而是**它能不能拦住该拦的**：
 *   · 改一个字符就失效
 *   · 公司名对不上就失效（防「把码复制给别家公司」）
 *   · 过期能识别，且过期是「只读」而不是锁死（数据不能丢）
 *   · 账号数上限能被读出来
 *   · **老码（ELV1/ELV2）不能因为我改了格式就作废** ← 2026-10 放弃一机一码后最该验的
 *   · 换密钥后老码立即失效
 *
 * 注意 licenseStatus(code, today) 的第二个参数是**日期**，不是公司名。
 * 公司名的比对发生在 server.js 的 licenseNow() 里（要跟系统设置里的公司名比），
 * 所以这里同时测两层：纯校验 + 比对逻辑。
 *
 * 用法： node tools/license-flow-test.js
 */
const license = require('./license.js');

const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** 复刻 server.js licenseNow() 里的公司名比对（保持两边逻辑一致） */
function withCompanyCheck (code, systemCompany) {
  const r = license.licenseStatus(code);
  if (r && (r.status === 'ok' || r.status === 'warn') && r.company) {
    const norm = (x) => String(x || '').replace(/[\s　]+/g, '').toLowerCase();
    if (norm(r.company) !== norm(systemCompany)) {
      return { ...r, status: 'invalid', companyMismatch: true, licensedTo: r.company };
    }
  }
  return r;
}

const COMPANY = '万祥机电设备有限公司';
const b64u = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

console.log('  [1] 正常签发的码');
const good = license.makeLicense(COMPANY, day(400), 20);
check('生成成功', !!good.code && good.code.startsWith('ELV3.'), good.code.slice(0, 26) + '…');
const parsed = license.licenseStatus(good.code);
check('校验通过', parsed.status === 'ok', parsed.status);
check('能解出公司名和到期日', parsed.company === COMPANY && parsed.expiry === day(400),
  `${parsed.company} / ${parsed.expiry}`);
check('账号数上限解得对', parsed.seats === 20, 'seats=' + parsed.seats);

console.log('\n  [2] ★ 改一个字符就该失效（离线签名的最低要求）');
const tampered = good.code.slice(0, -1) + (good.code.slice(-1) === 'A' ? 'B' : 'A');
check('★ 篡改后校验失败', license.licenseStatus(tampered).status === 'invalid',
  license.licenseStatus(tampered).status);

console.log('\n  [3] ★ 公司名对不上就该失效（防「把码复制给别家公司」）');
const otherCode = license.makeLicense('另一家公司', day(400)).code;
const mismatch = withCompanyCheck(otherCode, COMPANY);
check('★ 别家公司的码，在万祥的系统里不通过', mismatch.status === 'invalid', mismatch.status);
check('★ 提示里说明了「授权给谁」', mismatch.licensedTo === '另一家公司', mismatch.licensedTo || '-');
check('本公司用发给自己的码，通过', withCompanyCheck(good.code, COMPANY).status === 'ok');
check('公司名有空格/大小写差异时仍认（避免误伤）',
  withCompanyCheck(license.makeLicense('ABC 公司', day(400)).code, 'abc公司').status === 'ok');

console.log('\n  [4] ★ 过期必须能识别，而且是「只读」不是锁死');
const expired = license.licenseStatus(license.makeLicense(COMPANY, day(-1)).code);
check('★ 过期码被识别为 expired', expired.status === 'expired', expired.status);
check('★ 过期信息里带公司名（客户知道该续哪家）', expired.company === COMPANY, expired.company);
check('★ 过期 = readOnly（数据还能看）', expired.readOnly === true, 'readOnly=' + expired.readOnly);
const goodSt = license.licenseStatus(good.code);
check('有效的码不是 readOnly', goodSt.readOnly === false, 'readOnly=' + goodSt.readOnly);

console.log('\n  [5] 到期前 30 天要提醒');
const soon = license.licenseStatus(license.makeLicense(COMPANY, day(10)).code);
check('剩余 10 天 → warn（会提醒续费）', soon.status === 'warn', `status=${soon.status} daysLeft=${soon.daysLeft}`);
check('剩余 400 天 → ok（不打扰）', goodSt.status === 'ok', goodSt.status);
check('warn 也不是 readOnly', soon.readOnly === false, 'readOnly=' + soon.readOnly);

console.log('\n  [5b] ★ 账号数上限：签发时能填、能校验、填错会拒绝');
check('不填 seats → 不限（0）', license.makeLicense(COMPANY, day(400)).seats === 0);
check('显式填 0 → 不限', license.makeLicense(COMPANY, day(400), 0).seats === 0);
check('填 1 → 存 1', license.licenseStatus(license.makeLicense(COMPANY, day(400), 1).code).seats === 1);
check('填 "20"（字符串）也认', license.makeLicense(COMPANY, day(400), '20').seats === 20);
check('填 "不限" → 0', license.makeLicense(COMPANY, day(400), '不限').seats === 0);
check('★ 填非数字被拒绝', !!license.makeLicense(COMPANY, day(400), 'abc').error,
  license.makeLicense(COMPANY, day(400), 'abc').error || '-');
check('★ 填负数被拒绝', !!license.makeLicense(COMPANY, day(400), '-3').error);
check('★ 填 0.5 被拒绝', !!license.makeLicense(COMPANY, day(400), '0.5').error);
// 直接改 payload 里的 seats 想偷改额度 → 签名对不上
const [p3, s3] = good.code.split('.');
const forged = 'ELV3.' + b64u(`${COMPANY}|${day(400)}|9999`) + '.' + s3;
check('★ 篡改 payload 把额度改成 9999 → 签名失效',
  license.licenseStatus(forged).status === 'invalid', license.licenseStatus(forged).status);
check('  （原额度没被影响）', license.licenseStatus(good.code).seats === 20, 'seats=' + license.licenseStatus(good.code).seats);

console.log('\n  [5c] ★★ 已发出的老码不能作废（ELV1 / ELV2 继续有效）');
// 客户手上可能还有历史码：改造格式后它们必须照样认。
// 老码本来由旧版 gen-license.js 签出，这里用同样的算法现场构造。
const MC_OLD = 'MC-1A2B3C4D-5E6F7081';
const old1Payload = b64u(`${COMPANY}|${day(400)}`);
const old1 = 'ELV1.' + old1Payload + '.' + license._sign(old1Payload);
const old2Payload = b64u(`${COMPANY}|${day(400)}|${MC_OLD}`);
const old2 = 'ELV2.' + old2Payload + '.' + license._sign(old2Payload);
const r1 = license.licenseStatus(old1);
check('★ ELV1 老码继续有效', r1.status === 'ok' && r1.company === COMPANY, r1.status);
check('  ELV1 没有账号数上限（= 不限）', r1.seats === 0, 'seats=' + r1.seats);
const r2 = license.licenseStatus(old2);
check('★ ELV2 老码（曾一机一码）继续有效', r2.status === 'ok' && r2.company === COMPANY, r2.status);
check('  ELV2 的机器码被忽略，不判不匹配', r2.seats === 0 && r2.status === 'ok', 'seats=' + r2.seats);
check('★ 老码过了日期照样只读', license.licenseStatus('ELV1.' + b64u(`${COMPANY}|${day(-1)}`) + '.' + license._sign(b64u(`${COMPANY}|${day(-1)}`))).status === 'expired');
// 老码公司名不匹配时，仍然要被 server 那层拦（老码也带公司名）
check('  ELV1 老码也能触发公司名比对', withCompanyCheck(old1, '别家公司').status === 'invalid');
// 格式不对的第三字段不能被误当额度
check('★ ELV2 机器码格式不对的码仍判无效',
  license.licenseStatus('ELV2.' + b64u(`${COMPANY}|${day(400)}|乱写`) + '.' + license._sign(b64u(`${COMPANY}|${day(400)}|乱写`))).status === 'invalid');
check('★ ELV3 第三字段不是数字的码判无效',
  license.licenseStatus('ELV3.' + b64u(`${COMPANY}|${day(400)}|乱写`) + '.' + license._sign(b64u(`${COMPANY}|${day(400)}|乱写`))).status === 'invalid');

console.log('\n  [6] ★ 换密钥后老码立即失效（密钥泄露时能止损）');
const before = license.makeLicense(COMPANY, day(400)).code;
process.env.PMS_LICENSE_SECRET = 'a-completely-different-secret-for-testing';
delete require.cache[require.resolve('./license.js')];
const fresh = require('./license.js');
check('★ 换密钥后，老码不再通过', fresh.licenseStatus(before).status === 'invalid',
  fresh.licenseStatus(before).status);
const newCode = fresh.makeLicense(COMPANY, day(400)).code;
check('新密钥签的码能通过', fresh.licenseStatus(newCode).status === 'ok');
delete process.env.PMS_LICENSE_SECRET;
delete require.cache[require.resolve('./license.js')];

console.log('\n  [7] 空码 / 乱码不能崩，要当「未授权」处理');
check('空码 → none（功能可用，只提示）', license.licenseStatus('').status === 'none');
for (const bad of ['   ', '随便写的', 'ELV1.xxx.yyy', 'ELV2.aaa.bbb', 'ELV1.a.b.c', 'ELV4.a.b.c']) {
  let r;
  try { r = license.licenseStatus(bad) } catch (err) { r = { crash: err.message } }
  check(`「${bad}」不抛异常且算无效`, !r.crash && (r.status === 'invalid' || r.status === 'none'),
    r.crash ? '崩了：' + r.crash : r.status);
}

const pass = results.filter(r => r.ok).length;
console.log('\n' + '='.repeat(58));
console.log(`  授权码闭环：${pass} / ${results.length} 项通过`);
if (pass !== results.length) console.log('  失败：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.n).join('\n'));
console.log('='.repeat(58));
process.exit(pass === results.length ? 0 : 1);
