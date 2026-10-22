'use strict';
/**
 * 首次启动的 .env 初始化（第十九套）
 *
 * 用法： node tools/startup-env-test.js
 *
 * 为什么单独一套、而且自己起服务：
 *   .env 初始化**只在库是新建的**时候执行一次，跑在启动流程里而不是 HTTP 接口上。
 *   共享测试实例的库早就存在了，无论怎么发请求都碰不到那段代码 ——
 *   要用「全新的数据目录 + 全新进程」才能压到。
 *
 * 真实故障（2026-10 实测，不是假设）：
 *   全新库 + PMS_ADMIN_PASSWORD=Admin12345 启动，登录返回「账号或密码不正确」，
 *   改用 admin123 反而登进去了 —— 也就是说运维在 .env / docker-compose 里设的
 *   强口令**根本没生效**，管理员口令还是代码里写死的那个公开的默认值。
 *   启动日志只有一句没人看得懂的：
 *       [初始配置] 写入失败：no such table: users
 *   原因：那段代码写在 dbf.init() 之后、建表之前，auth.getUserByName('admin')
 *   在全新库上必然抛 no such table，然后被同一个大 try 吞掉；
 *   而公司名和 AI 配置跟它共用这个 try，管理员密码一抛错，它俩也一起被跳过。
 *
 * 所以这里断言的是**行为**，不是「代码里出现过这个变量名」——
 * tools/verify-compose.js 里原来那条 `serverJs.includes('PMS_ADMIN_PASSWORD')`
 * 在故障期间一直是绿的，正是这条弱断言让问题藏了很久。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');

const ROOT = path.join(__dirname, '..');
const results = [];
let skipped = 0;

function check (name, ok, extra = '') {
  results.push({ name, ok });
  // extra 只当"失败时的解释"用 —— 通过时还挂一句「日志里还写着 admin123」会让人以为出错了
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && extra ? '  — ' + extra : ''}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const TMPROOT = path.join(os.tmpdir(), 'elv-env-test-' + process.pid);

/** 找一个空闲端口（并发跑测试时固定端口会撞车） */
function freePort () {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/**
 * 起一个实例，等它真的能应答再返回。
 *
 * 只等固定毫秒是不行的：机器忙的时候 3 秒起不来，测试就假红；
 * 起来得早的时候又白等。改成轮询 /api/health，最多等 30 秒。
 */
async function startServer (dataDir, env, port) {
  fs.mkdirSync(dataDir, { recursive: true });
  const logFile = path.join(dataDir, 'run-' + Date.now() + '.log');
  const out = fs.openSync(logFile, 'w');
  const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PMS_PORT: String(port), PMS_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return { child, base, logFile, readLog: () => fs.readFileSync(logFile, 'utf8') };
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  const log = fs.readFileSync(logFile, 'utf8');
  try { child.kill(); } catch { /* 忽略 */ }
  throw new Error('测试实例没起来：\n' + log.slice(-1500));
}

async function stopServer (srv) {  if (!srv || !srv.child) return;
  try { srv.child.kill(); } catch { /* 忽略 */ }
  // Windows 上 kill 之后句柄要一点时间才真释放，不等的话下一次同目录启动会摸到锁
  for (let i = 0; i < 40 && srv.child.exitCode === null; i++) await sleep(100);
}

/** 直接打登录接口，不经任何测试辅助（这里测的就是"新库第一次登录"这件事本身） */
async function tryLogin (base, password, username = 'admin') {
  const r = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

/**
 * 起一个实例，一直等到它**自己退出**，收集它打印的内容。
 * 用来测"端口被占时怎么收场"—— 那种情况不会长时间运行，就是要看退出码和话术。
 */
function runTillExit (dataDir, env, port, timeoutMs = 30000) {
  return new Promise(resolve => {
    fs.mkdirSync(dataDir, { recursive: true });
    const child = spawn(process.execPath, ['--no-warnings', path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env: { ...process.env, PMS_PORT: String(port), PMS_DATA_DIR: dataDir, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    child.stdout.on('data', d => { out += d });
    child.stderr.on('data', d => { out += d });
    const timer = setTimeout(() => { try { child.kill() } catch { /* 忽略 */ } }, timeoutMs);
    child.on('exit', code => { clearTimeout(timer); resolve({ code, out }) });
  });
}

(async () => {
  try {
    // ──────────────────────────────────────────────
    console.log('\n [1] 全新库：.env 里设的口令必须真的生效');
    // ──────────────────────────────────────────────
    {
      const dir = path.join(TMPROOT, 'fresh');
      const port = await freePort();
      const ENV_PW = 'Zx!' + Math.random().toString(36).slice(2, 10);
      const srv = await startServer(dir, {
        PMS_ADMIN_PASSWORD: ENV_PW,
        PMS_COMPANY_NAME: '华二临港项目部',
        PMS_AI_ENABLED: '1',
        PMS_AI_MODEL: 'test-model-x',
      }, port);
      try {
        const log = srv.readLog();

        const okEnv = await tryLogin(srv.base, ENV_PW);
        check('.env 设的管理员密码能登录', okEnv.status === 200 && okEnv.body.ok === true,
          `HTTP ${okEnv.status} ${okEnv.body.error || ''}`);

        // 这条是安全项：设了口令却还留着默认口令，等于门锁换了钥匙没换
        const okDefault = await tryLogin(srv.base, 'admin123');
        check('设了 .env 密码后，默认口令 admin123 不能再登录',
          okDefault.status !== 200, okDefault.status === 200 ? '仍然能登录 —— 等于没设' : `HTTP ${okDefault.status}`);

        const h = await (await fetch(srv.base + '/api/health')).json();
        check('.env 的公司名写进了系统设置',
          h.settings && h.settings.company_name === '华二临港项目部', '实际：' + (h.settings && h.settings.company_name));

        // AI 配置不在 settings 表里，落在 data/ai-config.json
        const aiFile = path.join(dir, 'ai-config.json');
        const ai = fs.existsSync(aiFile) ? JSON.parse(fs.readFileSync(aiFile, 'utf8')) : null;
        check('.env 的 AI 助手配置写进了 ai-config.json',
          !!ai && ai.enabled === true && ai.model === 'test-model-x',
          ai ? `enabled=${ai.enabled} model=${ai.model}` : '文件不存在');

        check('启动日志里三件事都有明确交代（不再只有一句"写入失败"）',
          /公司名已按 \.env 设为/.test(log) && /管理员密码已按 \.env 设置/.test(log) && /已按 \.env 设置 AI 助手/.test(log),
          /no such table/.test(log) ? '日志里又出现 no such table' : '');

        check('启动横幅不再把 admin123 当成有效口令印出来',
          !/密码： admin123/.test(log), '日志里还写着 admin123');
      } finally { await stopServer(srv); }

      // ──────────────────────────────────────────────
      console.log('\n [2] 已有库重启：.env 不能再改一次密码');
      // ──────────────────────────────────────────────
      // 这里是最容易被"顺手改成每次都执行"的地方。若每次启动都按 .env 重置密码，
      // 用户在界面上改过的密码会在下次开机时被悄悄改回去 —— 用户只会说"密码自己变了"。
      const port2 = await freePort();
      const NEW_PW = 'Another-' + Date.now();
      const srv2 = await startServer(dir, { PMS_ADMIN_PASSWORD: NEW_PW }, port2);
      try {
        const okOld = await tryLogin(srv2.base, ENV_PW);
        check('重启后原来改过的密码仍然有效', okOld.status === 200, `HTTP ${okOld.status}`);
        const okNew = await tryLogin(srv2.base, NEW_PW);
        check('重启时 .env 里的新密码不会覆盖已有库', okNew.status !== 200, `HTTP ${okNew.status}`);
        const h2 = await (await fetch(srv2.base + '/api/health')).json();
        check('重启时 .env 里的公司名也不会覆盖已有设置',
          h2.settings && h2.settings.company_name === '华二临港项目部', '实际：' + (h2.settings && h2.settings.company_name));
      } finally { await stopServer(srv2); }
    }

    // ──────────────────────────────────────────────
    console.log('\n [3] 不设 .env：默认口令那条老路没被改坏');
    // ──────────────────────────────────────────────
    {
      const dir = path.join(TMPROOT, 'plain');
      const port = await freePort();
      const srv = await startServer(dir, {}, port);
      try {
        const ok = await tryLogin(srv.base, 'admin123');
        check('没设 .env 时，默认口令 admin123 仍可登录（首次使用引导）', ok.status === 200, `HTTP ${ok.status}`);
        const u = ok.body.user || {};
        check('默认账号仍标记「登录后必须改密码」', u.must_change_pw === true, 'must_change_pw=' + u.must_change_pw);
        check('启动横幅照旧提示 admin123',
          /密码： admin123/.test(srv.readLog()), '横幅里没提示默认口令，用户不知道用什么登录');
      } finally { await stopServer(srv); }
    }

    // ──────────────────────────────────────────────
    console.log('\n [4] .env 里的密码被拒绝时，不能连累其它两项');
    // ──────────────────────────────────────────────
    // 三件事曾经共用一个 try：管理员密码一抛错，公司名和 AI 配置一起被跳过。
    // 这里把密码设成一个必然被拒的值，看另外两项是否照常生效。
    {
      const dir = path.join(TMPROOT, 'weakpw');
      const port = await freePort();
      const srv = await startServer(dir, {
        PMS_ADMIN_PASSWORD: '123',          // 太短，resetPassword 应当拒绝
        PMS_COMPANY_NAME: '不连累测试公司',
      }, port);
      try {
        const h = await (await fetch(srv.base + '/api/health')).json();
        check('密码被拒时，公司名照样写进去（一项失败不连累另一项）',
          h.settings && h.settings.company_name === '不连累测试公司', '实际：' + (h.settings && h.settings.company_name));
        check('弱口令被拒时启动日志说清了原因',
          /管理员初始密码设置失败/.test(srv.readLog()) || /密码已按 \.env 设置/.test(srv.readLog()),
          '既没说失败也没说成功');
      } finally { await stopServer(srv); }
    }
    // ──────────────────────────────────────────────
    console.log('\n [5] 端口被占时：先认亲，再报错');
    // ──────────────────────────────────────────────
    // 用户遇到的"打不开系统"，多数情况其实是**上一次那个实例还开着**
    // （开机自启 + 又双击了一次、覆盖安装后旧进程没退、窗口被最小化）。
    // 以前一律报"端口已被占用，请改用其它端口"然后退出 —— 用户以为系统坏了。
    {
      const dirA = path.join(TMPROOT, 'portA');
      const dirB = path.join(TMPROOT, 'portB');
      const port = await freePort();
      const srvA = await startServer(dirA, {}, port);
      try {
        // 同一个数据目录再起一个：应该友好地告诉用户"已经在跑了"
        const same = await runTillExit(dirA, {}, port);
        check('同一个库重复启动：不报错，提示已经在运行', same.code === 0 && /已经在运行/.test(same.out),
          `退出码 ${same.code}｜${same.out.slice(-120).replace(/\s+/g, ' ')}`);
        check('提示里给出了能直接打开的地址', /http:\/\/127\.0\.0\.1:\d+/.test(same.out));

        // 另一个数据目录抢同一个端口：必须报错，而且要说清是"另一个副本"
        const other = await runTillExit(dirB, {}, port);
        check('另一个副本抢同一端口：明确报错（退出码非 0）', other.code !== 0, '退出码 ' + other.code);
        check('报错说清是另一个数据目录的实例，并给了换端口的办法',
          /数据目录/.test(other.out) && /--port/.test(other.out),
          other.out.slice(-160).replace(/\s+/g, ' '));

        // 原来那个实例不能受影响
        const alive = await fetch(srvA.base + '/api/health').then(r => r.ok).catch(() => false);
        check('原来那个实例没被挤掉', alive === true);
      } finally { await stopServer(srvA); }
    }
  } catch (e) {
    check('测试过程未抛异常', false, e.message);
  } finally {
    try { fs.rmSync(TMPROOT, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }

  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length} / ${results.length} 项通过${skipped ? `（另跳过 ${skipped} 条）` : ''}`);
  if (bad.length) {
    console.log('失败项：');
    for (const b of bad) console.log('  ✗ ' + b.name);
  }
  process.exit(bad.length ? 1 : 0);
})();
