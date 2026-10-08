import { useEffect, useState } from 'react'
import { LogIn, User as UserIcon, Lock, ShieldCheck, ArrowRight } from 'lucide-react'
import { Button, Card, Input, Pill } from '@/components/ui/primitives'
import { useApp, DEFAULT_SETTINGS } from '@/app-context'
import { http, ApiError } from '@/lib/api'
import { cn } from '@/lib/utils'

export default function LoginPage({ firstRun, initialMsg }: { firstRun: boolean; initialMsg?: string }) {
  const { setUser, refreshMeta, refreshDash, settings } = useApp()
  const S = settings || DEFAULT_SETTINGS
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [msg, setMsg] = useState(initialMsg || '')
  const [left, setLeft] = useState<number | null>(null)
  const [locked, setLocked] = useState(0)   // 锁定剩余秒数
  const [busy, setBusy] = useState(false)
  const [mustChange, setMustChange] = useState(false)
  const [newPw, setNewPw] = useState('')
  const [newPw2, setNewPw2] = useState('')

  /* 锁定倒计时 */
  useEffect(() => {
    if (locked <= 0) return
    const t = window.setInterval(() => setLocked(s => (s > 0 ? s - 1 : 0)), 1000)
    return () => window.clearInterval(t)
  }, [locked > 0])

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!username.trim() || !password) { setMsg('请输入账号和密码'); return }
    setBusy(true); setMsg(''); setLeft(null)
    try {
      const r = await http.login(username.trim(), password)
      setUser(r.user)
      if (r.user.must_change_pw) { setMustChange(true); setBusy(false); return }
      await Promise.all([refreshMeta(), refreshDash()])
    } catch (err) {
      const ae = err as ApiError
      const d: any = ae.data || {}
      if (d.locked && d.remainSec) { setLocked(d.remainSec); setMsg(ae.message) }
      else {
        setMsg(ae.message)
        if (typeof d.left === 'number' && d.left > 0) setLeft(d.left)
      }
      setBusy(false)
    }
  }

  const doChange = async (e: React.FormEvent) => {
    e.preventDefault()
    if (newPw.length < 6) { setMsg('新密码至少 6 位'); return }
    if (newPw !== newPw2) { setMsg('两次输入的新密码不一致'); return }
    setBusy(true); setMsg('')
    try {
      await http.changePassword(password, newPw)
      const me = await http.me()
      setUser(me.user)
      await Promise.all([refreshMeta(), refreshDash()])
    } catch (err) {
      setMsg((err as Error).message)
      setBusy(false)
    }
  }

  const mm = Math.floor(locked / 60), ss = locked % 60

  return (
    <div className="relative flex min-h-screen items-center justify-center p-6">
      {/* 背景光斑 */}
      <span className="pointer-events-none fixed -left-24 -top-24 h-[420px] w-[420px] rounded-full bg-blue-400/20 blur-[90px]" />
      <span className="pointer-events-none fixed -right-20 top-1/3 h-[380px] w-[380px] rounded-full bg-violet-400/20 blur-[90px]" />
      <span className="pointer-events-none fixed bottom-0 left-1/3 h-[320px] w-[320px] rounded-full bg-cyan-300/20 blur-[90px]" />

      <div className="relative z-10 grid w-full max-w-[880px] overflow-hidden rounded-card bg-surface shadow-pop lg:grid-cols-[1.05fr_1fr]">
        {/* ---- 左：品牌区 ---- */}
        <div className="grad-brand relative hidden flex-col justify-between p-9 text-white lg:flex">
          <div className="relative z-10">
            <span className="flex h-12 w-12 items-center justify-center rounded-[14px] bg-white/20 backdrop-blur">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="10" width="18" height="11" rx="2.5" />
                <path d="M7 10V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v3" />
              </svg>
            </span>
            <h1 className="mt-5 text-[26px] font-bold leading-snug">
              {S.system_name}
            </h1>
            <p className="mt-3 text-body leading-relaxed text-white/80">
              项目台账 · 合同 · 收付款计划 · 发票 · 成本毛利<br />
              一台电脑录入，全办公室局域网共享
            </p>
          </div>

          <ul className="relative z-10 mt-8 space-y-2 text-tiny text-white/80">
            {[
              '按付款条款自动生成收付款计划',
              '实际成本与动态毛利实时可见',
              '发票与收款自动勾稽',
              '扫描件识别后直接填表',
            ].map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-white/20">
                  <ArrowRight size={11} />
                </span>
                {s}
              </li>
            ))}
          </ul>

          <span className="pointer-events-none absolute -bottom-16 -right-12 h-52 w-52 rounded-full bg-white/10" />
          <span className="pointer-events-none absolute right-10 top-10 h-24 w-24 rounded-full bg-white/10" />
        </div>

        {/* ---- 右：表单区 ---- */}
        <div className="p-9">
          <div className="mb-6 flex items-center gap-3 lg:hidden">
            <span className="grad-brand flex h-10 w-10 items-center justify-center rounded-tile text-white">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <rect x="3" y="10" width="18" height="11" rx="2.5" /><path d="M7 10V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v3" />
              </svg>
            </span>
            <div className="text-[16px] font-bold text-ink-900">{S.system_name}</div>
          </div>

          {!mustChange ? (
            <form onSubmit={doLogin}>
              <h2 className="text-page text-ink-900">欢迎回来</h2>
              <p className="mt-1.5 text-body text-ink-500">请使用管理员分配的账号登录</p>

              <div className="mt-6 space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-tiny font-medium text-ink-500">登录账号</span>
                  <div className="relative">
                    <UserIcon size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
                    <Input
                      value={username} onChange={e => setUsername(e.target.value)}
                      placeholder="请输入账号" autoComplete="username" autoFocus
                      className="!pl-10" disabled={locked > 0}
                    />
                  </div>
                </label>

                <label className="block">
                  <span className="mb-1.5 block text-tiny font-medium text-ink-500">密码</span>
                  <div className="relative">
                    <Lock size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
                    <Input
                      type="password" value={password} onChange={e => setPassword(e.target.value)}
                      placeholder="请输入密码" autoComplete="current-password"
                      className="!pl-10" disabled={locked > 0}
                    />
                  </div>
                </label>
              </div>

              {msg && (
                <div className={cn(
                  'mt-4 rounded-tile px-3.5 py-2.5 text-tiny leading-relaxed',
                  locked > 0 ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700',
                )}>
                  {locked > 0
                    ? <>密码连续输错次数过多，账号已临时锁定<br /><b>{mm > 0 ? `${mm} 分 ` : ''}{ss} 秒</b>后可重试</>
                    : msg}
                  {left !== null && locked === 0 && <> （还可以试 {left} 次）</>}
                </div>
              )}

              <Button type="submit" variant="primary" size="lg" disabled={busy || locked > 0} className="mt-5 w-full">
                {locked > 0 ? '已锁定' : busy ? '登录中…' : <><LogIn size={17} /> 登 录</>}
              </Button>

              {firstRun && (
                <div className="mt-5 rounded-tile bg-blue-50 px-3.5 py-3 text-tiny leading-relaxed text-blue-700">
                  <div className="mb-1 flex items-center gap-1.5 font-semibold">
                    <ShieldCheck size={14} /> 首次使用
                  </div>
                  初始账号 <b>admin</b> / 密码 <b>admin123</b>，登录后请立即修改成你自己的密码。
                </div>
              )}
            </form>
          ) : (
            <form onSubmit={doChange}>
              <h2 className="text-page text-ink-900">设置新密码</h2>
              <p className="mt-1.5 text-body text-ink-500">首次登录或密码被重置后，需要先设置自己的密码</p>

              <div className="mt-6 space-y-4">
                <label className="block">
                  <span className="mb-1.5 block text-tiny font-medium text-ink-500">原密码</span>
                  <Input type="password" value={password} onChange={e => setPassword(e.target.value)} autoFocus />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-tiny font-medium text-ink-500">新密码</span>
                  <Input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} placeholder="至少 6 位" />
                </label>
                <label className="block">
                  <span className="mb-1.5 block text-tiny font-medium text-ink-500">确认新密码</span>
                  <Input type="password" value={newPw2} onChange={e => setNewPw2(e.target.value)} />
                </label>
              </div>

              {msg && <div className="mt-4 rounded-tile bg-amber-50 px-3.5 py-2.5 text-tiny text-amber-700">{msg}</div>}

              <Button type="submit" variant="primary" size="lg" disabled={busy} className="mt-5 w-full">
                {busy ? '提交中…' : '保存并进入系统'}
              </Button>
            </form>
          )}

          <p className="mt-6 text-center text-tiny text-ink-400">
            忘记密码请联系管理员在「成员管理」里重置
          </p>
        </div>
      </div>
    </div>
  )
}
