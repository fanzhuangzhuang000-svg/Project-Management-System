'use strict';
/**
 * 单据进件测试：**传一张发票/合同/表格进 AI 助手 → 判断该录到哪张表 → 方案 → 确认落库**
 *
 * 这条链路是「AI 助手收文件」的核心，也是新功能里最容易悄悄错的地方
 * （字段名、金额口径、项目匹配、附件归属），所以分两层钉住：
 *
 *   [1] 纯函数层：tools/ingest.js 的映射规则。跑得快、不依赖服务。
 *   [2] 端到端层：走真实 HTTP —— 上传 → 进件 → 确认 → 落库 → 原件挂上。
 *       识别结果不靠跑 OCR（CI 上没素材、也慢），而是直接往 attachments 表里
 *       写一份「已识别」的结果，专测进件这一段的逻辑。
 *
 * 为什么端到端那层不能省：光测映射函数**测不出**附件有没有挂到新记录上、
 * 别人能不能读到你传的发票 —— 这两件事只有把 HTTP 走一遍才看得见。
 *
 * 用法： node tools/ingest-test.js
 */
const T = require('./test-auth.js');
const BASE = T.BASE;
const ingest = require('../tools/ingest.js');
const { TABLES } = require('../schema.js');

const results = [];
function check (name, ok, extra = '') {
  results.push({ name, ok });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? '  — ' + extra : ''}`);
}

/** 与真实票据等长的合成发票（税号/号码/公司名都是编的，仓库是公开的） */
function invoiceOcr (project, opts = {}) {
  const o = {
    kind: 'invoice',
    confidence: 100, fieldCount: 7, expectedCount: 7,
    fields: {
      invoice_no: 'AIIN26312000006153870999',
      issue_date: '2026-09-28',
      amount: '1303131.29',
      tax_rate: '13',
      tax_amount: '169407.07',
      total_amount: '1472538.36',
      invoice_type: '电子发票（增值税专用发票）',
    },
    hits: { invoice_no: '发票号码：AIIN26312000006153870999', amount: '¥1303131.29' },
    hints: { remark: 'AIIN-万祥项目材料款', tax_nos: '91310115MA1K3AIIN0' },
    parties: [
      { role: 'buyer', label: '购买方', name: '上海索杰电子信息系统有限公司' },
      { role: 'seller', label: '销售方', name: '上海颤维电子科技有限公司' },
    ],
    suggest: { direction: 'out', partner_db: null },
    checks: [{ level: 'warn', text: '价税合计大写与小写不一致，请人工核对' }],
    // 3000 字的"识别原文"：用来验证摘要只带截断片段，不整份发给模型
    normalized: '电子发票（增值税专用发票） AIIN26312000006153870999 ' + '甲'.repeat(3000),
  };
  if (project) {
    o.suggest = { ...o.suggest, project_id: project.id, project_name: project.name, project_score: 100 };
  }
  if (opts.noProject) delete o.suggest.project_name;
  if (opts.weak) { o.confidence = 20; o.fieldCount = 2; }
  return o;
}

/** 造一个测试附件（直接落库，避免真的跑 OCR；ocr_status 由调用方给） */
function makeAttachment (name, { buffer, ext, uploadedBy, ocr, status = 'done' } = {}) {
  const attach = require('../attachments.js');
  const row = attach.add({
    buffer: buffer || Buffer.from('%PDF-1.4 AIIN test'),
    originalName: name,
    uploadedBy,
  });
  attach.update(row.id, {
    ocr_status: status,
    ocr_kind: ocr ? ocr.kind : null,
    ocr_fields: ocr ? JSON.stringify(ocr) : null,
    ocr_text: ocr ? ocr.normalized : null,
    ocr_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  return attach.get(row.id);
}

async function main () {
  /**
   * 未经 Cookie 包装的原始 fetch。
   *
   * T.prepareAuth() 会把 global.fetch 换成一个「自动带上管理员 Cookie」的包装版，
   * 之后所有请求都是管理员身份 —— 而"别人传的附件我看不到"这条**必须**用
   * 另一个普通账号发请求才测得出来。所以先把它留一份。
   */
  const rawFetch = global.fetch;
  /* ═══════════════ [1] 纯函数：识别结果 → 录入参数 ═══════════════ */
  console.log('\n[1] 映射规则（纯函数，不依赖服务）');

  const proj = { id: 7, name: '万祥弱电工程' };
  const inv = invoiceOcr(proj);

  const p1 = ingest.planFromOcr({ ocr: inv, ext: '.pdf' });
  check('发票 → create_invoice', p1.action === 'propose' && p1.tool === 'create_invoice', p1.action + '/' + p1.tool);
  check('金额口径不搞反（amount=不含税、total_amount=价税合计）',
    p1.args.amount === 1303131.29 && p1.args.total_amount === 1472538.36,
    JSON.stringify([p1.args.amount, p1.args.total_amount]));
  check('发票号/开票日期/税率原样带过去',
    p1.args.invoice_no === 'AIIN26312000006153870999' && p1.args.issue_date === '2026-09-28' && p1.args.tax_rate === 13,
    JSON.stringify([p1.args.invoice_no, p1.args.issue_date, p1.args.tax_rate]));
  check('备注（项目线索）带进 remark', p1.args.remark === 'AIIN-万祥项目材料款', String(p1.args.remark));
  check('已匹配到项目 → 用项目名交给 proposeWrite 解析', p1.args.project === '万祥弱电工程', String(p1.args.project));
  check('方向按 suggest 走', p1.args.direction === 'out', String(p1.args.direction));

  // 千分位 / ¥ / 单位混进来的金额必须解析干净，否则 NaN 会卡死后续校验
  const messy = invoiceOcr(proj);
  messy.fields.amount = '¥1,303,131.29 元';
  messy.fields.tax_rate = '13%';
  const pm = ingest.planFromOcr({ ocr: messy, ext: '.pdf' });
  check('金额里的 ¥ 千分位 与 % 都能解析',
    pm.args.amount === 1303131.29 && pm.args.tax_rate === 13,
    JSON.stringify([pm.args.amount, pm.args.tax_rate]));

  // 合同
  const CONTRACT_OCR = {
    kind: 'contract', confidence: 85, fieldCount: 6, expectedCount: 7,
    fields: { name: 'AIIN-某项目弱电分包合同', code: 'AIIN-HT-2026-001', amount: '586000', sign_date: '2026-03-05', payment_terms: '预付30%，验收65%，质保5%' },
    hints: {}, parties: [{ role: 'party_a', label: '甲方', name: '索杰' }, { role: 'party_b', label: '乙方', name: '颤维' }],
    suggest: { direction: 'out', project_id: 7, project_name: '万祥弱电工程' },
    checks: [], normalized: '合同',
  };
  const pc = ingest.planFromOcr({ ocr: CONTRACT_OCR, ext: '.pdf' });
  check('合同 → create_contract', pc.action === 'propose' && pc.tool === 'create_contract', pc.action + '/' + pc.tool);
  check('合同金额原样带过去', pc.args.amount === 586000, String(pc.args.amount));
  check('付款条款带过去', pc.args.payment_terms === '预付30%，验收65%，质保5%', String(pc.args.payment_terms));

  // 认不出类型 / 置信度太低 → 交给模型
  const pu = ingest.planFromOcr({ ocr: { kind: 'other', fields: {}, parties: [], hints: {} }, ext: '.jpg' });
  check('认不出类型 → 交给模型判断（action=model）', pu.action === 'model', pu.action);
  const pw = ingest.planFromOcr({ ocr: invoiceOcr(proj, { weak: true }), ext: '.jpg' });
  check('置信度太低 → 也交给模型，但保留兜底参数',
    pw.action === 'model' && pw.weak === true && pw.args && pw.args.amount === 1303131.29,
    `${pw.action}/weak=${pw.weak}/args=${!!pw.args}`);

  // 表格 → 引导去批量导入
  const ps = ingest.planFromOcr({ ocr: null, ext: '.xlsx' });
  check('表格 → 引导去批量导入（action=import）', ps.action === 'import', ps.action);

  /* ═══════════════ [2] 缺字段判断必须与后端校验一致 ═══════════════ */
  console.log('\n[2] 缺字段判断（和 db.validate 对齐，不能各说各话）');

  const dbf = require('../db.js');
  const noProj = ingest.invoiceArgs(invoiceOcr(null));
  const m1 = ingest.missingRequired('invoices', noProj);
  check('没匹配到项目 → 缺「所属项目」', m1.some(m => m.name === 'project_id'), m1.map(m => m.label).join('、'));

  // 发票只要给了价税合计，不含税金额由后端反算 —— 不该再让用户手填一遍
  const totalOnly = { project_id: 1, direction: 'out', issue_date: '2026-01-01', total_amount: 1130, tax_rate: 13 };
  const m2 = ingest.missingRequired('invoices', totalOnly);
  const dry2 = dbf.dryRunRow('invoices', totalOnly);
  check('只给价税合计时，不再把「金额」当缺失（后端会反算）',
    !m2.some(m => m.name === 'amount') && !(dry2 && dry2.error),
    JSON.stringify(m2.map(m => m.name)) + ' / ' + (dry2.error || 'dry-run 通过'));

  // 交叉一致性：我说"不缺"，后端 dry-run 就必须能过；反之亦然
  const pair1 = ingest.missingRequired('invoices', noProj).length === 0;
  const pair2 = !(dbf.dryRunRow('invoices', noProj) || {}).error;
  check('缺字段判断与后端 dry-run 结论一致', pair1 === pair2, `我:${pair1 ? '不缺' : '缺'} 后端:${pair2 ? '能过' : '拦下'}`);

  const ed = ingest.buildEditable('invoices', ['project_id', 'direction'], {
    projects: [{ value: 1, label: '市第一人民医院' }],
  });
  check('可补字段：ref 列给下拉（选项由调用方查库传入）',
    ed.project_id.kind === 'select' && ed.project_id.options.length === 1, JSON.stringify(ed.project_id));
  check('可补字段：枚举列直接取 schema 的 options',
    ed.direction.kind === 'select' && ed.direction.options.length === 2, JSON.stringify(ed.direction));

  /* ═══════════════ [3] 清洗模型给的参数 ═══════════════ */
  console.log('\n[3] 清洗模型给的参数（编造/坏格式要在入库前拦住）');

  const projects = [{ id: 7, name: '万祥弱电工程' }, { id: 8, name: '市第一人民医院' }];
  const s1 = ingest.sanitizeArgs('invoices', { project: '不存在的项目', amount: '¥1,234.00 元', invoice_no: 'X1', 乱七八糟: 'y' }, { projects });
  check('编造的项目名 → 丢掉并给理由（不能让整份方案废掉）',
    !s1.args.project && s1.dropped.some(d => d.includes('不存在')),
    JSON.stringify(s1.dropped));
  check('金额字符串解析成数字', s1.args.amount === 1234, String(s1.args.amount));
  check('表里没有的列直接忽略', s1.args['乱七八糟'] === undefined && s1.args.invoice_no === 'X1', JSON.stringify(s1.args));

  const s2 = ingest.sanitizeArgs('invoices', { project: '万祥', amount: '约十二万' }, { projects });
  check('项目名写短了也能对上（模糊匹配）', s2.args.project === '万祥弱电工程', String(s2.args.project));
  check('金额解析不出来 → 丢掉并说明（绝不让 NaN 进库）',
    s2.args.amount === undefined && s2.dropped.some(d => d.includes('不是有效数字')),
    JSON.stringify(s2.dropped));

  /* ═══════════════ [4] 发给模型的摘要：只带字段 + 截断片段 ═══════════════ */
  console.log('\n[4] 给模型的摘要（隐私 + 省 token）');

  const summary = ingest.docSummary({ ocr: inv, attachment: { original_name: 'AIIN-发票.pdf' }, projects, partners: [], hint: '万祥项目的' });
  check('摘要带上了关键字段', summary.includes('AIIN26312000006153870999') && summary.includes('1472538.36'));
  check('摘要带上了项目清单（模型只能用系统里真实存在的项目）', summary.includes('7: 万祥弱电工程'));
  check('摘要带上了用户附言', summary.includes('万祥项目的'));
  const excerpt = summary.split('文本片段')[1] || '';
  check('识别原文只发截断片段（3000 字原文不许整份发出去）',
    excerpt.length < 1200, `片段长度 ${excerpt.length}`);
  check('截断片段确实砍掉了尾部（不是把全文塞进来）', !summary.includes('甲'.repeat(900)));

  console.log('\n[5] 表格猜目标表');
  const g1 = ingest.guessSheetTable(['项目', '金额', '日期', '方式', '凭证号']);
  check('收付款台账表头 → payments', g1 && g1.table === 'payments', JSON.stringify(g1));
  const g2 = ingest.guessSheetTable(['单位名称', '类型', '联系人', '电话', '税号']);
  check('往来单位表头 → partners', g2 && g2.table === 'partners', JSON.stringify(g2));

  /* ═══════════════ [6] 端到端：走真实 HTTP ═══════════════ */
  console.log('\n[6] 端到端：上传 → 进件 → 确认 → 落库 → 原件挂上');

  await T.prepareAuth();
  const H = { 'Content-Type': 'application/json' };
  const post = (u, b) => fetch(BASE + u, { method: 'POST', headers: H, body: JSON.stringify(b || {}) });
  const get = (u) => fetch(BASE + u).then(r => r.json());

  const projList = await get('/api/list/projects?limit=1');
  const realProj = (projList.rows || [])[0];
  check('取到一个真实项目用于测试', !!realProj, realProj ? `#${realProj.id} ${realProj.name}` : '项目库是空的');

  const authMod = require('../auth.js');
  const me = authMod.getUserByName(T.USER);
  const cleanup = { attachments: [], invoices: [], contracts: [], users: [] };

  try {
    if (realProj) {
      // ---- 6.1 发票 + 已匹配到项目 → 直接给方案，确认即落库 ----
      const a1 = makeAttachment('AIIN-TEST-发票.pdf', {
        uploadedBy: me.id,
        ocr: invoiceOcr({ id: realProj.id, name: realProj.name }),
      });
      cleanup.attachments.push(a1.id);

      const r1 = await post('/api/ai/ingest', { attachment_id: a1.id }).then(r => r.json());
      check('进件返回待确认方案（不是直接写库）',
        r1.action === 'propose' && r1.proposal && r1.proposal.token, JSON.stringify(r1.action || r1.error));
      check('识别校验提示（大小写不一致）带给了用户',
        !!r1.proposal && (r1.proposal.warnings || []).some(w => w.includes('大写')),
        JSON.stringify((r1.proposal || {}).warnings));
      check('方案里没有缺字段（项目已匹配）',
        !!r1.proposal && (r1.proposal.missing || []).length === 0,
        JSON.stringify((r1.proposal || {}).missing));

      // 还没点确认 —— 这时候库里不该有这张发票
      const before = await get('/api/list/invoices?q=AIIN26312000006153870999');
      check('点确认之前，库里没有这张发票', (before.rows || []).length === 0, `找到 ${(before.rows || []).length} 条`);

      const ap1 = await post('/api/ai/apply', { token: r1.proposal.token }).then(r => r.json());
      check('确认后落库成功', ap1.ok === true && ap1.id > 0, JSON.stringify(ap1.error || ('id=' + ap1.id)));
      if (ap1.id) cleanup.invoices.push(ap1.id);
      check('原件自动挂到了新记录上', ap1.linkedAttachments === 1, `挂上 ${ap1.linkedAttachments} 份`);

      const after = await get('/api/list/invoices?q=AIIN26312000006153870999');
      const row = (after.rows || [])[0] || {};
      check('发票字段落库正确（价税合计/不含税/税率）',
        Number(row.total_amount) === 1472538.36 && Number(row.amount) === 1303131.29 && Number(row.tax_rate) === 13,
        JSON.stringify([row.total_amount, row.amount, row.tax_rate]));
      check('挂到了正确的项目', Number(row.project_id) === Number(realProj.id), `project_id=${row.project_id}`);

      const att1 = await get(`/api/attachments/${a1.id}`);
      check('附件表里也指向了这条发票（不是悬空扫描件）',
        att1.table_name === 'invoices' && Number(att1.record_id) === Number(ap1.id),
        `${att1.table_name}#${att1.record_id}`);

      // ---- 6.2 发票但项目没匹配上 → 方案明确缺字段，可在卡片上补 ----
      const a2 = makeAttachment('AIIN-TEST-发票-无项目.pdf', {
        uploadedBy: me.id,
        ocr: invoiceOcr(null),
      });
      cleanup.attachments.push(a2.id);

      const r2 = await post('/api/ai/ingest', { attachment_id: a2.id }).then(r => r.json());
      const miss = (r2.proposal && r2.proposal.missing) || [];
      check('项目没匹配上 → 方案里明确列出缺「所属项目」',
        r2.action === 'propose' && miss.some(m => m.name === 'project_id'),
        JSON.stringify(miss.map(m => m.name)));
      check('缺的字段给了下拉选项（用户不用退出去重传）',
        !!r2.proposal && r2.proposal.editable && r2.proposal.editable.project_id
        && r2.proposal.editable.project_id.kind === 'select'
        && r2.proposal.editable.project_id.options.length > 0,
        JSON.stringify((r2.proposal || {}).editable));

      // 没补就确认 → 必须被拦下，且回传还缺什么
      const apBad = await post('/api/ai/apply', { token: r2.proposal.token }).then(r => r.json());
      check('缺必填项时确认被拦下（不会写进一条脏数据）',
        !apBad.ok && !!apBad.error, JSON.stringify(apBad.error));
      check('拦下时回传了还缺哪些字段（前端能接着补）',
        Array.isArray(apBad.missing) && apBad.missing.some(m => m.name === 'project_id'),
        JSON.stringify(apBad.missing));

      // 补上项目再确认 → 成功
      const ap2 = await post('/api/ai/apply', { token: r2.proposal.token, patch: { project_id: realProj.id } })
        .then(r => r.json());
      check('在卡片上补完项目再确认 → 落库成功', ap2.ok === true && ap2.id > 0, JSON.stringify(ap2.error || ('id=' + ap2.id)));
      if (ap2.id) cleanup.invoices.push(ap2.id);
      const row2 = (await get('/api/list/invoices?q=AIIN26312000006153870999')).rows.find(r => r.id === ap2.id) || {};
      check('补的项目真的写进去了', Number(row2.project_id) === Number(realProj.id), `project_id=${row2.project_id}`);

      // ---- 6.3 传进来的表格 → 引导去导入中心，并猜对目标表 ----
      const csv = '单位名称,类型,联系人,电话\nAIIN测试甲方,甲方,张三,13800000000\n';
      const a3 = makeAttachment('AIIN-TEST-往来单位.csv', {
        buffer: Buffer.from(csv, 'utf8'), uploadedBy: me.id, ocr: null, status: 'unsupported',
      });
      cleanup.attachments.push(a3.id);
      const r3 = await post('/api/ai/ingest', { attachment_id: a3.id }).then(r => r.json());
      check('表格文件 → 引导去批量导入（不硬塞进单据录入）', r3.action === 'import', JSON.stringify(r3.action));
      check('按表头猜出了目标表 partners', r3.table === 'partners', JSON.stringify([r3.table, r3.tableLabel]));
      check('顺带告诉用户这份表有多少行', r3.rowCount === 1, `rowCount=${r3.rowCount}`);

      // ---- 6.4 不认识的文件 → 如实说，不装懂 ----
      const a4 = makeAttachment('AIIN-TEST-无识别.txt', {
        buffer: Buffer.from('这是一份没有识别结果的文本', 'utf8'), uploadedBy: me.id, ocr: null, status: 'unsupported',
      });
      cleanup.attachments.push(a4.id);
      const r4 = await post('/api/ai/ingest', { attachment_id: a4.id }).then(r => r.json());
      check('不支持识别的类型 → 给明确说明并指向附件中心',
        r4.action === 'none' && /附件中心/.test(r4.message || ''), String(r4.message));

      // ---- 6.5 附件归属：别人传的扫描件，我不能拿来看、下载、进件 ----
      //
      // 这一组必须用**非管理员**账号测：管理员本来就哪儿都能看（perms.all），
      // 拿管理员测等于什么都没测到 —— 第一版就是这么写的，全绿但漏洞照旧。
      const uname = 'aiin_' + Date.now().toString(36);
      const cu = await post('/api/users', {
        username: uname, name: '进件测试员', role: 'custom',
        read: ['invoices', 'projects'], write: ['invoices'], sys: [],
      }).then(r => r.json());
      check('建了一个只有发票读写权的普通账号', !cu.error && cu.id > 0, JSON.stringify(cu.error || ('id=' + cu.id)));
      if (cu.id) cleanup.users.push(cu.id);

      const lr = await rawFetch(BASE + '/api/login', {
        method: 'POST', headers: H, body: JSON.stringify({ username: uname, password: '123456' }),
      });
      const ptok = (lr.headers.get('set-cookie') || '').match(/pms_session=([^;]+)/);
      const other = { Cookie: 'pms_session=' + (ptok ? ptok[1] : ''), 'Content-Type': 'application/json' };
      check('普通账号登录成功', !!ptok, ptok ? 'ok' : '没有拿到会话');

      if (ptok) {
        // 管理员传的暂存发票（a1 已经确认挂到发票上了，所以另造一张纯暂存件）
        const a5 = makeAttachment('AIIN-TEST-管理员的发票.pdf', {
          uploadedBy: me.id, ocr: invoiceOcr({ id: realProj.id, name: realProj.name }),
        });
        cleanup.attachments.push(a5.id);

        const r5raw = await rawFetch(BASE + '/api/ai/ingest', {
          method: 'POST', headers: other, body: JSON.stringify({ attachment_id: a5.id }),
        });
        check('不能拿别人上传的扫描件生成录入方案（否则等于拿到原件读取权）',
          r5raw.status === 403, `HTTP ${r5raw.status}`);

        const dl = await rawFetch(BASE + '/api/file/' + a5.id, { headers: other });
        check('也不能直接下载别人还没归档的暂存原件', dl.status === 403, `HTTP ${dl.status}`);

        const listOther = await rawFetch(BASE + '/api/attachments', { headers: other }).then(r => r.json());
        check('暂存件不出现在别人的附件列表里（这次私有化的重点）',
          !(listOther.rows || []).some(x => x.id === a5.id),
          `列表里 ${(listOther.rows || []).length} 条`);

        // 反向验证：不是"把普通用户一刀切挡死" —— 他自己的暂存件必须照样能用
        const mine = makeAttachment('AIIN-TEST-普通账号自己的发票.pdf', {
          uploadedBy: cu.id, ocr: invoiceOcr({ id: realProj.id, name: realProj.name }),
        });
        cleanup.attachments.push(mine.id);
        const r6 = await rawFetch(BASE + '/api/ai/ingest', {
          method: 'POST', headers: other, body: JSON.stringify({ attachment_id: mine.id }),
        }).then(r => r.json());
        check('普通账号处理自己传的发票照常可用（没被误伤）',
          r6.action === 'propose' && !!r6.proposal, JSON.stringify(r6.action || r6.error || r6.message));
        const listMine = await rawFetch(BASE + '/api/attachments', { headers: other }).then(r => r.json());
        check('他自己传的暂存件看得到', (listMine.rows || []).some(x => x.id === mine.id));
      }

      // ---- 6.6 已挂到记录上的附件不能重复进件 ----
      const r7raw = await post('/api/ai/ingest', { attachment_id: a1.id });
      check('已经挂到记录上的附件不再受理（避免一份原件录两次）',
        r7raw.status === 409, `HTTP ${r7raw.status}`);
    }
  } finally {
    // 清场：发票、附件、临时账号都删干净
    // （附件在 test-auth 的清理白名单里还有一道兜底，防止测试中途崩掉留下垃圾）
    for (const id of cleanup.invoices) await post(`/api/delete/invoices/${id}`, { cascade: true }).catch(() => {});
    for (const id of cleanup.attachments) await post(`/api/attachments/${id}/delete`, {}).catch(() => {});
    for (const id of cleanup.users) await post(`/api/users/${id}/delete`, {}).catch(() => {});
  }

  /* ═══════════════ [7] 没配大模型时的降级行为 ═══════════════ */
  //
  // 这是新装客户最常见的情形：AI 还没配，用户就把一张收据拖进来了。
  // 必须给出人话解释，而不是抛异常或者假装成功。
  //
  // 只在**独立数据目录**里跑：这段会读 ai-config.json 判断有没有配模型，
  // 拿真实数据目录跑会碰到用户自己的密钥配置（既可能烧 token 又不可复现）。
  console.log('\n[7] 模型通道的降级（未配置大模型时）');
  const aiMod = require('../ai.js');
  if (!process.env.PMS_DATA_DIR) {
    check('跳过：需要独立数据目录（避免动到真实 AI 配置）', true, '设 PMS_DATA_DIR 后可跑');
  } else if (aiMod.getConfig().enabled) {
    check('跳过：该数据目录里已配置大模型，无法测「未配置」分支', true, '');
  } else {
    const other = makeAttachment('AIIN-TEST-收据.jpg', {
      uploadedBy: me.id,
      ocr: {
        kind: 'other', confidence: 0, fieldCount: 0, expectedCount: 0,
        fields: {}, hints: {}, parties: [], checks: [], normalized: '收款收据 今收到…',
      },
    });
    cleanup.attachments.push(other.id);
    const rOther = await post('/api/ai/ingest', { attachment_id: other.id }).then(r => r.json());
    check('认不出类型 + 没配模型 → 如实说认不出，并指路「系统设置」',
      rOther.action === 'none' && /系统设置/.test(rOther.message || ''),
      String(rOther.message));
    check('同时告诉前端"缺的是模型"（好引导去配置）', rOther.needModel === true, String(rOther.needModel));

    const weak = makeAttachment('AIIN-TEST-低置信度发票.jpg', {
      uploadedBy: me.id, ocr: invoiceOcr(null, { weak: true }),
    });
    cleanup.attachments.push(weak.id);
    const rWeak = await post('/api/ai/ingest', { attachment_id: weak.id }).then(r => r.json());
    check('置信度低的发票：仍给方案兜底（总比什么都没有强）',
      rWeak.action === 'propose' && rWeak.source === 'ingest-weak' && !!rWeak.proposal,
      JSON.stringify([rWeak.action, rWeak.source]));
    check('兜底方案必须明确提醒"对照原件核对"',
      !!rWeak.proposal && (rWeak.proposal.warnings || []).some(w => /置信度|核对/.test(w)),
      JSON.stringify((rWeak.proposal || {}).warnings));
  }

  /* ═══════════════ [8] 前端接线（点不了界面，至少把接线钉住） ═══════════════ */
  console.log('\n[8] 前端接线（源码级，防以后被删掉）');
  const fsMod = require('node:fs');
  const pathMod = require('node:path');
  const readSrc = (f) => fsMod.readFileSync(pathMod.join(__dirname, '..', 'web', 'src', f), 'utf8');
  try {
    const panel = readSrc('components/layout/AiAssistant.tsx');
    const api = readSrc('lib/api.ts');
    const imp = readSrc('pages/ImportPage.tsx');
    const srv = fsMod.readFileSync(pathMod.join(__dirname, '..', 'server.js'), 'utf8');

    check('AI 面板能收文件（回形针 + 拖拽 + 粘贴）',
      panel.includes("accept={meta?.upload?.accept}") && panel.includes('onDrop=') && panel.includes('onPaste='));
    check('面板把文件交给进件接口', panel.includes('http.ai.ingest('));
    check('确认时把卡片上补的字段一起提交', panel.includes('http.ai.applyProposal(p.token, patch)'));
    check('缺字段的卡片控件确实在渲染', panel.includes('editable[m.name]'));
    check('api 层有 ingest 与 patch 参数', api.includes('ingest: (body') && api.includes('patch?: Record'));
    check('导入页认 ?table= 预选目标表', imp.includes("sp.get('table')"));
    check('后端挂了进件路由', srv.includes("a === 'ingest'"));
    const aiSrc = fsMod.readFileSync(pathMod.join(__dirname, '..', 'ai.js'), 'utf8');
    check('方案里带着附件 id 并在确认后挂接', aiSrc.includes('attachIds: opts.attachIds') && aiSrc.includes('linkIds(p.attachIds'));
  } catch (e) {
    check('前端源码检查', false, e.message.slice(0, 80));
  }

  /* ═══════════════ 汇总 ═══════════════ */
  const failed = results.filter(r => !r.ok);
  console.log('\n' + '='.repeat(56));
  console.log(`  单据进件：${results.length - failed.length} / ${results.length} 项通过`);
  if (failed.length) console.log('  失败项：\n' + failed.map(f => '   - ' + f.name).join('\n'));
  console.log('='.repeat(56));
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => {
  console.error('\n  单据进件测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
