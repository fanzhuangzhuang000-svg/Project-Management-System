'use strict';
/**
 * SQLite 适配器：把 node:sqlite 包成统一接口
 *
 * 单机版（exe 安装包）走这条。零依赖，双击就能用。
 * 对上层 db.js 来说，它就是个「同步的数据库句柄」。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

/** 方言标记，业务层需要分支时用它（尽量别用） */
const DIALECT = 'sqlite';

function open (opts = {}) {
  const file = opts.file || path.join(opts.dataDir || path.join(__dirname, 'data'), 'pms.db');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = new DatabaseSync(file);

  // 这些 PRAGMA 是 SQLite 专属的连接设置，放在适配器里，
  // 业务层就不用关心「换个数据库要不要改这几行」。
  db.exec('PRAGMA journal_mode = WAL;');
  // 数据量很小（几 MB），用 FULL 换取掉电/强杀也不丢数据
  db.exec('PRAGMA synchronous = FULL;');
  // 允许别的连接（备份脚本、另一个实例）等待锁，而不是直接 SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 8000;');
  db.exec('PRAGMA foreign_keys = ON;');

  return {
    dialect: DIALECT,
    file,
    raw: db,

    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    close: () => { try { db.close() } catch { /* 忽略 */ } },

    /** 把 WAL 合并回主库。PG 没有这个概念，那边是空操作。 */
    checkpoint (mode = 'PASSIVE') {
      try { return db.prepare(`PRAGMA wal_checkpoint(${mode})`).get() } catch (e) { return { error: e.message } }
    },

    /** 生成一份完整、一致、整理过的数据库副本（SQLite 官方推荐的备份方式） */
    backupTo (destPath) {
      const escaped = String(destPath).replace(/'/g, "''");
      db.exec(`VACUUM INTO '${escaped}'`);
      return destPath;
    },

    /** 备份的实际格式（PG 那边可能是 pg_dump，这里是 SQLite 原生副本） */
    backupFormat () {
      return { format: 'sqlite-vacuum-into', restore: '把 .db 文件放回 data 目录即可，结构与数据都在' };
    },

    /** 表有哪些列（业务层建表时用来补缺失列） */
    columns (table) {
      return db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    },
  };
}

module.exports = { open, DIALECT };
