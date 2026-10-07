'use strict';
/**
 * 命令行备份： node tools/backup.js
 * （服务在运行时，更推荐用界面上的「立即备份」按钮或 备份数据.bat，走 HTTP 接口）
 */
const bk = require('../backup.js');

const r = bk.makeBackup();
if (!r.ok) {
  console.error('  备份失败：' + r.error);
  process.exit(1);
}
const kb = (r.size / 1024).toFixed(1);
console.log('');
console.log('  备份完成');
// 用 path.join 而不是写死反斜杠：反斜杠只在 Windows 上成立，
// Linux 上打出来是「backup\pms_xxx.db」，客户会以为文件找不到了。
console.log('  文件：' + require('node:path').join(bk.BACKUP_DIR, r.file));
console.log('  大小：' + kb + ' KB');
if (r.degraded) {
  console.log('');
  console.log('  ⚠ 警告：这次是降级备份 —— ' + (r.pgDumpError || '未找到 pg_dump'));
  console.log('    只有数据，没有表结构/索引/约束，装上 postgresql-client 后重新备份一次。');
}
if (r.restore) console.log('  还原：' + r.restore);
if (r.pruned && r.pruned.length) console.log('  已清理旧备份 ' + r.pruned.length + ' 份');
const last = bk.lastBackup();
if (last) console.log('  备份总数：' + bk.listBackups().length + ' 份');
if (r.remote && r.remote.mode !== 'off' && r.remote.ok) console.log('  已异地存放：' + r.remote.target);
else if (r.remote && !r.remote.ok) console.log('  ⚠ 异地存放失败（本地备份仍有效）：' + r.remote.error);
console.log('');
