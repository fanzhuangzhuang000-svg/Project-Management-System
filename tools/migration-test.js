'use strict';
/**
 * 数据库版本与迁移机制测试
 *
 * 关键要验证的不是「迁移能跑」，而是：
 *   · 老库（没有版本表）升级时**数据一个字节都不动**
 *   · 坏迁移不会把库改坏（事务回滚 + 中止后续）
 *   · 重复跑不会重复执行（幂等）
 *   · 升级前会自动备份（有退路）
 *
 * 用法： node tools/migration-test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const results = [];
const check = (n, ok, x = '') => {
  results.push({ n, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${n}${x ? '  — ' + x : ''}`);
};

// 用独立的临时数据目录，绝不碰用户的库
const TMP = path.join(os.tmpdir(), 'elv-mig-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.PMS_DATA_DIR = TMP;

const dbf = require('../db.js');
const M = require('../migrations.js');
const db = dbf.db;

console.log('[1] 全新库的基线');
dbf.init();
// 播种示例数据：后面要验证「升级不动数据」，没数据就验证不了
dbf.seed(true);
check('新库被标成最新版本', M.currentVersion(db) === M.LATEST, `v${M.currentVersion(db)} / 最新 v${M.LATEST}`);
check('版本表记录了每一步', M.applied(db).length === M.LATEST, M.applied(db).map(x => 'v' + x.version).join(' '));
check('每步都带名字和时间', M.applied(db).every(x => x.name && x.applied_at),
  M.applied(db)[0] ? M.applied(db)[0].applied_at : '');

console.log('\n[2] 幂等：再跑一次什么都不做');
const again = M.migrate(db, { log: () => {} });
check('没有重复执行', again.ran.length === 0 && again.from === again.to, `执行 ${again.ran.length} 个`);

console.log('\n[3] 模拟老库：抹掉版本表，数据必须纹丝不动');
const beforeProjects = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
const beforeContracts = db.prepare('SELECT COUNT(*) n FROM contracts').get().n;
const beforeSum = db.prepare('SELECT COALESCE(SUM(amount),0) v FROM contracts').get().v;
db.exec('DROP TABLE schema_migrations');
check('版本表已抹掉（模拟老库）', M.currentVersion(db) === 0);

const r = M.migrate(db, { log: () => {} });
check('老库被升到最新', r.to === M.LATEST, `v${r.from} → v${r.to}`);
check('★ 项目数没变', db.prepare('SELECT COUNT(*) n FROM projects').get().n === beforeProjects,
  `${beforeProjects} → ${db.prepare('SELECT COUNT(*) n FROM projects').get().n}`);
check('★ 合同数没变', db.prepare('SELECT COUNT(*) n FROM contracts').get().n === beforeContracts,
  `${beforeContracts} → ${db.prepare('SELECT COUNT(*) n FROM contracts').get().n}`);
check('★ 合同总额没变', db.prepare('SELECT COALESCE(SUM(amount),0) v FROM contracts').get().v === beforeSum,
  String(beforeSum));

console.log('\n[4] 升级前会自动备份');
db.exec('DROP TABLE schema_migrations');   // 再装成老库
const backupDir = path.join(TMP, 'backup');
const bk = M.migrate(db, {
  log: () => {},
  backup: () => {
    fs.mkdirSync(backupDir, { recursive: true });
    const dest = path.join(backupDir, 'pre-upgrade-test.db');
    dbf.backupTo(dest);
    return dest;
  },
});
check('产生了备份文件', !!bk.backup && fs.existsSync(bk.backup), bk.backup ? path.basename(bk.backup) : '无');
check('备份文件不是空的', bk.backup ? fs.statSync(bk.backup).size > 1000 : false,
  bk.backup ? (fs.statSync(bk.backup).size / 1024).toFixed(0) + ' KB' : '');

console.log('\n[5] 坏迁移不会改坏库');
{
  const M2 = require('../migrations.js');
  // 临时塞一条会失败、且失败前已经改了一半数据的迁移
  M2.MIGRATIONS.push({
    version: 99,
    name: '测试：故意失败',
    up (d) {
      d.prepare('UPDATE partners SET name = ? WHERE id = (SELECT MIN(id) FROM partners)').run('被改坏了');
      throw new Error('故意的');
    },
  });
  const beforeName = db.prepare('SELECT name FROM partners WHERE id = (SELECT MIN(id) FROM partners)').get().name;
  const bad = M2.migrate(db, { log: () => {} });
  check('迁移失败被捕获', !!bad.error, bad.error);
  check('版本停在失败前', M2.currentVersion(db) === M.LATEST, `v${M2.currentVersion(db)}`);
  const afterName = db.prepare('SELECT name FROM partners WHERE id = (SELECT MIN(id) FROM partners)').get().name;
  check('★ 失败迁移里的改动被回滚', afterName === beforeName, `${beforeName} → ${afterName}`);
  M2.MIGRATIONS.pop();
}

console.log('\n[6] 备份失败时宁可中止升级');
{
  db.exec('DROP TABLE schema_migrations');
  const aborted = M.migrate(db, { log: () => {}, backup: () => { throw new Error('磁盘满了') } });
  check('备份失败 → 升级中止（不留后患）', !!aborted.error && aborted.ran.length === 0, aborted.error);
  check('版本没有被推进', M.currentVersion(db) === 0, `v${M.currentVersion(db)}`);
  // 收尾：正常升上去
  M.migrate(db, { log: () => {} });
  check('恢复正常后能升到最新', M.currentVersion(db) === M.LATEST);
}

const pass = results.filter(x => x.ok).length;
console.log('\n' + '='.repeat(56));
console.log(`  迁移机制测试：${pass} / ${results.length} 项通过`);
if (pass !== results.length) console.log('  失败：\n' + results.filter(x => !x.ok).map(x => '   - ' + x.n).join('\n'));
console.log('='.repeat(56));

try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* 忽略 */ }
process.exit(pass === results.length ? 0 : 1);
