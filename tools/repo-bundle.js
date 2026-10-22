'use strict';
/**
 * 给仓库打一份「离线快照」（git bundle），放在仓库**外面**。
 *
 * 用法： node tools/repo-bundle.js [输出目录]
 *
 * ⚠️ 为什么需要这个（两次真实事故，别删）：
 *   1) 2026-10 打包脚本把仓库根目录整个删了 —— package.json / server.js /
 *      db.js / .git 全没了，只能重新 clone 再手工补回丢掉的那几处改动。
 *   2) 2026-10 又一次：`git stash push server.js` 半途失败，.git 里 HEAD、config、
 *      refs/heads 全丢，工作区里所有已跟踪文件（除 server.js）被删，
 *      node_modules 下每个包的 package.json 也一起没了。
 *      这次是靠 clone + 替换 .git + npm install 才救回来的。
 *
 * 两次的共同点：**本机磁盘上的副本是唯一副本**，出问题时既没有第二份代码，
 * 也没有能证明"我改了什么"的东西（未提交的改动只在内存里）。
 * 所以：跑任何会大面积动文件的操作之前，先打一份 bundle。
 *
 * bundle 是 git 自己的单文件格式，`git clone xxx.bundle` 就能完整还原
 * 所有分支和提交历史 —— 不需要网络，也不依赖 GitHub 还在不在。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const KEEP = 5;

function main () {
  const outDir = process.argv[2] || path.join(ROOT, '..', 'pms-bundles');
  // 仓库自己能读才算数：在非仓库目录跑只会得到一句难懂的报错
  const probe = spawnSync('git', ['rev-parse', '--git-dir'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) return { ok: false, error: '当前目录不是 git 仓库（或 git 不在 PATH 里）' };

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const out = path.join(outDir, `pms-${stamp}.bundle`);

  const r = spawnSync('git', ['bundle', 'create', out, '--all'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) {
    return { ok: false, error: ((r.stderr || '') + (r.stdout || '')).trim().slice(0, 300) };
  }
  const size = fs.statSync(out).size;

  // 只留最近 KEEP 份：bundle 一份几百 KB，堆多了没意义还占地方
  const old = fs.readdirSync(outDir)
    .filter(f => /^pms-\d{8}-\d{6}\.bundle$/.test(f))
    .sort()
    .slice(0, -KEEP);
  for (const f of old) { try { fs.unlinkSync(path.join(outDir, f)); } catch { /* 忽略 */ } }

  return { ok: true, file: out, size, pruned: old.length };
}

if (require.main === module) {
  const r = main();
  if (r.ok) {
    console.log(`  ✓ 仓库快照：${r.file}（${(r.size / 1024).toFixed(0)} KB${r.pruned ? `，清了 ${r.pruned} 份旧的` : ''}）`);
    console.log('    还原方式： git clone <这个文件> 一个新目录');
  } else {
    // 打不出快照不该让流程失败（比如交付现场的机器上没装 git），但必须说出来
    console.log('  ⊘ 仓库快照没打成：' + r.error);
  }
  process.exit(0);
}

module.exports = { main };
