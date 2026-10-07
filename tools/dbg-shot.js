'use strict';
/** 一次性调试：看 headless 浏览器里页面到底渲染了什么 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const TAUTH = require('./test-auth.js');

const PORT = 9446;
const BASE = process.argv[2] || 'http://127.0.0.1:8788';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  TAUTH.forceAdminPassword();
  const token = await TAUTH.login();
  const EDGE = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
  ].find(p => fs.existsSync(p));
  const profile = path.join(os.tmpdir(), 'pms_dbg4');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile, '--window-size=1920,1080', 'about:blank'], { stdio: 'ignore' });
  let targets = null;
  for (let i = 0; i < 60; i++) {
    try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (targets.some(t => t.type === 'page')) break } catch { /* wait */ }
    await sleep(250);
  }
  const page = targets.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map(); let seq = 0;
  ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } });
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) });
  const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(1500);
  await send('Network.enable');
  await send('Network.setCookie', { name: 'pms_session', value: token, url: BASE + '/', httpOnly: false });
  await send('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/#/dashboard' });
  await sleep(2500);
  const info = await evaluate(`(() => ({
    url: location.href,
    rootLen: (document.getElementById('root')||{}).innerHTML?.length || 0,
    bodyHead: document.body.innerText.slice(0, 500),
    asideCount: document.querySelectorAll('aside').length,
  }))()`);
  console.log(JSON.stringify(info, null, 2));
  child.kill();
  process.exit(0);
})().catch(e => { console.error('ERR', e.message); process.exit(1) });
