'use strict';
/**
 * 慢查询探针 —— 在**真实的 HTTP 服务进程里**给每条 SQL 计时
 *
 * 为什么需要它：同一个 dbf.dashboard()，
 *   · 在独立脚本里跑 → 350ms
 *   · 在 HTTP 端点里跑 → 1400ms
 * 差了整整 1 秒，说明差异来自进程状态或调用链，而不是 SQL 本身。
 * 靠在外部猜没用，直接把探针塞进服务进程里看。
 *
 * 用法：
 *   node tools/probe-slow.js            # 起服务，每条慢 SQL 打到 stderr
 *   然后另开一个终端 curl，就能看到这 1 秒花在哪了
 *
 * 原理：先 require('./db.js')，把 db.prepare 包一层计时，**再** require('./server.js')。
 * 因为 Node 的模块缓存是单例，server.js 拿到的就是被包过的那个 db。
 */
const path = require('node:path');

process.env.PMS_NO_AUTO_BACKUP = '1';
process.env.PMS_MAINTENANCE_INTERVAL_MS = '0';
if (!process.env.PMS_PORT) process.env.PMS_PORT = '8960';
if (!process.env.PMS_DATA_DIR) {
  process.env.PMS_DATA_DIR = path.join(require('node:os').tmpdir(), 'pms-load');
}

const THRESHOLD_MS = Number(process.env.PROBE_THRESHOLD || 10);

const dbf = require('../db.js');
const db = dbf.db;
const origPrepare = db.prepare.bind(db);

let current = [];       // 当前这批（一次请求内）的慢 SQL
const slowLog = [];
let seq = 0;

db.prepare = function (sql) {
  const stmt = origPrepare(sql);
  return new Proxy(stmt, {
    get (target, prop) {
      const v = target[prop];
      if (typeof v === 'function' && ['all', 'get', 'run'].includes(prop)) {
        return function (...args) {
          const t0 = process.hrtime.bigint();
          try {
            return v.apply(target, args);
          } finally {
            const ms = Number(process.hrtime.bigint() - t0) / 1e6;
            if (ms >= THRESHOLD_MS) {
              const brief = sql.replace(/\s+/g, ' ').trim().slice(0, 100);
              slowLog.push({ ms, brief });
              current.push({ ms, brief });
              console.error(`[慢SQL ${ms.toFixed(0)}ms] ${brief}`);
            }
          }
        };
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
};

// 每个请求结束时汇总一次：整条链路一共多少毫秒、多少条 SQL
const origCreate = require('node:http').createServer;
require('node:http').createServer = function (handler) {
  return origCreate.call(this, function (req, res) {
    const t0 = process.hrtime.bigint();
    current = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (ms >= 100) {
        const sum = current.reduce((s, x) => s + x.ms, 0);
        console.error(
          `[请求 #${++seq}] ${req.method} ${req.url.slice(0, 60)}  总计 ${ms.toFixed(0)}ms`
          + `  （其中 ${current.length} 条慢SQL 合计 ${sum.toFixed(0)}ms，未计入的 ${(ms - sum).toFixed(0)}ms）`
        );
        // 未计入的那部分才是真凶：JSON 序列化、JS 计算、或者根本没走 SQL
      }
    };
    res.on('finish', finish);
    res.on('close', finish);
    return handler(req, res);
  });
};

console.error(`慢查询探针已挂上（阈值 ${THRESHOLD_MS}ms），端口 ${process.env.PMS_PORT}，数据 ${process.env.PMS_DATA_DIR}`);
require('../server.js');
