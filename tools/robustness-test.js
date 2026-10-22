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
  console.log('\n [6] 折腾完这一圈，服务还好好的吗');
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
