'use strict';
/**
 * 回归测试：对外报的版本号必须和 package.json 一致。
 *
 * 起因（真实缺陷）：server.js 里原来写死 `const VERSION = '1.0.0'`，
 * 于是 1.0.1 / 1.0.2 的安装包启动横幅、/api/health、/api/meta 全都报
 * v1.0.0。客户报障时问「你装的是哪一版」，两边看到的版本号对不上，
 * 只能靠翻文件时间猜。这个坑很隐蔽 —— 版本号只影响显示，不影响功能，
 * 所以功能测试全绿也发现不了。
 *
 * 本套件做两件事：
 *   ① 断言 server.js 的兜底版本号 === package.json 的 version（防再次漂移）；
 *   ② 把 detectVersion() 的**源码原文**抽出来、换掉 fs 跑一遍，
 *      验证「读得到 package.json 就用它 / 读不到或内容坏掉才用兜底」。
 *      只断言字面量相等是不够的：分支写反了照样能蒙对。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
// 去掉 BOM 再解析：编辑器「另存为 UTF-8」很容易加上 BOM，JSON.parse 会直接抛错。
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8').replace(/^\uFEFF/, '')).version;
const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function ok (cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

// ── 1. package.json 自身形态 ──
ok(/^\d+\.\d+\.\d+/.test(pkgVersion), 'package.json 的 version 是 x.y.z 形态', pkgVersion);

// ── 2. server.js 的兜底版本号必须跟上 ──
const mFallback = /const VERSION_FALLBACK = '([^']+)'/.exec(src);
ok(!!mFallback, 'server.js 里有 VERSION_FALLBACK 常量');
ok(!!mFallback && mFallback[1] === pkgVersion,
  'VERSION_FALLBACK 与 package.json 的 version 一致（发版必须一起改）',
  mFallback ? `server.js=${mFallback[1]}  package.json=${pkgVersion}` : '没找到 VERSION_FALLBACK');

// ── 3. 不允许退回「写死 VERSION」的老写法 ──
const hardcoded = /const VERSION = ['"]/.exec(src);
ok(!hardcoded, 'VERSION 不再直接写死字符串（必须经 detectVersion 解析）',
  hardcoded ? hardcoded[0] + '…' : '');
ok(/const VERSION = detectVersion\(\)/.test(src), 'VERSION 由 detectVersion() 得出');

// ── 4. 抽出真正的 detectVersion 源码跑，验证各分支 ──
const fnSrc = /function detectVersion \(\) \{[\s\S]*?\n\}/.exec(src);
ok(!!fnSrc, '能从 server.js 抽到 detectVersion 源码');

// 把源码包成「工厂」：先绑好替身 fs / path，再调用工厂拿到的才是 detectVersion 本身。
// 注意不能把工厂直接当 detectVersion 调用 —— 那样返回的是这个函数对象，
// 断言 `=== '9.9.9'` 永远为假却又能「看起来在跑」，等于白测。
let makeDetect = null;
if (fnSrc) {
  try {
    makeDetect = new Function('fs', 'path', '__dirname', 'VERSION_FALLBACK',
      'return (' + fnSrc[0] + ')');
  } catch { /* 下面的断言会如实失败 */ }
}
ok(typeof makeDetect === 'function', 'detectVersion 源码可执行（否则无法验证分支）');

if (typeof makeDetect === 'function') {
  /** 用给定的 readFileSync 替身和兜底值，真跑一遍 server.js 里那份 detectVersion */
  const run = (readFileSync, fallback) => makeDetect({ readFileSync }, path, '/app', fallback)();

  const fromPkg = run(() => JSON.stringify({ version: '9.9.9' }), '1.2.3');
  ok(fromPkg === '9.9.9', '读得到 package.json 时用包里的版本（不是兜底值）', String(fromPkg));

  const fromFallback = run(() => { throw new Error('ENOENT'); }, '1.2.3');
  ok(fromFallback === '1.2.3', '读不到 package.json 时回落到 VERSION_FALLBACK', String(fromFallback));

  const fromBroken = run(() => '{ 这不是 JSON', '1.2.3');
  ok(fromBroken === '1.2.3', 'package.json 内容坏掉也不抛异常，回落兜底', String(fromBroken));

  // 带 BOM 的 package.json：JSON.parse 会抛错，若不显式去掉 BOM 就会静默回落兜底，
  // 表现为「版本号又对不上了，而且看不出原因」—— 写本套件时就踩到了这个。
  const fromBom = run(() => '\uFEFF' + JSON.stringify({ version: '7.7.7' }), '1.2.3');
  ok(fromBom === '7.7.7', 'package.json 带 BOM 时仍读出真实版本（不静默回落）', String(fromBom));
}

// ── 5. 对外出口仍引用 VERSION，没有另写死一个版本号 ──
const versionRefs = (src.match(/version:\s*VERSION\b/g) || []).length;
ok(versionRefs >= 2, '启动横幅与 HTTP 响应都引用 VERSION 常量', '实际 ' + versionRefs + ' 处');
ok(!/version:\s*['"]\d+\.\d+\.\d+/.test(src), '没有另外写死的版本号字面量');

// ── 6. 交付包里的 docker .env.example 也要跟上 ──
// Docker 包把这个文件原样打进去，客户复制成 .env 后 compose 就拿它当镜像标签。
// 它写 1.0.0 而实际发的是 1.0.3，客户截图问「装的是哪版」又是一笔糊涂账。
const envExample = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const mEnvVer = /^VERSION=(.+)$/m.exec(envExample);
ok(!!mEnvVer, '.env.example 里有 VERSION 配置项');
ok(!!mEnvVer && mEnvVer[1].trim() === pkgVersion,
  '.env.example 的 VERSION 与 package.json 一致（Docker 包原样交付）',
  mEnvVer ? `.env.example=${mEnvVer[1].trim()}  package.json=${pkgVersion}` : '没找到 VERSION');

console.log('\n  version-consistency: ' + pass + ' 通过, ' + fail + ' 失败');
// run-all.js 用这个正则判定套件结果：/(\d+)\s*\/\s*(\d+) 项通过/
// 格式必须一致，否则明明全过也会被判成「未取得结果」。
console.log(`  ${pass} / ${pass + fail} 项通过`);
process.exit(fail ? 1 : 0);
