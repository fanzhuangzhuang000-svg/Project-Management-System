'use strict';
/**
 * AI 助手后端
 *
 * 三件事：
 *   1. 模型厂商接入（DeepSeek / 通义 / Kimi / 智谱 / 豆包 / OpenAI / Claude / Ollama / 自定义）
 *   2. 密钥与配置的保存（只存在服务端，永远不会下发给浏览器）
 *   3. 把系统里的真实经营数据组装成上下文，连同提问一起发给模型
 *
 * 设计取舍：
 *   - 默认走 OpenAI 兼容协议，国内主流大模型基本都兼容，一套代码通吃
 *   - Claude 的协议不一样，单独实现
 *   - 上下文按提问关键词挑选相关内容 + 权限过滤，既不超上下文窗口也不越权泄数据
 */

const fs = require('node:fs');
const path = require('node:path');
const dbf = require('./db.js');
const auth = require('./auth.js');

const { DATA_DIR, num, round2 } = dbf;
const CONFIG_FILE = path.join(DATA_DIR, 'ai-config.json');

/* ==================== 模型厂商 ==================== */

const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek（深度求索）',
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '性价比高，中文表达好，默认选它就行',
  },
  qwen: {
    label: '阿里通义千问',
    protocol: 'openai',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    defaultModel: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1',
    note: 'qwen-long 支持超长上下文，项目多的时候可以用',
  },
  kimi: {
    label: '月之暗面 Kimi',
    protocol: 'openai',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'],
    defaultModel: 'moonshot-v1-32k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '长文本能力强',
  },
  zhipu: {
    label: '智谱 GLM',
    protocol: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    defaultModel: 'glm-4-plus',
    keyUrl: 'https://bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 免费额度大，适合先试',
  },
  doubao: {
    label: '字节豆包（火山方舟）',
    protocol: 'openai',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: [],
    defaultModel: '',
    keyUrl: 'https://console.volcengine.com/ark',
    note: '模型名要填「接入点 ID」（形如 ep-2024xxxx），在方舟控制台创建',
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    protocol: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-7B-Instruct'],
    defaultModel: 'Qwen/Qwen2.5-72B-Instruct',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '一个密钥可切换多个开源模型',
  },
  openai: {
    label: 'OpenAI',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '需要能访问外网',
  },
  anthropic: {
    label: 'Anthropic Claude',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-20250514', 'claude-3-5-sonnet-20241022', 'claude-3-5-haiku-20241022'],
    defaultModel: 'claude-3-5-sonnet-20241022',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    note: '需要能访问外网',
  },
  ollama: {
    label: '本地 Ollama（离线）',
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b'],
    defaultModel: 'qwen2.5:7b',
    keyUrl: '',
    note: '完全本地跑、不联网、不花钱，但要有显卡才快。密钥随便填（如 ollama）',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    protocol: 'openai',
    baseUrl: '',
    models: [],
    defaultModel: '',
    keyUrl: '',
    note: '任何兼容 OpenAI 接口的服务：填上接口地址和模型名即可',
  },
};

/* ==================== 配置读写 ==================== */

const EMPTY = {
  enabled: false,
  provider: 'deepseek',
  baseUrl: '',
  model: '',
  apiKey: '',
  temperature: 0.3,
  maxTokens: 2000,
  includeContext: true,
  useTools: true,
  allowWrite: false,
};

/** 读取完整配置（含密钥，只能服务端用） */
function getConfig () {
  let saved = {};
  try {
    if (fs.existsSync(CONFIG_FILE)) saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {};
  } catch { saved = {}; }
  const cfg = { ...EMPTY, ...saved };
  const p = PROVIDERS[cfg.provider] || PROVIDERS.deepseek;
  // baseUrl / model 留空就用厂商默认值
  if (!cfg.baseUrl) cfg.baseUrl = p.baseUrl;
  if (!cfg.model) cfg.model = p.defaultModel;
  cfg.protocol = p.protocol;
  return cfg;
}

/** 给前端看的配置：密钥只回一个掩码，绝不回原文 */
function publicConfig (perms) {
  const c = getConfig();
  const canEdit = !perms || auth.canSys(perms, 'settings');
  return {
    enabled: !!c.enabled,
    provider: c.provider,
    providerLabel: (PROVIDERS[c.provider] || {}).label || c.provider,
    baseUrl: c.baseUrl,
    model: c.model,
    includeContext: c.includeContext !== false,
    useTools: c.useTools !== false,
    allowWrite: !!c.allowWrite,
    temperature: c.temperature,
    maxTokens: c.maxTokens,
    hasKey: !!c.apiKey,
    keyHint: c.apiKey ? maskKey(c.apiKey) : '',
    canEdit,
    // 只有能改设置的人才看得到厂商清单（普通成员只需要知道能不能用）
    providers: canEdit ? Object.entries(PROVIDERS).map(([k, v]) => ({
      value: k, label: v.label, baseUrl: v.baseUrl, models: v.models,
      defaultModel: v.defaultModel, keyUrl: v.keyUrl, note: v.note,
    })) : undefined,
    ready: !!(c.enabled && c.apiKey && c.baseUrl && c.model),
  };
}

function maskKey (k) {
  const s = String(k);
  if (s.length <= 8) return '••••••';
  return s.slice(0, 4) + '••••••••' + s.slice(-4);
}

/** 保存配置。传空 apiKey 表示「不修改已有密钥」，传 null 表示清除 */
function saveConfig (patch, perms) {
  if (perms && !auth.canSys(perms, 'settings')) {
    const e = new Error('没有修改系统设置的权限');
    e.status = 403;
    throw e;
  }
  const cur = getConfig();
  const next = { ...cur };
  if (patch.provider && PROVIDERS[patch.provider]) {
    next.provider = patch.provider;
    const p = PROVIDERS[patch.provider];
    // 换厂商时，如果没显式给 baseUrl/model，就跟着切成新厂商的默认值
    if (patch.baseUrl === undefined) next.baseUrl = p.baseUrl;
    if (patch.model === undefined) next.model = p.defaultModel;
  }
  if (patch.baseUrl !== undefined) next.baseUrl = String(patch.baseUrl).trim();
  if (patch.model !== undefined) next.model = String(patch.model).trim();
  if (patch.apiKey === null) next.apiKey = '';
  else if (patch.apiKey !== undefined && String(patch.apiKey).trim() !== '') next.apiKey = String(patch.apiKey).trim();
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.includeContext !== undefined) next.includeContext = !!patch.includeContext;
  if (patch.useTools !== undefined) next.useTools = !!patch.useTools;
  if (patch.allowWrite !== undefined) next.allowWrite = !!patch.allowWrite;
  if (patch.temperature !== undefined) next.temperature = Math.max(0, Math.min(2, num(patch.temperature)));
  if (patch.maxTokens !== undefined) next.maxTokens = Math.max(200, Math.min(8000, parseInt(patch.maxTokens, 10) || 2000));

  delete next.protocol;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2), 'utf8');
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { /* Windows 上无所谓 */ }
  return publicConfig(perms);
}

/* ==================== 业务上下文组装 ==================== */

const W = (v) => (num(v) / 10000).toFixed(1);        // 元 → 万元
const Y = (v) => Math.round(num(v)).toLocaleString('zh-CN');

/**
 * 把当前经营数据组装成给模型看的上下文。
 * 关键点：
 *   - 严格按权限过滤，用户看不到的模块绝不出现在上下文里
 *   - 按提问关键词挑选明细，避免无脑塞进去撑爆上下文窗口
 *   - 只给事实和数字，不给结论 —— 结论让模型自己下
 */
function buildContext (perms, question) {
  const q = String(question || '');
  const d = dbf.dashboardFor(perms);
  const t = d.totals || {};
  const out = [];

  out.push('# 当前经营数据（单位：万元，除注明外）');
  out.push(`数据日期：${d.today || dbf.today()}`);
  out.push('');
  out.push('## 总体');

  // 没有权限的模块 dashboardFor 会把值置为 null。
  // 这种情况下必须整行略去 —— 直接打印 0 会让模型以为「这家公司没有合同」，得出完全错误的结论。
  const ok = (v) => v !== null && v !== undefined && Number.isFinite(Number(v));
  const line = (v, fn) => { if (ok(v)) out.push('- ' + fn()); };

  line(t.project_count, () => `项目 ${t.project_count} 个（进行中 ${(d.by_status || {})['进行中'] || 0}、已完工 ${(d.by_status || {})['已完工'] || 0}）`);
  line(t.contract_in, () => `收入合同额 ${W(t.contract_in)}，支出合同额 ${W(t.contract_out)}`);
  line(t.paid_in, () => `累计回款 ${W(t.paid_in)}，累计付款 ${W(t.paid_out)}`);
  line(t.receivable, () => `应收未收 ${W(t.receivable)}，应付未付 ${W(t.payable)}`
    + (ok(t.payable_contract) ? `（其中合同应付 ${W(t.payable_contract)}、无合同未付费用 ${W(t.payable_expense)}）` : ''));
  line(t.cost, () => `实际成本 ${W(t.cost)}，动态毛利 ${W(t.actual_profit)}（毛利率 ${num(t.actual_rate).toFixed(1)}%）`);
  line(t.gross_profit, () => `预计毛利（签约口径）${W(t.gross_profit)}（${num(t.gross_rate).toFixed(1)}%）`);
  line(t.collect_rate, () => `回款率 ${num(t.collect_rate).toFixed(1)}%`
    + (ok(t.cost_used_rate) ? `，成本执行率 ${num(t.cost_used_rate).toFixed(1)}%（预算 ${W(t.contract_out)}）` : ''));
  line(t.inv_out, () => `已开票 ${W(t.inv_out)}，未开票 ${W(t.uninvoiced_out)}；已开票未收 ${W(t.inv_out_unpaid)}；已收款未开票 ${W(t.paid_in_no_inv)}`);
  line(t.expense_count, () => `费用笔数 ${t.expense_count}`
    + (ok(t.material_amount) ? `，材料设备 ${W(t.material_amount)}` : ''));
  line(t.maint_count, () => `售后单 ${t.maint_count} 个，其中未结 ${t.maint_open} 个`);

  // 这一段全是无权限字段时，整节去掉，别留一个空标题让模型猜
  if (out[out.length - 1] === '## 总体') { out.pop(); out.pop(); }

  // ---- 账龄 ----
  const aging = (d.aging || {}).receivable;
  if (aging && Object.keys(aging).length) {
    out.push('');
    out.push('## 应收账龄');
    for (const [k, v] of Object.entries(aging)) {
      if (v && v.amount !== undefined) out.push(`- ${k}：${W(v.amount)}${v.count ? ` 万（${v.count} 笔）` : ' 万'}`);
    }
  }

  // ---- 逾期明细：收和付必须分开，否则模型会把应付当成应收来分析 ----
  const topOverdue = (d.aging || {}).top_overdue;
  if (Array.isArray(topOverdue) && topOverdue.length) {
    const ins = topOverdue.filter(r => r.direction === 'in');
    const outs = topOverdue.filter(r => r.direction === 'out');
    if (ins.length) {
      out.push('');
      out.push('## 逾期未收节点（越靠前逾期越久）');
      for (const r of ins.slice(0, 12)) {
        out.push(`- ${r.project_name || '#' + r.id}｜${r.phase || ''}｜${W(r.remaining)} 万｜到期 ${r.due_date}｜已逾期 ${r.days} 天`
          + `${r.contract_name ? '｜合同：' + r.contract_name : ''}`);
      }
    }
    if (outs.length) {
      out.push('');
      out.push('## 逾期未付节点（这些是欠供应商的）');
      for (const r of outs.slice(0, 12)) {
        out.push(`- ${r.project_name || '#' + r.id}｜${r.phase || ''}｜${W(r.remaining)} 万｜到期 ${r.due_date}｜已逾期 ${r.days} 天`
          + `${r.contract_name ? '｜合同：' + r.contract_name : ''}`);
      }
    }
  }

  // ---- 收付款计划总体（没有计划读权时 totals 是空对象，整节略去）----
  const st = (d.schedules || {}).totals;
  if (st && Number.isFinite(Number(st.node_count))) {
    out.push('');
    out.push('## 收付款计划执行');
    out.push(`- 计划节点 ${st.node_count} 个：应收计划 ${W(st.plan_in)} 万，应付计划 ${W(st.plan_out)} 万`);
    out.push(`- 已按计划收到 ${W(st.paid_in)} 万，已付出 ${W(st.paid_out)} 万`);
    out.push(`- 逾期未收 ${W(st.overdue_in)} 万（涉及 ${Math.round(num(st.overdue_count))} 个节点），逾期未付 ${W(st.overdue_out)} 万`);
    out.push(`- 尚未到期：应收 ${W(st.remaining_in)} 万，应付 ${W(st.remaining_out)} 万`);
  }

  // ---- 待办提醒 ----
  if (Array.isArray(d.reminders) && d.reminders.length) {
    out.push('');
    out.push('## 系统识别出的待办与预警');
    for (const r of d.reminders.slice(0, 15)) {
      out.push(`- [${r.level || 'info'}] ${r.title}${r.detail ? '：' + r.detail : ''}`
        + `${r.amount ? `（涉及 ${W(r.amount)} 万）` : ''}`);
    }
  }

  // ---- 月度趋势 ----
  if (Array.isArray(d.monthly) && d.monthly.length) {
    out.push('');
    out.push('## 最近月度收付（万元）');
    for (const m of d.monthly.slice(-12)) {
      out.push(`- ${m.ym}：收 ${W(m.inflow)}，付 ${W(m.outflow)}`);
    }
  }

  // ---- 费用构成 ----
  const be = d.by_expense || {};
  if (Object.keys(be).length) {
    out.push('');
    out.push('## 成本构成');
    const arr = Object.entries(be).sort((a, b) => num(b[1]) - num(a[1]));
    const sum = arr.reduce((s, x) => s + num(x[1]), 0) || 1;
    for (const [k, v] of arr) out.push(`- ${k}：${W(v)}（占 ${(num(v) / sum * 100).toFixed(1)}%）`);
  }

  // ---- 项目明细（需要项目查看权限）----
  // 这里要逐列按权限给：projectStatsMany 是直接查库的，不做权限过滤，
  // 不逐列判断的话，只有「项目台账」权限的人也会看到合同额和回款额。
  const can = (t) => !!(perms && (perms.all || (perms.read || []).includes(t)));
  if (can('projects')) {
    const rows = dbf.db.prepare('SELECT id, code, name, status, category, manager, progress, start_date, end_date FROM projects ORDER BY id DESC').all();
    if (rows.length) {
      const stats = dbf.projectStatsMany(rows.map(r => r.id));
      out.push('');
      out.push(`## 项目明细（共 ${rows.length} 个${rows.length > 60 ? '，下面按合同额列出前 60 个' : ''}）`);
      const enriched = rows.map(r => ({ ...r, ...(stats[r.id] || {}) }));
      enriched.sort((a, b) => num(b.contract_in) - num(a.contract_in));
      const wantCost = can('expenses') && q.match(/成本|毛利|利润|超支|费用|钱|赚|亏/);
      const wantCollect = can('payments') && q.match(/回款|收款|应收|欠|账龄|逾期|催/);
      for (const p of enriched.slice(0, 60)) {
        // 项目自身的信息：有项目权限就能看
        const bits = [`${p.name}`, `状态${p.status}`, `进度${p.progress}%`, `负责人${p.manager || '未指定'}`];
        // 合同口径
        if (can('contracts')) {
          bits.push(`收入合同${W(p.contract_in)}`);
          if (num(p.change_in) || num(p.change_out)) bits.push(`变更增加${W(p.change_in)}`);
        }
        // 资金口径
        if (can('payments')) {
          bits.push(`已回款${W(p.paid_in)}`, `应收${W(p.receivable)}`);
          if (wantCollect) bits.push(`回款率${num(p.collect_rate).toFixed(1)}%`);
        }
        // 成本口径
        if (can('expenses')) {
          bits.push(`实际成本${W(p.cost)}`, `动态毛利${W(p.actual_profit)}`, `毛利率${num(p.actual_rate).toFixed(1)}%`);
          if (wantCost) bits.push(`成本执行率${num(p.cost_used_rate).toFixed(1)}%`);
        }
        // 发票口径
        if (can('invoices')) bits.push(`已开票${W(p.inv_out)}`);
        out.push('- ' + bits.join('，'));
      }
    }
  }

  // ---- 多项目对比时补上按负责人/分类的汇总 ----
  if (can('contracts') && q.match(/负责人|经理|谁|团队|人员/)) {
    // 注意：负责人挂在 projects 上，contracts 表没有 manager 列，必须 join
    const rows = dbf.db.prepare(`
      SELECT p.manager AS mgr, COUNT(*) AS n, SUM(c.amount) AS amt
      FROM contracts c JOIN projects p ON p.id = c.project_id
      WHERE c.direction = 'in'
      GROUP BY p.manager ORDER BY amt DESC`).all();
    if (rows.length) {
      out.push('');
      out.push('## 按负责人汇总（收入合同）');
      for (const r of rows) out.push(`- ${r.mgr || '未指定'}：${r.n} 份合同，合计 ${W(r.amt)} 万`);
    }
  }
  if (can('projects') && q.match(/分类|类别|子系统|弱电系统|智能化/)) {
    const rows = dbf.db.prepare('SELECT category, COUNT(*) n FROM projects GROUP BY category ORDER BY n DESC').all();
    if (rows.length) {
      out.push('');
      out.push('## 项目分类分布');
      for (const r of rows) out.push(`- ${r.category || '未分类'}：${r.n} 个`);
    }
  }

  return out.join('\n');
}

/* ==================== 提示词 ==================== */

function systemPrompt (hasContext) {
  const base = [
    '你是「弱电智能化工程项目管理系统」内置的经营分析助手，服务对象是弱电工程公司的老板和项目经理。',
    '',
    '回答要求：',
    '1. 用中文，直接、具体、可执行。不要客套，不要复述我的问题。',
    '2. 涉及到数字时，引用给出的数据，并标明单位（万元）。不要自己编数字。',
    '3. 给建议要落到人和动作上，例如「本周内让张经理去催 XX 项目的第 3 笔进度款」，而不是「建议加强回款管理」。',
    '4. 如果数据不足以回答，直接说缺什么数据、去哪里补，不要硬答。',
    '5. 回答控制在 400 字以内，除非我明确要求详细分析。能用条列就用条列。',
    '6. 计算类问题要给出算式，让我能复核。',
  ];
  if (hasContext) {
    base.push('', '下面是系统的实时经营数据。它是最权威的事实来源，回答时必须以它为准：', '');
  } else {
    base.push('', '注意：当前没有附带经营数据，你只能基于通用经验回答。涉及具体数字时要说明「需要看系统数据」。');
  }
  return base.join('\n');
}

/** 内置的快捷提问（前端也用这份，保持一致） */
const QUICK_PROMPTS = [
  { icon: 'trending', text: '本月经营情况怎么样？有哪些要重点盯的？' },
  { icon: 'alert', text: '哪些项目回款有问题？给我一个催款优先级清单' },
  { icon: 'wallet', text: '分析一下成本，哪些项目有超支风险？' },
  { icon: 'chart', text: '按动态毛利率给项目排个序，说明为什么有高有低' },
  { icon: 'file', text: '应收账龄结构健康吗？该怎么优化？' },
  { icon: 'shield', text: '发票和收付款的勾稽有没有异常？税务上要注意什么？' },
];

/* ==================== 调用大模型 ==================== */

/** 统一的网络错误提示，把技术错误翻译成人话 */
function friendlyError (err, cfg) {
  const msg = String(err && err.message || err);
  if (err && err.name === 'AbortError') return '请求已取消';
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network/i.test(msg)) {
    return `连不上「${(PROVIDERS[cfg.provider] || {}).label || cfg.provider}」的接口地址（${cfg.baseUrl}）。`
      + '请检查网络，或者换一个能访问的厂商。';
  }
  return msg;
}

/**
 * 流式对话。
 * @param {object} opts {messages, perms, question, onDelta, onContext, signal}
 * @returns {Promise<{text:string, usage:object|null}>}
 */
async function chatStream (opts) {
  const cfg = getConfig();
  if (!cfg.enabled) { const e = new Error('AI 助手还没启用，请先到「系统设置」里配置'); e.status = 400; throw e; }
  if (!cfg.apiKey) { const e = new Error('还没填 API 密钥，请到「系统设置 → AI 助手」里填上'); e.status = 400; throw e; }
  if (!cfg.baseUrl) { const e = new Error('还没填接口地址'); e.status = 400; throw e; }
  if (!cfg.model) { const e = new Error('还没填模型名称'); e.status = 400; throw e; }

  const question = opts.question || '';
  const messages = [];

  // 上下文只在开了开关、且当前提问需要时带上（多轮对话里只带一次，省 token）
  let contextText = '';
  if (cfg.includeContext !== false) {
    try {
      contextText = buildContext(opts.perms, question);
      if (opts.onContext) opts.onContext(contextText);
    } catch (e) {
      contextText = '';
    }
  }

  const sys = systemPrompt(!!contextText) + (contextText ? contextText : '');
  messages.push({ role: 'system', content: sys });

  // 历史对话（只带最近若干轮，避免无限增长）
  const hist = Array.isArray(opts.messages) ? opts.messages.slice(-10) : [];
  for (const m of hist) {
    if (!m || !m.content) continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    messages.push({ role, content: String(m.content).slice(0, 6000) });
  }
  if (question) messages.push({ role: 'user', content: question });

  // 工具调用：让模型自己往下查明细，而不是一次拿到全部数据
  const useTools = cfg.useTools !== false && cfg.protocol !== 'anthropic';
  // 写入工具只在管理员开了开关、且当前用户确有写权限时才给模型看见
  const canWriteAny = !!(opts.perms && (opts.perms.all || (opts.perms.write || []).length));
  const useWrite = useTools && cfg.allowWrite === true && canWriteAny;
  if (useTools) {
    messages[0].content += '\n\n你可以调用工具查询系统中的明细数据（项目、合同、收付款、计划、发票、费用）。'
      + '\n遇到需要具体数字或明细的问题，先调用工具查，不要凭空推测。'
      + '\n工具返回的金额单位都是万元。一次可以并行调用多个工具。';
  }
  if (useWrite) {
    messages[0].content += '\n\n你还可以帮用户**录入**数据（项目、合同、收付款、发票、费用）。'
      + '\n重要规则：调用录入工具不会真的写库，只会生成一份「待确认方案」交给用户点确认。'
      + '\n所以调用之后要说「我准备这样录入，请点确认」，绝对不要说你已经保存好了。'
      + '\n用户没有明确要求录入时不要调用录入工具。'
      + '\n录入前如果缺关键信息（比如金额、所属项目），先问清楚，不要瞎填。';
  }

  const isAnthropic = cfg.protocol === 'anthropic';
  const url = isAnthropic
    ? cfg.baseUrl.replace(/\/+$/, '') + '/messages'
    : cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';

  /**
   * 发一次请求并流式读取。
   * 除了正文字段，还要累积 tool_calls —— OpenAI 流式下它是按片段拼出来的。
   */
  async function callOnce (msgs, allowTools, withWrite) {
    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (isAnthropic) {
      headers['x-api-key'] = cfg.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: cfg.model, max_tokens: cfg.maxTokens, temperature: cfg.temperature,
        system: sys, stream: true,
        messages: msgs.filter(m => m.role !== 'system'),
      };
      if (allowTools) body.tools = anthropicTools(withWrite);
    } else {
      headers.Authorization = 'Bearer ' + cfg.apiKey;
      body = {
        model: cfg.model, messages: msgs,
        temperature: cfg.temperature, max_tokens: cfg.maxTokens, stream: true,
      };
      if (allowTools) { body.tools = openAiTools(withWrite); body.tool_choice = 'auto' }
    }

    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: opts.signal });
    } catch (err) {
      const e = new Error(friendlyError(err, cfg));
      e.status = 502;
      throw e;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = (await res.text()).slice(0, 500); } catch { /* 读不到就算了 */ }
      let hint = '';
      if (res.status === 401 || res.status === 403) hint = '（API 密钥不对或没有权限，请到「系统设置 → AI 助手」重新填）';
      else if (res.status === 404) hint = '（接口地址或模型名不对）';
      else if (res.status === 429) hint = '（调用太频繁或余额不足）';
      else if (res.status >= 500) hint = '（对方服务暂时故障，稍后再试）';
      const e = new Error(`模型返回 ${res.status} ${hint}${detail ? ' — ' + detail : ''}`);
      e.status = 502;
      throw e;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let text = '';
    let usage = null;
    const tcAcc = [];                       // 累积中的 tool_calls

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // 按行处理，最后一行可能不完整，留在 buf 里
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line || !line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;

        let json;
        try { json = JSON.parse(payload); } catch { continue; }

        let delta = '';
        if (isAnthropic) {
          if (json.type === 'content_block_delta' && json.delta && json.delta.text) delta = json.delta.text;
          if (json.type === 'message_delta' && json.usage) usage = json.usage;
          if (json.type === 'message_start' && json.message && json.message.usage) usage = json.message.usage;
        } else {
          const ch = json.choices && json.choices[0];
          if (ch) {
            if (ch.delta && typeof ch.delta.content === 'string') delta = ch.delta.content;
            // 有的厂商（如 DeepSeek 推理模型）把思维链放在 reasoning_content，不展示给用户
            if (!delta && ch.delta && ch.delta.reasoning_content) { /* 忽略思维链 */ }
            if (ch.message && typeof ch.message.content === 'string' && !text) delta = ch.message.content;
            // tool_calls 是分片下发的：index 相同的片段要拼到一起
            const parts = (ch.delta && ch.delta.tool_calls) || (ch.message && ch.message.tool_calls);
            if (Array.isArray(parts)) {
              for (const p of parts) {
                const i = typeof p.index === 'number' ? p.index : tcAcc.length;
                if (!tcAcc[i]) tcAcc[i] = { id: '', name: '', argsRaw: '' };
                if (p.id) tcAcc[i].id = p.id;
                if (p.function && p.function.name) tcAcc[i].name = p.function.name;
                if (p.function && typeof p.function.arguments === 'string') tcAcc[i].argsRaw += p.function.arguments;
              }
            }
          }
          if (json.usage) usage = json.usage;
        }

        if (delta) {
          text += delta;
          if (opts.onDelta) opts.onDelta(delta);
        }
      }
    }
    return { text, toolCalls: tcAcc.filter(Boolean), usage };
  }

  /* ---- 智能体循环：模型要查就查，查到给答案为止 ---- */
  const MAX_ROUNDS = 5;
  const convo = messages.slice();
  let answer = '';
  let usage = null;
  let usedTools = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const r = await callOnce(convo, useTools, useWrite);
    if (r.usage) usage = r.usage;

    if (!useTools || !r.toolCalls.length) { answer = r.text; break }

    // 记下模型这一轮的「我要调用这些工具」
    convo.push({
      role: 'assistant',
      content: r.text || '',
      tool_calls: r.toolCalls.map(tc => ({
        id: tc.id || ('call_' + Math.random().toString(36).slice(2, 10)),
        type: 'function',
        function: { name: tc.name, arguments: tc.argsRaw || '{}' },
      })),
    });

    for (const tc of r.toolCalls) {
      const id = tc.id || convo[convo.length - 1].tool_calls.find(x => x.function.name === tc.name).id;
      const label = TOOL_LABEL[tc.name] || tc.name;
      usedTools++;
      if (opts.onTool) opts.onTool(tc.name, label);
      let args = {};
      try { args = JSON.parse(tc.argsRaw || '{}') } catch { args = {} }
      let result;
      try {
        if (WRITE_TOOL_MAP[tc.name]) {
          // 只在本轮真的下发了写入工具时才受理。
          // 否则模型可以绕过开关硬调 create_xxx —— 那就等于开关形同虚设。
          if (!useWrite) {
            result = { error: '当前没有开启「AI 录入数据」功能，无法创建记录。' };
          } else {
            result = proposeWrite(tc.name, args, opts.perms);
            if (result && result.__proposal && opts.onProposal) opts.onProposal(result);
          }
        } else {
          result = executeTool(tc.name, args, opts.perms);
        }
      } catch (e) {
        result = { error: '查询出错：' + e.message };
      }
      convo.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }

  // 轮次用完还没给答案（一直在查），最后强制要一次结论
  if (!answer) {
    convo.push({ role: 'user', content: '请直接给出最终结论，不要再调用工具。' });
    const last = await callOnce(convo, false, false);
    answer = last.text;
    if (last.usage) usage = last.usage;
  }

  return { text: answer, usage, usedTools };
}

/**
 * 测试连接：发一句最短的话，确认密钥/地址/模型都能用。
 * @param {object} [override] 临时的配置覆盖（「边填边测」用，不落盘）
 */
async function testConnection (override) {
  const cfg = { ...getConfig(), ...(override || {}) };
  if (!cfg.apiKey) { const e = new Error('还没填 API 密钥'); e.status = 400; throw e; }
  if (!cfg.baseUrl) { const e = new Error('还没填接口地址'); e.status = 400; throw e; }
  if (!cfg.model) { const e = new Error('还没填模型名称'); e.status = 400; throw e; }
  const isAnthropic = cfg.protocol === 'anthropic';
  const url = isAnthropic
    ? cfg.baseUrl.replace(/\/+$/, '') + '/messages'
    : cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  let body;
  if (isAnthropic) {
    headers['x-api-key'] = cfg.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    body = { model: cfg.model, max_tokens: 32, messages: [{ role: 'user', content: '回复两个字：正常' }] };
  } else {
    headers['Authorization'] = 'Bearer ' + cfg.apiKey;
    body = { model: cfg.model, max_tokens: 32, messages: [{ role: 'user', content: '回复两个字：正常' }] };
  }

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (err) {
    const e = new Error(friendlyError(err, cfg));
    e.status = 502;
    throw e;
  }
  const ms = Date.now() - t0;
  const raw = await res.text();
  if (!res.ok) {
    let hint = '';
    if (res.status === 401 || res.status === 403) hint = 'API 密钥不对或没有权限';
    else if (res.status === 404) hint = '接口地址或模型名不对';
    else if (res.status === 429) hint = '调用太频繁或余额不足';
    const e = new Error(`连接失败：HTTP ${res.status}${hint ? '（' + hint + '）' : ''} — ${raw.slice(0, 300)}`);
    e.status = 502;
    throw e;
  }
  let reply = '';
  try {
    const j = JSON.parse(raw);
    reply = isAnthropic
      ? (j.content && j.content[0] && j.content[0].text) || ''
      : (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
  } catch { reply = raw.slice(0, 100); }
  return {
    ok: true, ms, model: cfg.model,
    provider: (PROVIDERS[cfg.provider] || {}).label || cfg.provider,
    reply: String(reply).slice(0, 100),
  };
}

/* ==================== 简易限速（控制费用） ==================== */

const hits = new Map();          // userId -> [时间戳]
const WINDOW_MS = 60 * 1000;
const MAX_PER_MIN = 10;

function rateCheck (userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter(t => now - t < WINDOW_MS);
  if (arr.length >= MAX_PER_MIN) {
    return { ok: false, wait: Math.ceil((WINDOW_MS - (now - arr[0])) / 1000) };
  }
  arr.push(now);
  hits.set(userId, arr);
  return { ok: true };
}

/* ==================== 工具调用（让模型自己查明细） ==================== */

/**
 * 给模型的工具集。
 * 有了这些，模型不用一次拿到全部数据快照，而是发现问题后自己往下查 ——
 * 既能回答「第三笔进度款什么时候到账」这种细节问题，也省 token。
 *
 * 每个工具的执行都会过一遍权限：用户看不到的模块，查了也只回「没有权限」。
 */
const TOOLS = [
  {
    name: 'search_projects',
    desc: '按关键词/状态/负责人/分类查项目台账。想了解有哪些项目、某个项目的负责人或进度时用。',
    params: {
      keyword: { type: 'string', desc: '项目名称或编号里的关键词' },
      status: { type: 'string', enum: ['未开工', '进行中', '已完工', '结算中'], desc: '项目状态' },
      manager: { type: 'string', desc: '负责人姓名' },
      category: { type: 'string', desc: '子系统分类，如 综合布线、安防监控' },
      limit: { type: 'integer', desc: '最多返回几条，默认 20' },
    },
  },
  {
    name: 'get_project_detail',
    desc: '查某个项目的完整情况：合同、收付款、发票、成本、应收应付、计划节点。用户提到具体项目名时优先用这个。',
    params: {
      project: { type: 'string', desc: '项目名称或编号（支持部分匹配，如"第一人民医院"）', required: true },
    },
  },
  {
    name: 'list_contracts',
    desc: '查合同明细。想知道某个项目签了哪些合同、合同金额、还有哪些在执行时用。',
    params: {
      project: { type: 'string', desc: '限定项目（名称关键词）' },
      direction: { type: 'string', enum: ['in', 'out'], desc: 'in=收入合同（我方收款），out=支出合同（我方付款）' },
      status: { type: 'string', desc: '合同状态，如 执行中、已完工' },
      limit: { type: 'integer', desc: '最多返回几条，默认 20' },
    },
  },
  {
    name: 'list_payments',
    desc: '查实际发生的收付款流水。想核对某笔钱、看某个时间段收了多少钱时用。',
    params: {
      project: { type: 'string', desc: '限定项目（名称关键词）' },
      direction: { type: 'string', enum: ['in', 'out'], desc: 'in=收款，out=付款' },
      date_from: { type: 'string', desc: '起始日期 YYYY-MM-DD' },
      date_to: { type: 'string', desc: '截止日期 YYYY-MM-DD' },
      limit: { type: 'integer', desc: '最多返回几条，默认 30' },
    },
  },
  {
    name: 'list_schedules',
    desc: '查收付款计划节点（含已冲抵金额、是否逾期）。回答"什么时候该收/该付"用这个。',
    params: {
      project: { type: 'string', desc: '限定项目（名称关键词）' },
      direction: { type: 'string', enum: ['in', 'out'], desc: 'in=应收计划，out=应付计划' },
      overdue_only: { type: 'boolean', desc: '只返回已逾期的' },
      limit: { type: 'integer', desc: '最多返回几条，默认 30' },
    },
  },
  {
    name: 'list_invoices',
    desc: '查发票及其勾稽情况（开了多少票、收了多少钱、是否已收款未开票）。',
    params: {
      project: { type: 'string', desc: '限定项目（名称关键词）' },
      direction: { type: 'string', enum: ['in', 'out'], desc: 'in=进项（收到的票），out=销项（开出的票）' },
      limit: { type: 'integer', desc: '最多返回几条，默认 20' },
    },
  },
  {
    name: 'list_expenses',
    desc: '查项目费用明细（实际成本）。分析成本超支、看钱花在哪了用这个。',
    params: {
      project: { type: 'string', desc: '限定项目（名称关键词）' },
      category: { type: 'string', desc: '费用科目，如 材料设备、人工费、分包费' },
      unpaid_only: { type: 'boolean', desc: '只看还没付的' },
      limit: { type: 'integer', desc: '最多返回几条，默认 30' },
    },
  },
  {
    name: 'list_partners',
    desc: '查往来单位（客户/供应商）及其往来金额汇总。',
    params: {
      keyword: { type: 'string', desc: '单位名称关键词' },
      limit: { type: 'integer', desc: '最多返回几条，默认 20' },
    },
  },
  {
    name: 'summary',
    desc: '做汇总统计，适合回答"按负责人/分类/月份分别是多少"这类对比问题。',
    params: {
      dimension: { type: 'string', enum: ['manager', 'category', 'status', 'month', 'partner'], desc: '按什么分组' },
      metric: { type: 'string', enum: ['contract_in', 'contract_out', 'paid_in', 'paid_out', 'cost', 'receivable', 'count'], desc: '统计什么口径' },
    },
  },
];

/** 把工具定义转成 OpenAI 的 function calling 格式 */
function openAiTools (withWrite) {
  return (withWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS).map(t => {
    const props = {};
    const required = [];
    for (const [k, v] of Object.entries(t.params)) {
      const p = { type: v.type === 'integer' ? 'integer' : v.type === 'boolean' ? 'boolean' : 'string' };
      if (v.desc) p.description = v.desc;
      if (v.enum) p.enum = v.enum;
      props[k] = p;
      if (v.required) required.push(k);
    }
    return {
      type: 'function',
      function: {
        name: t.name,
        description: t.desc,
        parameters: { type: 'object', properties: props, required },
      },
    };
  });
}

/** Claude 的工具格式 */
function anthropicTools (withWrite) {
  return (withWrite ? [...TOOLS, ...WRITE_TOOLS] : TOOLS).map(t => {
    const props = {};
    const required = [];
    for (const [k, v] of Object.entries(t.params)) {
      const p = { type: v.type === 'integer' ? 'integer' : v.type === 'boolean' ? 'boolean' : 'string' };
      if (v.desc) p.description = v.desc;
      if (v.enum) p.enum = v.enum;
      props[k] = p;
      if (v.required) required.push(k);
    }
    return { name: t.name, description: t.desc, input_schema: { type: 'object', properties: props, required } };
  });
}

const TOOL_LABEL = {
  search_projects: '项目台账', get_project_detail: '项目详情', list_contracts: '合同',
  list_payments: '收付款流水', list_schedules: '收付款计划', list_invoices: '发票',
  list_expenses: '项目费用', list_partners: '往来单位', summary: '汇总统计',
};

/** 权限不足时统一的返回 */
const NO_PERM = (t) => ({ error: `没有查看「${t}」的权限，无法提供这部分数据` });

/**
 * 执行一个工具调用。
 * 注意：这里必须自己再做一次权限校验 —— 模型并不知道谁能看什么，
 * 它只看得到「有哪些工具」，不能让它越权取数。
 */
function executeTool (name, args, perms) {
  const can = (t) => !!(perms && (perms.all || (perms.read || []).includes(t)));
  const a = args || {};
  const lim = (v, d, max = 200) => Math.max(1, Math.min(max, parseInt(v, 10) || d));
  const like = (v) => `%${String(v).trim()}%`;
  const num2 = (v) => (v === null || v === undefined ? 0 : Math.round(Number(v) * 100) / 100);
  const W = (v) => Math.round(num2(v) / 100) / 100;      // 元 → 万元，保留两位
  const db = dbf.db;

  /** 按项目名关键词取项目 id 列表 */
  const projectIds = (kw) => {
    if (!kw) return null;
    const rows = db.prepare('SELECT id FROM projects WHERE name LIKE ? OR code LIKE ?').all(like(kw), like(kw));
    return rows.map(r => r.id);
  };
  const inIds = (ids) => (ids && ids.length ? ` AND project_id IN (${ids.map(() => '?').join(',')})` : (ids ? ' AND 1=0' : ''));

  switch (name) {
    case 'search_projects': {
      if (!can('projects')) return NO_PERM('项目台账');
      const where = []; const ps = [];
      if (a.keyword) { where.push('(name LIKE ? OR code LIKE ?)'); ps.push(like(a.keyword), like(a.keyword)) }
      if (a.status) { where.push('status = ?'); ps.push(a.status) }
      if (a.manager) { where.push('manager LIKE ?'); ps.push(like(a.manager)) }
      if (a.category) { where.push('category LIKE ?'); ps.push(like(a.category)) }
      const rows = db.prepare(`SELECT id, code, name, status, category, manager, progress, location, start_date, end_date
        FROM projects ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...ps, lim(a.limit, 20));
      if (!rows.length) return { found: 0, hint: '没有匹配的项目，换个关键词试试' };
      return { found: rows.length, projects: rows };
    }

    case 'get_project_detail': {
      if (!can('projects')) return NO_PERM('项目台账');
      if (!a.project) return { error: '请提供项目名称' };
      const p = db.prepare('SELECT * FROM projects WHERE name LIKE ? OR code LIKE ? ORDER BY id DESC LIMIT 1').get(like(a.project), like(a.project));
      if (!p) return { found: 0, hint: `没找到匹配「${a.project}」的项目` };
      const st = dbf.projectStatsMany([p.id])[p.id] || {};
      const out = { project: { id: p.id, code: p.code, name: p.name, status: p.status, manager: p.manager, progress: p.progress } };
      // 逐项按权限给，避免越权泄漏
      if (can('contracts')) {
        out.contracts = { 收入合同额万元: W(st.contract_in), 支出合同额万元: W(st.contract_out), 待收万元: W(st.contract_in - st.paid_in) };
        out.contract_list = db.prepare('SELECT code, name, direction, amount, status, sign_date FROM contracts WHERE project_id = ? ORDER BY id').all(p.id)
          .map(c => ({ ...c, amount: W(c.amount) }));
      }
      if (can('payments')) out.payments_summary = { 已收款万元: W(st.paid_in), 已付款万元: W(st.paid_out), 回款率: st.collect_rate };
      if (can('invoices')) out.invoices_summary = { 已开票万元: W(st.inv_out), 已收票万元: W(st.inv_in) };
      if (can('expenses')) out.cost = { 实际成本万元: W(st.cost), 动态毛利万元: W(st.actual_profit), 毛利率: st.actual_rate, 成本执行率: st.cost_used_rate };
      if (can('schedules')) {
        // status / paid_amount / remaining 都是 decorateSchedules 算出来的虚拟列，不能直接 SELECT
        const raw = db.prepare('SELECT id, direction, phase, amount, due_date, project_id, contract_id FROM schedules WHERE project_id = ? ORDER BY due_date').all(p.id);
        const dec = dbf.decorateSchedules(raw);
        const t = dbf.today();
        out.schedules = dec.slice(0, 20).map(s => ({
          direction: s.direction, phase: s.phase, 计划万元: W(s.amount),
          已冲抵万元: W(s.paid_amount), 未收付万元: W(s.remaining),
          到期日: s.due_date, 状态: s.status,
          逾期天数: s.due_date && s.due_date < t && num2(s.remaining) > 0
            ? Math.round((new Date(t) - new Date(s.due_date)) / 86400000) : 0,
        }));
      }
      return out;
    }

    case 'list_contracts': {
      if (!can('contracts')) return NO_PERM('合同台账');
      const ids = projectIds(a.project);
      const where = []; const ps = [];
      if (ids) { where.push(`project_id IN (${ids.map(() => '?').join(',')})`); ps.push(...ids) }
      if (a.direction) { where.push('direction = ?'); ps.push(a.direction) }
      if (a.status) { where.push('status = ?'); ps.push(a.status) }
      const rows = db.prepare(`SELECT id, code, name, direction, amount, status, sign_date, payment_terms, project_id
        FROM contracts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY amount DESC LIMIT ?`).all(...ps, lim(a.limit, 20));
      const pn = projectNameMap();
      return { found: rows.length, contracts: rows.map(r => ({ ...r, project: pn[r.project_id] || '', amount: W(r.amount) })) };
    }

    case 'list_payments': {
      if (!can('payments')) return NO_PERM('收付款');
      const ids = projectIds(a.project);
      const where = []; const ps = [];
      if (ids) { where.push(`project_id IN (${ids.map(() => '?').join(',')})`); ps.push(...ids) }
      if (a.direction) { where.push('direction = ?'); ps.push(a.direction) }
      if (a.date_from) { where.push('pay_date >= ?'); ps.push(a.date_from) }
      if (a.date_to) { where.push('pay_date <= ?'); ps.push(a.date_to) }
      const rows = db.prepare(`SELECT id, direction, kind, amount, pay_date, method, voucher_no, project_id
        FROM payments ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY pay_date DESC, id DESC LIMIT ?`).all(...ps, lim(a.limit, 30));
      const pn = projectNameMap();
      const sum = rows.reduce((s, r) => s + num2(r.amount), 0);
      return {
        found: rows.length, 合计万元: W(sum),
        payments: rows.map(r => ({ ...r, project: pn[r.project_id] || '', amount: W(r.amount) })),
      };
    }

    case 'list_schedules': {
      if (!can('schedules')) return NO_PERM('收付款计划');
      const ids = projectIds(a.project);
      const where = []; const ps = [];
      if (ids) { where.push(`s.project_id IN (${ids.map(() => '?').join(',')})`); ps.push(...ids) }
      if (a.direction) { where.push('s.direction = ?'); ps.push(a.direction) }
      const raw = db.prepare(`SELECT s.id, s.direction, s.phase, s.amount, s.due_date, s.project_id, s.contract_id
        FROM schedules s ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.due_date ASC LIMIT 400`).all(...ps);
      const decorated = dbf.decorateSchedules(raw.map(r => ({ ...r })));
      const t = dbf.today();
      const pn = projectNameMap();
      let list = decorated.map(r => ({
        direction: r.direction, phase: r.phase, 计划万元: W(r.amount),
        已冲抵万元: W(r.paid_amount), 未收付万元: W(r.remaining),
        到期日: r.due_date, 状态: r.status, 逾期天数: r.due_date && r.due_date < t && num2(r.remaining) > 0
          ? Math.round((new Date(t) - new Date(r.due_date)) / 86400000) : 0,
        project: pn[r.project_id] || '',
      }));
      if (a.overdue_only) list = list.filter(x => x.逾期天数 > 0);
      list = list.filter(x => x.未收付万元 > 0).slice(0, lim(a.limit, 30));
      return { found: list.length, schedules: list };
    }

    case 'list_invoices': {
      if (!can('invoices')) return NO_PERM('发票');
      const ids = projectIds(a.project);
      const where = []; const ps = [];
      if (ids) { where.push(`project_id IN (${ids.map(() => '?').join(',')})`); ps.push(...ids) }
      if (a.direction) { where.push('direction = ?'); ps.push(a.direction) }
      const raw = db.prepare(`SELECT id, invoice_no, direction, invoice_type, issue_date, total_amount, status, project_id, contract_id
        FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY issue_date DESC, id DESC LIMIT ?`).all(...ps, lim(a.limit, 20));
      const dec = dbf.decorateInvoices(raw.map(r => ({ ...r })));
      const pn = projectNameMap();
      return {
        found: dec.length,
        invoices: dec.map(r => ({
          invoice_no: r.invoice_no, direction: r.direction, 类型: r.invoice_type,
          开票日期: r.issue_date, 价税合计万元: W(r.total_amount), 状态: r.status,
          已收款万元: W(r.paid_amount), 未收万元: W(r.unpaid_amount), project: pn[r.project_id] || '',
        })),
      };
    }

    case 'list_expenses': {
      if (!can('expenses')) return NO_PERM('项目费用');
      const ids = projectIds(a.project);
      const where = []; const ps = [];
      if (ids) { where.push(`project_id IN (${ids.map(() => '?').join(',')})`); ps.push(...ids) }
      if (a.category) { where.push('category LIKE ?'); ps.push(like(a.category)) }
      if (a.unpaid_only) where.push("status = '未付'");
      const rows = db.prepare(`SELECT id, name, category, amount, expense_date, status, has_invoice, project_id
        FROM expenses ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY amount DESC LIMIT ?`).all(...ps, lim(a.limit, 30));
      const pn = projectNameMap();
      const sum = rows.reduce((s, r) => s + num2(r.amount), 0);
      return {
        found: rows.length, 合计万元: W(sum),
        expenses: rows.map(r => ({ ...r, project: pn[r.project_id] || '', amount: W(r.amount) })),
      };
    }

    case 'list_partners': {
      if (!can('partners')) return NO_PERM('往来单位');
      const where = a.keyword ? 'WHERE name LIKE ? OR contact LIKE ?' : '';
      const ps = a.keyword ? [like(a.keyword), like(a.keyword)] : [];
      const rows = db.prepare(`SELECT id, name, type, contact, phone FROM partners ${where} ORDER BY id DESC LIMIT ?`).all(...ps, lim(a.limit, 20));
      const out = rows.map(p => {
        const o = { name: p.name, type: p.type, contact: p.contact };
        // 往来金额也要按权限给
        if (can('contracts')) {
          const c = db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) a FROM contracts WHERE partner_id = ?").get(p.id);
          o['合同额万元'] = W(c.a);
        }
        if (can('payments')) {
          const q = db.prepare("SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE 0 END),0) a FROM payments WHERE project_id IN (SELECT id FROM projects WHERE client_id = ?)").get(p.id);
          o['已收款万元'] = W(q.a);
        }
        return o;
      });
      return { found: out.length, partners: out };
    }

    case 'summary': {
      const dim = a.dimension || 'manager';
      const metric = a.metric || 'contract_in';
      // 维度白名单，绝不把用户输入直接拼进 SQL
      const DIM = {
        manager: { sql: 'p.manager', from: 'contracts c JOIN projects p ON p.id = c.project_id', extra: "c.direction='in'" },
        category: { sql: 'p.category', from: 'projects p', extra: '', isProject: true },
        status: { sql: 'p.status', from: 'projects p', extra: '', isProject: true },
        partner: { sql: 'pa.name', from: 'payments c JOIN projects p ON p.id = c.project_id JOIN partners pa ON pa.id = p.client_id', extra: '' },
        month: { sql: "substr(c.pay_date,1,7)", from: 'payments c', extra: '' },
      };
      const d = DIM[dim];
      if (!d) return { error: '不支持的汇总维度' };

      // 权限：不同口径归属不同模块
      const needTable = metric === 'cost' ? 'expenses'
        : (metric === 'paid_in' || metric === 'paid_out' || metric === 'receivable') ? 'payments'
          : 'contracts';
      if (!can(needTable)) return NO_PERM(needTable === 'expenses' ? '项目费用' : needTable === 'payments' ? '收付款' : '合同台账');

      if (d.isProject) {
        const rows = db.prepare(`SELECT ${d.sql} AS k, COUNT(*) AS n FROM ${d.from} GROUP BY ${d.sql} ORDER BY n DESC LIMIT 30`).all();
        return { dimension: dim, rows: rows.map(r => ({ [dim]: r.k || '未设置', 项目数: r.n })) };
      }
      const COLS = {
        contract_in: "COALESCE(SUM(CASE WHEN c.direction='in' THEN c.amount ELSE 0 END),0)",
        contract_out: "COALESCE(SUM(CASE WHEN c.direction='out' THEN c.amount ELSE 0 END),0)",
        paid_in: "COALESCE(SUM(CASE WHEN c.direction='in' THEN c.amount ELSE 0 END),0)",
        paid_out: "COALESCE(SUM(CASE WHEN c.direction='out' THEN c.amount ELSE 0 END),0)",
        cost: 'COALESCE(SUM(c.amount),0)',
        receivable: "COALESCE(SUM(CASE WHEN c.direction='in' THEN c.amount ELSE 0 END),0)",
        count: 'COUNT(*)',
      };
      const col = COLS[metric];
      if (!col) return { error: '不支持的统计口径' };
      if (metric === 'cost' && dim !== 'month') return { error: '成本只能按月汇总' };
      const extra = d.extra ? `WHERE ${d.extra}` : '';
      const rows = db.prepare(`SELECT ${d.sql} AS k, ${col} AS v, COUNT(*) AS n FROM ${d.from} ${extra} GROUP BY ${d.sql} ORDER BY v DESC LIMIT 30`).all();
      return {
        dimension: dim, metric,
        rows: rows.map(r => ({
          [dim]: r.k || '未设置',
          ...(metric === 'count' ? { 笔数: r.n } : { 万元: W(r.v), 笔数: r.n }),
        })),
      };
    }

    default:
      return { error: `未知工具：${name}` };
  }
}

/** 项目 id → 名称，工具结果里带上名字模型才好引用 */
let _pnCache = null;
let _pnAt = 0;
function projectNameMap () {
  if (_pnCache && Date.now() - _pnAt < 5000) return _pnCache;
  const m = {};
  for (const r of dbf.db.prepare('SELECT id, name FROM projects').all()) m[r.id] = r.name;
  _pnCache = m; _pnAt = Date.now();
  return m;
}

/* ==================== 每日经营简报 ==================== */

const BRIEF_DIR = path.join(DATA_DIR, 'briefings');
const flights = new Map();                 // 同一份简报同时只生成一次，避免并发烧钱

/** 权限签名：不同权限看到的数据不同，缓存要分开，否则会串数据 */
function permsSig (perms) {
  if (!perms) return 'none';
  if (perms.all) return 'all';
  const s = [...(perms.read || [])].sort().join(',');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return 'r' + (h >>> 0).toString(36);
}

const BRIEF_PROMPT = [
  '请根据我提供的经营数据，写一份**今天的经营简报**，直接给我正文，不要开场白。',
  '',
  '格式要求（严格照做）：',
  '1. 第一行一句话总述当前经营状态，带最关键的两个数字。',
  '2. 然后列 **3 条**最该关注的事，每条格式：',
  '   **【标题】** 一句话说明问题和数字依据，再说一句今天或本周可以做的具体动作。',
  '3. 最后一行：`一句话判断：` 加上你对整体风险的判断（好/一般/需要警惕）。',
  '',
  '要求：总长控制在 250 字以内；只用我提供的数据，不要编数字；语气像给老板汇报，不要客套。',
].join('\n');

/**
 * 取今天的经营简报（生成一次后当天复用）。
 * @param {object} perms 当前用户权限
 * @param {object} [opts] {force:true} 强制重新生成
 */
async function getBriefing (perms, opts = {}) {
  const cfg = getConfig();
  const day = dbf.today();
  const sig = permsSig(perms);
  const file = path.join(BRIEF_DIR, `${day}-${sig}.json`);

  if (!opts.force) {
    try {
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        return { ...saved, cached: true };
      }
    } catch { /* 缓存坏了就重新生成 */ }
  }

  if (!cfg.enabled || !cfg.apiKey) {
    return {
      available: false, day,
      reason: cfg.enabled ? '还没填 API 密钥' : 'AI 助手还没启用',
      hint: '到「系统设置 → 智能助手」里配好并启用，每天会自动生成一份经营简报',
    };
  }

  // 已有同一天的生成任务在跑就直接等它，别重复调用模型
  const key = day + '-' + sig;
  if (flights.has(key)) return flights.get(key);

  const job = (async () => {
    const ctl = new AbortController();
    // 简报是打开首页时顺带生成的，不能让用户干等
    const timer = setTimeout(() => ctl.abort(), 90000);
    try {
      const out = await chatStream({
        perms,
        question: BRIEF_PROMPT,
        messages: [],
        signal: ctl.signal,
        onDelta: null,
      });
      const payload = {
        available: true, day, text: out.text.trim(),
        generatedAt: dbf.nowISO(),
        model: cfg.model,
        provider: (PROVIDERS[cfg.provider] || {}).label || cfg.provider,
        usage: out.usage || null,
      };
      try {
        fs.mkdirSync(BRIEF_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(payload), 'utf8');
      } catch { /* 存不下就下次再生成 */ }
      return { ...payload, cached: false };
    } finally {
      clearTimeout(timer);
      flights.delete(key);
    }
  })();

  flights.set(key, job);
  return job;
}

/** 清掉旧简报（保留最近 60 天） */
function pruneBriefings (keepDays = 60) {
  try {
    if (!fs.existsSync(BRIEF_DIR)) return 0;
    const cut = new Date(Date.now() - keepDays * 86400000);
    const pad = (n) => String(n).padStart(2, '0');
    const cutStr = `${cut.getFullYear()}-${pad(cut.getMonth() + 1)}-${pad(cut.getDate())}`;
    let n = 0;
    for (const f of fs.readdirSync(BRIEF_DIR)) {
      const m = /^(\d{4}-\d{2}-\d{2})-/.exec(f);
      if (m && m[1] < cutStr) { try { fs.unlinkSync(path.join(BRIEF_DIR, f)); n++ } catch { /* 忽略 */ } }
    }
    return n;
  } catch { return 0; }
}

/* ==================== 简报推送（每天定时发到群/微信） ==================== */

const crypto = require('node:crypto');

/**
 * 支持五种推送方式，都是简单的 HTTP POST：
 *   wecom      企业微信群机器人      （群里每个人都能看到，最常用）
 *   dingtalk   钉钉群机器人          （支持加签）
 *   feishu     飞书群机器人
 *   serverchan Server酱              （推到你个人微信，需要 SendKey）
 *   pushplus   PushPlus              （推到你个人微信，需要 token）
 *   custom     自定义 webhook        （自建服务或其他平台）
 */
const PUSH_TYPES = {
  wecom: { label: '企业微信群机器人', hint: '群设置 → 群机器人 → 添加 → 复制 Webhook 地址', need: ['url'], urlHint: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' },
  dingtalk: { label: '钉钉群机器人', hint: '群设置 → 智能群助手 → 添加机器人 → 自定义，安全设置建议选「加签」', need: ['url'], urlHint: 'https://oapi.dingtalk.com/robot/send?access_token=...' },
  feishu: { label: '飞书群机器人', hint: '群设置 → 群机器人 → 添加 → 自定义机器人', need: ['url'], urlHint: 'https://open.feishu.cn/open-apis/bot/v2/hook/...' },
  serverchan: { label: 'Server酱（推到个人微信）', hint: '到 sct.ftqq.com 微信扫码登录，复制 SendKey', need: ['key'], urlHint: 'SCT...' },
  pushplus: { label: 'PushPlus（推到个人微信）', hint: '到 pushplus.plus 微信扫码登录，复制 token', need: ['key'], urlHint: '你的 token' },
  custom: { label: '自定义 Webhook', hint: 'POST 一个 JSON：{title, content, text}', need: ['url'], urlHint: 'https://你自己的服务/notify' },
};

/** 钉钉加签：sign = base64(hmacSHA256(secret, timestamp + "\n" + secret)) */
function dingSign (secret, timestamp) {
  const s = crypto.createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
  return encodeURIComponent(s);
}

/** 按平台组装请求 */
function buildPushRequest (ch, title, md) {
  switch (ch.type) {
    case 'wecom':
      return {
        url: ch.url,
        body: { msgtype: 'markdown', markdown: { content: `**${title}**\n${md}` } },
      };
    case 'dingtalk': {
      let url = ch.url;
      if (ch.secret) {
        const ts = Date.now();
        url += `&timestamp=${ts}&sign=${dingSign(ch.secret, ts)}`;
      }
      return { url, body: { msgtype: 'markdown', markdown: { title, text: `### ${title}\n\n${md}` } } };
    }
    case 'feishu':
      return { url: ch.url, body: { msg_type: 'text', content: { text: `${title}\n\n${md}` } } };
    case 'serverchan':
      return {
        url: `https://sctapi.ftqq.com/${encodeURIComponent(ch.key)}.send`,
        body: { title, desp: md },
      };
    case 'pushplus':
      return {
        url: 'https://www.pushplus.plus/send',
        body: { token: ch.key, title, content: md, template: 'markdown' },
      };
    case 'custom':
      return { url: ch.url, body: { title, content: md, text: `${title}\n\n${md}` } };
    default:
      throw new Error('不支持的推送方式：' + ch.type);
  }
}

/** 发一条到指定渠道 */
async function sendPush (ch, title, md) {
  if (!ch || !ch.type) throw new Error('推送渠道没有配置');
  const def = PUSH_TYPES[ch.type];
  if (!def) throw new Error('不支持的推送方式：' + ch.type);
  for (const k of def.need) {
    if (!ch[k]) throw new Error(`${def.label} 缺少 ${k === 'url' ? 'Webhook 地址' : '密钥'}`);
  }
  const { url, body } = buildPushRequest(ch, title, md);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const txt = (await res.text()).slice(0, 300);
    if (!res.ok) throw new Error(`${def.label} 返回 HTTP ${res.status}：${txt}`);
    // 企业微信/钉钉出错时也返回 200，要靠 body 里的 errcode 判断
    try {
      const j = JSON.parse(txt);
      if (j.errcode && j.errcode !== 0) throw new Error(`${def.label} 报错（${j.errcode}）：${j.errmsg || txt}`);
      if (j.code && j.code !== 0 && j.code !== 200) throw new Error(`${def.label} 报错（${j.code}）：${j.message || txt}`);
    } catch (e) {
      if (e.message.includes(def.label)) throw e;      // 上面主动抛的
    }
    return { ok: true, detail: txt.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** 读推送配置 */
function getPushConfig () {
  const cfg = getConfig();
  const p = cfg.push || {};
  return {
    enabled: false, time: '08:30', channels: [], lastSent: '',
    ...p,
  };
}

function savePushConfig (patch, perms) {
  if (perms && !auth.canSys(perms, 'settings')) {
    const e = new Error('没有修改系统设置的权限');
    e.status = 403;
    throw e;
  }
  const cur = getPushConfig();
  const next = { ...cur };
  if (patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch.time !== undefined && /^\d{1,2}:\d{2}$/.test(String(patch.time))) next.time = String(patch.time);
  if (Array.isArray(patch.channels)) {
    next.channels = patch.channels
      .filter(c => c && c.type && PUSH_TYPES[c.type])
      .map(c => ({
        type: c.type,
        url: String(c.url || '').trim(),
        key: String(c.key || '').trim(),
        secret: String(c.secret || '').trim(),
        label: String(c.label || '').trim().slice(0, 30) || PUSH_TYPES[c.type].label,
      }));
  }
  // 只写 push 这一段，别动 AI 的主配置
  const full = getConfig();
  full.push = next;
  delete full.protocol;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(full, null, 2), 'utf8');
  return next;
}

/**
 * 到点就推今天的简报。
 * 由 server.js 的定时器每隔一段时间调一次，靠 lastSent 记住今天发过没有。
 */
async function maybePushDaily () {
  const p = getPushConfig();
  if (!p.enabled || !p.channels.length) return { sent: false, reason: '未启用推送或没有配渠道' };
  const day = dbf.today();
  if (p.lastSent === day) return { sent: false, reason: '今天已经推过了', day };

  // 还没到点就等
  const now = new Date();
  const [hh, mm] = p.time.split(':').map(Number);
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0);
  if (now < due) return { sent: false, reason: `还没到 ${p.time}` };

  // 推送用管理员视角（webhook 收到的是完整经营数据，配置时界面已提示）
  const b = await getBriefing({ all: true, read: [], write: [], sys: [] });
  if (!b.available) return { sent: false, reason: b.reason || '简报不可用' };

  const title = `${day} 经营简报`;
  const results = [];
  for (const ch of p.channels) {
    try {
      const r = await sendPush(ch, title, b.text || '');
      results.push({ type: ch.type, label: ch.label, ok: true, detail: r.detail });
    } catch (e) {
      results.push({ type: ch.type, label: ch.label, ok: false, error: e.message });
    }
  }
  if (results.some(r => r.ok)) {
    p.lastSent = day;
    savePushConfig({ lastSent: day });
  }
  return { sent: results.some(r => r.ok), day, results };
}

/** 立刻试推一次（测试按钮用） */
async function pushNow (perms) {
  const p = getPushConfig();
  if (!p.channels.length) { const e = new Error('还没有配置推送渠道'); e.status = 400; throw e; }
  const b = await getBriefing({ all: true, read: [], write: [], sys: [] }, { force: false });
  if (!b.available) { const e = new Error(b.reason || '简报不可用，先把 AI 配好'); e.status = 400; throw e; }
  const title = `${b.day} 经营简报`;
  const results = [];
  for (const ch of p.channels) {
    try {
      const r = await sendPush(ch, title, b.text || '');
      results.push({ type: ch.type, label: ch.label, ok: true, detail: r.detail });
    } catch (e) {
      results.push({ type: ch.type, label: ch.label, ok: false, error: e.message });
    }
  }
  return { ok: results.some(r => r.ok), results, preview: b.text };
}

/* ==================== 写入工具（只生成方案，不直接落库） ==================== */

/**
 * 这组工具不写库，只生成一份「待确认的录入方案」。
 * 前端把方案渲染成确认卡片，用户点「确认」才会真正写入。
 *
 * 为什么不让 AI 直接写：
 *   - 它可能把金额、日期理解错，直接落库就脏了
 *   - 业务系统里「谁改的、改了什么、对不对」比「快」重要
 */
const WRITE_TOOLS = [
  {
    name: 'create_project',
    desc: '录入一个新项目。只在用户明确要求「新建/录入/登记一个项目」时调用。',
    write: 'projects',
    label: '项目',
    params: {
      name: { type: 'string', desc: '项目名称', required: true },
      code: { type: 'string', desc: '项目编号，如 RD-2026-001' },
      client: { type: 'string', desc: '甲方单位名称（系统里已有的）' },
      category: { type: 'string', desc: '子系统类别，如 综合布线、安防监控' },
      status: { type: 'string', enum: ['未开工', '进行中', '已完工', '结算中'] },
      manager: { type: 'string', desc: '项目经理姓名' },
      location: { type: 'string', desc: '项目地点' },
      start_date: { type: 'string', desc: '开工日期 YYYY-MM-DD' },
      end_date: { type: 'string', desc: '竣工日期 YYYY-MM-DD' },
      remark: { type: 'string', desc: '备注' },
    },
  },
  {
    name: 'create_contract',
    desc: '录入一份合同。用户说「签了个合同」「录入合同」时用。金额单位是元。',
    write: 'contracts',
    label: '合同',
    params: {
      name: { type: 'string', desc: '合同名称', required: true },
      project: { type: 'string', desc: '所属项目（名称关键词或 id）', required: true },
      amount: { type: 'integer', desc: '合同金额（元，含税）', required: true },
      direction: { type: 'string', enum: ['in', 'out'], desc: 'in=收入合同（我方收钱），out=支出合同（我方付钱）' },
      partner: { type: 'string', desc: '对方单位名称（系统里已有的）' },
      code: { type: 'string', desc: '合同编号' },
      category: { type: 'string', desc: '合同类别，如 项目合同、采购合同、分包合同' },
      sign_date: { type: 'string', desc: '签订日期 YYYY-MM-DD' },
      payment_terms: { type: 'string', desc: '付款条款，如「预付30%，验收65%，质保5%」' },
    },
  },
  {
    name: 'create_payment',
    desc: '录入一笔实际发生的收付款。用户说「收到一笔钱」「付了款」时用。',
    write: 'payments',
    label: '收付款',
    params: {
      project: { type: 'string', desc: '所属项目（名称关键词或 id）', required: true },
      amount: { type: 'integer', desc: '金额（元）', required: true },
      direction: { type: 'string', enum: ['in', 'out'], desc: 'in=收款，out=付款' },
      pay_date: { type: 'string', desc: '日期 YYYY-MM-DD' },
      kind: { type: 'string', desc: '款项性质，如 预付款、进度款、尾款' },
      method: { type: 'string', desc: '收付方式，如 银行转账、承兑汇票、现金' },
      contract: { type: 'string', desc: '关联合同（名称关键词）' },
      voucher_no: { type: 'string', desc: '凭证号' },
    },
  },
  {
    name: 'create_invoice',
    desc: '录入一张发票。金额单位是元。',
    write: 'invoices',
    label: '发票',
    params: {
      project: { type: 'string', desc: '所属项目（名称关键词或 id）', required: true },
      invoice_no: { type: 'string', desc: '发票号码', required: true },
      direction: { type: 'string', enum: ['in', 'out'], desc: 'out=销项（我开出去的），in=进项（我收到的）' },
      invoice_type: { type: 'string', desc: '发票种类，如 增值税专用发票、工程类增值税专用发票、劳务发票、普票' },
      issue_date: { type: 'string', desc: '开票日期 YYYY-MM-DD' },
      amount: { type: 'integer', desc: '金额（不含税，元）' },
      tax_rate: { type: 'number', desc: '税率，如 13、9、6、3' },
      tax_amount: { type: 'integer', desc: '税额（元）' },
      total_amount: { type: 'integer', desc: '价税合计（元）' },
      partner: { type: 'string', desc: '对方单位名称' },
      remark: { type: 'string', desc: '备注' },
    },
  },
  {
    name: 'create_expense',
    desc: '录入一笔项目费用（实际成本）。',
    write: 'expenses',
    label: '项目费用',
    params: {
      project: { type: 'string', desc: '所属项目（名称关键词或 id）', required: true },
      name: { type: 'string', desc: '费用名称/说明', required: true },
      amount: { type: 'integer', desc: '金额（元，含税）', required: true },
      category: { type: 'string', desc: '费用科目，如 材料设备、人工费、分包费、机械租赁' },
      expense_date: { type: 'string', desc: '发生日期 YYYY-MM-DD' },
      status: { type: 'string', enum: ['未付', '已付'] },
      has_invoice: { type: 'string', desc: '有票 / 无票' },
    },
  },
];

/** 写工具名 → 定义，方便查 */
const WRITE_TOOL_MAP = Object.fromEntries(WRITE_TOOLS.map(t => [t.name, t]));

/* ---- 待确认方案的暂存（只在内存里，10 分钟过期）---- */
const proposals = new Map();
const PROPOSAL_TTL = 10 * 60 * 1000;

function stashProposal (p) {
  const token = 'prop_' + crypto.randomBytes(8).toString('hex');
  proposals.set(token, { ...p, token, at: Date.now() });
  // 顺手清掉过期的
  for (const [k, v] of proposals) if (Date.now() - v.at > PROPOSAL_TTL) proposals.delete(k);
  return proposals.get(token);
}

function getProposal (token) {
  const p = proposals.get(token);
  if (!p) return null;
  if (Date.now() - p.at > PROPOSAL_TTL) { proposals.delete(token); return null; }
  return p;
}

/** 按名称或 id 找项目 */
function findProject (v) {
  if (v === undefined || v === null || String(v).trim() === '') return { error: '没有指定项目' };
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const r = dbf.db.prepare('SELECT id, name FROM projects WHERE id = ?').get(Number(s));
    return r ? { id: r.id, name: r.name } : { error: `找不到 id=${s} 的项目` };
  }
  const rows = dbf.db.prepare('SELECT id, name FROM projects WHERE name LIKE ? OR code LIKE ? ORDER BY id').all(`%${s}%`, `%${s}%`);
  if (!rows.length) return { error: `项目库里没有名字含「${s}」的项目，请先建项目或告诉我准确的名称` };
  return rows.length > 1
    ? { id: rows[0].id, name: rows[0].name, ambiguous: rows.slice(0, 5).map(r => r.name) }
    : { id: rows[0].id, name: rows[0].name };
}

/** 按名称或 id 找往来单位 */
function findPartner (v) {
  if (v === undefined || v === null || String(v).trim() === '') return { id: null };
  const s = String(v).trim();
  if (/^\d+$/.test(s)) {
    const r = dbf.db.prepare('SELECT id, name FROM partners WHERE id = ?').get(Number(s));
    return r ? { id: r.id, name: r.name } : { id: null, warning: `找不到 id=${s} 的单位` };
  }
  const rows = dbf.db.prepare('SELECT id, name FROM partners WHERE name LIKE ? ORDER BY id').all(`%${s}%`);
  if (!rows.length) return { id: null, warning: `单位库里没有「${s}」，已留空，需要的话请在表单里点＋新建` };
  return rows.length > 1
    ? { id: rows[0].id, name: rows[0].name, ambiguous: rows.slice(0, 5).map(r => r.name) }
    : { id: rows[0].id, name: rows[0].name };
}

/** 按名称找当前项目的合同 */
function findContract (v, projectId) {
  if (!v) return { id: null };
  const rows = dbf.db.prepare('SELECT id, name FROM contracts WHERE name LIKE ? ORDER BY id').all(`%${String(v).trim()}%`);
  if (!rows.length) return { id: null, warning: `没找到叫「${v}」的合同，已留空` };
  return { id: rows[0].id, name: rows[0].name };
}

const yuan = (v) => (Number(v) / 10000).toFixed(2) + ' 万元';

/**
 * 执行写入工具：**只生成方案**，不落库。
 * 返回给模型的是「已生成待确认方案」，让模型把这个方案讲给用户听。
 */
function proposeWrite (name, args, perms) {
  const def = WRITE_TOOL_MAP[name];
  if (!def) return { error: '未知的写入工具：' + name };
  const a = args || {};

  // 权限：写入必须单独有该表的写权限
  if (!auth.canWrite(perms, def.write)) {
    return { error: `没有录入「${def.label}」的权限，无法代你创建。可以请管理员开通。` };
  }

  const fields = {};
  const detail = [];
  const warnings = [];

  const set = (k, v, label) => {
    if (v === undefined || v === null || v === '') return;
    fields[k] = v;
    detail.push([label, v]);
  };

  switch (name) {
    case 'create_project': {
      set('name', a.name, '项目名称');
      set('code', a.code, '项目编号');
      set('category', a.category, '子系统类别');
      set('status', a.status || '进行中', '项目状态');
      set('manager', a.manager, '项目经理');
      set('location', a.location, '项目地点');
      set('start_date', a.start_date, '开工日期');
      set('end_date', a.end_date, '竣工日期');
      set('remark', a.remark, '备注');
      if (a.client) {
        const c = findPartner(a.client);
        if (c.id) { fields.client_id = c.id; detail.push(['甲方单位', c.name]); if (c.ambiguous) warnings.push(`「${a.client}」匹配到多个单位，先用了「${c.name}」`); }
        else warnings.push(c.warning);
      }
      break;
    }
    case 'create_contract': {
      const p = findProject(a.project);
      if (p.error) return { error: p.error };
      fields.project_id = p.id;
      detail.push(['所属项目', p.name]);
      if (p.ambiguous) warnings.push(`「${a.project}」匹配到多个项目，先用了「${p.name}」`);
      set('name', a.name, '合同名称');
      set('code', a.code, '合同编号');
      set('direction', a.direction || 'in', '收支方向（in=收入/out=支出）');
      if (a.amount !== undefined) { fields.amount = Number(a.amount); detail.push(['合同金额', yuan(a.amount)]); if (Number(a.amount) > 1e12) return { error: '金额看起来不对（超过 1 万亿），请核对' }; }
      set('category', a.category || '项目合同', '合同类别');
      set('sign_date', a.sign_date, '签订日期');
      set('payment_terms', a.payment_terms, '付款条款');
      set('status', '执行中', '合同状态');
      if (a.partner) {
        const c = findPartner(a.partner);
        if (c.id) { fields.partner_id = c.id; detail.push(['对方单位', c.name]); }
        else warnings.push(c.warning);
      }
      break;
    }
    case 'create_payment': {
      const p = findProject(a.project);
      if (p.error) return { error: p.error };
      fields.project_id = p.id;
      detail.push(['所属项目', p.name]);
      set('direction', a.direction || 'in', '方向（in=收款/out=付款）');
      if (a.amount !== undefined) { fields.amount = Number(a.amount); detail.push(['金额', yuan(a.amount)]); }
      set('pay_date', a.pay_date || dbf.today(), '日期');
      set('kind', a.kind, '款项性质');
      set('method', a.method, '收付方式');
      set('voucher_no', a.voucher_no, '凭证号');
      if (a.contract) { const c = findContract(a.contract, p.id); if (c.id) fields.contract_id = c.id; else warnings.push(c.warning); }
      break;
    }
    case 'create_invoice': {
      const p = findProject(a.project);
      if (p.error) return { error: p.error };
      fields.project_id = p.id;
      detail.push(['所属项目', p.name]);
      set('invoice_no', a.invoice_no, '发票号码');
      set('direction', a.direction || 'out', '方向（out=销项/in=进项）');
      set('invoice_type', a.invoice_type || '增值税专用发票', '发票种类');
      set('issue_date', a.issue_date, '开票日期');
      if (a.amount !== undefined) { fields.amount = Number(a.amount); detail.push(['不含税金额', yuan(a.amount)]); }
      if (a.tax_rate !== undefined) { fields.tax_rate = Number(a.tax_rate); detail.push(['税率', a.tax_rate + '%']); }
      if (a.tax_amount !== undefined) { fields.tax_amount = Number(a.tax_amount); detail.push(['税额', yuan(a.tax_amount)]); }
      if (a.total_amount !== undefined) { fields.total_amount = Number(a.total_amount); detail.push(['价税合计', yuan(a.total_amount)]); }
      set('status', '已开具', '状态');
      set('remark', a.remark, '备注');
      if (a.partner) {
        const c = findPartner(a.partner);
        if (c.id) { fields.partner_id = c.id; detail.push(['对方单位', c.name]); }
        else warnings.push(c.warning);
      }
      break;
    }
    case 'create_expense': {
      const p = findProject(a.project);
      if (p.error) return { error: p.error };
      fields.project_id = p.id;
      detail.push(['所属项目', p.name]);
      set('name', a.name, '费用名称');
      set('category', a.category, '费用科目');
      if (a.amount !== undefined) { fields.amount = Number(a.amount); detail.push(['金额', yuan(a.amount)]); }
      set('expense_date', a.expense_date || dbf.today(), '发生日期');
      set('status', a.status || '未付', '状态');
      set('has_invoice', a.has_invoice, '发票情况');
      break;
    }
    default:
      return { error: '未知工具' };
  }

  // 先干跑一遍，让必填校验在这里就拦下来（而不是用户点了确认才报错）
  try {
    const dry = dbf.dryRunRow(def.write, fields);
    if (dry && dry.error) return { error: '这些信息还填不进去：' + dry.error };
  } catch { /* dryRun 不可用就跳过，确认时还会再校验一次 */ }

  const summary = `新建${def.label}：` + detail.slice(0, 4).map(([k, v]) => `${k} ${v}`).join('｜');
  const prop = stashProposal({
    kind: 'create', table: def.write, tableLabel: def.label,
    fields, detail, warnings, summary,
  });

  return {
    __proposal: true,
    token: prop.token,
    summary: prop.summary,
    detail: prop.detail,
    warnings: prop.warnings,
    note: '已生成一份「待确认的录入方案」。请把它清楚地讲给用户听（有哪些字段、金额多少），'
      + '并告诉用户点确认后才会真正保存。不要说你已经录入完成了。',
  };
}

/** 用户点了确认之后，真正落库 */
function applyProposal (token, perms) {
  const p = getProposal(token);
  if (!p) return { error: '这份方案已经过期或不存在了，请重新让 AI 生成一次' };
  if (!auth.canWrite(perms, p.table)) return { error: `没有录入「${p.tableLabel}」的权限` };
  let r;
  try {
    r = dbf.insertRow(p.table, p.fields);
  } catch (e) {
    return { error: '保存失败：' + e.message };
  }
  if (r.error) return { error: r.error };
  proposals.delete(token);
  return { ok: true, table: p.table, tableLabel: p.tableLabel, id: r.id, row: dbf.getRow(p.table, r.id) };
}

module.exports = {
  PROVIDERS, QUICK_PROMPTS, TOOLS, TOOL_LABEL, PUSH_TYPES,
  WRITE_TOOLS, WRITE_TOOL_MAP, proposeWrite, applyProposal,
  getConfig, publicConfig, saveConfig,
  buildContext, chatStream, testConnection,
  executeTool, openAiTools, anthropicTools,
  rateCheck, getBriefing, pruneBriefings, permsSig,
  getPushConfig, savePushConfig, sendPush, maybePushDaily, pushNow,
  CONFIG_FILE, BRIEF_DIR,
};
