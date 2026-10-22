/**
 * 后端接口客户端
 * 后端（server.js）保持不变，这里只做一层薄封装。
 * 所有金额单位一律是「元」，展示时再换算。
 */

export interface Perms {
  all: boolean
  read: string[]
  write: string[]
  sys: string[]
}

/* ---------------- AI 助手 ---------------- */

export interface AiProvider {
  value: string
  label: string
  baseUrl: string
  models: string[]
  defaultModel: string
  keyUrl: string
  note: string
}

export interface AiConfig {
  enabled: boolean
  provider: string
  providerLabel: string
  baseUrl: string
  model: string
  includeContext: boolean
  useTools: boolean
  allowWrite: boolean
  temperature: number
  maxTokens: number
  hasKey: boolean
  keyHint: string
  canEdit: boolean
  providers?: AiProvider[]
  quick: { icon: string; text: string }[]
  ready: boolean
}

export interface AiTestResult {
  ok: boolean
  ms: number
  model: string
  provider: string
  reply: string
}

export interface AiPushChannel {
  type: string
  url?: string
  key?: string
  secret?: string
  label?: string
}

export interface AiPushConfig {
  enabled: boolean
  time: string
  channels: AiPushChannel[]
  lastSent?: string
  types?: { value: string; label: string; hint: string; need: string[]; urlHint: string }[]
  today?: string
}

export interface AiPushResult {
  ok: boolean
  results: { type: string; label: string; ok: boolean; detail?: string; error?: string }[]
  preview?: string
}

export interface AiBriefing {
  available: boolean
  day: string
  text?: string
  cached?: boolean
  generatedAt?: string
  model?: string
  provider?: string
  reason?: string
  hint?: string
}

/** 待补的必填字段（确认卡片上直接补，不用跳去表单） */
export interface AiEditableField {
  label: string
  kind: 'select' | 'text' | 'number'
  options?: { value: any; label: string }[]
}

/** AI 生成的「待确认录入方案」：点确认才会真正写库 */
export interface AiProposal {
  __proposal?: boolean
  token: string
  summary: string
  detail: [string, any][]
  warnings: string[]
  note?: string
  /** 必填但没填的字段（前端渲染成输入框/下拉） */
  missing?: { name: string; label: string; kind?: string; refTable?: string | null }[]
  /** 可补字段的说明：字段名 → 控件定义 */
  editable?: Record<string, AiEditableField>
  /** 本地状态：等待确认 / 已保存 / 已取消 / 出错 */
  state?: 'pending' | 'applied' | 'cancelled' | 'error'
  error?: string
  appliedId?: number
  linkedAttachments?: number
}

/** 「单据进件」的结果：上传一张发票/合同后，后端判断该录到哪张表 */
export interface AiIngestResult {
  ok: boolean
  /** pending/running=还在识别；propose=给了方案；import=表格引导去导入中心；none=认不出 */
  status?: 'pending' | 'running'
  action?: 'propose' | 'import' | 'none'
  /** propose 的来源：ingest=按字段映射，ai=模型判断，ingest-weak=置信度低的兜底 */
  source?: string
  proposal?: AiProposal
  table?: string | null
  /** 猜出来的目标表的显示名（表格引导用） */
  tableLabel?: string | null
  /** 表头前若干列 + 行数，让用户确认猜得对不对 */
  headers?: string[]
  rowCount?: number
  message?: string
  fields?: Record<string, any>
  hints?: Record<string, any>
  checks?: string[]
  attachment?: any
  needModel?: boolean
  needAllowWrite?: boolean
  modelSaid?: string
}

export interface AiMessage { role: 'user' | 'assistant'; content: string }

/** 流式对话的回调 */
export interface AiStreamHandlers {
  onStatus?: (text: string) => void
  onDelta?: (text: string) => void
  onUsage?: (usage: Record<string, number> | null, tools?: number) => void
  /** 模型正在查某个模块的明细（用于显示"正在查询：合同…"） */
  onTool?: (name: string, label: string) => void
  /** 模型生成了待确认的录入方案 */
  onProposal?: (p: AiProposal) => void
  signal?: AbortSignal
}

/** 系统设置：界面自定义（欢迎语、公司名、系统名称） */
/** 授权状态（离线校验出来的） */
export interface LicenseInfo {
  status: 'none' | 'invalid' | 'expired' | 'warn' | 'ok'
  company: string | null
  expiry: string | null
  daysLeft: number | null
  warnDays: number
  error: string | null
  /** 授权的账号数上限；0 = 不限 */
  seats: number
  /** 已启用的账号数 */
  usedSeats: number | null
  /** 已达账号数上限（不能新建账号了，已有账号照常用） */
  seatsExceeded: boolean
  /** 过期后只读 */
  readOnly: boolean
}
export interface AppSettings {
  company_name: string
  system_name: string
  welcome_morning: string
  welcome_afternoon: string
  welcome_evening: string
  welcome_subtitle: string
  /** 副标题模式：fixed=固定副标题，daily=每日随机打工人语录 */
  subtitle_mode: string
  /** 授权码。普通账号读到的永远是空串（后端会脱敏），别拿它判断有没有授权 */
  license_key: string
  /** 操作日志保留天数，字符串。'0' = 永久保留 */
  log_retention_days: string
  /** 备份异地存放：off=只留本地，share=局域网共享目录，minio=传到 MinIO */
  backup_remote: string
  /** 共享目录路径，形如 \\NAS\backup\elv-pms。普通账号读到空串 */
  backup_share: string
}
export interface User {
  id: number
  username: string
  name: string
  role: string
  status: string
  must_change_pw: boolean
  last_login_at?: string | null
  login_count: number
  perms: Perms
}

export interface FieldDef {
  name: string
  label: string
  type: 'text' | 'textarea' | 'number' | 'money' | 'percent' | 'date' | 'select' | 'multi' | 'ref'
  list?: boolean
  form?: boolean
  width?: number
  required?: boolean
  span?: number
  options?: (string | { value: string; label: string })[]
  refTable?: string
  calc?: boolean
  virtual?: boolean
  badge?: boolean
  danger?: boolean
  default?: string | number
  placeholder?: string
  hint?: string
  /** 表单专用的快捷录入字段：本身是虚拟列，填了由后端转成关联记录 */
  quick?: boolean
  /** 编辑时从哪里带出初始值（通常是某个虚拟列，如 contract_in） */
  prefillFrom?: string
  step?: number
}

export interface TableDef {
  label: string
  icon: string
  order: number
  display: string
  searchFields: string[]
  fields: FieldDef[]
}

export interface Meta {
  app: string
  version: string
  tables: Record<string, TableDef>
  order: string[]
  options: Record<string, { value: number; label: string }[]>
  dbFile: string
  dataDir: string
  port: number
  lan: string[]
  trashKeepDays: number
  /** 系统权限项清单（账号编辑页按它渲染勾选框，别在前端写死） */
  sysKeys: string[]
  upload: { maxMB: number; accept: string; ocrExt: string[]; attachDir: string }
}

export type Row = Record<string, any> & { id: number }

/** 通知公告行（首页右侧栏） */
export interface NoticeRow { title: string; tag: string; date: string; kind: string }

export interface ListResult {
  table: string
  rows: Row[]
  total: number
  sums: Record<string, number>
  with_attachments?: number
}

export interface Reminder {
  level: 'danger' | 'warn' | 'info'
  kind: string
  count?: number
  amount?: number
  title: string
  detail?: string
  href: string
}

/**
 * 首页汇总数字（/api/dashboard 的 totals）。
 *
 * ⚠️ 这里必须逐个字段列出来，**不能**写成 `Record<string, number>`。
 * 写成索引签名等于放弃了类型检查：前端写 `t.collect_rat`（少个 e）TS 一句话都不说，
 * 运行时就是 undefined，页面上那个数字直接空白，而且不报错 —— 最难查的一类问题。
 * 后端 tools/upgrade-test.js 里有一份 CORE 字段清单守着「字段别被误删」，
 * 这里守着「前端别读错名字」，两头夹住。
 *
 * 带 `| null` 的字段是「当前账号没有对应模块的读权限」时后端显式置空的，
 * 不是缺失。展示层一律走 `fmtWan(...)` 之类的空值兜底。
 */
export interface DashTotals {
  project_count: number
  project_active: number
  project_done: number
  contract_count: number | null
  contract_in: number | null
  contract_out: number | null
  contract_in_ex: number | null
  contract_out_ex: number | null
  contract_in_base: number
  contract_out_base: number
  change_in: number
  change_out: number
  change_count: number
  paid_in: number | null
  paid_out: number | null
  receivable: number | null
  payable: number | null
  payable_contract: number | null
  payable_expense: number
  gross_profit: number | null
  gross_rate: number | null
  inv_out: number
  inv_in: number
  material_amount: number
  material_count: number
  cost: number
  cost_ex: number
  cost_unpaid: number
  expense_count: number
  maint_count: number
  maint_open: number
  maint_cost: number
  payment_count: number
  invoice_count: number
  partner_count: number
  actual_profit: number
  actual_rate: number
  cost_over: number | null
  cost_used_rate: number | null
  collect_rate: number | null
  uninvoiced_out: number | null
  inv_out_paid: number
  inv_in_paid: number
  linked_count: number
  inv_out_unpaid: number
  inv_in_unpaid: number
  paid_in_no_inv: number
  paid_out_no_inv: number
  inv_cover_rate: number
  /** 由 server.js 在返回前补上的附件总数（不在 db.dashboard() 里） */
  attachment_count?: number
}

/** 权限不足时的空汇总，避免每处都写 `?? 0` */
export const EMPTY_TOTALS = {
  project_count: 0, project_active: 0, project_done: 0,
  contract_count: 0, contract_in: 0, contract_out: 0, contract_in_ex: 0, contract_out_ex: 0,
  contract_in_base: 0, contract_out_base: 0, change_in: 0, change_out: 0, change_count: 0,
  paid_in: 0, paid_out: 0, receivable: 0, payable: 0, payable_contract: 0, payable_expense: 0,
  gross_profit: 0, gross_rate: 0, inv_out: 0, inv_in: 0, material_amount: 0, material_count: 0,
  cost: 0, cost_ex: 0, cost_unpaid: 0, expense_count: 0, maint_count: 0, maint_open: 0,
  maint_cost: 0, payment_count: 0, invoice_count: 0, partner_count: 0,
  actual_profit: 0, actual_rate: 0, cost_over: 0, cost_used_rate: 0, collect_rate: 0,
  uninvoiced_out: 0, inv_out_paid: 0, inv_in_paid: 0, linked_count: 0, inv_out_unpaid: 0,
  inv_in_unpaid: 0, paid_in_no_inv: 0, paid_out_no_inv: 0, inv_cover_rate: 0,
  attachment_count: 0,
} as const satisfies DashTotals

/** 收付款计划的节点汇总（Dashboard.schedules.totals） */
export interface SchedTotals {
  node_count: number
  plan_in: number
  plan_out: number
  paid_in: number
  paid_out: number
  overdue_in: number
  overdue_out: number
  overdue_count: number
  remaining_in: number
  remaining_out: number
}

export const EMPTY_SCHED_TOTALS = {
  node_count: 0, plan_in: 0, plan_out: 0, paid_in: 0, paid_out: 0,
  overdue_in: 0, overdue_out: 0, overdue_count: 0, remaining_in: 0, remaining_out: 0,
} as const satisfies SchedTotals

export interface Dashboard {
  today: string
  this_month: string
  /** 本月收付款。没有 payments 读权限时后端给 null（前端别当成 0 显示） */
  month_in: number | null
  month_out: number | null
  totals: DashTotals
  by_status: Record<string, number>
  by_category: Record<string, { count: number; contract_in: number; gross_profit: number }>
  by_expense: Record<string, number>
  monthly: { ym: string; inflow: number; outflow: number }[]
  top_receivable: Row[]
  overdue: Row[]
  reminders: Reminder[]
  schedules: {
    totals: SchedTotals
    overdue: Row[]
    upcoming: { ym: string; plan_in: number; plan_out: number; unpaid_in: number; unpaid_out: number }[]
    month: { ym: string; unpaid_in: number } | null
    due_soon: Row[]
    buckets: { d7?: { count: number; amount: number }; d30?: { count: number; amount: number } }
    warranty_due: Row[]
  }
  aging: {
    receivable: Record<string, { count: number; amount: number }>
    payable: Record<string, { count: number; amount: number }>
    top_overdue: Row[]
  }
  trend: { ym: string; snapshot: boolean; contract_in: number | null; cost: number | null; receivable: number | null; actual_profit: number | null; paid_in: number | null }[]
  mom: null | { base_ym: string; contract_in: number | null; cost: number | null; paid_in: number | null; receivable: number | null; actual_profit: number | null }
  /** 本周收付款（周一到现在）—— 数据统计卡「本周」tab */
  week?: { in: number; out: number } | null
  /** 新签收入合同额（按签订日期）：本月 / 上月 / 本周 —— 数据统计卡第一个大数字 */
  new_contract?: { month: number; prev_month: number; week: number } | null
  /** 首页 2.0 六个小指标里缺的几个 */
  extra?: { staff?: number; new_projects?: number; todo_count?: number | null } | null
  /** 项目回款率排行 Top5 */
  collect_rank?: { id: number; name: string; rate: number }[]
}

export class ApiError extends Error {
  status: number
  data: any
  constructor(message: string, status: number, data: any) {
    super(message)
    this.status = status
    this.data = data
  }
}

/** 会话失效时由 App 注入的回调 */
let onUnauthorized: (() => void) | null = null
export function setUnauthorizedHandler(fn: (() => void) | null) { onUnauthorized = fn }

export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await res.text()
  let data: any = {}
  try { data = text ? JSON.parse(text) : {} } catch {
    throw new ApiError(`服务返回异常：${text.slice(0, 120)}`, res.status, null)
  }
  if (!res.ok) {
    if (res.status === 401 && data.needLogin && onUnauthorized) onUnauthorized()
    throw new ApiError(data.error || `请求失败 ${res.status}`, res.status, data)
  }
  return data as T
}

const post = <T = any>(path: string, body?: unknown) =>
  api<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

/**
 * 删除接口的返回。
 * `trashError` 非空 = 回收站没存下快照 —— 记录已经删了，但**还原不了**。
 * 这种情况下界面必须明说，不能还拿「30 天内可还原」当承诺。
 */
export interface DeleteResult {
  ok?: boolean
  deleted?: number
  removedAttachments?: number
  removedFiles?: number
  keptAttachments?: boolean
  trashId?: number | null
  trashError?: string | null
}

/**
 * 数据库结构升级的结果。
 * `error` 非空 = 库还停在旧版本（典型原因：升级前备份撞名，迁移被中止）。
 * 这种情况必须让用户看见 —— 继续录入可能缺字段。
 */
export interface DbMigration {
  version: number
  error: string | null
  backup: string | null
}

export const http = {
  /* 认证 */
  login: (username: string, password: string) => post<{ ok: boolean; user: User }>('/api/login', { username, password }),
  logout: () => post('/api/logout'),
  me: () => api<{ user: User; tables: string[]; sysKeys: string[]; settings: AppSettings; license: LicenseInfo; dbMigration?: DbMigration }>('/api/me'),
  /** 首页右侧栏「通知公告」 */
  notices: () => api<{ company: NoticeRow[]; holiday: NoticeRow[]; system: NoticeRow[] }>('/api/notices'),
  changePassword: (oldPw: string, newPw: string) => post('/api/me/password', { old: oldPw, new: newPw }),

  /* 元数据 / 总览 */
  meta: () => api<Meta>('/api/meta'),
  /** 系统设置（界面自定义） */
  settings: () => api<{ settings: AppSettings; defaults: AppSettings; license: LicenseInfo }>('/api/settings'),
  saveSettings: (settings: Partial<AppSettings>) =>
    post<{ ok: boolean; settings: AppSettings; saved: string[]; license?: LicenseInfo }>('/api/settings', { settings }),
  dashboard: () => api<Dashboard>('/api/dashboard'),
  search: (q: string) => api<{ hits: { table: string; tableLabel: string; icon: string; id: number; title: string; subtitle: string }[] }>(`/api/search?q=${encodeURIComponent(q)}`),

  /* 数据表 */
  list: (table: string, params: Record<string, string | number> = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined && v !== null) p.set(k, String(v))
    const qs = p.toString()
    return api<ListResult>(`/api/list/${table}${qs ? '?' + qs : ''}`)
  },
  get: (table: string, id: number | string) => api<Row>(`/api/get/${table}/${id}`),
  save: (table: string, body: Record<string, any>) => post<{ ok: boolean; id: number; row: Row; /** 后端顺带做的事，比如「已自动创建主合同」 */ note?: string }>(`/api/save/${table}`, body),
  remove: (table: string, id: number | string, body: Record<string, any> = {}) => post<DeleteResult>(`/api/delete/${table}/${id}`, body),
  batchDelete: (table: string, ids: number[], body: Record<string, any> = {}) => post<DeleteResult>('/api/batch-delete', { table, ids, ...body }),

  /* 项目 */
  project: (id: number | string) => api<any>(`/api/project/${id}`),
  statement: (id: number | string) => api<any>(`/api/statement/${id}`),
  generatePlan: (contractId: number | string, force = false) => post<any>(`/api/contract/${contractId}/plan`, { force }),
  backfillInvoices: () => post<any>('/api/invoices/backfill'),

  /* 账号 */
  users: () => api<{ rows: (User & { remark?: string; created_at?: string })[]; sysKeys: string[]; loginGuard: { ip: string; username: string; fails: number; locked: boolean; remainSec: number }[] }>('/api/users'),
  saveUser: (body: Record<string, any>) => post<{ ok: boolean; id: number }>('/api/users', body),
  deleteUser: (id: number) => post(`/api/users/${id}/delete`),
  resetPassword: (id: number) => post(`/api/users/${id}/reset`),
  unlock: (body: Record<string, any>) => post<{ ok: boolean; cleared: number }>('/api/users/unlock', body),

  /* 回收站 / 日志 */
  trash: () => api<{ rows: any[]; stats: { entries: number; rows: number; bytes: number } }>('/api/trash'),
  restore: (id: number) => post<{ ok: boolean; restored: number; skipped: number; reattached: number }>(`/api/trash/${id}/restore`),
  purge: (id: number) => post(`/api/trash/${id}/purge`),
  purgeAll: () => post<{ purged: number }>('/api/trash/purge-all'),
  logs: (params: Record<string, string | number> = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined) p.set(k, String(v))
    const qs = p.toString()
    return api<{ rows: any[]; total: number; stats: any }>(`/api/logs${qs ? '?' + qs : ''}`)
  },
  purgeLogs: (days: number) => post('/api/logs/purge', { days }),

  /* 系统 */
  dbstatus: () => api<any>('/api/dbstatus'),
  backup: () => post<{
    ok: boolean; file: string; size: number; format: string;
    /** pg_dump 不可用时降级为只含数据的 JSON（界面必须如实提示） */
    degraded?: boolean; pgDumpError?: string; restore?: string;
  }>('/api/backup'),
  snapshots: () => api<{ rows: any[]; keepMonths: number; currentYm: string }>('/api/snapshots'),
  captureSnapshot: (body: Record<string, any> = {}) => post('/api/snapshots/capture', body),
  deleteSnapshot: (ym: string) => post(`/api/snapshots/${ym}/delete`),
  clearDemo: () => post<{ removed: number }>('/api/demo/clear'),

  /* 附件 */
  attachments: (params: Record<string, string | number> = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined) p.set(k, String(v))
    const qs = p.toString()
    return api<{ rows: any[]; total: number; totalSize: number }>(`/api/attachments${qs ? '?' + qs : ''}`)
  },
  /** 单条附件（带识别原文和归一化文本；列表接口故意不带，太大） */
  attachment: (id: number | string) => api<any>(`/api/attachments/${id}`),
  recordAttachments: (table: string, id: number | string) => api<{ rows: any[]; total: number }>(`/api/record-attachments/${table}/${id}`),
  deleteAttachment: (id: number) => post(`/api/attachments/${id}/delete`),
  recognizeAttachment: (id: number) => post(`/api/attachments/${id}/recognize`),
  rematchAttachment: (id: number) => post(`/api/attachments/${id}/rematch`),
  upload: (file: File, fields: Record<string, string> = {}) => {
    const fd = new FormData()
    for (const [k, v] of Object.entries(fields)) fd.append(k, v)
    fd.append('file', file)
    return api<{ ok: boolean; attachment: any }>('/api/upload', { method: 'POST', body: fd })
  },

  /* 导入 */
  importMeta: () => api<any>('/api/import/meta'),
  importTemplateUrl: (table: string) => `/api/import/template/${table}`,
  runImport: (table: string, file: File, opts: { preview?: boolean; autoCreatePartners?: boolean } = {}) => {
    const fd = new FormData()
    fd.append('file', file)
    if (opts.autoCreatePartners) fd.append('auto_create_partners', '1')
    const qs = opts.preview ? '?preview=1' : ''
    return api<any>(`/api/import/${table}${qs}`, { method: 'POST', body: fd })
  },

  /* ---------------- AI 助手 ---------------- */
  ai: {
    config: () => api<AiConfig>('/api/ai'),
    saveConfig: (body: Record<string, any>) => post<AiConfig & { ok: boolean }>('/api/ai/config', body),
    test: (body: Record<string, any> = {}) => post<AiTestResult>('/api/ai/test', body),

    /** 每日经营简报（后端当天缓存，不会重复调模型） */
    briefing: (refresh = false) => api<AiBriefing>(`/api/ai/briefing${refresh ? '?refresh=1' : ''}`),

    /** 确认 AI 的录入方案（点确认后才真正写库）
     *  patch：在确认卡片上补/改的字段（如选了所属项目） */
    applyProposal: (token: string, patch?: Record<string, any>) =>
      post<{ ok: boolean; table: string; tableLabel: string; id: number; linkedAttachments?: number; missing?: any[] }>(
        '/api/ai/apply', { token, patch }),

    /** 单据进件：把刚上传的附件交给后端判断该录到哪张表，返回待确认方案 */
    ingest: (body: { attachmentId: number; hint?: string }) =>
      post<AiIngestResult>('/api/ai/ingest', { attachment_id: body.attachmentId, hint: body.hint || '' }),

    /* 简报推送到微信/钉钉/飞书 */
    pushConfig: () => api<AiPushConfig>('/api/ai/push'),
    savePush: (body: Record<string, any>) => post<AiPushConfig & { ok: boolean }>('/api/ai/push', body),
    testPush: () => post<AiPushResult>('/api/ai/push/test', {}),

    /** 把一段分析导出成 Word 报告，返回 Blob 并触发浏览器下载 */
    exportReport: async (
      body: { question: string; answer: string; title?: string; includeData?: boolean },
      filename?: string,
    ): Promise<void> => {
      const res = await fetch('/api/ai/export', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        let msg = `导出失败（${res.status}）`
        try { const j = await res.json(); if (j?.error) msg = j.error } catch { /* 忽略 */ }
        if (res.status === 401 && onUnauthorized) onUnauthorized()
        throw new ApiError(msg, res.status, null)
      }
      const blob = await res.blob()
      // 文件名优先用响应头里服务端给的名字，拿不到就本地拼一个
      let name = filename || '经营分析报告.docx'
      const cd = res.headers.get('content-disposition') || ''
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd)
      if (m) { try { name = decodeURIComponent(m[1]) } catch { /* 保持默认 */ } }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 10000)
    },

    /**
     * 流式提问。
     * 用 fetch + 手动读 SSE（EventSource 只能 GET，带不了请求体，也用不了 POST）。
     * @returns 完整回复文本
     */
    chat: async (body: { question: string; messages?: AiMessage[] }, h: AiStreamHandlers = {}): Promise<string> => {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: body.question, messages: body.messages || [] }),
        signal: h.signal,
      })

      if (!res.ok || !res.body) {
        let msg = `请求失败（${res.status}）`
        let data: any = {}
        try { data = await res.json(); if (data?.error) msg = data.error } catch { /* 不是 JSON 就用默认文案 */ }
        if (res.status === 401 && data?.needLogin && onUnauthorized) onUnauthorized()
        throw new ApiError(msg, res.status, data)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buf = ''
      let full = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })

        let idx: number
        // SSE 以空行分隔事件，这里按行处理，最后一行可能不完整要留在缓冲里
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '')
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (!payload) continue
          let evt: any
          try { evt = JSON.parse(payload) } catch { continue }

          if (evt.type === 'delta' && evt.text) {
            full += evt.text
            h.onDelta?.(evt.text)
          } else if (evt.type === 'status') {
            h.onStatus?.(evt.text || '')
          } else if (evt.type === 'tool') {
            h.onTool?.(evt.name || '', evt.label || evt.name || '')
          } else if (evt.type === 'proposal' && evt.prop) {
            h.onProposal?.({ ...evt.prop, state: 'pending' })
          } else if (evt.type === 'done') {
            h.onUsage?.(evt.usage || null, evt.tools || 0)
          } else if (evt.type === 'error') {
            throw new ApiError(evt.error || '模型调用失败', 502, null)
          }
        }
      }
      return full
    },
  },

  exportUrl: (table: string, params: Record<string, string | number> = {}) => {
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== '' && v !== undefined) p.set(k, String(v))
    const qs = p.toString()
    return `/api/export/${table}${qs ? '?' + qs : ''}`
  },
  fileUrl: (id: number, inline = false) => `/api/file/${id}${inline ? '?inline=1' : ''}`,
}
