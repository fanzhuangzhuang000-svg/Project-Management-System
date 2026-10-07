'use strict';
/**
 * MinIO 存储驱动验证
 *
 * 验证的是**我这边**的集成：业务同步 API → 同步桥 → minio 客户端 → 真实 HTTP → 对象存储。
 * 服务端用 tools/minio-mock-server.js（跑在独立进程，原因见那个文件的注释）。
 *
 * 用法： node tools/minio-mock-test.js
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const PORT = 9100;
const SERVER = path.join(__dirname, 'minio-mock-server.js');

const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // 模拟服务必须独立进程：storage 调用会 Atomics.wait 阻塞主线程，
  // 同进程的话服务永远没机会响应（生产环境 MinIO 是独立容器，没这问题）
  const srv = spawn(process.execPath, [SERVER, String(PORT)], { stdio: 'ignore', windowsHide: true });
  await sleep(1200);
  console.log(`  模拟 S3 服务已起（独立进程 pid ${srv.pid}）`);
  console.log('');

  // 环境变量要在 require 存储层之前设好
  process.env.STORAGE_DRIVER = 'minio';
  process.env.MINIO_ENDPOINT = '127.0.0.1';
  process.env.MINIO_PORT = String(PORT);
  process.env.MINIO_USE_SSL = 'false';
  process.env.MINIO_ACCESS_KEY = 'testkey';
  process.env.MINIO_SECRET_KEY = 'testsecret';
  process.env.MINIO_BUCKET = 'elv-pms-test';
  const cacheDir = path.join(os.tmpdir(), 'elv-minio-cache-' + Date.now());
  process.env.PMS_DATA_DIR = cacheDir;

  const { storage } = require('../storage.js');
  check('驱动选择为 minio', storage.driver === 'minio', storage.describe());

  const key = '202610/abcdef012345.pdf';
  const payload = Buffer.from('%PDF-1.7 测试内容 ' + 'x'.repeat(2000));

  console.log('\n[1] 上传');
  storage.save(key, payload);
  check('save 成功', true, `${payload.length} 字节`);

  console.log('\n[2] 取本地路径（OCR 只认本地文件）');
  const p1 = storage.localPath(key);
  check('localPath 返回了本地文件', fs.existsSync(p1), path.basename(p1));
  check('内容一字不差', fs.readFileSync(p1).equals(payload), `${fs.statSync(p1).size} 字节`);
  check('第二次走缓存（同一路径）', storage.localPath(key) === p1);

  console.log('\n[3] 存在性 / 大小');
  check('exists = true', storage.exists(key) === true);
  check('size 对得上', storage.size(key) === payload.length, String(storage.size(key)));
  check('不存在的键 exists = false', storage.exists('202610/nope.pdf') === false);

  console.log('\n[4] 列目录');
  storage.save('202611/second.txt', Buffer.from('hi'));
  const list = storage.list();
  check('列出了 2 个对象', list.length === 2, list.map(x => x.key).join(', '));
  check('前缀过滤可用', storage.list('202611/').length === 1);

  console.log('\n[5] 删除');
  storage.remove(key);
  check('删完 exists = false', storage.exists(key) === false);
  check('另一个对象不受影响', storage.exists('202611/second.txt') === true);
  check('删不存在的键不抛错', storage.remove('nothing/here.pdf') === true);

  console.log('\n[6] 本地缓存可释放');
  storage.save('202612/rel.pdf', Buffer.from('abc'));
  const rp = storage.localPath('202612/rel.pdf');
  check('取到了缓存文件', fs.existsSync(rp));
  storage.release('202612/rel.pdf');
  check('release 后本地缓存已清', !fs.existsSync(rp));
  check('对象存储里的正本还在', storage.exists('202612/rel.pdf') === true);

  console.log('\n[7] 附件模块走 MinIO（真实业务路径）');
  const attach = require('../attachments.js');
  attach.createTable();   // 临时数据目录是新的，先把表建出来
  const added = attach.add({
    buffer: Buffer.from('PDF-测试附件内容'),
    originalName: 'MOCKTEST-合同.pdf',
    tableName: null, recordId: null, token: null, category: null, projectId: null,
  });
  check('附件存进了对象存储', !!added.id, 'id=' + added.id);
  const row = attach.get(added.id);
  const ap = attach.absPathOf(row.stored_name);
  check('能取回本地路径（OCR 要用）', fs.existsSync(ap));
  check('内容一致', fs.readFileSync(ap).toString() === 'PDF-测试附件内容');
  const stKey = row.stored_name;
  attach.remove(added.id);   // 这一步会同时删数据库记录和对象存储里的文件
  check('附件删掉后，对象存储里的文件也没了', storage.exists(stKey) === false);
  check('数据库记录也删了', !attach.get(added.id), 'get 返回 ' + JSON.stringify(attach.get(added.id)))

  srv.kill();
  try { storage.close?.() } catch { /* 忽略 */ }
  try { fs.rmSync(cacheDir, { recursive: true, force: true }) } catch { /* 忽略 */ }

  const pass = results.filter(r => r.ok).length;
  console.log('\n' + '='.repeat(56));
  console.log(`  MinIO 存储验证：${pass} / ${results.length} 项通过`);
  if (pass !== results.length) {
    console.log('  失败：\n' + results.filter(r => !r.ok).map(r => '   - ' + r.n).join('\n'));
  }
  console.log('='.repeat(56));
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => {
  console.error('\n  ✗ 验证失败：' + e.message);
  process.exit(1);
});
