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

const arg = process.argv.find(a => !a.startsWith('-') && a !== process.argv[0] && a !== process.argv[1]);
const force = process.argv.includes('--force');
const list = bk.listBackups();

function die (msg, code = 1) {
  console.error('\n  ✗ ' + msg + '\n');
  process.exit(code);
}

/**
 * 有没有**别的进程**正占着这个库？
 *
 * ⚠️ 这不是"多此一举的客气提醒"，是真的踩过：
 *    原来这里只打印一句「系统请先停止服务」，然后直接把文件删掉、拷过去。
 *    实测（服务刚被 kill、句柄还没释放时立刻还原）：
 *      · pms.db 删掉又拷了回去 —— 看起来成功了，还打印了 ✓
 *      · 但 pms.db-wal 删不掉（还被占着），那份 WAL 里装的是**还原前**的新数据
 *      · 服务一起来就把 WAL 回放进去 —— 用户看到"还原成功"，数据却回到还原前
 *    更糟的是：服务在跑时替换库文件，等于两个进程同时写一份数据。
 *
 * 三重判据，任一命中就算"有人在用"：
 *   ① 本系统的 HTTP 还活着，而且它读的正是这个库（比对 dbId，不比端口号猜）
 *      —— 端口按常见顺序试：PMS_PORT / 8787 / 8899 / 8790
 *   ② 文件改不了名 —— Windows 上只要还有进程开着它，rename 就 EBUSY。
 *      （Linux 的 rename 对已打开的文件也成功，所以这条只对 Windows 有效，
 *        单机版就是 Windows；Linux 那边靠 ① 和 ③）
 *   ③ SQLite 拿不到排他锁 —— WAL 模式下其它连接空闲时也能拿到，
 *      所以它只能作为补充；真正兜底的是"删不掉就别继续"（见下面的 failed 分支）。
 *
 * 必须整体放进**子进程**：本进程 require('db.js') 已经开着这个库，
 * 自己跟自己抢锁/改名永远是失败。
 */
function dbBusyState (file) {
  if (!fs.existsSync(file)) return 'free';       // 还没有库，第一次还原，无需判断
  const probe = `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const { DatabaseSync } = require('node:sqlite');
    const file = process.argv[1];
    const hash = s => crypto.createHash('sha1')
      .update(require('node:path').resolve(String(s || '')).replace(/\\\\/g, '/').toLowerCase())
      .digest('hex').slice(0, 12);
    const wantId = hash(file);
    process.stdout.write('');   // 占位，避免 stdout 为空时被当成失败
    (async () => {
      const ports = [process.env.PMS_PORT, 8787, 8899, 8790].filter(Boolean);
      for (const p of ports) {
        try {
          const ctl = AbortSignal.timeout ? AbortSignal.timeout(600) : undefined;
          const r = await fetch('http://127.0.0.1:' + p + '/api/health', { signal: ctl });
          const j = await r.json();
          if (j && j.dbId === wantId) { process.stdout.write('busy:服务正在 ' + p + ' 端口上跑着'); return; }
        } catch { /* 这个端口没有 */ }
      }
      // Windows：还有进程开着它，改名就会 EBUSY
      const tmp = file + '.lockprobe';
      try { fs.renameSync(file, tmp); fs.renameSync(tmp, file); }
      catch (e) { process.stdout.write('busy:文件被占用（' + (e.code || e.message) + '）'); return; }
      // SQLite 排他锁
      try {
        const d = new DatabaseSync(file);
        d.exec('PRAGMA busy_timeout = 400;');
        d.exec('BEGIN EXCLUSIVE'); d.exec('ROLLBACK'); d.close();
      } catch (e) {
        if (/locked|busy/i.test(String(e.message))) { process.stdout.write('busy:数据库写锁被别人拿着'); return; }
      }
      process.stdout.write('free');
    })();
  `;
  const r = spawnSync(process.execPath, ['--no-warnings', '-e', probe, file],
    { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const out = String(r.stdout || '').trim();
  return out || ('err:' + String(r.stderr || '探测失败').trim().slice(0, 160));
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

/**
 * 关掉本进程自己的数据库连接 —— 这一步不能省。
 *
 * require('../db.js') 一加载就开了一个连接（上面做安全备份也用它）。
 * Windows 上只要还有句柄开着这个文件，**改名和删除都会 EBUSY**：
 *   · 不关的话，占用探测会把自己当成"别的进程在用"，永远拒绝还原；
 *   · 更早的版本更糟：unlink 失败被空 catch 吞掉，文件没删掉就往下走，
 *     旧的 -wal 留着，服务一起来就把还原前的数据回放回来。
 */
try { dbf.closeDb(); } catch { /* 没有连接也无所谓 */ }

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
  // 动手之前先确认没人占着这个库（详见 dbBusyState 的注释）
  const busy = dbBusyState(dbf.DB_FILE);
  if (busy.startsWith('busy') && !force) {
    die('还有进程（很可能是本系统自己）正占着这个数据库：\n'
      + '    ' + dbf.DB_FILE + '\n'
      + '  探测结果：' + busy.replace(/^busy:?/, '') + '\n\n'
      + '  请先停掉服务：双击安装目录里的「停止系统.bat」，或关掉那个黑色的服务窗口，\n'
      + '  等两三秒让文件句柄释放，再重跑本命令。\n\n'
      + '  为什么不能直接覆盖：服务在跑时替换库文件，两个进程会同时写一份数据；\n'
      + '  更常见的是 -wal 文件删不掉，服务一启动就把还原前的数据回放回来 ——\n'
      + '  你会看到"还原成功"，但数据还是还原前的。\n\n'
      + '  确认服务确实已停、只是探测不准（极少数情况）：加 --force 重跑。');
  }
  if (busy.startsWith('err:')) {
    console.log('  ⚠ 检测占用时出问题（' + busy.slice(4, 80) + '），照常继续。');
  }
  // 删掉旧文件时**不能静默失败**：删不掉 -wal 是上面那个"还原无效"的直接成因
  const failed = [];
  for (const suffix of ['', '-wal', '-shm']) {
    const f = dbf.DB_FILE + suffix;
    if (!fs.existsSync(f)) continue;
    try { fs.unlinkSync(f); } catch (e) { failed.push(path.basename(f) + '（' + (e.code || e.message) + '）'); }
  }
  if (failed.length) {
    die('这些文件删不掉，还原已中止：\n    ' + failed.join('\n    ')
      + '\n\n  说明还有进程占着数据库。先彻底停掉服务再重试。\n'
      + '  （如果继续，旧的 -wal 会被回放，你看到的是还原前的数据）');
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