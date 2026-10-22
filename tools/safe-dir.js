/**
 * 删除目录的唯一入口 —— 默认拒绝，而不是默认允许。
 *
 * ⚠️ 为什么要有这个文件（真实事故，别删）：
 *    2026-10 打包脚本把**仓库根目录**整个删掉了 —— package.json / server.js /
 *    db.js / .git 全没了，工作区只剩一个 trash.js，只能重新 clone 恢复，
 *    当时未提交的改动全部丢失。
 *    事后按代码逐行核对，所有 rmSync 的入参看起来都在 dist-artifacts 之下，
 *    **没能复现出是哪条路径拼成了空串/根目录**。既然查不出，就不能靠"小心一点"，
 *    改成结构性防护：调用方必须显式声明"我允许删哪个目录之内"，越界直接抛错。
 *    任何将来的重构、任何 env 拼错（PMS_ARTIFACT_OUT='' 之类），都只可能
 *    让打包失败，不可能再删掉源码。
 *
 * 用法：
 *   safeRm(path.join(OUT, 'stage'), [OUT])            // 删 OUT 的子目录
 *   safeRm(OUT, [OUT], { self: true })                 // 删 OUT 本身（清理产物目录）
 *   safeRm(ROOT, [OUT])                                // ✗ 抛错 —— 这不是"产物"
 */

const fs = require('node:fs');
const path = require('node:path');

/** Windows 路径大小写不敏感，比较前统一小写，避免 c:\ vs C:\ 判错 */
const norm = p => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();

/* 无论如何都不许删的位置：盘根、仓库根、用户目录、临时目录根。
   这些判断不依赖调用方传的 roots —— 就算有人写成 safeRm(ROOT, [ROOT], {self:true})，
   也过不去。 */
function assertNotLandmark (abs) {
  const n = norm(abs);
  const landmarks = [
    path.parse(abs).root,               // C:\
    path.join(__dirname, '..'),         // 仓库根
    process.env.USERPROFILE || '',
    process.env.HOME || '',
    require('node:os').tmpdir(),
  ].filter(Boolean).map(norm);
  if (landmarks.includes(n)) {
    throw new Error(`拒绝删除 ${abs}：这是受保护的位置（盘根/仓库根/用户目录/临时目录）`);
  }
  // 路径深度兜底：c:\a、c:\a\b 这种浅路径一律不删 —— 正常产物目录至少是
  // <仓库>/dist-artifacts/<包名> 这种深度，浅到两段只可能是变量拼错了。
  const depth = n.split(/[\\/]/).filter(Boolean).length;
  if (depth < 3) {
    throw new Error(`拒绝删除 ${abs}：路径太浅（${depth} 段），几乎肯定是变量拼错了`);
  }
}

/**
 * @param {string} target 要删的路径
 * @param {string[]} roots 允许的边界（target 必须是其中之一或它们的子孙）
 * @param {{self?: boolean}} opts self=true 时允许 target 等于某个 root
 */
function safeRm (target, roots, opts) {
  if (!target || typeof target !== 'string') {
    throw new Error('拒绝删除：目标为空（变量拼成了空串）');
  }
  const abs = path.resolve(target);
  assertNotLandmark(abs);

  const list = (roots || []).filter(Boolean).map(r => path.resolve(r));
  if (!list.length) throw new Error('拒绝删除：没有声明允许范围');

  const n = norm(abs);
  for (const r of list) {
    const rn = norm(r);
    if (n === rn) {
      if (!opts || !opts.self) {
        throw new Error(`拒绝删除 ${abs}：它是允许范围的根，需要显式 self: true`);
      }
      fs.rmSync(abs, { recursive: true, force: true });
      return;
    }
    if (n.startsWith(rn + path.sep) || n.startsWith(rn + '/')) {
      fs.rmSync(abs, { recursive: true, force: true });
      return;
    }
  }
  throw new Error(`拒绝删除 ${abs}：不在允许范围内（${list.join(' , ')}）`);
}

// 导出 assertNotLandmark 只为测试：它会抛错但**不删任何东西**，
// 于是"仓库根/临时目录/盘根必须被拦"这三条可以在测试里安全地断言
// —— 换成直接调 safeRm 去试，万一防线失效就是一次真实的删库。
module.exports = { safeRm, assertNotLandmark };
