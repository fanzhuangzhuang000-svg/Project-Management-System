import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  FolderKanban, ScrollText, Wallet, ReceiptText, FileCheck2, CreditCard,
  Layers, FileText, ShoppingCart, Tag, CircleCheck, CalendarDays,
} from 'lucide-react'
import { Card, Empty, Skeleton } from '@/components/ui/primitives'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { BriefingCard } from '@/components/dashboard/BriefingCard'
import { useApp, DEFAULT_SETTINGS } from '@/app-context'
import { http, type Dashboard as Dash } from '@/lib/api'
import { cn, fmtWan, n0, delta as calcDelta, renderWelcome, pickWelcomeSlot, resolveSubtitle } from '@/lib/utils'

/**
 * 工作台首页 · 管理系统 2.0 风格
 *   1. 顶部大 Banner（浅蓝渐变 + 3D 弱电插画）
 *   2. 四张彩色渐变入口大卡（项目总览/合同管理/收付款/发票管理）
 *   3. 数据统计卡（本周/本月切换：四大数字 + 六小指标）
 *   4. 底部左右：待办总览环形图 + 项目执行概览进度条
 * 右侧辅助栏在 AppShell 里（DashAside）。
 */
export default function DashboardPage() {
  const { user, dash, loading, refreshDash, settings } = useApp()
  const [range, setRange] = useState<'week' | 'month'>('month')
  const [briefing, setBriefing] = useState(false)

  useEffect(() => { void refreshDash() }, [refreshDash])
  // 简报卡只在配置了 AI 时出现；先探测一次（BriefingCard 自己内部也有兜底）
  useEffect(() => { setBriefing(true) }, [])

  const d = dash
  const t = (d?.totals || {}) as Record<string, number>
  const mom = d?.mom

  /* ---------- Banner 欢迎语（沿用系统设置模板） ---------- */
  const S = settings || DEFAULT_SETTINGS
  const welcomeText = renderWelcome(String(S[pickWelcomeSlot()] ?? ''), S.company_name)
  // 副标题：fixed=固定文案，daily=每日随机打工人语录（仅替换文本，排版样式不变）
  const subtitleText = resolveSubtitle((S as any).subtitle_mode, S.welcome_subtitle)

  /* ---------- 四张渐变入口卡 ---------- */
  const activeCount = n0(t.project_active)
  const entryCards = [
    {
      key: 'projects', to: '/t/projects', bg: 'grad-entry-1',
      icon: FolderKanban, deco: FileCheck2,
      title: '项目总览', sub: `实时查看项目进度与经营数据 · 在建 ${activeCount} 个`,
    },
    {
      key: 'contracts', to: '/t/contracts', bg: 'grad-entry-2',
      icon: ScrollText, deco: CreditCard,
      title: '合同管理', sub: `${n0(t.contract_count)} 份合同执行中 · 总额 ${fmtWan(t.contract_in)} 万`,
    },
    {
      key: 'payments', to: '/t/payments', bg: 'grad-entry-3',
      icon: Wallet, deco: CreditCard,
      title: '收付款', sub: `本月已回款 ${fmtWan(d?.month_in)} 万 · 应收 ${fmtWan(t.receivable)} 万`,
    },
    {
      key: 'invoices', to: '/t/invoices', bg: 'grad-entry-4',
      icon: ReceiptText, deco: Tag,
      title: '发票管理', sub: `待开票 ${fmtWan(t.uninvoiced_out)} 万 · 已开票 ${fmtWan(t.inv_out)} 万`,
    },
  ]

  /* ---------- 数据统计：本周/本月切换 ---------- */
  const isWeek = range === 'week'
  const newContractAmt = isWeek
    ? null // 本周新增合同没有单独口径，用月环比替代展示
    : n0(t.contract_in)
  const fmtDelta = (v: number | null | undefined) => {
    if (v == null || !Number.isFinite(v) || v === 0) return null
    return v > 0 ? { up: true, text: `▲${Math.abs(Math.round(v))}%` } : { up: false, text: `▼${Math.abs(Math.round(v))}%` }
  }
  const bigStats = [
    { label: isWeek ? '本周收款' : '新增合同额', value: isWeek ? fmtWan(d?.week?.in) : fmtWan(newContractAmt), unit: '万',
      delta: isWeek ? null : fmtDelta(pct(mom?.contract_in, t.contract_in)),
      tone: 'blue' },
    { label: '总合同额', value: fmtWan(t.contract_in), unit: '万',
      delta: null, tone: 'blue' },
    { label: isWeek ? '本周付款' : '新增回款', value: isWeek ? fmtWan(d?.week?.out) : fmtWan(d?.month_in), unit: '万',
      delta: null, tone: 'green' },
    { label: '总回款', value: fmtWan(t.paid_in), unit: '万',
      delta: fmtDelta(pct(mom?.paid_in, t.paid_in)), tone: 'green' },
  ]
  const smallStats = [
    { label: '在建项目', value: `${activeCount}个` },
    { label: '管理人员', value: `${n0(d?.extra?.staff)}人` },
    { label: '设备总数', value: `${n0(t.material_count)}台` },
    { label: '本月新增', value: `${n0(d?.extra?.new_projects)}个项目` },
    { label: '故障售后', value: `${n0(t.maint_open)}单` },
    { label: '待办事项', value: d?.extra?.todo_count != null ? `${n0(d.extra.todo_count)}项` : '—' },
  ]

  /* ---------- 待办总览（环形图四段：逾期未收/7天内到期/待审合同/售后待处理） ---------- */
  const schedTotals = d?.schedules?.totals || {}
  const todoSlices = useMemo(() => {
    const byKind: Record<string, number> = {}
    for (const r of (d?.reminders || [])) {
      if (r.count) byKind[r.kind] = (byKind[r.kind] || 0) + r.count
    }
    const overdueIn = n0((d?.reminders || []).find(r => r.kind === 'overdue_in')?.count)
    const due7 = n0((d?.reminders || []).find(r => r.kind === 'due_7')?.count)
    const maint = n0((d?.reminders || []).find(r => r.kind === 'maint')?.count)
    const doneUnpaid = n0((d?.reminders || []).find(r => r.kind === 'done_unpaid')?.count)
    return [
      { label: '逾期未收', value: overdueIn, color: '#EF4444' },
      { label: '7天内到期', value: due7, color: '#F59E0B' },
      { label: '待审合同', value: doneUnpaid, color: '#3B82F6' },
      { label: '售后待处理', value: maint, color: '#8B5CF6' },
    ].filter(s => s.value > 0)
  }, [d])
  const todoTotal = todoSlices.reduce((s, x) => s + x.value, 0)

  /* ---------- 项目执行概览（横向进度条，取进行中项目） ---------- */
  const execProjects = useMemo(() => {
    const list = (d?.top_receivable || []).filter((p: any) => p.status === '进行中')
    const src = list.length ? list : (d?.top_receivable || [])
    return src.slice(0, 4)
  }, [d])

  if (loading && !d) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[140px] w-full" />
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[100px]" />)}
        </div>
        <Skeleton className="h-[220px] w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ══════════ 1. 顶部大 Banner ══════════ */}
      <div
        className="relative overflow-hidden rounded-[20px] px-7 py-7"
        style={{
          background: `linear-gradient(105deg, var(--banner-from) 0%, var(--banner-to) 78%)`,
          boxShadow: '0 2px 12px rgba(0,0,0,.04)',
        }}
      >
        {/* 波浪流线装饰 */}
        <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-60" preserveAspectRatio="none" viewBox="0 0 900 140" fill="none" aria-hidden>
          <path d="M0 118 C150 88, 300 132, 460 104 S 760 70, 900 96" stroke="#BFDBFE" strokeWidth="1.4" strokeOpacity=".7" fill="none" />
          <path d="M0 132 C180 104, 340 140, 520 116 S 800 88, 900 110" stroke="#DBEAFE" strokeWidth="1.2" strokeOpacity=".8" fill="none" />
          <circle cx="120" cy="112" r="2.4" fill="#93C5FD" /><circle cx="760" cy="84" r="2.4" fill="#93C5FD" />
        </svg>

        <div className="relative z-10 flex items-center justify-between gap-6">
          <div className="min-w-0">
            <h1 className="text-[28px] font-bold leading-tight" style={{ color: 'var(--banner-title)' }}>
              {welcomeText}
            </h1>
            <p className="mt-2 text-[16px] font-semibold" style={{ color: 'var(--ink-900)' }}>{subtitleText}</p>
            <p className="mt-1 text-[13px]" style={{ color: 'var(--ink-500)' }}>
              {String(S.welcome_subtitle || '平台布局更清晰，数据管理更便捷，组件样式更美观，给您带来全新产品体验')}
            </p>
          </div>
          {/* 3D 风格弱电插画：蓝图卷轴 + 安全帽 + 线缆 */}
          <DecorElv />
        </div>
      </div>

      {/* ══════════ 2. 四张彩色渐变入口卡 ══════════ */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {entryCards.map(c => (
          <Link key={c.key} to={c.to}
            className="group relative block h-[100px] overflow-hidden rounded-2xl px-5 py-4 transition-all duration-200 hover:-translate-y-[3px]"
            style={{ backgroundImage: undefined }} data-grad={c.bg}>
            <div className={cn('absolute inset-0', c.bg)} />
            {/* 右上角小装饰图标（半透明白） */}
            <c.deco size={56} strokeWidth={1.1}
              className="absolute -right-2 -top-2 text-white/25 transition-transform duration-300 group-hover:scale-110" />
            <div className="relative z-10 flex h-full flex-col justify-center text-white">
              <div className="flex items-center gap-2">
                <c.icon size={20} strokeWidth={2.2} />
                <span className="text-[17px] font-bold tracking-wide">{c.title}</span>
              </div>
              <div className="mt-1.5 truncate text-[12px] text-white/80">{c.sub}</div>
            </div>
            {/* 左下光斑 */}
            <span className="pointer-events-none absolute -bottom-6 -left-4 h-20 w-20 rounded-full bg-white/10" />
          </Link>
        ))}
      </div>

      {/* ══════════ 今日经营简报（配置了 AI 才有内容，内部自己兜底） ══════════ */}
      <BriefingCard />

      {/* ══════════ 3. 数据统计卡 ══════════ */}
      <Card className="px-6 pb-5 pt-5">
        <div className="flex items-center justify-between">
          <div className="flex items-baseline gap-3">
            <span className="text-[15px] font-bold text-ink-900">数据统计</span>
            <span className="text-[12px] text-ink-400">更新时间 {String(d?.today || '').slice(0, 10)} 08:30</span>
          </div>
          <div className="flex items-center gap-1 rounded-full p-1" style={{ background: 'var(--tile-bg)' }}>
            {(['week', 'month'] as const).map(v => (
              <button key={v} onClick={() => setRange(v)}
                className={cn('rounded-full px-3.5 py-1 text-tiny font-medium transition-all duration-200',
                  range === v ? 'bg-white text-ink-900 shadow-soft' : 'text-ink-400 hover:text-ink-700')}
                style={range === v ? { background: 'var(--card-bg)' } : undefined}>
                {v === 'week' ? '本周' : '本月'}
              </button>
            ))}
          </div>
        </div>

        {/* 第一行：四个大数字 */}
        <div className="mt-4 grid grid-cols-2 gap-4 xl:grid-cols-4">
          {bigStats.map((b, i) => (
            <div key={i} className="rounded-tile px-3 py-2" style={{ background: 'var(--tile-bg)' }}>
              <div className="text-[12px] text-ink-500">{b.label}</div>
              <div className="mt-1 flex items-baseline gap-1.5">
                <span className="num-in text-[26px] font-extrabold leading-none tnum text-ink-900">
                  ¥{b.value ?? '0'}
                </span>
                <span className="text-[12px] text-ink-400">{b.unit}</span>
              </div>
              {b.delta && (
                <div className={cn('mt-1 text-[11px] font-medium tnum', b.delta.up ? 'text-down' : 'text-up')}>
                  较上月 {b.delta.text}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* 第二行：六个小指标（细分隔线隔开） */}
        <div className="mt-4 grid grid-cols-3 gap-y-3 xl:grid-cols-6" style={{ borderTop: '1px dashed var(--topbar-line)' }}>
          {smallStats.map((s, i) => (
            <div key={i} className="pt-3 text-center">
              <div className="text-[12px] text-ink-400">{s.label}</div>
              <div className="mt-0.5 text-[17px] font-bold tnum text-ink-900">{s.value}</div>
            </div>
          ))}
        </div>
      </Card>

      {/* ══════════ 4. 底部左右两卡 ══════════ */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {/* 待办总览：环形图 + 图例 */}
        <Card className="px-6 pb-6 pt-5">
          <div className="text-[15px] font-bold text-ink-900">待办总览</div>
          {todoTotal > 0 ? (
            <div className="mt-4 flex items-center gap-8">
              {/* 环形图：纯 SVG conic 环（无依赖、按段着色） */}
              <div className="relative h-[150px] w-[150px] flex-none">
                <TodoDonut slices={todoSlices} />
                <div className="absolute inset-0 flex flex-col items-center justify-center">
                  <span className="num-in text-[34px] font-extrabold leading-none tnum text-ink-900">{todoTotal}</span>
                  <span className="mt-1 text-[12px] text-ink-400">待办事项</span>
                </div>
              </div>
              {/* 图例 */}
              <div className="min-w-0 flex-1 space-y-2">
                {todoSlices.map(s => (
                  <Link key={s.label} to="/t/schedules"
                    className="flex items-center gap-2.5 rounded-tile px-2 py-1.5 transition-colors duration-200 hover:bg-slate-50">
                    <span className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: s.color }} />
                    <span className="min-w-0 flex-1 truncate text-body text-ink-700">{s.label}</span>
                    <span className="tnum text-body font-bold text-ink-900">{s.value}{s.label === '售后待处理' ? '单' : '笔'}</span>
                  </Link>
                ))}
              </div>
            </div>
          ) : (
            <Empty icon={CircleCheck} title="暂无待办" hint="没有逾期、没有临期款项，干得漂亮" />
          )}
        </Card>

        {/* 项目执行概览：横向进度条 */}
        <Card className="px-6 pb-6 pt-5">
          <div className="flex items-center justify-between">
            <div className="text-[15px] font-bold text-ink-900">项目执行概览</div>
            <Link to="/t/projects" className="text-tiny text-brand transition-opacity duration-200 hover:opacity-70">全部</Link>
          </div>
          {execProjects.length ? (
            <div className="mt-5 space-y-4">
              {execProjects.map((p: any) => (
                <div key={p.id}>
                  <div className="mb-1.5 flex items-center justify-between">
                    <Link to={`/p/${p.id}`} className="min-w-0 flex-1 truncate text-[14px] text-ink-700 transition-colors duration-200 hover:text-brand">
                      {p.name}
                    </Link>
                    <span className="ml-3 tnum text-[13px] font-bold text-brand">{n0(p.progress)}%</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full" style={{ background: 'var(--tile-bg)' }}>
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(100, n0(p.progress))}%`, background: 'linear-gradient(90deg, #3B82F6, #60A5FA)' }} />
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty icon={FolderKanban} title="暂无进行中的项目" />
          )}
        </Card>
      </div>
    </div>
  )
}

/* ============================ 子组件 ============================ */

/** 环比百分比（mom 差值 / 现值），算不出返回 null */
function pct (diff: number | null | undefined, cur: number | null | undefined): number | null {
  if (diff == null || cur == null) return null
  const prev = n0(cur) - n0(diff)
  if (prev <= 0) return null
  return (n0(diff) / prev) * 100
}

/** 待办环形图：四段 conic 环，纯 SVG */
function TodoDonut ({ slices }: { slices: { label: string; value: number; color: string }[] }) {
  const total = slices.reduce((s, x) => s + x.value, 0) || 1
  const R = 62, C = 2 * Math.PI * R
  let acc = 0
  return (
    <svg viewBox="0 0 160 160" className="h-full w-full -rotate-90">
      <circle cx="80" cy="80" r={R} fill="none" stroke="var(--tile-bg)" strokeWidth="16" />
      {slices.map(s => {
        const len = (s.value / total) * C
        const el = (
          <circle key={s.label} cx="80" cy="80" r={R} fill="none" stroke={s.color} strokeWidth="16"
            strokeLinecap="butt"
            strokeDasharray={`${Math.max(0, len - 2)} ${C - len + 2}`}
            strokeDashoffset={-acc} />
        )
        acc += len
        return el
      })}
    </svg>
  )
}

/** Banner 右侧插画：3D 风格蓝图卷轴 + 安全帽 + 线缆（纯 SVG，带光影反射） */
function DecorElv () {
  return (
    <svg
      className="pointer-events-none absolute right-6 top-1/2 hidden h-[150px] w-[260px] -translate-y-1/2 lg:block"
      viewBox="0 0 260 150" fill="none" aria-hidden
    >
      <defs>
        <linearGradient id="scrollBody" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FFFFFF" /><stop offset="100%" stopColor="#DBEAFE" />
        </linearGradient>
        <linearGradient id="scrollRoll" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#93C5FD" /><stop offset="100%" stopColor="#3B82F6" />
        </linearGradient>
        <linearGradient id="hatBody" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FDE68A" /><stop offset="100%" stopColor="#F59E0B" />
        </linearGradient>
        <linearGradient id="cable" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#818CF8" /><stop offset="100%" stopColor="#60A5FA" />
        </linearGradient>
        <radialGradient id="shadow" cx=".5" cy=".5" r=".5">
          <stop offset="0%" stopColor="#3B82F6" stopOpacity=".22" /><stop offset="100%" stopColor="#3B82F6" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 地面光晕（反射感） */}
      <ellipse cx="140" cy="128" rx="92" ry="14" fill="url(#shadow)" />

      {/* 蓝图卷轴（立体感：卷筒 + 展开的纸面 + 网格） */}
      <g transform="translate(96 30)">
        <rect x="10" y="8" width="112" height="76" rx="6" fill="url(#scrollBody)" stroke="#93C5FD" strokeOpacity=".5" />
        <rect x="0" y="0" width="16" height="92" rx="8" fill="url(#scrollRoll)" />
        <rect x="116" y="0" width="16" height="92" rx="8" fill="url(#scrollRoll)" />
        {/* 图纸网格 + 线路 */}
        <g stroke="#93C5FD" strokeOpacity=".45" strokeWidth="1">
          <path d="M28 22 H108 M28 40 H108 M28 58 H108" />
          <path d="M44 14 V72 M70 14 V72 M96 14 V72" />
        </g>
        <path d="M36 62 L52 46 L70 58 L92 30" stroke="#2563EB" strokeWidth="2.4" strokeLinecap="round" fill="none" />
        <circle cx="92" cy="30" r="3.2" fill="#2563EB" />
        <circle cx="36" cy="62" r="3.2" fill="#2563EB" />
      </g>

      {/* 安全帽（立体：帽壳 + 帽檐 + 高光） */}
      <g transform="translate(38 74)">
        <path d="M10 34 A26 26 0 0 1 62 34 Z" fill="url(#hatBody)" />
        <rect x="2" y="32" width="68" height="9" rx="4.5" fill="#F59E0B" />
        <rect x="33" y="6" width="6" height="22" rx="3" fill="#FBBF24" />
        <path d="M16 24 A20 20 0 0 1 34 10" stroke="#fff" strokeOpacity=".65" strokeWidth="3" strokeLinecap="round" fill="none" />
      </g>

      {/* 线缆（从卷轴垂下的跳线，带弧度） */}
      <path d="M118 122 C150 132, 176 116, 208 126" stroke="url(#cable)" strokeWidth="3.4" strokeLinecap="round" fill="none" />
      <circle cx="118" cy="122" r="3.4" fill="#818CF8" />
      <circle cx="208" cy="126" r="3.4" fill="#60A5FA" />
    </svg>
  )
}
