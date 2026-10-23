'use strict';
/**
 * 看板输出基线 —— 手工闸门，**不进 run-all**
 *
 * 为什么需要它
 *   看板重算是十几条聚合叠出来的，任何一次"看起来等价"的 SQL 改写都可能悄悄改变
 *   某个字段的取值或顺序。历史教训：把 scheduleAllocation 改成 GROUP BY 时，
 *   靠的就是"改前存一份、改后逐字节比"才敢确认等价。
 *
 * 用法
 *   PMS_DATA_DIR=C:/pms-load-probe node tools/dash-baseline.js save C:/pms-baseline/before.json
 *   PMS_DATA_DIR=C:/pms-load-probe node tools/dash-baseline.js check C:/pms-baseline/before.json
 *
 * 唯一允许变化的字段是 extra.todo_count（它以前恒为 0，是 bug）；比对前统一掩码成 0。
 * 其它任何字节差异都按回归处理。
 */
const fs = require('node:fs');
const path = require('node:path');

process.env.PMS_NO_AUTO_BACKUP = '1';
if (!process.env.PMS_DATA_DIR) {
  console.error('必须显式指定 PMS_DATA_DIR（例如 C:/pms-load-probe），避免拿正式库做实验');
  process.exit(2);
}

const dbf = require('../db.js');
dbf.init();

const MASK = ['"todo_count":0'];

/** 数据里唯一允许变的字段：掩码掉，避免它盖住真正的回归 */
function mask (s) {
  return String(s).replace(/"todo_count":\s*-?\d+(\.\d+)?/g, MASK[0]);
}

function snapshot () {
  const dashAll = dbf.dashboard();
  const ids = dbf.db.prepare('SELECT id FROM projects ORDER BY id').all().map(r => r.id);
  return {
    // 整份看板（字段顺序也在里面 —— JSON.stringify 对 key 顺序敏感）
    dashboard: mask(JSON.stringify(dashAll)),
    // 受限权限视角：验证权限裁剪没有被分块/合并改写
    permsLimited: mask(JSON.stringify(dbf.dashboardFor({ all: false, read: ['materials'], write: [] }))),
    // 冲抵结果全量 Map（schedules → 已收付），改冲抵算法时这是最硬的证据
    alloc: JSON.stringify([...dbf.scheduleAllocation()].sort((a, b) => a[0] - b[0])),
    // 每项目统计（8 条聚合的产物）
    stats: JSON.stringify(ids.map(id => [id, dbf.projectStatsMany([id])[id] || null])),
  };
}

/** 找出第一处差异，带上下文，比"字符串不相等"有用得多 */
function firstDiff (a, b) {
  let i = 0;
  const n = Math.min(a.length, b.length);
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return null;
  const from = Math.max(0, i - 120);
  return {
    at: i,
    before: a.slice(from, i + 120),
    after: b.slice(from, i + 120),
  };
}

function main () {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== 'save' && cmd !== 'check') {
    console.error('用法：node tools/dash-baseline.js save|check <文件路径>');
    process.exit(2);
  }
  if (!file) {
    console.error('缺少基线文件路径');
    process.exit(2);
  }

  const now = snapshot();

  if (cmd === 'save') {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    fs.writeFileSync(path.resolve(file), JSON.stringify(now, null, 1), 'utf8');
    const dashBytes = now.dashboard.length;
    console.log('已保存基线：' + path.resolve(file));
    console.log(`  dashboard ${dashBytes} 字节 / alloc ${JSON.parse(now.alloc).length} 项 / stats ${JSON.parse(now.stats).length} 个项目`);
    return;
  }

  if (!fs.existsSync(file)) {
    console.error('基线文件不存在：' + file + '（先跑 save）');
    process.exit(2);
  }
  const base = JSON.parse(fs.readFileSync(file, 'utf8'));
  let bad = 0;
  for (const key of Object.keys(base)) {
    if (base[key] === now[key]) { console.log(`  ✓ ${key} 完全一致`); continue; }
    bad++;
    const d = firstDiff(base[key], now[key]);
    console.error(`  ✗ ${key} 不一致（首个差异在第 ${d ? d.at : '?'} 字节）`);
    if (d) {
      console.error('    改前 …' + d.before);
      console.error('    改后 …' + d.after);
    }
  }
  if (bad) {
    console.error(`\n基线比对失败：${bad} 项不一致`);
    process.exit(1);
  }
  console.log('\n基线比对通过（todo_count 已掩码）');
}

main();
