import { Outlet, useLocation } from 'react-router-dom'
import { Sidebar } from './Sidebar'
import { Topbar } from './Topbar'
import { AiAssistant } from './AiAssistant'
import { LicenseBanner } from './LicenseBanner'
import { DashAside } from './DashAside'
import { useApp, DEFAULT_SETTINGS } from '@/app-context'
import { titleOf } from '@/lib/nav'
import { Modal, useConfirm, useToast } from '@/components/ui/overlay'
import { Button, Field, Input, Pill } from '@/components/ui/primitives'
import { http } from '@/lib/api'
import { useState } from 'react'
import { cn } from '@/lib/utils'

export function AppShell() {
  const { user, meta, dash, trashCount, settings } = useApp()
  const S = settings || DEFAULT_SETTINGS
  const loc = useLocation()
  const [todoOpen, setTodoOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  // 辅助栏：只在工作台/报表这类「总览页」显示（设计稿：右侧栏跟着工作台走）
  const showAside = ['/', '/dashboard', '/reports'].includes(loc.pathname)

  if (!user) return null

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar perms={user.perms} dash={dash} badges={{ trash: trashCount, attachments: (dash?.totals as any)?.attachment_count }} />

      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          user={user}
          dash={dash}
          onOpenTodo={() => setTodoOpen(true)}
          onOpenProfile={() => setProfileOpen(true)}
        />

        <div className="flex min-h-0 flex-1">
          <main className="min-w-0 flex-1 overflow-y-auto px-6 pb-24 pt-5">
            {/* 授权到期提醒（正常时不渲染任何东西） */}
            <LicenseBanner />

            {/* 面包屑（轻量，不占视觉重量） */}
            <div className="mb-4 flex items-center gap-2 text-tiny text-ink-400">
              <span>{S.system_name}</span>
              <span className="text-ink-200">/</span>
              <span className="text-ink-500">{titleOf(loc.pathname, meta?.tables || {})}</span>
            </div>
            <Outlet />
          </main>

          {/* 右侧辅助栏（320px）：欢迎卡 / 常用功能 / 排行 / 公告 */}
          {showAside && <DashAside dash={dash} user={user} />}
        </div>
      </div>

      <AiAssistant dash={dash} />
      <TodoPanel open={todoOpen} onClose={() => setTodoOpen(false)} />
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
    </div>
  )
}

/* ---------------- 待办清单抽屉 ---------------- */
function TodoPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { dash } = useApp()
  const reminders = dash?.reminders || []
  const TONE = { danger: 'red', warn: 'orange', info: 'blue' } as const

  return (
    <Modal open={open} onClose={onClose} title={`待办清单（${reminders.length}）`} width="md">
      {!reminders.length ? (
        <p className="pb-4 text-body text-ink-400">当前没有待办事项 🎉</p>
      ) : (
        <div className="space-y-2 pb-4">
          {reminders.map((r, i) => (
            <a
              key={i} href={`#${r.href}`} onClick={onClose}
              className="flex items-center gap-3 rounded-tile bg-slate-50 px-4 py-3 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft"
            >
              <Pill tone={TONE[r.level]} dot>{r.level === 'danger' ? '紧急' : r.level === 'warn' ? '待办' : '关注'}</Pill>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium text-ink-900">{r.title}</span>
                <span className="block truncate text-tiny text-ink-400">{r.detail}</span>
              </span>
            </a>
          ))}
        </div>
      )}
    </Modal>
  )
}

/* ---------------- 修改密码 ---------------- */
function ProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const submit = async () => {
    setErr('')
    if (newPw.length < 6) { setErr('新密码至少 6 位'); return }
    if (newPw !== newPw2) { setErr('两次输入的新密码不一致'); return }
    setBusy(true)
    try {
      await http.changePassword(oldPw, newPw)
      toast('密码已修改', 'ok')
      setOldPw(''); setNewPw(''); setNewPw2('')
      onClose()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal
      open={open} onClose={onClose} title="修改我的密码" width="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={submit} disabled={busy}>{busy ? '提交中…' : '确认修改'}</Button>
      </>}
    >
      <div className="space-y-4 pb-2">
        <Field label="原密码"><Input type="password" value={oldPw} onChange={e => setOldPw(e.target.value)} /></Field>
        <Field label="新密码" hint="至少 6 位"><Input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} /></Field>
        <Field label="确认新密码"><Input type="password" value={newPw2} onChange={e => setNewPw2(e.target.value)} /></Field>
        {err && <div className="rounded-tile bg-red-50 px-3.5 py-2.5 text-tiny text-red-600">{err}</div>}
      </div>
    </Modal>
  )
}
