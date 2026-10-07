'use strict';
/**
 * 附件上传 + OCR 识别 端到端界面测试
 *   node tools/ui-attach-test.js [http://127.0.0.1:8787]
 *
 * 用真实的发票 PDF 和合同扫描件走完整流程：
 *   附件库上传 → 自动识别 → 查看识别结果 → 在合同中上传并「全部填入」→ 保存 → 验证落库与关联
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
 const TAUTH = require('./test-auth.js');

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const PORT = 9334;
const FIX = path.join(__dirname, 'fixtures');
const INVOICE = path.join(FIX, 'invoice.pdf');
const SCAN = path.join(FIX, 'contract-scan.jpg');
const NEWCON = path.join(FIX, 'contract-new.pdf');

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
  for (const f of [INVOICE, SCAN, NEWCON]) {
    if (!fs.existsSync(f)) throw new Error('缺少测试素材：' + f);
  }
  const browser = EDGE_CANDIDATES.find(p => fs.existsSync(p));
  if (!browser) throw new Error('未找到 Edge/Chrome');

  const profile = path.join(os.tmpdir(), 'pms_attach_profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--disable-extensions',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
    '--window-size=1700,1150', 'about:blank',
  ], { stdio: 'ignore' });

  try {
    let targets = null;
    for (let i = 0; i < 60; i++) {
      try {
        targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        if (targets.some(t => t.type === 'page')) break;
      } catch { /* 还没起来 */ }
      await sleep(250);
    }
    const page = (targets || []).find(t => t.type === 'page');
    if (!page) throw new Error('无法连接无头浏览器');

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

    await send('Page.enable');
    await send('Runtime.enable');
    await send('DOM.enable');
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
    const waitFor = async (expr, timeout = 15000, label = expr) => {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        try { if (await evaluate(expr)) return true; } catch { /* 重试 */ }
        await sleep(200);
      }
      throw new Error('等待超时：' + label);
    };
    // 通过 CDP 把真实文件塞进 <input type=file>
    const setFileInput = async (selector, filePath) => {
      const doc = await send('DOM.getDocument', { depth: -1 });
      const q = await send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector });
      if (!q.result || !q.result.nodeId) throw new Error('没找到文件输入框：' + selector);
      await send('DOM.setFileInputFiles', { nodeId: q.result.nodeId, files: [filePath] });
    };

    // ================= 1. 附件库页面 =================
    // ---- 先登录 ----
    TAUTH.forceAdminPassword();
    await TAUTH.resetTestData();   // 清掉上次中断留下的测试数据，避免互相污染
    await send('Page.navigate', { url: BASE + '/' });
    await waitFor(`!!document.querySelector('#login-form')`, 15000, '登录页');
    await evaluate(`(() => { const f = document.querySelector('#login-form');
      f.username.value = ${JSON.stringify(TAUTH.USER)}; f.password.value = ${JSON.stringify(TAUTH.PASS)}; })()`);
    await evaluate(`document.querySelector('#login-btn').click()`);
    await waitFor(`!!document.querySelector('#nav .nav-item')`, 15000, '登录后进入系统');
    console.log('  （已登录）');

    console.log('\n[1] 附件与识别页面');
    await send('Page.navigate', { url: BASE + '/#/dashboard' });
    await waitFor(`!!document.querySelector('#view')`, 8000, '应用加载');
    // 先清空历史附件，保证断言基于干净状态
    const pre = await evaluate(`(async () => {
      const a = await fetch('/api/attachments').then(r => r.json());
      for (const row of a.rows) await fetch('/api/attachments/' + row.id + '/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const iv = await fetch('/api/list/invoices?q=' + encodeURIComponent('24312000000123456789')).then(x => x.json());
      for (const row of iv.rows) await fetch('/api/delete/invoices/' + row.id, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"cascade":true}' });
      return a.total + '/' + iv.total;
    })()`);
    console.log(`  （已清理历史附件/残留发票 ${pre}）`);

    await send('Page.navigate', { url: BASE + '/#/attachments' });
    await waitFor(`document.querySelectorAll('#view .kpi').length >= 4`, 12000, '附件库页面渲染');
    check('附件库页面渲染', true);
    check('侧栏出现「附件与识别」入口', await evaluate(`!!document.querySelector('#nav [data-href="#/attachments"]')`));
    check('上传区提示文案存在', (await evaluate(`document.querySelector('#view [data-list]')?.innerText`)).length > 0);

    // ================= 2. 上传发票 PDF 并自动识别 =================
    console.log('\n[2] 上传发票 PDF，自动识别');
    await setFileInput('#view input[data-file]', INVOICE);
    await waitFor(`document.querySelector('#view [data-list] .attach-item') !== null`, 20000, '附件出现在列表');
    check('文件已上传并出现在附件库', true);
    await waitFor(`document.querySelector('#view [data-list]').innerText.includes('已识别')`, 40000, 'OCR 完成');
    const libText = await evaluate(`document.querySelector('#view [data-list]').innerText`);
    check('识别状态变为「已识别」', /已识别/.test(libText));
    check('列表标出文件类型为发票', /发票/.test(libText), libText.split('\n').filter(Boolean).slice(0, 3).join(' | '));

    // ================= 3. 查看识别结果 =================
    console.log('\n[3] 打开识别结果查看器');
    await evaluate(`document.querySelector('#view [data-list] [data-act="view-att"]').click()`);
    await waitFor(`!!document.querySelector('.viewer-preview')`, 8000, '查看器打开');
    check('查看器打开并渲染预览', true);
    await waitFor(`document.querySelector('.viewer-side [data-act="fill-new"]') !== null`, 15000, '识别面板渲染');
    const panel = await evaluate(`document.querySelector('.viewer-side').innerText`);
    check('没开表单时提供「新建发票并填入」', /新建发票并填入/.test(panel));
    check('识别出 20 位发票号码', /24312000000123456789/.test(panel), '发票号码命中');
    check('识别出价税合计 327,000.00', /327,000\.00/.test(panel));
    check('识别出购买方「市第一人民医院」', /市第一人民医院/.test(panel));
    check('给出自动关联建议', /自动建议/.test(panel), (panel.match(/💡[^\n]*/) || [''])[0].slice(0, 90));
    check('显示置信度', /置信度\s*100%/.test(panel));
    check('提示需人工核对金额', /务必与原件核对/.test(panel));
    // 原文查看
    await evaluate(`document.querySelector('.viewer-side [data-act="toggle-raw"]').click()`);
    check('可展开识别原文', await evaluate(`document.querySelector('.ocr-raw')?.style.display === 'block'`));
    await evaluate(`document.querySelector('[data-act="v-close"]').click()`);
    await sleep(300);
    check('查看器可关闭', await evaluate(`!document.querySelector('.viewer-preview')`));

    // ================= 3b. 识别出系统里没有的单位/项目 → 提示一键新建 =================
    console.log('\n[3b] 识别出新单位/新项目，主动提示一键新建');
    await send('Page.navigate', { url: BASE + '/#/attachments' });
    await waitFor(`!!document.querySelector('#view input[data-file]')`, 12000, '附件库');
    await setFileInput('#view input[data-file]', NEWCON);
    await waitFor(`!!document.querySelector('[data-act="cm-yes"]')`, 60000, '「是否新建」提示弹窗');
    const dlgText = await evaluate(`document.querySelector('[data-act="cm-yes"]').closest('.modal').innerText`);
    check('识别到系统里没有的记录时会主动提示', /发现系统里还没有的记录/.test(dlgText));
    check('提示里列出了甲方单位', /星海科技园发展有限公司/.test(dlgText));
    check('提示里列出了乙方单位', /新锐机电安装工程有限公司/.test(dlgText));
    check('提示里列出了项目名称', /星海科技园智能化弱电工程/.test(dlgText));
    const boxes = await evaluate(`[...document.querySelectorAll('[data-act="cm-yes"]')].length && (() => {
      const list = [...document.querySelectorAll('.dlg-item')];
      return list.map(l => ({ text: l.innerText.split('\\n')[0], checked: l.querySelector('input').checked }));
    })()`);
    check('甲方与项目默认勾选', boxes.some(b => /星海科技园发展有限公司/.test(b.text) && b.checked) &&
      boxes.some(b => /星海科技园智能化弱电工程/.test(b.text) && b.checked),
      boxes.map(b => b.text + (b.checked ? '✓' : '✗')).join(' / '));
    check('乙方（可能是贵司自己）默认不勾选', boxes.some(b => /新锐机电安装工程有限公司/.test(b.text) && !b.checked));

    await evaluate(`document.querySelector('[data-act="cm-yes"]').click()`);
    await waitFor(`!document.querySelector('[data-act="cm-yes"]')`, 12000, '弹窗关闭');
    await sleep(1800);
    const created = await evaluate(`(async () => ({
      p1: (await fetch('/api/list/partners?q=' + encodeURIComponent('星海科技园发展有限公司')).then(r => r.json())).total,
      p2: (await fetch('/api/list/partners?q=' + encodeURIComponent('新锐机电安装工程有限公司')).then(r => r.json())).total,
      proj: (await fetch('/api/list/projects?q=' + encodeURIComponent('星海科技园智能化弱电工程')).then(r => r.json())).total,
    }))()`);
    check('甲方单位已自动新建', created.p1 === 1);
    check('未勾选的乙方没有被新建', created.p2 === 0);
    check('项目已自动新建', created.proj === 1);

    await evaluate(`document.querySelector('#view [data-list] [data-act="view-att"]').click()`);
    await waitFor(`!!document.querySelector('.viewer-side')`, 10000, '查看器打开');
    await waitFor(`document.querySelector('.viewer-side').innerText.includes('已匹配')`, 12000, '重新匹配生效');
    const sideTxt = await evaluate(`document.querySelector('.viewer-side').innerText`);
    check('新建后自动重新匹配为「已匹配」', /已匹配/.test(sideTxt));
    check('未开表单时提供「新建合同并填入」', /新建合同并填入/.test(sideTxt));

    await evaluate(`document.querySelector('.viewer-side [data-act="fill-new"]').click()`);
    await waitFor(`!!document.querySelector('#modal-root [data-field="code"]')`, 12000, '合同表单自动打开');
    await sleep(800);
    const autoForm = await evaluate(`(() => {
      const m = document.querySelector('#modal-root .mask');
      const g = n => { const e = m.querySelector('[data-field="' + n + '"]'); if (!e) return null;
        return e.tagName === 'SELECT' ? e.selectedOptions[0].textContent : e.value; };
      return { code: g('code'), amount: g('amount'), project: g('project_id'),
               partner: g('partner_id'), direction: (() => { const e = m.querySelector('[data-field="direction"]'); return e ? e.value : null; })(),
               directionText: g('direction') };
    })()`);
    check('「新建并填入」自动带入合同编号', autoForm.code === 'FB-2026-077', autoForm.code);
    check('自动带入合同金额', String(autoForm.amount) === '1200000', autoForm.amount);
    check('自动选中刚新建的项目', /星海科技园智能化弱电工程/.test(autoForm.project || ''), autoForm.project);
    check('自动选中刚新建的甲方单位', /星海科技园发展有限公司/.test(autoForm.partner || ''), autoForm.partner);
    check('自动判断收支方向为收入', autoForm.direction === 'in', autoForm.direction + ' / ' + autoForm.directionText);
    await evaluate(`document.querySelector('#modal-root [data-act="close-modal"]').click()`);
    await sleep(500);

    // ================= 4. 合同表单里上传扫描件并一键填表 =================
    console.log('\n[4] 在「新增合同」表单里上传扫描件 → 全部填入');
    await send('Page.navigate', { url: BASE + '/#/t/contracts' });
    await waitFor(`document.querySelector('#view [data-act="add"][data-table="contracts"]') !== null`, 12000, '合同列表');
    await evaluate(`document.querySelector('#view [data-act="add"][data-table="contracts"]').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 1`, 6000, '合同表单弹出');
    check('表单底部出现附件区', await evaluate(`!!document.querySelector('#modal-root [data-attach]')`));

    await setFileInput('#modal-root input[type="file"]', SCAN);
    await waitFor(`document.querySelector('#modal-root [data-attach-list] .attach-item') !== null`, 20000, '扫描件上传');
    check('扫描件已上传到表单', true);
    await waitFor(`document.querySelector('#modal-root [data-attach-panel] [data-act="fill-all"]') !== null`, 60000, '表单内识别完成');
    check('表单内完成识别并展示结果', true);
    const formPanel = await evaluate(`document.querySelector('#modal-root [data-attach-panel]').innerText`);
    check('识别出合同编号 HT-2026-088', /HT-2026-088/.test(formPanel));
    check('识别出合同金额 5,860,000.00', /5,860,000\.00/.test(formPanel));

    await evaluate(`document.querySelector('#modal-root [data-attach-panel] [data-act="fill-all"]').click()`);
    await sleep(500);
    const filled = await evaluate(`(() => {
      const m = document.querySelector('#modal-root .mask');
      const g = n => { const e = m.querySelector('[data-field="'+n+'"]'); return e ? e.value : null; };
      return { code: g('code'), name: g('name'), amount: g('amount'), sign: g('sign_date'),
               start: g('start_date'), end: g('end_date'), terms: (g('payment_terms')||'').slice(0,20),
               direction: g('direction'), project: m.querySelector('[data-field="project_id"]').selectedOptions[0].textContent };
    })()`);
    check('合同编号已填入', filled.code === 'HT-2026-088', filled.code);
    check('合同金额已填入', String(filled.amount) === '5860000', filled.amount);
    check('签订/开工/竣工日期已填入', filled.sign === '2026-03-05' && filled.start === '2026-03-10' && filled.end === '2026-12-31',
      `${filled.sign} / ${filled.start} / ${filled.end}`);
    check('自动关联到已有项目', /市第一人民医院新院区/.test(filled.project), filled.project);
    check('合同名称已填入', !!filled.name, String(filled.name).slice(0, 30));

    // ================= 5. 保存并验证附件自动挂到新记录 =================
    console.log('\n[5] 保存合同，验证附件自动关联');
    const cname = filled.name + '（附件测试）';
    await evaluate(`(() => { const m=document.querySelector('#modal-root .mask');
      const e=m.querySelector('[data-field="name"]'); e.value=${JSON.stringify(cname)}; e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
    await evaluate(`document.querySelector('#modal-root [data-act="save-form"]:not([data-continue])').click()`);
    await waitFor(`document.querySelectorAll('#modal-root .mask').length === 0`, 12000, '表单关闭');
    await waitFor(`document.body.innerText.includes(${JSON.stringify(cname)})`, 10000, '合同出现在列表');
    check('合同保存成功', true);

    const saved = await evaluate(`(async () => {
      const r = await fetch('/api/list/contracts?q=' + encodeURIComponent('附件测试')).then(x => x.json());
      if (!r.rows.length) return null;
      const c = r.rows[0];
      const a = await fetch('/api/attachments?table_name=contracts&record_id=' + c.id).then(x => x.json());
      return { id: c.id, code: c.code, amount: c.amount, attachments: a.total, names: a.rows.map(x => x.original_name) };
    })()`);
    check('合同落库且字段正确', saved && saved.code === 'HT-2026-088' && saved.amount === 5860000,
      saved ? `#${saved.id} ${saved.code} ¥${saved.amount}` : '未找到');
    check('上传的扫描件已自动挂到该合同', saved && saved.attachments === 1, saved ? saved.names.join(', ') : '');

    // 右上角计数
    await send('Page.navigate', { url: BASE + '/#/dashboard' });
    await waitFor(`document.querySelectorAll('#view .ds-kpi').length === 4`, 12000, '总览页');
    const navCnt = await evaluate(`document.querySelector('#nav [data-href="#/attachments"] .cnt')?.textContent`);
    check('侧栏附件计数已更新', Number(navCnt) >= 2, '附件 ' + navCnt + ' 个');

    // ================= 6. 数据安全：备份接口 =================
    console.log('\n[6] 数据备份与状态接口');
    const st = await evaluate(`fetch('/api/dbstatus').then(r=>r.json())`);
    check('数据库状态接口可用', !!st.counts && st.walMode === 'wal', `journal=${st.walMode} sync=${st.synchronous}`);
    check('写入模式为同步落盘', String(st.synchronous) === '2', 'synchronous=' + st.synchronous);
    const bkRes = await evaluate(`fetch('/api/backup',{method:'POST'}).then(r=>r.json())`);
    check('一键备份成功', bkRes.ok === true, bkRes.file + ' ' + (bkRes.size / 1024).toFixed(1) + 'KB');

    // ================= 7. 清理 =================
    console.log('\n[7] 清理测试数据');
    const cleanup = await evaluate(`(async () => {
      const post = (u,b) => fetch(u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}).then(r=>r.json());
      const c = await fetch('/api/list/contracts?q=' + encodeURIComponent('附件测试')).then(x=>x.json());
      for (const row of c.rows) await post('/api/delete/contracts/'+row.id, {cascade:true});
      // 由测试素材识别出来的发票（号码取自样本，绝不会和真实数据重号）
      const iv = await fetch('/api/list/invoices?q=' + encodeURIComponent('24312000000123456789')).then(x=>x.json());
      for (const row of iv.rows) await post('/api/delete/invoices/'+row.id, {cascade:true});
      const np = await fetch('/api/list/projects?q=' + encodeURIComponent('星海科技园')).then(x=>x.json());
      for (const row of np.rows) await post('/api/delete/projects/'+row.id, {cascade:true});
      for (const kw of ['星海科技园发展有限公司','新锐机电安装工程有限公司','杭州智联弱电工程有限公司','界面测试供应商']) {
        const ps = await fetch('/api/list/partners?q=' + encodeURIComponent(kw)).then(x=>x.json());
        for (const row of ps.rows) await post('/api/delete/partners/'+row.id, {cascade:true});
      }
      const a = await fetch('/api/attachments').then(x=>x.json());
      for (const row of a.rows) await post('/api/attachments/'+row.id+'/delete', {});
      const d = await fetch('/api/dashboard').then(x=>x.json());
      const left = await fetch('/api/attachments').then(x=>x.json());
      const extra = await fetch('/api/list/projects?q=' + encodeURIComponent('星海科技园')).then(x=>x.json());
      return d.totals.project_count + '/' + d.totals.contract_count + '/' + d.totals.contract_in + '/att=' + left.total + '/extra=' + extra.total;
    })()`);
    check('测试数据已清理干净', cleanup === '3/8/10460000/att=0/extra=0', '项目/合同/收入/附件/残留 = ' + cleanup);

    // ================= 8. 运行时错误 =================
    console.log('\n[8] 前端运行时错误检查');
    const errs = JSON.parse(await evaluate('JSON.stringify(window.__errs || [])'));
    check('全过程无 JS 报错', errs.length === 0, errs.length ? errs.slice(0, 3).join(' | ') : '0 条');

    ws.close();
  } finally {
    try { child.kill(); } catch { /* 忽略 */ }
    await sleep(400);
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(60));
  console.log(`  附件与识别测试：${results.length - failed.length} / ${results.length} 项通过`);
  if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name + (f.extra ? ' (' + f.extra + ')' : '')).join('\n'));
  console.log('='.repeat(60));
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error('\n[测试异常]', e.message); process.exit(1); });
