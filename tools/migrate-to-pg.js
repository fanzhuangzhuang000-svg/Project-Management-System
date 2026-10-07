#!/usr/bin/env node
'use strict';
/**
 * SQLite → PostgreSQL 数据迁移
 *
 * 用法：
 *   node tools/migrate-to-pg.js "postgres://用户:密码@主机:5432/库名"
 *   node tools/migrate-to-pg.js --check "postgres://..."     只对账，不导入
 *   node tools/migrate-to-pg.js --dry-run "postgres://..."   只建表，不导数据
 *
 * 做的事：
 *   1. 读现有 data/pms.db 的真实表结构（以库里实际结构为准，不是 schema.js 的定义，
 *      这样连历史 ALTER 加过的列也能一起搬过去）
 *   2. 在 PG 里建同样的表（类型做方言转换）
 *   3. 逐表导入，带进度
 *   4. 对账：各表记录数、合同总额、应收总额必须两边一致
 *
 * 全程只读源库，不动 data/pms.db 一个字节。
 */
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.PMS_DATA_DIR || path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'pms.db');

const args = process.argv.slice(2);
const CHECK_ONLY = args.includes('--check');
const DRY_RUN = args.includes('--dry-run');
const URL = args.find(a => !a.startsWith('--'));

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`,
  bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`,
  red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  cyan: s => `\x1b[36m${s}\x1b[0m`,
};

function usage () {
  console.log('');
  console.log(C.bold('  SQLite → PostgreSQL 数据迁移'));
  console.log('');
  console.log('  用法：');
  console.log('    node tools/migrate-to-pg.js "postgres://user:pass@host:5432/dbname"');
  console.log('    node tools/migrate-to-pg.js --check   "postgres://..."    只对账');
  console.log('    node tools/migrate-to-pg.js --dry-run "postgres://..."    只建表');
  console.log('');
  console.log(C.dim(`  源库：${DB_FILE}`));
  console.log('');
}

/** SQLite 类型 → PG 类型。布尔类字段刻意留 INTEGER，业务层到处是 === 1 的判断。 */
function pgType (sqliteType) {
  const t = String(sqliteType || '').toUpperCase();
  if (t.includes('INT')) return 'BIGINT';
  if (t.includes('REAL') || t.includes('FLOA') || t.includes('DOUB')) return 'DOUBLE PRECISION';
  if (t.includes('BLOB')) return 'BYTEA';
  if (t.includes('NUM') || t.includes('DEC')) return 'NUMERIC';
  return 'TEXT';
}

function quoteIdent (name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** 从源库读出真实结构 */
function readSourceSchema (src) {
  const tables = src.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all().map(r => r.name);

  const out = [];
  for (const t of tables) {
    const cols = src.prepare(`PRAGMA table_info(${t})`).all();
    // 自增主键：PG 用 BIGSERIAL
    const hasAutoId = cols.some(c => c.name === 'id' && c.pk === 1);
    out.push({ table: t, cols, hasAutoId });
  }
  return out;
}

function buildCreateSql (meta) {
  const parts = [];
  for (const c of meta.cols) {
    if (c.name === 'id' && meta.hasAutoId) { parts.push(`${quoteIdent('id')} BIGSERIAL PRIMARY KEY`); continue }
    let def = `${quoteIdent(c.name)} ${pgType(c.type)}`;
    if (c.notnull === 1 && c.name !== 'id') def += ' NOT NULL';
    if (c.dflt_value !== null && c.dflt_value !== undefined) {
      const d = String(c.dflt_value).trim();
      // SQLite 的默认值字面量 PG 大多能认，原样带上
      def += ` DEFAULT ${d}`;
    }
    parts.push(def);
  }
  // 没有自增 id 的表（比如 settings 是 key/value），用主键约束兜住
  if (!meta.hasAutoId) {
    const pk = meta.cols.find(c => c.pk === 1);
    if (pk) parts.push(`PRIMARY KEY (${quoteIdent(pk.name)})`);
  }
  return `CREATE TABLE IF NOT EXISTS ${quoteIdent(meta.table)} (\n  ${parts.join(',\n  ')}\n)`;
}

/** 等宽进度条 */
function bar (done, total, width = 28) {
  const pct = total ? done / total : 1;
  const fill = Math.round(pct * width);
  return '[' + '█'.repeat(fill) + '·'.repeat(width - fill) + '] ' + String(Math.round(pct * 100)).padStart(3) + '%';
}

(async () => {
  if (!URL || (!/^postgres(ql)?:\/\//i.test(URL))) { usage(); process.exit(1) }
  if (!fs.existsSync(DB_FILE)) {
    console.log('  ' + C.red(`✗ 找不到源数据库：${DB_FILE}`));
    console.log('  ' + C.dim('  如果数据在别处，用环境变量 PMS_DATA_DIR 指定目录'));
    process.exit(1);
  }

  let Client;
  try { ({ Client } = require('pg')) } catch {
    console.log('  ' + C.red('✗ 缺少 pg 驱动。先在项目目录执行：npm install'));
    process.exit(1);
  }

  const src = new DatabaseSync(DB_FILE, { readOnly: true });
  const schema = readSourceSchema(src);
  const totalRows = schema.reduce((n, m) =>
    n + src.prepare(`SELECT COUNT(*) c FROM ${quoteIdent(m.table)}`).get().c, 0);

  console.log('');
  console.log('  ' + C.bold('SQLite → PostgreSQL 迁移'));
  console.log('  ' + '═'.repeat(62));
  console.log(`  源库：    ${C.dim(DB_FILE)}`);
  console.log(`  目标：    ${C.dim(String(URL).replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@'))}`);
  console.log(`  表数量：  ${schema.length}    总记录：${totalRows}`);
  if (CHECK_ONLY) console.log('  模式：    ' + C.yellow('只对账，不导入'));
  if (DRY_RUN) console.log('  模式：    ' + C.yellow('只建表，不导数据'));
  console.log('  ' + '═'.repeat(62));
  console.log('');

  const pg = new Client({ connectionString: URL });
  await pg.connect();

  // ── 1. 建表 ──
  console.log('  ' + C.bold('[1/3] 建表'));
  for (const m of schema) {
    await pg.query(buildCreateSql(m));
    console.log(`    ✓ ${m.table.padEnd(18)} ${m.cols.length} 列`);
  }

  // ── 2. 导数据 ──
  if (!CHECK_ONLY && !DRY_RUN) {
    console.log('');
    console.log('  ' + C.bold('[2/3] 导入数据'));
    let done = 0;
    for (const m of schema) {
      const rows = src.prepare(`SELECT * FROM ${quoteIdent(m.table)}`).all();
      if (rows.length) {
        const colNames = m.cols.map(c => c.name);
        const colList = colNames.map(quoteIdent).join(', ');
        const CHUNK = 200;
        for (let i = 0; i < rows.length; i += CHUNK) {
          const slice = rows.slice(i, i + CHUNK);
          const values = [];
          const tuples = slice.map(row => {
            const ph = colNames.map((_, k) => '$' + (values.length + k + 1));
            for (const cn of colNames) values.push(row[cn] === undefined ? null : row[cn]);
            return '(' + ph.join(', ') + ')';
          });
          // 自增 id 要显式写入，否则重建后 id 会变（附件、关联全靠它）
          const conflict = m.hasAutoId
            ? ` ON CONFLICT (${quoteIdent('id')}) DO NOTHING`
            : ' ON CONFLICT DO NOTHING';
          await pg.query(
            `INSERT INTO ${quoteIdent(m.table)} (${colList}) VALUES ${tuples.join(', ')}${conflict}`,
            values
          );
        }
      }
      done += rows.length;
      process.stdout.write(`\r    ${bar(done, totalRows)}  ${m.table.padEnd(18)} ${String(rows.length).padStart(6)} 条`);
      // 自增序列要跟当前最大 id 对齐，否则新插入会主键冲突
      if (m.hasAutoId && rows.length) {
        await pg.query(`SELECT setval(pg_get_serial_sequence($1, 'id'), COALESCE(MAX(id), 1)) FROM ${quoteIdent(m.table)}`,
          [m.table]);
      }
    }
    console.log('');
  } else {
    console.log('');
    console.log('  ' + C.dim('[2/3] 跳过导入'));
  }

  // ── 3. 对账 ──
  console.log('');
  console.log('  ' + C.bold('[3/3] 数据对账'));
  const problems = [];
  for (const m of schema) {
    const a = src.prepare(`SELECT COUNT(*) c FROM ${quoteIdent(m.table)}`).get().c;
    const b = Number((await pg.query(`SELECT COUNT(*) c FROM ${quoteIdent(m.table)}`)).rows[0].c);
    const ok = CHECK_ONLY ? true : a === b;
    if (!ok) problems.push(`${m.table}: SQLite ${a} 条 vs PG ${b} 条`);
    console.log(`    ${ok ? C.green('✓') : C.red('✗')} ${m.table.padEnd(18)} SQLite ${String(a).padStart(6)}   PG ${String(b).padStart(6)}`);
  }

  // 关键业务口径：合同总额、应收总额
  console.log('');
  console.log('    ' + C.bold('关键业务口径：'));
  const biz = [
    ['收入合同总额', `SELECT COALESCE(SUM(amount),0) v FROM contracts WHERE direction = 'in'`],
    ['支出合同总额', `SELECT COALESCE(SUM(amount),0) v FROM contracts WHERE direction = 'out'`],
    ['已收款合计', `SELECT COALESCE(SUM(amount),0) v FROM payments WHERE direction = 'in'`],
    ['已付款合计', `SELECT COALESCE(SUM(amount),0) v FROM payments WHERE direction = 'out'`],
    ['发票价税合计', `SELECT COALESCE(SUM(total_amount),0) v FROM invoices`],
    ['项目数', `SELECT COUNT(*) v FROM projects`],
  ];
  for (const [label, sql] of biz) {
    let a = null, b = null;
    try { a = Number(src.prepare(sql).get().v) } catch { /* 表可能不存在 */ }
    try { b = Number((await pg.query(sql)).rows[0].v) } catch { /* 同上 */ }
    if (a === null || b === null) continue;
    const same = Math.abs(a - b) < 0.01;
    if (!same && !CHECK_ONLY) problems.push(`${label}: SQLite ${a} vs PG ${b}`);
    console.log(`      ${same ? C.green('✓') : C.red('✗')} ${label.padEnd(14)} SQLite ${a.toLocaleString('zh-CN')}   PG ${b.toLocaleString('zh-CN')}`);
  }

  console.log('');
  console.log('  ' + '═'.repeat(62));
  if (problems.length) {
    console.log('  ' + C.red(`✗ 对账不通过，${problems.length} 处不一致：`));
    for (const p of problems) console.log('      ' + p);
    console.log('');
    console.log('  ' + C.dim('  PG 里的数据不完整。可以删掉 PG 里的表重跑一次。'));
    await pg.end(); src.close();
    process.exit(1);
  }

  console.log('  ' + C.green('✓ 迁移完成，两边数据完全一致'));
  console.log('');
  if (!CHECK_ONLY && !DRY_RUN) {
    console.log('  ' + C.yellow('提醒：确认数据没问题之前，先别删 data/pms.db。'));
    console.log('  ' + C.dim('  建议先把 data 目录整体复制一份留底，再切换 DB_URL 启动。'));
    console.log('');
    console.log('  启动命令：');
    console.log('  ' + C.cyan(`  set DB_URL=${URL}`));
    console.log('  ' + C.cyan('  node server.js'));
  }
  console.log('  ' + '═'.repeat(62));
  console.log('');

  await pg.end();
  src.close();
})().catch(async (e) => {
  console.error('');
  console.error('  ' + C.red('✗ 迁移失败：' + e.message));
  console.error('');
  process.exit(1);
});
