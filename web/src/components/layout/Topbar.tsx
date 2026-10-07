import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CircleHelp, Expand, Minimize2, Search, LogOut, KeyRound, X } from 'lucide-react'
import { Avatar, Pill } from '@/components/ui/primitives'
import { http, type Dashboard, type User } from '@/lib/api'
import { cn } from '@/lib/utils'

function greet() {
  const h = new Date().getHours()
  if (h < 6) return '凌晨好'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

interface Hit { table: string; tableLabel: string; icon: string; id: number; title: string; subtitle: string }

export function Topbar({
  user, dash, onOpenProfile, onOpenTodo,
}: { user: User; dash?: Dashboard | null; onOpenProfile: () => void; onOpenTodo: () => void }) {
  const nav = useNavigate()
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [full, setFull] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)

  const todoCount = (dash?.reminders || []).length
  const unread = (dash?.reminders || []).filter(r => r.level === 'danger').length

  /* 点击外部收起搜索结果 / 用户菜单 */
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setHits(null)
      if (!(e.target as HTMLElement).closest('[data-userbox]')) setMenuOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  /* 全局搜索：300ms 防抖 */
  useEffect(() => {
    if (!q.trim()) { setHits(null); return }
    setBusy(true)
    const t = window.setTimeout(async () => {
      try {
        const r = await http.search(q.trim())
        setHits(r.hits)
      } catch { setHits([]) } finally { setBusy(false) }
    }, 300)
    return () => window.clearTimeout(t)
  }, [q])

  /* 全屏切换（规格里的"全屏图标按钮"） */
  const toggleFull = async () => {
    try {
      if (!document.fullscreenElement) { await document.documentElement.requestFullscreen(); setFull(true) }
      else { await document.exitFullscreen(); setFull(false) }
    } catch { /* 浏览器不允许就忽略 */ }
  }

  const goHit = (h: Hit) => {
    setQ(''); setHits(null)
    nav(h.table === 'attachments' ? `/attachments` : `/t/${h.table}`)
  }

  return (
    <header
      className="sticky top-0 z-40 flex h-16 flex-none items-center gap-3 px-6"
      style={{
        background: 'rgba(255,255,255,0.72)',
        backdropFilter: 'blur(18px) saturate(180%)',
        WebkitBackdropFilter: 'blur(18px) saturate(180%)',
        boxShadow: '0 1px 0 rgba(148,163,184,.14), 0 8px 24px rgba(15,23,42,.03)',
      }}
    >
      {/* ---- 搜索胶囊 ---- */}
      <div ref={boxRef} className="relative w-[320px] max-w-[36vw]">
        <div className="flex h-10 items-center gap-2 rounded-full bg-slate-100/80 px-4 transition-shadow duration-200 focus-within:bg-white"
          style={{ boxShadow: 'inset 0 0 0 0 transparent' }}>
          <Search size={16} className="flex-none text-ink-400" />
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="搜索项目、合同、单位..."
            className="!h-auto w-full !bg-transparent !px-0 !py-0 text-body placeholder:text-ink-400 focus:!shadow-none"
          />
          {q && (
            <button onClick={() => { setQ(''); setHits(null) }} className="flex-none text-ink-400 hover:text-ink-700">
              <X size={15} />
            </button>
          )}
        </div>

        {hits && (
          <div className="absolute left-0 right-0 top-12 max-h-[60vh] overflow-y-auto rounded-card bg-white p-2 shadow-pop animate-float-in">
            {busy && !hits.length && <div className="px-3 py-4 text-center text-tiny text-ink-400">搜索中…</div>}
            {!busy && !hits.length && <div className="px-3 py-4 text-center text-tiny text-ink-400">没有找到匹配的记录</div>}
            {hits.slice(0, 20).map((h, i) => (
              <button
                key={i}
                onClick={() => goHit(h)}
                className="flex w-full items-center gap-3 rounded-tile px-3 py-2 text-left transition-colors duration-200 hover:bg-slate-50"
              >
                <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] bg-slate-100 text-[14px]">
                  {h.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body font-medium text-ink-900">{h.title}</span>
                  <span className="block truncate text-tiny text-ink-400">{h.subtitle || h.tableLabel}</span>
                </span>
                <Pill tone="gray">{h.tableLabel}</Pill>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="ml-auto flex items-center gap-1.5">
        {/* 全屏 */}
        <IconBtn onClick={toggleFull} title={full ? '退出全屏' : '全屏'}>
          {full ? <Minimize2 size={18} /> : <Expand size={18} />}
        </IconBtn>

        {/* 待办清单：一个入口就够。
            以前这里有两个按钮（铃铛 + 清单），点开是同一个面板，
            只是显示方式不同（红点 vs 数字），容易让人以为是两个功能。
            现在合并：徽标显示条数，里面有紧急项时徽标会闪。 */}
        <IconBtn
          onClick={onOpenTodo}
          title={todoCount
            ? `待办清单：${todoCount} 条${unread > 0 ? `，其中 ${unread} 条紧急` : ''}`
            : '待办清单'}
          count={todoCount}
          urgent={unread > 0}
        >
          <Bell size={18} />
        </IconBtn>

        {/* 帮助 */}
        <IconBtn onClick={() => nav('/settings')} title="帮助与系统信息">
          <CircleHelp size={18} />
        </IconBtn>

        {/* 细竖线分隔 */}
        <span className="mx-2 h-7 w-px bg-slate-200/80" />

        {/* 用户区 */}
        <div className="relative" data-userbox>
          <button
            onClick={() => setMenuOpen(o => !o)}
            className="flex items-center gap-2.5 rounded-tile px-2 py-1.5 transition-colors duration-200 hover:bg-slate-100/70"
          >
            <Avatar name={user.name} size={38} />
            <span className="hidden text-left leading-tight sm:block">
              <span className="block text-body font-semibold text-ink-900">{user.name}</span>
              <span className="block text-[11px] text-ink-400">
                {user.perms.all ? '超级管理员' : '成员'}
              </span>
            </span>
          </button>

          {menuOpen && (
            <div className="absolute right-0 top-14 w-52 rounded-card bg-white p-2 shadow-pop animate-float-in">
              <div className="px-3 pb-2 pt-1">
                <div className="text-body font-semibold text-ink-900">{user.name}</div>
                <div className="text-tiny text-ink-400">@{user.username}</div>
              </div>
              <button onClick={() => { setMenuOpen(false); onOpenProfile() }}
                className="flex w-full items-center gap-2.5 rounded-tile px-3 py-2 text-body text-ink-700 transition-colors duration-200 hover:bg-slate-50">
                <KeyRound size={16} className="text-ink-400" /> 修改密码
              </button>
              <button onClick={async () => { await http.logout().catch(() => {}); location.reload() }}
                className="flex w-full items-center gap-2.5 rounded-tile px-3 py-2 text-body text-down transition-colors duration-200 hover:bg-red-50">
                <LogOut size={16} /> 退出登录
              </button>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}

function IconBtn({
  children, onClick, title, dot, count, urgent,
}: { children: ReactNode; onClick?: () => void; title?: string; dot?: boolean; count?: number; urgent?: boolean }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className="relative flex h-10 w-10 items-center justify-center rounded-tile text-ink-500 transition-all duration-200 hover:bg-slate-100/80 hover:text-ink-900"
    >
      {children}
      {dot && (
        <span className="absolute right-2.5 top-2.5 h-2 w-2 rounded-full bg-down animate-pulse-dot" />
      )}
      {!dot && !!count && count > 0 && (
        <span className={cn('absolute right-1.5 top-1.5 min-w-[16px] rounded-full bg-down px-1 text-[10px] font-semibold leading-4 text-white tnum',
          urgent && 'animate-pulse-dot')}>
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  )
}
