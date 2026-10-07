'use strict';
/** React 重写后的前端验证：登??总览 ?各页面，并检查设计规格是否落?*/
const { spawn } = require('node:child_process');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const T = require('./test-auth.js');
const BASE = process.argv[2] || process.env.PMS_BASE || T.BASE;   // 可传参指向临时测试服'
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PORT = 9530;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const results = [];
const check = (name, ok, extra = '') => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? '  — ' + extra : ''}`);
};

(async () => {
  T.forceAdminPassword();
  const prof = path.join(os.tmpdir(), 'pms_react');
  fs.rmSync(prof, { recursive: true, force: true });
  const c = spawn(EDGE, ['--headless=new', '--disable-gpu', '--no-first-run',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, '--window-size=1680,1050', 'about:blank'], { stdio: 'ignore' });
  let tg = null;
  for (let i = 0; i < 60; i++) {
    try { tg = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); if (tg.some(t => t.type === 'page')) break; } catch { /* ?*/ }
    await sleep(250);
  }
  const page = tg.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  const pend = new Map(); let s = 0;
  const errs = [];
  ws.addEventListener('message', e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text || 'exception');
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errs.push((m.params.args || []).map(a => a.value || a.description || '').join(' ').slice(0, 160));
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (m, q = {}) => new Promise(r => { const id = ++s; pend.set(id, r); ws.send(JSON.stringify({ id, method: m, params: q })); });
  const ev = async x => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  const wait = async (x, ms, what) => {
    const t = Date.now();
    while (Date.now() - t < ms) { try { if (await ev(x)) return true } catch { /* 重试 */ } await sleep(200) }
    throw new Error('等待超时：' + (what || x));
  };
  const goto = async (hash, sel, what) => {
    const h = hash.startsWith('#') ? hash : '#' + hash
    await send('Page.navigate', { url: BASE + '/' + h });
    await sleep(500);
    await send('Page.navigate', { url: BASE + '/' + h });
    if (sel) await wait(sel.startsWith('!!') || sel.startsWith('document') ? sel : `!!document.querySelector('` + sel + `')`, 15000, what);
    await sleep(700);
  };

  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1050, deviceScaleFactor: 1, mobile: false });

  // ---------- 登录?----------
  console.log('[1] 登录页');
  await send('Page.navigate', { url: BASE + '/' });
  await wait(`!!document.querySelector('input[autocomplete="username"]')`, 15000, '登录页');
  const L = await ev(`(() => {
    const root = document.getElementById('root');
    const card = root.querySelector('.rounded-card');
    const grad = root.querySelector('.grad-brand');
    return {
      mounted: root.children.length > 0,
      hasCard: !!card,
      cardRadius: card ? getComputedStyle(card).borderRadius : '',
      brandBg: grad ? getComputedStyle(grad).backgroundImage.slice(0, 42) : '',
      inputs: root.querySelectorAll('input').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  check('React 应用挂载', L.mounted, 'root 有内容');
  check('登录卡片大圆角（20px）', L.cardRadius === '20px', L.cardRadius);
  check('品牌蓝紫渐变生效', /linear-gradient/.test(L.brandBg), L.brandBg);
  check('登录页无横向溢出', L.overflow <= 2, L.overflow + 'px');

  // ---------- 登录 ----------
  console.log('[2] 登录');
  await ev(`(() => {
    const inputs = document.querySelectorAll('input');
    const set = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(inputs[0], ${JSON.stringify(T.USER)}); set(inputs[1], ${JSON.stringify(T.PASS)});
  })()`);
  await ev(`document.querySelector('button[type="submit"]').click()`);
  await wait(`!!document.querySelector('aside')`, 20000, '进入主界');
  await sleep(1200);
  check('登录成功并进入主界面', true);

  // ---------- 主框?----------
  console.log('[3] 布局骨架');
  const A = await ev(`(() => {
    const aside = document.querySelector('aside');
    const header = document.querySelector('header');
    const tiles = document.querySelectorAll('.icon-tile');
    const logo = aside.querySelector('.grad-brand');
    const bottom = aside.querySelector('[style*="rgba(255, 255, 255, 0.08)"]') || aside.lastElementChild;
    const ring = aside.querySelector('svg circle:nth-child(2)');
    return {
      sideW: Math.round(aside.getBoundingClientRect().width),
      sideBg: getComputedStyle(aside).backgroundImage.slice(0, 60),
      topH: Math.round(header.getBoundingClientRect().height),
      topBg: getComputedStyle(header).backgroundColor,
      topBlur: getComputedStyle(header).backdropFilter || getComputedStyle(header).webkitBackdropFilter,
      navItems: aside.querySelectorAll('nav a').length,
      navItemH: aside.querySelector('nav a') ? Math.round(aside.querySelector('nav a').getBoundingClientRect().height) : 0,
      activeBar: (() => {
        const a = aside.querySelector('nav a.active');
        if (!a) return 'none';
        const w = getComputedStyle(a, '::before').width;      // 有伪元素时才是 3px 那种值
        return (w === 'auto' || w === '0px') ? 'none' : w;     // 没有伪元素 = 'auto'/'0px'
      })(),
      hasLogo: !!logo,
      hasRing: !!ring,
      tiles: tiles.length,
      searchW: Math.round((header.querySelector('input') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
      aiBubble: [...document.querySelectorAll('button')].some(b => (b.title || '').includes('智能项目分析助手')) || [...document.querySelectorAll('button')].some(b => b.textContent.includes('智能项目分析助手')),
      sideBgLight: getComputedStyle(aside).backgroundColor,
    };
  })()`);
  /* ---- 2.0 规格：白侧栏 220px / 菜单 40px / 无指示条；AI 是右下小圆球 ---- */
  check('侧边栏宽 220px', A.sideW === 220, A.sideW + 'px');
  check('侧边栏纯白背景', A.sideBg === 'none' && A.sideBgLight !== undefined ? true : A.sideBg === 'none', A.sideBg.slice(0, 30));
  check('顶栏高 64px', A.topH === 64, A.topH + 'px');
  check('顶栏毛玻璃生', /blur/.test(A.topBlur || ''), A.topBlur);
  check('侧栏菜单项高 40px', A.navItemH === 40, A.navItemH + 'px');
  check('选中项无发光指示条（2.0 改浅蓝底蓝字）', A.activeBar === 'none', String(A.activeBar));
  check('右下角 AI 小圆球（title=智能项目分析助手）', A.aiBubble);

  // ---------- 总览 ----------
  console.log('[4] 首页概览');
  await goto('/dashboard', `document.querySelectorAll('a[data-grad]').length === 4`, '总览渲染');
  await sleep(1800);
  const D = await ev(`(() => {
    const h1 = document.querySelector('h1');
    const cards = document.querySelectorAll('.card, .card-glass');
    const entries = [...document.querySelectorAll('a[data-grad]')];
    const donut = document.querySelectorAll('svg circle[stroke]:not([stroke="var(--tile-bg)"])');
    const main = document.querySelector('main');
    const asides = [...document.querySelectorAll('aside')];
    return {
      title: h1 ? h1.textContent.trim() : '',
      titleSize: h1 ? getComputedStyle(h1).fontSize : '',
      titleWeight: h1 ? getComputedStyle(h1).fontWeight : '',
      cards: cards.length,
      entryCount: entries.length,
      entryH: entries[0] ? Math.round(entries[0].getBoundingClientRect().height) : 0,
      entryGrad: entries[0] ? getComputedStyle(entries[0].querySelector('div')).backgroundImage.slice(0, 30) : '',
      bigNumbers: document.querySelectorAll('.num-in').length,
      donutArcs: donut.length,
      hasStats: document.body.innerText.includes('数据统计'),
      hasTodo: document.body.innerText.includes('待办总览'),
      hasExec: document.body.innerText.includes('项目执行概览'),
      asideW: asides.length > 1 ? Math.round(asides[1].getBoundingClientRect().width) : 0,
      hasQuick: document.body.innerText.includes('常用功能'),
      hasRank: document.body.innerText.includes('回款率排行'),
      hasNotice: document.body.innerText.includes('通知公告') || document.body.innerText.includes('公司公告'),
      hasTheme: document.documentElement.getAttribute('data-theme') === 'light' || document.documentElement.getAttribute('data-theme') === 'dark',
      pills: document.querySelectorAll('.pill, [class*="rounded-full"]').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mainScroll: main ? main.scrollHeight - main.clientHeight : 0,
      bodyBg: (getComputedStyle(document.body, '::before').backgroundImage || '').slice(0, 60),
    };
  })()`);
  check('欢迎标题渲染', /好/.test(D.title), D.title);
  check('欢迎标题 28px 粗体', D.titleSize === '28px' && Number(D.titleWeight) >= 700, `${D.titleSize}/${D.titleWeight}`);
  check('页面底色渐变', /gradient/.test(D.bodyBg));
  check('四张渐变入口卡已渲染', D.entryCount === 4, D.entryCount + ' 张');
  check('入口卡高 100px', D.entryH === 100, D.entryH + 'px');
  check('入口卡是渐变背景', /gradient/.test(D.entryGrad), D.entryGrad);
  check('数据统计卡（大数字 + 滚动动画）', D.hasStats && D.bigNumbers >= 4, D.bigNumbers + ' 个大数字');
  check('待办总览环形图有分段', D.hasTodo && D.donutArcs >= 1, D.donutArcs + ' 段');
  check('项目执行概览在', D.hasExec);
  check('右侧辅助栏 320px', D.asideW === 320, D.asideW + 'px');
  check('常用功能宫格在', D.hasQuick);
  check('回款率排行在', D.hasRank);
  check('通知公告在', D.hasNotice);
  check('主题已挂到 html[data-theme]', D.hasTheme);
  check('总览无横向溢出', D.overflow <= 2, D.overflow + 'px');

  // ---------- 各业务页?----------
  console.log('[5] 业务页面');
  const pages = [
    ['#/t/projects', '项目管理', 'table.tbl'],
    ['#/t/contracts', '合同管理', 'table.tbl'],
    ['#/t/payments', '收付', 'table.tbl'],
    ['#/t/invoices', '发票管理', 'table.tbl'],
    ['#/t/expenses', '项目费用', 'table.tbl'],
    ['#/reports', '报表统计', 'svg.recharts-surface'],
    ['#/users', '成员管理', '.icon-tile'],
    ['#/logs', '操作日志', 'table.tbl'],
    ['#/trash', '回收', 'h1'],
    ['#/settings', '系统设置', 'h1'],
    ['#/attachments', '附件中心', 'h1'],
    ['#/import', '数据导入', 'h1'],
  ];
  for (const [hash, name, sel] of pages) {
    try {
      await goto(hash, sel, name);
      const info = await ev(`(() => ({
        h1: (document.querySelector('h1') || {}).textContent || '',
        rows: document.querySelectorAll('table.tbl tbody tr').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        err: !!document.querySelector('[class*="bg-red-50"]'),
      }))()`);
      const okPage = info.h1.length > 0 && info.overflow <= 2;
      check(`${name} 页面正常`, okPage, `标题「${info.h1.trim().slice(0, 14)}」${info.rows ? ` · ${info.rows} 行` : ''}`);
    } catch (e) {
      check(`${name} 页面正常`, false, e.message.slice(0, 60));
    }
  }

  // ---------- 项目详情 ----------
  console.log('[5.1] 设置页的智能助手与推送卡');
  try {
    await goto('/settings', 'h1', '系统设置');
    await sleep(1600);
    const st = await ev(`(() => {
      const t = document.body.innerText;
      return {
        ai: t.includes('智能助手'),
        tool: t.includes('允许模型自己查明'),
        ctx: t.includes('自动附带经营数据'),
        push: t.includes('简报推'),
        pushTime: t.includes('推送时'),
        addCh: [...document.querySelectorAll('button')].some(b => b.textContent.includes('添加推送渠')),
        testPush: [...document.querySelectorAll('button')].some(b => b.textContent.includes('立即试推一')),
        warn: t.includes('推送内容包含完整经营数'),
        apiKey: !!document.querySelector('input[type="password"]'),
      };
    })()`);
    check('设置页有「智能助手」卡', st.ai);
    check('有「自动附带经营数据」开', st.ctx);
    check('有「允许模型自己查明细」开', st.tool);
    check('有「简报推送」卡', st.push);
    check('有推送时间设', st.pushTime);
    check('有「添加推送渠道」按', st.addCh);
    check('有「立即试推一次」按', st.testPush);
    check('有「推送含完整经营数据」的风险提示', st.warn);
    check('API 密钥输入框是密码类型', st.apiKey);
  } catch (e) {
    check('设置页的智能助手与推送卡', false, e.message.slice(0, 60));
  }

  // ---------- 项目详情 ----------
  console.log('[6] 项目详情');
  try {
    const pid = await ev(`fetch('/api/list/projects?limit=1').then(r=>r.json()).then(d=>d.rows[0] && d.rows[0].id)`);
    await goto(`#/p/${pid}`, 'h1', '项目详情');
    await sleep(900);
    const P = await ev(`(() => ({
      h1: (document.querySelector('h1') || {}).textContent || '',
      tabs: document.querySelectorAll('.rounded-full, button').length,
      charts: document.querySelectorAll('svg.recharts-surface').length,
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))()`);
    check('项目详情页正常', P.h1.length > 1 && P.overflow <= 2, `${P.h1.trim().slice(0, 18)}`);
  } catch (e) { check('项目详情页正', false, e.message.slice(0, 60)) }

  // ---------- 控制台错?----------
  console.log('[7] 运行时错');
  const realErrs = errs.filter(e => !/favicon|404|ResizeObserver/i.test(e));
  check('无 JS 运行时错误', realErrs.length === 0, realErrs.slice(0, 2).join(' | ') || '0 条');

  // ══════════ 8. 功能流程：新??详情 ?清理 ══════════
  console.log('[8] 功能流程');
  const clickByText = (text) => `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim().includes(${JSON.stringify(text)}));
    if (!b) return false; b.click(); return true;
  })()`;
  const testName = 'UI-RT-' + Date.now().toString(36);

  try {
    await goto('/t/projects', 'table.tbl', '项目列表');
    check('点「新建项目」打开表单', await ev(clickByText('新建项目')));
    await sleep(700);

    const hasForm = await ev(`[...document.querySelectorAll('h3')].some(h => h.textContent.includes('新增'))`);
    check('表单弹窗已打开', hasForm);

    // 项目表单里必须能直接填合同金额（虚拟?+ quick 标记，不能表单不渲染'
    const moneyField = await ev(`(() => {
      const modal = [...document.body.children].find(el => el.id !== 'root' && el.querySelector && el.querySelector('h3'));
      if (!modal) return { ok: false };
      const labels = [...modal.querySelectorAll('label')].map(l => l.textContent || '');
      const hit = labels.find(t => t.includes('收入合同'));
      return {
        ok: !!hit,
      hint: /自动帮你/.test(modal.innerText || ''),
        input: !!hit && !!modal.querySelector('label:has(input)'),
        status: modal.innerText.includes('项目状'),
      };
    })()`);
    check('项目表单里有「收入合同额」可填', moneyField.ok, moneyField.ok ? '已渲染' : '✗ 虚拟列被过滤掉了');
    check('该字段有说明文字（填了会自动建主合同）', moneyField.hint);
    check('金额输入框真的在弹窗', moneyField.input);
    check('其他字段没受影响（项目状态仍在）', moneyField.status);

    // 弹窗是通过 portal 挂到 body 上的，必须限定在弹窗内部找输入框'
    // 否则会选到工具栏的搜索框（它在 DOM 里排在前面）?
    await ev(`(() => {
      const modal = [...document.body.children].find(el => el.id !== 'root' && el.querySelector && el.querySelector('h3'));
      if (!modal) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      const inputs = [...modal.querySelectorAll('input')].filter(i => i.type === 'text' || !i.type);
      if (inputs[0]) { setter.call(inputs[0], 'RT-' + Date.now().toString(36)); inputs[0].dispatchEvent(new Event('input',{bubbles:true})); }
      if (inputs[1]) { setter.call(inputs[1], ${JSON.stringify(testName)}); inputs[1].dispatchEvent(new Event('input',{bubbles:true})); }
      return inputs.length;
    })()`);
    await sleep(200);
    await ev(`(() => {
      const modal = [...document.body.children].find(el => el.id !== 'root' && el.querySelector && el.querySelector('h3'));
      const btn = [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === '保存');
      if (btn) btn.click();
      return !!btn;
    })()`);
    await sleep(1600);

    // 如果弹窗还在，说明保存被拦下来了，把错误提示读出'
    const afterSave = await ev(`(() => {
      const modal = [...document.body.children].find(el => el.id !== 'root' && el.querySelector && el.querySelector('h3'));
      const err = modal ? (modal.querySelector('[class*="bg-red-50"]') || {}).textContent : '';
      return { stillOpen: !!modal, err: err || '' };
    })()`);
    const found = await ev(`document.body.innerText.includes(${JSON.stringify(testName)})`);
    check('新增的项目出现在列表', found, found ? testName : (afterSave.err || (afterSave.stillOpen ? '表单仍开着' : '未找')));

    if (found) {
      const pid = await ev(`fetch('/api/list/projects?q=' + encodeURIComponent(${JSON.stringify(testName)})).then(r=>r.json()).then(d=>d.rows[0] && d.rows[0].id)`);
      check('新增记录已落', !!pid, 'id=' + pid);
      if (pid) {
        await goto(`/p/${pid}`, 'h1', '项目详情');
        await sleep(700);
        const detail = await ev(`(() => ({
          title: (document.querySelector('h1')||{}).textContent || '',
          tabs: [...document.querySelectorAll('button')].filter(b => /合同|收付款|发票|费用|材料|售后|附件/.test(b.textContent)).length,
        }))()`);
        check('项目详情页打开且有页签', detail.title.includes(testName) && detail.tabs >= 6, `${detail.tabs} 个页签`);
      }
    }

    // 清理
    const cleaned = await ev(`(async () => {
      const r = await fetch('/api/list/projects?q=' + encodeURIComponent(${JSON.stringify(testName)})).then(x=>x.json());
      let n = 0;
      for (const row of r.rows) {
        await fetch('/api/delete/projects/' + row.id, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ cascade:true }) });
        n++;
      }
      const left = await fetch('/api/list/projects?q=' + encodeURIComponent(${JSON.stringify(testName)})).then(x=>x.json());
      return { removed: n, left: left.total };
    })()`);
    check('测试数据已清', cleaned.left === 0, `删除 ${cleaned.removed} 条，剩余 ${cleaned.left} 条`);
  } catch (e) {
    check('功能流程', false, e.message.slice(0, 70));
  }

  // ══════════ 9. 录入与维护能力（此前缺失、本轮补回） ══════════
  console.log('[9] 录入与维护能');
  const findModal = `[...document.body.children].find(el => el.id !== 'root' && el.querySelector && el.querySelector('h3'))`;

  // ---- 9.1 表单必填校验 ----
  try {
    await goto('/t/projects', 'table.tbl', '项目列表');
    await ev(clickByText('新建项目'));
    await sleep(800);
    await ev(`(() => { const m = ${findModal}; const b = [...m.querySelectorAll('button')].find(x => x.textContent.trim() === '保存'); b.click(); })()`);
    await sleep(800);
    const v = await ev(`(() => {
      const m = ${findModal};
      const red = m ? m.querySelector('[class*="bg-red-50"]') : null;
      return { open: !!m, err: red ? red.textContent.trim() : '' };
    })()`);
    check('必填项为空时拦截保存', v.open && /不能为空/.test(v.err), v.err || '没有报错');
    await ev(`(() => { const m = ${findModal}; const b = [...m.querySelectorAll('button')].find(x => x.textContent.trim() === '取消'); b && b.click(); })()`);
    await sleep(600);
  } catch (e) { check('必填项为空时拦截保存', false, e.message.slice(0, 60)) }

  // ---- 9.2 表单内附件区 + 就地新建关联记录 ----
  try {
    await ev(clickByText('新建项目'));
    await sleep(800);
    const f = await ev(`(() => {
      const m = ${findModal};
      if (!m) return { ok: false };
      const text = m.innerText;
      return {
        ok: true,
        attachArea: text.includes('扫描'),
        uploadBtn: [...m.querySelectorAll('button')].some(b => b.textContent.includes('上传附件')),
        quickBtns: [...m.querySelectorAll('button[title]')].filter(b => (b.getAttribute('title') || '').includes('就地新建')).length,
      };
    })()`);
    check('表单内可上传附件', f.attachArea && f.uploadBtn, f.attachArea ? '' : '没找到附件区');
    check('关联字段可就地新建', f.quickBtns >= 1, f.quickBtns + ' 个「+」按钮');

    if (f.quickBtns >= 1) {
      await ev(`(() => { const m = ${findModal}; [...m.querySelectorAll('button[title]')].find(b => (b.getAttribute('title')||'').includes('就地新建')).click(); })()`);
      await sleep(800);
      const q = await ev(`[...document.body.querySelectorAll('h3')].map(h => h.textContent.trim()).filter(t => /^新建/.test(t))`);
      check('弹出新建关联记录的子表单', q.length >= 1, q.join(' / ') || '无');
      // 关掉两层弹窗
      for (let i = 0; i < 3; i++) {
        await ev(`(() => { const bs = [...document.body.querySelectorAll('button')].filter(b => b.textContent.trim() === '取消'); if (bs.length) bs[bs.length - 1].click(); })()`);
        await sleep(400);
      }
    }
  } catch (e) { check('表单内可上传附件', false, e.message.slice(0, 60)) }

  // ---- 9.3 合同：按付款条款生成收付款计?----
  try {
    await goto('/t/contracts', 'table.tbl', '合同列表');
    const hasBtn = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('生成计划'))`);
    check('合同行有「生成计划」按', hasBtn);

    const prev = await ev(`(async () => {
      const r = await fetch('/api/list/contracts?limit=200').then(x => x.json());
      const c = r.rows.find(x => (x.payment_terms || '').trim()) || r.rows[0];
      const p = await fetch('/api/contract/' + c.id + '/plan', {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ preview: true })
      }).then(x => x.json());
      return { name: c.name, nodes: (p.nodes || []).length, existing: p.existing, sum: p.sum };
    })()`);
    check('生成计划能预览出节点', prev.nodes >= 2, `${prev.nodes} 个节点 · 合同「${String(prev.name).slice(0, 12)}」`);
    check('预览会带上已有节点数', typeof prev.existing === 'number', `已有 ${prev.existing} 个`);
  } catch (e) { check('合同行有「生成计划」按钮', false, e.message.slice(0, 60)) }

  // ---- 9.4 对账?----
  try {
    const pid = await ev(`fetch('/api/list/projects?limit=1').then(r=>r.json()).then(d=>d.rows[0].id)`);
    await goto(`/statement/${pid}`, 'h1', '对账');
    await sleep(1000);
    const st = await ev(`(() => ({
      isStatement: document.body.innerText.includes('项目对账'),
      tables: document.querySelectorAll('table.tbl').length,
      hasPrint: [...document.querySelectorAll('button')].some(b => b.textContent.includes('打印')),
    }))()`);
    check('对账单页渲染', st.isStatement && st.tables >= 3, `${st.tables} 张明细表`);
    check('对账单可打印', st.hasPrint);
  } catch (e) { check('对账单页渲染', false, e.message.slice(0, 60)) }

  // ---- 9.5 搜索 ----
  try {
    await goto('/t/partners', 'table.tbl', '往来单');
    await sleep(500);
    const before = await ev(`document.querySelectorAll('table.tbl tbody tr').length`);
    const setSearch = (txt) => `(() => {
      const i = [...document.querySelectorAll('main input')].find(x => (x.placeholder || '').includes('搜索'));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(i, ${JSON.stringify(txt)}); i.dispatchEvent(new Event('input',{bubbles:true}));
    })()`;
    await ev(setSearch('不存在的单位XYZ'));
    await sleep(1000);
    const after = await ev(`document.querySelectorAll('table.tbl tbody tr').length`);
    check('搜索能过滤列表', before > 0 && after === 0, `${before} → ${after} 行`);
    await ev(setSearch(''));
    await sleep(900);
    const restored = await ev(`document.querySelectorAll('table.tbl tbody tr').length`);
    check('清空搜索后恢复列', restored === before, `${restored} 行`);
  } catch (e) { check('搜索能过滤列', false, e.message.slice(0, 60)) }

  // ---- 9.6 批量删除 ----
    // 先清掉上次跑挂在半路留下的 UIBATCH- 材料，
    // 否则这次搜出来的行数会被历史残留撑大，断言变成"看运气"
    try {
      const tkClean = await T.login();
      const left = await fetch(BASE + '/api/list/materials?q=UIBATCH-&limit=200',
        { headers: { Cookie: 'pms_session=' + tkClean } }).then(r => r.json());
      for (const row of (left.rows || [])) {
        await fetch(BASE + '/api/delete/materials/' + row.id,
          { method: 'POST', headers: { Cookie: 'pms_session=' + tkClean, 'Content-Type': 'application/json' }, body: '{}' });
      }
      if ((left.rows || []).length) console.log('      （清了 ' + left.rows.length + ' 条历史残留）');
    } catch { /* 清理失败不影响主流程 */ }
  try {
    const made = await ev(`(async () => {
      const ids = [];
      for (let i = 0; i < 2; i++) {
        const r = await fetch('/api/save/materials', { method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ project_id: 125, category: '设备', name: 'UIBATCH-' + Date.now().toString(36) + '-' + i, unit: '个', quantity: 1, unit_price: 10 }) }).then(x => x.json());
        if (r.id) ids.push(r.id);
      }
      return ids;
    })()`);
    check('准备两条测试数据', made.length === 2, 'ids=' + made.join(','));

    await goto('/t/materials', 'table.tbl', '材料设备');
    await ev(`(() => {
      const i = [...document.querySelectorAll('main input')].find(x => (x.placeholder || '').includes('搜索'));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(i, 'UIBATCH-'); i.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(1100);
    const rowsFound = await ev(`document.querySelectorAll('table.tbl tbody tr').length`);
    check('搜索到测试数据', rowsFound >= 2, rowsFound + ' 行');

    await ev(`(() => { const cb = document.querySelector('table.tbl thead input[type=checkbox]'); cb && cb.click(); })()`);
    await sleep(500);
    check('勾选后出现批量操作', await ev(`document.body.innerText.includes('已')`));

    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('批量删除')); b && b.click(); })()`);
    await sleep(800);
    check('批量删除先弹确认', await ev(`document.body.innerText.includes('删除选中')`));

    await ev(`(() => {
      const m = ${findModal};
      if (!m) return false;
      const b = [...m.querySelectorAll('button')].find(x => /删除/.test(x.textContent));
      b && b.click(); return !!b;
    })()`);
    await sleep(1400);
    const left = await ev(`fetch('/api/list/materials?q=UIBATCH-').then(r=>r.json()).then(d=>d.total)`);
    check('批量删除生效', left === 0, '剩余 ' + left + ' 条');
  } catch (e) { check('批量删除生效', false, e.message.slice(0, 60)) }

  // ══════════ 10. 扫描件识??填入表单（界面链路） ══════════
  console.log('[10] 扫描件识别与填入');
  let ocrAttId = null;
  try {
    // 先用接口上传一张合同扫描件（界面上传等价），等识别完成
    const token = await T.login();
    const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'contract.pdf'));
    const fd = new FormData();
    fd.append('file', new Blob([buf], { type: 'application/pdf' }), 'UIOCTEST-合同扫描件.pdf');
    const up = await fetch(BASE + '/api/upload', {
      method: 'POST', headers: { Cookie: 'pms_session=' + token }, body: fd,
    }).then(r => r.json());
    ocrAttId = up.attachment?.id || null;
    check('上传扫描件成', !!ocrAttId, 'id=' + ocrAttId);

    let ready = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
    const list = await fetch(BASE + '/api/attachments?q=UIOCTEST-', {
        headers: { Cookie: 'pms_session=' + token },
      }).then(r => r.json());
      const a = (list.rows || [])[0];
      if (a && a.ocr_status === 'done') { ready = true; break }
    }
    check('识别已完', ready);

    // 界面上应该出现「识别结果」按'
    await goto('/attachments', 'h1', '附件中心');
    await ev(`(() => {
      const i = [...document.querySelectorAll('main input')].find(x => (x.placeholder || '').includes('搜索'));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(i, 'UIOCTEST-'); i.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await sleep(1400);
    const hasBtn = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('识别结果'))`);
    check('附件卡片出现「识别结果」按', hasBtn);

    if (hasBtn) {
      await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('识别结果')); b.click(); })()`);
      await sleep(900);
      const panel = await ev(`(() => {
        const m = ${findModal};
        if (!m) return { open: false };
        const txt = m.innerText;
        return {
          open: true,
          hasFields: txt.includes('合同编号') || txt.includes('合同金额') || txt.includes('名称'),
          hasParties: txt.includes('关联线索') || txt.includes('甲方'),
      fillBtn: [...m.querySelectorAll('button')].some(b => /新建(合同|发票)并填入/.test(b.textContent)),
          rows: m.querySelectorAll('table tbody tr').length,
        };
      })()`);
      check('识别结果面板打开', panel.open);
      check('面板列出识别出的字段', panel.hasFields, panel.rows + ' 个');
      check('面板显示甲乙方匹配情况', panel.hasParties);
      check('面板有「新建合同并填入」按钮', panel.fillBtn);

      if (panel.fillBtn) {
        await ev(`(() => {
          const m = ${findModal};
    const b = [...m.querySelectorAll('button')].find(x => /新建(合同|发票)并填入/.test(x.textContent));
          b.click();
        })()`);
        await sleep(1000);
        // 预填校验：表单里应该已经带上识别到的编号与金'
        const pre = await ev(`(() => {
          const m = ${findModal};
          if (!m) return { open: false };
          const inputs = [...m.querySelectorAll('input')];
          const vals = inputs.map(i => i.value).filter(Boolean);
          return {
            open: true,
            title: (m.querySelector('h3') || {}).textContent || '',
            hasCode: vals.some(v => String(v).includes('HT-2026-088')),
            hasAmount: vals.some(v => String(v).includes('5860000') || String(v).includes('5,860,000')),
            filled: vals.length,
          };
        })()`);
        check('「新建并填入」打开了合同表', pre.open && /合同/.test(pre.title), pre.title);
        check('合同编号已预', pre.hasCode);
        check('合同金额已预', pre.hasAmount, pre.filled + ' 个字段有');
        // 关掉表单
        await ev(`(() => { const bs = [...document.body.querySelectorAll('button')].filter(b => b.textContent.trim() === '取消'); if (bs.length) bs[bs.length-1].click(); })()`);
        await sleep(500);
      }
    }
  } catch (e) {
    check('扫描件识别与填入', false, e.message.slice(0, 70));
  } finally {
    try {
      const token = await T.login();
      if (ocrAttId) await fetch(BASE + '/api/attachments/' + ocrAttId + '/delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'pms_session=' + token }, body: '{}',
      });
      await fetch(BASE + '/api/trash/purge-all', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'pms_session=' + token }, body: '{}',
      });
      check('识别测试数据已清', true);
    } catch { check('识别测试数据已清', false) }
  }

  // ══════════ 11. AI 助手面板（含真实流式对话?══════════
  console.log('[11] AI 助手面板');
  let mockSrv = null;
  try {
    const httpMod = require('node:http');
    const MOCK_PORT = 18898;
    const REPLY = '收入合同额 1046.0 万元，**建议本周催收**。\n\n- 第一人民医院有 146.5 万逾期 98 天\n- 云鼎广场有 6.0 万逾期 238 天';
    // 假模型服务：把回复切碎流式推出去
    mockSrv = httpMod.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c });
      req.on('end', () => {
        let p = {}; try { p = JSON.parse(body) } catch { /* 忽略 */ }
        if (!p.stream) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: '正常' } }] }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const pieces = REPLY.match(/[\s\S]{1,6}/g) || [];
        let i = 0;
        const t = setInterval(() => {
          if (i >= pieces.length) {
            clearInterval(t);
            res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }] }) + '\n\n');
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] }) + '\n\n');
        }, 8);
      });
    });
    await new Promise(r => mockSrv.listen(MOCK_PORT, '127.0.0.1', r));

    // 配好 AI（指向假模型'
    const tk = await T.login();
    const H = { Cookie: 'pms_session=' + tk, 'Content-Type': 'application/json' };
    const saveCfg = b => fetch(BASE + '/api/ai/config', { method: 'POST', headers: H, body: JSON.stringify(b) }).then(r => r.json());
    await saveCfg({ provider: 'custom', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'ui-mock', apiKey: 'sk-test-ui', enabled: true, includeContext: true });

    await goto('/dashboard', 'aside', '总览');
    await sleep(600);

    // 打开右下角小圆球（2.0 规格：标题在 title 属性上，不是文字）
    check('右下角有 AI 助手小圆球', await ev(`[...document.querySelectorAll('button')].some(b => (b.title||'').includes('智能项目分析助手'))`));
    await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('智能项目分析助手')); b && b.click(); })()`);
    await sleep(900);
    check('面板已展开', await ev(`document.body.innerText.includes('智能项目分析助手')`));
    check('头部显示已接入的模型', await ev(`document.body.innerText.includes('ui-mock')`));
    check('提示会自动带上经营数', await ev(`document.body.innerText.includes('自动带上')`));

    // 快捷提问
    const hasQuick = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('哪些项目回款有问'))`);
    check('显示快捷提问', hasQuick);
    if (hasQuick) {
      await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('哪些项目回款有问')); b.click(); })()`);
      // 等流式内容出来
      let streamed = false;
      for (let i = 0; i < 40; i++) {
        await sleep(300);
        if (await ev(`document.body.innerText.includes('146.5')`)) { streamed = true; break }
      }
      check('回复流式渲染出来', streamed);
      const md = await ev(`(() => {
        const t = document.body.innerText;
        return {
          bold: !!document.querySelector('strong'),
          list: document.querySelectorAll('li').length > 0,
          tail: t.includes('238 天'),
        };
      })()`);
      check('Markdown 粗体已渲', md.bold);
      check('Markdown 列表已渲', md.list);
      check('回复完整显示到结', md.tail);
      check('问完清空了输入框', await ev(`(() => { const ta = document.querySelector('textarea'); return !ta || ta.value === ''; })()`));
      check('显示复制按钮（悬停态）', await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('复制'))`));

      // ---- 导出 Word ----
      const hasExport = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('导出 Word'))`);
      check('回复下方有「导出 Word」按钮', hasExport);
      if (hasExport) {
        await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('导出 Word')); b.click(); })()`);
        let toasted = false;
        for (let i = 0; i < 30; i++) {
          await sleep(300);
          if (await ev(`document.body.innerText.includes('Word 报告已导')`)) { toasted = true; break }
        }
        check('导出成功并提', toasted);
      }

      // ---- 对话记忆：刷新后还在 ----
      const before = await ev(`document.body.innerText.includes('146.5')`);
      await send('Page.reload', {});
      await sleep(1200);
      await wait(`!!document.querySelector('aside')`, 20000);
      await sleep(1200);
      await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('智能项目分析助手')); b && b.click(); })()`);
      await sleep(1000);
      check('刷新后对话历史还在（本地记忆）', before && await ev(`document.body.innerText.includes('146.5')`));
    }

    // ---- 常用功能宫格的「AI助手」入口要能唤起助手（2.0 改成了右侧栏宫格）----
    {
      // 宫格只在总览页（右侧栏），先回工作台
      await ev(`(() => { const x = [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === '收起'); x && x.click(); })()`)
      await sleep(400)
      await goto('/dashboard', `!!document.querySelector('a[data-grad]')`, '回到总览')
      await sleep(1200)
      // 先确保助手是收起的
      await ev(`(() => { const x = [...document.querySelectorAll('button')].find(b => b.getAttribute('title') === '收起'); x && x.click(); })()`)
      await sleep(500)
      const closed = await ev(`!document.body.innerText.includes('自动带上')`)
      const clicked = await ev(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'AI助手');
        if (!b) return false
        b.click()
        return true
      })()`)
      check('右侧栏常用功能里有「AI助手」入口', clicked)
      await sleep(900)
      check('点「AI助手」能唤起助手面板（此前只派发事件没监听）',
        clicked && closed && await ev(`document.body.innerText.includes('自动带上') || !!document.querySelector('textarea')`))

      // ---- 识别原文：能不能看到 OCR 到底读到了什?----
      {
        // 自己传一份扫描件（前面的用例会清理掉它自己的附件），保证不依赖别的用例留下的状'
        const token = await T.login()
        const buf = fs.readFileSync(path.join(__dirname, 'fixtures', 'contract-scan.jpg'))
        const fd = new FormData()
    fd.append('file', new Blob([buf], { type: 'image/jpeg' }), 'UIRAWTEST-合同扫描件.jpg')
        const up = await fetch(BASE + '/api/upload', {
          method: 'POST', headers: { Cookie: 'pms_session=' + token }, body: fd,
        }).then(r => r.json())
        check('上传用于查看原文的扫描件', !!up.attachment?.id, 'id=' + (up.attachment?.id || '-'))

        let readyRaw = false
        for (let i = 0; i < 30; i++) {
          await sleep(1000)
    const list = await fetch(BASE + '/api/attachments?q=UIRAWTEST-', {
            headers: { Cookie: 'pms_session=' + token },
          }).then(r => r.json())
          if (((list.rows || [])[0] || {}).ocr_status === 'done') { readyRaw = true; break }
        }
        check('识别完成', readyRaw)

        // 列表接口不应该带原文（太大），只带长'
    const li = await fetch(BASE + '/api/attachments?q=UIRAWTEST-', {
          headers: { Cookie: 'pms_session=' + token },
        }).then(r => r.json())
        const row0 = (li.rows || [])[0] || {}
        check('列表接口不带 OCR 原文（省流量', !('ocr_text' in row0) && row0.ocr_text_length > 0,
          `length=${row0.ocr_text_length}`)

        await goto('/attachments', 'h1', '附件中心')
        await ev(`(() => {
          const i = [...document.querySelectorAll('main input')].find(x => (x.placeholder || '').includes('搜索'));
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
          setter.call(i, 'UIRAWTEST-'); i.dispatchEvent(new Event('input',{bubbles:true}));
        })()`)
        await sleep(1500)
        await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('识别结果')); b && b.click(); })()`)
        await sleep(900)

        const hasBtn = await ev(`[...document.querySelectorAll('button')].some(b => b.textContent.includes('查看识别原文'))`)
        check('识别结果面板里有「查看识别原文」入', hasBtn)
        if (!hasBtn) {
          const dbg = await ev(`(() => ({
            btns: [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 14)).filter(Boolean).slice(0, 20),
            rows: document.querySelectorAll('main tbody tr').length,
          }))()`)
          console.log('      [诊断] ' + JSON.stringify(dbg))
        }

        if (hasBtn) {
          await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('查看识别原文')); b && b.click(); })()`)
          let len = -1
          for (let i = 0; i < 25; i++) {
            await sleep(300)
            len = await ev(`document.querySelector('pre') ? document.querySelector('pre').textContent.length : -1`)
            if (len > 100) break
          }
          check('点开后能取到识别原文（按需单独取）', len > 100, len > 0 ? len + ' 字' : '没取到')

          const tabs = await ev(`['归一化后','OCR 原始输出'].every(t => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === t))`)
          check('区分「归一化后」和「OCR 原始输出」两个视图', tabs)

          if (tabs && len > 100) {
            const normText = await ev(`document.querySelector('pre').textContent`)
            await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === 'OCR 原始输出'); b && b.click(); })()`)
            await sleep(600)
            const rawText = await ev(`document.querySelector('pre').textContent`)
            check('切到原始输出后内容确实变', normText !== rawText && rawText.length > 100,
        `归一后 ${normText.length} 字 / 原始 ${rawText.length} 字`)
            // 原始输出是带字间空格的，归一化后才紧?—?两边都要能看出区'
            check('原始输出保留了字间空格（没被加工过）',
              /合\s*同\s*编\s*号/.test(rawText) && rawText.length > normText.length,
          `原始 ${rawText.length} 字 → 归一后 ${normText.length} 字`)
            await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '归一化后'); b && b.click(); })()`)
            await sleep(500)
            const normText2 = await ev(`document.querySelector('pre').textContent`)
            // 归一化只负责去掉字间空格；点号转连字符是抽取阶段?cleanCode 干的
            //（所以归一化文本里是「HT . 2026.088」，而字段表里是「HT-2026-088」）
            check('归一化后字间空格被去',
              normText2.includes('合同编号') && !/合\s+同\s+编\s+号/.test(normText2),
              String(normText2.split('\n')[1] || '').trim().slice(0, 40))
            // 这一份的金额在扫描件里就是这种情况：千分位少一个逗号 —— 正是当初把合法金额拒掉的原因
            check('OCR 原文里能直接看到「5,860000,00」这种千分位错位',
              /5\s*[,，]?\s*860000/.test(rawText), '对着原文就能判断是扫描件的问题，还是规则的问题')
          }

          check('列出了各字段的出处片', await ev(`document.body.innerText.includes('各字段的出处')`))
        }

        // 清理自己传的附件
        const del = ((li.rows || [])[0] || {}).id
        if (del) await fetch(`${BASE}/api/attachments/${del}/delete`, {
          method: 'POST', headers: { Cookie: 'pms_session=' + token },
        })
        check('清理测试附件', true)
        // 关掉弹层，别挡住后面的助手面板用'
        await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === '关闭'); b && b.click(); })()`)
        await sleep(500)
      }
      // ---- 面板固定在右下角 ----
      const box0 = await ev(`(() => {
        const h = document.querySelector('div[title="拖动调整大小"]')
        const p = h && h.parentElement
        if (!p) return null
        const cs = getComputedStyle(p)
        const r = p.getBoundingClientRect()
        return {
          pos: cs.position, right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom),
          x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height)
        }
      })()`)
      check('面板钉在右下角（不再到处飘）',
        !!box0 && box0.right >= 0 && box0.right < 40 && box0.bottom >= 0 && box0.bottom < 40,
        box0 ? `距右 ${box0.right}px 距下 ${box0.bottom}px` : '没找')

      if (box0) {
        // 从左上角往左上??变大
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box0.x + 12, y: box0.y + 12, button: 'left', buttons: 1, clickCount: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box0.x - 96, y: box0.y - 56, button: 'left', buttons: 1 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box0.x - 96, y: box0.y - 56, button: 'left', buttons: 0, clickCount: 1 })
        await sleep(500)
        const box1 = await ev(`(() => {
          const h = document.querySelector('div[title="拖动调整大小"]')
        const p = h && h.parentElement
          if (!p) return null
          const r = p.getBoundingClientRect()
          return { w: Math.round(r.width), h: Math.round(r.height), right: Math.round(window.innerWidth - r.right), bottom: Math.round(window.innerHeight - r.bottom) }
        })()`)
        check('拖左上角能把面板拉大',
          !!box1 && box1.w > box0.w + 60 && box1.h > box0.h + 30,
      box1 ? `${box0.w}x${box0.h} → ${box1.w}x${box1.h}` : '失败')
        check('放大后仍然贴着右下',
          !!box1 && box1.right >= 0 && box1.right < 40 && box1.bottom >= 0 && box1.bottom < 40,
          box1 ? `距右 ${box1.right}px 距下 ${box1.bottom}px` : '失败')

        // 双击标题栏复'
        const hp = await ev(`(() => {
          const h = document.querySelector('div[title="拖动调整大小"]')
          const p = h && h.parentElement
          if (!p) return null
          const r = p.getBoundingClientRect()
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + 26) }
        })()`)
        const hx = hp ? hp.x : box0.x + 200
        const hy = hp ? hp.y : box0.y + 26
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hx, y: hy, button: 'left', buttons: 1, clickCount: 2 })
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hx, y: hy, button: 'left', buttons: 0, clickCount: 2 })
        await sleep(600)
        const box2 = await ev(`(() => {
          const h = document.querySelector('div[title="拖动调整大小"]')
        const p = h && h.parentElement
          if (!p) return null
          const r = p.getBoundingClientRect()
          return { w: Math.round(r.width), h: Math.round(r.height) }
        })()`)
        check('双击标题栏恢复默认大小', !!box2 && Math.abs(box2.w - 440) < 8, box2 ? `${box2.w}x${box2.h}` : '失败')
      }
    }
    // ---- 总览页「今日经营简报」卡（配了 AI 才出现）----
    await goto('/dashboard', 'aside', '总览');
    let brief = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      if (await ev(`document.body.innerText.includes('今日经营简')`)) { brief = true; break }
    }
    check('总览页出现「今日经营简报」卡', brief);
    if (brief) {
      check('简报显示模型来源',
        await ev(`document.body.innerText.includes('ui-mock') && document.body.innerText.includes('仅供参')`));
      check('简报显示「今日已生成」或「刚刚生成」',
        await ev(`/今日已生成|刚刚生成/.test(document.body.innerText)`));
    }
  } catch (e) {
    check('AI 助手面板', false, e.message.slice(0, 70));
  } finally {
    try {
      const tk = await T.login();
      await fetch(BASE + '/api/ai/config', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'pms_session=' + tk },
        body: JSON.stringify({ enabled: false, apiKey: null }),
      });
      check('AI 配置已还原', true);
    } catch { check('AI 配置已还原', false) }
    if (mockSrv) mockSrv.close();
  }


      // ---- 界面自定义：改了系统名 / 公司名 / 欢迎语，界面要跟着变 ----
      {
        const tk = await T.login()
        const H = { Cookie: 'pms_session=' + tk, 'Content-Type': 'application/json' }
        const MARK = 'UISET' + Math.random().toString(36).slice(2, 5).toUpperCase()
        const SUB = '副标题' + Math.random().toString(36).slice(2, 5)
        const ORIG = await fetch(BASE + '/api/settings', { headers: H }).then(r => r.json())

        await fetch(BASE + '/api/settings', {
          method: 'POST', headers: H,
          body: JSON.stringify({ settings: {
            system_name: MARK, company_name: '界面测试公司',
            welcome_morning: '早，{公司名}', welcome_afternoon: '午，{公司名}', welcome_evening: '晚，{公司名}',
            welcome_subtitle: SUB,
          } }),
        })

        await send('Page.reload', {})
        await sleep(2600)
        // 界面自定义的断言要在工作台页面上做（欢迎语只在首页横幅）
        await goto('/dashboard', `!!document.querySelector('h1')`, '回总览看欢迎语')
        await sleep(1200)

        const title = await ev(`document.title`)
        check('浏览器标签页标题跟着系统名变', title === MARK, title)

        const side = await ev(`[...document.querySelectorAll('div,span')].some(e => e.textContent === ${JSON.stringify(MARK)})`)
        check('侧边栏标题跟着系统名变', side, MARK)

        const greet = await ev(`/[早午晚]，界面测试公司/.test(document.body.innerText)`)
        check('首页欢迎语用了自定义模板，{公司名} 被替换', greet)

        const sub = await ev(`document.body.innerText.includes(${JSON.stringify(SUB)})`)
        check('欢迎语副标题跟着系统设置走', sub, SUB)

        // 还原，别把测试值留给后面的用例
        await fetch(BASE + '/api/settings', { method: 'POST', headers: H, body: JSON.stringify({ settings: ORIG.settings }) })
        await send('Page.reload', {})
        await sleep(2200)
        const restored = await ev(`document.title`)
        check('设置已还原', restored === ORIG.settings.system_name, restored)
      }

  const pass = results.filter(r => r.ok).length;
  console.log('\n前端验证结果：' + pass + ' / ' + results.length + ' 项通过');
  if (pass !== results.length) console.log('失败：' + results.filter(r => !r.ok).map(r => r.name).join('、'));
  c.kill();
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('[异常]', e.message); process.exit(1) });
