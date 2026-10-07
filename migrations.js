'use strict';
/**
 * 数据库版本与迁移（类似 Flyway 的简化版）
 *
 * ── 为什么要它 ──
 * 之前加字段靠 createTables() 里的「PRAGMA 查一下缺哪列就 ALTER 加上」，
 * 这对**加列**够用，但干不了这些：
 *   · 数据订正（把旧值改成新格式）
 *   · 建索引、删冗余列
 *   · 依赖顺序的复杂变更
 * 而且没有版本记录，你无法回答「客户这套库到底是哪个版本」。
 *
 * ── 怎么工作 ──
 *   1. 建 schema_migrations 表（记录已执行的版本）
 *   2. 读出当前版本号
 *   3. 有更新的迁移就**先自动备份**，再逐个在事务里执行
 *   4. 记录版本
 *
 * ── 老库怎么办 ──
 * 老库没有 schema_migrations 表，会被当成版本 0。
 * 第一个迁移是「基线」，它什么都不改，只是把现有库标记成 1 版
 * —— 所以老用户升级时不会被动数据。
 */
const fs = require('node:fs');
const path = require('node:path');

/**
 * 迁移清单。**只能往后追加，不能改已经发布过的条目**
 * （改了的话，已经跑过的库不会重跑，新库和老库结构就不一致了）。
 *
 * up(db) 里可以用 db.prepare/exec，和业务代码一样的同步接口。
 */
const MIGRATIONS = [
  {
    version: 1,
    name: '基线（建表 + 补齐历史缺失列）',
    up () {
      // 建表和补列由 db.js 的 createTables() 负责，且它是幂等的。
      // 这里刻意什么都不做：老库升级时被标记成基线版本，数据一个字节都不动。
    },
  },
  {
    version: 2,
    name: '系统设置表（界面自定义 / 授权码）',
    up (db) {
      db.exec(`CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT
      );`);
    },
  },
  {
    version: 3,
    name: '给常用查询补索引',
    up (db) {
      // 注意：logs / attachments 这些表不是 db.js 建的，是各自模块在启动稍后建的。
      // 迁移跑在建表之前，所以必须先确认表在不在 —— 否则首启就会报 no such table。
      //
      // 而且判断方式必须是方言感知的：用 sqlite_master 去查 PG 会直接报错，
      // 而在 PG 里**一条语句报错会污染整个事务**，后面的迁移全部执行不了。
      const has = (t) => {
        try {
          if (db.dialect === 'postgres') {
            return !!db.prepare(`SELECT table_name FROM information_schema.tables
              WHERE table_schema = current_schema() AND table_name = ?`).get(t);
          }
          return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
        } catch { return false }
      };
      // 日志按时间倒序翻页是最高频查询之一，数据量大了没索引会明显变慢。
      // 列名是 at 不是 created_at（logs 表从一开始就叫这个）。
      if (has('logs')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_logs_at ON logs(at);');
        db.exec('CREATE INDEX IF NOT EXISTS idx_logs_table ON logs(table_name);');
      }
      if (has('attachments')) {
        db.exec('CREATE INDEX IF NOT EXISTS idx_attach_created ON attachments(created_at);');
      }
    },
  },
  {
    version: 4,
    name: '多租户：tenant_id 字段 + 租户表',
    up (db) {
      // 纯增量：给业务表加 tenant_id，默认 1。
      // 老数据自动全部归到租户 1，**不需要任何手工迁移** —— 这就是需求里
      // 「现在单机版默认 tenant_id=1，所有老数据自动归到租户1」的落地方式。
      //
      // 单机版下所有数据都是 1，查询带上 tenant_id 条件也永远只命中这些，
      // 行为和现在完全一致；只有开了多租户模式，这个字段才真正产生隔离效果。
      const tables = ['projects', 'contracts', 'contract_changes', 'schedules',
        'payments', 'invoices', 'expenses', 'materials', 'partners', 'maintenance',
        'attachments', 'logs', 'snapshots', 'users'];

      for (const t of tables) {
        try {
          // 先看存不存在，避免对不存在的表执行 ALTER 报错
          const exists = db.dialect === 'postgres'
            ? !!db.prepare(`SELECT table_name FROM information_schema.tables
                WHERE table_schema = current_schema() AND table_name = ?`).get(t)
            : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
          if (!exists) continue;

          const cols = db.columns(t);
          if (!cols.includes('tenant_id')) {
            db.exec(`ALTER TABLE "${t}" ADD COLUMN tenant_id BIGINT DEFAULT 1;`);
          }
        } catch { /* 单张表失败不影响其它表 */ }
      }

      // 租户表
      db.exec(`CREATE TABLE IF NOT EXISTS tenants (
        id BIGINT PRIMARY KEY,
        name TEXT NOT NULL,
        contact TEXT,
        phone TEXT,
        expiry TEXT,
        status TEXT DEFAULT '启用',
        remark TEXT,
        created_at TEXT,
        updated_at TEXT
      );`);

      // 至少要有 1 号租户，否则老库升上来会「无家可归」
      const has1 = db.prepare('SELECT id FROM tenants WHERE id = 1').get();
      if (!has1) {
        const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
        db.prepare(`INSERT INTO tenants (id, name, status, remark, created_at, updated_at)
                    VALUES (1, '默认租户', '启用', '单机版 / 老数据归属', ?, ?)`).run(ts, ts);
      }

      // 越权风险点：租户维度的查询会很多，没索引会明显变慢。
      //
      // ⚠️ 这里**不能**用 try/catch 兜失败：PostgreSQL 里一条语句报错，
      // 整个事务就被污染，后面所有语句都会回
      // "current transaction is aborted" —— catch 只能吞掉 JS 错误，救不回事务。
      // 而 logs 表是 logs.js 在 init() 之后才建的，跑 v4 时它还不存在。
      // 所以必须**先确认表和列都在**再建索引。
      const tableExists = (t) => {
        try {
          return db.dialect === 'postgres'
            ? !!db.prepare(`SELECT table_name FROM information_schema.tables
                WHERE table_schema = current_schema() AND table_name = ?`).get(t)
            : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
        } catch { return false }
      };
      const colExists = (t, c) => {
        try { return db.columns(t).includes(c) } catch { return false }
      };
      for (const t of ['projects', 'contracts', 'payments', 'invoices', 'schedules', 'attachments']) {
        if (tableExists(t) && colExists(t, 'tenant_id')) {
          db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_tenant ON "${t}"(tenant_id);`);
        }
      }
    },
  },
];

const TABLE = 'schema_migrations';
const LATEST = MIGRATIONS.length ? MIGRATIONS[MIGRATIONS.length - 1].version : 0;

function ensureTable (db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    version INTEGER PRIMARY KEY,
    name TEXT,
    applied_at TEXT
  );`);
}

/** 当前库的版本号（没表 / 没记录 = 0） */
function currentVersion (db) {
  try {
    ensureTable(db);
    const r = db.prepare(`SELECT MAX(version) AS v FROM ${TABLE}`).get();
    return Number(r && r.v) || 0;
  } catch {
    return 0;
  }
}

/** 已执行过的版本清单（界面上展示用） */
function applied (db) {
  try {
    ensureTable(db);
    return db.prepare(`SELECT version, name, applied_at FROM ${TABLE} ORDER BY version`).all();
  } catch {
    return [];
  }
}

/**
 * 这个库里已经有没有业务数据？
 * 用来决定升级前要不要备份 —— 空库不用备，有数据必须备。
 */
function hasExistingData (db) {
  try {
    // 方言不同，列表的方式也不同（SQLite 读 sqlite_master，PG 读 information_schema）
    const isPg = db.dialect === 'postgres';
    const names = isPg
      ? db.prepare(`SELECT table_name AS name FROM information_schema.tables
                    WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`)
        .all().map(r => r.name)
      : db.prepare(`SELECT name FROM sqlite_master
                    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
        .all().map(r => r.name);

    for (const n of names) {
      if (n === TABLE) continue;
      // 只看表里有没有行，空表不算「有数据」
      try {
        const c = db.prepare(`SELECT COUNT(*) AS n FROM "${n}"`).get();
        if (Number(c && c.n) > 0) return true;
      } catch { /* 个别表查不了就跳过 */ }
    }
    return false;
  } catch {
    // 判断不了就保守一点：当作有数据，走备份流程
    return true;
  }
}

/**
 * 跑到最新版本。
 * @param {object} db 数据库句柄
 * @param {object} opts
 * @param {function} [opts.backup] 迁移前自动备份，返回备份文件路径
 * @param {function} [opts.log] 日志输出
 * @returns {{from:number,to:number,ran:Array,backup:string|null,error?:string}}
 */
function migrate (db, opts = {}) {
  const log = opts.log || (() => {});
  const from = currentVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > from).sort((a, b) => a.version - b.version);

  if (!pending.length) {
    return { from, to: from, ran: [], backup: null };
  }

  log(`数据库版本 ${from} → ${LATEST}，有 ${pending.length} 个迁移要执行`);

  // 升级前先备份：迁移写错了还能退回去。
  //
  // 判据不能是「from > 0」—— 恰恰相反，**老用户升级时 from 就是 0**
  // （他们的库还没有版本表）。用版本号判断的话，最需要备份的那批人反而没备份。
  // 所以改成看「库里到底有没有东西」：空库没什么可备的，有数据就必须备。
  let backupFile = null;
  if (hasExistingData(db) && typeof opts.backup === 'function') {
    try {
      backupFile = opts.backup();
      log('升级前已备份：' + backupFile);
    } catch (e) {
      // 备份失败就不升了 —— 没有退路的升级比不升级更危险
      return { from, to: from, ran: [], backup: null, error: '升级前备份失败，已中止：' + e.message };
    }
  }

  const ran = [];
  ensureTable(db);
  const ts = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

  for (const m of pending) {
    try {
      // 每条迁移单独一个事务：某条失败时，前面的已经生效的不会被回滚掉
      db.exec('BEGIN');
      m.up(db);
      db.prepare(`INSERT INTO ${TABLE} (version, name, applied_at) VALUES (?, ?, ?)`)
        .run(m.version, m.name, ts());
      db.exec('COMMIT');
      ran.push({ version: m.version, name: m.name });
      log(`  ✓ v${m.version}  ${m.name}`);
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
      return {
        from, to: currentVersion(db), ran, backup: backupFile,
        error: `迁移 v${m.version}「${m.name}」失败：${e.message}`,
      };
    }
  }

  return { from, to: currentVersion(db), ran, backup: backupFile };
}

module.exports = { MIGRATIONS, LATEST, TABLE, migrate, currentVersion, applied, ensureTable };
