import { useEffect, useMemo, useState } from 'react'
import { Users, Plus, Pencil, Trash2, KeyRound, ShieldCheck, Unlock, UserX } from 'lucide-react'
import {
  Button, Card, Pill, Avatar, Progress, Empty, Skeleton, IconTile, Input, Field, Select,
} from '@/components/ui/primitives'
import { useConfirm, useToast, Modal } from '@/components/ui/overlay'
import { http, type User } from '@/lib/api'
import { cn, fmtInt, timeAgo } from '@/lib/utils'
import { useApp } from '@/app-context'

const ROLE_PRESETS: Record<string, { label: string; desc: string; read: string[]; write: string[]; sys: string[] }> = {
  manager: {
    label: '项目经理', desc: '看全部业务，可改项目和合同',
    read: ['projects', 'contracts', 'contract_changes', 'schedules', 'payments', 'invoices', 'expenses', 'materials', 'maintenance', 'partners'],
    write: ['projects', 'contracts', 'contract_changes', 'schedules', 'materials', 'maintenance'],
    sys: [],
  },
  finance: {
    label: '财务', desc: '管钱：合同、收付款、发票、费用',
    read: ['projects', 'contracts', 'schedules', 'payments', 'invoices', 'expenses', 'partners'],
    write: ['payments', 'invoices', 'expenses', 'schedules'],
    sys: [],
  },
  viewer: {
    label: '只读查看', desc: '只能看，改不了任何数据',
    read: ['projects', 'contracts', 'schedules', 'payments', 'invoices', 'expenses', 'materials', 'maintenance', 'partners'],
    write: [], sys: [],
  },
  custom: { label: '自定义', desc: '按需勾选模块权限', read: [], write: [], sys: [] },
}

export default function UsersPage() {
  const { meta, user: me, refreshDash, license } = useApp()
  const [users, setUsers] = useState<(User & any)[] | null>(null)
  const [guard, setGuard] = useState<any[]>([])
  const [projects, setProjects] = useState<any[]>([])
  const [editing, setEditing] = useState<any | null>(null)
  const [open, setOpen] = useState(false)
  const toast = useToast()
  const { confirm, confirmNode } = useConfirm()

  // 授权的账号数上限：达上限时提前拦，别让用户填完表单才吃一个 400
  const seats = license?.seats || 0
  const seatsExceeded = seats > 0 && !!license?.seatsExceeded

  const load = async () => {
    try {
      const [u, p] = await Promise.all([
        http.users(),
        http.list('projects', { limit: 0 }).catch(() => ({ rows: [] as any[] })),
      ])
      setUsers(u.rows); setGuard(u.loginGuard || [])
      setProjects((p as any).rows || [])
    } catch (e) { toast((e as Error).message, 'err'); setUsers([]) }
  }
  useEffect(() => { void load() }, [])

  /* 每人负责的项目数 → 任务负载 */
  const loadOf = useMemo(() => {
    const m: Record<string, number> = {}
    for (const p of projects) {
      const k = p.manager || '未分配'
      m[k] = (m[k] || 0) + 1
    }
    const max = Math.max(1, ...Object.values(m))
    return { map: m, max }
  }, [projects])

  const lockedCount = guard.filter(g => g.locked).length

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4 px-6 py-5">
        <IconTile icon={Users} tone="brand" />
        <div>
          <h1 className="text-page text-ink-900">成员管理</h1>
          <p className="mt-1 text-body text-ink-500">按「模块 × 查看/编辑」分配权限，看不到的模块不会出现在对方菜单里</p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {lockedCount > 0 && (
            <Button variant="soft" onClick={async () => {
              const r = await http.unlock({ all: true })
              toast(`已清除 ${r.cleared} 条失败记录`, 'ok'); void load()
            }}><Unlock size={15} /> 全部解锁（{lockedCount}）</Button>
          )}
          <Button variant="primary" onClick={() => {
            if (seatsExceeded) {
              toast(`已达到授权的账号数上限（${seats} 个），不能再新建成员。已有的成员可以照常使用，需要增加请联系我方升级授权。`, 'err')
              return
            }
            setEditing(null); setOpen(true)
          }}>
            <Plus size={17} /> 新建成员
          </Button>
          {seatsExceeded && (
            <span className="text-tiny text-orange-600">
              已用满 {seats} / {seats} 个账号，停用成员可腾出位置
            </span>
          )}
        </div>
      </Card>

      {/* 登录失败监控 */}
      {guard.length > 0 && (
        <Card className="px-5 py-4">
          <div className="mb-3 flex items-center gap-2">
            <ShieldCheck size={16} className={lockedCount ? 'text-down' : 'text-orange-500'} />
            <span className="text-cardtitle text-ink-700">登录安全监控</span>
            <span className="text-tiny text-ink-400">同一账号 15 分钟内错 5 次、或同一 IP 错 20 次会临时锁定 10 分钟</span>
          </div>
          <div className="space-y-2">
            {guard.map((g, i) => (
              <div key={i} className="flex items-center gap-3 rounded-tile bg-slate-50 px-4 py-2.5">
                <Pill tone={g.locked ? 'red' : 'orange'} dot>{g.locked ? `已锁定 ${g.remainSec}s` : '尝试中'}</Pill>
                <span className="text-body font-medium text-ink-900">{g.username || '—'}</span>
                <span className="text-tiny text-ink-400">来自 {g.ip || '—'}</span>
                <span className="text-tiny text-ink-400">失败 {g.fails} 次</span>
                <Button size="sm" variant="soft" className="ml-auto" onClick={async () => {
                  await http.unlock({ ip: g.ip, username: g.username })
                  toast('已解除锁定', 'ok'); void load()
                }}>解除锁定</Button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* 成员卡片网格（每行 4 个） */}
      {users === null ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[210px]" />)}
        </div>
      ) : !users.length ? (
        <Card><Empty icon={Users} title="还没有成员" /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {users.map(u => {
            const role = ROLE_PRESETS[u.role] || ROLE_PRESETS.custom
            const loadN = loadOf.map[u.name] || 0
            const online = !!u.last_login_at && (Date.now() - new Date(String(u.last_login_at).replace(' ', 'T')).getTime()) < 7 * 86400000
            return (
              <Card key={u.id} hover className="flex flex-col p-5">
                <div className="flex items-start gap-3.5">
                  <Avatar name={u.name} size={52} online={online} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[15px] font-bold text-ink-900">{u.name}</span>
                      {u.id === me?.id && <Pill tone="blue">我</Pill>}
                    </div>
                    <div className="truncate text-tiny text-ink-400">@{u.username}</div>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      <Pill tone={u.perms.all ? 'purple' : 'gray'}>
                        {u.perms.all ? '超级管理员' : role.label}
                      </Pill>
                      <Pill tone={u.status === '启用' ? 'green' : 'red'} dot>{u.status}</Pill>
                    </div>
                  </div>
                </div>

                <div className="mt-4 space-y-2 text-tiny">
                  <Row k="权限范围" v={u.perms.all ? '全部模块' : `可看 ${u.perms.read.length} · 可改 ${u.perms.write.length}`} />
                  <Row k="负责项目" v={`${loadN} 个`} />
                  <Row k="上次登录" v={u.last_login_at ? timeAgo(u.last_login_at) : '从未登录'} />
                </div>

                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between text-[11px] text-ink-400">
                    <span>任务负载</span><span className="tnum">{loadN} / {loadOf.max}</span>
                  </div>
                  <Progress value={(loadN / loadOf.max) * 100} tone={loadN > loadOf.max * 0.8 ? 'warm' : 'brand'} />
                </div>

                <div className="mt-4 flex items-center gap-1.5 pt-1">
                  <Button size="sm" variant="soft" onClick={() => { setEditing(u); setOpen(true) }}>
                    <Pencil size={14} /> 编辑
                  </Button>
                  <Button size="sm" variant="soft" onClick={async () => {
                    const ok = await confirm('重置密码？', `把「${u.name}」的密码重置为 123456，该账号下次登录时必须修改。`, '重置')
                    if (!ok) return
                    try { await http.resetPassword(u.id); toast('已重置为 123456', 'ok'); void load() }
                    catch (e) { toast((e as Error).message, 'err') }
                  }}><KeyRound size={14} /></Button>
                  {u.id !== me?.id && (
                    <Button size="sm" variant="danger" onClick={async () => {
                      const ok = await confirm('删除成员？', `将删除「${u.name}」账号，该账号会立即掉线。`, '删除', true)
                      if (!ok) return
                      try { await http.deleteUser(u.id); toast('已删除', 'ok'); void load() }
                      catch (e) { toast((e as Error).message, 'err') }
                    }}><Trash2 size={14} /></Button>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {users && (
        <Card className="px-5 py-4">
          <div className="mb-2 text-cardtitle text-ink-700">角色说明</div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {Object.entries(ROLE_PRESETS).filter(([k]) => k !== 'custom').map(([k, v]) => (
              <div key={k} className="rounded-tile bg-slate-50 px-3.5 py-2.5">
                <div className="text-body font-semibold text-ink-900">{v.label}</div>
                <div className="mt-0.5 text-tiny text-ink-400">{v.desc}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {confirmNode}
      {open && (
        <UserForm
          user={editing} tables={meta?.order || []} sysKeys={meta && (meta as any).sysKeys}
          onClose={() => setOpen(false)}
          onSaved={() => { void load(); void refreshDash() }}
        />
      )}
    </div>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-ink-400">{k}</span>
      <span className="font-medium text-ink-700">{v}</span>
    </div>
  )
}

/* ---------------- 账号表单 ---------------- */
const SYS_LABEL: Record<string, string> = {
  users: '成员管理', trash: '回收站', logs: '操作日志',
  import: '数据导入', backup: '数据备份', settings: '系统设置',
}

/** 模块权限列表：英文 key → 中文名（只影响显示，勾选逻辑仍用英文 key） */
const MODULE_LABEL: Record<string, string> = {
  projects: '项目管理',
  contracts: '合同管理',
  contract_changes: '合同变更',
  schedules: '收付款计划',
  payments: '收付款',
  invoices: '发票管理',
  expenses: '项目费用',
  materials: '材料设备',
  partners: '往来单位',
  maintenance: '售后维修',
}

function UserForm({
  user, tables, sysKeys, onClose, onSaved,
}: { user: any | null; tables: string[]; sysKeys?: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast()
  const isNew = !user
  const [username, setUsername] = useState(user?.username || '')
  const [name, setName] = useState(user?.name || '')
  const [role, setRole] = useState(user?.role || 'custom')
  const [status, setStatus] = useState(user?.status || '启用')
  const [password, setPassword] = useState('')
  const [read, setRead] = useState<string[]>(user?.perms?.read || [])
  const [write, setWrite] = useState<string[]>(user?.perms?.write || [])
  const [sys, setSys] = useState<string[]>(user?.perms?.sys || [])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const applyPreset = (r: string) => {
    setRole(r)
    const p = ROLE_PRESETS[r]
    if (p && r !== 'custom') { setRead(p.read); setWrite(p.write); setSys(p.sys) }
  }

  const toggle = (arr: string[], set: (v: string[]) => void, k: string) =>
    set(arr.includes(k) ? arr.filter(x => x !== k) : [...arr, k])

  const save = async () => {
    setErr('')
    if (!username.trim()) { setErr('登录账号不能为空'); return }
    if (isNew && password && password.length < 6) { setErr('密码至少 6 位'); return }
    setBusy(true)
    try {
      await http.saveUser({
        id: user?.id, username: username.trim(), name: name.trim() || username.trim(),
        role, status, password: password || undefined, read, write, sys,
      })
      toast(isNew ? '成员已创建' : '成员已更新', 'ok')
      onSaved(); onClose()
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const isAdmin = role === 'admin'

  return (
    <Modal
      open onClose={onClose} title={isNew ? '新建成员' : `编辑成员 · ${user?.name}`} width="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</Button>
      </>}
    >
      <div className="pb-2">
        <div className="grid grid-cols-2 gap-4">
          <Field label="登录账号 *"><Input value={username} onChange={e => setUsername(e.target.value)} placeholder="字母/数字，2-32 位" /></Field>
          <Field label="姓名"><Input value={name} onChange={e => setName(e.target.value)} /></Field>
          <Field label="角色">
            <Select value={role} onChange={e => applyPreset(e.target.value)}>
              <option value="admin">超级管理员（全部权限）</option>
              {Object.entries(ROLE_PRESETS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </Select>
          </Field>
          <Field label="状态">
            <Select value={status} onChange={e => setStatus(e.target.value)}>
              <option value="启用">启用</option><option value="停用">停用</option>
            </Select>
          </Field>
          <div className="col-span-2">
            <Field label={isNew ? '初始密码' : '重置密码（留空则不修改）'} hint="留空默认 123456，登录后必须修改">
              <Input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={isNew ? '留空则默认 123456' : ''} />
            </Field>
          </div>
        </div>

        {!isAdmin && (
          <>
            <div className="mt-5 text-cardtitle text-ink-700">模块权限</div>
            <div className="mt-2 overflow-hidden rounded-tile bg-slate-50">
              <table className="w-full text-tiny">
                <thead>
                  <tr className="text-ink-400">
                    <th className="px-4 py-2 text-left font-medium">模块</th>
                    <th className="w-20 py-2 font-medium">查看</th>
                    <th className="w-20 py-2 font-medium">编辑</th>
                  </tr>
                </thead>
                <tbody>
                  {tables.map(t => (
                    <tr key={t} className="bg-surface/60">
                      <td className="px-4 py-1.5 text-ink-700">{MODULE_LABEL[t] || t}</td>
                      <td className="py-1.5 text-center">
                        <input type="checkbox" className="h-4 w-4 cursor-pointer accent-blue-500"
                          checked={read.includes(t)} onChange={() => toggle(read, setRead, t)} />
                      </td>
                      <td className="py-1.5 text-center">
                        <input type="checkbox" className="h-4 w-4 cursor-pointer accent-blue-500"
                          checked={write.includes(t)} onChange={() => toggle(write, setWrite, t)} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-5 text-cardtitle text-ink-700">系统权限</div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(sysKeys || Object.keys(SYS_LABEL)).map(k => {
                const on = sys.includes(k)
                return (
                  <button key={k} type="button" onClick={() => toggle(sys, setSys, k)}
                    className={cn('rounded-full px-3.5 py-1.5 text-tiny font-medium transition-all duration-200',
                      on ? 'grad-brand text-white shadow-soft' : 'bg-slate-100 text-ink-500 hover:bg-slate-200')}>
                    {SYS_LABEL[k] || k}
                  </button>
                )
              })}
            </div>
          </>
        )}

        {err && <div className="mt-4 rounded-tile bg-red-50 px-3.5 py-2.5 text-tiny text-red-600">{err}</div>}
      </div>
    </Modal>
  )
}
