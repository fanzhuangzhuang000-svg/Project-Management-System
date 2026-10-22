'use strict';
/**
 * 日常维护：那些「每天该做一次」的杂事。
 *
 * 为什么单独抽出来（2026-10）：
 *   这些事原来全写死在 server.js 的启动流程里 —— 只有**进程启动**那一刻会跑。
 *   单机版的典型用法是装完就一直开着（关掉浏览器不等于关服务），
 *   于是一台连续开一个月的机器上：
 *     · 回收站永远不清理，「保留 30 天」形同虚设，附件文件跟着一起堆着
 *     · 自动备份只在装完那天做过一份，之后再也没有第二份 —— 真出事只能回到一个月前
 *     · 超过 7 天没人认领的暂存附件一直躺在磁盘里
 *     · 月度快照缺月，趋势图断档
 *   现在同一份逻辑既在启动时跑，也由 server.js 每小时跑一次；
 *   每一步都自带幂等判断（今天备份过就不再备、只删超过 N 天的），重复跑没有副作用。
 *
 * 抽成模块的另一个好处：测试可以直接调 runDaily()，不用等一小时定时器。
 */
const bk = require('./backup.js');
const trash = require('./trash.js');
const attach = require('./attachments.js');
const auth = require('./auth.js');
const snap = require('./snapshots.js');

/**
 * 跑一次日常维护。
 * 任何一步失败都不影响其它步骤 —— 备份失败不该连带把回收站清理也停掉。
 * @returns {{backup:object|null, trash:object, orphans:number, snap:number, errors:string[]}}
 */
function runDaily () {
  const errors = [];

  // 1) 过期会话：登录态本身有 30 天期限，过期的行不清就会越积越多
  try { auth.purgeExpired(); } catch (e) { errors.push('过期会话：' + e.message); }

  // 2) 没人认领的暂存附件（上传后没保存表单），超过 7 天清掉。
  //    注意 detached=1（用户主动选「保留附件」）的不算，purgeOrphans 内部已排除。
  let orphans = 0;
  try { orphans = attach.purgeOrphans(7); } catch (e) { errors.push('暂存附件：' + e.message); }

  // 3) 回收站超过保留期（30 天）的条目彻底删除 —— 连同当时保留的附件文件
  let trashResult = { purged: 0, removedFiles: 0 };
  try { trashResult = trash.autoPurge(trash.KEEP_DAYS); } catch (e) { errors.push('回收站清理：' + e.message); }

  // 4) 上个月没记快照的话补一份（用于看趋势）
  let snapMade = 0;
  try { snapMade = snap.ensureMonthly(); } catch (e) { errors.push('月度快照：' + e.message); }

  // 5) 今天还没备份就备一份。hasBackupToday() 按文件名里的日期判断，
  //    所以同一天跑很多次也只会有一份。
  let backup = null;
  try {
    if (!bk.hasBackupToday()) backup = bk.makeBackup('auto');
  } catch (e) { errors.push('自动备份：' + e.message); }

  return { backup, trash: trashResult, orphans, snap: snapMade, errors };
}

module.exports = { runDaily };
