'use strict';
/** React 界面截图：登录后逐页截图，供人工核对设计规格 */
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const T = require('./test-auth.js');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const OUT = process.argv[3] || path.join(os.tmpdir(), 'pms_shots');
const PORT = 9560;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SHOTS = [
  { name: '01-登录页', hash: null, w: 1440, h: 900, full: false },
  { name: '02-首页概览', hash: '/dashboard', w: 1680, h: 1050, full: true },
  { name: '03-首页概览-窄屏', hash: '/dashboard', w: 1280, h: 900, full: true },
  { name: '04-项目列表', hash: '/t/projects', w: 1680, h: 1050, full: true },
  { name: '05-合同管理', hash: '/t/contracts', w: 1680, h: 1000, full: false },
  { name: '06-报表统计', hash: '/reports', w: 1680, h: 1050, full: true },
  { name: '07-成员管理', hash: '/users', w: 1680, h: 1000, full: false },
  { name: '08-系统设置', hash: '/settings', w: 1680, h: 1000, full: false },
  { name: '09-附件中心', hash: '/attachments', w: 1680, h: 950, full: false },
  { name: '10-数据导入', hash: '/import', w: 1680, h: 950, full: false },
];

(async () => {
  T.forceAdminPassword();
  fs.mkdirSync(OUT, { recursive: true });
  const prof = path.join(os.tmpdir(), 'pms_shot_react');
  fs.rmSync(prof, { recursive: true, force: true });
  const c = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });
  let tg = null;
  for (let i = 0; i < 60; i++) {
    try { tg = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (tg.some(t => t.type === 'page')) break } catch { /* 等 */ }
    await sleep(250);
  }
  const page = tg.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pend = new Map(); let s = 0;
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id) } });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, q = {}) => new Promise(r => { const id = ++s; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: q })) });
  const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const wait = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(x)) return true } catch { /* 重试 */ } await sleep(200) } return false };
  const shot = async (file, full) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!full });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return fs.statSync(file).size;
  };

  await send('Page.enable'); await send('Runtime.enable');

  // 登录页
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: 'http://127.0.0.1:8787/' });
  await wait(`!!document.querySelector('input[autocomplete="username"]')`, 15000);
  await sleep(900);
  console.log('  01-登录页.png  ' + Math.round(await shot(path.join(OUT, '01-登录页.png'), false) / 1024) + ' KB');

  // 登录
  await ev(`(() => { const i = document.querySelectorAll('input');
    const set = (el, v) => { Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, v); el.dispatchEvent(new Event('input',{bubbles:true})) };
    set(i[0], ${JSON.stringify(T.USER)}); set(i[1], ${JSON.stringify(T.PASS)}); })()`);
  await ev(`document.querySelector('button[type="submit"]').click()`);
  await wait(`!!document.querySelector('aside')`, 20000);
  await sleep(1500);

  for (const sh of SHOTS.slice(1)) {
    await send('Emulation.setDeviceMetricsOverride', { width: sh.w, height: sh.h, deviceScaleFactor: 1, mobile: false });
    await ev(`location.hash = '#${sh.hash}'`);
    await sleep(1800);
    await wait(`!!document.querySelector('h1')`, 10000);
    await sleep(1200);   // 等图表动画
    const kb = Math.round(await shot(path.join(OUT, sh.name + '.png'), sh.full) / 1024);
    console.log(`  ${sh.name}.png  ${kb} KB`);
  }

  // 对账单页（需要先拿到一个项目 id）
  try {
    const pid = await ev(`fetch('/api/list/projects?limit=1').then(r=>r.json()).then(d=>d.rows[0].id)`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 1400, deviceScaleFactor: 1, mobile: false });
    await ev(`location.hash = '#/statement/${pid}'`);
    await sleep(2200);
    await wait(`!!document.querySelector('h1')`, 10000);
    await sleep(900);
    const kb = Math.round(await shot(path.join(OUT, '11-项目对账单.png'), false) / 1024);
    console.log(`  11-项目对账单.png  ${kb} KB`);
  } catch { console.log('  对账单截图跳过') }

  // 识别结果面板（上传一张样例合同 → 等识别 → 打开面板）
  let ocrId = null;
  try {
    const token = await T.login();
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'contract.pdf'));
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/pdf' }), '示例-合同扫描件.pdf');
    const up = await fetch('http://127.0.0.1:8787/api/upload', {
      method: 'POST', headers: { Cookie: 'pms_session=' + token }, body: fd,
    }).then(r => r.json());
    ocrId = up.attachment?.id || null;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const l = await fetch('http://127.0.0.1:8787/api/attachments?q=' + encodeURIComponent('示例-合同扫描件'), {
        headers: { Cookie: 'pms_session=' + token },
      }).then(r => r.json());
      if ((l.rows || [])[0]?.ocr_status === 'done') break;
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await ev(`location.hash = '#/attachments'`);
    await sleep(1800);
    await ev(`(() => {
      const i = [...document.querySelectorAll('main input')].find(x => (x.placeholder || '').includes('搜索'));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(i, '示例-合同扫描件'); i.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(1500);
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('识别结果')); b && b.click(); })()`);
    await sleep(1200);
    const kb = Math.round(await shot(path.join(OUT, '12-扫描件识别结果.png'), false) / 1024);
    console.log(`  12-扫描件识别结果.png  ${kb} KB`);
  } catch (e) { console.log('  识别面板截图跳过：' + e.message.slice(0, 40)) }
  finally {
    // 清理截图用的样例附件
    try {
      const token = await T.login();
      if (ocrId) await fetch('http://127.0.0.1:8787/api/attachments/' + ocrId + '/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'pms_session=' + token }, body: '{}',
      });
      await fetch('http://127.0.0.1:8787/api/trash/purge-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'pms_session=' + token }, body: '{}',
      });
    } catch { /* 忽略 */ }
  }

  console.log('\n  输出目录：' + OUT);
  c.kill();
  process.exit(0);
})().catch(e => { console.error('[截图失败]', e.message); process.exit(1) });
