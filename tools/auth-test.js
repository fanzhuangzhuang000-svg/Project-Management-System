'use strict';
/**
 * 登录与权限端到端测试
 *   node tools/auth-test.js [http://127.0.0.1:8787]
 *
 * 覆盖：未登录拦截、密码错误、登录、改密、按模块授权、越权被拒、
 *       只读账号看不到写操作、停用账号、管理员保护、退出登录。
 */
const { forceAdminPassword, USER, PASS, BASE: AUTH_BASE } = require('./test-auth.js');

// 基址必须和 test-auth.js 一致：登录会话属于 AUTH_BASE，
// 这里换成别的地址就会带着不属于它的 Cookie 打过去，表现为随机 401。
const BASE = process.argv[2] || AUTH_BASE;
const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

/** 带指定会话的请求 */
async function req (method, path, { body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `pms_session=${cookie}`;
  const res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = {};
  try { data = await res.json(); } catch { /* 空响应 */ }
  return { status: res.status, data, cookie: (/pms_session=([^;]+)/.exec(res.headers.get('set-cookie') || '') || [])[1] };
}
const login = (username, password) => req('POST', '/api/login', { body: { username, password } });

const TUSER = 'test_viewer_' + Date.now().toString().slice(-5);
const TPASS = 'view1234';

(async function main () {
  console.log('\n[0] 准备：确保测试管理员账号可用');
  forceAdminPassword();
  check('测试管理员账号已就绪', true, USER + ' / ' + PASS + '（真实 admin 账号不受影响）');

  // ================= 1. 未登录 =================
  console.log('\n[1] 未登录访问');
  const noAuth = await req('GET', '/api/dashboard');
  check('业务接口返回 401', noAuth.status === 401, 'status=' + noAuth.status);
  check('响应里带 needLogin 标记', noAuth.data.needLogin === true);
  check('健康检查免登录', (await req('GET', '/api/health')).status === 200);

  // ================= 2. 登录 =================
  console.log('\n[2] 登录');
  const bad = await login(USER, 'definitely-wrong');
  check('密码错误被拒', bad.status === 401, bad.data.error);
  const noUser = await login('不存在的账号', 'x');
  check('账号不存在也是同样的提示（不泄露账号是否存在）', noUser.status === 401 && noUser.data.error === bad.data.error);
  const okLogin = await login(USER, PASS);
  check('正确密码登录成功', okLogin.status === 200 && !!okLogin.cookie, okLogin.data.user && okLogin.data.user.username);
  const adminCookie = okLogin.cookie;
  check('返回的权限是管理员', okLogin.data.user.perms.all === true);
  const me = await req('GET', '/api/me', { cookie: adminCookie });
  check('会话可用（/api/me）', me.status === 200 && me.data.user.username === USER);

  // ================= 3. 创建受限账号 =================
  console.log('\n[3] 创建受限账号（只能看项目，不能改）');
  const created = await req('POST', '/api/users', {
    cookie: adminCookie,
    body: {
      username: TUSER, name: '测试查看员', role: 'custom', password: TPASS, status: '启用',
      read: ['projects', 'contracts'], write: [], sys: [],
    },
  });
  check('账号创建成功', created.status === 200 && !!created.data.id, 'id=' + created.data.id);
  const dup = await req('POST', '/api/users', { cookie: adminCookie, body: { username: TUSER, password: TPASS } });
  check('账号名重复被拒', dup.status === 400, dup.data.error);
  const weak = await req('POST', '/api/users', { cookie: adminCookie, body: { username: TUSER + 'x', password: '123' } });
  check('密码太短被拒', weak.status === 400, weak.data.error);

  const vLogin = await login(TUSER, TPASS);
  check('受限账号可以登录', vLogin.status === 200 && !!vLogin.cookie);
  const vCookie = vLogin.cookie;
  const vPerms = vLogin.data.user.perms;
  check('权限按模块生效', vPerms.read.length === 2 && vPerms.write.length === 0 && !vPerms.all,
    `可看 ${vPerms.read.join(',')}，可改 ${vPerms.write.length} 个`);

  // ================= 4. 越权 =================
  console.log('\n[4] 越权访问');
  check('有权限的模块可以看', (await req('GET', '/api/list/projects', { cookie: vCookie })).status === 200);
  const forbidden = await req('GET', '/api/list/invoices', { cookie: vCookie });
  check('没权限的模块被拒（403）', forbidden.status === 403, forbidden.data.error);
  const writeDenied = await req('POST', '/api/save/projects', { cookie: vCookie, body: { name: '越权新增' } });
  check('只读账号不能新增（403）', writeDenied.status === 403, writeDenied.data.error);
  check('只读账号不能删除（403）', (await req('POST', '/api/delete/projects/1', { cookie: vCookie, body: {} })).status === 403);
  check('只读账号不能批量删除（403）', (await req('POST', '/api/batch-delete', { cookie: vCookie, body: { table: 'projects', ids: [1] } })).status === 403);
  check('只读账号不能看回收站（403）', (await req('GET', '/api/trash', { cookie: vCookie })).status === 403);
  check('只读账号不能看操作日志（403）', (await req('GET', '/api/logs', { cookie: vCookie })).status === 403);
  check('只读账号不能管账号（403）', (await req('GET', '/api/users', { cookie: vCookie })).status === 403);
  check('只读账号不能备份（403）', (await req('POST', '/api/backup', { cookie: vCookie, body: {} })).status === 403);
  check('管理员这些都能用', (await req('GET', '/api/trash', { cookie: adminCookie })).status === 200 &&
    (await req('GET', '/api/logs', { cookie: adminCookie })).status === 200 &&
    (await req('GET', '/api/users', { cookie: adminCookie })).status === 200);

  // ================= 5. 登录日志 =================
  console.log('\n[5] 操作日志记录登录');
  const logs = await req('GET', '/api/logs?action=login', { cookie: adminCookie });
  check('记录了登录动作', logs.data.rows.some(l => l.action === 'login'), logs.data.rows.length + ' 条登录日志');

  // ================= 6. 修改密码 =================
  console.log('\n[6] 修改密码');
  const wrongOld = await req('POST', '/api/me/password', { cookie: vCookie, body: { old: 'nope', new: 'newpass123' } });
  check('原密码错误被拒', wrongOld.status === 400, wrongOld.data.error);
  const tooShort = await req('POST', '/api/me/password', { cookie: vCookie, body: { old: TPASS, new: '123' } });
  check('新密码太短被拒', tooShort.status === 400, tooShort.data.error);
  const changed = await req('POST', '/api/me/password', { cookie: vCookie, body: { old: TPASS, new: 'newpass123' } });
  check('改密成功', changed.status === 200);
  check('旧密码不能再登录', (await login(TUSER, TPASS)).status === 401);
  check('新密码可以登录', (await login(TUSER, 'newpass123')).status === 200);

  // ================= 7. 停用与删除 =================
  console.log('\n[7] 停用与删除');
  const uid = created.data.id;
  await req('POST', '/api/users', {
    cookie: adminCookie,
    body: { id: uid, username: TUSER, name: '测试查看员', role: 'custom', status: '停用', read: ['projects'], write: [], sys: [] },
  });
  const afterDisable = await login(TUSER, 'newpass123');
  check('停用后无法登录', afterDisable.status === 403, afterDisable.data.error);
  const oldSession = await req('GET', '/api/me', { cookie: vCookie });
  check('停用后旧会话立即失效', oldSession.status === 401);

  const selfDel = await req('POST', `/api/users/${me.data.user.id}/delete`, { cookie: adminCookie, body: {} });
  check('不能删除当前登录账号', selfDel.status === 400, selfDel.data.error);
  const selfDown = await req('POST', '/api/users', {
    cookie: adminCookie,
    body: { id: me.data.user.id, username: USER, name: '测试管理员', role: 'custom', status: '启用', read: ['projects'], write: [], sys: [] },
  });
  check('不能取消自己的管理员身份', selfDown.status === 400, selfDown.data.error);

  const delUser = await req('POST', `/api/users/${uid}/delete`, { cookie: adminCookie, body: {} });
  check('删除受限账号成功', delUser.status === 200);

  // ================= 8. 退出 =================
  console.log('\n[8] 退出登录');
  const out = await req('POST', '/api/logout', { cookie: adminCookie, body: {} });
  check('退出成功', out.status === 200);
  check('退出后会话失效', (await req('GET', '/api/me', { cookie: adminCookie })).status === 401);

  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`  登录与权限测试：${results.length - failed.length} / ${results.length} 项通过`);
  if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name).join('\n'));
  console.log('='.repeat(60));
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('\n[测试异常]', e.message); process.exit(1); });
