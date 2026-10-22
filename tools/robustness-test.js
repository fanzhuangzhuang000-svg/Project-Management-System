'use strict';
/**
 * 接口健壮性（第二十套）
 *
 * 用法： node tools/robustness-test.js [http://127.0.0.1:8792]
 *
 * 这一套压的不是业务对不对，而是「输入不是人填的时候，系统怎么反应」：
 *   · 请求体是 JSON 但不是对象（null / "abc" / 123）—— 合法 JSON，不是请求体
 *   · 请求体是坏 JSON、是空、是 6 MB
 *   · 路径里的 ID 是 abc / -1 / 1e309 / 超大整数 / ../../etc/passwd
 *   · 查询串里 limit=abc、page=-1
 *
 * 判据只有三条，但都很硬：
 *   ① 任何情况下都不能 500（500 = 后端抛了没兜住的异常）
 *   ② 报错必须是 JSON + 中文原因，不能是把内部异常原文弹给用户
 *      （以前 body=null 时返回的就是 `Cannot read properties of null (reading 'token')`）
 *   ③ 请求超限必须回 413 并把原因写清，不能直接掐断连接
 *      （以前 readBody 超限时 req.destroy()，客户端拿到的是 ECONNRESET，
 *        界面上显示「网络错误，请重试」—— 用户会反复重试同一个大文件）
 *
 * 注意：破坏性接口（清示例数据、清日志、清回收站、备份）只喂**必然被拒**的输入，
 * 不喂 `{}` —— 修好 null 兜底之后 `{}` 会真的执行，那会把同时跑的其他套件数据清掉。
 */
// 命令行给的地址必须优先于 tools/test-base.js 的默认值 ——
// 否则会出现"请求打到 argv 指的地址、登录却打到 8792"的分裂，
// 症状是「连不上测试服务」，看起来像套件写错了。
if (process.argv[2]) process.env.PMS_BASE = process.argv[2];
const T = require('./test-auth.js');
const BASE = T.BASE;

const results = [];
let skipped = 0;
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${!ok && extra ? '  — ' + extra : ''}`);
}

const HEAD = () => ({ 'Content-Type': 'application/json', Cookie: T.cookieHeader() });

/** 发一个请求，永不抛（连接被重置也要拿到一个结果） */
async function hit (method, path, body, raw = false) {
  const init = { method, headers: HEAD() };
  if (body !== undefined) init.body = raw ? body : JSON.stringify(body);
  try {
    const r = await fetch(BASE + path, init);
    let text = '';
    try { text = await r.text(); } catch { /* 略 */ }
    return { status: r.status, text };
  } catch (e) {
    return { status: -1, text: '', err: e.message };
  }
}

const TABLES = ['projects', 'contracts', 'payments', 'invoices', 'expenses', 'materials', 'partners', 'plans', 'maintenance'];
const BAD_IDS = ['abc', '-1', '0', '1e309', 'null', 'NaN', '../../etc/passwd', '1 OR 1=1', '9007199254740993'];
// 合法 JSON，但解析出来不是对象 —— 这正是以前 9 个接口 500 的输入
const NON_OBJECT_BODIES = ['null', '"abc"', '123', 'true'];
// 这些接口哪怕收到 `{}` 也不会毁数据
const SAFE_POSTS = [
  '/api/save/projects', '/api/batch-delete', '/api/import/commit',
  '/api/ai/chat', '/api/ai/apply', '/api/ai/ingest', '/api/ai/config', '/api/ai/test',
  '/api/settings', '/api/users/unlock', '/api/snapshots/capture',
  '/api/contract/projects/plan', '/api/invoices/backfill', '/api/search',
];
// 这些会因为 `{}` 真的执行，只能喂必然被拒的输入
const DESTRUCTIVE_POSTS = ['/api/demo/clear', '/api/demo/seed', '/api/trash/purge-all', '/api/logs/purge', '/api/backup'];

// 英文 JS 运行时错误 / 内部实现细节：出现在响应里就说明内部异常没被兜住
const LEAK_MARKS = [
  'Cannot read propert', 'Cannot set propert', 'is not a function', 'is not iterable',
  'undefined is not', 'node:internal', 'SQLITE_', 'at Object.', 'at async ',
];
const leaks = (text) => LEAK_MARKS.some(m => text.includes(m))
  || /["':(]\s?[A-Za-z]:[\\/]/.test(text);   // 响应里出现 C:\ 这种本机路径

(async () => {
  // prepareAuth 会建好测试管理员、登录、注入 Cookie，并确保示例数据在
  // —— 最后一条正是 [5] 里「示例数据还在」那条断言的前提。
  await T.prepareAuth();

  // ───────────────────────────────────────────────
  console.log('\n [1] 请求体是「合法 JSON 但不是对象」时不能 500');
  // ───────────────────────────────────────────────
  // JSON.parse('null') === null，下游一句 body.token 就是 TypeError。
  // 以前 /api/save/projects、batch-delete、ai.apply、ai.ingest、settings、
  // users/unlock、logs/purge、snapshots/capture、contract.plan 全部 500。
  {
    // ⚠️ 这里必须传**字符串**（原样发出去），不能传 JS 的 null：
    //    fetch 的 body=null 等于"不带请求体"，那走的是另一条路径（空体 → {}），
    //    测不到"JSON.parse 出来是 null"这个真正的坑。
    const bad = [];
    for (const p of SAFE_POSTS) {
      for (const b of NON_OBJECT_BODIES) {
        const r = await hit('POST', p, b, true);
        if (r.status >= 500 || r.status === -1) bad.push(`${p} body=${b} → ${r.status || r.err}`);
        else if (leaks(r.text)) bad.push(`${p} body=${b} → 内部异常外泄`);
      }
    }
    check(`${SAFE_POSTS.length} 个接口 × ${NON_OBJECT_BODIES.length} 种非对象请求体，没有一个 500`,
      bad.length === 0, bad.slice(0, 3).join('；'));

    const okMsg = await hit('POST', '/api/ai/apply', 'null', true);
    check('非对象请求体返回的是中文提示，不是英文异常原文',
      okMsg.status === 400 && /方案|缺少|格式/.test(okMsg.text), `${okMsg.status} ${okMsg.text.slice(0, 80)}`);
  }

  // ───────────────────────────────────────────────
  console.log('\n [2] 坏 JSON / 空体：400，且不崩');
  // ───────────────────────────────────────────────
  {
    const bad = [];
    for (const p of [...SAFE_POSTS, ...DESTRUCTIVE_POSTS]) {
      const r = await hit('POST', p, '{bad json', true);
      if (r.status >= 500 || r.status === -1) bad.push(`${p} → ${r.status || r.err}`);
    }
    check('坏 JSON 一律 4xx（不 500、不断连接）', bad.length === 0, bad.slice(0, 3).join('；'));

    // 空体：有些接口本来就允许（比如 /api/logout），所以只要求"不是 5xx"
    const empty = await hit('POST', '/api/save/projects', '', true);
    check('空请求体走 400 而不是 500', empty.status === 400, `${empty.status} ${empty.text.slice(0, 60)}`);
  }

  // ───────────────────────────────────────────────
  console.log('\n [3] 路径里的 ID 被污染时不能 500');
  // ───────────────────────────────────────────────
  {
    const bad = [];
    for (const t of TABLES) {
      for (const id of BAD_IDS) {
        const enc = encodeURIComponent(id);
        const cases = [
          ['GET', `/api/get/${t}/${enc}`],
          ['GET', `/api/list/${t}?q=${enc}&limit=${enc}&page=${enc}`],
          ['GET', `/api/export/${t}?ids=${enc}`],
          ['GET', `/api/record-attachments/${t}/${enc}`],
          ['GET', `/api/statement/${t}?id=${enc}`],
          ['POST', `/api/delete/${t}/${enc}`],
        ];
        for (const [m, p] of cases) {
          const r = await hit(m, p, m === 'POST' ? {} : undefined);
          if (r.status >= 500 || r.status === -1) bad.push(`${m} ${p} → ${r.status || r.err}`);
          else if (leaks(r.text)) bad.push(`${m} ${p} → 内部异常外泄`);
        }
      }
    }
    check(`${TABLES.length} 张表 × ${BAD_IDS.length} 种脏 ID × 6 个接口，没有一个 500`,
      bad.length === 0, bad.slice(0, 3).join('；'));
  }

  // ───────────────────────────────────────────────
  console.log('\n [4] 请求体超限：413 + 说清原因（不能掐连接）');
  // ───────────────────────────────────────────────
  {
    // 4 MB 上限 + 一点点。用 JSON 体而不是文件上传，避免在测试机上写 6 MB 临时文件
    const bigBody = '{"x":"' + 'a'.repeat(5 * 1024 * 1024) + '"}';
    const r = await hit('POST', '/api/save/projects', bigBody, true);
    check('5 MB 的 JSON 体返回 413，而不是连接被重置',
      r.status === 413, r.status === -1 ? '连接被重置：' + r.err : 'HTTP ' + r.status);
    check('413 的响应体里写清了上限', /上限|过大/.test(r.text) && /MB/.test(r.text), r.text.slice(0, 80));
  }

  // ───────────────────────────────────────────────
  console.log('\n [5] 超大编号：不能写进库，更不能把日志接口搞挂');
  // ───────────────────────────────────────────────
  // 真实故障（本套件自己的脏 ID 用例挖出来的）：
  //   POST /api/delete/projects/9007199254740993
  //   → parseInt 舍入成 9007199254740992 写进 logs.record_id
  //   → node:sqlite 读回时抛 "Value is too large to be represented as a
  //     JavaScript number"
  //   → /api/logs 与首页系统通知**永久 500**，重启也不好（脏数据在库里）。
  //   任何一个登录用户一次请求就能做到。
  {
    const parse = (r) => { try { return JSON.parse(r.text) } catch { return {} } };
    const trashBefore = (parse(await hit('GET', '/api/trash')).rows || []).length;

    const big = await hit('POST', '/api/delete/projects/9007199254740993', {});
    check('超大编号被拒（不是 200）', big.status === 400 || big.status === 404, `HTTP ${big.status} ${big.text.slice(0, 80)}`);

    const logs = await hit('GET', '/api/logs');
    check('之后的日志接口仍然正常（没有把超范围整数写进 record_id）',
      logs.status === 200, `HTTP ${logs.status} ${logs.text.slice(0, 100)}`);

    const trashAfter = (parse(await hit('GET', '/api/trash')).rows || []).length;
    check('回收站没有多出一条点开什么都没有的空条目', trashAfter === trashBefore, `${trashBefore} → ${trashAfter}`);

    const ghost = await hit('POST', '/api/delete/projects/999999', {});
    check('删不存在的记录回 404，而不是"假成功"', ghost.status === 404, `HTTP ${ghost.status} ${ghost.text.slice(0, 60)}`);

    const neg = await hit('POST', '/api/delete/projects/-5', {});
    check('负数编号被拒', neg.status === 400 || neg.status === 404, 'HTTP ' + neg.status);
  }

  // ───────────────────────────────────────────────
  console.log('\n [6] 上传文件名里的转义：既要解，又不能解坏');
  // ───────────────────────────────────────────────
  // 浏览器上传 a"b.pdf 时发的头是 filename="a%22b.pdf"（RFC 7578 要求把引号转义）。
  // 以前服务端直接取引号里的原文，于是系统里的「原始文件名」变成 a%22b.pdf，
  // 下载下来也是这个名字。
  // 反过来，「进度100%.pdf」里的 % 是合法字符，解码会失败 —— 那种情况必须保持原样，
  // 不能为了"解码"把用户的名字搞丢。
  {
    const upload = async (filename) => {
      const b = '----X' + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/pdf\r\n\r\n`),
        Buffer.from('%PDF-1.4 test'),
        Buffer.from(`\r\n--${b}--\r\n`),
      ]);
      const r = await fetch(BASE + '/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + b, Cookie: T.cookieHeader() },
        body,
      });
      const j = await r.json().catch(() => ({}));
      const att = j.attachment || {};
      if (att.id) {
        await fetch(BASE + '/api/attachments/' + att.id + '/delete',
          { method: 'POST', headers: HEAD(), body: '{}' }).catch(() => { });
      }
      return { status: r.status, name: att.original_name, error: j.error };
    };

    const quoted = await upload('a%22b.pdf');
    check('百分号转义的文件名被还原（a%22b.pdf → a"b.pdf，显示时变成 a_b.pdf）',
      quoted.status === 200 && quoted.name && !quoted.name.includes('%22'),
      `${quoted.status} ${quoted.name || quoted.error}`);

    const percent = await upload('进度100%.pdf');
    check('名字里本来就有 % 的文件不会被解坏', percent.status === 200 && percent.name === '进度100%.pdf',
      `${percent.status} ${percent.name || percent.error}`);

    const spaces = await upload('%E5%90%88%E5%90%8C%20%E7%94%B2.pdf');
    check('整段百分号编码的中文名能正确还原', spaces.status === 200 && spaces.name === '合同 甲.pdf',
      `${spaces.status} ${spaces.name || spaces.error}`);
  }

  // ───────────────────────────────────────────────
  console.log('\n [7] 数值极值：不让 Infinity / NaN 混进库');
  // ───────────────────────────────────────────────
  // 1e308 是**合法 JSON 数字**，JSON.parse 出来也是有限数，所以任何
  // `Number.isFinite` 的输入检查都拦不住它 —— 真正溢出的是后面这一步：
  //   round2(1e308) = Math.round(1e308 * 100) / 100 = Infinity
  // 以前这些数照样入库：
  //   · 发票金额 1e308 → 价税合计算成 Infinity → node:sqlite 存成 NULL
  //   · 材料 1e200 × 1e200 → 金额 0
  //   · 看板 SUM 溢出 → JSON.stringify(Infinity) = null → 界面显示「—」
  // 现在保存时就按上限拒掉，并说清楚上限是多少。
  {
    const parse = (r) => { try { return JSON.parse(r.text) } catch { return {} } };
    const proj = ((parse(await hit('GET', '/api/list/projects?limit=1')).rows) || [])[0] || {};
    const pid = proj.id;
    const today = new Date().toLocaleDateString('sv-SE');
    // 注意：这些记录名都带 EXTREME- 前缀，修好之前（旧代码）会被真的写进去，
    // 所以下面无论成败都要清一遍，不能把共享测试库灌成垃圾场。
    const CASES = [
      ['发票金额 1e308', 'invoices', { project_id: pid, direction: 'out', issue_date: today, amount: 1e308, tax_rate: 9 }],
      ['材料 1e200 × 1e200', 'materials', { project_id: pid, name: 'EXTREME-材料', quantity: 1e200, unit_price: 1e200 }],
      ['合同金额 1e308', 'contracts', { name: 'EXTREME-合同', project_id: pid, amount: 1e308, tax_rate: 9, category: '项目合同', direction: 'in' }],
      ['项目进度 1e308', 'projects', { name: 'EXTREME-项目', status: '进行中', progress: 1e308 }],
      ['项目进度 300%', 'projects', { name: 'EXTREME-进度', status: '进行中', progress: 300 }],
    ];
    const bad = [];
    for (const [label, t, body] of CASES) {
      const r = await hit('POST', '/api/save/' + t, body);
      const msg = parse(r).error || '';
      if (r.status !== 400) bad.push(`${label} → HTTP ${r.status}`);
      else if (!/超出范围|应在 0 到 100/.test(msg)) bad.push(`${label} → 报错看不懂：${msg.slice(0, 40)}`);
      else if (leaks(r.text)) bad.push(`${label} → 内部异常外泄`);
    }
    check(`${CASES.length} 种超范围数值一律 400，并说清上限`, bad.length === 0, bad.slice(0, 3).join('；'));

    const d = parse(await hit('GET', '/api/dashboard'));
    const nonNum = Object.entries(d.totals || {})
      .filter(([, v]) => v === null || (typeof v === 'number' && !Number.isFinite(v)))
      .map(([k]) => k);
    check('看板每一项都还是数字（`SUM` 溢出会让整块变成 null）', nonNum.length === 0, nonNum.join('、'));

    // 清理：旧代码下这些东西是真的建出来了
    for (const t of ['invoices', 'materials', 'contracts', 'projects']) {
      const rows = (parse(await hit('GET', `/api/list/${t}?q=EXTREME-`)).rows) || [];
      for (const row of rows) await hit('POST', `/api/delete/${t}/${row.id}`, { cascade: true, keepAttachments: false });
    }
  }

  // ───────────────────────────────────────────────
  console.log('\n [8] 日期：认不出来的不能入库，能认的要归一');
  // ───────────────────────────────────────────────
  // 逾期判断是字符串比较（due_date < today），所以：
  //   'abc'        → 'a' > '2'，永远不逾期
  //   '2026/10/01' → '/' > '-'，永远不逾期
  //   '2026-13-45' → 月份 13 也能存，月度统计 substr(0,7) 得到 '2026-13'
  // 以前这三种都能存进去，代价是那一笔款从催款清单上消失，界面上还看不出毛病。
  {
    const parse = (r) => { try { return JSON.parse(r.text) } catch { return {} } };
    const proj = ((parse(await hit('GET', '/api/list/projects?limit=1')).rows) || [])[0] || {};
    const base = { project_id: proj.id, direction: 'in', phase: '进度款', amount: 1000 };

    const badDates = [];
    for (const d of ['abc', '2026-13-45', '2026-02-30', '下周一']) {
      const r = await hit('POST', '/api/save/schedules', { ...base, due_date: d });
      const msg = parse(r).error || '';
      if (r.status !== 400) badDates.push(`${d} → HTTP ${r.status}`);
      else if (!/日期/.test(msg)) badDates.push(`${d} → 报错没提日期：${msg.slice(0, 30)}`);
    }
    check('认不出来的日期被拒（"abc"、13 月、2 月 30 号）', badDates.length === 0, badDates.join('；'));

    const slash = await hit('POST', '/api/save/schedules', { ...base, due_date: '2026/10/01' });
    const slashRow = parse(slash).row || {};
    check('2026/10/01 这种写法被归一成 2026-10-01', slash.status === 200 && slashRow.due_date === '2026-10-01',
      `${slash.status} ${slashRow.due_date || parse(slash).error}`);
    if (slashRow.id) await hit('POST', `/api/delete/schedules/${slashRow.id}`, { keepAttachments: false });

    const compact = await hit('POST', '/api/save/schedules', { ...base, due_date: '20261001' });
    const compactRow = parse(compact).row || {};
    check('20261001 也能认（粘贴 Excel 里常见）', compact.status === 200 && compactRow.due_date === '2026-10-01',
      `${compact.status} ${compactRow.due_date || parse(compact).error}`);
    if (compactRow.id) await hit('POST', `/api/delete/schedules/${compactRow.id}`, { keepAttachments: false });
  }

  // ───────────────────────────────────────────────
  console.log('\n [9] 折腾完这一圈，服务还好好的吗');
  // ───────────────────────────────────────────────
  {
    const h = await hit('GET', '/api/health');
    check('服务仍在应答', h.status === 200);

    const d = await hit('GET', '/api/dashboard');
    const dash = (() => { try { return JSON.parse(d.text) } catch { return {} } })();
    check('业务数据还能正常读（库没被搞坏）', d.status === 200 && !!dash.totals, `HTTP ${d.status}`);
    check('示例数据还在（没被破坏性用例清掉）',
      dash.totals && Number(dash.totals.project_count) > 0, '项目数 ' + (dash.totals && dash.totals.project_count));

    // 登录态没被糊掉
    const me = await hit('GET', '/api/me');
    check('会话仍然有效', me.status === 200);
  }

  const bad = results.filter(r => !r.ok);
  console.log(`\n${results.length - bad.length} / ${results.length} 项通过${skipped ? `（另跳过 ${skipped} 条）` : ''}`);
  if (bad.length) {
    console.log('失败项：');
    for (const b of bad) console.log('  ✗ ' + b.name);
  }
  process.exit(bad.length ? 1 : 0);
})().catch(e => {
  console.log('  ✗ 测试过程抛异常：' + e.message);
  console.log(`\n0 / 1 项通过`);
  process.exit(1);
});
