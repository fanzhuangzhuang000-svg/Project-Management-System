'use strict';
/**
 * 授权码测试
 *
 * 分两段：
 *   1) 纯函数（生成/校验/防伪）—— 不依赖服务
 *   2) 服务端集成 —— 授权状态、过期只读、续费放行、账号数上限
 *
 * 用法： node tools/license-test.js [http://127.0.0.1:8787]
 */
const L = require('./license.js');
const T = require('./test-auth.js');
const BASE = process.argv[2] || T.BASE;

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
};

/** 固定「今天」，避免测试结果随真实日期漂移 */
const TODAY = new Date('2026-10-06T00:00:00');
const day = (offset) => {
  const d = new Date(TODAY.getTime() + offset * 86400000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const get = async (p, cookie) => {
  const r = await fetch(BASE + p, { headers: cookie ? { Cookie: cookie } : {} });
  let j = null; try { j = await r.json() } catch { /* ignore */ }
  return { status: r.status, ...(j || {}) };
};
const post = async (p, body, cookie) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body || {}),
  });
  let j = null; try { j = await r.json() } catch { /* ignore */ }
  return { status: r.status, ...(j || {}) };
};

(async () => {
  console.log('[1] 生成与校验');
  const m = L.makeLicense('万祥机电设备有限公司', '2027-12-31');
  check('能生成授权码', !!m.code && m.code.startsWith('ELV3.'), m.code ? m.code.slice(0, 24) + '…' : '');
  check('公司名和到期日回填正确', m.company === '万祥机电设备有限公司' && m.expiry === '2027-12-31');
  check('不填账号数 → 不限', m.seats === 0, 'seats=' + m.seats);

  const m20 = L.makeLicense('万祥机电设备有限公司', '2027-12-31', 20);
  check('能带账号数上限生成', m20.seats === 20 && m20.code.startsWith('ELV3.'));

  const ok = L.licenseStatus(m.code, TODAY);
  check('有效授权 → ok', ok.status === 'ok', `${ok.status} 剩 ${ok.daysLeft} 天`);
  check('有效授权不是只读', ok.readOnly === false);
  check('公司名能从码里解出来', ok.company === '万祥机电设备有限公司', ok.company);

  console.log('\n[2] 日期解析容错');
  for (const [inp, want] of [
    ['2027-12-31', '2027-12-31'],
    ['2027/12/31', '2027-12-31'],
    ['2027年12月31日', '2027-12-31'],
    ['2027.12.31', '2027-12-31'],
    ['2027-1-5', '2027-01-05'],
  ]) {
    check(`「${inp}」→ ${want}`, L.makeLicense('测试', inp).expiry === want, String(L.makeLicense('测试', inp).expiry));
  }
  check('乱写的日期被拒绝', !!L.makeLicense('测试', '明年这时候').error);
  check('空公司名被拒绝', !!L.makeLicense('', '2027-12-31').error);

  console.log('\n[3] 三档状态');
  check('还有 451 天 → ok', L.licenseStatus(L.makeLicense('A', '2027-12-31').code, TODAY).status === 'ok');
  const warn = L.licenseStatus(L.makeLicense('A', day(20)).code, TODAY);
  check('还有 20 天 → warn', warn.status === 'warn', `${warn.daysLeft} 天`);
  check('第 30 天正好进入提醒', L.licenseStatus(L.makeLicense('A', day(30)).code, TODAY).status === 'warn');
  check('第 31 天还不提醒', L.licenseStatus(L.makeLicense('A', day(31)).code, TODAY).status === 'ok');
  const exp = L.licenseStatus(L.makeLicense('A', day(-1)).code, TODAY);
  check('昨天到期 → expired', exp.status === 'expired', `${exp.daysLeft} 天`);
  check('过期后 readOnly = true', exp.readOnly === true);
  check('过期当天不算过期', L.licenseStatus(L.makeLicense('A', day(0)).code, TODAY).readOnly === false);

  console.log('\n[4] 防伪');
  const good = L.makeLicense('真公司', '2027-01-01').code;
  check('原码有效', L.licenseStatus(good, TODAY).status === 'ok');
  check('改最后一位就失效',
    L.licenseStatus(good.slice(0, -1) + (good.slice(-1) === 'A' ? 'B' : 'A'), TODAY).status === 'invalid');
  check('中间插一个字符就失效',
    L.licenseStatus(good.slice(0, 20) + 'X' + good.slice(20), TODAY).status === 'invalid');
  check('乱输入被判无效', L.licenseStatus('随便打的', TODAY).status === 'invalid');
  check('空值 → none（不是 invalid）', L.licenseStatus('', TODAY).status === 'none');
  // 拿一个真签名去配另一个 payload —— 必须失败
  const forgedPayload = Buffer.from('假公司|2099-01-01|999').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  check('换掉 payload 但签名不变 → 无效',
    L.licenseStatus(`ELV3.${forgedPayload}.${good.split('.')[2]}`, TODAY).status === 'invalid');
  check('公司名里的 | 不会破坏格式',
    L.licenseStatus(L.makeLicense('A|B公司', '2027-01-01').code, TODAY).status === 'ok');

  console.log('\n[4b] 老码兼容（ELV1 / ELV2 不能因改造而作废）');
  const b64u = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const p1 = b64u('万祥机电设备有限公司|2027-12-31');
  const old1 = 'ELV1.' + p1 + '.' + L._sign(p1);
  check('★ ELV1 老码仍有效', L.licenseStatus(old1, TODAY).status === 'ok', L.licenseStatus(old1, TODAY).status);
  const p2 = b64u('万祥机电设备有限公司|2027-12-31|MC-1A2B3C4D-5E6F7081');
  const old2 = 'ELV2.' + p2 + '.' + L._sign(p2);
  check('★ ELV2 老码（曾一机一码）仍有效，不再比对机器码',
    L.licenseStatus(old2, TODAY).status === 'ok', L.licenseStatus(old2, TODAY).status);
  check('  ELV2 的机器码不当成账号数', L.licenseStatus(old2, TODAY).seats === 0);

  console.log('\n[5] 服务端集成');
  T.forceAdminPassword();   // 建临时测试账号（真实 admin 不受影响）
  await T.login();
  const H = T.cookieHeader();
  const setLic = async (code) => {
    // 授权码现在会和「系统设置里的公司名」比对（防止把码复制给别家公司用），
    // 所以夹具必须把公司名设成和授权码一致 —— 现实中客户也是这么做的：
    // 先按公司名买码，再把系统里的公司名填成一样的。
    await post('/api/settings', { settings: { company_name: '万祥机电设备有限公司' } }, H);
    await post('/api/settings', { settings: { license_key: code } }, H);
    return (await get('/api/me', H)).license;
  };
  const writeBusiness = async () => (await post('/api/save/partners', { name: 'LT-授权测试单位' }, H)).status;

  const before = await get('/api/me', H);
  check('/api/me 带 license 字段', !!before.license && typeof before.license.status === 'string', before.license?.status);
  check('/api/me 不再暴露本机机器码（已放弃一机一码）', !('machineCode' in before), 'machineCode' in before ? '还在' : '已移除');

  let s = await setLic('');
  check('未填授权码 → none', s.status === 'none', s.status);
  check('未填授权码不锁功能（否则新装就没法用）', s.readOnly === false && await writeBusiness() === 200);

  s = await setLic(L.makeLicense('万祥机电设备有限公司', '2027-12-31').code);
  check('有效授权 → ok，能写', s.status === 'ok' && await writeBusiness() === 200, s.company);

  s = await setLic(L.makeLicense('万祥机电设备有限公司', day(10)).code);
  check('即将到期 → warn，仍能写', s.status === 'warn' && await writeBusiness() === 200, `${s.daysLeft} 天`);

  s = await setLic(L.makeLicense('万祥机电设备有限公司', day(-1)).code);
  check('已过期 → expired', s.status === 'expired', `${s.daysLeft} 天`);
  check('★ 过期后写业务数据被拒（403）', await writeBusiness() === 403);
  check('★ 过期后仍能看数据', (await get('/api/dashboard', H)).status === 200);
  check('★ 过期后仍能导出（导出走 GET，不受影响）', (await fetch(BASE + '/api/export/contracts', { headers: { Cookie: H } })).status === 200);
  check('★ 过期后仍能备份数据', (await post('/api/backup', {}, H)).status === 200);
  check('★ 过期后仍能粘贴新授权码续费', (await post('/api/settings', { settings: { license_key: 'x' } }, H)).status === 200);

  s = await setLic('ELV3.aaaa.bbbb');
  check('伪造的码 → invalid', s.status === 'invalid', s.error);
  check('无效码不锁功能（只是提示，别把客户锁在门外）', s.readOnly === false);

  console.log('\n[5b] 服务端 × 账号数上限');
  // 用 seats=1 造一个「额度只有 1」的码：测试库里至少有 admin + 测试管理员，
  // 所以新建账号必然超限 —— 这正是要验的。
  const seat1 = L.makeLicense('万祥机电设备有限公司', '2027-12-31', 1);
  s = await setLic(seat1.code);
  check('服务端回带账号数上限', s.seats === 1, 'seats=' + s.seats);
  check('服务端回带已用账号数', typeof s.usedSeats === 'number' && s.usedSeats >= 2, 'used=' + s.usedSeats);
  check('★ 已超限时给出提示标记', s.seatsExceeded === true);
  const blocked = await post('/api/users', { username: 'lt_seat_probe', name: '额度探测', password: 'Test1234' }, H);
  check('★ 达上限后新建账号被拒（400）', blocked.status === 400, 'status=' + blocked.status);
  check('★ 拒绝提示说明了上限和解决办法',
    String(blocked.error || '').includes('上限') && String(blocked.error || '').includes('升级'), String(blocked.error || '').slice(0, 60));
  check('★ 超限不锁业务写入（已有账号照常用）', await writeBusiness() === 200);
  // 不限额度 → 能建
  s = await setLic(L.makeLicense('万祥机电设备有限公司', '2027-12-31').code);
  check('不限额度时 seats=0 且不超限', s.seats === 0 && s.seatsExceeded === false, `seats=${s.seats} exceeded=${s.seatsExceeded}`);
  const created = await post('/api/users', { username: 'lt_seat_ok', name: '额度内账号', password: 'Test1234' }, H);
  check('★ 不限额度时能正常新建账号', created.status === 200, 'status=' + created.status);
  if (created.id) await post(`/api/users/${created.id}/delete`, {}, H);
  s = await setLic('');

  console.log('\n[6] 清理');
  await setLic('');
  const dbf = require('../db.js');
  const removed = dbf.db.prepare("DELETE FROM partners WHERE name = 'LT-授权测试单位'").run().changes;
  check('测试数据已清理', removed >= 0, `删除 ${removed} 条`);

  const pass = results.filter(r => r.ok).length;
  console.log('\n' + '='.repeat(56));
  console.log(`  授权测试结果：${pass} / ${results.length} 项通过`);
  if (pass !== results.length) {
    console.log('  失败项：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.name).join('\n'));
  }
  console.log('='.repeat(56));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('[测试异常]', e.message); process.exit(1) });
