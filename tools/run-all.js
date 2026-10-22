'use strict';
/**
 * 一条命令跑完所有验证
 *
 * 用法： node tools/run-all.js
 *
 * 顺序有讲究：
 *   先构建前端（安装包要打包 public），再跑逻辑测试，最后打安装包并验证安装。
 *   两个安装验证之间要留间隔 —— 它们都用临时目录，紧挨着跑会互相干扰
 *   （安装包 exe 刚被上一个脚本占用，文件锁还没释放）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
// 基址和默认端口都来自 tools/test-base.js —— 那里写了为什么不能默认 8787
// （8787 是用户正式实例的端口，测试连上去就是拿真实库做实验）。
const { BASE, TEST_PORT, DATA_DIR } = require('./test-base.js');
// 端口从 BASE 推导，而不是写死 8787：
// 本机已经装了一份在跑的正式系统时（它占着 8787），测试要能换端口跑，
// 否则只能先停掉正在用的服务 —— 这正是之前踩过的坑。
const PORT = (() => {
  try { const u = new URL(BASE); return u.port || (u.protocol === 'https:' ? '443' : '80') } catch { return TEST_PORT }
})();
const npm = process.env.PMS_NPM || 'npm';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const rows = [];
function head (t) {
  console.log('');
  console.log('  ' + '═'.repeat(58));
  console.log('  ' + t);
  console.log('  ' + '═'.repeat(58));
}
function row (name, ok, detail = '') {
  rows.push({ name, ok, detail, skipped: false });
  console.log(`    ${ok ? '✓' : '✗'} ${name.padEnd(22)} ${detail}`);
}
/**
 * 记一条「没跑」。
 *
 * 以前这里写的是 row(name, true, '跳过') —— 跳过的项被记成通过，
 * 汇总里那句「全部通过」也就把 9 个从没执行过的套件算进去了。
 * 这等于判分器自己在撒谎：越是不敢跑的地方，报告越绿。
 *
 * 现在跳过是独立的第三种状态：不算通过、不算失败，但一定单独计数并打印，
 * 而且必须带原因。汇总行会把「通过 / 失败 / 跳过」三个数都写出来，
 * 想瞒也瞒不住。
 */
function skip (name, reason) {
  rows.push({ name, ok: true, detail: reason, skipped: true });
  console.log(`    ⊘ ${name.padEnd(22)} 跳过：${reason}`);
}

/** 跑一个 node 脚本，返回 stdout（不继承 stdio，避免刷屏） */
function runNode (script, args = [], timeout = 900000) {
  const r = spawnSync('node', ['--no-warnings', script, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * CI 模式下不跑的套件 —— 每一个都必须写明**确切原因**。
 *
 * 别把这份清单当"不重要所以跳过"：它们在本地是有意义的（装机、PG+MinIO 集成、
 * 示例数据反复重建……）。不跑只有一个原因 —— **CI 环境提供不了前提**。
 *
 * 每个条目是 file -> 原因。原因必须具体到"缺哪个文件/哪个服务"，
 * 写"环境不具备"这种话等于没写 —— 半年后没人知道该补什么。
 *
 * 哪个套件恢复成可跑（比如素材改用合成件入库），从这里删掉对应行即可。
 * 这份清单只允许变短。
 */
const CI_SKIP = new Map([
  // 需要装 PostgreSQL + MinIO 才能跑。CI 的 windows-latest 上没有这套栈，
  // 要补就得在 workflow 里起 service container，属于另开一条集成流水线的事。
  ['verify-pro-edition.js', '需要真实 PostgreSQL + MinIO 栈（CI 未起服务）'],
  // verify-installed.js 原来也在这里，理由是"CI 里 run-all 跑的时候还没打包"。
  // 现在它已从第 3 步挪到第 6 步（打完包之后），跳不跳由"有没有比源码新的包"
  // 决定，不再需要按环境写死。CI 自己的打包在 run-all 之后，所以那边仍然走
  // 第 6 步的 skip 分支，并另有一个独立步骤在打包后调它 —— 两处语义一致。
]);
const CI = process.argv.includes('--ci') || process.env.PMS_CI === '1';

(async () => {
  console.log('');
  console.log('  弱电智能化工程项目管理系统 · 全量验证');
  console.log(`  ${new Date().toLocaleString('zh-CN')}`);

  // ---------- 0. 服务是否在跑 ----------
  head('0/6  环境检查');
  // 先给仓库打一份离线快照。全量验证会跑打包、装机、覆盖安装、卸载 ——
  // 全是"大面积动文件"的操作，而这个目录里的代码是**唯一副本**
  // （2026-10 已经因此丢过一次仓库根目录）。bundle 放在仓库外面，
  // 出事了 `git clone xxx.bundle` 就能整份还原。打不出来不阻断，只提示。
  {
    const r = runNode(path.join('tools', 'repo-bundle.js'));
    const line = r.out.split('\n').find(l => /仓库快照|没打成/.test(l)) || '';
    row('仓库快照', /仓库快照：/.test(line), line.replace(/^\s*[✓⊘]\s*/, '').slice(0, 90));
  }

  let up = false;
  try { const r = await fetch(BASE + '/api/health'); up = r.ok } catch { /* 没起 */ }
  // 自己起的服务最后要关掉（见文件末尾），否则下次跑测试会连上一个数据目录
  // 已经对不上的老进程 —— 那正是 2026-10 那次"密码永远不对"的成因之一。
  let ownServerPid = 0;
  if (!up) {
    console.log(`    服务没在跑，正在启动测试实例（端口 ${PORT} · 数据目录 ${DATA_DIR}）…`);
    const { spawn } = require('node:child_process');
    const child = spawn('node', ['--no-warnings', 'server.js', '--port', PORT], {
      cwd: ROOT, stdio: 'ignore', detached: true,
      // ⚠️ 显式指定 PMS_DATA_DIR：测试进程改库和请求服务必须落在**同一个库**上。
      //    不写的话两边各自按 cwd 去猜默认值，cwd 一变就错位。
      env: { ...process.env, PMS_DATA_DIR: DATA_DIR },
    });
    ownServerPid = child.pid;
    child.unref();
    for (let i = 0; i < 30 && !up; i++) { await sleep(500); try { const r = await fetch(BASE + '/api/health'); up = r.ok } catch { /* 等 */ } }
  } else {
    console.log(`    复用已在运行的实例（${BASE}）`);
  }
  row('服务可访问', up, up ? BASE : '✗ 启动失败');
  if (!up) { console.log('\n  服务起不来，后面的测试没有意义，先解决它。'); process.exit(1) }
  // 及早验证"服务读的库 == 测试要改的库"，别等跑到一半才红一片
  {
    let sameDb = true, why = '';
    try {
      const h = await (await fetch(BASE + '/api/health')).json();
      const me = require('../db.js');
      const crypto = require('node:crypto');
      const hash = s => crypto.createHash('sha1')
        .update(path.resolve(String(s || '')).replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 12);
      if (!h.dbId) { sameDb = false; why = '服务版本太旧，health 没有 dbId' } else if (h.dbId !== hash(me.DB_FILE)) {
        sameDb = false;
        why = `服务端读的是 ${h.db}（dbId ${h.dbId}），测试端要改的是 ${me.DB_FILE}`;
      }
    } catch (e) { sameDb = false; why = e.message.slice(0, 120) }
    row('库一致性', sameDb, sameDb ? '服务端与测试端是同一个库' : '✗ ' + why);
    if (!sameDb) {
      console.log('\n  测试进程和服务读的不是同一个数据库 —— 继续跑只会写坏数据，先停下。');
      if (ownServerPid) { try { process.kill(ownServerPid) } catch { /* 已退出 */ } }
      process.exit(1);
    }
  }

  // ---------- 1. 前端构建 ----------
  head('1/6  前端构建（tsc 类型检查 + vite 打包）');
  try {
    const r = spawnSync(npm, ['run', 'build'], { cwd: path.join(ROOT, 'web'), encoding: 'utf8', timeout: 600000, shell: true, windowsHide: true });
    const ok = r.status === 0;
    const m = /built in ([\d.]+)s/.exec((r.stdout || '') + (r.stderr || ''));
    row('前端构建', ok, ok ? `打包完成 ${m ? m[1] + 's' : ''}` : '✗ 构建失败');
    if (!ok) console.log(((r.stdout || '') + (r.stderr || '')).split('\n').slice(-12).join('\n'));
  } catch (e) { row('前端构建', false, e.message.slice(0, 60)) }

  // ---------- 2. 单元测试 ----------
  head('2/6  纯函数单元测试');
  {
    const r = runNode(path.join('tools', 'unit-test.js'));
    const m = /(\d+)\s*\/\s*(\d+) 项通过/.exec(r.out);
    const p = m ? +m[1] : 0, a = m ? +m[2] : 0;
    row('单元测试', p === a && a > 0, a ? `${p}/${a}` : '✗ 未取得结果');
    if (p !== a) console.log(r.out.split('\n').filter(l => l.includes('✗')).join('\n'));
  }

  // ---------- 3. 主程序测试套件 ----------
  // 标题里的套件数写死过一次（写 27，实际 28），之后每次加套件都忘改 ——
  // 报告上的数字和实际跑的对不上，正是这套判分器最容易骗人的地方。改成算出来的。
  const SUITES = [    ['登录与权限', 'auth-test.js'], ['表级越权', 'perm-test.js'],
    ['八项优化', 'upgrade-test.js'], ['性能回归', 'perf-test.js'],
    ['子系统多选', 'multi-test.js'], ['付款条款解析', 'plan-test.js'],
    ['批量删除', 'batch-test.js'], ['批量导入', 'import-test.js'],
    ['新功能', 'features-test.js'], ['识别链路', 'ocr-chain-test.js'],
    ['系统设置', 'settings-test.js'], ['授权码', 'license-test.js'],
    ['授权闭环', 'license-flow-test.js'],
    ['升级迁移', 'migration-test.js'], ['MinIO 存储', 'minio-mock-test.js'],
    ['Docker 配置', 'verify-compose.js'],
    ['示例数据一致性', 'reseed-atomic-test.js'],
    // ⚠️ 「装机验证」(verify-installed.js) 不在这个列表里。
    //    它验的是"装出来的包 == 仓库代码吗"，而安装包要到第 5 步才生成。
    //    放在这里会验到**上一次**打的包：本机实际跑出过
    //    「★ 包内代码与仓库一致 — 不一致：server.js」，原因是第 3 步装的是
    //    dist-installer 里改动前的旧包，第 5 步才重新打。现已挪到第 6 步，
    //    紧跟在打包之后 —— 那条断言本来就是为这种时序错位写的，结果它先抓到了自己。
    ['多租户隔离', 'tenant-test.js'],
    ['专业版集成', 'verify-pro-edition.js'],
    ['AI 助手', 'ai-test.js'], ['React 界面', 'ui-react-test.js'],
    // 纯静态检查：health 被当成结果对象用，会让启动警告恒亮、
    // /api/meta 的 ocr.ok 恒为空。属性访问 undefined 不会报错，最易复发。
    ['识别状态取值', 'ocr-health-usage-test.js'],
    // /api/health 未登录可达，PG 下 DB_FILE 含明文密码 —— 必须保证回显时已脱敏。
    ['数据库凭据脱敏', 'db-cred-leak-test.js'],
    // 发布链路：workflow 写错会导致 Release 静默不产出，YAML 语法错则直接不跑。
    ['发布工作流', 'check-workflows.js'],
    // 版本号一致性：server.js 曾写死 '1.0.0'，1.0.1/1.0.2 的包对外谎报 v1.0.0。
    ['版本号一致性', 'version-consistency-test.js'],
    // 发票抬头是左右两栏并排，归一化删掉汉字间空格后购买方会吞掉销售方
    // （线上真实票据：「上海A公司销名称:上海B公司」当成了一个公司名）。
    ['发票购销双方', 'invoice-party-test.js'],
    // 单据进件：AI 助手收一张发票/合同/表格进来 → 判断该录到哪张表 → 方案 → 确认落库。
    // 识别结果直接写库，不跑 OCR，所以 CI 上也能跑（素材不入库）。
    ['单据进件', 'ingest-test.js'],
    // 静态检查：调用业务模块方法时，前缀名必须真的被定义过。
    // 起源是一个真事故：sweepLogs() 里写 `logs.purge(days)`，而导入的名字是 logmod，
    // 那行每次都抛 ReferenceError 并被 catch 吞掉 —— 「日志保留天数」从上线起就没生效。
    // 它不在任何请求路径上，接口测试和单元测试都碰不到，只能靠静态检查兜。
    // 模块引用有效性：见下方说明
    ['模块引用有效性', 'module-ref-test.js'],
    // 低频接口与越权回归：解锁账号、清日志、清示例数据、重新匹配、计划预览、
    // 批量删除 dryRun、附件 inline 预览 —— 这些之前一条断言都没有。
    // 同时压四个越权口子：暂存附件归属、回收站还原、导入目标表、设置脱敏。
    ['低频接口与越权', 'api-extra-test.js'],
    // 口径一致性 / 原子性：把「同一个业务事实」从两个入口各取一次必须相等。
    // 起源是三个只有横向对照才露馅的 BUG：回款率排行把付款算进收款、
    // 闰日合同的质保金到期日溢出到 3 月 1 号、发票自动挂账方向反了。
    // 这类问题不报错、不崩溃，单看任何一个页面都挑不出毛病。
    ['口径一致性与原子性', 'consistency-test.js'],
    // 首次启动的 .env 初始化：只有「全新数据目录 + 全新进程」才压得到，
    // 所以这套自己起服务（不连共享实例）。起源是实测故障 —— 全新库设了
    // PMS_ADMIN_PASSWORD，管理员口令却还是公开的 admin123。
    ['启动初始化', 'startup-env-test.js'],
    // 接口健壮性：请求体是 JSON 的 null / "abc" / 123、脏 ID、5 MB 请求体。
    // 以前这些都会 500 并把英文异常原文弹给用户，超限则直接掐连接（fetch failed）。
    ['接口健壮性', 'robustness-test.js'],
  ];
  head(`3/6  主程序测试（${SUITES.length} 套件）`);
  let suitePass = 0, suiteTotal = 0, skipped = 0;
  for (const [name, file] of SUITES) {
    if (CI && CI_SKIP.has(file)) {
      skipped++;
      skip(name, CI_SKIP.get(file));
      continue;
    }
    const t0 = Date.now();
    const r = runNode(path.join('tools', file), [BASE]);
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    // 套件自己说「这台机器跑不了」时，必须走 SKIP 通道。
    //
    // 为什么要有这条：有些套件缺的是**运行时能力**（浏览器没装、中文 OCR 语言包没有），
    // 不是缺文件，所以没法在 CI_SKIP 里静态列出来 —— 同一台机器换个环境就跑得了。
    // 以前这种套件只能二选一：假装通过（埋雷），或直接失败（噪音）。
    // 现在统一约定：打印 `SKIP: 原因` 并以 0 退出，由这里转成"未执行"。
    const skipMsg = /^\s*SKIP[:：]\s*(.+)$/m.exec(r.out);
    if (skipMsg) {
      skipped++;
      skip(name, skipMsg[1].trim());
      continue;
    }
    const m = /(\d+)\s*\/\s*(\d+) 项通过/.exec(r.out);
    if (m) {
      const p = +m[1], a = +m[2];
      // 套件内部主动跳过的用例数（例如没有中文 OCR 语言包时的图片识别断言）。
      // 这些不计入分母，但必须显示出来 —— 否则「31/31」看着满分，
      // 实际有 2 条根本没跑。
      const inner = /跳过\s*(\d+)/.exec(r.out);
      const note = inner && +inner[1] > 0 ? `  跳过 ${inner[1]} 条` : '';
      suitePass += p; suiteTotal += a;
      row(name, p === a, `${p}/${a}  ${sec}s${note}`);
      if (p !== a) console.log(r.out.split('\n').filter(l => l.includes('✗')).slice(0, 6).map(l => '        ' + l.trim()).join('\n'));
    } else {
      row(name, false, '✗ 未取得结果');
      console.log(r.out.split('\n').slice(-8).map(l => '        ' + l).join('\n'));
    }
  }
  console.log(`    ${'—'.repeat(40)}`);
  console.log(`    小计 ${suitePass} / ${suiteTotal}${skipped ? `（另有 ${skipped} 个套件未执行，见上方 ⊘）` : ''}`);

  // ---------- 4. OCR 自检 ----------
  head('4/6  OCR 自检（全部素材）');
  {
    const fix = path.join(ROOT, 'tools', 'fixtures');
    const files = ['contract.pdf', 'contract-new.pdf', 'invoice.pdf', 'contract-scan.png']
      .map(f => path.join(fix, f)).filter(f => fs.existsSync(f));
    if (!files.length) {
      // 一份素材都没有时不能报"失败"——素材本就不入库（.gitignore），
      // 报失败会让 CI 永远红，而且看不出真实原因。
      // 但也不能报"通过"：那会让「OCR 自检」这一整段在报告里凭空变成绿的。
      skip('OCR 自检', '无夹具素材（tools/fixtures/ 为空）');
    } else {
      // 图片素材走的是系统级 OCR（WinRT / Tesseract），缺中文语言包时
      // 识别出来是空的 —— GitHub 的 windows-latest、海外客户的英文系统都这样。
      // 这是环境能力问题，如实标成「未执行」；PDF 文字层是纯 JS，不受影响。
      let zhOk = true;
      try {
        const { windowsOcrLangs } = require('./ocr-backend.js');
        zhOk = windowsOcrLangs().some(l => /^zh/i.test(l));
      } catch { /* 探测不了就当可用，让断言自己说话 */ }
      const run = files.filter(f => zhOk || f.toLowerCase().endsWith('.pdf'));
      const drop = files.filter(f => !zhOk && !f.toLowerCase().endsWith('.pdf'));
      for (const f of drop) skip(`OCR 自检 ${path.basename(f)}`, '系统没有中文 OCR 语言包，图片扫描件认不出中文（PDF 文字层不受影响）');
      if (!run.length && drop.length) skip('OCR 自检', '当前环境没有任何可用的中文识别引擎');
      if (run.length) {
        const r = runNode(path.join('tools', 'ocr-selftest.js'), run);
        const names = [...r.out.matchAll(/文件: ([^\r\n]+)/g)].map(m => path.basename(m[1].trim()));
        const scores = [...r.out.matchAll(/置信度: (\d+)\s*% \((\d+)\/(\d+)/g)];
        if (!names.length) row('OCR 自检', false, '✗ 没有输出');
        for (let i = 0; i < names.length; i++) {
          const s = scores[i];
          if (!s) { row(names[i], false, '✗ 无置信度'); continue }
          row(names[i], s[2] === s[3], `${s[1]}%  ${s[2]}/${s[3]}`);
        }
      }
    }
  }

  // ---------- 5. 打安装包 ----------
  head('5/6  打安装包');
  if (CI) {
    // 打包一次要 4~8 分钟（压 node.exe 83MB）。CI 里紧接着还要跑
    // build-artifacts.js 再打一遍同样的东西 —— 两遍加起来十几分钟纯浪费。
    // 这里如实标成"没跑"，不假装通过。
    skip('生成安装包', '本步让给 build-artifacts.js（CI 里由「打交付包」步骤覆盖）');
  } else {
    const r = runNode(path.join('tools', 'build-installer.js'));
    const exe = require('./installer-path.js').findInstaller();
    const ok = fs.existsSync(exe);
    row('生成安装包', ok, ok ? `${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB` : '✗ 未生成');
    if (!ok) console.log(r.out.split('\n').slice(-10).map(l => '        ' + l).join('\n'));
  }

  // ---------- 6. 安装包验证 ----------
  head('6/6  安装包验证');
  //
  // 跳过与否只看两件**具体的事**，不能因为「在 CI 里」就一律跳过：
  //   ① 有没有安装包 exe —— 没打包就没法装
  //   ② 有没有识别素材 —— 装机验证要传一份合同扫描件走完整的 OCR 链路
  // 素材现在是合成件、随仓库入库（tools/fixtures/），所以 ② 在 CI 上也是满足的。
  const exeForVerify = require('./installer-path.js').findInstaller();
  const fixturePdf = path.join(ROOT, 'tools', 'fixtures', 'contract.pdf');

  /**
   * 目录里最新的文件时间（递归）。
   * 用来判断「安装包是不是比源码还旧」—— 旧包装出来的是旧程序，
   * 拿它当验证对象等于验证上一版的代码，报出来的红绿都不算数。
   */
  function newestMtime (dir) {
    let max = 0;
    let stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let ents;
      try { ents = fs.readdirSync(cur, { withFileTypes: true }) } catch { continue }
      for (const e of ents) {
        const p = path.join(cur, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') stack.push(p); continue }
        try { max = Math.max(max, fs.statSync(p).mtimeMs) } catch { /* 忽略 */ }
      }
    }
    return max;
  }
  /**
   * ⚠️ 判据里**不能**包含 public/。
   * 本脚本第 1 步自己就会 `npm run build` 重建 public/，它的 mtime 永远比
   * 上一次打的安装包新 —— 那样第 6 步永远跳过，等于把这一整段验证废掉。
   * 真正决定包内容的是前端源码（web/src）、后端源码和安装脚本，比这几处就够了。
   */
  const srcMtime = Math.max(
    newestMtime(path.join(ROOT, 'web', 'src')),
    ...['server.js', 'db.js', 'auth.js', 'ai.js', 'attachments.js', 'schema.js', 'migrations.js'].map(f => {
      try { return fs.statSync(path.join(ROOT, f)).mtimeMs } catch { return 0 }
    }),
    ...['build-installer.js', path.join('installer', 'Installer.cs')].map(f => {
      try { return fs.statSync(path.join(ROOT, 'tools', f)).mtimeMs } catch { return 0 }
    }),
  );
  const exeStale = exeForVerify && fs.existsSync(exeForVerify) && fs.statSync(exeForVerify).mtimeMs < srcMtime;

  if (!exeForVerify || !fs.existsSync(exeForVerify)) {
    skip('常规验证（装→跑→卸）', '还没打安装包；先跑 npm run dist 或 node tools/build-installer.js');
    skip('装机验证', '还没打安装包（它要打开包里的 app/server.js 逐字节比对）');
    skip('覆盖安装（服务在跑时覆盖）', '还没打安装包；同上');
  } else if (exeStale) {
    // 这一步以前不存在，代价是「改了安装脚本但没重新打包」时，
    // 验证跑的是上一次的包 —— 要么假绿（旧包刚好没问题），要么假红（旧包的毛病）。
    skip('常规验证（装→跑→卸）', '安装包比源码旧，先重新打包（node tools/build-installer.js）');
    skip('装机验证', '安装包比源码旧 —— 验它等于验上一版代码');
    skip('覆盖安装（服务在跑时覆盖）', '安装包比源码旧，同上');
  } else if (!fs.existsSync(fixturePdf)) {
    skip('常规验证（装→跑→卸）', '缺识别素材 tools/fixtures/contract.pdf（跑 node tools/fixtures/make-fixtures.js 生成）');
    skip('装机验证', '缺识别素材 tools/fixtures/contract.pdf（装机验证要走完整 OCR 链路）');
    skip('覆盖安装（服务在跑时覆盖）', '缺识别素材 tools/fixtures/contract.pdf');
  } else {
    {
      const r = runNode(path.join('tools', 'verify-installer.js'));
      const ok = /全部通过/.test(r.out);
      const m = /(\d+)\s*\/\s*(\d+) 项通过/.exec(r.out);
      row('常规验证（装→跑→卸）', ok, m ? m[0] : (ok ? '全部通过' : '✗ 有失败'));
      if (!ok) console.log(r.out.split('\n').filter(l => l.includes('✗')).slice(0, 6).map(l => '        ' + l.trim()).join('\n'));
    }
    // 装机验证紧跟在这里 —— 它比对的是"包里的 server.js 与仓库是否逐字节相同"，
    // 必须用**刚落盘**的包，不能是上一次的。
    {
      const r = runNode(path.join('tools', 'verify-installed.js'));
      const ok = /全部通过|(\d+)\s*\/\s*(\d+) 项通过/.test(r.out) && !/\d+ 项失败/.test(r.out);
      const m = /(\d+)\s*\/\s*(\d+) 项通过/.exec(r.out);
      row('装机验证', ok, m ? m[0] : (ok ? '全部通过' : '✗ 有失败'));
      if (!ok) console.log(r.out.split('\n').filter(l => l.includes('✗')).slice(0, 6).map(l => '        ' + l.trim()).join('\n'));
    }
    // 两个安装验证都用临时目录，紧挨着跑会因为文件锁互相干扰
    console.log('    （等 12 秒：上一个验证的临时服务和文件锁要时间释放）');
    await sleep(12000);
    {
      const r = runNode(path.join('tools', 'verify-overwrite.js'));
      const ok = /全部通过/.test(r.out);
      const m = /（(\d+)\/(\d+)）/.exec(r.out);
      row('覆盖安装（服务在跑时覆盖）', ok, m ? `${m[1]}/${m[2]}` : (ok ? '全部通过' : '✗ 有失败'));
      if (!ok) console.log(r.out.split('\n').filter(l => l.includes('✗')).slice(0, 6).map(l => '        ' + l.trim()).join('\n'));
    }
  }

  // ---------- 汇总 ----------
  // 三类分开数。分开的意义：以前「通过 40，失败 0」这句话里混着 13 个
  // 从没执行过的项，看起来是无懈可击的绿，实际有一半功能区是暗的。
  const bad = rows.filter(r => !r.ok);
  const skippedRows = rows.filter(r => r.ok && r.skipped);
  const passed = rows.length - bad.length - skippedRows.length;
  console.log('');
  console.log('  ' + '═'.repeat(58));
  console.log(`    共 ${rows.length} 项：通过 ${passed}，失败 ${bad.length}，未执行 ${skippedRows.length}`);
  if (bad.length) {
    console.log('');
    bad.forEach(b => console.log(`      ✗ ${b.name}  ${b.detail}`));
  }
  if (skippedRows.length) {
    console.log('');
    console.log('    以下项没有跑，不算通过：');
    skippedRows.forEach(s => console.log(`      ⊘ ${s.name}  ${s.detail}`));
  }
  if (!bad.length && !skippedRows.length) console.log('    ✓ 全部通过（无跳过、无失败）');
  console.log('  ' + '═'.repeat(58));
  console.log('');
  // 关掉本次自己起的测试实例。不关的话端口会一直被占着，下次跑测试就"复用"
  // 这个老进程 —— 而它的数据目录、代码版本都可能是上一次的，排查时会把人绕死。
  // 只关自己起的那个：复用已有实例时 ownServerPid 是 0。
  if (ownServerPid) {
    try { process.kill(ownServerPid); console.log('  （已关闭本次启动的测试实例）') } catch { /* 已退出 */ }
  }
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('\n  ✗ 全量验证失败：' + e.message); process.exit(1) });
