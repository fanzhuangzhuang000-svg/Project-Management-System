'use strict';
// 纯读压测对照：只打轻量列表接口，排除写锁与重聚合，专测 worker 并行度
// 用法： node tools/bench-readonly.js <port> [secs] [concurrency]
const http = require('node:http');
const PORT = Number(process.argv[2]) || 8901;
const SECS = Number(process.argv[3]) || 10;
const CONC = Number(process.argv[4]) || 30;
const BASE = `http://127.0.0.1:${PORT}`;

function req (p, cookie) {
  return new Promise((resolve, reject) => {
    http.get(BASE + p, { headers: { Cookie: cookie } }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    }).on('error', reject);
  });
}

async function main () {
  // 登录
  const cookie = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ username: 'admin', password: 'admin123' });
    const r = http.request(BASE + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } }, res => {
      resolve((res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; '));
      res.resume();
    });
    r.on('error', reject); r.end(data);
  });

  const deadline = Date.now() + SECS * 1000;
  let done = 0, errs = 0;
  const lat = [];
  const worker = async () => {
    while (Date.now() < deadline) {
      const t0 = process.hrtime.bigint();
      try {
        const s = await req('/api/list/payments?limit=50&offset=' + (Math.floor(Math.random() * 40) * 50), cookie);
        if (s !== 200) errs++;
      } catch { errs++; }
      lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
      done++;
    }
  };
  await Promise.all(Array.from({ length: CONC }, worker));
  lat.sort((a, b) => a - b);
  const p = q => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
  console.log(`纯读 ${CONC} 并发 / ${SECS}s：${(done / SECS).toFixed(1)} r/s · P50 ${p(0.5).toFixed(0)}ms · P95 ${p(0.95).toFixed(0)}ms · 错误 ${errs}`);
}
main().catch(e => { console.error(e); process.exit(1); });
