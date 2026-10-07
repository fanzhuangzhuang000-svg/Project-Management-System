'use strict';
/**
 * 回归测试：ocrHealth 被当成「结果对象」使用。
 *
 * 起因（真实 bug）：server.js 里
 *     const { health: ocrHealth } = require('./tools/ocr.js');
 * 拿到的是**函数**。但代码写的是 ocrHealth.ok / .label / .hint ——
 * 属性访问函数返回 undefined，于是：
 *   · 启动横幅的「⚠ 识别功能不可用」**永远**打印（!undefined 恒为真）
 *   · /api/meta 的 ocr.ok 恒为 undefined，前端据此判定扫描识别不可用
 *
 * 而实际 tesseract 装得好好的，探测结果一直 ok:true —— 纯显示层错误，
 * 查起来极其误导（我为此绕了一大圈，怀疑过沙箱、PATH、用户身份，全是错方向）。
 *
 * 本测试不依赖 tesseract 装没装：只检查「代码有没有把它当对象用」。
 * 这个错一旦再犯，undefined 会静默通过，所以必须用 AST 之外的硬断言兜住。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok (cond, name, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail ? '  → ' + detail : '')); }
}

// 取出 src 中所有形如 `ocrHealth.属性` 的使用点。
// 必须先剥掉注释 —— 修复说明里会故意写出 `ocrHealth.ok` 这个反例，
// 直接扫全文会把自己的注释当成残留，让测试永远红。
const codeOnly = SRC
  .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
  .replace(/^[ \t]*\/\/.*$/gm, '');   // 行注释

const propUses = [...codeOnly.matchAll(/\bocrHealth\s*\.\s*([A-Za-z_$][\w$]*)/g)]
  .map(m => m[1]);

ok(propUses.length === 0,
  'server.js 不再有任何 ocrHealth.属性 的属性访问',
  '仍存在: ' + [...new Set(propUses)].join(', '));

// 确认解构出来的确实是函数
const importLine = codeOnly.match(/const\s*\{[^}]*\bhealth\s*:\s*ocrHealth\b[^}]*\}\s*=\s*require\([^)]*ocr\.js[^)]*\)/);
ok(!!importLine, 'ocrHealth 来自 ocr.js 的 health 导出（是个函数）');

// 确认两处使用点都调用了它
const callCount = (codeOnly.match(/\bocrHealth\s*\(\s*\)/g) || []).length;
ok(callCount >= 2,
  'ocrHealth 至少被调用两次（/api/meta 与启动横幅）',
  '实际调用次数: ' + callCount);

// 堵住另一种等价写法：先赋值再当对象用。
//   const h = ocrHealth;  ...  h.ok     ← 同样把函数当对象，属性全 undefined
// 直接扫 `ocrHealth.x` 抓不到这种形态（上一版就漏了，是临时改回旧代码时实测发现的）。
// 注意要匹配「= 右边就是 ocrHealth 且不是调用」——写成 `ocrHealth=` 会漏掉
// `const h = ocrHealth;` 这种分号结尾的裸赋值。
const assignNoCall = [...codeOnly.matchAll(/=\s*ocrHealth\s*(?![(=])/g)];
ok(assignNoCall.length === 0,
  '没有把 ocrHealth 裸赋给变量（必须是调用结果才可读属性）',
  '发现 ' + assignNoCall.length + ' 处裸赋值');

// 真正的探测结果必须是对象
const ocrMod = require(path.join(ROOT, 'tools', 'ocr.js'));
const h = ocrMod.health();
ok(h && typeof h === 'object' && typeof h.ok === 'boolean',
  'ocr.js 的 health() 返回带布尔 ok 的对象',
  '实际返回: ' + JSON.stringify(h));

console.log('\n  ocr-health-usage: ' + pass + ' 通过, ' + fail + ' 失败');
// run-all.js 用这个正则判定套件结果：/(\d+)\s*\/\s*(\d+) 项通过/
// 格式必须一致，否则明明全过也会被判成「未取得结果」（我第一版就踩了这个坑）。
console.log(`  ${pass} / ${pass + fail} 项通过`);
process.exit(fail ? 1 : 0);
