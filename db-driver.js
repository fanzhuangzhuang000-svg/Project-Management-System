'use strict';
/**
 * 数据库驱动选择器
 *
 *   DB_URL 没配 / 是文件路径        → SQLite（单机版，零依赖，双击就能用）
 *   DB_URL=postgres://...          → PostgreSQL（专业版 / 网络版，Docker 部署）
 *
 * ── 为什么能用同一份同步业务代码跑在异步的 PG 上 ──
 * db.js 有 1700 行同步代码（node:sqlite 是同步 API）。pg 是异步的。
 * 如果为此把整个数据层改成 async，改动面太大、风险太高。
 * 所以 adapter-pg 用「worker 线程跑 pg + 主线程 Atomics.wait 等结果」
 * 把异步包装成同步：业务层看到的就是一个普通的同步句柄。
 *
 * 代价：一次查询期间主线程是阻塞的 —— 但同步 SQLite 本来就是这样，
 * 对「2-5 人的局域网工具」这个场景完全够用。
 */
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.PMS_DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_URL = String(process.env.DB_URL || '').trim();

function isPg (url) {
  // postgres:// = 独立 PG 服务器；pglite:// = 进程内 WASM Postgres（不用装服务器）
  return /^(postgres(ql)?|pglite):\/\//i.test(url);
}

function openDb () {
  if (isPg(DB_URL)) {
    // 只在真的用 PG 时才 require pg —— 单机版装机包里没有这个依赖，也不该有
    const adapter = require('./adapter-pg.js');
    return adapter.open({ url: DB_URL });
  }
  return require('./adapter-sqlite.js').open({ dataDir: DATA_DIR });
}

// ★「这个库本来就存在吗」必须在**打开连接之前**判断。打开连接这个动作
// 本身就会创建 pms.db 文件，所以以前在 openDb() 之后算 fs.existsSync 是恒为 true 的。
// 后果很隐蔽：server.js 里「首次启动才写 .env 初始配置」那一整块（公司名、
// 管理员初始密码、AI 助手默认配置）在 SQLite 下**永远不会执行**；PG 下因为硬编码
// false 反而正常 —— 专业版测试用的正是 PG，所以一直没暴露。
const EXISTED_BEFORE_OPEN = isPg(DB_URL) ? false : fs.existsSync(require("node:path").join(DATA_DIR, "pms.db"));
const db = openDb();

/** 给日志/界面用的一句话描述 */
function describe () {
  if (db.dialect === 'postgres') {
    // 别把密码打到日志里
    const safe = String(DB_URL).replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');
    return 'PostgreSQL  ' + safe;
  }
  return 'SQLite  ' + db.file;
}

module.exports = {
  db,
  dialect: db.dialect,
  describe,
  DB_URL,
  DATA_DIR,
  isPg: db.dialect === 'postgres',
  // SQLite 模式下是 pms.db 的路径；PG 模式下是连接串（界面显示用）
  DB_FILE: db.dialect === 'postgres' ? DB_URL : db.file,
  DB_EXISTED: EXISTED_BEFORE_OPEN,
};
