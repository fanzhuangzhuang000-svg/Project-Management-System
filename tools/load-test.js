'use strict';
/**
 * 并发压测 —— 回答一个具体问题：30-50 人同时用，会不会卡？
 *
 * 为什么要自己写：通用压测工具（autocannon/wrk）测的是「接口能不能扛 QPS」，
 * 但这里真正要测的是**主线程阻塞**。同步 SQLite 的架构下，一次慢查询会冻结
 * 整个事件循环 —— 表现不是"这个请求慢"，而是"所有人的所有请求一起慢"。
 * 只有把不同并发档位的延迟分布放在一起比，才看得出是排队还是并行。
 *
 * 判据（写在报告最后）：
 *   · 吞吐随并发线性增长、P95 基本不涨  → 真并行，架构没问题
 *   · 吞吐到某个点不再涨、P95 线性上涨  → 完全串行，撞到主线程天花板
 *
 * 用法：
 *   node tools/load-test.js --dir <数据目录>            # 10/30/50 三档各 15 秒
 *   node tools/load-test.js --dir ... --levels 10,30    # 指定档位
 *   node tools/load-test.js --dir ... --secs 20
 *
 * 数据目录要先用 tools/seed-load.js 造好。
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

function argOf (name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = path.resolve(argOf('--dir', path.join(os.tmpdir(), 'pms-load')));
const LEVELS = String(argOf('--levels', '10,30,50')).split(',').map(Number).filter(n => n > 0);
const SECS = Number(argOf('--secs', '15')) || 15;
const ROOT = path.join(__dirname, '..');

const PORT = Number(argOf('--port', String(8900 + Math.floor(Math.random() * 80))));
const BASE = `http://127.0.0.1:${PORT}`;

// ⚠️ 本机 curl/fetch 走 7897 代理，访问 127.0.0.1 必须绕开
const NO_PROXY = { proxy: undefined };

/** 起服务并等健康检查 */
async function startServer () {
  const env = {
    ...process.env,
    PMS_PORT: String(PORT),
    PMS_DATA_DIR: DIR,
    PMS_NO_AUTO_BACKUP: '1',
    PMS_MAINTENANCE_INTERVAL_MS: '0',
  };
  const srv = spawn(process.execPath, ['--no-warnings', 'server.js'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', d => { log += d.toString(); });
  srv.stderr.on('data', d => { log += d.toString(); });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1500) });
      if (r.ok) return { srv, log: () => log };
    } catch { /* 还没起来 */ }
    await sleep(300);
  }
  throw new Error('服务 30 秒内没起来：\n' + log.slice(-1500));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function pct (arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}

/** 登录拿 cookie */
async function login () {
  const r = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  if (!r.ok) throw new Error('登录失败：' + r.status + ' ' + (await r.text()).slice(0, 200));
  const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [r.headers.get('set-cookie')].filter(Boolean);
  return raw.map(c => String(c).split(';')[0]).join('; ');
}

/**
 * 混合负载。权重按真实使用估：
 * 有人一上班就开看板看进度，有人在录收付款，有人在翻列表找单子。
 */
function buildScenario (cookie, projectIds, contractIds) {
  const req = async (method, url, body) => {
    const t0 = process.hrtime.bigint();
    let status = 0; let err = null;
    try {
      const r = await fetch(BASE + url, {
        method,
        headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
      status = r.status;
      // 必须把响应体读完，否则连接不释放，压测数字会失真（看起来很快）
      await r.arrayBuffer();
    } catch (e) { err = e.message; }
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status, err };
  };

  // 权重表：累计到 100
  const mix = [
    { w: 28, name: '看板',      go: () => req('GET', '/api/dashboard') },
    { w: 22, name: '收付款列表', go: () => req('GET', '/api/list/payments?limit=50&offset=' + (Math.floor(Math.random() * 40) * 50)) },
    { w: 12, name: '项目列表',   go: () => req('GET', '/api/list/projects?limit=50') },
    { w: 12, name: '项目详情',   go: () => req('GET', '/api/project/' + projectIds[Math.floor(Math.random() * projectIds.length)]) },
    { w: 10, name: '合同列表',   go: () => req('GET', '/api/list/contracts?limit=50') },
    { w: 6,  name: '日志',      go: () => req('GET', '/api/logs?limit=50') },
    { w: 6,  name: '保存收付款', go: () => req('POST', '/api/save/payments', {
        project_id: projectIds[Math.floor(Math.random() * projectIds.length)],
        contract_id: contractIds[Math.floor(Math.random() * contractIds.length)],
        direction: 'in', kind: '工程款', amount: Math.round(Math.random() * 10000) / 10 + 100,
        pay_date: new Date().toISOString().slice(0, 10), method: '银行转账',
      }) },
    { w: 4,  name: '导出',      go: () => req('GET', '/api/export/invoices') },
  ];
  const total = mix.reduce((s, m) => s + m.w, 0);
  function pickOne () {
    let r = Math.random() * total;
    for (const m of mix) { r -= m.w; if (r <= 0) return m; }
    return mix[0];
  }
  return { req, pickOne };
}

/** 跑一档并发，返回统计 */
async function runLevel (level, scenario) {
  const perName = new Map();   // name -> { ms: [], ok, bad }
  const allMs = [];
  let ok = 0; let bad = 0;
  const stopAt = Date.now() + SECS * 1000;
  const startedAt = Date.now();

  async function worker () {
    while (Date.now() < stopAt) {
      const s = scenario.pickOne();
      const r = await s.go();
      allMs.push(r.ms);
      if (r.status >= 200 && r.status < 400) ok++; else bad++;
      let e = perName.get(s.name);
      if (!e) { e = { ms: [], ok: 0, bad: 0, slow: 0 }; perName.set(s.name, e); }
      e.ms.push(r.ms);
      if (r.status >= 200 && r.status < 400) e.ok++; else e.bad++;
      if (r.ms > 1000) e.slow++;
    }
  }

  await Promise.all(Array.from({ length: level }, worker));
  const dur = (Date.now() - startedAt) / 1000;
  return { level, dur, allMs, ok, bad, perName, rps: ok / dur };
}

async function main () {
  if (!fs.existsSync(path.join(DIR, 'pms.db'))) {
    console.error('数据目录里没有 pms.db：' + DIR);
    console.error('先生成数据： node tools/seed-load.js --dir "' + DIR + '"');
    process.exit(1);
  }
  console.log('数据目录：' + DIR);
  console.log('服务端口：' + PORT + '（压测期间临时启动，结束后关闭）');

  const { srv, log } = await startServer();
  const results = [];
  try {
    const cookie = await login();

    // 先摸出真实 id 范围（详情/保存要用）
    const pj = await (await fetch(`${BASE}/api/list/projects?limit=200`, { headers: { Cookie: cookie } })).json();
    const projectIds = (pj.rows || []).map(r => r.id);
    const ct = await (await fetch(`${BASE}/api/list/contracts?limit=200`, { headers: { Cookie: cookie } })).json();
    const contractIds = (ct.rows || []).map(r => r.id);
    if (!projectIds.length) throw new Error('数据里没有项目，先跑 seed-load');
    console.log(`样本：${projectIds.length} 个项目 / ${contractIds.length} 份合同\n`);

    const scenario = buildScenario(cookie, projectIds, contractIds);

    // 预热：把连接、语句缓存、页面缓存都跑热，否则第一档会背冷启动的锅
    process.stdout.write('预热…');
    for (let i = 0; i < 20; i++) await scenario.req('GET', '/api/dashboard');
    console.log(' 完成\n');

    for (const lv of LEVELS) {
      process.stdout.write(`  ${String(lv).padStart(3)} 并发 / ${SECS}s … `);
      const r = await runLevel(lv, scenario);
      results.push(r);
      console.log(`${r.rps.toFixed(1)} req/s · P95 ${pct(r.allMs, 95).toFixed(0)}ms · 错误 ${r.bad}`);
    }
  } finally {
    srv.kill('SIGTERM');
    await sleep(800);
    try { srv.kill('SIGKILL'); } catch { /* 已退出 */ }
  }

  // ── 报告 ──
  const base = results[0];
  console.log('\n' + '='.repeat(78));
  console.log('延迟分布（毫秒）');
  console.log('='.repeat(78));
  console.log('并发  请求数    吞吐      平均    P50    P90    P95    P99    最大   错误');
  for (const r of results) {
    console.log(
      String(r.level).padStart(4) +
      String(r.ok + r.bad).padStart(8) +
      (r.rps.toFixed(1) + ' r/s').padStart(11) +
      (r.allMs.reduce((a, b) => a + b, 0) / r.allMs.length).toFixed(0).padStart(7) +
      pct(r.allMs, 50).toFixed(0).padStart(7) +
      pct(r.allMs, 90).toFixed(0).padStart(7) +
      pct(r.allMs, 95).toFixed(0).padStart(7) +
      pct(r.allMs, 99).toFixed(0).padStart(7) +
      pct(r.allMs, 100).toFixed(0).padStart(7) +
      String(r.bad).padStart(7)
    );
  }

  // 分类看：哪一个接口在拖后腿
  const names = new Set();
  for (const r of results) for (const k of r.perName.keys()) names.add(k);
  console.log('\n' + '='.repeat(78));
  console.log('按接口拆（每格：P95 / 平均，毫秒）');
  console.log('='.repeat(78));
  const head = ['接口'.padEnd(14)];
  for (const r of results) head.push((r.level + ' 并发').padStart(14));
  console.log(head.join(''));
  for (const n of names) {
    const row = [n.padEnd(14)];
    for (const r of results) {
      const e = r.perName.get(n);
      row.push((e ? `${pct(e.ms, 95).toFixed(0)} / ${(e.ms.reduce((a, b) => a + b, 0) / e.ms.length).toFixed(0)}` : '—').padStart(14));
    }
    console.log(row.join(''));
  }

  // ── 判据 ──
  console.log('\n' + '='.repeat(78));
  console.log('结论');
  console.log('='.repeat(78));
  const hi = results[results.length - 1];
  const rpsRatio = hi.rps / base.rps;
  const lvRatio = hi.level / base.level;
  const p95Ratio = pct(hi.allMs, 95) / Math.max(1, pct(base.allMs, 95));

  console.log(`吞吐：${base.level} 并发 ${base.rps.toFixed(1)} → ${hi.level} 并发 ${hi.rps.toFixed(1)}（×${rpsRatio.toFixed(2)}，并发 ×${lvRatio}）`);
  console.log(`P95 ：${pct(base.allMs, 95).toFixed(0)}ms → ${pct(hi.allMs, 95).toFixed(0)}ms（×${p95Ratio.toFixed(2)}）`);

  if (rpsRatio > lvRatio * 0.6) {
    console.log('→ 吞吐基本跟着并发走：请求是真并行处理的，架构上没有硬天花板。');
  } else {
    console.log('→ 并发涨了 ' + lvRatio.toFixed(0) + ' 倍，吞吐只涨了 ' + rpsRatio.toFixed(1) + ' 倍：');
    console.log('  请求在排队，主线程是瓶颈（同步查询阻塞事件循环）。');
  }
  const worst = [...hi.perName.entries()].sort((a, b) => pct(b[1].ms, 95) - pct(a[1].ms, 95))[0];
  if (worst) {
    console.log(`→ 最慢的接口：${worst[0]}（P95 ${pct(worst[1].ms, 95).toFixed(0)}ms，平均 ${(worst[1].ms.reduce((a, b) => a + b, 0) / worst[1].ms.length).toFixed(0)}ms）`);
  }
  if (hi.bad > 0) console.log(`⚠️ 错误 ${hi.bad} 个，看上面分类里哪一项 bad 最多`);

  console.log('\n服务端日志尾巴：');
  console.log(log().split('\n').slice(-8).join('\n'));
}

main().catch(e => { console.error('\n[压测失败] ' + e.message); process.exit(1); });
