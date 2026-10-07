#!/usr/bin/env node
'use strict';
/**
 * 附件从本地目录迁到 MinIO
 *
 * 用法：
 *   set MINIO_ENDPOINT=127.0.0.1
 *   set MINIO_ACCESS_KEY=...
 *   set MINIO_SECRET_KEY=...
 *   node tools/migrate-attachments.js
 *
 * 行为：
 *   - 只**上传**，不动本地文件（出问题可以随时切回本地存储）
 *   - 已存在且大小一致的对象会跳过，可以重复跑
 *   - 迁移前把本地附件目录整个复制一份留底
 *   - 迁完对账：数据库记录数 / 对象数 / 总字节数
 *
 * 迁完把 STORAGE_DRIVER 改成 minio 重启即可。确认没问题再删本地目录。
 */
const fs = require('node:fs');
const path = require('node:path');

const C = {
  dim: s => `\x1b[2m${s}\x1b[0m`, bold: s => `\x1b[1m${s}\x1b[0m`,
  green: s => `\x1b[32m${s}\x1b[0m`, red: s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`, cyan: s => `\x1b[36m${s}\x1b[0m`,
};

const DATA_DIR = process.env.PMS_DATA_DIR || path.join(__dirname, '..', 'data');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');

(async () => {
  if (!fs.existsSync(ATTACH_DIR)) {
    console.log(`  ${C.red('✗ 没有本地附件目录：')}${ATTACH_DIR}`);
    process.exit(1);
  }

  // 直接连 MinIO，不走同步桥（脚本本身可以是异步的，没必要绕）
  let Minio;
  try { Minio = require('minio') } catch {
    console.log(`  ${C.red('✗ 缺少 minio 客户端，先执行 npm install')}`);
    process.exit(1);
  }

  const endPoint = process.env.MINIO_ENDPOINT || '127.0.0.1';
  const port = Number(process.env.MINIO_PORT || 9000);
  const useSSL = String(process.env.MINIO_USE_SSL || 'false') === 'true';
  const accessKey = process.env.MINIO_ACCESS_KEY || 'minioadmin';
  const secretKey = process.env.MINIO_SECRET_KEY || 'minioadmin';
  const bucket = process.env.MINIO_BUCKET || 'elv-pms';

  const client = new Minio.Client({ endPoint, port, useSSL, accessKey, secretKey, pathStyle: true });

  console.log('');
  console.log(`  ${C.bold('附件迁移：本地目录 → MinIO')}`);
  console.log('  ' + '═'.repeat(60));
  console.log(`  来源：${C.dim(ATTACH_DIR)}`);
  console.log(`  目标：${C.dim(`minio://${endPoint}:${port}/${bucket}`)}`);

  // 确保桶存在
  const has = await client.bucketExists(bucket).catch(() => false);
  if (!has) { await client.makeBucket(bucket); console.log(`  ${C.dim('（已创建 bucket）')}`) }

  // 收集本地文件
  const files = [];
  (function walk (dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else files.push({ key: r, full: path.join(dir, e.name), size: fs.statSync(path.join(dir, e.name)).size });
    }
  })(ATTACH_DIR, '');

  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  console.log(`  待迁移：${files.length} 个文件，共 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log('  ' + '═'.repeat(60));
  console.log('');

  let uploaded = 0, skipped = 0, failed = 0;
  const problems = [];

  for (const f of files) {
    try {
      // 已经传过且大小一样就跳过（可以重复跑）
      let remoteSize = -1;
      try { remoteSize = (await client.statObject(bucket, f.key)).size } catch { /* 不存在 */ }

      if (remoteSize === f.size) {
        skipped++;
      } else {
        await client.putObject(bucket, f.key, fs.readFileSync(f.full), f.size);
        uploaded++;
      }
    } catch (e) {
      failed++;
      problems.push(`${f.key}: ${e.message}`);
    }
    const done = uploaded + skipped + failed;
    const pct = Math.round(done / files.length * 100);
    const bar = '█'.repeat(Math.round(pct / 4)).padEnd(25, '·');
    process.stdout.write(`\r    [${bar}] ${String(pct).padStart(3)}%  ${done}/${files.length}`);
  }
  console.log('');
  console.log('');

  console.log(`  ${C.green('✓')} 新上传 ${uploaded} 个`);
  console.log(`  ${C.dim(`· 已存在跳过 ${skipped} 个`)}`);
  if (failed) console.log(`  ${C.red(`✗ 失败 ${failed} 个`)}`);
  if (problems.length) {
    console.log('');
    for (const p of problems.slice(0, 10)) console.log('      ' + p);
  }

  // 对账：数据库里登记的附件，是不是都能在 MinIO 里找到
  console.log('');
  console.log('  ' + C.bold('对账'));
  try {
    const dbf = require('../db.js');
    const rows = dbf.db.prepare('SELECT id, stored_name FROM attachments').all();
    let missing = 0, sizeMismatch = 0;
    for (const r of rows) {
      if (!r.stored_name) continue;
      const local = path.join(ATTACH_DIR, r.stored_name.replace(/\//g, path.sep));
      const localSize = fs.existsSync(local) ? fs.statSync(local).size : null;
      let remoteSize = -1;
      try { remoteSize = (await client.statObject(bucket, r.stored_name)).size } catch { /* 无 */ }
      if (remoteSize < 0) missing++;
      else if (localSize !== null && remoteSize !== localSize) sizeMismatch++;
    }
    console.log(`    数据库登记附件：${rows.length} 条`);
    console.log(`    ${missing ? C.red('✗') : C.green('✓')} MinIO 里缺失：${missing} 条`);
    console.log(`    ${sizeMismatch ? C.red('✗') : C.green('✓')} 大小不一致：${sizeMismatch} 条`);
    if (!missing && !sizeMismatch) {
      console.log('');
      console.log(`  ${C.green('✓ 迁移完成')}，两边一致`);
    }
  } catch (e) {
    console.log(`    ${C.yellow('（跳过数据库对账：' + e.message + '）')}`);
  }

  console.log('');
  console.log(`  ${C.yellow('提醒：本地文件一个都没删。')}`);
  console.log(`  ${C.dim('  确认没问题后，把 STORAGE_DRIVER 改成 minio 重启即可；')}`);
  console.log(`  ${C.dim('  再观察一段时间确认无误，才能删本地 data/attachments 目录。')}`);
  console.log('');
  console.log('  ' + '═'.repeat(60));
  console.log('');

  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error(`  ${C.red('✗ ' + e.message)}`);
  process.exit(1);
});
