import { NavLink } from 'react-router-dom'
import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { visibleNav } from '@/lib/nav'
import type { Perms } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useApp, DEFAULT_SETTINGS } from '@/app-context'

/**
 * 左侧固定导航栏（220px，纯白背景 —— 管理系统 2.0 风格）
 * · 顶部：蓝色小方块 Logo + 系统名（粗体黑字）
 * · 分组可折叠：组标题行带展开箭头，点击整组收起/展开
 * · 选中项：浅蓝底 #EFF6FF + 蓝字 #2563EB（无左侧指示条）
 */
export function Sidebar({
  perms, badges,
}: { perms?: Perms; dash?: unknown; badges?: { trash?: number; attachments?: number } }) {
  const { settings } = useApp()
  const S = settings || DEFAULT_SETTINGS
  const groups = visibleNav(perms)
  const [collapsed, setCollapsed] = useState(false)
  // 默认全部展开；收起状态记在本地，下次进来保持
  const [closedGroups, setClosedGroups] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('pms.sidebar.groups') || '{}') } catch { return {} }
  })

  const toggleGroup = (title: string) => {
    setClosedGroups(prev => {
      const next = { ...prev, [title]: !prev[title] }
      try { localStorage.setItem('pms.sidebar.groups', JSON.stringify(next)) } catch { /* 忽略 */ }
      return next
    })
  }

  return (
    <aside
      className={cn(
        'relative z-30 flex h-full flex-none flex-col transition-[width] duration-200 ease-out',
        collapsed ? 'w-[76px]' : 'w-[220px]',
      )}
      style={{
        background: 'var(--card-bg)',
        boxShadow: '1px 0 0 var(--topbar-line), 8px 0 24px rgba(15,23,42,.03)',
      }}
    >
      {/* ---- Logo 区（高 64px）：蓝色小方块 + 粗体黑字 ---- */}
      <div className={cn('flex h-16 flex-none items-center gap-3', collapsed ? 'justify-center px-0' : 'px-5')}>
        <span
          className="grad-brand flex h-9 w-9 flex-none items-center justify-center rounded-[11px] text-white"
          style={{ boxShadow: '0 6px 18px rgba(59,130,246,.45)' }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="10" width="18" height="11" rx="2.5" />
            <path d="M7 10V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v3" />
          </svg>
        </span>
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[15px] font-bold text-ink-900" title={S.system_name}>{S.system_name}</div>
            <div className="truncate text-[11px] tracking-[0.12em] text-ink-400">ELV PMS</div>
          </div>
        )}
      </div>

      {/* ---- 菜单区：分组可折叠 ---- */}
      <nav className="no-scrollbar flex-1 overflow-y-auto pb-4">
        {groups.map((group, gi) => {
          const closed = !!closedGroups[group.title]
          return (
            <div key={group.title} className="mb-0.5">
              {/* 分隔线：第一组之前不画，之后每组一条浅线 */}
              {gi > 0 && <div className="mx-4 my-1.5 h-px" style={{ background: 'var(--topbar-line)' }} />}
              {!collapsed ? (
                <button
                  onClick={() => toggleGroup(group.title)}
                  className="flex w-full items-center gap-1 px-5 pb-1 pt-2.5 text-[11px] font-medium tracking-wider text-ink-400 transition-colors duration-200 hover:text-ink-500"
                >
                  <span className="flex-1 text-left">{group.title}</span>
                  <ChevronDown
                    size={13}
                    className={cn('text-ink-400 transition-transform duration-200', closed && '-rotate-90')}
                  />
                </button>
              ) : (
                <div className="mx-3 my-2 h-px" style={{ background: 'var(--topbar-line)' }} />
              )}
              {/* 组体：折叠时高度收为 0（不用 display:none，保住展开动画的顺滑） */}
              <div
                className="overflow-hidden transition-[max-height] duration-200 ease-out"
                style={{ maxHeight: collapsed || !closed ? 640 : 0 }}
              >
                {(collapsed ? group.items.slice(0, 1) : group.items).map(item => (
                  <NavLink
                    key={item.key}
                    to={item.to}
                    title={collapsed ? item.label : undefined}
                    className={({ isActive }) => cn('nav-item mx-3', collapsed && 'justify-center px-0', isActive && 'active')}
                  >
                    {({ isActive }) => (
                      <>
                        <item.icon
                          size={20}
                          strokeWidth={2}
                          className={cn('flex-none', isActive ? 'text-brand' : 'text-ink-400')}
                        />
                        {!collapsed && (
                          <>
                            <span className="truncate text-[14px]">{item.label}</span>
                            {item.badge && !!badges?.[item.badge] && (
                              <span className="ml-auto rounded-full bg-slate-100 px-2 py-[1px] text-[11px] tnum text-ink-500">
                                {badges![item.badge]}
                              </span>
                            )}
                          </>
                        )}
                      </>
                    )}
                  </NavLink>
                ))}
              </div>
            </div>
          )
        })}
      </nav>

      {/* 折叠按钮 */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="absolute right-[-11px] top-[86px] hidden h-[22px] w-[22px] items-center justify-center rounded-full text-ink-400 shadow-soft transition-transform duration-200 hover:text-brand lg:flex"
        style={{ background: 'var(--card-bg)', transform: collapsed ? 'rotate(180deg)' : undefined }}
        aria-label={collapsed ? '展开菜单' : '收起菜单'}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
      </button>
    </aside>
  )
}
