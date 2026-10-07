'use strict';
/**
 * 给 AI 助手截图：起一个假模型 → 配好 → 在真实浏览器里问一句 → 截图
 * 用法： node tools/shot-ai.js [url] [输出目录]
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const T = require('./test-auth.js');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'pms_ai_shots');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9555, MOCK = 18897;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const REPLY = `按目前的账，**回款问题集中在两个项目**，建议按下面的顺序催：

1. **市第一人民医院新院区** —— 逾期最严重
   - 进度款 24.4 万，已逾期 **249 天**
   - 验收款 146.5 万，已逾期 98 天
   - 合计 170.9 万，占全部应收的 46.7%

2. **城建·云鼎广场** —— 回款率只有 50.0%
   - 已收 159.0 万 / 合同 318.0 万，还有 159.0 万没到

| 项目 | 应收 | 逾期天数 | 建议动作 |
|---|---|---|---|
| 第一人民医院 | 170.9 万 | 249 天 | 本周发正式催款函 |
| 云鼎广场 | 159.0 万 | 未到期 | 提前对账，锁定付款节点 |

**核算口径**：应收 366.3 万 − 未到期 188.3 万 = 逾期 178.0 万。`;

(async () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 假模型
  const mock = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c });
    req.on('end', () => {
      let p = {}; try { p = JSON.parse(b) } catch { /* 忽略 */ }
      if (!p.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: '正常' } }] }));
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const pieces = REPLY.match(/[\s\S]{1,10}/g) || [];
      let i = 0;
      const t = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(t);
          res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }] }) + '\n\n');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] }) + '\n\n');
      }, 18);
    });
  });
  await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));

  T.forceAdminPassword();
  const tk = await T.login();
  const H = { Cookie: 'pms_session=' + tk, 'Content-Type': 'application/json' };
  await fetch(BASE + '/api/ai/config', {
    method: 'POST', headers: H, body: JSON.stringify({
      provider: 'deepseek', baseUrl: `http://127.0.0.1:${MOCK}/v1`, model: 'deepseek-chat',
      apiKey: 'sk-test-screenshot', enabled: true, includeContext: true,
    }),
  });

  const prof = path.join(os.tmpdir(), 'pms_ai_prof');
  fs.rmSync(prof, { recursive: true, force: true });
  const c = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });

  let tg = null;
  for (let i = 0; i < 60; i++) { try { tg = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (tg.some(x => x.type === 'page')) break } catch { } await sleep(250) }
  const page = tg.find(x => x.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pend = new Map(); let s = 0;
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, q = {}) => new Promise(r => { const id = ++s; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: q })) });
  const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const wait = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(x)) return true } catch { } await sleep(200) } return false };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });

  // 登录
  await send('Page.navigate', { url: BASE + '/' });
  await wait(`!!document.querySelector('input[autocomplete="username"]')`, 15000);
  await sleep(900);
  await ev(`(() => { const i = document.querySelectorAll('input');
    const set = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})) };
    set(i[0], ${JSON.stringify(T.USER)}); set(i[1], ${JSON.stringify(T.PASS)}); })()`);
  await ev(`document.querySelector('button[type="submit"]').click()`);
  await wait(`!!document.querySelector('aside')`, 20000);
  await sleep(2200);

  // 打开助手并提问
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('智能项目分析助手')); b && b.click(); })()`);
  await sleep(1200);
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('哪些项目回款有问题')); b && b.click(); })()`);
  for (let i = 0; i < 60; i++) { await sleep(300); if (await ev(`document.body.innerText.includes('核算口径')`)) break }
  await sleep(900);

  const shot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return fs.statSync(file).size;
  };

  let kb = Math.round(await shot(path.join(OUT, '13-智能助手对话.png')) / 1024);
  console.log(`  13-智能助手对话.png        ${kb} KB`);

  // 总览页的今日经营简报
  await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('智能项目分析助手')); b && b.click(); })()`);
  await sleep(600);
  for (let i = 0; i < 60; i++) { await sleep(500); if (await ev(`document.body.innerText.includes('今日经营简报')`)) break }
  await sleep(900);
  kb = Math.round(await shot(path.join(OUT, '15-今日经营简报.png')) / 1024);
  console.log(`  15-今日经营简报.png        ${kb} KB`);

  // 设置页
  await ev(`location.hash = '#/settings'`);
  await sleep(2500);
  await wait(`document.body.innerText.includes('智能助手')`, 10000);
  await sleep(800);
  kb = Math.round(await shot(path.join(OUT, '14-智能助手配置.png')) / 1024);
  console.log(`  14-智能助手配置.png        ${kb} KB`);

  // 还原
  await fetch(BASE + '/api/ai/config', { method: 'POST', headers: H, body: JSON.stringify({ enabled: false, apiKey: null }) });
  c.kill(); mock.close();
  console.log(`\n  输出目录：${OUT}`);
  process.exit(0);
})().catch(async e => { console.error('  ✗ ' + e.message); process.exit(1) });
