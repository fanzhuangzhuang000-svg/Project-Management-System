'use strict';
/**
 * 截图工具：登录后把指定页面截成 PNG，用于人工/自动核对视觉效果
 *   node tools/shot.js [baseUrl] [输出目录]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TAUTH = require('./test-auth.js');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'pms_shots');
const PORT = 9444;
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHOTS = [
  { name: '01-登录页', hash: null, before: 'logout', w: 1440, h: 900, full: false },
  { name: '02-驾驶舱', hash: '#/dashboard', w: 1680, h: 1050, full: true },
  { name: '03-驾驶舱窄屏', hash: '#/dashboard', w: 1280, h: 900, full: true },
  { name: '04-项目台账', hash: '#/t/projects', w: 1600, h: 1000, full: false },
  { name: '05-项目详情', hash: '#/p/125', w: 1600, h: 1050, full: false },
  { name: '06-对账单', hash: '#/statement/125', w: 1100, h: 1200, full: true },
  { name: '07-账号管理', hash: '#/users', w: 1600, h: 900, full: false },
];

(async function main () {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  fs.mkdirSync(OUT, { recursive: true });
  TAUTH.forceAdminPassword();
  await TAUTH.resetTestData();

  const profile = path.join(os.tmpdir(), 'pms_shot_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1680,1050', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        if (targets.some(t => t.type === 'page')) break;
      } catch { /* 等待 */ }
      await sleep(250);
    }
    const page = (targets || []).find(t => t.type === 'page');
    if (!page) throw new Error('无法连接调试端口');

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    const send = (method, params = {}) => new Promise(res => {
      const id = ++seq; pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async expr => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const waitFor = async (expr, ms, what) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { if (await evaluate(expr)) return true; } catch { /* 重试 */ }
        await sleep(180);
      }
      throw new Error('等待超时：' + what);
    };
    const shot = async (file, full) => {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      return fs.statSync(file).size;
    };

    await send('Page.enable');
    await send('Runtime.enable');

    // ---- 登录 ----
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '/' });
    await waitFor(`!!document.querySelector('#login-form')`, 15000, '登录页');
    await sleep(600);
    let size = await shot(path.join(OUT, '01-登录页.png'), false);
    console.log('  01-登录页.png  ' + (size / 1024).toFixed(0) + ' KB');

    await evaluate(`(() => { const f = document.querySelector('#login-form');
      f.username.value = ${JSON.stringify(TAUTH.USER)}; f.password.value = ${JSON.stringify(TAUTH.PASS)}; })()`);
    await evaluate(`document.querySelector('#login-btn').click()`);
    await waitFor(`!!document.querySelector('#nav .nav-item')`, 15000, '进入系统');

    // ---- 逐页截图 ----
    for (const s of SHOTS.slice(1)) {
      await send('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url: BASE + '/' + s.hash });
      await sleep(400);
      await send('Page.navigate', { url: BASE + '/' + s.hash });   // 触发 hashchange 渲染
      await sleep(1400);
      try { await waitFor(`document.querySelector('#view').innerText.length > 80`, 10000, s.name); } catch { /* 继续截图 */ }
      await sleep(900);   // 等数字滚动动画结束
      size = await shot(path.join(OUT, s.name + '.png'), s.full);
      console.log('  ' + s.name + '.png  ' + (size / 1024).toFixed(0) + ' KB');
    }
    console.log('\n输出目录：' + OUT);
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
  }
  process.exit(0);
})().catch(e => { console.error('[截图失败]', e.message); process.exit(1); });
