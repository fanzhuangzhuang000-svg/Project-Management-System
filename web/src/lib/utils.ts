import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Tailwind 类名合并（shadcn/ui 约定） */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/* ---------------- 数值 / 金额 ---------------- */
export const n0 = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 千分位金额，保留 2 位 */
export const fmtMoney = (v: unknown): string =>
  n0(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 按「万」展示，保留 2 位 */
export const fmtWan = (v: unknown): string =>
  (n0(v) / 10000).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** 大数字拆成「整数 + 小数」两段，供大号指标分开展示 */
export function splitMoney(v: unknown): { int: string; dec: string } {
  const s = fmtMoney(v)
  const i = s.lastIndexOf('.')
  return i < 0 ? { int: s, dec: '' } : { int: s.slice(0, i), dec: s.slice(i) }
}

export const fmtInt = (v: unknown): string => Math.round(n0(v)).toLocaleString('zh-CN')

/** 百分比，带一位小数 */
export const fmtPct = (v: unknown, digits = 1): string => `${n0(v).toFixed(digits)}%`

/** 带 ↑↓ 的涨跌文案 */
export function delta(cur: number, prev: number, digits = 1): { text: string; up: boolean } {
  const d = n0(cur) - n0(prev)
  const up = d >= 0
  const pct = prev !== 0 ? Math.abs(d / prev) * 100 : null
  const txt = pct === null
    ? `${up ? '+' : '-'}${fmtInt(Math.abs(d))}`
    : `${up ? '+' : '-'}${pct.toFixed(digits)}%`
  return { text: txt, up }
}

/* ---------------- 日期 ---------------- */
export const today = (): string => {
  const d = new Date()
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 「2026年10月6日 周二」 */
export function fmtDateCN(iso?: string | null): string {
  const s = (iso || today()).slice(0, 10)
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return s
  const w = ['日', '一', '二', '三', '四', '五', '六'][new Date(y, m - 1, d).getDay()]
  return `${y}年${m}月${d}日 周${w}`
}

/** 相对时间：「10分钟前」 */
export function timeAgo(iso?: string | null): string {
  if (!iso) return ''
  const t = new Date(String(iso).replace(' ', 'T')).getTime()
  if (!Number.isFinite(t)) return String(iso).slice(0, 16)
  const diff = Date.now() - t
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)}天前`
  return String(iso).slice(0, 10)
}

/** 按当前钟点返回问候语 */
export function greeting(): string {
  const h = new Date().getHours()
  if (h < 6) return '凌晨好'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

/* ---------------- 其他 ---------------- */
/** 取名字末两字做头像文字（中文习惯） */
export function initials(name?: string | null): string {
  const s = String(name || '').trim()
  if (!s) return '—'
  if (/^[A-Za-z]/.test(s)) return s.slice(0, 2).toUpperCase()
  return s.length <= 2 ? s : s.slice(-2)
}

/** 由字符串稳定映射到一个头像配色（同一个人每次颜色一致） */
const AVATAR_COLORS = [
  'from-blue-500 to-indigo-500',
  'from-violet-500 to-purple-500',
  'from-cyan-500 to-sky-500',
  'from-emerald-500 to-teal-500',
  'from-orange-500 to-amber-500',
  'from-rose-500 to-pink-500',
]
export function avatarColor(seed?: string | null): string {
  const s = String(seed || '')
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997
  return AVATAR_COLORS[h % AVATAR_COLORS.length]
}

export const fmtSize = (bytes: unknown): string => {
  let b = n0(bytes)
  if (b < 1024) return `${b} B`
  const u = ['KB', 'MB', 'GB', 'TB']
  let i = -1
  do { b /= 1024; i++ } while (b >= 1024 && i < u.length - 1)
  return `${b.toFixed(b < 10 ? 1 : 0)} ${u[i]}`
}

/* ============ 界面自定义：欢迎语渲染 ============ */

/** 欢迎语模板里的占位符 */
export function renderWelcome (tpl: string, companyName: string): string {
  return String(tpl || '').replace(/\{公司名\}/g, companyName || '项目团队')
}

/**
 * 当前时段该用哪条欢迎语。
 * 上午 05:00-12:00 / 下午 12:00-18:00 / 晚上 18:00-次日 05:00
 */
export function pickWelcomeSlot (
  d: Date = new Date(),
): 'welcome_morning' | 'welcome_afternoon' | 'welcome_evening' {
  const h = d.getHours()
  if (h >= 5 && h < 12) return 'welcome_morning'
  if (h >= 12 && h < 18) return 'welcome_afternoon'
  return 'welcome_evening'
}

/* ============ 首页副标题：固定文案 / 每日随机打工人语录 ============ */

/** 内置弱电工程行业语录库 */
export const WORKER_QUOTES: string[] = [
  '今日搬砖，项目稳步推进',
  '工程无小事，细节定成败',
  '认真管好每一份合同，盯紧每一笔回款',
  '开工顺顺利利，回款稳稳当当',
  '今日努力，只为项目按时交付',
  '弱电工程人，脚踏实地，不负所托',
  '把控项目风险，做好项目管理',
  '忙而不乱，稳步推进所有项目',
]

/**
 * 按日期从语录库稳定挑一条：同一天内结果固定不刷新，换日期自动更换。
 * 用「年内的第几天」做种子，纯前端计算，不依赖后端与缓存。
 */
export function pickDailyQuote (d: Date = new Date()): string {
  const start = new Date(d.getFullYear(), 0, 0)
  const dayOfYear = Math.floor((d.getTime() - start.getTime()) / 86400000)
  return WORKER_QUOTES[dayOfYear % WORKER_QUOTES.length]
}

/** 副标题模式：fixed=固定副标题（沿用 welcome_subtitle），daily=每日随机语录 */
export type SubtitleMode = 'fixed' | 'daily'

/**
 * 解析当前该显示的副标题文本。
 * 仅替换文本，文字位置与排版由调用处保持不变。
 */
export function resolveSubtitle (mode: string | undefined, fixed: string, d: Date = new Date()): string {
  return mode === 'daily' ? pickDailyQuote(d) : String(fixed || '')
}
