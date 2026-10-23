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
 * 本地时间串。
 * 这里**不能** require('./db.js') —— db.js 是在 init() 里 require 本模块的，
 * 顶层反向 require 会拿到半成品的 exports。复制这 3 行比冒循环依赖的风险划算。
 * （库里的时间字段都是本地时间串，写 UTC 会差一个时区，页面上的「升级时间」就不对。）
 */
function localTs (d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

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
        const ts = localTs();
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
  {
    version: 5,
    name: '列表排序与关联查询补索引',
    up (db) {
      // ── 为什么需要这一版 ──
      // 之前所有索引只覆盖 id / project_id / tenant_id（见 db.js 建表那两行），
      // 而列表页的默认排序键全是业务日期：收付款按 pay_date、发票按 issue_date、
      // 费用按 expense_date、计划按 due_date。这些列一个索引都没有，
      // 于是每条列表请求都是「整表扫 + 临时 B 树排序 + 取前 50 行」，
      // 数据量到几万行就从几十毫秒涨到几百毫秒甚至几秒。
      //
      // 复合索引里带上 id 的原因：排序是 `ORDER BY 日期 DESC, id DESC`，
      // 只有 (日期, id) 两列都有序，才能完全免掉那次排序步骤。
      // （SQLite 的 rowid 表本来就把 rowid 挂在索引尾部，多写一次没有额外代价；
      //   而 PostgreSQL 必须显式写，否则还是要 sort。）
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
      // 表和列都在才建：迁移跑在建表之前，缺一张表就让整条迁移失败得不偿失
      const idx = (name, table, cols) => {
        if (!tableExists(table)) return;
        if (!cols.every(c => colExists(table, c))) return;
        db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON "${table}"(${cols.join(', ')});`);
      };

      // 收付款：列表按发生日期倒序翻页；发票勾稽按 invoice_id 分组；按合同筛选
      idx('idx_payments_pay_date', 'payments', ['pay_date', 'id']);
      idx('idx_payments_invoice', 'payments', ['invoice_id']);
      idx('idx_payments_contract', 'payments', ['contract_id']);
      // 发票：列表按开票日期倒序；按合同/单位筛选
      idx('idx_invoices_issue_date', 'invoices', ['issue_date', 'id']);
      idx('idx_invoices_contract', 'invoices', ['contract_id']);
      // 收付款计划：列表按到期日倒序；
      // 冲抵算法（scheduleAllocation）是按 project_id + direction + due_date 顺序遍历的
      idx('idx_schedules_due_date', 'schedules', ['due_date', 'id']);
      idx('idx_schedules_alloc', 'schedules', ['project_id', 'direction', 'due_date', 'id']);
      // 费用：列表按发生日期倒序
      idx('idx_expenses_expense_date', 'expenses', ['expense_date', 'id']);
      // 合同变更：changeMap 每次都按 合同 + 已确认 汇总
      idx('idx_changes_contract_status', 'contract_changes', ['contract_id', 'status']);
      // 合同：项目台账按 项目 + 方向 聚合；列表按签订日期
      idx('idx_contracts_project_dir', 'contracts', ['project_id', 'direction']);
      idx('idx_contracts_sign_date', 'contracts', ['sign_date', 'id']);
    },
  },
  {
    version: 6,
    name: '清理方向错误的发票挂账',
    up (db) {
      // ── 为什么需要这一版 ──
      // 老版本的发票自动挂账（POST /api/invoices/backfill）在发票侧和收付侧
      // 各把方向取反了一次，两次抵消，结果变成**同方向**配对：
      //   收款(in) 被挂到了进项票(in) 上
      //   付款(out) 被挂到了销项票(out) 上
      // 语义完全反了，导致发票勾稽（已开票已收 / 已收未开票）整块数字失真，
      // 而且整个过程不报错，用户只会觉得「对不上账」。
      //
      // 代码已修（现在收款只配销项票）。这一版负责把历史错挂的账解开，
      // 让它们回到「未关联」状态，用户可以重新点一次自动挂账 —— 这次会挂对。
      // 只解方向相同的配对，本来就没挂的、方向本来就对的一律不动。
      const hasPay = db.dialect === 'postgres'
        ? !!db.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'payments'").get()
        : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payments'").get();
      const hasInv = db.dialect === 'postgres'
        ? !!db.prepare("SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = 'invoices'").get()
        : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='invoices'").get();
      if (!hasPay || !hasInv) return;

      const ids = db.prepare(`SELECT p.id FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.direction = i.direction`).all().map(r => r.id);
      if (!ids.length) return;
      const stmt = db.prepare('UPDATE payments SET invoice_id = NULL WHERE id = ?');
      for (const id of ids) stmt.run(id);
    },
  },

  {
    version: 7,
    name: '回收站补 tenant_id（快照一直是失败的）',
    up (db) {
      // ── 为什么需要这一版 ──
      // trash 表由 trash.js 的 createTable() 建，建的时候**没有 tenant_id**；
      // 而 v4 的多租户迁移只遍历业务表，清单里没有 trash。
      // 可 trash.push() 的 INSERT 里写着 tenant_id —— 于是每次删除都：
      //   1) 快照抛 "table trash has no column named tenant_id"
      //   2) server.js 的 catch 只打一行日志，接着照删
      // 结果：数据删了，回收站里一条都没有，「30 天内可一键还原」全程是空话。
      // 这一版把列补上；索引一起补，否则多租户模式下列表查询会全表扫。
      const isPg = db.dialect === 'postgres';
      const exists = isPg
        ? !!db.prepare(`SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'trash'`).get()
        : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='trash'").get();
      if (!exists) return;                       // 新库由 createTable() 直接建全，这里不用管
      const cols = db.columns('trash');
      if (!cols.includes('tenant_id')) {
        db.exec('ALTER TABLE "trash" ADD COLUMN tenant_id BIGINT DEFAULT 1;');
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_trash_tenant ON trash(tenant_id);');
    },
  },
  {
    version: 8,
    name: '清理超出 JS 安全整数范围的 record_id（会让日志页永久 500）',
    up (db) {
      // ── 为什么需要这一版 ──
      // 旧版本写日志时是 `entry.record_id ? parseInt(entry.record_id, 10) : null`。
      // 请求里带一个超大编号（例如 /api/delete/projects/9007199254740993）时，
      // parseInt 会舍入成 9007199254740992 存进库 —— 超过 2^53 之后，
      // node:sqlite 读回来时抛 "Value is too large to be represented as a
      // JavaScript number"，于是 /api/logs 和首页系统通知**永久 500**。
      // 重启也不会好，因为脏数据在库里。
      //
      // 现在新写入已经被 logs.js 拦住了（只存安全整数），这一版负责把
      // 已经中招的库治好：这些记录的编号本来也没有意义（对应的记录早就不存在）。
      const MAX = Number.MAX_SAFE_INTEGER;
      // ⚠️ 不能「先执行再吞 no such table」——SQLite 下失败语句不毒化事务，
      // PG 下一旦失败，整个事务 aborted，后面写 schema_migrations 必报
      // "current transaction is aborted"，且真错误被吞掉无从排查。
      // 必须先查目录确认表存在，不存在就整体跳过（新库的 logs 由
      // logs.js 在迁移之后建，天然没有脏数据要治）。
      const hasLogs = db.dialect === 'postgres'
        ? !!db.prepare(`SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'logs'`).get()
        : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='logs'").get();
      if (hasLogs) db.exec(`UPDATE logs SET record_id = NULL WHERE record_id > ${MAX} OR record_id < -${MAX};`);
    },
  },
  {
    version: 9,
    name: '看板聚合覆盖索引（聚合列进索引，扫描不再回表）',
    up (db) {
      // ── 为什么需要这一版 ──
      // SQL 画像显示看板重算 209ms 里 110ms+ 花在 payments 的多次全表聚合上：
      // scheduleAllocation 的 GROUP BY、按项目收支合计、按月流水……
      // 已有索引只含过滤列（如 idx_payments_project 只有一列 project_id），
      // 聚合要的 direction/amount 都得回表取宽行 —— 4 万行 × 多次。
      //
      // 这批「覆盖索引」把聚合列也放进索引：扫描只走窄索引、零回表。
      // tenant_id 放在【末尾】而不是开头，是刻意的：
      //   · 放开头：单机模式（查询不带 tenant 过滤）GROUP BY 无法借索引顺序，
      //     要额外排序，反而变慢
      //   · 放末尾：两种模式都是纯覆盖扫描 —— 单机不需要过滤；多租户的
      //     tenant_id 过滤在扫描时顺带完成，同样零回表
      // 代价：payments 多 3 个索引，每次插入多写 3 棵 B 树（微秒级），
      // 换看板重算从 209ms 降下来 —— 读是 28% 流量，写只有 6%。
      // ⚠️ 先查目录再建，不能「先执行再吞 does not exist」——
      // PG 下失败语句会毒化整个迁移事务（见 v8 的注释）。
      const tableExists = (t) => db.dialect === 'postgres'
        ? !!db.prepare(`SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ?`).get(t)
        : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      const idx = (name, table, cols) => {
        if (!tableExists(table)) return;
        db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON "${table}"(${cols.join(', ')});`);
      };
      // 收付款：按项目+方向合计（scheduleAllocation / 项目收支 / 冲抵）
      idx('idx_payments_agg', 'payments', ['project_id', 'direction', 'amount', 'tenant_id']);
      // 收付款：按月流水（substr(pay_date,1,7) 分组；索引按 pay_date 有序，免排序）
      idx('idx_payments_ym', 'payments', ['pay_date', 'direction', 'amount', 'tenant_id']);
      // 收付款：发票勾稽 / invoicePaidMap（按 invoice_id 分组合计）
      idx('idx_payments_invoice_amt', 'payments', ['invoice_id', 'amount', 'tenant_id']);
      // 发票：按项目+方向合计（项目台账 / 看板开票额）
      idx('idx_invoices_agg', 'invoices', ['project_id', 'direction', 'total_amount', 'tenant_id']);
      // 费用：科目排行 + 项目成本合计
      idx('idx_expenses_cat', 'expenses', ['category', 'amount', 'tenant_id']);
      idx('idx_expenses_agg', 'expenses', ['project_id', 'amount', 'amount_ex_tax', 'tenant_id']);
    },
  },
  {
    version: 10,
    name: '月度流水表达式覆盖索引（免临时 B 树排序）',
    up (db) {
      // 看板的 12 个月流水是 `GROUP BY substr(pay_date,1,7) ORDER BY ym DESC LIMIT 12`。
      // v9 的 idx_payments_ym 只能让扫描免回表，分组与排序还得靠 TEMP B-TREE
      // —— 4 万行进临时表再排，约 9ms，是单条 SQL 里最贵的一条。
      //
      // 用「表达式索引」把 substr 的结果本身变成索引键，扫描顺序就是分组顺序，
      // GROUP BY 和 ORDER BY 都省掉。但**光有表达式还不够**：
      //   · 只建 (substr(...))          → 仍然要回表取 direction/amount，40ms，更慢
      //   · 加上 direction, amount      → WHERE 里的 pay_date 不在索引里，仍要回表
      //   · 再加上 pay_date（本版）     → SCAN USING COVERING INDEX，1.8ms
      // 这三种都实测过，别想当然地只建表达式那一列。
      //
      // ⚠️ PG 要求表达式多包一层括号，且不能和普通列混在同一个括号里。
      // ⚠️ 先查目录再建（PG 下失败语句会毒化整个事务，见 v8 注释）。
      const exists = db.dialect === 'postgres'
        ? !!db.prepare(`SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = 'payments'`).get()
        : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payments'").get();
      if (!exists) return;
      const ym = db.dialect === 'postgres' ? '(substr(pay_date,1,7))' : 'substr(pay_date,1,7)';
      db.exec(`CREATE INDEX IF NOT EXISTS idx_payments_ym_expr
        ON payments(${ym}, pay_date, direction, amount, tenant_id);`);
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
  const ts = () => localTs();

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
