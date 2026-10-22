'use strict';
/**
 * 压测种子数据生成器
 *
 * 造一份「公司用了两三年」体量的数据，用来回答一个问题：
 *   30-50 个人同时用，这套系统到底撑不撑得住？
 *
 * 为什么必须用真实规模：空库上任何实现都很快。
 *   · 60 个项目时，看板若按项目逐个查（N+1），跑 60 组查询
 *   · 4 万条收付款时，导出若整表读进内存，主线程冻结几百毫秒
 *   · 20 万条日志时，日志页若无索引，一页要扫全表
 * 这些在 10 条数据时全是「正常」的。
 *
 * 用法：
 *   node tools/seed-load.js                  # 默认规模，写到系统临时目录
 *   node tools/seed-load.js --dir D:\load    # 指定数据目录
 *   node tools/seed-load.js --scale 0.2      # 两成规模（快速冒烟）
 *   node tools/seed-load.js --reset          # 先清空目标库再生成
 *
 * ⚠️ 默认写到临时目录，**不会**碰 data/pms.db。
 *    要往正式库写必须显式给 --dir，并且会二次确认。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// ── 参数 ──
function argOf (name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = path.resolve(argOf('--dir', path.join(os.tmpdir(), 'pms-load')));
const SCALE = Number(argOf('--scale', '1')) || 1;
const RESET = process.argv.includes('--reset');

// ⚠️ 必须在 require('../db.js') **之前**设置：db-driver 在模块加载时就读 PMS_DATA_DIR。
process.env.PMS_DATA_DIR = DIR;
process.env.PMS_NO_AUTO_BACKUP = '1';
process.env.PMS_MAINTENANCE_INTERVAL_MS = '0';

const dbf = require('../db.js');

// ── 固定种子随机数：同一版本跑两次结果一致，压测数字才可比 ──
let seed = 20261022;
function rnd () {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const money = (a, b) => Math.round((a + rnd() * (b - a)) * 100) / 100;

const ORGS = ['上海天宸置业', '三林滨江开发', '永和路园区管委会', '悦阳和景置业', '华二临港校区',
  '浦东建设集团', '建工五局', '中建八局', '申通地铁', '城投集团'];
const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡'];
const GIVEN = ['伟', '芳', '娜', '敏', '静', '强', '磊', '洋', '勇', '军', '杰', '涛', '明', '超', '霞'];
const nameOf = () => pick(SURNAMES) + pick(GIVEN) + (rnd() > 0.7 ? pick(GIVEN) : '');
const PROJECT_KINDS = ['弱电智能化', '安防监控', '综合布线', '门禁一卡通', '会议系统', '机房建设', '消防报警', '广播系统'];
const CATEGORIES = ['进行中', '已完工', '已暂停', '待开工'];
const DIRECTIONS = ['in', 'out'];
const PHASES = ['预付款', '进度款', '验收款', '质保金', '尾款'];
const METHODS = ['银行转账', '承兑汇票', '现金', '支票'];
const KINDS = ['工程款', '材料款', '劳务费', '设计费', '设备款'];
const STATUS_INV = ['已开票', '已收款', '部分收款', '已作废'];

/** 过去 N 天内的一天，格式 YYYY-MM-DD */
function dayWithin (days) {
  const t = Date.now() - Math.floor(rnd() * days) * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
const nowISO = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

// ── 规模（真实：公司用 2-3 年） ──
const N = (base) => Math.max(1, Math.round(base * SCALE));
const PLAN = {
  partners: N(120),
  projects: N(60),
  contractsPerProject: 20,
  schedulesPerProject: 100,
  payments: N(40000),
  invoices: N(20000),
  expenses: N(15000),
  materials: N(800),
  maintenance: N(300),
  logs: N(200000),
};

function main () {
  const t0 = Date.now();
  console.log('数据目录：' + DIR);
  if (RESET) {
    console.log('--reset：清空现有业务数据');
  }
  dbf.init();
  // dbf.init() 只建 schema.js 里的业务表。日志/附件/回收站/账号/快照这几个
  // 模块各管各的表，得各自建一次 —— 顺序和 server.js 启动流程保持一致。
  for (const mod of ['attachments.js', 'trash.js', 'logs.js', 'auth.js', 'snapshots.js']) {
    const m = require('../' + mod);
    if (m.ensureDir) m.ensureDir();
    if (m.createTable) m.createTable();
  }

  const db = dbf.db;
  const dbFile = path.join(DIR, 'pms.db');
  const existedRows = db.prepare('SELECT COUNT(*) n FROM projects').get().n;
  if (existedRows > 0 && !RESET) {
    console.log(`\n⚠️ 目标库里已有 ${existedRows} 个项目。`);
    console.log('   继续会**追加**数据（可能造成 project_id 混乱）。要重来请加 --reset。');
    console.log('   已中止。');
    process.exit(1);
  }

  if (RESET) {
    // 顺序要紧：先子表后父表。没有外键约束，顺序错了也不报错，只会留下孤儿数据。
    for (const t of ['payments', 'invoices', 'schedules', 'expenses', 'materials', 'maintenance',
      'contract_changes', 'contracts', 'projects', 'partners', 'attachments', 'trash', 'logs']) {
      try { db.exec(`DELETE FROM ${t}`); } catch { /* 表可能不存在 */ }
    }
  }

  // ── 一次性事务：20 万条逐条提交要跑好几分钟 ──
  db.exec('BEGIN');

  // 往来单位
  const insPartner = db.prepare('INSERT INTO partners (name,type,contact,phone,remark,is_demo,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)');
  const partnerIds = [];
  for (let i = 0; i < PLAN.partners; i++) {
    const nm = ORGS[i % ORGS.length] + (i >= ORGS.length ? '（' + (i + 1) + '）' : '') + pick(['有限公司', '股份有限公司', '集团']);
    const r = insPartner.run(nm, pick(['客户', '供应商', '分包']), nameOf(), '13' + int(10000000, 99999999), '', nowISO(), nowISO());
    partnerIds.push(Number(r.lastInsertRowid));
  }

  // 项目
  const insProject = db.prepare(`INSERT INTO projects
    (code,name,client_id,category,status,manager,progress,location,start_date,end_date,remark,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?)`);
  const projectIds = [];
  for (let i = 0; i < PLAN.projects; i++) {
    const kind = PROJECT_KINDS[i % PROJECT_KINDS.length];
    const org = ORGS[i % ORGS.length];
    const start = dayWithin(1100);
    const r = insProject.run(
      'P' + String(2024000 + i + 1),
      org + kind + '工程' + (i > 9 ? '-' + (i + 1) + '期' : ''),
      partnerIds[i % partnerIds.length],
      pick([kind, kind + ',综合布线']),
      pick(CATEGORIES), nameOf(), int(0, 100),
      pick(['上海市浦东新区', '上海市徐汇区', '上海市临港新片区', '上海市闵行区']) + pick(['1号', '88号', '366弄']),
      start, dayWithin(400), '', nowISO(), nowISO()
    );
    projectIds.push(Number(r.lastInsertRowid));
  }
  console.log(`  项目 ${projectIds.length} · 往来单位 ${partnerIds.length}`);

  // 合同：每项目 20 份
  // ⚠️ change_amount / final_amount 是 schema 里的**虚拟字段**（由合同变更累加算出），
  //    表里没有这两列。同理 invoices 的 paid_amount/unpaid_amount、schedules 的
  //    paid_amount/remaining/state 也不在表里 —— 一律不能写进 INSERT。
  const insContract = db.prepare(`INSERT INTO contracts
    (code,name,project_id,category,direction,partner_id,amount,tax_rate,amount_ex_tax,sign_date,start_date,end_date,status,remark,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`);
  const contractIds = [];
  for (const pid of projectIds) {
    for (let j = 0; j < PLAN.contractsPerProject; j++) {
      const dir = j % 3 === 0 ? 'out' : 'in';
      const amt = money(dir === 'in' ? 200000 : 50000, dir === 'in' ? 8000000 : 1200000);
      const sign = dayWithin(1000);
      const r = insContract.run(
        'HT' + pid + '-' + String(j + 1).padStart(3, '0'),
        pick(['弱电施工', '设备采购', '安装调试', '维保服务', '分包']) + '合同-' + (j + 1),
        pid, pick(['项目合同', '采购合同', '分包合同']), dir,
        partnerIds[int(0, partnerIds.length - 1)], amt, pick([6, 9, 13]),
        Math.round(amt / 1.09 * 100) / 100, sign, sign, dayWithin(200),
        pick(['履行中', '已结算', '已终止']), '', nowISO(), nowISO()
      );
      contractIds.push({ id: Number(r.lastInsertRowid), pid, dir, amt });
    }
  }
  console.log(`  合同 ${contractIds.length}`);

  // 收付款计划：每项目 100 条
  const insSchedule = db.prepare(`INSERT INTO schedules
    (project_id,contract_id,direction,phase,ratio,amount,due_date,basis,remark,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,0,?,?)`);
  let schedCount = 0;
  for (const pid of projectIds) {
    const mine = contractIds.filter(c => c.pid === pid);
    for (let j = 0; j < PLAN.schedulesPerProject; j++) {
      const c = mine[j % mine.length];
      const amt = Math.round(c.amt / 10 * 100) / 100;
      insSchedule.run(pid, c.id, c.dir, pick(PHASES), 10, amt, dayWithin(700), '按合同约定',
        '', nowISO(), nowISO());
      schedCount++;
    }
  }
  console.log(`  收付款计划 ${schedCount}`);

  // 收付款：主力大表
  const insPay = db.prepare(`INSERT INTO payments
    (project_id,contract_id,invoice_id,direction,kind,amount,pay_date,method,voucher_no,remark,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`);
  for (let i = 0; i < PLAN.payments; i++) {
    const c = contractIds[i % contractIds.length];
    insPay.run(c.pid, c.id, null, c.dir, pick(KINDS),
      money(1000, 500000), dayWithin(1000), pick(METHODS),
      'PZ' + String(100000 + i), '', nowISO(), nowISO());
  }
  console.log(`  收付款 ${PLAN.payments}`);

  // 发票
  const insInv = db.prepare(`INSERT INTO invoices
    (project_id,contract_id,partner_id,direction,invoice_type,invoice_no,issue_date,amount,tax_rate,tax_amount,total_amount,status,remark,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`);
  for (let i = 0; i < PLAN.invoices; i++) {
    const c = contractIds[i % contractIds.length];
    const amt = money(5000, 800000);
    const tax = Math.round(amt * 0.09 * 100) / 100;
    insInv.run(c.pid, c.id, partnerIds[int(0, partnerIds.length - 1)], c.dir,
      pick(['增值税专用发票', '增值税普通发票']), 'FP' + String(30000000 + i),
      dayWithin(1000), amt, 9, tax, Math.round((amt + tax) * 100) / 100,
      pick(STATUS_INV), '', nowISO(), nowISO());
  }
  console.log(`  发票 ${PLAN.invoices}`);

  // 项目费用
  const insExp = db.prepare(`INSERT INTO expenses
    (project_id,contract_id,category,name,amount,tax_rate,amount_ex_tax,expense_date,payee_id,has_invoice,status,remark,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,?,?)`);
  for (let i = 0; i < PLAN.expenses; i++) {
    const c = contractIds[i % contractIds.length];
    const amt = money(200, 60000);
    insExp.run(c.pid, c.id, pick(['材料费', '人工费', '机械费', '差旅费', '招待费']),
      pick(['线缆', '桥架', '摄像头', '交换机', '辅材']) + i,
      amt, 13, Math.round(amt / 1.13 * 100) / 100, dayWithin(900),
      partnerIds[int(0, partnerIds.length - 1)], pick(['有', '无']), pick(['已报销', '待报销']), '', nowISO(), nowISO());
  }
  console.log(`  项目费用 ${PLAN.expenses}`);

  // 材料设备
  const insMat = db.prepare(`INSERT INTO materials
    (project_id,name,model,brand,unit,quantity,unit_price,amount,status,remark,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,0,?,?)`);
  for (let i = 0; i < PLAN.materials; i++) {
    const pid = projectIds[i % projectIds.length];
    const qty = int(1, 200); const price = money(50, 8000);
    insMat.run(pid, pick(['网络摄像机', '交换机', '光缆', '配线架', '门禁控制器', '读卡器']) + '-' + i,
      pick(['DS-2CD3T46', 'S5735-L24T', 'GJXH-12B1', 'PP-24', 'AC-8000']),
      pick(['海康', '华为', '大华', '宇视', '康普']), pick(['台', '个', '米', '套']),
      qty, price, Math.round(qty * price * 100) / 100, pick(['已到货', '待发货', '已验货']), '', nowISO(), nowISO());
  }
  console.log(`  材料设备 ${PLAN.materials}`);

  // 售后维修
  const insMaint = db.prepare(`INSERT INTO maintenance
    (project_id,report_date,issue,status,handler,finish_date,remark,is_demo,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,0,?,?)`);
  for (let i = 0; i < PLAN.maintenance; i++) {
    const d = dayWithin(700);
    insMaint.run(projectIds[i % projectIds.length], d,
      pick(['摄像机离线', '门禁刷卡无反应', '对讲没声音', '录像丢失', '网络不通']),
      pick(['待处理', '处理中', '已完成']), nameOf(), d, '', nowISO(), nowISO());
  }
  console.log(`  售后维修 ${PLAN.maintenance}`);

  // 操作日志：这是最容易拖慢「日志页」和「通知」的表
  const insLog = db.prepare(`INSERT INTO logs (at,operator,action,table_name,record_id,label,summary,detail)
    VALUES (?,?,?,?,?,?,?,?)`);
  const tablesWithRows = [['projects', projectIds], ['contracts', contractIds.map(c => c.id)],
    ['payments', null], ['invoices', null]];
  for (let i = 0; i < PLAN.logs; i++) {
    const [t, ids] = tablesWithRows[i % tablesWithRows.length];
    insLog.run(dayWithin(900) + ' ' + String(int(0, 23)).padStart(2, '0') + ':' + String(int(0, 59)).padStart(2, '0') + ':00',
      nameOf(), pick(['create', 'update', 'delete', 'batch_delete', 'login']), t,
      ids ? ids[int(0, ids.length - 1)] : null,
      pick(['项目台账', '合同管理', '收付款', '发票管理']), pick(['新建', '修改', '删除']), '');
  }
  console.log(`  操作日志 ${PLAN.logs}`);

  db.exec('COMMIT');

  // ── 汇总 ──
  const counts = [
    ['projects', 'projects'], ['contracts', 'contracts'], ['payments', 'payments'],
    ['invoices', 'invoices'], ['schedules', 'schedules'], ['expenses', 'expenses'],
    ['materials', 'materials'], ['maintenance', 'maintenance'], ['logs', 'logs'],
    ['partners', 'partners'],
  ].map(([label, t]) => `${label} ${db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n}`);

  const size = fs.existsSync(dbFile) ? (fs.statSync(dbFile).size / 1024 / 1024).toFixed(1) : '?';
  console.log('\n完成，用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s，库文件 ' + size + ' MB');
  console.log('  ' + counts.join('  '));
  console.log('\n下一步：node tools/load-test.js --dir "' + DIR + '"');
}

main();
