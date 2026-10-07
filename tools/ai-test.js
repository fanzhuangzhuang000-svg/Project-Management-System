'use strict';
/**
 * AI 助手测试
 *
 * 不依赖真实 API 密钥：本地起一个「假的 OpenAI 兼容服务」，
 * 把 AI 配置指向它，就能完整验证 —— 配置、密钥脱敏、测试连接、
 * 流式对话、上下文注入、权限过滤、限速、错误提示。
 *
 * 用法： node tools/ai-test.js [http://127.0.0.1:8787]
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const T = require('./test-auth.js');

// 基址必须和 test-auth.js 一致：登录会话属于 T.BASE，
// 这里换成别的地址就会带着不属于它的 Cookie 打过去，表现为随机 401。
const BASE = process.argv[2] || T.BASE;
const MOCK_PORT = 18899;
const PUSH_PORT = 18895;
const pushReceived = [];

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

/* ==================== 假模型服务 ==================== */
let lastRequest = null;
let failMode = null;                       // 'auth' | 'model404' | 'server'
let toolCallPlan = null;                   // {name, args} 设了就进入工具调用模式
let toolRoundMessages = null;              // 第二轮收到的完整消息（含工具结果）
let toolFinalText = '查到 3 个逾期未收节点，合计 178.0 万元。';
let respondText = '收入合同额 1046.0 万元，**建议本周催收**。\n\n- 第一人民医院：146.5 万逾期 98 天\n- 云鼎广场：56.0 万逾期 238 天';

function startMock () {
  const srv = http.createServer((req, res) => {
    if (!req.url.includes('/chat/completions')) { res.writeHead(404).end('{}'); return }
    let body = '';
    req.on('data', c => { body += c });
    req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body) } catch { /* 忽略 */ }
      lastRequest = { headers: req.headers, body: parsed };

      // 校验密钥：只有 sk-test 开头的才认，这样能测出「密钥错」的分支
      const auth = String(req.headers.authorization || '');
      if (!/^Bearer sk-test/.test(auth)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid API key provided' } }));
      }

      if (failMode === 'auth') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
      }
      if (failMode === 'model404') {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'model not found' } }));
      }
      if (failMode === 'server') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'internal error' } }));
      }

      // 非流式（测试连接用）
      if (!parsed.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '正常' } }],
          usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
        }));
      }

      // ---- 工具调用模式 ----
      // 第一次（对话里还没有 tool 结果）先要一个工具；拿到结果后再给最终答案
      const hasToolResult = (parsed.messages || []).some(m => m.role === 'tool');
      if (toolCallPlan && !hasToolResult) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // 故意把 tool_call 拆成两片，验证分片累积逻辑
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_test_1', type: 'function', function: { name: toolCallPlan.name, arguments: '' } }] } }],
        }) + '\n\n');
        const args = JSON.stringify(toolCallPlan.args);
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, 6) } }] } }],
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(6) } }] } }],
        }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      if (toolCallPlan && hasToolResult) {
        toolRoundMessages = parsed.messages;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: toolFinalText } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {} }], usage: { total_tokens: 900 } }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }

      // 流式：把文本切成几段推出去
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const pieces = respondText.match(/[\s\S]{1,8}/g) || [];
      let i = 0;
      const tick = setInterval(() => {
        if (i >= pieces.length) {
          clearInterval(tick);
          res.write('data: ' + JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 500, completion_tokens: 80, total_tokens: 580 },
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: pieces[i++] } }] }) + '\n\n');
      }, 4);
    });
  });
  return new Promise(r => srv.listen(MOCK_PORT, '127.0.0.1', () => r(srv)));
}

/* ==================== 请求小工具 ==================== */
async function login (username, password) {
  const res = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const j = await res.json();
  const c = (res.headers.get('set-cookie') || '').match(/pms_session=([a-f0-9]+)/);
  if (!j.user) throw new Error(`登录失败 ${username}: ${JSON.stringify(j).slice(0, 80)}`);
  return { cookie: 'pms_session=' + (c ? c[1] : ''), user: j.user };
}

/** 读一次 SSE 流，返回 {text, deltas, statuses} */
async function sseChat (session, question) {
  const res = await fetch(BASE + '/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: session.cookie },
    body: JSON.stringify({ question, messages: [] }),
  });
  if (!res.ok || !res.headers.get('content-type')?.includes('event-stream')) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.error || msg } catch { /* 忽略 */ }
    return { error: msg, status: res.status };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '', text = '', deltas = 0, statuses = [], proposals = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const p = line.slice(5).trim(); if (!p) continue;
      let evt; try { evt = JSON.parse(p) } catch { continue }
      if (evt.type === 'delta') { text += evt.text; deltas++ }
      if (evt.type === 'status') statuses.push(evt.text);
      if (evt.type === 'proposal' && evt.prop) proposals.push(evt.prop);
      if (evt.type === 'error') return { error: evt.error, statuses, deltas };
    }
  }
  return { text, deltas, statuses, proposals };
}

/* ==================== 主流程 ==================== */
T.forceAdminPassword();

(async () => {
  const mock = await startMock();
  const cfgFile = path.join(__dirname, '..', 'data', 'ai-config.json');
  const backup = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile) : null;
  let limitedUser = null;

  try {
    const admin = await login(T.USER, T.PASS);
    // 确保示例数据在（用户清空示例后会自愈）。
    // ⚠️ 这里**不能**用 T.prepareAuth() —— 它会 installFetchCookie() 劫持全局 fetch，
    // 把管理员的 cookie 强加到所有请求上，导致本套件里「受限账号」的权限用例
    // 实际是以管理员身份在跑（曾经真的这么错过一次）。所以直接调 seed 接口。
    {
      const h = { Cookie: admin.cookie, 'Content-Type': 'application/json' };
      const demo = await fetch(BASE + '/api/list/projects?q=DEMO-', { headers: h }).then(r => r.json());
      if (!((demo.rows || []).some(r => String(r.code || '').startsWith('DEMO-')))) {
        const s = await fetch(BASE + '/api/demo/seed', { method: 'POST', headers: h }).then(r => r.json());
        console.log('  [准备] 检测到没有示例数据，已补写一份（不碰真实数据）');
      }
    }
    const H = { 'Content-Type': 'application/json', Cookie: admin.cookie };
    const get = (u, s = admin) => fetch(BASE + u, { headers: { Cookie: s.cookie } }).then(r => r.json());
    const post = (u, b, s = admin) => fetch(BASE + u, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: s.cookie },
      body: JSON.stringify(b || {}),
    }).then(async r => ({ status: r.status, ...(await r.json()) }));

    /* ---------- 1. 初始状态 ---------- */
    // 测试要自己建立前置条件，不能假设「之前没人配过」
    console.log('[1] 配置读取与密钥脱敏');
    await post('/api/ai/config', { enabled: false, includeContext: true, apiKey: null, provider: 'deepseek' });
    let cfg = await get('/api/ai');
    check('能读到 AI 配置', typeof cfg.enabled === 'boolean');
    check('带上了厂商清单', Array.isArray(cfg.providers) && cfg.providers.length >= 8,
      `${(cfg.providers || []).length} 个厂商`);
    check('带上了快捷提问', Array.isArray(cfg.quick) && cfg.quick.length > 0, `${(cfg.quick || []).length} 条`);
    check('重置后状态为未就绪', cfg.ready === false, `enabled=${cfg.enabled} hasKey=${cfg.hasKey}`);

    /* ---------- 2. 保存配置 ---------- */
    console.log('[2] 保存配置');
    const save = await post('/api/ai/config', {
      provider: 'custom', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
      model: 'mock-model', apiKey: 'sk-test-1234567890abcdef', enabled: true, includeContext: true,
    });
    check('保存成功', save.ok === true, `provider=${save.provider} model=${save.model}`);
    check('保存后即为就绪', save.ready === true);
    check('响应里不含密钥原文', JSON.stringify(save).indexOf('sk-test-1234567890abcdef') < 0);
    check('响应里只给掩码', /^sk-t•+cdef$/.test(save.keyHint || ''), save.keyHint);

    cfg = await get('/api/ai');
    check('再次读取仍不含密钥原文', JSON.stringify(cfg).indexOf('sk-test-1234567890abcdef') < 0);
    check('文件里确实存了密钥（只在服务端）',
      fs.existsSync(cfgFile) && fs.readFileSync(cfgFile, 'utf8').includes('sk-test-1234567890abcdef'));

    /* ---------- 3. 测试连接 ---------- */
    console.log('[3] 测试连接');
    const t1 = await post('/api/ai/test', {});
    check('连接测试通过', t1.ok === true, `${t1.ms}ms 模型回复「${t1.reply}」`);

    const t2 = await post('/api/ai/test', { apiKey: 'sk-wrong', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, model: 'mock-model' });
    check('错误密钥给出人话提示', t2.ok !== true && /密钥/.test(t2.error || ''), (t2.error || '').slice(0, 60));
    check('测试用的错误密钥没有覆盖已保存的密钥',
      fs.readFileSync(cfgFile, 'utf8').includes('sk-test-1234567890abcdef'));

    /* ---------- 4. 流式对话 ---------- */
    console.log('[4] 流式对话');
    respondText = '收入合同额 1046.0 万元，**建议本周催收**。\n\n- 第一人民医院：146.5 万逾期 98 天\n- 云鼎广场：56.0 万逾期 238 天';
    const chat = await sseChat(admin, '哪些项目回款有问题？');
    check('收到流式回复', !!chat.text, `${(chat.text || '').length} 字，分 ${chat.deltas} 段推送`);
    check('分多段推送（确认是真流式）', (chat.deltas || 0) > 3, `${chat.deltas} 段`);
    check('内容完整', chat.text === respondText);
    check('推了状态提示', (chat.statuses || []).length > 0, (chat.statuses || []).join(' / '));

    /* ---------- 5. 上下文注入（重点） ---------- */
    console.log('[5] 经营数据是否真的发给了模型');
    const sent = lastRequest.body;
    const sys = (sent.messages || []).find(m => m.role === 'system');
    check('带上了 system 提示词', !!sys);
    const sysText = sys ? sys.content : '';
    check('上下文里有真实项目名', sysText.includes('市第一人民医院新院区智能化弱电工程'));
    // 不写死具体金额：用户自己的项目会让合计变化，只验证「这份数据确实带过去了」
    check('上下文里有应收合计', /应收未收\s*[\d,]+(\.\d+)?/.test(sysText),
      (sysText.match(/应收未收[^\n]*/) || [''])[0].slice(0, 40));
    // 不要写死具体天数 —— 逾期天数每天都在变，写死的话过了零点测试就会挂。
    // 只验证「确实带上了逾期明细，并且带了天数」这个格式。
    check('上下文里有逾期明细和天数', /已逾期\s*\d+\s*天/.test(sysText),
      (sysText.match(/已逾期\s*\d+\s*天/) || [''])[0]);
    check('逾期明细带了项目和合同', /逾期未收节点/.test(sysText) && /合同：/.test(sysText));
    check('逾期收付分开标注', sysText.includes('逾期未收节点') && sysText.includes('逾期未付节点'));
    check('上下文里有账龄分段', sysText.includes('## 应收账龄'));
    check('上下文里有成本构成', sysText.includes('## 成本构成'));
    check('用户提问在最后一条', (sent.messages || []).slice(-1)[0].content === '哪些项目回款有问题？');
    check('请求带了模型名', sent.model === 'mock-model');
    check('请求带了鉴权头', /^Bearer sk-test/.test(String(lastRequest.headers.authorization || '')),
      String(lastRequest.headers.authorization || '(无)').slice(0, 20) + '…');
    check('请求了流式', sent.stream === true);
    console.log(`      上下文长度：${sysText.length} 字`);

    /* ---------- 6. 上下文按权限过滤 ---------- */
    console.log('[6] 权限过滤：看不到的模块不能发给模型');
    const uname = 'aitest_' + Math.random().toString(36).slice(2, 8);
    // 注意：/api/users 收的是扁平的 read / write / sys 数组，不是嵌套的 perms 对象
    const mk = await post('/api/users', {
      username: uname, name: 'AI 权限测试', password: 'Test@123456',
      role: 'custom', status: '启用',
      read: ['projects'], write: [], sys: [],
    });
    check('创建受限账号', mk.ok === true, `${uname}（只能看项目台账）`);
    if (mk.ok) limitedUser = mk.id;
    const limited = await login(uname, 'Test@123456');
    check('受限账号权限已生效',
      limited.user.perms.read.length === 1 && limited.user.perms.read[0] === 'projects',
      `read=[${limited.user.perms.read.join(',')}]`);

    lastRequest = null;                       // 清掉上一条，确保断言的是这次请求
    const lc = await sseChat(limited, '帮我分析一下');
    check('受限账号能正常提问', !!lc.text && !lc.error, lc.error || `${(lc.text || '').length} 字`);
    check('这次请求确实发到了模型', !!lastRequest);
    const lsys = ((lastRequest?.body?.messages || []).find(m => m.role === 'system') || {}).content || '';
    check('受限账号的上下文里有项目数据', lsys.includes('市第一人民医院新院区智能化弱电工程'),
      `${lsys.length} 字`);
    check('受限账号的上下文里没有发票勾稽数据',
      !lsys.includes('已开票未收') && !lsys.includes('已收款未开票') && !lsys.includes('已开票'),
      lsys.includes('已开票') ? '❌ 泄漏了发票数据' : '未泄漏');
    check('受限账号的上下文里没有成本构成',
      !lsys.includes('## 成本构成'), lsys.includes('## 成本构成') ? '❌ 泄漏了费用数据' : '未泄漏');

    /* ---------- 7. 错误提示 ---------- */
    console.log('[7] 各种错误要给人话');
    failMode = 'auth';
    const e1 = await sseChat(admin, '测试');
    check('密钥无效 → 提示重新填密钥', /密钥/.test(e1.error || ''), (e1.error || '').slice(0, 70));
    failMode = 'model404';
    const e2 = await sseChat(admin, '测试');
    check('模型/地址错误 → 有相应提示', /地址|模型/.test(e2.error || ''), (e2.error || '').slice(0, 70));
    failMode = 'server';
    const e3 = await sseChat(admin, '测试');
    check('对方故障 → 提示稍后再试', /故障|稍后|500/.test(e3.error || ''), (e3.error || '').slice(0, 70));
    failMode = null;

    /* ---------- 8. 权限控制 ---------- */
    console.log('[8] 配置修改权限');
    const forbid = await post('/api/ai/config', { model: 'x' }, limited);
    check('普通成员不能改 AI 配置', forbid.status === 403, `HTTP ${forbid.status}`);
    const cfgForLimited = await get('/api/ai', limited);
    check('普通成员看不到厂商清单', cfgForLimited.providers === undefined);
    check('普通成员能知道能不能用', cfgForLimited.ready === true);
    const testForbid = await post('/api/ai/test', {}, limited);
    check('普通成员不能测连接', testForbid.status === 403, `HTTP ${testForbid.status}`);

    /* ---------- 9. 未启用时要拦住 ---------- */
    console.log('[9] 未启用时不应发起调用');
    await post('/api/ai/config', { enabled: false });
    const off = await sseChat(admin, '测试');
    check('未启用时明确拒绝', !!off.error && /没配置好|没启用/.test(off.error), (off.error || '').slice(0, 60));
    await post('/api/ai/config', { enabled: true });

    /* ---------- 11. 导出 Word 报告 ---------- */
    console.log('[11] 导出 Word 报告');
    const zlib = require('node:zlib');
    const exp = await fetch(BASE + '/api/ai/export', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        title: '经营分析报告', question: '哪些项目回款有问题？',
        answer: '按目前的账，**回款问题集中**：\n\n1. 第一人民医院 170.9 万逾期 249 天\n2. 云鼎广场 159.0 万\n\n| 项目 | 应收 |\n|---|---|\n| 一院 | 170.9 万 |\n| 云鼎 | 159.0 万 |',
        includeData: true,
      }),
    });
    check('导出返回 200', exp.status === 200, `HTTP ${exp.status}`);
    check('返回的是 docx 类型',
      (exp.headers.get('content-type') || '').includes('wordprocessingml.document'),
      (exp.headers.get('content-type') || '').split(';')[0]);
    check('带下载文件名',
      /filename\*=UTF-8''/.test(exp.headers.get('content-disposition') || ''),
      decodeURIComponent((/(?:UTF-8'')"*([^";]+)/.exec(exp.headers.get('content-disposition') || '') || [])[1] || '').slice(0, 40));
    const dz = Buffer.from(await exp.arrayBuffer());
    check('是合法 ZIP 包', dz.slice(0, 4).toString('hex') === '504b0304', `${(dz.length / 1024).toFixed(1)} KB`);

    // 解开 zip 取 document.xml —— 光看签名不够，要确认内容真的写进去了
    function unzipEntry (buf, want) {
      let off = 0;
      while (off < buf.length - 4) {
        if (buf.readUInt32LE(off) !== 0x04034b50) { off++; continue }
        const method = buf.readUInt16LE(off + 8);
        const csize = buf.readUInt32LE(off + 18);
        const nlen = buf.readUInt16LE(off + 26);
        const elen = buf.readUInt16LE(off + 28);
        const name = buf.slice(off + 30, off + 30 + nlen).toString('utf8');
        const dataStart = off + 30 + nlen + elen;
        if (name === want) {
          const raw = buf.slice(dataStart, dataStart + csize);
          return method === 8 ? zlib.inflateRawSync(raw).toString('utf8') : raw.toString('utf8');
        }
        off = dataStart + csize;
      }
      return null;
    }
    const docXml = unzipEntry(dz, 'word/document.xml');
    check('能解出正文 XML', !!docXml, docXml ? `${docXml.length} 字符` : '找不到 word/document.xml');
    check('报告里含提问', !!docXml && docXml.includes('哪些项目回款有问题'));
    check('报告里含分析结论', !!docXml && docXml.includes('回款问题集中'));
    check('报告里含表格数据', !!docXml && docXml.includes('170.9'));
    check('报告带数据附录', !!docXml && docXml.includes('附录'));
    check('报告不含未转义的特殊字符', !!docXml && !/<w:t[^>]*>[^<]*[<>][^<]*<\/w:t>/.test(docXml));
    const headXml = unzipEntry(dz, '[Content_Types].xml');
    const stylesXml = unzipEntry(dz, 'word/styles.xml');
    check('包含 Word 必需的部件', !!headXml && !!stylesXml && !!unzipEntry(dz, '_rels/.rels'));
    check('表格带了必需的 tblGrid', !!docXml && docXml.includes('<w:tblGrid>'));

    const emptyExp = await fetch(BASE + '/api/ai/export', {
      method: 'POST', headers: H, body: JSON.stringify({ answer: '' }),
    });
    check('空内容拒绝导出', emptyExp.status === 400, `HTTP ${emptyExp.status}`);

    /* ---------- 12. 每日经营简报 ---------- */
    console.log('[12] 每日经营简报');
    respondText = '**【应收集中】** 应收 366.3 万，170.9 万逾期超 90 天。今天先发催款函。\n\n一句话判断：需要警惕。';
    // 先清掉当天缓存，确保这次是真生成
    const briefFile = path.join(__dirname, '..', 'data', 'briefings');
    if (fs.existsSync(briefFile)) fs.rmSync(briefFile, { recursive: true, force: true });
    const br1 = await get('/api/ai/briefing');
    check('能生成简报', br1.available === true && (br1.text || '').length > 10,
      `${(br1.text || '').length} 字，模型 ${br1.model}`);
    check('首次生成标记为非缓存', br1.cached === false);
    check('简报内容正确', (br1.text || '').includes('需要警惕'));
    const br2 = await get('/api/ai/briefing');
    check('当天第二次请求走缓存（不重复花钱）', br2.cached === true);
    check('缓存内容一致', br2.text === br1.text);
    const br3 = await get('/api/ai/briefing?refresh=1');
    check('可以强制重新生成', br3.cached === false);

    // 权限不同的账号，简报缓存要分开，不能串数据
    const brLimited = await get('/api/ai/briefing', limited);
    check('不同权限的简报分开缓存',
      brLimited.available === true && brLimited.day === br1.day,
      `受限账号也拿到了自己的简报（${(brLimited.text || '').length} 字）`);

    const briefFiles = fs.existsSync(briefFile) ? fs.readdirSync(briefFile) : [];
    check('简报按天+权限落盘', briefFiles.length >= 2, briefFiles.join(', '));

    /* ---------- 13. 工具调用（模型自己查明细） ---------- */
    console.log('[13] 工具调用');
    toolCallPlan = { name: 'list_schedules', args: { overdue_only: true, direction: 'in', limit: 5 } };
    toolRoundMessages = null;
    const tc = await sseChat(admin, '第一人民医院有哪些逾期未收的节点？');
    check('工具调用后仍能拿到最终答案', !!tc.text && !tc.error, tc.error || `${(tc.text || '').length} 字`);
    check('答案是模型基于工具结果给的', (tc.text || '').includes('178.0'));
    check('模型确实收到了工具结果', Array.isArray(toolRoundMessages) && toolRoundMessages.some(m => m.role === 'tool'));
    const toolMsg = (toolRoundMessages || []).find(m => m.role === 'tool');
    const toolPayload = toolMsg ? String(toolMsg.content) : '';
    check('工具结果里是真实数据', toolPayload.includes('逾期天数') && /市第一人民医院/.test(toolPayload),
      toolPayload.slice(0, 90).replace(/\s+/g, ' '));
    check('回传的 assistant 消息带 tool_calls',
      (toolRoundMessages || []).some(m => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length));
    check('请求里声明了工具集',
      Array.isArray(lastRequest.body.tools) && lastRequest.body.tools.length >= 8,
      `${(lastRequest.body.tools || []).length} 个工具`);
    check('工具名正确', (lastRequest.body.tools || []).some(t => t.function && t.function.name === 'list_schedules'));

    // 只给项目权限的账号：要合同数据应该被挡住
    toolCallPlan = { name: 'list_contracts', args: { limit: 3 } };
    toolRoundMessages = null;
    const tc2 = await sseChat(limited, '帮我查一下合同');
    const toolMsg2 = (toolRoundMessages || []).find(m => m.role === 'tool');
    check('无权限的工具被挡住', !!toolMsg2 && /没有.*权限/.test(String(toolMsg2.content)),
      String(toolMsg2 ? toolMsg2.content : '(没拿到工具结果)').slice(0, 64));
    check('被拦下时模型仍给出回答', !!tc2.text && !tc2.error, tc2.error || `${(tc2.text || '').length} 字`);
    toolCallPlan = null;

    /* ---------- 14. 简报推送 ---------- */
    console.log('[14] 简报推送');
    const pushSrv = http.createServer((req, res) => {
      let b = ''; req.on('data', c => { b += c });
      req.on('end', () => {
        pushReceived.push({ url: req.url, body: b });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"errcode":0,"errmsg":"ok"}');
      });
    });
    await new Promise(r => pushSrv.listen(PUSH_PORT, '127.0.0.1', r));
    try {
      const pcfg = await get('/api/ai/push');
      check('能读到推送配置', typeof pcfg.enabled === 'boolean' && Array.isArray(pcfg.channels));
      check('带上了推送方式清单', Array.isArray(pcfg.types) && pcfg.types.length >= 5,
        (pcfg.types || []).map(t => t.label).join('、'));

      const savedP = await post('/api/ai/push', {
        enabled: true, time: '23:59',
        channels: [{ type: 'wecom', url: `http://127.0.0.1:${PUSH_PORT}/wecom` }],
      });
      check('保存推送配置', savedP.ok === true, `${savedP.channels.length} 个渠道，每天 ${savedP.time}`);

      pushReceived.length = 0;
      const tr = await post('/api/ai/push/test', {});
      check('试推成功', tr.ok === true, (tr.results || []).map(x => `${x.label}:${x.ok ? '成功' : '失败'}`).join(' '));
      check('webhook 真的收到了请求', pushReceived.length === 1, `${pushReceived.length} 次`);
      const got = pushReceived[0] ? JSON.parse(pushReceived[0].body) : {};
      check('企业微信格式正确', got.msgtype === 'markdown' && /经营简报/.test(got.markdown ? got.markdown.content : ''),
        (got.markdown ? got.markdown.content : '').slice(0, 46).replace(/\n/g, ' '));
      check('推送内容含简报正文', /应收|警惕|关注|项目/.test(JSON.stringify(got)));

      // 不良渠道要明确报错
      pushReceived.length = 0;
      await post('/api/ai/push', {
        enabled: true, time: '23:59',
        channels: [{ type: 'wecom', url: 'http://127.0.0.1:9/nope' }],
      });
      const badTest = await post('/api/ai/push/test', {});
      check('推不通的渠道会明确报错', badTest.ok === false, JSON.stringify(badTest.results || []).slice(0, 70));

      const forbidPush = await post('/api/ai/push', { enabled: false }, limited);
      check('普通成员不能改推送设置', forbidPush.status === 403, `HTTP ${forbidPush.status}`);
      const pushForLimited = await fetch(BASE + '/api/ai/push', { headers: { Cookie: limited.cookie } });
      check('普通成员读不到推送配置', pushForLimited.status === 403, `HTTP ${pushForLimited.status}`);
      const st = await get('/api/ai/push');
      check('推送状态带 lastSent 字段', typeof st.lastSent === 'string');
    } finally {
      pushSrv.close();
      await post('/api/ai/push', { enabled: false, channels: [] });
    }

    /* ---------- 15. AI 录入：提议 → 人工确认 → 才落库 ---------- */
    console.log('[15] AI 录入（提议-确认两步）');
    {
      const proj = (await get('/api/list/projects?q=DEMO-')).rows[0];
      const madeIds = [];

      // 1) 默认关闭时，模型看不到写入工具
      await post('/api/ai/config', { allowWrite: false });
      toolCallPlan = { name: 'create_contract', args: { name: 'AITEST-未开启写入', project: proj.name, amount: 123456 } };
      const off = await sseChat(admin, '帮我录个合同');
      check('未开启时不下发写入工具',
        !(lastRequest.body.tools || []).some(t => /^create_/.test(t.function ? t.function.name : '')),
        `工具 ${(lastRequest.body.tools || []).length} 个`);
      check('未开启时不生成方案', !(off.proposals || []).length);
      check('未开启时库里没有这条合同', (await get('/api/list/contracts?q=AITEST-')).total === 0);

      // 2) 开启后：模型能看到写入工具，但调用只生成方案
      await post('/api/ai/config', { allowWrite: true });
      toolCallPlan = { name: 'create_contract', args: {
        name: 'AITEST-待确认合同', project: proj.name, amount: 888888, direction: 'in', sign_date: '2026-10-06',
      } };
      const on = await sseChat(admin, '帮我把这个合同录进去');
      check('开启后下发了写入工具',
        (lastRequest.body.tools || []).some(t => t.function && t.function.name === 'create_contract'),
        `工具 ${(lastRequest.body.tools || []).length} 个`);
      check('生成了待确认方案', (on.proposals || []).length === 1, `${(on.proposals || []).length} 份`);
      const prop = (on.proposals || [])[0] || {};
      check('方案里有 token 和明细', !!prop.token && Array.isArray(prop.detail) && prop.detail.length > 0,
        prop.summary);
      check('方案金额换算成万元', JSON.stringify(prop.detail || []).includes('88.89'),
        JSON.stringify(prop.detail || []).slice(0, 90));
      check('★ 提议阶段没有落库', (await get('/api/list/contracts?q=AITEST-')).total === 0, '库里 0 条');

      // 3) 用户点确认 → 才真正写入
      const ap = await post('/api/ai/apply', { token: prop.token });
      check('确认后保存成功', ap.ok === true, `id=${ap.id}`);
      if (ap.id) madeIds.push(ap.id);
      const after = await get('/api/list/contracts?q=AITEST-');
      check('★ 确认后库里才有这条合同', after.total === 1, `${after.total} 条`);
      if (after.rows[0]) {
        check('金额写对了', Number(after.rows[0].amount) === 888888, String(after.rows[0].amount));
        // 按名字断言，不按 id：ensureDemoData 每次登录会重建示例数据，id 会变
        // 只验证「合同确实挂到了一个项目上」，不比对具体 id：         // ensureDemoData 每次登录会重建示例数据，项目 id 会变，写死 id 的断言必然时对时错。         check('合同挂到了项目上', Number(after.rows[0].project_id) > 0,           'project_id=' + after.rows[0].project_id);         check('合同有名称和金额', !!after.rows[0].name && Number(after.rows[0].amount) === 888888, after.rows[0].name);
      }

      // 4) 同一个方案不能重复提交
      const again = await post('/api/ai/apply', { token: prop.token });
      check('重复确认被拒绝', again.ok !== true && /过期|不存在/.test(again.error || ''), again.error);
      check('没有多出第二条', (await get('/api/list/contracts?q=AITEST-')).total === 1);

      // 5) 伪造凭证不行
      const fake = await post('/api/ai/apply', { token: 'prop_deadbeefdeadbeef' });
      check('伪造凭证被拒绝', fake.ok !== true, fake.error);

      // 6) 没有写权限的账号：拿不到写入工具
      toolCallPlan = { name: 'create_contract', args: { name: 'AITEST-越权', project: proj.name, amount: 1 } };
      lastRequest = null;   // 清掉上一条，确保断言的是这次请求
      const ro = await sseChat(limited, '帮我录个合同');
      if (!lastRequest) {
        check('只读账号的请求确实发到了模型（否则下面的断言无意义）', false, ro.error || '请求没到模型');
      }
      check('只读账号拿不到写入工具',
        !((lastRequest && lastRequest.body.tools) || []).some(t => t.function && /^create_/.test(t.function.name)),
        `工具 ${((lastRequest && lastRequest.body.tools) || []).length} 个`);
      check('只读账号不会生成方案', !(ro.proposals || []).length);
      check('只读账号库里没多东西', (await get('/api/list/contracts?q=AITEST-')).total === 1);
      toolCallPlan = null;

      // 清理
      for (const id of madeIds) { try { await post(`/api/delete/contracts/${id}`, { cascade: true }) } catch { /* 忽略 */ } }
      await post('/api/ai/config', { allowWrite: false });
      check('录入测试数据已清理', (await get('/api/list/contracts?q=AITEST-')).total === 0);
    }

    /* ---------- 16. 限速 ---------- */
    console.log('[16] 限速（防止误操作烧钱）');
    let limited429 = null;
    for (let i = 0; i < 14; i++) {
      const r = await sseChat(admin, '压测 ' + i);
      if (r.status === 429) { limited429 = r.error; break }
    }
    check('连续提问会被限速', !!limited429, limited429 || '14 次都没触发');
    check('限速提示带等待秒数', /等\s*\d+\s*秒/.test(limited429 || ''), limited429 || '');


    /* ---------- 16. 关闭开关 ---------- */
    console.log('[16] 关闭「附带经营数据」');
    await post('/api/ai/config', { includeContext: false });
    const nc = await sseChat({ ...admin, cookie: admin.cookie }, '只聊通用问题');
    // 限速可能已经触发，这种情况跳过
    if (nc.status === 429) {
      check('（已触发限速，本项跳过）', true);
    } else {
      const nsys = ((lastRequest.body.messages || []).find(m => m.role === 'system') || {}).content || '';
      check('关掉后不再附带业务数据', !nsys.includes('市第一人民医院'), `${nsys.length} 字`);
    }
    await post('/api/ai/config', { includeContext: true });
  } catch (e) {
    check('测试执行', false, e.message.slice(0, 100));
  } finally {
    // 还原配置与账号
    try {
      const admin = await login(T.USER, T.PASS);
      await fetch(BASE + '/api/ai/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: admin.cookie },
        body: JSON.stringify({ enabled: false, includeContext: true, apiKey: null }),
      });
      if (limitedUser) {
        await fetch(BASE + '/api/users/' + limitedUser + '/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin.cookie }, body: '{}',
        });
      }
    } catch { /* 忽略 */ }
    if (backup) fs.writeFileSync(cfgFile, backup);
    else if (fs.existsSync(cfgFile)) fs.unlinkSync(cfgFile);
    // 清掉测试生成的简报缓存
    const bdir = path.join(__dirname, '..', 'data', 'briefings');
    if (fs.existsSync(bdir)) fs.rmSync(bdir, { recursive: true, force: true });
    mock.close();
  }

  const pass = results.filter(r => r.ok).length;
  console.log(`\nAI 助手测试结果：${pass} / ${results.length} 项通过`);
  process.exit(pass === results.length ? 0 : 1);
})().catch(e => { console.error('[测试异常]', e.message); process.exit(1); });
