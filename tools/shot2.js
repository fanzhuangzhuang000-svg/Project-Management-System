'use strict';
/**
 * 一次性截图脚本：直接用会话 Cookie 进入系统截首页（新 2.0 首页验收用）
 *   node tools/shot2.js [baseUrl] [输出目录]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TAUTH = require('./test-auth.js');

const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'pms_shots2');
const PORT = 9445;
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find(p => fs.existsSync(p));

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async function main () {
  if (!EDGE) throw new Error('未找到 Edge/Chrome');
  fs.mkdirSync(OUT, { recursive: true });
  TAUTH.forceAdminPassword();
  const token = await TAUTH.login();

  const profile = path.join(os.tmpdir(), 'pms_shot_profile2');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1920,1080', 'about:blank',
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

    await send('Page.enable');

    // 先开一次站点拿 origin，再种 Cookie（Cookie 域绑定 origin）
    await send('Page.navigate', { url: BASE + '/' });
    await sleep(1200);
    await send('Network.enable');
    await send('Network.setCookie', {
      name: 'pms_session', value: token, url: BASE + '/', httpOnly: false,
    });
    // ⚠️ 从 / 到 /#/dashboard 只是同文档 hash 跳转，App 不会重新查登录态；
    // 必须整页 reload 一次，让带 Cookie 的 /api/me 跑起来。
    await send('Page.reload');

    const shot = async (file, full) => {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      return fs.statSync(file).size;
    };

    // 首页 1920×1080（设计稿目标分辨率）
    await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: BASE + '/#/dashboard' });
    await sleep(1500);
    // 等 React 挂载出侧栏
    for (let i = 0; i < 30; i++) {
      const ok = await evaluate(`!!document.querySelector('nav a')`).catch(() => false);
      if (ok) break;
      await sleep(300);
    }
    await sleep(1200); // 等数字动画
    let size = await shot(path.join(OUT, 'dashboard-1920-light.png'), false);
    console.log('dashboard-1920-light.png  ' + (size / 1024).toFixed(0) + ' KB');

    // 深色主题
    await evaluate(`document.documentElement.setAttribute('data-theme','dark'); localStorage.setItem('pms.theme','dark'); true`);
    await sleep(700);
    size = await shot(path.join(OUT, 'dashboard-1920-dark.png'), false);
    console.log('dashboard-1920-dark.png  ' + (size / 1024).toFixed(0) + ' KB');
    await evaluate(`document.documentElement.setAttribute('data-theme','light'); localStorage.setItem('pms.theme','light'); true`);

    // 整页长图（看完整布局）
    size = await shot(path.join(OUT, 'dashboard-full.png'), true);
    console.log('dashboard-full.png  ' + (size / 1024).toFixed(0) + ' KB');

    // 结构自检：三栏、渐变卡、统计卡、环形、进度条
    const checks = await evaluate(`(() => {
      const aside = document.querySelector('aside');
      const asides = [...document.querySelectorAll('aside')];
      return {
        asideCount: asides.length,
        sidebarW: asides[0] ? Math.round(asides[0].getBoundingClientRect().width) : 0,
        rightW: asides.length > 1 ? Math.round(asides[1].getBoundingClientRect().width) : 0,
        navItems: document.querySelectorAll('nav a').length,
        entryCards: [...document.querySelectorAll('a[data-grad]')].length,
        bigStats: [...document.querySelectorAll('.num-in')].length,
        todoDonut: !!document.querySelector('svg circle'),
        progressBars: [...document.querySelectorAll('.h-2.overflow-hidden')].length,
        aiFab: !!document.querySelector('button[title="智能项目分析助手"]'),
        quickGrid: [...document.querySelectorAll('button .rounded-xl')].length,
      };
    })()`);
    console.log('结构检查: ' + JSON.stringify(checks));

    console.log('\n输出目录：' + OUT);
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
  }
  process.exit(0);
})().catch(e => { console.error('[截图失败]', e.message); process.exit(1); });
