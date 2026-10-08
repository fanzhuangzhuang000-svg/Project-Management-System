'use strict';
/**
 * 测试用的登录辅助
 * 直接改本地数据库把 admin 密码设成已知值（避免依赖上一次跑测试时的密码），
 * 然后登录拿到会话 Cookie，并把 Cookie 注入全局 fetch。
 *
 * 用法（在测试脚本里）：
 *   const { prepareAuth, BASE, USER, PASS } = require('./test-auth.js');
 *   await prepareAuth();      // 之后所有 fetch 都自动带上登录态
 */
const path = require('node:path');

const crypto = require('node:crypto');
const BASE = process.env.PMS_BASE || 'http://127.0.0.1:8787';
// 测试专用管理员账号：不碰真实的 admin，避免跑完测试把用户密码改掉。
// 密码每次随机生成，只存在内存里——即使账号忘了删，也没人知道密码。
const USER = 'testadmin';
const PASS = 'T-' + crypto.randomBytes(6).toString('hex');

let cachedToken = null;

/** 删除测试专用管理员账号（测试进程退出时自动调用，不留后患） */
function removeTestAdmin () {
  try {
    const auth = require('../auth.js');
    const u = auth.getUserByName(USER);
    if (u) auth.deleteUser(u.id, null);
  } catch { /* 忽略 */ }
}

let exitHooked = false;
function hookCleanup () {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', removeTestAdmin);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => { removeTestAdmin(); process.exit(1); });
  }
}

/** 直接改库，确保测试管理员存在且密码是已知值（真实 admin 账号不受影响） */
function forceAdminPassword (pw = PASS) {
  const auth = require('../auth.js');
  auth.createTable();
  auth.ensureAdmin();                     // 首次跑时保证真实 admin 已创建
  // 测试都从 127.0.0.1 打过来，先清掉登录失败计数，
  // 否则某个用例故意试错密码会把后面所有用例一起锁在门外。
  auth.clearAllLoginFails();
  let u = auth.getUserByName(USER);
  if (!u) {
    auth.saveUser({
      username: USER, name: '测试管理员', role: 'admin', password: pw, status: '启用',
      remark: '自动化测试专用账号，可随时删除',
    }, null);
    u = auth.getUserByName(USER);
  }
  const r = auth.resetPassword(u.id, pw, false);
  if (r.error) throw new Error('设置测试密码失败：' + r.error);
  auth.saveUser({ id: u.id, username: u.username, name: u.name || '测试管理员', role: 'admin', status: '启用' }, null);
  hookCleanup();                          // 跑完自动删掉这个临时账号
  return pw;
}

/** 解除所有登录锁定（给测试用例用） */
function unlockAll () {
  try { return require('../auth.js').clearAllLoginFails(); } catch { return 0; }
}

/** 本进程是否已经确保过示例数据（只做一次，避免每个测试都重建） */
let demoEnsured = false

async function login (username = USER, password = PASS) {
  // 测试辅助：登录前把本账号的失败计数清掉。
  // 前面某个用例故意试错密码（OCR/登录相关断言）会触发 5 次锁定，
  // 之后所有后续 T.login() 都会被拒 —— 但密码本身是对的，不该被连带锁死。
  try {
    const auth = require('../auth.js');
    auth.clearLoginFails('127.0.0.1', username);
  } catch { /* 表还没建就跳过 */ }
  const res = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('登录失败：' + (data.error || res.status));
  const raw = res.headers.get('set-cookie') || '';
  const m = /pms_session=([^;]+)/.exec(raw);
  if (!m) throw new Error('登录响应里没有会话 Cookie');
  cachedToken = m[1];
  // 管理员首次登录时确保示例数据在（进程内只做一次）。
  // 放在这里而不是 prepareAuth 里，是因为有 8 个测试文件没调 prepareAuth，
  // 却同样依赖示例数据（材料、计划节点、示例项目）—— 挂在登录上才能全覆盖。
  if (!demoEnsured && username === USER) {
    demoEnsured = true;
    await ensureDemoData();
  }
  return cachedToken;
}

/** 让同源的 fetch 自动带上会话 Cookie */
function installFetchCookie (token) {
  const orig = global.fetch;
  global.fetch = (input, init = {}) => {
    const url = typeof input === 'string' ? input : ((input && input.url) || '');
    if (url.startsWith(BASE)) {
      const headers = Object.assign({}, init.headers || {});
      headers.Cookie = `pms_session=${token}`;
      init = Object.assign({}, init, { headers });
    }
    return orig(input, init);
  };
}

/** 一步到位：设密码 → 登录 → 注入 Cookie */
async function prepareAuth () {
  forceAdminPassword();
  const token = await login();
  installFetchCookie(token);
  await resetTestData();
  await ensureDemoData();
  return token;
}

/**
 * 测试套件大量断言依赖「示例数据」（市第一人民医院、收付款、发票、计划节点…）。
 * 用户一旦在「系统设置」里清空示例数据、录了自己的项目，这些断言就会集体失效
 * （features-test 甚至会直接崩）。
 *
 * 这里检测到示例数据缺失就补写一份（都是 is_demo=1 的记录，不碰真实数据），
 * 并明确提示怎么再清掉。绝不静默改动用户库。
 */
async function ensureDemoData () {
  try {
    // 每次跑测试都把示例数据「清掉重建」，保证基线是确定的。
    //
    // 以前是「检测到缺失才补」，但检查太浅：只看有没有 DEMO- 项目。
    // 结果某次级联删除带走了 20 个计划节点、项目还留着，检查通不过（以为数据齐全），
    // 于是依赖计划节点的断言（逾期明细、催款优先级）就集体失败了。
    //
    // 示例数据本来就可以随时重建（is_demo=1，不碰真实数据），
    // 与其猜它缺没缺，不如直接重建 —— 快（约 100ms）而且确定。
    // 必须显式带上 cookie。
    // 这个函数是从 login() 里调的，那时 installFetchCookie() 还没执行，
    // 不带 cookie 的请求会 401 —— 而 /api/demo/seed 需要系统设置权限。
    // 结果就是：日志打印「示例数据已重建」，实际一条都没建，
    // 后续依赖示例数据的断言集体失败，还很难查。
    const cookie = cachedToken ? { Cookie: 'pms_session=' + cachedToken } : {};

    // 播种后**校验一遍**，不齐就重来。
    //
    // 为什么不能「调一次 seed 就完事」：clear 和 seed 是两次独立的写，
    // 中间有个极短的空窗；而且每个测试文件是独立进程、各自都会触发一次重建。
    // 实测出现过 perm-test 读到 materials=0 —— 偶发、很难复现，但对使用者就是「测试有时挂」。
    // 与其猜原因，不如播完就验，不齐就再播一次。
    let ok = false;
    for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
      const res = await fetch(BASE + '/api/demo/seed', { method: 'POST', headers: cookie });
      if (res.status !== 200) {
        console.log(`  [准备] 示例数据补写失败：HTTP ${res.status}（后续依赖示例数据的用例可能会失败）`);
        return;
      }
      const r = await res.json();
      // 三个关键模块都得有数据，缺一个就算没齐
      const chk = await fetch(BASE + '/api/dashboard', { headers: cookie }).then(x => x.json()).catch(() => null);
      const n = chk && chk.totals ? chk.totals : {};
      ok = Number(n.project_count) > 0 && Number(n.material_count) > 0 && Number(n.contract_count) > 0;
      if (ok) {
        console.log(`  [准备] 示例数据已重建（项目 ${n.project_count} / 合同 ${n.contract_count} / 材料 ${n.material_count} / 计划节点 ${(r && r.plans) || '?'}）`);
      } else if (attempt < 3) {
        console.log(`  [准备] 示例数据不完整（项目 ${n.project_count || 0} / 材料 ${n.material_count || 0}），重试第 ${attempt + 1} 次…`);
        await new Promise(r2 => setTimeout(r2, 400));
      } else {
        console.log('  [准备] 连续 3 次都没播全，依赖示例数据的用例可能会失败');
      }
    }
    console.log('         都是 is_demo=1 的记录，你的真实数据一直是 is_demo=0，不受影响');
  } catch (e) {
    console.log('  [准备] 示例数据检查失败（不影响测试继续）：' + e.message.slice(0, 60));
  }
}

// ---------------- 测试数据重置 ----------------
// 上一次测试中途失败会留下残留，污染下一次断言（比如"星海科技园"已存在就不弹新建提示了）。
// 所有 API 测试开跑前统一清一遍。
const RESIDUE = {
  projects: ['界面测试', '继续新增测试', 'UITEST', 'VCHK', '多子系统测试', '附件测试', '星海科技园', 'BATCHTEST', 'FEAT-', 'TEST-IMP', '导入测试', 'AIIN-'],
  contracts: ['附件测试', 'BATCHTEST', 'FEAT-', 'TEST-', '界面测试', 'AIIN-'],
  invoices: ['AIIN'],
  partners: ['界面测试', '从没见过的', '星海科技园', '新锐机电安装', '杭州智联弱电', '测试甲方建设', '测试供应商科技', '测试分包劳务', '批量删除测试', '单条删除测试', 'BATCHTEST', 'AIIN测试'],
};

async function resetTestData (token) {
  const tk = token || cachedToken || await login();
  const hdr = { 'Content-Type': 'application/json', Cookie: `pms_session=${tk}` };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: hdr, body: JSON.stringify(b || {}) }).then(r => r.json());
  const get = u => fetch(BASE + u, { headers: hdr }).then(r => r.json());
  let n = 0;
  try {
    for (const kw of RESIDUE.projects) {
      const r = await get('/api/list/projects?q=' + encodeURIComponent(kw));
      for (const row of (r.rows || [])) { await post(`/api/delete/projects/${row.id}`, { cascade: true, keepAttachments: false }); n++; }
    }
    for (const kw of RESIDUE.contracts) {
      const r = await get('/api/list/contracts?q=' + encodeURIComponent(kw));
      for (const row of (r.rows || [])) { await post(`/api/delete/contracts/${row.id}`, { cascade: true, keepAttachments: false }); n++; }
    }
    for (const kw of RESIDUE.partners) {
      const r = await get('/api/list/partners?q=' + encodeURIComponent(kw));
      for (const row of (r.rows || [])) { await post(`/api/delete/partners/${row.id}`, { cascade: true, keepAttachments: false }); n++; }
    }
    // 识别素材误建出来的发票
    const iv = await get('/api/list/invoices?q=' + encodeURIComponent('24312000000123456789'));
    for (const row of (iv.rows || [])) { await post(`/api/delete/invoices/${row.id}`, { cascade: true }); n++; }
    // 单据进件测试建的发票（AIIN- 前缀）
    for (const kw of (RESIDUE.invoices || [])) {
      const r = await get('/api/list/invoices?q=' + encodeURIComponent(kw));
      for (const row of (r.rows || [])) { await post(`/api/delete/invoices/${row.id}`, { cascade: true }); n++; }
    }
    // 只清「测试自己传的」扫描件，按文件名识别。
    //
    // ⚠️ 这里以前是「无条件删掉所有附件」。项目里只有示例数据时看不出问题（附件数是 0），
    // 但只要用户上传过真实扫描件，就会被一起删光 —— 而 attachments.remove 走的是
    // fs.unlinkSync，不进回收站、删了找不回来。血的教训，绝不能再用无条件删除。
    const TEST_FILE = /^(contract|invoice)\.(pdf|png|jpe?g)$|OCRTEST-|UIOCTEST-|PKGTEST-|示例-合同扫描件|import-contracts-|^probe|UI-RT-|UIBATCH-|附件测试|批量删除测试|AIIN-TEST-/i;
    const a = await get('/api/attachments');
    let skipped = 0;
    for (const row of (a.rows || [])) {
      const nm = String(row.original_name || '');
      if (TEST_FILE.test(nm)) { await post(`/api/attachments/${row.id}/delete`, {}); n++; }
      else skipped++;
    }
    if (skipped) console.log(`  [清理] 已跳过 ${skipped} 个非测试附件（不在删除白名单里）`);
    // 清掉测试留下的回收站条目
    const tr = await get('/api/trash');
    for (const t of (tr.rows || [])) {
      if (RESIDUE.projects.some(k => String(t.label || '').includes(k))) await post(`/api/trash/${t.id}/purge`, {});
    }
  } catch { /* 重置失败不阻断测试 */ }
  return n;
}

const cookieHeader = () => `pms_session=${cachedToken}`;

module.exports = {
  BASE, USER, PASS, forceAdminPassword, login, installFetchCookie, prepareAuth,
  resetTestData, removeTestAdmin, cookieHeader, unlockAll,
};
