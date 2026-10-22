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
  db.exec('PRAGMA busy_timeout = 8000;');
  // WAL 下的官方推荐搭配是 synchronous=NORMAL：
  //  · NORMAL：应用崩溃/被强杀**不丢数据**（WAL 里都有），只有整机掉电/系统崩溃
  //    可能丢最后几笔已提交事务 —— 换来每次提交不再强制 fsync（Windows 上一次
  //    fsync 几十毫秒，写路径里最贵的一步）。
  //  · FULL：掉电也不丢，代价是每个事务都 fsync。以前用 FULL 是因为单机几 MB
  //    数据感觉不出来；压测（4 万收付款、30 并发混合负载）里它成了写延迟大头。
  //  · 业务取舍：项目款项记录丢了最后一两笔可以从界面重录（有回收站/日志），
  //    而「每次录账都卡几百毫秒」是所有人都感知的。选 NORMAL。
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  /**
   * 切 WAL：**失败了不能让它把服务拖死**。
   *
   * ⚠️ 这里踩过两次，都记下来：
   *  1) busy_timeout 原来写在 journal_mode 之后 —— 注释还写着"允许别的连接等待锁"，
   *     等于把超时设在了出事之后，形同虚设。
   *  2) 把它挪到前面**也没用**：SQLite 的 PRAGMA journal_mode 在拿不到锁时
   *     是立即返回 SQLITE_BUSY 的，不走 busy handler（实测：非 WAL 库上另一个
   *     进程 BEGIN IMMEDIATE，这边仍然秒抛 database is locked）。
   *
   * 而"另一个进程正握着库"是**正常场景**，不是故障：
   *   · 开机自启的服务还在初始化，用户又双击了一次图标
   *   · 覆盖安装刚杀掉旧进程，句柄还没释放
   *   · 备份脚本正在读
   * 所以：先重试几次（通常几十毫秒内锁就没了），仍然不行就**降级**继续 ——
   * WAL 只是并发优化，用默认的 rollback journal 一样能正常读写。
   * 以前这里直接抛到顶层，用户看到的就是"双击图标，窗口闪一下就没了"。
   * （CI 的覆盖安装验证抓到的就是这一行：adapter-sqlite.js:23 database is locked）
   */
  let walOk = false;
  for (let i = 0; i < 10 && !walOk; i++) {
    try { db.exec('PRAGMA journal_mode = WAL;'); walOk = true; }
    catch (e) {
      if (!/locked|busy/i.test(String(e && e.message))) throw e;   // 别的原因照抛
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200) } catch { /* 忽略 */ }
    }
  }
  if (!walOk) {
    console.warn('[SQLite] 数据库被其他进程占用，本次以默认日志模式启动（功能不受影响，并发写入会稍慢）');
  }

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
