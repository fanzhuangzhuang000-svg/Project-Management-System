'use strict';
/**
 * PostgreSQL 适配器
 *
 * ── 为什么要这么绕 ──
 * 业务层 db.js 有 1700 行同步代码（原生 SQLite 是同步 API）。
 * pg 是异步的。把整个数据层改成 async 会牵动所有调用方，风险极高。
 *
 * 所以这里用「worker 线程持有 pg 连接 + 主线程 Atomics.wait 阻塞等结果」
 * 把异步包装成同步。业务层看到的就是一个普通的同步句柄，一行都不用改。
 *
 * 代价：查询期间主线程阻塞。同步 SQLite 本来也是这样，
 * 对「2-5 人的局域网工具」完全够用；真到高并发再换 async 数据层。
 *
 * ── 关键设计决定 ──
 * 1) 用**单个 Client** 而不是 Pool：业务层靠 BEGIN/COMMIT 做事务，
 *    走连接池的话两条语句可能落到不同连接上，事务就废了。
 * 2) 布尔/开关类字段在 PG 里仍然用 INTEGER（0/1），不用 boolean。
 *    因为业务层到处是 `=== 1` 这种判断，改成 boolean 会全线崩。
 *    用整数类型，两边 JS 看到的值完全一样。
 */
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { Worker, MessageChannel, receiveMessageOnPort } = require('node:worker_threads');

const DIALECT = 'postgres';

// ─────────────────────────── pg_dump ───────────────────────────
//
// PG 的备份必须用 pg_dump，不能自己 SQL 拼 —— 自己拼出来的只有行数据，
// 没有主键、索引、唯一约束、默认值、序列。客户真要还原时才发现这些没了，
// 那份备份就是残废的。
//
// pg_dump 是个外部程序，不一定存在：
//   · Docker 精简镜像里没装（node:22-alpine 默认没有）
//   · 客户机器上不一定装了 postgresql-client
// 所以这里做三件事：找得到就用、找不到就退回 JSON 兜底、把实际格式如实报出去。

const PG_DUMP_CANDIDATES = ['pg_dump', 'pg_dump.exe'];

/** 找 pg_dump 可执行文件（跨平台，PATH 里找不到就翻常见安装目录） */
function whichPgDump () {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, PG_DUMP_CANDIDATES, { encoding: 'utf8', timeout: 5000, windowsHide: true });
  if (r.status === 0 && r.stdout) {
    const first = String(r.stdout).split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
    if (first && fs.existsSync(first)) return { available: true, bin: first };
  }
  // PATH 里没有就翻标准安装位置（Windows 上装过 PG 客户端但没进 PATH 的情况不少）
  const extra = process.platform === 'win32'
    ? [
        'C:\\Program Files\\PostgreSQL',
        'C:\\Program Files (x86)\\PostgreSQL',
      ]
    : ['/usr/lib/postgresql', '/usr/pgsql'];
  for (const root of extra) {
    try {
      // 版本目录倒序排：优先用最新的客户端
      const vers = fs.existsSync(root)
        ? fs.readdirSync(root).sort().reverse()
        : [];
      for (const v of vers) {
        const exe = process.platform === 'win32'
          ? path.join(root, v, 'bin', 'pg_dump.exe')
          : path.join(root, v, 'bin', 'pg_dump');
        if (fs.existsSync(exe)) return { available: true, bin: exe };
      }
    } catch { /* 忽略 */ }
  }
  return { available: false, bin: null };
}

/**
 * 用 pg_dump 生成一份备份
 *
 * -Fc 是自定义格式：单文件、已压缩、可 pg_restore 选择性还原，
 * 对「客户手里只有一份文件、没有服务器权限」的交付场景最合适。
 */
function pgDumpTo (url, destPath) {
  const found = whichPgDump();
  if (!found.available) {
    // 找不到 pg_dump 就退回 JSON，**但要如实标记**，不能让用户以为备份了结构
    return { ok: true, path: destPath, format: 'pg-json', bin: null };
  }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const r = spawnSync(found.bin, ['-Fc', '--no-owner', '--no-privileges', '-f', destPath, url], {
    encoding: 'utf8',
    timeout: 30 * 60 * 1000,
    windowsHide: true,
  });
  if (r.error) throw new Error('pg_dump 执行失败：' + r.error.message);
  if (r.status !== 0) {
    throw new Error('pg_dump 退出码 ' + r.status + '：' + String(r.stderr || '').trim().slice(0, 400));
  }
  if (!fs.existsSync(destPath) || fs.statSync(destPath).size === 0) {
    throw new Error('pg_dump 执行完但没有产出文件');
  }
  return { ok: true, path: destPath, format: 'pg_dump-Fc', bin: found.bin };
}

/**
 * PGlite（进程内 WASM PG）没有 pg_dump 出口，只能整目录快照。
 * 用完要停服务才能解压回去 —— 这个限制必须写在界面上，不能藏。
 */
function pgliteSnapshot (dir, destPath) {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  if (!fs.existsSync(dir)) throw new Error('PGlite 数据目录不存在：' + dir);
  // PGlite 的 dumpDataDir 是 worker 里的异步接口，这里在主线程直接打包磁盘目录。
  // 数据目录里没有活跃写入（PGlite 每次 exec 都同步落盘），所以拷贝是安全的。
  const tar = process.platform === 'win32' ? 'tar.exe' : 'tar';
  const r = spawnSync(tar, ['-czf', destPath, '-C', dir, '.'], { encoding: 'utf8', timeout: 30 * 60 * 1000, windowsHide: true });
  if (r.error) throw new Error('打包数据目录失败：' + r.error.message);
  if (r.status !== 0) throw new Error('tar 退出码 ' + r.status + '：' + String(r.stderr || '').trim().slice(0, 300));
  return { ok: true, path: destPath, format: 'pglite-tar', bin: tar };
}

/** 逐表 JSON 兜底：只有数据没有结构，仅在 pg_dump 找不到时用 */
function jsonFallbackDump (call, destPath) {
  const tables = call({
    kind: 'query',
    sql: `SELECT table_name AS t FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`,
  }).rows.map(r => r.t);
  const dump = { __format: 'elv-pms-pg-json', __at: new Date().toISOString(), tables: {} };
  for (const t of tables) dump.tables[t] = call({ kind: 'query', sql: `SELECT * FROM "${t}"` }).rows;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.writeFileSync(destPath, JSON.stringify(dump));
  return { ok: true, path: destPath, format: 'pg-json', bin: null };
}

// ─────────────────────────── SQL 方言翻译 ───────────────────────────

/**
 * 把 `?` 占位符换成 PG 的 `$1 $2 …`
 *
 * 必须跳过字符串字面量里的问号（比如 LIKE '%?%'），否则会把参数个数数错。
 * 这里手写一个小扫描器，比正则可靠。
 */
/**
 * SQLite 专有函数 → PG 对应写法。
 * 目前只用到 IFNULL（PG 里叫 COALESCE）。
 * substr / || / COALESCE / LIKE / COUNT / SUM 两边都支持，不用动。
 */
function functions (sql) {
  return String(sql).replace(/\bIFNULL\s*\(/gi, 'COALESCE(');
}

function placeholders (sql) {
  let out = '';
  let n = 0;
  let i = 0;
  const len = sql.length;
  while (i < len) {
    const ch = sql[i];
    // 单引号字符串：'' 是转义的单引号
    if (ch === "'") {
      out += ch; i++;
      while (i < len) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "''"; i += 2; continue }
        out += sql[i];
        if (sql[i] === "'") { i++; break }
        i++;
      }
      continue;
    }
    // 双引号标识符
    if (ch === '"') {
      out += ch; i++;
      while (i < len) { out += sql[i]; if (sql[i] === '"') { i++; break } i++ }
      continue;
    }
    // 行注释
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < len && sql[i] !== '\n') { out += sql[i]; i++ }
      continue;
    }
    if (ch === '?') { n++; out += '$' + n; i++; continue }
    out += ch; i++;
  }
  return out;
}

/** SQLite 的表结构 → PG 的表结构 */
function ddl (sql) {
  return String(sql)
    // 自增主键
    .replace(/INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT/gi, 'BIGSERIAL PRIMARY KEY')
    // 浮点：SQLite 的 REAL 在 PG 里对应 DOUBLE PRECISION，精度才够存金额
    .replace(/\bREAL\b/gi, 'DOUBLE PRECISION')
    // 其余裸 INTEGER 一律放宽成 BIGINT —— 这一步不是保守起见，是必须的：
    // SQLite 的类型是建议性的，INTEGER 列里塞 13 位毫秒时间戳毫无问题；
    // PG 的 INTEGER 是严格 32 位（上限 21 亿），塞进去直接报
    // "value ... is out of range for type integer"，连登录都会失败。
    // 业务里有会话/登录失败时间这类毫秒值，必须 BIGINT 才装得下。
    // （BIGSERIAL 里不含 INTEGER 字样，不会被误伤）
    .replace(/\bINTEGER\b/gi, 'BIGINT');
}

/** 是不是 INSERT（要补 RETURNING id 才能拿到自增主键） */
function isInsert (sql) { return /^\s*INSERT\s+INTO/i.test(sql) }
function insertTable (sql) {
  const m = /^\s*INSERT\s+INTO\s+["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?/i.exec(sql);
  return m ? m[1] : null;
}
function alreadyReturning (sql) { return /\bRETURNING\b/i.test(sql) }

/** PRAGMA table_info(x) → 适配成 PG 的列清单查询 */
function pragmaTableInfo (sql) {
  const m = /^\s*PRAGMA\s+table_info\(\s*["`]?([A-Za-z_][A-Za-z0-9_]*)["`]?\s*\)/i.exec(sql);
  return m ? m[1] : null;
}

// ─────────────────────────── worker 源码 ───────────────────────────
// 单独写成一个字符串，避免 eval 里引用外部作用域
const WORKER_SRC = `
'use strict';
const { workerData } = require('node:worker_threads');
const port = workerData.port;

// 两种后端，界面/配置上没区别，都是真 PostgreSQL：
//   pg      —— 连独立部署的 PostgreSQL（生产/Docker）
//   pglite  —— Postgres 编译成 WASM，跑在进程内，不用装服务器（测试 / 免 Docker 的专业版）
let backend = null;
let connecting = null;

async function ensureBackend () {
  if (backend) return backend;
  if (!connecting) {
    connecting = (async () => {
      if (workerData.kind === 'pglite') {
        const { PGlite } = require(workerData.pglitePath);
        const inst = await PGlite.create(workerData.dir);
        const b = {
          query: (arg) => (typeof arg === 'string' ? inst.query(arg) : inst.query(arg.text, arg.values)),
          exec: (sql) => inst.exec(sql),
          end: () => inst.close(),
        };
        backend = b;               // ★ 必须真的记下来（下面 pg 分支的教训）
        return b;
      }
      const pgMod = require(workerData.pgPath);
      const { Client, types } = pgMod;
      // ★ 关键：pg 默认把 BIGINT(int8) / NUMERIC 当【字符串】返回（怕超过 JS 安全整数），
      // 但业务里到处是 === 1、Number(x)、金额加减 —— 拿到字符串会全线出问题：
      // 开关判断失效、聚合指标变字符串、统计对不上、id 比较失败。
      // 我们的 id 和金额远到不了 2^53，转成 number 是安全的。
      types.setTypeParser(20, (v) => (v === null ? null : Number(v)));    // int8 / BIGINT
      types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));  // numeric / SUM()
      types.setTypeParser(700, (v) => (v === null ? null : Number(v)));   // real
      types.setTypeParser(701, (v) => (v === null ? null : Number(v)))    // double precision
      const c = new Client({
        connectionString: workerData.url,
        application_name: 'elv-pms',
        // ★ 云上必备：数据库放在 RDS / 云主机上时，中间一定有防火墙或 NAT。
        // 它会悄悄掐掉「空闲超过几分钟」的 TCP 连接 —— 表现是系统跑着跑着
        // 突然所有接口一起 500（"Connection terminated unexpectedly"），
        // 查防火墙查不出问题，因为连接在空闲时是被中间设备单方面关掉的。
        // keepAlive 让 Node 自己定期发探测包，连接就不会被当成空闲回收。
        keepAlive: true,
        keepAliveInitialDelayMillis: 10000,
      });
      // ★ 连接断了必须自己爬起来。
      //
      // pg 的 Client 在连接异常时会 emit 'error'。以前这里没有监听者，
      // 事件无人处理就会变成 worker 的未捕获异常 —— worker 一挂，
      // 主线程的 workerError 被置位，之后**每一次**数据库调用都直接抛
      // 「数据库 worker 已挂」，整个系统永久不可用，只能重启进程。
      //
      // 也就是说：一次网络抖动 = 客户的数据系统彻底报废。
      // 现在改成把坏掉的连接丢掉，下次查询自动重新建立。
      //
      // ⚠ 两个必须做对的地方（都实测踩过）：
      //   1) backend 必须被真的赋值。原版只是 return conn，没赋值，
      //      于是每条查询都新建一个 Client —— 旧 Client 立刻 emit 'end'，
      //      handler 又把 backend 置空，形成「建→弃→再建」的抖动循环，
      //      结果永远拿不到可用连接（自愈测试 12 次全失败）。
      //   2) 'error' 里不能碰 backend=null 之外的连接对象，
      //      否则新旧连接的 end 事件会互相把对方踢掉。
      const conn = {
        query: (arg) => c.query(arg),
        exec: (sql) => c.query(sql),
        end: () => c.end(),
        client: c,
      };
      c.on('error', (e) => {
        console.error('[PG] 连接异常，将自动重连：' + ((e && e.message) || e));
        if (backend && backend.client === c) { backend = null; connecting = null; }
      });
      c.on('end', () => {
        if (backend && backend.client === c) { backend = null; connecting = null; }
      });
      try {
        await c.connect();
      } catch (e) {
        backend = null; connecting = null;    // 首连失败也让下一次重试有机会
        throw e;
      }
      backend = conn;                        // ★ 记下来，下次查询复用同一个连接
      return conn;
    })();
  }
  return connecting;
}

/** 连接类错误（PG 断线、网络抖动、服务重启）—— 这些值得重试一次 */
function isConnError (e) {
  const m = String((e && e.message) || e || '');
  return /terminated|ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|Connection closed|connect|closed the connection|server closed/i.test(m);
}

const sleep = (ms) => { const sab = new SharedArrayBuffer(4); Atomics.wait(new Int32Array(sab), 0, 0, ms); };

async function handle (m) {
  if (m.kind === 'close') { const b = await ensureBackend(); await b.end(); backend = null; connecting = null; return {} }
  // 重试一次：worker 侧如果刚好在重连，第一条请求不该替这次抖动背锅。
  for (let attempt = 0; ; attempt++) {
    const b = await ensureBackend();
    try {
      if (m.kind === 'exec') { await b.exec(m.sql); return {} }
      const res = await b.query({ text: m.sql, values: m.params || [] });
      return {
        rows: res.rows,
        changes: typeof res.rowCount === 'number' ? res.rowCount : (res.affectedRows || 0),
        lastInsertRowid: m.wantId ? (res.rows[0] || {}).id : undefined,
      };
    } catch (e) {
      if (attempt === 0 && isConnError(e)) {
        console.error('[PG] 查询因连接问题失败，重连后重试一次：' + (e && e.message));
        if (backend && backend.client === b.client) { backend = null; connecting = null; }
        sleep(400);
        continue;
      }
      throw e;
    }
  }
}

port.on('message', (m) => {
  const i32 = new Int32Array(m.sab);
  handle(m).then(
    (out) => { port.postMessage({ id: m.id, ok: true, ...out }); },
    (err) => { port.postMessage({ id: m.id, ok: false, error: err.message || String(err) }); }
  ).finally(() => { Atomics.store(i32, 0, 1); Atomics.notify(i32, 0); });
});
`;

// ─────────────────────────── 适配器 ───────────────────────────

function open (opts = {}) {
  const url = opts.url;
  if (!url) throw new Error('PostgreSQL 连接串为空（请检查环境变量 DB_URL）');

  // pglite:// → 进程内的 WASM Postgres（不用装服务器）
  // postgres:// → 独立部署的 PostgreSQL（生产 / Docker）
  const isPglite = /^pglite:/i.test(url);

  let workerData = {};
  // pglite://./data/pgdata  →  ./data/pgdata 作为数据目录
  let pgliteDir = null;
  if (isPglite) {
    let pglitePath;
    try { pglitePath = require.resolve('@electric-sql/pglite') } catch {
      throw new Error('用 pglite:// 需要先装 @electric-sql/pglite（npm install）');
    }
    pgliteDir = url.replace(/^pglite:\/\//i, '') || path.join(__dirname, 'data', 'pgdata');
    workerData = { kind: 'pglite', dir: pgliteDir, pglitePath };
  } else {
    // pg 只在真连 PG 服务器时才需要；单机版装机包里没有它，也不该有
    let pgPath;
    try {
      pgPath = require.resolve('pg');
    } catch {
      throw new Error(
        '连 PostgreSQL 需要 pg 驱动，但当前环境里没装。\n' +
        '  · 网络版/专业版：在项目目录执行  npm install  后再启动\n' +
        '  · 单机版：不需要 PostgreSQL，用默认的 SQLite 即可（不要设 DB_URL）'
      );
    }
    workerData = { kind: 'pg', url, pgPath };
  }

  // ── worker 生命周期 ──
  //
  // worker 是整个数据层的命门：它一挂，主线程再也拿不到任何查询结果。
  // 所以不能只在启动时建一次 —— 挂了就地重建，下一次调用自动接上，
  // 而不是让整个服务只能靠重启进程恢复。
  let seq = 0;
  let closed = false;
  let workerError = null;
  let port1 = null;
  let worker = null;

  function spawnWorker () {
    const { port1: p1, port2 } = new MessageChannel();
    port1 = p1;
    workerData.port = port2;
    worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData,
      transferList: [port2],
    });
    worker.unref?.();
    worker.on('error', (e) => { workerError = e; });
    worker.on('exit', () => { /* 主线程退出时正常结束 */ });
  }

  spawnWorker();

  /** worker 挂掉后重新拉起；返回是否恢复成功 */
  function respawn () {
    if (closed) return false;
    try { if (worker) worker.terminate(); } catch { /* 忽略 */ }
    workerError = null;
    try { spawnWorker(); return true; } catch { return false; }
  }

  /**
   * 同步调用：把异步查询变成本次调用内阻塞等待
   *
   * worker 意外挂掉时自动重建并重试一次。之前这里是直接抛
   * 「数据库 worker 已挂」，而且这个状态一旦设上就**永远不会清掉**——
   * 一次网络抖动或一次 PG 短暂重启，就让整个系统再也不能用数据库，
   * 只有重启服务进程才能恢复。云上部署时这是不可接受的。
   */
  function call (msg, timeoutMs = 60000, retryOnce = true) {
    if (closed) throw new Error('数据库连接已关闭');
    if (workerError) {
      if (!retryOnce || !respawn()) throw new Error('数据库 worker 已挂：' + workerError.message);
    }
    const id = ++seq;
    const sab = new SharedArrayBuffer(4);
    const i32 = new Int32Array(sab);
    try {
      port1.postMessage({ ...msg, id, sab });
    } catch (e) {
      if (retryOnce && respawn()) return call(msg, timeoutMs, false);
      throw e;
    }
    const r = Atomics.wait(i32, 0, 0, timeoutMs);
    if (r === 'timed-out') {
      // 超时后 worker 可能还活着也可能死了，等它一会儿再看
      if (workerError && retryOnce && respawn()) return call(msg, timeoutMs, false);
      throw new Error(`数据库查询超时（${timeoutMs}ms）：${String(msg.sql).slice(0, 80)}`);
    }
    let m;
    // Atomics 唤醒后消息应该已经躺在端口队列里，取出来即可
    while ((m = receiveMessageOnPort(port1)) === undefined) { /* 自旋 */ }
    const out = m.message;
    if (!out.ok) {
      // worker 是因为未捕获异常挂的 → 重建后再试一次
      if (retryOnce && workerError && respawn()) return call(msg, timeoutMs, false);
      throw new Error(out.error);
    }
    return out;
  }

  /** 哪些表有 id 列（决定 INSERT 要不要补 RETURNING id），启动时查一次并缓存 */
  let idTables = null;
  function hasIdColumn (table) {
    if (!idTables) {
      try {
        const r = call({
          kind: 'query',
          sql: `SELECT table_name FROM information_schema.columns
                WHERE table_schema = current_schema() AND column_name = 'id'`,
        });
        idTables = new Set((r.rows || []).map(x => x.table_name));
      } catch { idTables = new Set() }
    }
    return idTables.has(table);
  }

  /**
   * 这张表有没有 id 列？
   *
   * 为什么不能「先试着带 RETURNING id，失败了再退回去」：
   * PG 里一条语句报错，**整个事务就被污染**，后面所有语句都会回
   * "current transaction is aborted"。而 saveSettings 这类逻辑包在 BEGIN/COMMIT 里，
   * 一失败整个事务就废了，重试也没用。所以必须**先问清楚**。
   *
   * 为什么不缓存「没有 id」：
   * 启动早期查询时，auth 的表可能还没建出来。那时把 users 记成「没有 id」，
   * 之后建账号就永远拿不到主键了（实测踩过）。所以只在**确认表已存在**时才缓存结论。
   */
  const idKnown = new Map();
  function tableHasId (t) {
    if (idKnown.has(t)) return idKnown.get(t);
    try {
      const r = call({
        kind: 'query',
        params: [t],
        sql: `SELECT
                (SELECT COUNT(*) FROM information_schema.tables
                  WHERE table_schema = current_schema() AND table_name = $1) AS tbl_exists,
                (SELECT COUNT(*) FROM information_schema.columns
                  WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'id') AS has_id`,
      });
      const row = (r.rows || [])[0] || {};
      const exists = Number(row.tbl_exists) > 0;
      const hasId = Number(row.has_id) > 0;
      if (exists) idKnown.set(t, hasId);   // 表确实存在，才敢把结论记下来
      return hasId;
    } catch {
      return false;   // 查不到就先当没有，下次再问
    }
  }

  function prepare (rawSql) {
    const sql = String(rawSql);

    // PRAGMA table_info(x)：SQLite 的方言，翻译成 PG 的系统表查询
    const pragmaTable = pragmaTableInfo(sql);
    if (pragmaTable) {
      const translated = `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = $1
        ORDER BY ordinal_position`;
      return {
        all: (...p) => call({ kind: 'query', sql: translated, params: [pragmaTable] }).rows || [],
        get: (...p) => (call({ kind: 'query', sql: translated, params: [pragmaTable] }).rows || [])[0],
        run: () => ({ changes: 0 }),
      };
    }

    // 建表之类的 DDL 走这里
    const isDdl = /^\s*CREATE\s+/i.test(sql);
    const finalSql = isDdl ? placeholders(ddl(sql)) : placeholders(functions(sql));

    // INSERT 要拿到自增主键：PG 没有 lastInsertRowid，得靠 RETURNING
    //
    // 这里刻意用「乐观 + 回退」而不是先查 information_schema：
    // 启动早期查一次列清单并缓存的话，那时 auth 的表可能还没建出来，
    // 缓存里就没有 users，之后所有建账号都拿不到 id（实测踩过）。
    // 改成默认补 RETURNING id，真没有 id 列再退回去 —— 不依赖启动顺序，能自愈。
    let wantId = false;
    let sqlToRun = finalSql;

    if (isInsert(finalSql) && !alreadyReturning(finalSql)) {
      const t = insertTable(finalSql);
      if (t && tableHasId(t)) { wantId = true; sqlToRun = finalSql + ' RETURNING id' }
    }

    const runQuery = (params) => {
      const r = call({ kind: 'query', sql: sqlToRun, params, wantId });
      return { changes: r.changes ?? 0, lastInsertRowid: r.lastInsertRowid };
    };

    return {
      all: (...params) => call({ kind: 'query', sql: sqlToRun, params }).rows || [],
      get: (...params) => (call({ kind: 'query', sql: sqlToRun, params }).rows || [])[0],
      run: (...params) => runQuery(params),
    };
  }

  return {
    dialect: DIALECT,
    url,
    file: url,
    raw: null,

    prepare,
    exec: (sql) => {
      // 多语句 DDL / BEGIN / COMMIT 都走这个；pg 的简单查询协议支持多语句
      const text = /^\s*CREATE\s+/i.test(sql) ? ddl(sql) : functions(sql);
      call({ kind: 'exec', sql: text });
    },
    close: () => { try { closed = true; call({ kind: 'close' }, 5000) } catch { /* 忽略 */ } try { worker.terminate() } catch { /* 忽略 */ } },

    /** PG 没有 WAL checkpoint，空操作（PG 自己会做 checkpoint） */
    checkpoint () { return { ok: true, note: 'PostgreSQL 由服务端自动 checkpoint，无需手动处理' } },

    /**
     * 备份。
     *
     * 三条路径，按后端选，产出物都能真正还原：
     *   postgres://  pg_dump（-Fc 自定义格式）—— 结构、索引、约束、序列全在
     *   pglite://     整份数据目录快照（.tar.gz）—— PGlite 没有 pg_dump 出口
     *   （退回）      逐表 JSON，只有数据没有结构，仅在找不到 pg_dump 时兜底
     *
     * 为什么不再默认用 JSON：客户真正的数据在这里，不能靠「记得去核对结构」。
     * 但 pg_dump 不一定存在（容器精简镜像没装、免 Docker 的环境没有），
     * 所以保留 JSON 兜底，并明确记录 format，界面上如实告诉用户备份了什么。
     */
    backupTo (destPath) {
      if (isPglite) return pgliteSnapshot(pgliteDir, destPath);
      try {
        return pgDumpTo(url, destPath);
      } catch (e) {
        // pg_dump 失败不能就这么把错误甩给用户 —— 先用 JSON 兜一份，
        // 保证「今天有一份能看的数据」这件事成立，再把 pg_dump 的原始错误带出去。
        try {
          const fb = jsonFallbackDump(call, destPath.replace(/\.db$/, '') + '.json');
          return { ...fb, degraded: true, pgDumpError: e.message };
        } catch (e2) {
          throw new Error(e.message + '（JSON 兜底也失败：' + e2.message + '）');
        }
      }
    },

    /** 备份的实际格式（界面要如实显示，别让用户以为备份了什么） */
    backupFormat () {
      if (isPglite) return { format: 'pglite-tar', restore: '整目录快照，需停止服务后解压回数据目录' };
      const fmt = whichPgDump();
      return fmt.available
        ? { format: 'pg_dump-Fc', restore: 'pg_restore 还原，结构与数据都在' }
        : { format: 'pg-json', restore: '仅数据表，索引与约束需重建（系统未找到 pg_dump）' };
    },

    /** 表有哪些列 */
    columns (table) {
      return prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    },
  };
}

module.exports = { open, DIALECT, placeholders, ddl, functions };
