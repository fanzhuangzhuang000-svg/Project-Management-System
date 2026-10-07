import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import {
  Sun, Moon, MoreHorizontal, Wallet, ReceiptText, FilePlus2, Bell,
  Bot, FileDown, Plus, CloudSun, Medal, ChevronRight,
} from 'lucide-react'
import { http, type Dashboard, type NoticeRow, type User } from '@/lib/api'
import { cn, renderWelcome, pickWelcomeSlot } from '@/lib/utils'
import { useApp, DEFAULT_SETTINGS } from '@/app-context'

/**
 * 右侧辅助栏（320px，管理系统 2.0 风格），从上到下：
 *   1. 蓝紫渐变欢迎卡（云朵太阳 + 日期）
 *   2. 常用功能宫格（2×4，第 8 格是「+」）
 *   3. 排行统计：项目回款率 Top5（🥇🥈🥉 + 4/5 蓝色编号）
 *   4. 通知公告（Tab：公司公告 / 系统通知 / 放假通知）
 */
export function DashAside({ dash, user }: { dash?: Dashboard | null; user: User }) {
  const { settings } = useApp()
  const S = settings || DEFAULT_SETTINGS
  const nav = useNavigate()
  void user   // 保留入参：后续要按角色定制快捷入口时用

  /* ---- 主题切换（右上角太阳/月亮，存 localStorage） ---- */
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    (localStorage.getItem('pms.theme') as 'light' | 'dark') || 'light')
  const toggleTheme = () => {
    const next = theme === 'light' ? 'dark' : 'light'
    setTheme(next)
    localStorage.setItem('pms.theme', next)
    document.documentElement.setAttribute('data-theme', next)
  }

  /* ---- 欢迎语按小时段（时段问候由系统设置的欢迎语模板决定） ---- */
  const dateText = useMemo(() => {
    const d = new Date()
    const wd = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()]
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${wd}`
  }, [])

  /* ---- 排行（用真实回款率） ---- */
  const rank = (dash?.collect_rank || []).slice(0, 5)

  /* ---- 通知公告 ---- */
  const [notices, setNotices] = useState<{ company: NoticeRow[]; holiday: NoticeRow[]; system: NoticeRow[] } | null>(null)
  const [noticeTab, setNoticeTab] = useState<'company' | 'system' | 'holiday'>('company')
  useEffect(() => {
    let alive = true
    http.notices()
      .then(r => { if (alive) setNotices(r) })
      .catch(() => { if (alive) setNotices({ company: [], holiday: [], system: [] }) })
    return () => { alive = false }
  }, [])
  const noticeRows = notices ? notices[noticeTab] : []

  /* ---- 常用功能宫格 ---- */
  const quick = [
    { icon: Wallet, label: '快速记收款', bg: 'grad-purple', to: '/t/payments?quick=in' },
    { icon: ReceiptText, label: '快速记付款', bg: 'grad-warm', to: '/t/payments?quick=out' },
    { icon: FilePlus2, label: '上传发票', bg: 'grad-green', to: '/t/invoices' },
    { icon: Bell, label: '消息通知', bg: 'grad-brand', to: '/logs' },
    { icon: FilePlus2, label: '新建合同', bg: 'grad-entry-2', to: '/t/contracts?quick=new' },
    { icon: Bot, label: 'AI助手', bg: 'grad-ai', to: 'ai' },
    { icon: FileDown, label: '导出报表', bg: 'grad-cyan', to: '/reports' },
    { icon: Plus, label: '自定义', bg: 'grad-entry-4', to: 'add' },
  ]
  const onQuick = (q: typeof quick[number]) => {
    if (q.to === 'ai') { window.dispatchEvent(new CustomEvent('open-ai-assistant')); return }
    if (q.to === 'add') return
    nav(q.to)
  }

  return (
    <aside className="no-scrollbar w-[320px] flex-none overflow-y-auto px-4 pb-8 pt-5">
      <div className="space-y-4">
        {/* ════ 1. 欢迎卡：蓝紫渐变 ════ */}
        <div className="relative overflow-hidden rounded-2xl px-5 py-5 text-white grad-ai" style={{ boxShadow: '0 8px 24px rgba(99,102,241,.28)' }}>
          <CloudSun size={54} className="absolute right-4 top-3 text-white/25" strokeWidth={1.6} />
          {/* 欢迎语同样取系统设置（按时段自动切换，{公司名} 已替换） */}
          <div className="text-[17px] font-bold leading-snug">
            {renderWelcome(String(S[pickWelcomeSlot()] ?? ''), S.company_name)}
          </div>
          <div className="mt-1 text-tiny text-white/80">欢迎登录{S.system_name}</div>
          <div className="mt-3 tnum text-[12px] text-white/70">{dateText}</div>
          {/* 装饰光斑 */}
          <span className="pointer-events-none absolute -bottom-8 -left-6 h-24 w-24 rounded-full bg-white/10" />
        </div>

        {/* ════ 2. 常用功能宫格 ════ */}
        <div className="card px-4 pb-3 pt-4">
          <div className="mb-3 flex items-center justify-between px-1">
            <span className="text-cardtitle text-ink-700">常用功能</span>
            <MoreHorizontal size={16} className="text-ink-400" />
          </div>
          <div className="grid grid-cols-4 gap-y-3">
            {quick.map((q, i) => (
              <button key={i} onClick={() => onQuick(q)}
                className="group flex flex-col items-center gap-1.5 rounded-tile py-1.5 transition-transform duration-200 hover:-translate-y-0.5">
                <span className={cn('flex h-10 w-10 items-center justify-center rounded-xl text-white transition-shadow duration-200 group-hover:shadow-pop', q.bg)}>
                  <q.icon size={18} />
                </span>
                <span className="text-[11px] text-ink-500">{q.label}</span>
              </button>
            ))}
          </div>
        </div>

        {/* ════ 3. 排行统计：项目回款率 Top5 ════ */}
        <div className="card px-4 pb-3 pt-4">
          <div className="mb-2 flex items-center justify-between px-1">
            <span className="text-cardtitle text-ink-700">回款率排行</span>
            <Link to="/t/projects" className="flex items-center gap-0.5 text-[11px] text-ink-400 transition-colors duration-200 hover:text-brand">
              全部 <ChevronRight size={12} />
            </Link>
          </div>
          {rank.length ? (
            <div className="space-y-0.5">
              {rank.map((r, i) => (
                <Link key={r.id} to={`/p/${r.id}`}
                  className="flex items-center gap-2.5 rounded-tile px-2 py-2 transition-colors duration-200 hover:bg-slate-50">
                  {i < 3 ? (
                    <Medal size={18} className={cn('flex-none',
                      i === 0 ? 'text-amber-400' : i === 1 ? 'text-slate-400' : 'text-orange-400')} />
                  ) : (
                    <span className="flex h-5 w-5 flex-none items-center justify-center rounded-full bg-blue-50 text-[11px] font-bold text-brand tnum">
                      {i + 1}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-body text-ink-700">{r.name}</span>
                  <span className="tnum text-body font-bold text-ink-900">{r.rate}%</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="px-2 py-4 text-center text-tiny text-ink-400">录入合同和收款后，这里排出回款率 Top5</p>
          )}
          <div className="pt-1 text-center text-[11px] text-ink-400">没有更多了</div>
        </div>

        {/* ════ 4. 通知公告 ════ */}
        <div className="card px-4 pb-3 pt-4">
          <div className="mb-2 flex items-center gap-1 px-1">
            {([['company', '公司公告'], ['system', '系统通知'], ['holiday', '放假通知']] as const).map(([k, label]) => (
              <button key={k} onClick={() => setNoticeTab(k)}
                className={cn('rounded-full px-2.5 py-1 text-[11px] font-medium transition-all duration-200',
                  noticeTab === k ? 'bg-blue-50 text-brand' : 'text-ink-400 hover:text-ink-700')}>
                {label}
              </button>
            ))}
          </div>
          <div className="space-y-0.5">
            {noticeRows.length ? noticeRows.map((n, i) => (
              <div key={i} className="flex items-center gap-2 rounded-tile px-2 py-2 transition-colors duration-200 hover:bg-slate-50">
                <span className="min-w-0 flex-1 truncate text-tiny text-ink-700">{n.title}</span>
                <NoticeTag tag={n.tag} />
                <span className="flex-none tnum text-[11px] text-ink-400">{n.date}</span>
              </div>
            )) : (
              <p className="px-2 py-4 text-center text-tiny text-ink-400">暂无通知</p>
            )}
          </div>
        </div>
      </div>

      {/* 主题切换：挂在右侧栏顶部（浮动小按钮，设计稿四之四） */}
      <button
        onClick={toggleTheme}
        title={theme === 'light' ? '切换深色主题' : '切换浅色主题'}
        className="fixed right-[336px] top-[70px] z-40 flex h-9 w-9 items-center justify-center rounded-full text-ink-500 shadow-soft transition-all duration-200 hover:text-brand hover:shadow-card"
        style={{ background: 'var(--card-bg)' }}
      >
        {theme === 'light' ? <Moon size={16} /> : <Sun size={16} />}
      </button>
    </aside>
  )
}

/** 紧急程度胶囊：一级红 / 二级橙 / 三级蓝（设计稿四之三） */
function NoticeTag({ tag }: { tag: string }) {
  if (tag === '一级') return <span className="flex-none rounded-full bg-down px-2 py-[1px] text-[10px] font-medium text-white">一级</span>
  if (tag === '二级') return <span className="flex-none rounded-full bg-orange-500 px-2 py-[1px] text-[10px] font-medium text-white">二级</span>
  if (tag === '三级') return <span className="flex-none rounded-full bg-brand px-2 py-[1px] text-[10px] font-medium text-white">三级</span>
  return <span className="flex-none rounded-full bg-slate-200 px-2 py-[1px] text-[10px] font-medium text-ink-500">{tag}</span>
}
