'use strict';
/**
 * 数据库备份
 * 使用 SQLite 官方的 VACUUM INTO：一次语句产出一份完整、一致、已整理过的副本，
 * 且不会与正在运行的服务的读写连接冲突（旧版做法是在第二个连接上做
 * wal_checkpoint(TRUNCATE)，在服务同时运行时并不安全）。
 */
const fs = require('node:fs');
const path = require('node:path');
const dbf = require('./db.js');

const BACKUP_DIR = path.join(dbf.DATA_DIR, '..', 'backup');
const KEEP = 30;

// 备份文件的扩展名跟着后端走：
//   .db    SQLite 原生副本 / PGlite 目录快照 / pg_dump 自定义格式
//   .json  pg_dump 找不到时的兜底（只有数据，没有结构）
// 这个正则以前写死 .db，PG 兜底产出的 .json 备份会**根本不出现在界面列表里** ——
// 用户以为没备份成功，实际文件就在硬盘上。
const BACKUP_RE = /^pms_\d{8}_\d{6}(?:_[A-Za-z0-9\u4e00-\u9fa5]+)?\.(db|json|tar\.gz|fc)$/;

function stamp (d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function listBackups () {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => BACKUP_RE.test(f))
    .map(f => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      const ext = f.endsWith('.json') ? 'json' : f.endsWith('.tar.gz') ? 'tar.gz' : 'db';
      return { name: f, size: st.size, mtime: st.mtime.toISOString(), ext };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

function prune () {
  const files = listBackups().map(b => b.name).sort();
  const removed = [];
  while (files.length > KEEP) {
    const old = files.shift();
    try { fs.unlinkSync(path.join(BACKUP_DIR, old)); removed.push(old); } catch { /* 忽略 */ }
  }
  return removed;
}

/**
 * 生成一份备份
 *
 * 备份格式由数据库后端决定（见 adapter 的 backupFormat）：
 * 单机 SQLite 是 VACUUM INTO 出的 .db；PG 走 pg_dump；
 * pg_dump 找不到时退回 JSON —— 这时会把 degraded 一起返回，
 * 让界面明确告诉用户「这份只有数据、没有结构」，不能悄悄降级。
 *
 * @returns {{ok:boolean, file?:string, path?:string, size?:number, format?:string,
 *            degraded?:boolean, pgDumpError?:string, restore?:string,
 *            pruned?:string[], remote?:object, error?:string}}
 */
function makeBackup (tag) {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = `pms_${stamp()}${tag ? '_' + tag : ''}.db`;
    const dest = path.join(BACKUP_DIR, name);
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    const out = dbf.backupTo(dest) || {};      // VACUUM INTO / pg_dump / 目录打包
    const format = out.format || dbf.backupFormat().format;
    // 兜底或 PGlite 快照时文件名后缀要跟着变，别让用户以为能直接双击打开
    let file = name;
    if (format === 'pg-json') file = name.replace(/\.db$/, '.json');
    else if (format === 'pglite-tar') file = name.replace(/\.db$/, '.tar.gz');
    const realPath = out.path || dest;
    const size = fs.existsSync(realPath) ? fs.statSync(realPath).size : 0;

    if (out.degraded) console.log('[备份] ⚠ pg_dump 不可用，已降级为 JSON（无结构）：' + out.pgDumpError);
    const pruned = prune();

    // 异地再存一份。失败**不回滚**本地备份 —— 本地那份才是主备份，
    // 异地是加分项，传失败只记一条警告，不能因此让备份流程失败。
    let remote = { ok: true, mode: 'off' };
    try {
      const br = require('./backup-remote.js');
      // 注意传的是**真实产出路径**（realPath）——pg_dump 降级时文件是 .json，
      // 沿用 .db 的路径会把「共享目录里没有这个文件」报成复制成功。
      remote = br.upload(realPath, file, br.configFromSettings());
      if (!remote.ok) console.log('[备份] 异地存放失败：' + remote.error);
      else if (remote.mode !== 'off') console.log('[备份] 已异地存放：' + remote.target);
    } catch (e) { remote = { ok: false, mode: 'off', error: e.message }; }

    const info = dbf.backupFormat();
    return {
      ok: true, file, path: realPath, size, format,
      degraded: !!out.degraded, pgDumpError: out.pgDumpError,
      restore: info.restore, pruned, remote,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 今天是否已经备份过（用于启动时的自动备份，避免反复重启刷屏） */
function hasBackupToday () {
  const today = new Date();
  const p = n => String(n).padStart(2, '0');
  const prefix = `pms_${today.getFullYear()}${p(today.getMonth() + 1)}${p(today.getDate())}_`;
  return listBackups().some(b => b.name.startsWith(prefix));
}

function lastBackup () {
  const list = listBackups();
  return list.length ? list[0] : null;
}

/** 备份的实际格式说明（界面「数据在哪」卡片用） */
function backupFormatInfo () {
  try {
    const info = dbf.backupFormat();
    const label = {
      'sqlite-vacuum-into': 'SQLite 原生副本',
      'pg_dump-Fc': 'PostgreSQL 完整备份（含索引与约束）',
      'pglite-tar': 'PGlite 数据目录快照',
      'pg-json': '仅数据表（未找到 pg_dump，无结构）',
    }[info.format] || '数据库原生副本';
    return { format: info.format || 'unknown', label, restore: info.restore || '' };
  } catch (e) {
    return { format: 'unknown', label: '未知', restore: '', error: e.message };
  }
}

function dbFootprint () {
  const files = {};
  for (const suffix of ['', '-wal', '-shm']) {
    const p = dbf.DB_FILE + suffix;
    try { files[path.basename(p)] = fs.statSync(p).size; } catch { files[path.basename(p)] = 0; }
  }
  const total = Object.values(files).reduce((a, b) => a + b, 0);
  return { files, total };
}

module.exports = { BACKUP_DIR, KEEP, makeBackup, listBackups, lastBackup, hasBackupToday, prune, dbFootprint, backupFormatInfo, stamp };
