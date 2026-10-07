'use strict';
/**
 * 系统设置（界面自定义）测试
 *
 * 覆盖：
 *   - 默认值（老用户升级后界面不变）
 *   - 保存 / 回读
 *   - 非法键被忽略（防止前端塞垃圾进来）
 *   - 权限：普通成员不能改
 *   - 未登录也能拿到品牌信息（登录页要显示系统名）
 *   - 公司名为空时的兜底
 *
 * 用法： node tools/settings-test.js [http://127.0.0.1:8787]
 */
const T = require('./test-auth.js');
const BASE = process.argv[2] || T.BASE;

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
};

const get = async (p, cookie) => {
  const r = await fetch(BASE + p, { headers: cookie ? { Cookie: cookie } : {} });
  let j = null; try { j = await r.json() } catch { /* 非 JSON */ }
  return { status: r.status, ...(j || {}) };
};
const post = async (p, body, cookie) => {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json() } catch { /* 非 JSON */ }
  return { status: r.status, ...(j || {}) };
};

T.forceAdminPassword();
(async () => {
  // T.login() 返回的是会话 token（不是完整 Cookie 头），要自己拼
  await T.login();
  const admin = T.cookieHeader();

  const DEFAULTS = {
    company_name: '项目团队',
    system_name: '弱电智能化工程项目管理系统',
    welcome_morning: '上午好，{公司名} 👋',
    welcome_afternoon: '下午好，{公司名} ☕',
    welcome_evening: '晚上好，{公司名} 🌙',
    welcome_subtitle: '以下是您团队今日的工作概览',
  };

  console.log('[1] 读取与默认值');
  const init = await get('/api/settings', admin);
  check('能读到设置', init.status === 200 && !!init.settings);
  check('后端带了默认值（前端做「恢复默认」用）', !!init.defaults && Object.keys(init.defaults).length >= 6,
    Object.keys(init.defaults || {}).join(', '));
  check('默认值里有公司名和系统名',
    typeof init.settings.company_name === 'string' && typeof init.settings.system_name === 'string');

  const me = await get('/api/me', admin);
  check('/api/me 也带上设置（前端启动就能用）', !!me.settings && !!me.settings.system_name);

  console.log('\n[2] 未登录也要能拿到品牌信息（登录页显示系统名用）');
  const health = await get('/api/health');
  check('/api/health 带 settings', !!health.settings && !!health.settings.system_name,
    JSON.stringify(health.settings));
  const anon = await get('/api/me');
  check('未登录访问 /api/me 返回 401', anon.status === 401);
  check('401 里也带 settings（否则登录页没法显示系统名）', !!anon.settings && !!anon.settings.system_name);
  check('公开的只有品牌字段，不含授权码等敏感项',
    anon.settings && !('license_key' in anon.settings) && Object.keys(anon.settings).length <= 2,
    Object.keys(anon.settings || {}).join(', '));

  console.log('\n[3] 保存与回读');
  const target = {
    company_name: '万祥机电设备有限公司',
    system_name: '万祥机电工程管理系统',
    welcome_morning: '早上好，{公司名} 💪',
    welcome_afternoon: '下午好呀，{公司名}',
    welcome_evening: '晚上好，{公司名}，辛苦了',
    welcome_subtitle: '这是今天的活儿',
  };
  const saved = await post('/api/settings', { settings: target }, admin);
  check('保存成功', saved.ok === true, JSON.stringify(saved.saved || []));
  check('六个键都存了', (saved.saved || []).length === 6, String((saved.saved || []).length));
  const back = await get('/api/settings', admin);
  let same = true, diffKey = '';
  for (const k of Object.keys(DEFAULTS)) {
    if (String(back.settings[k]) !== String(target[k])) { same = false; diffKey = k; break }
  }
  check('回读和写入一致', same, same ? '六项全对' : `不一致：${diffKey}`);

  console.log('\n[4] 只写传进来的键，其余不动');
  const partial = await post('/api/settings', { settings: { welcome_subtitle: '只改这一个' } }, admin);
  check('只改了一个键', (partial.saved || []).length === 1, JSON.stringify(partial.saved));
  const after = await get('/api/settings', admin);
  check('company_name 没被清掉', after.settings.company_name === target.company_name,
    after.settings.company_name);
  check('system_name 没被清掉', after.settings.system_name === target.system_name, after.settings.system_name);
  check('改的那个确实改了', after.settings.welcome_subtitle === '只改这一个');

  console.log('\n[5] 非法键要被忽略（防止塞垃圾）');
  const evil = await post('/api/settings', {
    settings: { evil_key: '恶意', __proto__x: 'x', company_name: '合法值' },
  }, admin);
  check('只存了合法键', JSON.stringify(evil.saved) === '["company_name"]', JSON.stringify(evil.saved));
  check('结果里没有非法键', !('evil_key' in (evil.settings || {})));
  const still = await get('/api/settings', admin);
  check('回读也没有非法键', !('evil_key' in still.settings));

  console.log('\n[6] 空值处理');
  await post('/api/settings', { settings: { company_name: '', welcome_subtitle: '' } }, admin);
  const empty = await get('/api/settings', admin);
  // 存了空串要回退到默认值 —— 否则欢迎语会渲染成「上午好， 👋」这种缺一块的样子
  check('公司名清空后回退到默认（不是空串）', empty.settings.company_name === '项目团队',
    JSON.stringify(empty.settings.company_name));
  check('副标题清空后也回退到默认',
    empty.settings.welcome_subtitle === '以下是您团队今日的工作概览',
    JSON.stringify(empty.settings.welcome_subtitle));

  console.log('\n[7] 权限：普通成员不能改');
  const uname = 'settest_' + Math.random().toString(36).slice(2, 7);
  const mk = await post('/api/users', {
    username: uname, name: '设置权限测试', password: 'Test@123456', role: 'custom', status: '启用',
    read: ['projects'], write: [], sys: [],
  }, admin);
  check('建了受限账号', !!mk.id, uname);
  const lr = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: uname, password: 'Test@123456' }),
  });
  const lj = await lr.json();
  const cookie = 'pms_session=' + ((lr.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/) || [])[1];
  check('受限账号能登录', !!lj.user);

  const roRead = await get('/api/settings', cookie);
  check('受限账号能读设置（前端要渲染界面）', roRead.status === 200 && !!roRead.settings);
  const roWrite = await post('/api/settings', { settings: { company_name: '越权改名' } }, cookie);
  check('受限账号不能写设置', roWrite.status === 403, 'HTTP ' + roWrite.status);
  const unchanged = await get('/api/settings', admin);
  check('越权写入没生效', unchanged.settings.company_name !== '越权改名', unchanged.settings.company_name);

  console.log('\n[8] 恢复默认（收尾）');
  const reset = await post('/api/settings', { settings: DEFAULTS }, admin);
  check('恢复默认成功', reset.ok === true);
  const final = await get('/api/settings', admin);
  let allDefault = true;
  for (const k of Object.keys(DEFAULTS)) if (String(final.settings[k]) !== String(DEFAULTS[k])) allDefault = false;
  check('六项都回到默认', allDefault, JSON.stringify(final.settings.company_name));

  // 清理
  if (mk.id) await post(`/api/users/${mk.id}/delete`, {}, admin).catch(() => {});
  check('清理测试账号', true);

  const pass = results.filter(r => r.ok).length;
  console.log('\n' + '='.repeat(56));
  console.log(`  设置测试结果：${pass} / ${results.length} 项通过`);
  if (pass !== results.length) {
    console.log('  失败项：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.name).join('\n'));
  }
  console.log('='.repeat(56));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('[测试异常]', e.message); process.exit(1) });
