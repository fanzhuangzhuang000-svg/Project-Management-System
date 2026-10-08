'use strict';
/**
 * 深色主题「亮色残留」审计 + 逐页截图
 *
 * 为什么要有这个工具：
 *   深色模式出问题的地方永远是同一类 —— 某个元素写死了 bg-white / bg-slate-50 /
 *   bg-red-50，浅色主题下完全看不出来，切到深色就成了一块刺眼的亮斑。
 *   靠人一页页翻着找必然漏（本项目已经漏过两轮），所以改成机器全量扫一遍：
 *   对每个可见元素算「自身背景 与 父级背景合成后的实际亮度」，
 *   在深色主题下凡是实际亮度 > 阈值、或者「暗字压暗底」的，全部列出来。
 *
 * 用法：
 *   node tools/ui-theme-audit.js                       # 深色审计，有发现就退出码 1
 *   node tools/ui-theme-audit.js --themes=dark,light    # 两个主题都扫
 *   node tools/ui-theme-audit.js --pages=settings       # 只扫指定页
 *   node tools/ui-theme-audit.js --shot                 # 顺带逐页存截图
 *
 * 需要：本机有 Edge（msedge.exe）、目标实例已启动（默认 http://127.0.0.1:9100）。
 *   PMS_BASE     目标实例（默认 127.0.0.1:9100）
 *   PMS_UI_USER / PMS_UI_PASS  管理员账号（默认 admin / admin123，首登会改密）
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BASE = process.env.PMS_BASE || 'http://127.0.0.1:9100';
const USER = process.env.PMS_UI_USER || 'admin';
const PASS = process.env.PMS_UI_PASS || 'admin123';
const WANT_PASS = process.env.PMS_UI_NEWPASS || 'Uicheck-12345';
const EDGE = process.env.PMS_EDGE || 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = Number(process.env.PMS_CDP_PORT || 9562);
const OUT = process.env.PMS_SHOT_DIR || path.join(os.tmpdir(), 'pms_theme_shots');

const argv = process.argv.slice(2);
const has = f => argv.includes(f);
const val = (k, d) => { const a = argv.find(x => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : d; };
const THEMES = val('themes', 'dark').split(',').map(s => s.trim()).filter(Boolean);
const ONLY = val('pages', '').split(',').map(s => s.trim()).filter(Boolean);
const SHOT = has('--shot') || process.env.PMS_SHOT === '1';
const LAYOUT = has('--layout') || process.env.PMS_LAYOUT === '1';
const PALETTE = has('--palette') || process.env.PMS_PALETTE === '1';

/** 深色主题下：合成亮度超过这个值就算「亮色残留」（0~1） */
const DARK_LIMIT = Number(process.env.PMS_DARK_LIMIT || 0.6);
/** 浅色主题下：低于这个值算「暗色残留」 */
const LIGHT_LIMIT = Number(process.env.PMS_LIGHT_LIMIT || 0.25);

const PAGES = [
  { name: '01-首页概览', hash: '/dashboard' },
  { name: '02-项目列表', hash: '/t/projects' },
  { name: '03-合同管理', hash: '/t/contracts' },
  { name: '04-收付款', hash: '/t/payments' },
  { name: '05-报表统计', hash: '/reports' },
  { name: '06-成员管理', hash: '/users' },
  { name: '07-系统设置', hash: '/settings' },
  { name: '08-附件中心', hash: '/attachments' },
  { name: '09-数据导入', hash: '/import' },
  { name: '10-操作日志', hash: '/logs' },
  { name: '11-回收站', hash: '/trash' },
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- 审计表达式 */
/**
 * 在页面里跑：返回所有「可疑元素」。
 * 亮度用 sRGB 相对亮度加权（人眼对绿最敏感），比 RGB 平均值准。
 */
const AUDIT_FN = `(() => {
  const LIMIT_DARK = ${DARK_LIMIT}, LIMIT_LIGHT = ${LIGHT_LIMIT};
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  const limit = dark ? LIMIT_DARK : LIMIT_LIGHT;
  const parse = s => {
    const m = /rgba?\\(([^)]+)\\)/.exec(s || '');
    if (!m) return null;
    const p = m[1].split(',').map(v => parseFloat(v));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = c => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  // 半透明背景按 alpha 合成到父级实际背景上，才是眼睛看到的颜色
  const over = (top, bot) => ({
    r: top.r * top.a + bot.r * (1 - top.a),
    g: top.g * top.a + bot.g * (1 - top.a),
    b: top.b * top.a + bot.b * (1 - top.a),
    a: 1,
  });
  const PAGE = { r: dark ? 15 : 240, g: dark ? 23 : 244, b: dark ? 42 : 255, a: 1 };
  // 同级里铺了一块「绝对定位 + 渐变」的兄弟节点并盖住自己 —— 本项目首页入口卡
  // 就是这么写的（<Link> 里放一个 absolute inset-0 的渐变层，文字是它的兄弟）。
  // 这种情况祖先链上找不到渐变，必须靠兄弟节点判断，否则白字会被误报成白底白字。
  const hasCoveringGradient = el => {
    const r0 = el.getBoundingClientRect();
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const parent = n.parentElement;
      if (!parent) break;
      for (const sib of parent.children) {
        if (sib === n) continue;
        const scs = getComputedStyle(sib);
        if (!scs.backgroundImage || scs.backgroundImage === 'none') continue;
        if (scs.position !== 'absolute' && scs.position !== 'fixed') continue;
        const sb = sib.getBoundingClientRect();
        if (sb.left <= r0.left + 1 && sb.right >= r0.right - 1 &&
            sb.top <= r0.top + 1 && sb.bottom >= r0.bottom - 1) return true;
      }
    }
    return false;
  };
  // 返回 null = 底色是渐变/图片（彩色卡片），亮度无从比较，直接跳过该元素。
  // 不这样处理的话，渐变卡里的白字会被误报成「白字白底」。
  const effBg = el => {
    const chain = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null;
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) chain.push(c);
      if (n === document.body) break;
    }
    // 只有 body 一层实色（元素自己到 body 之间都是透明的）→ 可能被兄弟渐变层盖着
    if (chain.length <= 1 && hasCoveringGradient(el)) return null;
    let acc = PAGE;
    for (let i = chain.length - 1; i >= 0; i--) acc = over(chain[i], acc);
    return acc;
  };
  const sig = el => {
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/)
      .filter(c => c && !/^(animate-|duration-|ease-)/.test(c)).slice(0, 6).join('.');
    return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
  };
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg')) continue;
    if (el.tagName === 'IMG' || el.tagName === 'CANVAS') continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') continue;   // 渐变卡片是刻意的
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) continue;
    if (r.bottom < -2000 || r.top > 8000) continue;

    const own = parse(cs.backgroundColor);
    const bg = effBg(el);
    if (!bg) continue;                 // 渐变底（彩色卡片）内部不判亮度
    const bgLum = lum(bg);
    const fg = parse(cs.color);
    const fgLum = fg && fg.a > 0.4 ? lum(over(fg, bg)) : null;
    const reasons = [];
    // 小圆点（状态灯、图例色块）本来就是高饱和的小色块，不算「亮色残留」；
    // 只有「灰白」色块或面积较大的亮块才算 —— 那才是写死 bg-white/slate-50 的症状。
    const mx = Math.max(bg.r, bg.g, bg.b), mn = Math.min(bg.r, bg.g, bg.b);
    const achromatic = (mx - mn) < 30;
    const big = r.width * r.height > 3000;
    // ① 实际亮度反了：深色主题下出现亮块 / 浅色主题下出现暗块
    if (dark) { if (bgLum > limit && (achromatic || big)) reasons.push('亮底'); }
    else if (bgLum < limit && (achromatic || big)) reasons.push('暗底');
    // ② 文字压在底色上对比不足（同向且都偏暗/偏亮）
    if (fgLum !== null) {
      if (dark && fgLum < 0.34 && bgLum < 0.34) reasons.push('暗字暗底');
      if (!dark && fgLum > 0.82 && bgLum > 0.82) reasons.push('亮字亮底');
    }
    if (!reasons.length) continue;
    const key = sig(el) + '|' + reasons.join(',') + '|' + Math.round(bgLum * 100);
    out.push({
      sig: sig(el), reasons, bgLum: Number(bgLum.toFixed(3)),
      fgLum: fgLum === null ? null : Number(fgLum.toFixed(3)),
      own: own && own.a > 0 ? 'rgba(' + [own.r, own.g, own.b, own.a].join(',') + ')' : 'transparent',
      eff: 'rgb(' + [bg.r, bg.g, bg.b].map(v => Math.round(v)).join(',') + ')',
      w: Math.round(r.width), h: Math.round(r.height),
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30),
      key,
    });
    seen.add(key);
  }
  return { dark, total: out.length, uniq: seen.size, rows: out.slice(0, 400) };
})()`;

/* ---------------------------------------------------------------- 版面探测 */
/**
 * 量页面「留白」：每张卡片内部底部空了多少像素、栅格每一行有没有空洞。
 * 视觉上「留白太多」本质就是这两件事，量出来才有得改。
 */
const LAYOUT_FN = `(() => {
  const r2 = r => ({ t: Math.round(r.top), l: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), b: Math.round(r.bottom) });
  const out = { hash: location.hash, viewportH: window.innerHeight, docH: document.documentElement.scrollHeight, cards: [], grids: [] };
  for (const el of document.querySelectorAll('.card, .card-glass')) {
    const b = el.getBoundingClientRect();
    if (b.height < 8) continue;
    let contentBottom = b.top;
    for (const ch of el.children) {
      const cb = ch.getBoundingClientRect();
      if (cb.height > 2) contentBottom = Math.max(contentBottom, cb.bottom);
    }
    const head = el.querySelector('h1, h2, h3, .text-cardtitle, .text-page');
    out.cards.push({
      title: (head ? head.textContent : (el.textContent || '')).replace(/\\s+/g, ' ').trim().slice(0, 16),
      ...r2(b), empty: Math.round(b.bottom - contentBottom),
      cls: String(el.className).slice(0, 80),
    });
  }
  for (const g of document.querySelectorAll('[class*="grid-cols-"]')) {
    const b = g.getBoundingClientRect();
    if (b.height < 40 || b.width < 200) continue;
    const unit = b.width / 12;
    const kids = [...g.children].filter(k => k.getBoundingClientRect().height > 4).map(k => {
      const kb = k.getBoundingClientRect();
      return { col: Math.round((kb.left - b.left) / unit), span: Math.max(1, Math.round(kb.width / unit)), h: Math.round(kb.height) };
    });
    out.grids.push({ cls: String(g.className).replace(/\\s+/g, ' ').slice(0, 70), ...r2(b), kids });
  }
  return out;
})()`;

/* ---------------------------------------------------------------- 色板快照 */
/**
 * 把当前主题下所有 --c-* 变量读出来，换算成 #RRGGBB。
 * 用途：确认「改主题变量没有动到浅色主题」—— 浅色值必须还是 Tailwind 默认色。
 */
const PALETTE_FN = `(() => {
  const cs = getComputedStyle(document.documentElement);
  const names = [];
  for (const sheet of document.styleSheets) {
    let rules; try { rules = sheet.cssRules } catch { continue }
    for (const r of rules) {
      if (r.style && r.selectorText && r.selectorText.includes(':root')) {
        for (const p of r.style) if (p.startsWith('--c-')) names.push(p);
      }
    }
  }
  const hex = v => {
    const p = String(v).trim().split(/\\s+/).map(Number);
    if (p.length < 3 || p.some(isNaN)) return String(v).trim();
    return '#' + p.slice(0, 3).map(n => n.toString(16).padStart(2, '0').toUpperCase()).join('');
  };
  const out = {};
  for (const n of [...new Set(names)].sort()) out[n] = hex(cs.getPropertyValue(n));
  return out;
})()`;

/* ---------------------------------------------------------------- 浮层用例 */
/**
 * 弹窗 / 下拉 / 抽屉 / 浮球面板只有在"打开"时才存在，逐页截图扫不到它们。
 * 而深色主题最刺眼的白色残留恰恰经常出现在弹窗上（写死 bg-white 的模态框）。
 * 这里用「按文字点按钮」的方式逐个打开，打开后立刻再跑一遍审计。
 */
const OVERLAYS = [
  {
    name: '新建项目弹窗', hash: '/t/projects',
    open: `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes('新建项目')); if (!b) return false; b.click(); return true })()`,
    close: `(() => { const bs = [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === '取消'); bs.length && bs[bs.length - 1].click() })()`,
  },
  {
    name: '顶部用户下拉', hash: '/t/projects',
    open: `(() => { const h = document.querySelector('header'); const b = [...h.querySelectorAll('button')].find(x => x.querySelector('span.relative.inline-flex')); if (!b) return false; b.click(); return true })()`,
    close: `(() => { document.body.click() })()`,
  },
  {
    name: '搜索联想下拉', hash: '/t/projects',
    open: `(() => { const i = document.querySelector('header input'); if (!i) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(i, 'a'); i.dispatchEvent(new Event('input', { bubbles: true })); return true })()`,
    close: `(() => { const i = document.querySelector('header input'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })) })()`,
  },
  {
    name: 'AI 助手面板', hash: '/dashboard',
    open: `(() => { const bs = [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 50 && r.width < 80 && r.bottom > window.innerHeight - 60 && r.right > window.innerWidth - 60 }); if (!bs.length) return false; bs[0].click(); return true })()`,
    close: `(() => { const bs = [...document.querySelectorAll('button')].filter(b => { const r = b.getBoundingClientRect(); return r.width > 50 && r.width < 80 && r.bottom > window.innerHeight - 60 && r.right > window.innerWidth - 60 }); bs.length && bs[0].click() })()`,
  },
  {
    name: '轻提示 Toast', hash: '/settings',
    open: `(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('刷新')); if (!b) return false; b.click(); return true })()`,
    close: `(() => {})()`,
  },
];

/* ---------------------------------------------------------------- 登录（HTTP） */
async function loginToken () {
  const post = (u, b, cookie) => fetch(BASE + u, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, cookie ? { Cookie: 'pms_session=' + cookie } : {}),
    body: JSON.stringify(b),
  });
  const grab = r => (/pms_session=([^;]+)/.exec(r.headers.get('set-cookie') || '') || [])[1];
  // 先按「已改过密」的密码试一次；不行再试初始密码 admin123
  const tryPasses = [WANT_PASS, PASS].filter((v, i, a) => v && a.indexOf(v) === i);
  let cookie = null;
  for (const pw of tryPasses) {
    const r = await post('/api/login', { username: USER, password: pw });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) continue;
    cookie = grab(r);
    if (!d.user || !d.user.must_change_pw) return cookie;   // 直接能进业务页
    // 首登强制改密：带会话改成已知密码，再登一次
    const r2 = await post('/api/me/password', { old: pw, new: WANT_PASS }, cookie);
    if (!r2.ok) continue;
    const r3 = await post('/api/login', { username: USER, password: WANT_PASS });
    if (!r3.ok) continue;
    cookie = grab(r3);
    return cookie;
  }
  if (!cookie) throw new Error('登录失败：账号密码都不对（' + USER + '）');
  return cookie;
}

/* ---------------------------------------------------------------- 主流程 */
(async () => {
  const token = await loginToken();
  console.log(`  目标实例：${BASE}   账号：${USER}`);
  if (SHOT) fs.mkdirSync(OUT, { recursive: true });

  const prof = path.join(os.tmpdir(), 'pms_theme_audit_prof');
  fs.rmSync(prof, { recursive: true, force: true });
  const c = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, 'about:blank'], { stdio: 'ignore' });

  let tg = null;
  for (let i = 0; i < 80; i++) {
    try { tg = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (tg.some(t => t.type === 'page')) break; }
    catch { /* 等浏览器起来 */ }
    await sleep(250);
  }
  if (!tg || !tg.some(t => t.type === 'page')) { c.kill(); throw new Error('Edge 没起来（检查 msedge.exe 路径 / 调试端口）'); }
  const page = tg.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pend = new Map(); let seq = 0;
  ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, q = {}) => new Promise(r => { const id = ++seq; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: q })); });
  const ev = async x => (await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })).result?.result?.value;
  const wait = async (x, ms) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(x)) return true; } catch { /* 重试 */ } await sleep(200); } return false; };
  const shot = async file => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return fs.statSync(file).size;
  };

  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: BASE + '/' });
  await wait('!!document.body', 15000);
  await send('Network.setCookie', { name: 'pms_session', value: token, domain: new URL(BASE).hostname, path: '/' });

  if (PALETTE) {
    const snaps = {};
    for (const theme of THEMES) {
      await ev(`localStorage.setItem('pms.theme', ${JSON.stringify(theme)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
      await sleep(300);
      snaps[theme] = await ev(PALETTE_FN);
    }
    const keys = [...new Set(Object.values(snaps).flatMap(o => Object.keys(o || {})))].sort();
    console.log('\n  ' + '变量'.padEnd(22) + THEMES.map(t => t.padEnd(10)).join(''));
    for (const k of keys) console.log('  ' + k.padEnd(22) + THEMES.map(t => String((snaps[t] || {})[k] || '—').padEnd(10)).join(''));
    c.kill();
    console.log('');
    process.exit(0);
  }

  const all = [];
  for (const theme of THEMES) {
    await ev(`localStorage.setItem('pms.theme', ${JSON.stringify(theme)}); document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
    console.log(`\n═══ ${theme === 'dark' ? '深色' : '浅色'}主题 ═══`);
    for (const p of PAGES) {
      if (ONLY.length && !ONLY.some(k => p.name.includes(k) || p.hash.includes(k))) continue;
      await send('Page.navigate', { url: BASE + '/#' + p.hash });
      await sleep(400);
      await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
      await wait('!!document.querySelector("main")', 12000);
      await sleep(1600);   // 等图表/骨架屏收敛
      const r = await ev(AUDIT_FN);
      const effTheme = await ev(`document.documentElement.getAttribute('data-theme')`);
      if (LAYOUT) {
        const L = await ev(LAYOUT_FN);
        console.log(`\n  ── 版面：${p.name}（视口高 ${L.viewportH}，文档高 ${L.docH}）──`);
        for (const cd of L.cards) {
          const flag = cd.empty > 40 ? '  ⚠ 底部空 ' + cd.empty + 'px' : '';
          console.log(`     卡片 ${String(cd.title).padEnd(16)} ${String(cd.w + '×' + cd.h).padEnd(10)} top=${String(cd.t).padEnd(5)} 内容底 ${cd.b - cd.empty}${flag}`);
        }
        for (const g of L.grids) {
          const used = g.kids.reduce((a, k) => a + k.span, 0);
          console.log(`     栅格 ${g.cls.slice(0, 54)}`);
          console.log(`       ${g.kids.map(k => `[col${k.col} 跨${k.span} 高${k.h}]`).join(' ')}  合计跨 ${used}/12`);
        }
        console.log('');
      }
      if (SHOT) {
        const kb = Math.round(await shot(path.join(OUT, `${theme}-${p.name}.png`)) / 1024);
        process.stdout.write(`  ${p.name.padEnd(14)} 可疑 ${String(r.total).padStart(4)} 处（去重 ${r.uniq}）  ${kb} KB  [data-theme=${effTheme}]\n`);
      } else {
        process.stdout.write(`  ${p.name.padEnd(14)} 可疑 ${String(r.total).padStart(4)} 处（去重 ${r.uniq}）  [data-theme=${effTheme}]\n`);
      }
      for (const row of r.rows) all.push({ theme, page: p.name, ...row });
    }

    // 浮层（弹窗 / 下拉 / 面板）单独扫一遍
    if (!ONLY.length || ONLY.some(k => 'overlays'.includes(k) || '浮层'.includes(k))) {
      for (const ov of OVERLAYS) {
        await send('Page.navigate', { url: BASE + '/#' + ov.hash });
        await sleep(500);
        await ev(`document.documentElement.setAttribute('data-theme', ${JSON.stringify(theme)})`);
        await wait('!!document.querySelector("main")', 10000);
        await sleep(1200);
        const opened = await ev(ov.open);
        await sleep(700);
        if (!opened) { process.stdout.write(`  ${('浮层·' + ov.name).padEnd(20)} 打不开，跳过\n`); continue; }
        const r = await ev(AUDIT_FN);
        process.stdout.write(`  ${('浮层·' + ov.name).padEnd(20)} 可疑 ${String(r.total).padStart(4)} 处（去重 ${r.uniq}）\n`);
        for (const row of r.rows) all.push({ theme, page: '浮层·' + ov.name, ...row });
        await ev(ov.close);
        await sleep(300);
      }
    }
  }

  c.kill();

  // 按「元素签名」聚合：同一个写死的 class 在多个页面出现，只报一次
  const bySig = new Map();
  for (const r of all) {
    const k = r.theme + '|' + r.reasons.join(',') + '|' + r.sig.replace(/\.(text|bg|border)[\w./-]*$/, '');
    const e = bySig.get(k) || { ...r, count: 0, pages: new Set() };
    e.count++; e.pages.add(r.page); bySig.set(k, e);
  }
  const list = [...bySig.values()].sort((a, b) => b.count - a.count);

  console.log('\n──────────────── 聚合结果（同一处写死的颜色只列一次）────────────────');
  if (!list.length) console.log('  ✅ 没有发现亮/暗残留');
  for (const e of list) {
    console.log(`\n  ${e.count} 处 · ${e.reasons.join('+')} · 实际亮度 ${e.bgLum}${e.fgLum !== null ? ' / 文字 ' + e.fgLum : ''}`);
    console.log(`    ${e.sig.slice(0, 110)}`);
    console.log(`    自身背景 ${e.own} → 合成 ${e.eff}   ${e.w}×${e.h}   ${e.text ? '「' + e.text + '」' : ''}`);
    console.log(`    出现页：${[...e.pages].slice(0, 6).join('、')}${e.pages.size > 6 ? ' …' : ''}`);
  }

  const bad = list.filter(e => e.theme === 'dark');
  console.log('\n──────────────── 小结 ────────────────');
  console.log(`  深色主题可疑点：${all.filter(r => r.theme === 'dark').length} 处（去重 ${bad.length} 类）`);
  const lightBad = list.filter(e => e.theme === 'light');
  if (THEMES.includes('light')) console.log(`  浅色主题可疑点：${all.filter(r => r.theme === 'light').length} 处（去重 ${lightBad.length} 类）`);
  if (SHOT) console.log(`  截图目录：${OUT}`);
  process.exit(bad.length ? 1 : 0);
})().catch(e => { console.error('[审计失败]', e.message); process.exit(2); });
