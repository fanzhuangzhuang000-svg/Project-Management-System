'use strict';
/**
 * 静态检查：模块引用的名字必须真的存在
 *
 * 用法： node tools/module-ref-test.js
 *
 * 为什么需要这个套件：
 *   server.js 的 `sweepLogs()` 里写着 `logs.purge(days)`，而顶部导入的名字是
 *   `logmod`。`logs` 从来没定义过 —— 这行每次执行都抛 ReferenceError，
 *   被外层的 catch 吞掉，只在控制台留一句"清理失败"。
 *   结果：「日志保留天数」这个设置**从上线起就没生效过**，日志表只会无限涨。
 *
 *   这类 bug 有三个可怕之处：
 *     1) 不报错（有 catch）；
 *     2) 不影响主流程（定时任务，没人看）；
 *     3) 单元测试和接口测试都碰不到（它不是任何一个请求路径）。
 *   换句话说，任何"跑一遍看看"的手段都发现不了它。只能靠静态检查。
 *
 * 检查方式：
 *   把「业务模块方法」的调用点全部找出来（attach.get / trash.purge / logmod.list…），
 *   要求被调用的那个前缀名在本文件里**至少出现过一次定义**（require / const / 函数 / 参数）。
 *   故意把"定义"的判定放得很宽：宁可漏报，也不要有一次误报 ——
 *   一个会误报的检查，人看两次就会开始无视它。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

/**
 * 只检查这些方法名。
 *
 * 为什么不检查所有 `X.y(`：`res.json`、`map.get`、`req.headers` 这类遍地都是，
 * 一旦把它们也算进来，误报会淹没真正的问题。
 * 这份清单是「只有本项目业务模块才会用的方法名」，覆盖面够，噪音小。
 * 新增模块导出方法时顺手加进来，就能被自动看住。
 */
const BIZ_METHODS = [
  'purge', 'purgeAll', 'reseedDemo', 'clearDemo', 'linkIds', 'linkByToken',
  'diffFields', 'decorateAttachment', 'countForProject', 'listBackups',
  'importMeta', 'buildTemplate', 'readTable', 'projectStatsMany',
];

/** 收集一个文件里所有"看起来被定义过"的标识符（判定宽松，宁漏勿误） */
function definedNames (src) {
  const names = new Set();
  const add = (n) => { if (n) names.add(n) };
  // const a = require(...) / const { a, b } = require(...)
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}\s*=/g)) {
    m[1].split(',').forEach(p => add(p.split(':').pop().trim()));
  }
  // function foo (...)
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 函数/箭头函数参数 (a, b, c) => / function (a, b)
  for (const m of src.matchAll(/(?:\(([^()]*)\)\s*=>|function\s*[A-Za-z_$\w]*\s*\(([^()]*)\))/g)) {
    const inner = m[1] || m[2] || '';
    inner.split(',').forEach(p => add(p.replace(/[={}[\].]/g, ' ').trim().split(/\s+/).pop()));
  }
  // catch (e) / for (const x of ...)
  for (const m of src.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  return names;
}

/** 把注释替换成等长空白（保留行号），避免把注释里提到的旧写法当成真调用 */
function stripComments (src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length));
}

/**
 * 扫描一个文件，返回「用了但没定义」的调用点。
 * 被判定为定义过的名字不在其中 —— 哪怕它只是个同名局部变量，也放行。
 */
function scanFile (file) {
  const src = stripComments(fs.readFileSync(file, 'utf8'));
  const defined = definedNames(src);
  const bad = [];
  const re = new RegExp(`(^|[^.\\w$])([A-Za-z_$][\\w$]*)\\.(${BIZ_METHODS.join('|')})\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src)) !== null) {
    const name = m[2];
    if (!defined.has(name)) {
      const line = src.slice(0, m.index).split('\n').length;
      bad.push({ name, method: m[3], line });
    }
  }
  return bad;
}

const TARGETS = fs.readdirSync(ROOT).filter(f => f.endsWith('.js'));
let total = 0;
for (const f of TARGETS) {
  const file = path.join(ROOT, f);
  if (fs.statSync(file).size > 2 * 1024 * 1024) continue;   // 跳过打包产物
  const bad = scanFile(file);
  total += bad.length;
  const uniq = [...new Map(bad.map(b => [`${b.name}.${b.method}`, b])).values()];
  check(`${f} 的模块调用都有定义`, bad.length === 0,
    bad.length ? uniq.map(b => `${b.name}.${b.method}() 第 ${b.line} 行`).join('、') : '');
}

console.log(`\n  ${results.filter(r => r.ok).length} / ${results.length} 项通过`);
process.exit(results.every(r => r.ok) ? 0 : 1);
