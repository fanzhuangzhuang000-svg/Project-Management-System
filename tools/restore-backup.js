'use strict';
/**
 * 从备份还原： node tools/restore-backup.js [备份文件名]
 *
 * 不传文件名就用最新一份。
 *
 * ── 为什么单独做成命令行工具，不做界面按钮 ──
 * 还原要覆盖正在被服务的那个数据库文件。服务在跑的时候还原，等于
 * 让同一份数据同时被两个进程写 —— SQLite 下会锁死，PG 下会写坏。
 * 唯一安全的做法是：**先停服务，再还原，再起服务**。
 * 这个顺序没法在「服务正在运行」的过程中完成，所以只能做成命令行工具，
 * 由部署脚本（systemd / 部署说明）来串。
 *
 * ── 各种备份格式怎么还原 ──
 *   .db   SQLite VACUUM INTO 原生副本 → 直接拷回 data 目录
 *   .fc/.db (pg_dump -Fc)              → pg_restore --clean --if-exists
 *   .json 逐表 JSON（无结构兜底）      → 需要手工导入，本工具只做校验和统计
 *   .tar.gz PGlite 数据目录快照        → 解压回 PGlite 数据目录
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

process.env.PMS_NO_AUTO_BACKUP = '1';   // 还原脚本自己会先给现有数据做保险

const dbf = require('../db.js');
const bk = require('../backup.js');

const arg = process.argv[2];
const list = bk.listBackups();

function die (msg, code = 1) {
  console.error('\n  ✗ ' + msg + '\n');
  process.exit(code);
}

if (!list.length) die('备份目录里一份备份都没有：' + bk.BACKUP_DIR);

const chosen = arg
  ? list.find(b => b.name === arg || b.name.endsWith(arg))
  : list[0];

if (!chosen) {
  die('找不到备份：' + arg + '\n  可用：\n' + list.slice(0, 10).map(b => '    ' + b.name).join('\n'));
}

const src = path.join(bk.BACKUP_DIR, chosen.name);
const size = (chosen.size / 1024).toFixed(1);
console.log('\n  即将从备份还原');
console.log('  文件：' + src);
console.log('  大小：' + size + ' KB');
console.log('  ⚠ 这会覆盖当前数据库。系统请先停止服务。');

// 还原前先给「当前」数据做一份保险：还原错了还能退回来
const safety = path.join(bk.BACKUP_DIR, `pms_${bk.stamp()}_before-restore.db`);
try {
  dbf.backupTo(safety);
  console.log('  已先把当前数据另存为 ' + path.basename(safety) + '（还原出问题可退回）');
} catch (e) {
  console.log('  ⚠ 当前数据另存失败（不影响还原）：' + e.message);
}

function which (bin) {
  const c = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(c, [bin], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status !== 0) return null;
  const first = String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  return first && fs.existsSync(first) ? first : null;
}

function kindOf (file) {
  if (file.endsWith('.json')) return 'json';
  if (file.endsWith('.tar.gz')) return 'pglite';
  // pg_dump -Fc 产出的是自定义格式，文件头是 PGDMP
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(5);
    fs.readSync(fd, buf, 0, 5, 0);
    fs.closeSync(fd);
    if (buf.toString('latin1') === 'PGDMP') return 'pgdump';
  } catch { /* 忽略 */ }
  return 'sqlite';
}

const kind = kindOf(src);

if (kind === 'sqlite') {
  if (dbf.dialect !== 'sqlite') {
    die('这是 SQLite 备份，但当前系统连的是 PostgreSQL。请在 SQLite 版本上还原。');
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(dbf.DB_FILE + suffix); } catch { /* 不存在就算了 */ }
  }
  fs.copyFileSync(src, dbf.DB_FILE);
  console.log('  ✓ 已还原到 ' + dbf.DB_FILE);
  console.log('    现在可以启动服务了。\n');
  process.exit(0);
}

if (kind === 'pgdump') {
  if (dbf.dialect !== 'postgres') {
    die('这是 PostgreSQL 备份，但当前系统连的是 SQLite。');
  }
  const pgRestore = which('pg_restore') || which('pg_restore.exe');
  if (!pgRestore) {
    die('系统里找不到 pg_restore。请先装 PostgreSQL 客户端（Ubuntu: apt install postgresql-client）。');
  }
  if (!dbf.DB_URL) {
    die('读不到数据库连接串（DB_URL 为空）。请在服务用的环境里执行本工具，别只跑裸 node。');
  }
  const args = ['--clean', '--if-exists', '-d', dbf.DB_URL, src];
  const r = spawnSync(pgRestore, args, { encoding: 'utf8', timeout: 60 * 60 * 1000, windowsHide: true });
  if (r.error) die('pg_restore 执行失败：' + r.error.message);
  if (r.status !== 0) {
    console.error(String(r.stderr || '').slice(-2000));
    die('pg_restore 退出码 ' + r.status);
  }
  console.log('  ✓ 已用 pg_restore 还原（含表结构、索引、约束）');
  console.log('    现在可以启动服务了。\n');
  process.exit(0);
}

if (kind === 'pglite') {
  const dir = String(dbf.DB_URL).replace(/^pglite:\/\//i, '');
  if (dbf.dialect !== 'postgres' || !/^pglite:/i.test(String(dbf.DB_URL))) {
    die('这是 PGlite 快照，当前系统不是 PGlite 模式。');
  }
  // 先把现有目录挪走而不是直接删：解压出问题还能换回来
  const aside = dir + '.before-restore-' + Date.now();
  try { fs.renameSync(dir, aside); } catch { /* 目录本来就不存在 */ }
  fs.mkdirSync(dir, { recursive: true });
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const r = spawnSync(tar, ['-xzf', src, '-C', dir], { encoding: 'utf8', timeout: 60 * 60 * 1000, windowsHide: true });
  if (r.error || r.status !== 0) {
    console.error(String(r.stderr || '').slice(-1000));
    try { fs.rmSync(dir, { recursive: true, force: true }); fs.renameSync(aside, dir); } catch { /* 忽略 */ }
    die('解压失败，已把原数据目录换回来了');
  }
  console.log('  ✓ 已还原 PGlite 数据目录：' + dir);
  console.log('    现在可以启动服务了。\n');
  process.exit(0);
}

// json 兜底：没有结构，不能自动还原。这里只做检查和事实说明，不做半吊子导入。
let j;
try { j = JSON.parse(fs.readFileSync(src, 'utf8')); } catch (e) { die('这份 JSON 读不出来：' + e.message); }
const tables = Object.keys(j.tables || {});
const rows = Object.values(j.tables || {}).reduce((a, r) => a + r.length, 0);
console.log('');
console.log('  这份是「只有数据、没有结构」的 JSON 兜底备份，不能一键还原。');
console.log('  内容：' + tables.length + ' 张表 / ' + rows + ' 行');
console.log('');
console.log('  为什么会这样：备份时系统里找不到 pg_dump 工具。');
console.log('  怎么办（二选一）：');
console.log('    1) 装上 PostgreSQL 客户端后重新备份一次，之后就能一键还原：');
console.log('       Ubuntu  sudo apt install postgresql-client');
console.log('    2) 用这份 JSON 手工导入（导出为 CSV 再用系统的「数据导入」功能）：');
for (const t of tables) console.log('         ' + t + '  ' + j.tables[t].length + ' 行');
console.log('');