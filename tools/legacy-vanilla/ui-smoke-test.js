'use strict';
/**
 * 前端端到端冒烟测试
 * 自己拉起无头 Edge，通过 DevTools 协议真实点击界面，验证：
 * 列表渲染 → 新增项目 → 项目详情页签切换 → 详情页内新增收付款（自动带项目）
 * → 嵌套「快速新建往来单位」 → 表单校验 → 删除清理，全程收集 JS 报错。
 *
 * 用法： node tools/ui-smoke-test.js [http://127.0.0.1:8787]
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
 const TAUTH = require('./test-auth.js');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9333;
const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

async function main () {
  const browser = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!browser) throw new Error('未找到 Edge/Chrome，无法执行界面测试');
  const profile = path.join(os.tmpdir(), 'pms_uitest_profile');
  fs.rmSync(profile, { recursive: true, force: true });

  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1600,1100', 'about:blank',
  ], { stdio: 'ignore', detached: false });

  try {
    // 等待调试端口就绪
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
        targets = await r.json();
        if (targets.some(t => t.type === 'page')) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    const page = (targets || []).find(t => t.type === 'page');
    if (!page) throw new Error('无法连接无头浏览器调试端口');

    // ---- CDP 客户端 ----
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    const pending = new Map();
    let seq = 0;
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', rej);
    });
    const send = (method, params = {}) => new Promise(res => {
      const id = ++seq;
      pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });

    await send('Page.enable');
    await send('Runtime.enable');
    // 页面任何 JS 报错都记录下来
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: `window.__errs=[];window.addEventListener('error',e=>window.__errs.push('ERR: '+(e.message||e)));window.addEventListener('unhandledrejection',e=>window.__errs.push('REJ: '+(e.reason&&e.reason.message||e.reason)));`,
    });

    const evaluate = async (expr) => {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description || JSON.stringify(r.result.exceptionDetails));
      }
      return r.result.result.value;
    };
    const waitFor = async (expr, timeout = 8000, label = expr) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await evaluate(expr)) return true; } catch { /* 重试 */ }
        await sleep(120);
      }
      throw new Error('等待超时：' + label);
    };

    // ================= 0. 登录 =================
    console.log('\n[0] 登录页');
    TAUTH.forceAdminPassword();
    await TAUTH.resetTestData();   // 清掉上次中断留下的测试数据，避免互相污染
    await send('Page.navigate', { url: BASE + '/' });
    await waitFor(`!!document.querySelector('#login-form')`, 15000, '登录页渲染');
    check('未登录时显示登录页', true);
    const brandTxt = await evaluate(`document.querySelector('.login-card').innerText`);
    check('登录页有系统名称与输入框', /弱电智能化工程/.test(brandTxt) && /登录账号/.test(brandTxt));
    // 先故意输错密码
    await evaluate(`(() => { const f = document.querySelector('#login-form');
      f.username.value = ${JSON.stringify(TAUTH.USER)}; f.password.value = 'wrong-password'; })()`);
    await evaluate(`document.querySelector('#login-btn').click()`);
    await waitFor(`/不正确/.test(document.querySelector('#login-err').textContent)`, 8000, '密码错误提示');
    check('密码错误时给出提示且不放行', !(await evaluate(`!!document.querySelector('#nav .nav-item')`)));
    // 正确登录
    await evaluate(`(() => { const f = document.querySelector('#login-form');
      f.username.value = ${JSON.stringify(TAUTH.USER)}; f.password.value = ${JSON.stringify(TAUTH.PASS)}; })()`);
    await evaluate(`document.querySelector('#login-btn').click()`);
    await waitFor(`!!document.querySelector('#nav .nav-item')`, 15000, '登录后进入系统');
    check('登录成功进入系统', true);
    check('顶栏显示当前用户', /管理员/.test(await evaluate(`document.querySelector('#current-user').textContent`)),
      await evaluate(`document.querySelector('#current-user').textContent`));
    check('管理员能看到账号管理入口', await evaluate(`!!document.querySelector('#nav [data-href="#/users"]')`));

    // 开跑前先清掉上一次可能中断留下的测试数据，避免互相污染
    await send('Page.navigate', { url: BASE + '/#/dashboard' });
    await waitFor(`!!document.querySelector('#view')`, 8000, '应用加载');
    const cleaned = await evaluate(`(async () => {
      const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
      let n = 0;
      for (const kw of ['界面测试', '继续新增测试', 'UITEST', 'VCHK', '多子系统测试', '附件测试', '星海科技园']) {
        const r = await fetch('/api/list/projects?q=' + encodeURIComponent(kw)).then(x => x.json());
        for (const row of r.rows) { await post('/api/delete/projects/' + row.id, { cascade: true }); n++; }
      }
      for (const kw of ['界面测试供应商', '从没见过的甲方单位', '星海科技园发展有限公司', '新锐机电安装工程有限公司', '杭州智联弱电工程有限公司']) {
        const p = await fetch('/api/list/partners?q=' + encodeURIComponent(kw)).then(x => x.json());
        for (const row of p.rows) { await post('/api/delete/partners/' + row.id, { cascade: true }); n++; }
      }
      const a = await fetch('/api/attachments').then(x => x.json());
      for (const row of a.rows) { await post('/api/attachments/' + row.id + '/delete', {}); n++; }
      // 由识别测试素材误建出来的发票
      const iv = await fetch('/api/list/invoices?q=' + encodeURIComponent('24312000000123456789')).then(x => x.json());
      for (const row of iv.rows) { await post('/api/delete/invoices/' + row.id, { cascade: true }); n++; }
      // 附件识别测试中断时可能残留的合同
      const ct = await fetch('/api/list/contracts?q=' + encodeURIComponent('附件测试')).then(x => x.json());
      for (const row of ct.rows) { await post('/api/delete/contracts/' + row.id, { cascade: true }); n++; }
      return n;
    })()`);
    console.log(`  （测试前清理残留 ${cleaned} 条）`);

    // ================= 1. 列表页 =================
    console.log('\n[1] 项目台账列表');
    await send('Page.navigate', { url: BASE + '/#/t/projects' });
    await waitFor(`document.querySelectorAll('#view table.tb tbody tr').length >= 3`, 10000, '项目列表渲染');
    const rowCount = await evaluate(`document.querySelectorAll('#view table.tb tbody tr').length`);
    check('示例项目渲染出来', rowCount === 3, `表格 ${rowCount} 行`);
    check('侧栏计数已加载', (await evaluate(`document.querySelector('#nav .nav-item[data-href="#/t/contracts"] .cnt')?.textContent`)) === '8',
      '合同计数=' + await evaluate(`document.querySelector('#nav .nav-item[data-href="#/t/contracts"] .cnt')?.textContent`));
    check('示例数据标记', (await evaluate(`document.querySelectorAll('#view tbody tr.demo').length`)) === 3);

    // 项目台账的计算列（合同额/成本/已收款/应收余额/毛利率）
    check('项目台账显示汇总计算列', (await evaluate(`document.querySelector('#view table.tb thead').innerText.includes('应收余额')`)));
    const pfoot = await evaluate(`document.querySelector('#view table.tb tfoot')?.innerText.replace(/\\s+/g,' ')`);
    check('项目台账合计行正确（收入 10,460,000 / 应收 3,663,000）',
      /10,460,000\.00/.test(pfoot || '') && /3,663,000\.00/.test(pfoot || ''), pfoot);
    check('应收余额红色预警显示', (await evaluate(`document.querySelectorAll('#view tbody .neg').length`)) === 3);
    check('毛利率按项目算出', (await evaluate(`document.querySelector('#view table.tb tbody').innerText.includes('50.96%')`)));

    // 合同列表：带金额，应出现合计行且金额正确
    await send('Page.navigate', { url: BASE + '/#/t/contracts' });
    await waitFor(`document.querySelectorAll('#view table.tb tbody tr').length === 8`, 10000, '合同列表渲染');
    const foot = await evaluate(`document.querySelector('#view table.tb tfoot')?.innerText.replace(/\\s+/g,' ')`);
    check('合同列表出现合计行', !!foot, (foot || '').trim());
    check('合计金额正确（收入+支出 = 15,150,000.00）', /15,150,000\.00/.test(foot || ''), '合计=' + foot);

    // ================= 2. 新增项目 =================
    console.log('\n[2] 新增项目（走完整表单）');
    await send('Page.navigate', { url: BASE + '/#/t/projects' });
    await waitFor(`!!document.querySelector('#view [data-act="add"][data-table="projects"]')`, 8000, '回到项目列表');
    await evaluate(`document.querySelector('#view [data-act="add"][data-table="projects"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1`, 4000, '新增表单弹出');
    check('表单弹出且字段齐全', (await evaluate(`document.querySelectorAll('#modal-root .mask .form-grid [data-field]').length`)) === 11,
      (await evaluate(`document.querySelectorAll('#modal-root .mask .form-grid [data-field]').length`)) + ' 个字段');

    // 必填校验：直接保存应报错
    await evaluate(`document.querySelector('#modal-root [data-act="save-form"]:not([data-continue])').click()`);
    await sleep(400);
    const errMsg = await evaluate(`document.querySelector('#modal-root [data-role="err"]').textContent`);
    check('必填校验拦截', /不能为空/.test(errMsg), errMsg);
    check('校验失败时表单未关闭', (await evaluate(`document.querySelectorAll('#modal-root .mask').length`)) === 1);

    // 正常填写
    const testName = '界面测试项目-' + Date.now();
    await evaluate(`(() => {
      const m = document.querySelector('#modal-root .mask');
      const set = (f, v) => { const el = m.querySelector('[data-field="'+f+'"]'); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); };
      set('name', ${JSON.stringify(testName)});
      set('code', 'UITEST-001');
      set('manager', '测试员');
      set('end_date', '2026-12-31');
      const sel = m.querySelector('[data-field="client_id"]');
      sel.selectedIndex = 1;
      sel.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await evaluate(`document.querySelector('#modal-root [data-act="save-form"]:not([data-continue])').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 0`, 6000, '表单关闭');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(testName)})`, 6000, '新项目出现在列表');
    const newRows = await evaluate(`document.querySelectorAll('#view table.tb tbody tr').length`);
    check('新增成功并刷新列表', newRows === 4, `表格 ${newRows} 行`);
    check('成功提示出现', await evaluate(`!!document.querySelector('#toast-root .toast.ok')`));

    const newId = await evaluate(`(async () => {
      const r = await fetch('/api/list/projects?q=' + encodeURIComponent(${JSON.stringify(testName)})).then(r=>r.json());
      return r.rows[0] && r.rows[0].id;
    })()`);
    check('后端已落库', !!newId, 'id=' + newId);

    // ---- 子系统类别多选 ----
    console.log('\n[2c] 子系统类别多选');
    await evaluate(`document.querySelector('#view [data-act="add"][data-table="projects"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1`, 6000, '新增表单');
    const chipInfo = await evaluate(`(() => {
      const box = document.querySelector('#modal-root [data-field="category"]');
      return { count: box.querySelectorAll('.chip').length, on: box.querySelectorAll('.chip.on').length };
    })()`);
    check('子系统类别渲染成可点选标签', chipInfo.count >= 10, chipInfo.count + ' 个备选');
    check('默认已选中一个子系统', chipInfo.on === 1, chipInfo.on + ' 个已选');
    const multiName = '多子系统测试-' + Date.now();
    await evaluate(`(() => {
      const m = document.querySelector('#modal-root .mask');
      const chips = m.querySelectorAll('[data-field="category"] .chip');
      chips[1].click();          // 加选第 2 个
      chips[3].click();          // 加选第 4 个
      const e = m.querySelector('[data-field="name"]'); e.value = ${JSON.stringify(multiName)};
      e.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const onCount = await evaluate(`document.querySelectorAll('#modal-root [data-field="category"] .chip.on').length`);
    check('可以同时选中多个子系统', onCount === 3, onCount + ' 个已选');
    // 再点一次应取消该标签
    await evaluate(`document.querySelectorAll('#modal-root [data-field="category"] .chip')[1].click()`);
    const afterOff = await evaluate(`document.querySelectorAll('#modal-root [data-field="category"] .chip.on').length`);
    check('再点一次可取消选中', afterOff === 2, afterOff + ' 个已选');
    await evaluate(`document.querySelectorAll('#modal-root [data-field="category"] .chip')[1].click()`);
    await evaluate(`document.querySelector('#modal-root [data-act="save-form"]:not([data-continue])').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 0`, 8000, '保存多子系统项目');
    const multiSaved = await evaluate(`(async () => {
      const r = await fetch('/api/list/projects?q=' + encodeURIComponent(${JSON.stringify(multiName)})).then(x => x.json());
      const row = r.rows[0];
      return row ? { cats: row.category, tags: document.querySelector('#view tbody') ? document.querySelector('#view tbody').innerText : '' } : null;
    })()`);
    check('多个子系统已保存', multiSaved && String(multiSaved.cats).split(',').length === 3, multiSaved ? multiSaved.cats : '未找到');
    check('列表里以多个标签展示', !!multiSaved && ['综合布线', '安防监控', '机房工程'].every(c => multiSaved.tags.includes(c)),
      multiSaved ? multiSaved.tags.split('\n').filter(Boolean)[0] : '');
    await evaluate(`(async () => {
      const r = await fetch('/api/list/projects?q=' + encodeURIComponent(${JSON.stringify(multiName)})).then(x => x.json());
      for (const row of r.rows) await fetch('/api/delete/projects/' + row.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    })()`);

    // ---- 保存并继续新增（连续录入用） ----
    console.log('\n[2b] 保存并继续新增');
    await evaluate(`document.querySelector('#view [data-act="add"][data-table="projects"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1`, 6000, '新增表单弹出');
    const contName = '继续新增测试-' + Date.now();
    await evaluate(`(() => { const m = document.querySelector('#modal-root .mask');
      const e = m.querySelector('[data-field="name"]'); e.value = ${JSON.stringify(contName)};
      e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate(`document.querySelector('#modal-root [data-act="save-form"][data-continue="1"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1 && document.querySelector('#modal-root [data-field="name"]').value === ''`,
      10000, '表单清空待录入下一条');
    check('保存后表单清空、停留在新增状态', true);
    const contSaved = await evaluate(`fetch('/api/list/projects?q=' + encodeURIComponent(${JSON.stringify(contName)})).then(r => r.json()).then(d => d.total)`);
    check('上一条已落库', contSaved === 1, contSaved + ' 条');
    await evaluate(`document.querySelector('#modal-root [data-act="close-modal"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 0`, 5000, '关闭表单');
    await evaluate(`(async () => {
      const d = await fetch('/api/list/projects?q=' + encodeURIComponent(${JSON.stringify(contName)})).then(r => r.json());
      for (const row of d.rows) await fetch('/api/delete/projects/' + row.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    })()`);

    // ================= 3. 项目详情页 =================
    console.log('\n[3] 项目详情页与页签切换');
    await send('Page.navigate', { url: `${BASE}/#/p/${newId}` });
    // 注意：不能只等"页面出现项目名"——上一个列表页里本来就有这个名字，会立刻误判
    await waitFor(`!!document.querySelector('#view .detail-head h2') &&
      document.querySelector('#view .detail-head h2').textContent.includes(${JSON.stringify(testName)})`, 12000, '详情页渲染');
    check('详情页 KPI 区渲染', (await evaluate(`document.querySelectorAll('#view .kpi').length`)) === 10);
    check('八个页签齐全', (await evaluate(`document.querySelectorAll('#view .tab').length`)) === 8);
    check('默认页签为合同', (await evaluate(`document.querySelector('#view .tab.active')?.textContent.includes('合同')`)) === true);

    await evaluate(`document.querySelector('#view .tab[data-key="payments"]').click()`);
    await waitFor(`document.querySelector('#view .tab[data-key="payments"]').classList.contains('active')`, 6000, '页签切换');
    await waitFor(`!!document.querySelector('#detail-panel [data-act="add"][data-table="payments"]')`, 6000, '收付款面板加载');
    check('切换到收付款页签', true);

    // ================= 4. 详情页内新增，自动带项目 =================
    console.log('\n[4] 详情页内新增收付款（项目自动带入）');
    await evaluate(`document.querySelector('#detail-panel [data-act="add"][data-table="payments"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1`, 4000, '收付款表单弹出');
    const presetProject = await evaluate(`document.querySelector('#modal-root [data-field="project_id"]').value`);
    check('所属项目已自动选中', String(presetProject) === String(newId), `project_id=${presetProject}`);
    await evaluate(`(() => {
      const m = document.querySelector('#modal-root .mask');
      const set = (f, v) => { const el = m.querySelector('[data-field="'+f+'"]'); el.value = v; el.dispatchEvent(new Event('input', {bubbles:true})); };
      set('amount', '128000'); set('pay_date', '2026-06-18'); set('voucher_no', 'UITEST-SK-001');
    })()`);
    await evaluate(`document.querySelector('#modal-root [data-act="save-form"]:not([data-continue])').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 0`, 6000, '收付款保存');
    await waitFor(`document.querySelector('#detail-panel').innerText.includes('UITEST-SK-001')`, 6000, '记录出现在面板');
    check('收付款新增成功', true);
    check('详情页 KPI 实时更新', (await evaluate(`document.querySelector('#view .kpi.c .vl').innerText.replace(/[^0-9.]/g,'')`)) === '12.80',
      '累计回款=' + await evaluate(`document.querySelector('#view .kpi.c .vl').innerText.trim()`));

    // ================= 5. 嵌套快速新建（最易出错的地方） =================
    console.log('\n[5] 表单内嵌套「快速新建往来单位」');
    await evaluate(`document.querySelector('#view .tab[data-key="contracts"]').click()`);
    await waitFor(`!!document.querySelector('#detail-panel [data-act="add"][data-table="contracts"]')`, 6000, '合同面板');
    await evaluate(`document.querySelector('#detail-panel [data-act="add"][data-table="contracts"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1`, 4000, '合同表单弹出');

    // 合同类别联动收支方向
    await evaluate(`(() => {
      const m = document.querySelector('#modal-root .mask');
      const sel = m.querySelector('[data-field="category"]');
      sel.value = '采购合同'; sel.dispatchEvent(new Event('change', {bubbles:true}));
    })()`);
    await sleep(200);
    const dir = await evaluate(`document.querySelector('#modal-root [data-field="direction"]').value`);
    check('合同类别联动收支方向', dir === 'out', '采购合同 → ' + dir);

    await evaluate(`document.querySelector('#modal-root [data-act="ref-new"][data-ref="partners"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 2`, 4000, '嵌套表单弹出');
    check('嵌套表单同时存在两层', true);
    const nestedName = '界面测试供应商-' + Date.now();
    await evaluate(`(() => {
      const m = document.querySelectorAll('#modal-root .mask')[1];
      const el = m.querySelector('[data-field="name"]'); el.value = ${JSON.stringify(nestedName)};
      el.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    await evaluate(`document.querySelectorAll('#modal-root .mask')[1].querySelector('[data-act="save-form"]:not([data-continue])').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1`, 6000, '子表单关闭');
    check('保存子表单后父表单仍在', true);
    await waitFor(`document.querySelector('#modal-root [data-field="partner_id"]').selectedOptions[0].textContent.includes('界面测试供应商')`, 5000, '父表单下拉已回填');
    check('新建单位自动回填到父表单', true);

    // 关掉表单
    await evaluate(`document.querySelector('#modal-root [data-act="close-modal"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 0`, 3000, '关闭表单');

    // ================= 6. 清理测试数据 =================
    console.log('\n[6] 清理测试数据');
    const cleanup = await evaluate(`(async () => {
      const post = (u,b) => fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());
      await post('/api/delete/projects/${newId}', {cascade:true});
      const ps = await fetch('/api/list/partners?q=' + encodeURIComponent('界面测试供应商')).then(r=>r.json());
      for (const p of ps.rows) await post('/api/delete/partners/'+p.id, {cascade:true});
      const d = await fetch('/api/dashboard').then(r=>r.json());
      return d.totals.project_count + '/' + d.totals.contract_in;
    })()`);
    check('测试数据已清理，数据回到初始态', cleanup === '3/10460000', '项目数/收入合同额 = ' + cleanup);

    // ================= 7. 布局体检 =================
    console.log('\n[7] 布局体检（总览页）');
    await send('Page.navigate', { url: BASE + '/#/dashboard' });
    await waitFor(`document.querySelectorAll('#view .ds-kpi').length === 4`, 10000, '总览页渲染');
    const L = await evaluate(`(() => {
      const kpis = [...document.querySelectorAll('#view .ds-kpi')].map(e => e.getBoundingClientRect());
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        sidebar: Math.round(document.querySelector('.sidebar').getBoundingClientRect().width),
        screen: !!document.querySelector('#view .dash-screen'),
        kpiCount: kpis.length,
        kpiRow1: kpis.filter(k => Math.abs(k.top - kpis[0].top) < 2).length,
        kpiWidth: Math.round(kpis[0].width),
        kpiHeight: Math.round(kpis[0].height),
        cards: document.querySelectorAll('#view .ds-card').length,
        cardsBroken: [...document.querySelectorAll('#view .ds-card')].filter(c => c.getBoundingClientRect().width < 120).length,
        charts: document.querySelectorAll('#view .ds-chart').length,
        chartCols: document.querySelector('#view .ds-chart') ? document.querySelector('#view .ds-chart').querySelectorAll('.ds-col').length : 0,
        glow: (() => { const k = document.querySelector('#view .ds-kpi .kv'); return k ? getComputedStyle(k).textShadow : ''; })(),
        darkBg: getComputedStyle(document.querySelector('#view .dash-screen')).backgroundImage.includes('gradient'),
        navItems: document.querySelectorAll('#nav .nav-item').length,
        rankRows: document.querySelectorAll('#view .ds-rank .rk').length,
        agingRows: document.querySelectorAll('#view .ds-aging .ag').length,
        clock: (document.querySelector('#ds-clock') || {}).textContent || '',
        // 新增：环形仪表 / 趋势线 / 待办提醒 / 发票勾稽
        gauges: document.querySelectorAll('#view .ds-gauge').length,
        gaugeArc: (() => {
          const c = document.querySelector('#view .ds-gauge circle:nth-child(2)');
          return c ? (c.getAttribute('stroke-dasharray') || '') : '';
        })(),
        gaugeTexts: [...document.querySelectorAll('#view .ds-gauge text')].map(t => t.textContent.trim()),
        trendSvg: !!document.querySelector('#view .ds-trend svg'),
        trendPathLen: (() => { const p = document.querySelector('#view .ds-trend svg path'); return p ? Math.round(p.getTotalLength()) : 0; })(),
        reminders: document.querySelectorAll('#view .ds-remind').length,
        reconRows: document.querySelectorAll('#view .ds-recon .ds-rk-row').length,
        coverBar: !!document.querySelector('#view .ds-cover .bar i'),
        // 布局整齐度：每个分区网格都不能有空洞，同排卡片要等高
        ...(() => {
          const all = [];
          let gridW = 0;
          for (const grid of document.querySelectorAll('#view .ds-grid')) {
            const gw = Math.round(grid.getBoundingClientRect().width);
            gridW = Math.max(gridW, gw);
            const cards = [...grid.querySelectorAll('.ds-card')].map(c => {
              const b = c.getBoundingClientRect();
              return { y: Math.round(b.top), r: Math.round(b.right), h: Math.round(b.height) };
            });
            if (!cards.length) continue;
            const rows = [];
            for (const c of cards) {
              let r = rows.find(x => Math.abs(x.y - c.y) < 8);
              if (!r) { r = { y: c.y, items: [] }; rows.push(r); }
              r.items.push(c);
            }
            for (const r of rows) all.push({ right: Math.max(...cards.map(c => c.r)), row: r });
          }
          const holeOf = o => o.right - Math.max(...o.row.items.map(c => c.r));
          return {
            gridRows: all.length,
            holes: all.filter(o => holeOf(o) > 40).length,          // 右侧 >40px 算空洞
            maxHole: Math.max(0, ...all.map(holeOf)),
            maxRagged: Math.max(0, ...all.map(o => {                 // 同排最大高差
              const hs = o.row.items.map(c => c.h);
              return Math.max(...hs) - Math.min(...hs);
            })),
            zones: document.querySelectorAll('#view .ds-zone').length,
            remindH: Math.round((document.querySelector('#view .ds-remind-wrap')
              || document.querySelector('#view .ds-remind')).getBoundingClientRect().height),
            gridW,
          };
        })(),
        crumb: document.querySelector('#crumb').textContent.trim(),
        viewH: Math.round(document.querySelector('#view').getBoundingClientRect().height),
      };
    })()`);
    check('页面无横向溢出', L.overflow <= 2, `溢出 ${L.overflow}px`);
    check('侧栏宽度正常', L.sidebar === 216, `${L.sidebar}px`);
    check('总览使用深色驾驶舱大屏', L.screen && L.darkBg, 'dash-screen + 渐变背景');
    check('四个核心指标卡同排', L.kpiCount === 4 && L.kpiRow1 === 4 && L.kpiWidth >= 180 && L.kpiHeight >= 90,
      `${L.kpiCount} 张，同排 ${L.kpiRow1} 张，单张 ${L.kpiWidth}×${L.kpiHeight}px`);
    check('指标数字带发光效果', !!L.glow && L.glow !== 'none' && /\d+px/.test(L.glow), L.glow.slice(0, 46));
    check('大屏卡片全部正常排布', L.cards >= 7 && L.cardsBroken === 0, `${L.cards} 张卡片，异常宽度 ${L.cardsBroken} 张`);
    check('两张图表都渲染出数据点', L.charts === 2 && L.chartCols >= 6, `${L.charts} 张图 / 资金图 ${L.chartCols} 个月`);
    check('账龄分档渲染', L.agingRows >= 3, `${L.agingRows} 档`);
    check('大屏时钟在走', /\d{4}-\d{2}-\d{2}/.test(L.clock), L.clock);
    // ---- 本轮新增的图形与面板 ----
    check('环形仪表渲染（4 个比率）', L.gauges === 4 && L.gaugeTexts.every(t => /%$/.test(t)),
      `${L.gauges} 个：${L.gaugeTexts.join(' ')}`);
    check('环形按比例绘制（dasharray 有两位数字）', /^[\d.]+ [\d.]+$/.test(L.gaugeArc), L.gaugeArc);
    check('趋势折线渲染出路径', L.trendSvg && L.trendPathLen > 100, `路径长 ${L.trendPathLen}`);
    check('待办提醒条渲染', L.reminders >= 1, `${L.reminders} 条`);
    check('发票勾稽面板渲染', L.reconRows >= 4 && L.coverBar, `${L.reconRows} 行 + 覆盖率条`);
    // ---- 布局整齐度：网格充满、同排等高、提醒条紧凑 ----
    check('网格每行都填满（无空洞）', L.holes === 0,
      `${L.gridRows} 行，最大右侧空隙 ${L.maxHole}px`);
    check('同排卡片等高（参差 ≤ 4px）', L.maxRagged <= 4,
      `最大高差 ${L.maxRagged}px`);
    check('总览分了业务分区', L.zones === 3, `${L.zones} 个分区标题`);
    check('待办提醒条紧凑（≤120px）', L.remindH > 0 && L.remindH <= 120, `${L.remindH}px`);
    // 导航项 = 总览 + 业务表 + 附件/导入/回收站/日志/账号/设置，从接口动态算，避免以后加表又要改测试
    const expectedNav = await evaluate(`fetch('/api/meta').then(r => r.json()).then(m => m.order.length + 7)`);
    check('侧栏导航项齐全', L.navItems === expectedNav, `${L.navItems} / 预期 ${expectedNav}`);
    check('应收排行有数据', L.rankRows >= 2, `${L.rankRows} 行`);
    check('面包屑正确', L.crumb === '总览经营概览', L.crumb);
    check('内容区有高度', L.viewH > 400, `${L.viewH}px`);

    // ================= 7b. 手机端适配 =================
    console.log('\n[7b] 手机端适配（390×844 触摸屏）');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await send('Page.navigate', { url: BASE + '/#/dashboard' });
    await waitFor(`document.querySelectorAll('#view .ds-kpi').length === 4`, 12000, '手机端总览');
    await sleep(700);
    const M = await evaluate(`(() => {
      const sb = document.querySelector('.sidebar');
      const menu = document.querySelector('#btn-menu');
      const kp = document.querySelector('.ds-kpis');
      return {
        menuDisplay: getComputedStyle(menu).display,
        menuSize: Math.round(menu.getBoundingClientRect().width) + 'x' + Math.round(menu.getBoundingClientRect().height),
        sidebarLeft: Math.round(sb.getBoundingClientRect().left),
        sidebarW: Math.round(sb.getBoundingClientRect().width),
        kpiCols: getComputedStyle(kp).gridTemplateColumns.split(' ').length,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    check('手机端出现汉堡按钮', M.menuDisplay !== 'none' && M.menuSize === '38x38', M.menuSize);
    check('手机端侧栏默认收起', M.sidebarLeft < -100, `left=${M.sidebarLeft}px`);
    check('手机端指标卡改单列', M.kpiCols === 1, M.kpiCols + ' 列');
    check('手机端无横向溢出', M.overflow <= 2, `溢出 ${M.overflow}px`);
    // 打开抽屉
    await evaluate(`document.querySelector('#btn-menu').click()`);
    await sleep(450);
    const M2 = await evaluate(`(() => {
      const sb = document.querySelector('.sidebar');
      return {
        left: Math.round(sb.getBoundingClientRect().left),
        backdrop: getComputedStyle(document.querySelector('#nav-backdrop')).display,
        navText: getComputedStyle(document.querySelector('#nav .nav-item span:not(.ico)')).display,
        itemH: Math.round(document.querySelector('#nav .nav-item').getBoundingClientRect().height),
      };
    })()`);
    check('点汉堡滑出抽屉', M2.left === 0, `left=${M2.left}px`);
    check('抽屉有遮罩', M2.backdrop === 'block', M2.backdrop);
    check('抽屉里导航文字可见', M2.navText !== 'none', M2.navText);
    check('导航项触摸目标够大（≥44px）', M2.itemH >= 44, M2.itemH + 'px');
    await evaluate(`document.querySelector('#nav-backdrop').click()`);
    await sleep(400);
    check('点遮罩收起抽屉', (await evaluate(`Math.round(document.querySelector('.sidebar').getBoundingClientRect().left)`)) < -100);
    // 表格横向滑动
    await send('Page.navigate', { url: BASE + '/#/t/projects' });
    await waitFor(`document.querySelectorAll('#view table.tb tbody tr').length > 0`, 12000, '手机端项目列表');
    await sleep(500);
    const MT = await evaluate(`(() => {
      const w = document.querySelector('.table-wrap');
      return {
        scrollable: w.scrollWidth > w.clientWidth,
        tableW: Math.round(document.querySelector('.tb').getBoundingClientRect().width),
        wrapW: Math.round(w.clientWidth),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    check('宽表格可横向滑动', MT.scrollable, `表宽 ${MT.tableW} > 容器 ${MT.wrapW}`);
    check('表格页整体不溢出', MT.pageOverflow <= 2, `溢出 ${MT.pageOverflow}px`);
    // 恢复桌面视口，别影响后续用例
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });

    // ================= 7c. 多分辨率版面体检 =================
    // 曾经在 1200px 断点把 span-4 改 6、span-8 改 12，导致 4+8 配对各占一行、前半行空一半；
    // 这里把常见分辨率都量一遍，空洞和参差都不许出现。
    console.log('\n[7c] 多分辨率版面体检');
    const BREAKPOINTS = [
      { w: 1680, h: 1050, name: '桌面 1680' },
      { w: 1440, h: 900, name: '笔记本 1440' },
      { w: 1280, h: 800, name: '小笔记本 1280' },
      { w: 1024, h: 768, name: '平板横屏 1024' },
      { w: 768, h: 1024, name: '平板竖屏 768' },
      { w: 390, h: 844, name: '手机 390' },
    ];
    for (const bp of BREAKPOINTS) {
      await send('Emulation.setDeviceMetricsOverride', { width: bp.w, height: bp.h, deviceScaleFactor: 1, mobile: bp.w <= 768 });
      await send('Page.navigate', { url: BASE + '/#/dashboard' });
      await waitFor(`document.querySelectorAll('#view .ds-kpi').length === 4`, 12000, bp.name + ' 总览');
      await sleep(500);
      const M3 = await evaluate(`(() => {
        let maxHole = 0, maxRag = 0;
        for (const g of document.querySelectorAll('#view .ds-grid')) {
          const cards = [...g.querySelectorAll('.ds-card')].map(c => {
            const b = c.getBoundingClientRect();
            return { y: Math.round(b.top), r: Math.round(b.right), h: Math.round(b.height) };
          });
          if (!cards.length) continue;
          const right = Math.max(...cards.map(c => c.r));
          const rs = [];
          for (const cd of cards) { let r = rs.find(x => Math.abs(x.y - cd.y) < 8); if (!r) { r = { y: cd.y, items: [] }; rs.push(r); } r.items.push(cd); }
          for (const r of rs) {
            maxHole = Math.max(maxHole, right - Math.max(...r.items.map(c => c.r)));
            const hs = r.items.map(c => c.h);
            maxRag = Math.max(maxRag, Math.max(...hs) - Math.min(...hs));
          }
        }
        return { maxHole, maxRag, overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      })()`);
      check(bp.name + ' 版面整齐', M3.maxHole <= 40 && M3.maxRag <= 4 && M3.overflow <= 2,
        `空洞 ${M3.maxHole}px / 参差 ${M3.maxRag}px / 溢出 ${M3.overflow}px`);
    }
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Emulation.setTouchEmulationEnabled', { enabled: false });

    // ================= 8. 收付款计划 / 数据导入 / 项目内页签 =================
    console.log('\n[8] 新增模块页面');
    await send('Page.navigate', { url: BASE + '/#/t/schedules' });
    await waitFor(`document.querySelectorAll('#view table.tb tbody tr').length >= 10`, 12000, '收付款计划列表');
    const schedTxt = await evaluate(`document.querySelector('#view').innerText`);
    check('收付款计划列表渲染出节点', /预付款|进度款|质保金/.test(schedTxt));
    check('显示已收付/未收付列', schedTxt.includes('已收付') && schedTxt.includes('未收付'));
    check('节点状态标签出现', /已完成|已逾期|待收付|部分收付/.test(schedTxt));
    check('页面有自动冲抵说明', /自动冲抵/.test(schedTxt));
    const schedFoot = await evaluate(`document.querySelector('#view table.tb tfoot')?.innerText.replace(/\\s+/g,' ')`);
    check('计划合计行正确（全部计划 14,540,000）', /14,540,000\.00/.test(schedFoot || ''), schedFoot);

    await send('Page.navigate', { url: BASE + '/#/import' });
    await waitFor(`!!document.querySelector('#imp')`, 12000, '数据导入页');
    check('数据导入页渲染', true);
    check('导入步骤条 7 张表', (await evaluate(`document.querySelectorAll('#imp [data-act="imp-pick"]').length`)) === 7);
    const impTxt = await evaluate(`document.querySelector('#imp').innerText`);
    check('有下载模板入口', impTxt.includes('下载导入模板'));
    check('有列说明对照表', impTxt.includes('列说明'));
    check('说明了导入先后顺序', /往来单位.*项目台账.*合同/.test(impTxt));

    const pid = await evaluate(`fetch('/api/list/projects?limit=1').then(r=>r.json()).then(d=>d.rows[0].id)`);
    await send('Page.navigate', { url: BASE + '/#/p/' + pid });
    await waitFor(`document.querySelectorAll('#view .tab').length === 8`, 12000, '项目详情页签');
    check('项目详情有 8 个页签（含费用、售后）', true,
      await evaluate(`[...document.querySelectorAll('#view .tab')].map(t=>t.textContent.replace(/[0-9]/g,'')).join(' / ')`));
    await evaluate(`document.querySelector('#view .tab[data-key="schedules"]').click()`);
    await waitFor(`!!document.querySelector('#detail-panel [data-table="schedules"]')`, 10000, '项目内计划页签');
    check('项目内「收付款计划」页签可用', true);
    await evaluate(`document.querySelector('#view .tab[data-key="attachments"]').click()`);
    await waitFor(`!!document.querySelector('#detail-panel [data-act="p-att-up"]')`, 10000, '项目内附件页签');
    check('项目内「附件」页签可用', true);

    // ================= 9. 列表勾选与批量删除 =================
    console.log('\n[9] 列表勾选与批量删除');
    const delIds = await evaluate(`(async () => {
      const post = (u, b) => fetch(u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) }).then(r => r.json());
      const a = await post('/api/save/partners', { name: '批量删除测试甲', type: '其他' });
      const b = await post('/api/save/partners', { name: '批量删除测试乙', type: '其他' });
      return [a.id, b.id];
    })()`);
    await send('Page.navigate', { url: BASE + '/#/t/partners' });
    await waitFor(`document.querySelectorAll('#view .row-chk').length >= 3`, 12000, '往来单位列表');
    check('列表出现勾选列', (await evaluate(`document.querySelectorAll('#view .row-chk').length`)) >= 3);
    check('表头有全选框', await evaluate(`!!document.querySelector('#view [data-check-all]')`));
    check('未勾选时批量操作条隐藏', await evaluate(`document.querySelector('#view .sel-bar').style.display === 'none'`));

    const pickTwo = `(() => {
      const want = ${JSON.stringify(delIds)};
      [...document.querySelectorAll('#view .row-chk')].forEach(c => {
        if (want.includes(Number(c.value))) { c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true })); }
      });
    })()`;
    await evaluate(pickTwo);
    await waitFor(`document.querySelector('#view .sel-bar').style.display !== 'none'`, 5000, '批量操作条出现');
    const barTxt = (await evaluate(`document.querySelector('#view .sel-bar').innerText`)).replace(/\s+/g, ' ');
    check('操作条显示已选数量', /已选 2 条/.test(barTxt), barTxt.slice(0, 50));
    check('操作条有「批量删除」与「导出所选」', /批量删除/.test(barTxt) && /导出所选/.test(barTxt));
    check('选中的行有高亮', (await evaluate(`document.querySelectorAll('#view tbody tr.sel').length`)) === 2);

    await evaluate(`document.querySelector('#view [data-check-all]').click()`);
    await sleep(300);
    const allSel = await evaluate(`({ total: document.querySelectorAll('#view .row-chk').length, on: document.querySelectorAll('#view .row-chk:checked').length })`);
    check('全选勾上本页所有行', allSel.total === allSel.on && allSel.total > 0, `${allSel.on}/${allSel.total}`);

    await evaluate(`document.querySelector('#view [data-sel-clear]').click()`);
    await sleep(300);
    check('取消选择后操作条隐藏', await evaluate(`document.querySelector('#view .sel-bar').style.display === 'none'`));

    await evaluate(pickTwo);
    await evaluate(`document.querySelector('#view [data-sel-del]').click()`);
    await waitFor(`!!document.querySelector('[data-act="dc-yes"]')`, 10000, '批量删除确认弹窗');
    const dcTxt = await evaluate(`document.querySelector('[data-act="dc-yes"]').closest('.modal').innerText`);
    check('批量删除会先弹确认框', /确认删除选中的 2 条/.test(dcTxt), dcTxt.split('\n')[0]);
    check('没有附件时不显示附件选项', !/附件的文件/.test(dcTxt));
    await evaluate(`document.querySelector('[data-act="dc-yes"]').click()`);
    await waitFor(`document.querySelector('#view .sel-bar').style.display === 'none'`, 12000, '批量删除完成');
    const gone = await evaluate(`fetch('/api/list/partners?q=' + encodeURIComponent('批量删除测试')).then(r => r.json()).then(d => d.total)`);
    check('选中的记录已批量删除', gone === 0, gone + ' 条残留');

    // 单条删除也走同一个确认框
    await evaluate(`document.querySelector('#view [data-act="add"][data-table="partners"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1`, 6000, '新增单位表单');
    await evaluate(`(() => { const m = document.querySelector('#modal-root .mask');
      const e = m.querySelector('[data-field="name"]'); e.value = '单条删除测试'; e.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await evaluate(`document.querySelector('#modal-root [data-act="save-form"]:not([data-continue])').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 0`, 8000, '保存单位');
    await waitFor(`document.querySelector('#view tbody').innerText.includes('单条删除测试')`, 8000, '新单位出现在列表');
    await evaluate(`(() => {
      const rows = [...document.querySelectorAll('#view tbody tr')];
      const tr = rows.find(r => r.innerText.includes('单条删除测试'));
      tr.querySelector('[data-act="del"]').click();
    })()`);
    await waitFor(`!!document.querySelector('[data-act="dc-yes"]')`, 8000, '单条删除确认框');
    check('单条删除也带确认框', true);
    await evaluate(`document.querySelector('[data-act="dc-yes"]').click()`);
    await waitFor(`!document.querySelector('#view tbody').innerText.includes('单条删除测试')`, 10000, '单条删除完成');
    check('单条删除成功', true);

    // ================= 10. JS 报错汇总 =================
    console.log('\n[10] 前端运行时错误检查');
    const errs = await evaluate('JSON.stringify(window.__errs || [])');
    const errList = JSON.parse(errs);
    check('全过程无 JS 报错', errList.length === 0, errList.length ? errList.join(' | ') : '0 条');

    ws.close();
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(400);
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(56));
  console.log(`  界面测试结果：${results.length - failed.length} / ${results.length} 项通过`);
  if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name + (f.extra ? ' (' + f.extra + ')' : '')).join('\n'));
  console.log('='.repeat(56));
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('\n[测试异常]', e.message); process.exit(1); });
