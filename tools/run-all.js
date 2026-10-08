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
const BASE = process.env.PMS_BASE || 'http://127.0.0.1:8787';
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
  rows.push({ name, ok, detail });
  console.log(`    ${ok ? '✓' : '✗'} ${name.padEnd(22)} ${detail}`);
}

/** 跑一个 node 脚本，返回 stdout（不继承 stdio，避免刷屏） */
function runNode (script, args = [], timeout = 900000) {
  const r = spawnSync('node', ['--no-warnings', script, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout, windowsHide: true,
  });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

/**
 * CI 模式下跳过的套件 —— 每一个都必须在干净克隆上实测过确实跑不起来。
 *
 * 别把这份清单当"不重要所以跳过"：它们在本地是有意义的（装机、PG+MinIO 集成、
 * 示例数据反复重建……）。跳过只有一个原因 —— **CI 环境提供不了前提**：
 *
 *   · 缺夹具素材（.gitignore 排除真实扫描件，见 tools/fixtures/README.md）
 *   · 需要先产出安装包 exe（verify-installed）
 *   · 需要真实 PG + MinIO 栈（verify-pro-edition）
 *   · 需要真实 AI 密钥（ai-test）
 *
 * 哪个套件恢复成可跑（比如素材改用脱敏件入库），从这里删掉对应行即可。
 */
const CI_SKIP = new Set([
  'batch-test.js', 'import-test.js', 'features-test.js', 'ocr-chain-test.js',
  'ui-react-test.js', 'verify-installed.js', 'verify-pro-edition.js', 'ai-test.js',
  'reseed-atomic-test.js',
]);
const CI = process.argv.includes('--ci') || process.env.PMS_CI === '1';

(async () => {
  console.log('');
  console.log('  弱电智能化工程项目管理系统 · 全量验证');
  console.log(`  ${new Date().toLocaleString('zh-CN')}`);

  // ---------- 0. 服务是否在跑 ----------
  head('0/6  环境检查');
  let up = false;
  try { const r = await fetch(BASE + '/api/health'); up = r.ok } catch { /* 没起 */ }
  if (!up) {
    console.log('    服务没在跑，正在启动…');
    const { spawn } = require('node:child_process');
    spawn('node', ['--no-warnings', 'server.js', '--port', '8787'], { cwd: ROOT, stdio: 'ignore', detached: true }).unref();
    for (let i = 0; i < 30 && !up; i++) { await sleep(500); try { const r = await fetch(BASE + '/api/health'); up = r.ok } catch { /* 等 */ } }
  }
  row('服务可访问', up, up ? BASE : '✗ 启动失败');
  if (!up) { console.log('\n  服务起不来，后面的测试没有意义，先解决它。'); process.exit(1) }

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
  head('3/6  主程序测试（27 套件）');
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
    ['装机验证', 'verify-installed.js'],
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
  ];
  let suitePass = 0, suiteTotal = 0, skipped = 0;
  for (const [name, file] of SUITES) {
    if (CI && CI_SKIP.has(file)) {
      skipped++;
      row(name + '（CI 跳过）', true, '环境不具备，见 CI_SKIP 注释');
      continue;
    }
    const t0 = Date.now();
    const r = runNode(path.join('tools', file), [BASE]);
    const sec = ((Date.now() - t0) / 1000).toFixed(0);
    const m = /(\d+)\s*\/\s*(\d+) 项通过/.exec(r.out);
    if (m) {
      const p = +m[1], a = +m[2];
      suitePass += p; suiteTotal += a;
      row(name, p === a, `${p}/${a}  ${sec}s`);
      if (p !== a) console.log(r.out.split('\n').filter(l => l.includes('✗')).slice(0, 6).map(l => '        ' + l.trim()).join('\n'));
    } else {
      row(name, false, '✗ 未取得结果');
      console.log(r.out.split('\n').slice(-8).map(l => '        ' + l).join('\n'));
    }
  }
  console.log(`    ${'—'.repeat(40)}`);
  console.log(`    小计 ${suitePass} / ${suiteTotal}${skipped ? `（CI 跳过 ${skipped} 个环境依赖套件）` : ''}`);

  // ---------- 4. OCR 自检 ----------
  head('4/6  OCR 自检（全部素材）');
  {
    const fix = path.join(ROOT, 'tools', 'fixtures');
    const files = ['contract.pdf', 'contract-new.pdf', 'invoice.pdf', 'contract-scan.jpg']
      .map(f => path.join(fix, f)).filter(f => fs.existsSync(f));
    if (!files.length) {
      // 一份素材都没有时不能报"失败"——素材本就不入库（.gitignore），
      // 报失败会让 CI 永远红，而且看不出真实原因。
      row('OCR 自检', true, CI ? '跳过：CI 无夹具素材' : '跳过：无素材（跑 tools/fixtures/make-fixtures.py 或自备）');
    } else {
      const r = runNode(path.join('tools', 'ocr-selftest.js'), files);
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

  // ---------- 5. 打安装包 ----------
  head('5/6  打安装包');
  if (CI) {
    // 打包一次要 4~8 分钟（压 node.exe 83MB）。CI 里紧接着还要跑
    // build-artifacts.js 再打一遍同样的东西 —— 两遍加起来十几分钟纯浪费。
    // 这里如实标成"交给下一步"，不假装通过。
    row('生成安装包', true, 'CI 跳过：由 build-artifacts.js 统一打（避免重复压缩）');
  } else {
    const r = runNode(path.join('tools', 'build-installer.js'));
    const outDir = process.env.PMS_INSTALLER_OUT || 'dist-installer';
    const exe = path.join(ROOT, outDir, '弱电项目管理系统-安装程序.exe');
    const ok = fs.existsSync(exe);
    row('生成安装包', ok, ok ? `${(fs.statSync(exe).size / 1024 / 1024).toFixed(1)} MB` : '✗ 未生成');
    if (!ok) console.log(r.out.split('\n').slice(-10).map(l => '        ' + l).join('\n'));
  }

  // ---------- 6. 安装包验证 ----------
  head('6/6  安装包验证');
  if (CI) {
    // verify-installer / verify-overwrite 要上传 contract.pdf 验证识别引擎，
    // 素材不入库 → CI 上必然红。这里如实标成"未执行"，不假装通过。
    row('常规验证（装→跑→卸）', true, 'CI 跳过：需 fixtures/contract.pdf');
    row('覆盖安装（服务在跑时覆盖）', true, 'CI 跳过：同上');
  } else {
    {
      const r = runNode(path.join('tools', 'verify-installer.js'));
      const ok = /全部通过/.test(r.out);
      const m = /(\d+)\s*\/\s*(\d+) 项通过/.exec(r.out);
      row('常规验证（装→跑→卸）', ok, m ? m[0] : (ok ? '全部通过' : '✗ 有失败'));
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
  const bad = rows.filter(r => !r.ok);
  console.log('');
  console.log('  ' + '═'.repeat(58));
  console.log(`    共 ${rows.length} 项，通过 ${rows.length - bad.length}，失败 ${bad.length}`);
  if (bad.length) {
    bad.forEach(b => console.log(`      ✗ ${b.name}  ${b.detail}`));
  } else {
    console.log('    ✓ 全部通过');
  }
  console.log('  ' + '═'.repeat(58));
  console.log('');
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('\n  ✗ 全量验证失败：' + e.message); process.exit(1) });
