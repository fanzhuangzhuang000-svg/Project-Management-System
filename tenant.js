'use strict';
/**
 * 租户上下文
 *
 * ── 设计原则：单机版行为一个字节都不变 ──
 * 多租户只在 `MULTI_TENANT=1` 时生效。没开的时候：
 *   · 不往查询里加任何条件
 *   · 所有新数据 tenant_id 都是 1
 *   · 界面上看不到「租户管理」入口
 * 所以现有单机客户升级上来，行为和以前完全一样。
 *
 * 开了之后，数据访问层会自动带上 tenant_id 条件，
 * 一个账号只能看到自己租户的数据。
 *
 * ── 为什么用环境变量而不是界面开关 ──
 * 这是**部署形态**的区别，不是用户偏好。让客户在界面上误关一下就可能
 * 把隔离关掉，风险太大；放在 .env 里由部署的人决定更稳妥。
 */
const dbf = () => require('./db.js');

// ── 租户上下文为什么必须用 AsyncLocalStorage ──
//
// 以前是一个模块级变量 `let current = 1`。在「一个请求从头到尾同步跑完」的理想情况下
// 还没问题，但这套服务是 async 的：handleApi 里到处是 await（读请求体、附件、AI 调用）。
// 一旦在 await 处让出事件循环，另一个用户的请求就会插进来执行，
// 它调的 setTenant() 会把这个**共享变量**改掉 —— 回到第一个请求时，
// 它后面的查询就带上了别人的 tenant_id。
//
// 这类串号不会报错，只会在某个时刻把 A 部门的数据算进 B 部门，
// 而且越是并发高越容易出现 —— 恰好是「公司几十人一起用」的场景。
//
// AsyncLocalStorage 是 Node 内建的「按异步调用链隔离的存储」：
// 每个请求在自己的上下文里读写，await 前后自动保持一致，互不干扰。
// 没有上下文时（脚本、测试直接调用）退回 fallback，行为与以前一致。
const { AsyncLocalStorage } = require('node:async_hooks');
const als = new AsyncLocalStorage();

/** 没有请求上下文时的值（脚本/测试直接用 dbf 时走这里） */
let fallbackTenant = 1;

/** 是否启用多租户隔离 */
function isMultiTenant () {
  const v = String(process.env.MULTI_TENANT || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function currentTenant () {
  const store = als.getStore();
  return store ? store.tenantId : fallbackTenant;
}

/** 切换当前请求的租户（登录时按账号的 tenant_id 设置） */
function setTenant (id) {
  const n = Number(id);
  const v = Number.isFinite(n) && n > 0 ? n : 1;
  const store = als.getStore();
  if (store) { store.tenantId = v; return v; }
  fallbackTenant = v;
  return v;
}

/**
 * 在一个租户上下文里执行 fn。
 * 服务端每个请求入口都要用它包一层，否则 currentTenant() 拿到的是 fallback。
 */
function runWithTenant (id, fn) {
  const n = Number(id);
  return als.run({ tenantId: Number.isFinite(n) && n > 0 ? n : 1 }, fn);
}

function reset () {
  const store = als.getStore();
  if (store) store.tenantId = 1;
  else fallbackTenant = 1;
}

/**
 * 给查询加上租户条件。
 * 单机模式下返回空串 —— 保证不改动现有 SQL。
 * @param {string} [alias] 表别名，如 't.' 或 'p.'
 */
function where (alias = '') {
  // 单机模式返回空串 —— 调用方据此判断「不加任何条件」，
  // 这样现有的 SQL 一个字都不会变。
  return isMultiTenant() ? alias + 'tenant_id = ' + currentTenant() : '';
}

/** 新插入的行该带什么 tenant_id */
function stampTenant () {
  return currentTenant();
}

/**
 * 确保所有该有 tenant_id 的表都有这一列。
 *
 * ── 为什么需要这个 ──
 * 迁移 v4 里写了要给 logs / snapshots 等表加 tenant_id，但**那对它们是空转的**：
 * v4 跑在 dbf.init() 里，而这些表是各自模块（logs.js / snapshots.js / trash.js…）
 * 在 init() 之后才建的 —— 存在性检查直接跳过。
 * 已经因此踩过两次（users、attachments），扫描后发现一共 6 张表缺列。
 *
 * 与其去每个模块里各补一次（还可能漏掉以后新增的表），不如**统一收口**：
 * 在所有模块建完表之后调一次这个函数，缺哪列补哪列。
 *
 * 幂等，可以反复调；单机模式下也只是把默认值 1 补上，不影响任何行为。
 */
function ensureColumns () {
  const db = dbf().db;
  const tables = ['projects', 'contracts', 'contract_changes', 'schedules', 'payments',
    'invoices', 'expenses', 'materials', 'partners', 'maintenance', 'attachments',
    'logs', 'snapshots', 'trash', 'users', 'sessions', 'login_fails'];
  const added = [];
  for (const t of tables) {
    try {
      const exists = db.dialect === 'postgres'
        ? !!db.prepare(`SELECT table_name FROM information_schema.tables
            WHERE table_schema = current_schema() AND table_name = ?`).get(t)
        : !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (!exists) continue;                       // 表还没建，不是错误
      if (db.columns(t).includes('tenant_id')) continue;
      db.exec(`ALTER TABLE "${t}" ADD COLUMN tenant_id BIGINT DEFAULT 1;`);
      added.push(t);
    } catch { /* 单张表失败不拖累其它表 */ }
  }
  return added;
}

/** 租户清单（超级管理员用） */function list () {
  try {
    return dbf().db.prepare('SELECT * FROM tenants ORDER BY id').all();
  } catch {
    return [];
  }
}

function get (id) {
  try {
    return dbf().db.prepare('SELECT * FROM tenants WHERE id = ?').get(Number(id));
  } catch {
    return null;
  }
}

/**
 * 新建租户。
 *
 * 需求里说「新建租户 = 自动建好一套空数据库结构 + 一个管理员账号」。
 * 但**私有化部署是一个客户一套库**，表结构本来就共用（只靠 tenant_id 区分），
 * 所以这里不需要真的建表 —— 建一个租户记录 + 一个管理员账号即可。
 * 真要做 SaaS 把多个客户放一个库里，这套逻辑也不用改。
 */
function create ({ name, contact, phone, expiry, adminUser, adminPassword } = {}) {
  const db = dbf().db;
  const nm = String(name || '').trim();
  if (!nm) return { error: '租户名称不能为空' };

  // 时间戳用本地时间：同库的其它时间字段都是本地时间串，混着 UTC 会差一个时区
  const ts = dbf().nowISO();
  let id;
  db.exec('BEGIN');
  try {
    const maxId = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM tenants').get().m;
    id = Number(maxId) + 1;
    db.prepare(`INSERT INTO tenants (id, name, contact, phone, expiry, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, '启用', ?, ?)`)
      .run(id, nm, contact || null, phone || null, expiry || null, ts, ts);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* 忽略 */ }
    return { error: '建租户失败：' + e.message };
  }

  // 给这个租户建一个管理员账号
  let user = null;
  if (adminUser) {
    try {
      const auth = require('./auth.js');
      // users 表是 auth 自己建的，跑在 init() 之后。
      // 这里必须先确保表在，否则 saveUser 会报 "no such table: users"。
      auth.createTable();
      const r = auth.saveUser({
        username: String(adminUser).trim(),
        name: nm + ' 管理员',
        role: 'admin',
        password: adminPassword || 'admin123',
        status: '启用',
        remark: `租户 ${id} 的管理员`,
      }, null);
      if (r.id) {
        db.prepare('UPDATE users SET tenant_id = ? WHERE id = ?').run(id, r.id);
        user = { id: r.id, username: adminUser };
      }
    } catch (e) {
      return { ok: true, id, warning: '租户建好了，但管理员账号没建成：' + e.message };
    }
  }

  return { ok: true, id, user };
}

/** 改租户（改名、停用、改到期日） */
function update (id, patch = {}) {
  const db = dbf().db;
  const cur = get(id);
  if (!cur) return { error: '租户不存在' };
  // 时间戳用本地时间：同库的其它时间字段都是本地时间串，混着 UTC 会差一个时区
  const ts = dbf().nowISO();
  const fields = [];
  const vals = [];
  for (const k of ['name', 'contact', 'phone', 'expiry', 'status', 'remark']) {
    if (patch[k] !== undefined) { fields.push(`${k} = ?`); vals.push(patch[k]) }
  }
  if (!fields.length) return { error: '没有要改的内容' };
  fields.push('updated_at = ?');
  vals.push(ts, Number(id));
  try {
    db.prepare(`UPDATE tenants SET ${fields.join(', ')} WHERE id = ?`).run(...vals);
    return { ok: true, tenant: get(id) };
  } catch (e) {
    return { error: '保存失败：' + e.message };
  }
}

/** 每个租户各有多少数据（租户管理页显示用） */
function stats (id) {
  const db = dbf().db;
  const out = {};
  for (const t of ['projects', 'contracts', 'payments', 'invoices', 'users']) {
    try {
      out[t] = Number(db.prepare(`SELECT COUNT(*) AS n FROM "${t}" WHERE tenant_id = ?`).get(Number(id)).n);
    } catch { out[t] = 0 }
  }
  return out;
}

/** 租户数量（判断要不要显示「租户管理」入口） */
function count () {
  try { return Number(dbf().db.prepare('SELECT COUNT(*) AS n FROM tenants').get().n) } catch { return 1 }
}

module.exports = {
  isMultiTenant, currentTenant, setTenant, runWithTenant, reset,
  where, scope: where, stampTenant,
  list, get, create, update, stats, count, ensureColumns,
};
