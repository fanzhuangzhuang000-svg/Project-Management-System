'use strict';
/**
 * 账号与会话
 *
 * 设计：
 *  - 密码用 Node 内置 crypto.scrypt 加盐哈希，库里不存明文
 *  - 会话用 httpOnly Cookie + sessions 表，局域网内共享电脑时不会因为刷新掉线
 *  - 权限按「模块 × 读/写」授权，对应"根据管理内容创建账号"：
 *      perms = { all:false, read:[表名], write:[表名], sys:['trash','logs','import','backup','users'] }
 *    管理员用 { all:true } 直接放行
 */
const crypto = require('node:crypto');
const { db, nowISO } = require('./db.js');

const COOKIE = 'pms_session';
const SESSION_DAYS = 30;
const SYS_KEYS = ['users', 'trash', 'logs', 'import', 'backup', 'settings'];

// ---------------- 密码 ----------------
function hashPassword (pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword (pw, stored) {
  try {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const calc = crypto.scryptSync(String(pw), salt, 64);
    const want = Buffer.from(hash, 'hex');
    if (calc.length !== want.length) return false;
    return crypto.timingSafeEqual(calc, want);
  } catch { return false; }
}

const passwordProblem = (pw) => {
  const s = String(pw || '');
  if (s.length < 6) return '密码至少 6 位';
  if (s.length > 64) return '密码太长（最多 64 位）';
  if (/^\s+$/.test(s)) return '密码不能全是空格';
  return null;
};

// ---------------- 建表 ----------------
function createTable () {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    name TEXT,
    password TEXT NOT NULL,
    role TEXT DEFAULT 'custom',
    perms TEXT,
    status TEXT DEFAULT '启用',
    must_change_pw INTEGER DEFAULT 0,
    last_login_at TEXT,
    login_count INTEGER DEFAULT 0,
    remark TEXT,
    created_at TEXT,
    updated_at TEXT,
    tenant_id BIGINT DEFAULT 1
  );`);

  // 多租户：老库补 tenant_id 列。
  //
  // ⚠️ 迁移 v4 里也写了要给 users 加这个列，但**那个迁移对 users 是空转**：
  // v4 跑在 dbf.init() 里，而 users 表是 auth 在 init() 之后才建的，
  // 那时表还不存在，存在性检查直接跳过了 —— 所以这个列必须在这里补。
  try {
    if (!db.columns('users').includes('tenant_id')) {
      db.exec('ALTER TABLE users ADD COLUMN tenant_id BIGINT DEFAULT 1;');
    }
  } catch { /* 列已存在之类，忽略 */ }
  db.exec(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT,
    expires_at TEXT,
    last_seen TEXT,
    ip TEXT,
    agent TEXT
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);');
  // 登录失败记录：用于连续输错后短时锁定，防局域网内被暴力破解
  db.exec(`CREATE TABLE IF NOT EXISTS login_fails (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT,
    username TEXT,
    at_ms INTEGER NOT NULL
  );`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_loginfails_ms ON login_fails(at_ms);');
}

// ---------------- 登录限速 ----------------
// 同一账号 15 分钟内错 5 次 → 锁 10 分钟（严格，保护账号本身）
// 同一 IP  15 分钟内错 20 次 → 锁 10 分钟（宽松，防止一个人手滑把同事一起锁住）
const LOGIN_MAX_FAILS = 5;
const LOGIN_IP_MAX_FAILS = 20;
const LOGIN_WINDOW_MIN = 15;
const LOGIN_LOCK_MIN = 10;

function _countSince (col, val, since) {
  return db.prepare(`SELECT COUNT(*) n, MAX(at_ms) m FROM login_fails WHERE ${col} = ? AND at_ms >= ?`).get(String(val || ''), since);
}

/**
 * 检查是否处于锁定状态。
 * 返回 { locked, fails, left, remainSec? }
 */
function loginLock (ip, username) {
  const now = Date.now();
  const win = now - LOGIN_WINDOW_MIN * 60000;
  const lockMs = LOGIN_LOCK_MIN * 60000;

  const byUser = _countSince('username', username, win);
  const byIp = _countSince('ip', ip, win);

  const hits = [];
  if (byUser.n >= LOGIN_MAX_FAILS) hits.push({ scope: '账号', n: byUser.n, last: byUser.m });
  if (byIp.n >= LOGIN_IP_MAX_FAILS) hits.push({ scope: '来源', n: byIp.n, last: byIp.m });

  if (hits.length) {
    const until = Math.max(...hits.map(h => h.last)) + lockMs;
    if (now < until) {
      return { locked: true, scope: hits[0].scope, fails: byUser.n, left: 0, remainSec: Math.ceil((until - now) / 1000), untilMs: until };
    }
    // 锁定时间已过，清掉旧记录重新开始
    db.prepare('DELETE FROM login_fails WHERE ip = ? OR username = ?').run(String(ip || ''), String(username || ''));
    return { locked: false, fails: 0, left: LOGIN_MAX_FAILS };
  }
  return { locked: false, fails: byUser.n, left: Math.max(0, LOGIN_MAX_FAILS - byUser.n) };
}

function recordLoginFail (ip, username) {
  db.prepare('INSERT INTO login_fails (ip, username, at_ms) VALUES (?,?,?)').run(String(ip || ''), String(username || ''), Date.now());
  db.prepare('DELETE FROM login_fails WHERE at_ms < ?').run(Date.now() - 86400000);   // 顺手清理 1 天前的
  return loginLock(ip, username);
}

/** 登录成功 / 管理员手动解锁 */
function clearLoginFails (ip, username) {
  return Number(db.prepare('DELETE FROM login_fails WHERE ip = ? OR username = ?').run(String(ip || ''), String(username || '')).changes);
}

/** 清空所有失败记录（管理员"全部解锁"） */
function clearAllLoginFails () {
  return Number(db.prepare('DELETE FROM login_fails').run().changes);
}

/** 当前有失败记录或正被锁定的账号/IP（系统设置里展示，管理员可一键解锁） */
function loginLockStats () {
  const now = Date.now();
  const win = now - LOGIN_WINDOW_MIN * 60000;
  const lockMs = LOGIN_LOCK_MIN * 60000;
  const rows = db.prepare(`SELECT ip, username, COUNT(*) n, MAX(at_ms) m
    FROM login_fails WHERE at_ms >= ? GROUP BY ip, username ORDER BY m DESC`).all(win);
  const byUser = {}, byIp = {};
  for (const r of rows) {
    byUser[r.username] = (byUser[r.username] || 0) + r.n;
    byIp[r.ip] = (byIp[r.ip] || 0) + r.n;
  }
  return rows.map(r => {
    const until = Math.max(
      byUser[r.username] >= LOGIN_MAX_FAILS ? r.m + lockMs : 0,
      byIp[r.ip] >= LOGIN_IP_MAX_FAILS ? r.m + lockMs : 0,
    );
    return {
      ip: r.ip, username: r.username, fails: r.n,
      scope: byIp[r.ip] >= LOGIN_IP_MAX_FAILS ? '来源' : (byUser[r.username] >= LOGIN_MAX_FAILS ? '账号' : ''),
      locked: until > now,
      remainSec: until > now ? Math.ceil((until - now) / 1000) : 0,
    };
  });
}

// ---------------- 权限 ----------------
const ALL_TABLES = () => require('./schema.js').TABLE_ORDER;

function parsePerms (u) {
  if (!u) return { all: false, read: [], write: [], sys: [] };
  if (u.role === 'admin') return { all: true, read: ALL_TABLES(), write: ALL_TABLES(), sys: SYS_KEYS.slice() };
  let p = {};
  try { p = JSON.parse(u.perms || '{}'); } catch { p = {}; }
  return {
    all: !!p.all,
    read: Array.isArray(p.read) ? p.read : [],
    write: Array.isArray(p.write) ? p.write : [],
    sys: Array.isArray(p.sys) ? p.sys : [],
  };
}
const canRead = (perms, table) => !!(perms && (perms.all || perms.read.includes(table)));
const canWrite = (perms, table) => !!(perms && (perms.all || perms.write.includes(table)));
const canSys = (perms, key) => !!(perms && (perms.all || perms.sys.includes(key)));

/** 公开给前端的用户信息（不含密码） */
function publicUser (u) {
  if (!u) return null;
  const perms = parsePerms(u);
  return {
    id: u.id, username: u.username, name: u.name || u.username,
    role: u.role, status: u.status,
    must_change_pw: !!u.must_change_pw,
    last_login_at: u.last_login_at, login_count: u.login_count || 0,
    perms,
  };
}

// ---------------- 会话 ----------------
function createSession (user, req) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const exp = new Date(now.getTime() + SESSION_DAYS * 86400000);
  const iso = d => d.toISOString().slice(0, 19).replace('T', ' ');
  db.prepare(`INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen, ip, agent)
    VALUES (?,?,?,?,?,?,?)`).run(
    token, user.id, nowISO(), iso(exp), nowISO(),
    (req && req.socket && req.socket.remoteAddress) || null,
    String((req && req.headers['user-agent']) || '').slice(0, 200),
  );
  return { token, expiresAt: iso(exp) };
}

function cookieHeader (token, maxAgeSec) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}
function clearCookieHeader () {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function parseCookies (req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of String(raw).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    // Cookie 值可能带非法百分号（%%），decodeURIComponent 会抛 URIError，必须兜住
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}

/** 从请求里取当前用户（校验会话有效性 + 账号是否被停用） */
function fromRequest (req) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!s) return null;
  if (s.expires_at && s.expires_at < nowISO()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
  if (!u || u.status !== '启用') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  // 滑动续期：每次访问把有效期往后推
  const exp = new Date(Date.now() + SESSION_DAYS * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE token = ?').run(nowISO(), exp, token);
  return { ...u, token, perms: parsePerms(u) };
}

function destroySession (req) {
  const token = parseCookies(req)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function destroyUserSessions (userId) {
  return Number(db.prepare('DELETE FROM sessions WHERE user_id = ?').run(parseInt(userId, 10)).changes);
}

function purgeExpired () {
  return Number(db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowISO()).changes);
}

// ---------------- 用户 ----------------
const DEFAULT_ADMIN = { username: 'admin', password: 'admin123', name: '系统管理员' };

/** 首次启动创建 admin 账号；已有用户则不动 */
function ensureAdmin () {
  const n = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  if (n > 0) return { created: false, total: n };
  const ts = nowISO();
  db.prepare(`INSERT INTO users (username, name, password, role, perms, status, must_change_pw, remark, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    DEFAULT_ADMIN.username, DEFAULT_ADMIN.name, hashPassword(DEFAULT_ADMIN.password),
    'admin', JSON.stringify({ all: true }), '启用', 1,
    '首次启动自动创建，请尽快修改密码', ts, ts,
  );
  return { created: true, ...DEFAULT_ADMIN, total: 1 };
}

function listUsers () {
  return db.prepare('SELECT * FROM users ORDER BY id ASC').all().map(u => ({
    ...publicUser(u),
    remark: u.remark, created_at: u.created_at,
  }));
}

function getUser (id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(parseInt(id, 10)) || null;
}
function getUserByName (username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || '').trim()) || null;
}

function countAdmins (excludeId) {
  const rows = db.prepare("SELECT id, role, perms FROM users WHERE status = '启用'").all();
  return rows.filter(r => r.id !== excludeId && parsePerms(r).all).length;
}

/** 已启用的账号数（授权的账号数上限用它判定；停用的不占额度） */
function countActiveUsers () {
  const row = db.prepare("SELECT COUNT(*) AS n FROM users WHERE status = '启用'").get();
  return Number((row && row.n) || 0);
}

function saveUser (input, operator) {
  const id = input.id ? parseInt(input.id, 10) : 0;
  const username = String(input.username || '').trim();
  const name = String(input.name || '').trim() || username;
  const role = String(input.role || 'custom');
  const status = input.status === '停用' ? '停用' : '启用';
  const remark = String(input.remark || '').trim() || null;
  const perms = role === 'admin'
    ? { all: true }
    : {
        all: false,
        read: Array.isArray(input.read) ? input.read : [],
        write: Array.isArray(input.write) ? input.write : [],
        sys: Array.isArray(input.sys) ? input.sys : [],
      };
  const ts = nowISO();

  if (!username) return { error: '登录账号不能为空' };
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) return { error: '登录账号只能用字母、数字、下划线、点、横线（2~32 位）' };

  if (id) {
    const cur = getUser(id);
    if (!cur) return { error: '账号不存在' };
    // 不允许把自己停用或降权，避免把自己锁在门外
    if (operator && operator.id === id) {
      if (status !== '启用') return { error: '不能停用当前登录的账号' };
      if (role !== 'admin' && parsePerms(cur).all) return { error: '不能取消自己的管理员身份' };
    }
    const dup = getUserByName(username);
    if (dup && dup.id !== id) return { error: '登录账号「' + username + '」已被占用' };
    if (cur.role === 'admin' && role !== 'admin' && countAdmins(id) === 0) {
      return { error: '至少要保留一个管理员账号' };
    }
    db.prepare(`UPDATE users SET username=?, name=?, role=?, perms=?, status=?, remark=?, updated_at=? WHERE id=?`)
      .run(username, name, role, JSON.stringify(perms), status, remark, ts, id);
    if (status !== '启用') destroyUserSessions(id);
    if (input.password) {
      const p = passwordProblem(input.password);
      if (p) return { error: p };
      db.prepare('UPDATE users SET password=?, must_change_pw=0, updated_at=? WHERE id=?').run(hashPassword(input.password), ts, id);
      destroyUserSessions(id);
    }
    return { ok: true, id };
  }

  if (getUserByName(username)) return { error: '登录账号「' + username + '」已存在' };
  const pw = input.password || '123456';
  const p = passwordProblem(pw);
  if (p) return { error: p };
  const info = db.prepare(`INSERT INTO users (username, name, password, role, perms, status, must_change_pw, remark, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
    username, name, hashPassword(pw), role, JSON.stringify(perms), status,
    input.must_change_pw ? 1 : 0, remark, ts, ts,
  );
  return { ok: true, id: Number(info.lastInsertRowid) };
}

function deleteUser (id, operator) {
  const u = getUser(id);
  if (!u) return { error: '账号不存在' };
  if (operator && operator.id === u.id) return { error: '不能删除当前登录的账号' };
  if (parsePerms(u).all && countAdmins(u.id) === 0) return { error: '至少要保留一个管理员账号' };
  destroyUserSessions(u.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
  return { ok: true };
}

function resetPassword (id, newPw, mustChange) {
  const u = getUser(id);
  if (!u) return { error: '账号不存在' };
  const pw = newPw || '123456';
  const p = passwordProblem(pw);
  if (p) return { error: p };
  db.prepare('UPDATE users SET password=?, must_change_pw=?, updated_at=? WHERE id=?')
    .run(hashPassword(pw), mustChange ? 1 : 0, nowISO(), u.id);
  destroyUserSessions(u.id);
  return { ok: true };
}

function changeOwnPassword (user, oldPw, newPw) {
  const u = getUser(user.id);
  if (!u) return { error: '账号不存在' };
  if (!verifyPassword(oldPw, u.password)) return { error: '原密码不正确' };
  const p = passwordProblem(newPw);
  if (p) return { error: p };
  if (String(oldPw) === String(newPw)) return { error: '新密码不能和原密码相同' };
  db.prepare('UPDATE users SET password=?, must_change_pw=0, updated_at=? WHERE id=?')
    .run(hashPassword(newPw), nowISO(), u.id);
  return { ok: true };
}

function markLogin (userId) {
  db.prepare('UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?').run(nowISO(), userId);
}

/** 是否处于"刚建好管理员、还没登录过"的状态（登录页据此提示初始密码） */
function firstRunPending () {
  const u = getUserByName(DEFAULT_ADMIN.username);
  return !!(u && u.must_change_pw && (u.login_count || 0) === 0);
}

module.exports = {
  COOKIE, SESSION_DAYS, SYS_KEYS, DEFAULT_ADMIN,
  LOGIN_MAX_FAILS, LOGIN_IP_MAX_FAILS, LOGIN_LOCK_MIN, LOGIN_WINDOW_MIN,
  createTable, hashPassword, verifyPassword, passwordProblem,
  parsePerms, canRead, canWrite, canSys, publicUser,
  loginLock, recordLoginFail, clearLoginFails, clearAllLoginFails, loginLockStats,
  createSession, cookieHeader, clearCookieHeader, fromRequest, destroySession, destroyUserSessions, purgeExpired,
  ensureAdmin, listUsers, getUser, getUserByName, saveUser, deleteUser, resetPassword, changeOwnPassword, markLogin,
  countAdmins, countActiveUsers, firstRunPending,
};
