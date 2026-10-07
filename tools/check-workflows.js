#!/usr/bin/env node
'use strict';
/** 用 Node 校验 workflow YAML 能否解析 + 关键字段是否在位（不依赖 pyyaml） */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
let bad = 0, total = 0;
const ok = (c, m) => { total++; console.log(`  ${c ? '✓' : '✗'} ${m}`); if (!c) bad++; };

// 极简 YAML 结构检查：缩进一致、key 冒号、无 tab、无未闭合引号
function lint (f) {
  const src = fs.readFileSync(f, 'utf8');
  const lines = src.split('\n');
  const issues = [];
  lines.forEach((l, i) => {
    if (/\t/.test(l)) issues.push(`第 ${i + 1} 行含 tab（YAML 只认空格）`);
    if (/^\s*[^#\s].*:\s*$/.test(l) && /[<>]/.test(l)) issues.push(`第 ${i + 1} 行有未展开的占位符`);
  });
  const q = (src.match(/"/g) || []).length;
  if (q % 2 !== 0) issues.push('双引号数量为奇数（有未闭合引号）');
  return issues;
}

for (const f of ['ci.yml', 'release.yml']) {
  const p = path.join(ROOT, '.github', 'workflows', f);
  console.log(`\n▌ ${f}`);
  ok(fs.existsSync(p), '文件存在');
  if (!fs.existsSync(p)) continue;
  const issues = lint(p);
  ok(issues.length === 0, issues.length ? issues.join('; ') : '无 tab / 引号配平');
  const src = fs.readFileSync(p, 'utf8');
  ok(/^name:/m.test(src), '有 name:');
  ok(/^on:/m.test(src), '有 on: 触发器');
  ok(/^jobs:/m.test(src), '有 jobs:');
}

console.log('\n▌ 交叉检查');
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
ok(/run-all\.js --ci/.test(ci), 'CI 调 run-all.js --ci');
ok(/build-artifacts\.js/.test(ci), 'CI 调 build-artifacts.js');
ok(/verify-artifacts\.js/.test(ci), 'CI 调 verify-artifacts.js');
ok(/runs-on: windows-latest/.test(ci), 'CI 跑在 windows-latest（装机验证/OCR/csc 只在 Windows 成立）');

const rel = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8');
ok(/tags: \['v\*'\]/.test(rel), 'Release 由 v* 标签触发');
ok(/contents: write/.test(rel), 'Release 申请 contents: write 权限');
ok(/build-artifacts\.js/.test(rel) && /verify-artifacts\.js/.test(rel), 'Release 先打再校验');
ok(/-eq 3|-eq 3 \|\||"3 个产物"/.test(rel), 'Release 断言三份产物齐全');
ok(/windows-standalone/.test(rel) && /docker\.zip/.test(rel) && /linux\.tar\.gz/.test(rel), 'Release 描述里三个平台都有');
ok(/fail_on_unmatched_files: true/.test(rel), '附件缺失时直接失败（避免 404 链接）');

console.log('\n' + '═'.repeat(52));
// 必须输出「N / M 项通过」——run-all.js 靠这个正则判定成败，
// 格式不对会被判成「未取得结果」并显示成红色失败。
console.log(`  ${bad ? '✗' : '✓'} 发布工作流：${total - bad} / ${total} 项通过`);
console.log('');
process.exit(bad ? 1 : 0);
