'use strict';
/**
 * 附件存储层：文件落盘 + 元数据入库 + 识别结果持久化
 * 文件目录： data/attachments/<年月>/<随机名>.<ext>
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, DATA_DIR, nowISO, projectChildTables } = require('./db.js');
// 多租户：只在 MULTI_TENANT=1 时生效，单机模式下 scope() 返回空串（SQL 一字不改）
const tenantCtx = require('./tenant.js');

// 附件存哪由存储层决定：本地目录（单机版）或 MinIO（网络版）
// 业务代码只调 storage.save / localPath / remove，不关心文件实际在哪
const { storage } = require('./storage.js');
const ATTACH_DIR = storage.baseDir;

// 可上传的类型；前一组支持 OCR 识别
const OCR_EXT = ['.pdf', '.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp', '.gif'];
const ALLOW_EXT = new Set([...OCR_EXT, '.doc', '.docx', '.xls', '.xlsx', '.txt', '.csv', '.dwg', '.dxf', '.zip', '.rar', '.7z', '.ofd']);
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.bmp', '.tif', '.tiff', '.webp', '.gif'];

const MIME = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.webp': 'image/webp',
  '.gif': 'image/gif', '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.dwg': 'application/acad', '.dxf': 'application/dxf', '.ofd': 'application/ofd',
};

// 项目下的子记录表：**只能在这里维护一份**。
// 之前 attachments.js 的三处枚举各自写死一份，漏了 schedules ——
// 而 db.js 级联删除（SCHEDULE 的 childTables）是包含它的，
// 结果就是「记录被删了，挂在它身上的附件既没保留也没清理」，
// 变成 record_id 指向不存在行、purgeOrphans 又看不见的永久脏数据。
// 少写一张表 = 那张表的附件全部悬空，所以统一从 db.js 取。
const PROJECT_CHILD_TABLES = projectChildTables();

// 目录/桶由存储层在初始化时准备好，这里保留成空操作（老代码还在调它）
function ensureDir () { /* storage 已就绪 */ }

function createTable () {
  db.exec(`CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT,
    table_name TEXT,
    record_id INTEGER,
    project_id INTEGER,
    original_name TEXT,
    stored_name TEXT,
    ext TEXT,
    mime TEXT,
    size INTEGER DEFAULT 0,
    category TEXT,
    ocr_status TEXT DEFAULT 'none',
    ocr_error TEXT,
    ocr_kind TEXT,
    ocr_confidence INTEGER,
    ocr_text TEXT,
    ocr_fields TEXT,
    ocr_engine TEXT,
    ocr_at TEXT,
    is_demo INTEGER DEFAULT 0,
    detached INTEGER DEFAULT 0,
    uploaded_by INTEGER,
    created_at TEXT,
    updated_at TEXT,
    tenant_id BIGINT DEFAULT 1
  );`);
  // 兼容老库：补上后加的列
  const cols = new Set(db.prepare('PRAGMA table_info(attachments)').all().map(r => r.name));
  if (!cols.has('detached')) db.exec('ALTER TABLE attachments ADD COLUMN detached INTEGER DEFAULT 0;');
  // 上传者。暂存附件（还没挂到记录上）按上传者隔离 —— 没有这一列时，
  // canSeeAttachment 只能对所有人放行，等于谁都能翻到别人传的发票原图
  // （票面含税号、开户行、银行账号）。
  if (!cols.has('uploaded_by')) db.exec('ALTER TABLE attachments ADD COLUMN uploaded_by INTEGER;');
  // 多租户：迁移 v4 里也想给 attachments 加 tenant_id，但那个迁移跑在 dbf.init() 里，
  // 而这张表是这里才建的 —— 和 users 表一样，v4 对它其实是空转。
  // 所以必须在这里补，否则新库永远没有这一列。
  if (!cols.has('tenant_id')) db.exec('ALTER TABLE attachments ADD COLUMN tenant_id BIGINT DEFAULT 1;');
  db.exec('CREATE INDEX IF NOT EXISTS idx_attach_record ON attachments(table_name, record_id);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_attach_token ON attachments(token);');
  db.exec('CREATE INDEX IF NOT EXISTS idx_attach_project ON attachments(project_id);');
}

const extOf = name => path.extname(String(name || '')).toLowerCase();
const isOcrExt = ext => OCR_EXT.includes(ext);
const mimeOf = ext => MIME[ext] || 'application/octet-stream';
const isImage = ext => IMAGE_EXT.includes(ext);

/** 原始文件名只用于显示与下载，先做安全化处理 */
function safeDisplayName (name) {
  return String(name || 'file').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 180) || 'file';
}

/**
 * 附件的**本地可读路径**。
 * 本地存储直接返回磁盘路径；MinIO 会先把对象下到缓存再返回路径
 * —— OCR 引擎只认本地文件（路径穿越防护在 storage-local 里做了）。
 */
function absPathOf (storedName) {
  return storage.localPath(storedName);
}

// ---------------- 写入 ----------------
function add ({ buffer, originalName, tableName, recordId, token, category, projectId, uploadedBy }) {
  const ext = extOf(originalName);
  if (!ALLOW_EXT.has(ext)) {
    const e = new Error(`不支持的文件类型 ${ext || '(无扩展名)'}`);
    e.code = 'EXT';
    throw e;
  }
  const ym = nowISO().slice(0, 7).replace('-', '');
  // 存储键用 / 分隔（对象存储的惯例），本地存储会转成目录
  const storedName = ym + '/' + crypto.randomBytes(9).toString('hex') + ext;
  storage.save(storedName, buffer);

  // 没显式传 project_id 时，从「挂在哪条记录上」反查出来。
  // 不做这一步的话，直接上传到具体记录的附件 project_id 恒为 null ——
  // 删除项目时既匹配不到 table_name+record_id（子表枚举可能不全），
  // 也匹配不到 project_id 兜底查询，附件就会变成悬空脏数据。
  const pid = projectId ? parseInt(projectId, 10)
    : (tableName && recordId ? resolveProjectId(tableName, recordId) : null);

  const ts = nowISO();
  const info = db.prepare(`INSERT INTO attachments
    (token, table_name, record_id, project_id, original_name, stored_name, ext, mime, size, category,
     ocr_status, is_demo, uploaded_by, created_at, updated_at, tenant_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)`).run(
    token || null,
    tableName || null,
    recordId ? parseInt(recordId, 10) : null,
    pid,
    safeDisplayName(originalName),
    storedName,
    ext,
    mimeOf(ext),
    buffer.length,
    category || null,
    isOcrExt(ext) ? 'pending' : 'unsupported',
    uploadedBy ? parseInt(uploadedBy, 10) : null,
    ts, ts,
    // 单机模式下永远是 1
    tenantCtx.stampTenant(),
  );
  return get(Number(info.lastInsertRowid));
}

function get (id) {
  // ★ 多租户：下载走的就是 get()，这里不隔离的话，知道附件 id
  // 就能把别人公司的合同扫描件下走 —— 附件泄漏比看金额严重得多。
  const tc = tenantCtx.scope('');
  return db.prepare('SELECT * FROM attachments WHERE id = ?' + (tc ? ` AND ${tc}` : ''))
    .get(parseInt(id, 10)) || null;
}

function remove (id) {
  const row = get(id);
  if (!row) return { deleted: 0 };
  db.prepare('DELETE FROM attachments WHERE id = ?').run(row.id);
  storage.remove(row.stored_name);
  return { deleted: 1 };
}

function update (id, patch) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  db.prepare(`UPDATE attachments SET ${keys.map(k => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
    .run(...keys.map(k => patch[k]), nowISO(), parseInt(id, 10));
}

// ---------------- 查询 ----------------
function list (f = {}) {
  const where = [];
  const params = [];
  if (f.table_name) { where.push('table_name = ?'); params.push(f.table_name); }
  if (f.record_id) { where.push('record_id = ?'); params.push(parseInt(f.record_id, 10)); }
  if (f.project_id) { where.push('project_id = ?'); params.push(parseInt(f.project_id, 10)); }
  if (f.token) { where.push('token = ?'); params.push(f.token); }
  if (f.status) { where.push('ocr_status = ?'); params.push(f.status); }
  if (f.only_orphan === '1') where.push('record_id IS NULL');
  if (f.q) {
    where.push('(original_name LIKE ? OR ocr_text LIKE ?)');
    params.push(`%${f.q}%`, `%${f.q}%`);
  }
  // ★ 多租户：列表也要隔离，否则别人的附件名/识别内容全会显示出来。
  // 单机模式下 scope() 是空串，这条不会被加进去。
  const tcL = tenantCtx.scope('');
  if (tcL) where.push(tcL);
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM attachments ${whereSQL} ORDER BY id DESC`).all(...params);

  // 附加归属对象名称，便于在附件库里直接看出这是哪份合同/发票
  const nameCache = {};
  const nameOf = (t, id) => {
    if (!t || !id) return null;
    const key = t + ':' + id;
    if (key in nameCache) return nameCache[key];
    let v = null;
    try {
      const display = { projects: 'name', contracts: 'name', invoices: 'invoice_no', payments: 'voucher_no', materials: 'name', partners: 'name' }[t] || 'id';
      const r = db.prepare(`SELECT ${display} AS v FROM ${t} WHERE id = ?`).get(id);
      v = r && r.v ? String(r.v) : `#${id}`;
    } catch { v = `#${id}`; }
    nameCache[key] = v;
    return v;
  };
  for (const r of rows) {
    r.record_label = nameOf(r.table_name, r.record_id);
    r.has_ocr = r.ocr_status === 'done';
  }
  const totalSize = rows.reduce((s, r) => s + (r.size || 0), 0);
  return { rows, total: rows.length, totalSize };
}

function stats () {
  const r = db.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(size),0) AS bytes,
      SUM(CASE WHEN ocr_status='done' THEN 1 ELSE 0 END) AS done,
      SUM(CASE WHEN ocr_status='pending' OR ocr_status='running' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN ocr_status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN record_id IS NULL AND detached = 0 THEN 1 ELSE 0 END) AS orphan,
      SUM(CASE WHEN detached = 1 THEN 1 ELSE 0 END) AS detached
    FROM attachments`).get();
  return {
    total: r.total, bytes: r.bytes, done: r.done || 0, pending: r.pending || 0,
    failed: r.failed || 0, orphan: r.orphan || 0, detached: r.detached || 0,
  };
}

// ---------------- 关联 ----------------
/** 表单保存后，把本次上传的暂存附件挂到新记录上 */
function linkByToken (token, tableName, recordId) {
  if (!token || !recordId) return 0;
  const projectId = resolveProjectId(tableName, recordId);
  const info = db.prepare(`UPDATE attachments SET table_name = ?, record_id = ?, project_id = COALESCE(?, project_id), token = NULL, updated_at = ?
    WHERE token = ? AND record_id IS NULL`)
    .run(tableName, parseInt(recordId, 10), projectId, nowISO(), token);
  return Number(info.changes);
}

function resolveProjectId (tableName, recordId) {
  try {
    if (tableName === 'projects') return parseInt(recordId, 10);
    const r = db.prepare(`SELECT project_id FROM ${tableName} WHERE id = ?`).get(parseInt(recordId, 10));
    return r && r.project_id ? r.project_id : null;
  } catch { return null; }
}

/** 删除某条记录时连带清理其附件 */
function removeForRecord (tableName, recordId) {
  const rows = db.prepare('SELECT id FROM attachments WHERE table_name = ? AND record_id = ?').all(tableName, parseInt(recordId, 10));
  for (const r of rows) remove(r.id);
  return rows.length;
}

/** 删除项目时，连带清理项目本身 + 其下所有子记录的附件 */
function removeForProject (projectId) {
  const pid = parseInt(projectId, 10);
  const pairs = [['projects', pid]];
  for (const t of PROJECT_CHILD_TABLES) {
    for (const r of db.prepare(`SELECT id FROM ${t} WHERE project_id = ?`).all(pid)) pairs.push([t, r.id]);
  }
  let n = 0;
  for (const [t, id] of pairs) n += removeForRecord(t, id);
  // 兜底：project_id 直接指向该项目的附件
  for (const r of db.prepare('SELECT id FROM attachments WHERE project_id = ?').all(pid)) n += remove(r.id).deleted;
  return n;
}

/** 解除关联但保留文件（用户选择"只删记录、保留扫描件"时用） */
function detachIds (ids) {
  const stmt = db.prepare(`UPDATE attachments
    SET table_name = NULL, record_id = NULL, detached = 1, updated_at = ?
    WHERE id = ?`);
  let n = 0;
  for (const id of ids) n += Number(stmt.run(nowISO(), id).changes);
  return n;
}

function detachForRecord (tableName, recordId) {
  const rows = db.prepare('SELECT id FROM attachments WHERE table_name = ? AND record_id = ?').all(tableName, parseInt(recordId, 10));
  return detachIds(rows.map(r => r.id));
}

function detachForProject (projectId) {
  const pid = parseInt(projectId, 10);
  const pairs = [['projects', pid]];
  for (const t of PROJECT_CHILD_TABLES) {
    for (const r of db.prepare(`SELECT id FROM ${t} WHERE project_id = ?`).all(pid)) pairs.push([t, r.id]);
  }
  const seen = new Set();
  for (const [t, id] of pairs) {
    for (const r of db.prepare('SELECT id FROM attachments WHERE table_name = ? AND record_id = ?').all(t, id)) seen.add(r.id);
  }
  for (const r of db.prepare('SELECT id FROM attachments WHERE project_id = ?').all(pid)) seen.add(r.id);
  return detachIds([...seen]);
}

/** 把指定的若干个附件直接关联到某条记录（识别后"新建并填入"时用） */
function linkIds (ids, tableName, recordId) {
  if (!ids || !ids.length || !recordId) return 0;
  const projectId = resolveProjectId(tableName, recordId);
  const stmt = db.prepare(`UPDATE attachments
    SET table_name = ?, record_id = ?, project_id = COALESCE(?, project_id), token = NULL, updated_at = ?
    WHERE id = ?`);
  let n = 0;
  for (const raw of ids) {
    const id = parseInt(raw, 10);
    if (!id) continue;
    n += Number(stmt.run(tableName, parseInt(recordId, 10), projectId, nowISO(), id).changes);
  }
  return n;
}

/** 从回收站还原时，把附件接回原记录 */
function reattach (ref) {
  if (!ref || !ref.id) return 0;
  const row = get(ref.id);
  if (!row) return 0;
  const tableName = ref.table_name || null;
  const recordId = ref.record_id ? parseInt(ref.record_id, 10) : null;
  const projectId = (tableName && recordId) ? resolveProjectId(tableName, recordId) : null;
  db.prepare(`UPDATE attachments
    SET table_name = ?, record_id = ?, project_id = COALESCE(?, project_id), detached = 0, updated_at = ?
    WHERE id = ?`).run(tableName, recordId, projectId, nowISO(), ref.id);
  return 1;
}

/** 清理长期没有归属的暂存附件（用户上传后没保存表单）。
 *  注意：用户主动选择"保留附件"而解除关联的（detached=1）不在此列，绝不自动删。 */
function purgeOrphans (days = 7) {
  const cut = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare('SELECT id FROM attachments WHERE record_id IS NULL AND detached = 0 AND created_at < ?').all(cut);
  for (const r of rows) remove(r.id);
  return rows.length;
}

/** 统计某个项目（含其下所有子记录）的附件数量 */
function countForProject (projectId) {
  const pid = parseInt(projectId, 10);
  const keys = new Set([`projects:${pid}`]);
  for (const t of PROJECT_CHILD_TABLES) {
    for (const r of db.prepare(`SELECT id FROM ${t} WHERE project_id = ?`).all(pid)) keys.add(`${t}:${r.id}`);
  }
  let n = 0;
  for (const r of db.prepare('SELECT id, table_name, record_id, project_id FROM attachments').all()) {
    if (r.project_id === pid || (r.table_name && keys.has(`${r.table_name}:${r.record_id}`))) n++;
  }
  return n;
}

/** 把磁盘上存在但库里没有的文件清掉（反向清理） */
function totalBytes () { return stats().bytes; }

/** 批量取某张表若干记录的附件数量，用于列表页显示回形针 */
function countsFor (tableName, ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  const stmt = db.prepare('SELECT COUNT(*) n FROM attachments WHERE table_name = ? AND record_id = ?');
  for (const id of ids) out[id] = stmt.get(tableName, id).n;
  return out;
}

/** 按文件名或识别出的文字搜索附件 */
function search (kw, limit = 8) {
  if (!kw) return [];
  const like = `%${kw}%`;
  return db.prepare(`SELECT id, original_name, table_name, record_id, ocr_kind, ocr_status, size, created_at
    FROM attachments WHERE original_name LIKE ? OR ocr_text LIKE ? OR ocr_fields LIKE ?
    ORDER BY id DESC LIMIT ?`).all(like, like, like, limit);
}

/** 某条记录的全部附件（用于行内查看） */
function forRecord (tableName, recordId) {
  return list({ table_name: tableName, record_id: recordId });
}

module.exports = {
  ATTACH_DIR, OCR_EXT, ALLOW_EXT, MIME,
  ensureDir, createTable, add, get, list, remove, update, stats, linkByToken, linkIds,
  removeForRecord, removeForProject, detachForRecord, detachForProject, detachIds, reattach,
  purgeOrphans, countForProject, countsFor, search, forRecord,
  absPathOf, mimeOf, extOf, isOcrExt, isImage, safeDisplayName, resolveProjectId, totalBytes,
};
