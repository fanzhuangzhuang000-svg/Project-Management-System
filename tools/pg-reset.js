#!/usr/bin/env node
'use strict';
/**
 * 清空 PostgreSQL 里的所有表（**只给测试用，别在客户库上跑**）
 *
 * 为什么需要它：
 *   SQLite 模式下每个测试套件跑完会自己清干净，重复跑不会累积。
 *   但 PG 库是长期存在的，反复跑测试会把测试项目堆在里面 ——
 *   "按类别筛出 N 个项目"这类断言就会被历史残留撑大，结果时对时错。
 *   所以跑 PG 全量测试前，先来一次这个。
 *
 * 用法：
 *   set DB_URL=postgres://user:pass@host:5432/dbname
 *   node tools/pg-reset.js
 *
 * 有 --force 才真的动手；否则只打印将要删什么（防手滑）。
 */
const L = '\x1b[0m';
const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const GRN = '\x1b[32m';
const DIM = '\x1b[2m';
const B = '\x1b[1m';

const URL = process.env.DB_URL || '';
const FORCE = process.argv.includes('--force');

(async () => {
  if (!/^postgres(ql)?:\/\//i.test(URL)) {
    console.log(`  ${RED}✗ 需要设置 DB_URL 指向一个 PostgreSQL 库${L}`);
    console.log(`  ${DIM}  set DB_URL=postgres://user:pass@host:5432/dbname${L}`);
    process.exit(1);
  }

  let Client;
  try { ({ Client } = require('pg')) } catch {
    console.log(`  ${RED}✗ 缺少 pg 驱动，先执行 npm install${L}`);
    process.exit(1);
  }

  const safe = URL.replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@');
  const pg = new Client({ connectionString: URL });
  await pg.connect();

  const tables = (await pg.query(
    `SELECT table_name AS t FROM information_schema.tables
     WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`
  )).rows.map(r => r.t);

  console.log('');
  console.log(`  ${B}清空 PostgreSQL${L}`);
  console.log(`  目标：${DIM}${safe}${L}`);
  console.log(`  共 ${tables.length} 张表`);
  console.log('');

  if (!tables.length) {
    console.log(`  ${DIM}（库是空的，没什么可删）${L}`);
    await pg.end();
    return;
  }

  // 先看一眼各表有多少数据，删之前让人心里有数
  for (const t of tables) {
    const n = Number((await pg.query(`SELECT COUNT(*) c FROM "${t}"`)).rows[0].c);
    if (n > 0) console.log(`    ${String(n).padStart(7)} 条  ${t}`);
  }
  console.log('');

  if (!FORCE) {
    console.log(`  ${YEL}这只是演练。确认要清空的话加 --force：${L}`);
    console.log(`  ${DIM}  node tools/pg-reset.js --force${L}`);
    console.log('');
    await pg.end();
    return;
  }

  // 整库连表一起删，比逐表 TRUNCATE 干净（外键约束不用操心）
  await pg.query('DROP SCHEMA public CASCADE');
  await pg.query('CREATE SCHEMA public');
  console.log(`  ${GRN}✓ 已清空，下次启动会自动重新建表${L}`);
  console.log(`  ${DIM}  （演示数据也会重新播种；真实数据在 SQLite 那边，不受影响）${L}`);
  console.log('');

  await pg.end();
})().catch(e => {
  console.error(`  ${RED}✗ ${e.message}${L}`);
  process.exit(1);
});
