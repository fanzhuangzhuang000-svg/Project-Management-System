import { useEffect, useState } from 'react'
import { Palette, Save, RotateCcw, Eye, Sparkles } from 'lucide-react'
import { Button, Card, IconTile, Input, Pill, Skeleton } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'
import { useApp, DEFAULT_SETTINGS } from '@/app-context'
import { http, type AppSettings } from '@/lib/api'
import { cn, pickWelcomeSlot, renderWelcome } from '@/lib/utils'

const SLOTS: { key: keyof AppSettings; label: string; hint: string }[] = [
  { key: 'welcome_morning', label: '上午 05:00 - 12:00', hint: '上午好，{公司名} 👋' },
  { key: 'welcome_afternoon', label: '下午 12:00 - 18:00', hint: '下午好，{公司名} ☕' },
  { key: 'welcome_evening', label: '晚上 18:00 - 次日 05:00', hint: '晚上好，{公司名} 🌙' },
]

export function AppearanceSettingsCard () {
  const { settings, refreshSettings } = useApp()
  const toast = useToast()
  const [form, setForm] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [busy, setBusy] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    // 优先用全局上下文里的（已经带了），没有再拉一次
    if (settings) { setForm({ ...DEFAULT_SETTINGS, ...settings }); setLoaded(true); return }
    http.settings().then(r => setForm({ ...DEFAULT_SETTINGS, ...r.settings }))
      .catch(() => { /* 用默认值兜底 */ })
      .finally(() => setLoaded(true))
  }, [settings])

  const set = (k: keyof AppSettings, v: string) => setForm(f => ({ ...f, [k]: v }))

  const save = async () => {
    setBusy(true)
    try {
      const r = await http.saveSettings(form)
      toast('界面已更新', 'ok')
      setForm({ ...DEFAULT_SETTINGS, ...r.settings })
      await refreshSettings()
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally { setBusy(false) }
  }

  const reset = () => setForm({ ...DEFAULT_SETTINGS })

  const activeKey = pickWelcomeSlot()
  const preview = renderWelcome(form[activeKey] as string, form.company_name)
  const dirty = settings
    ? Object.keys(DEFAULT_SETTINGS).some(k => (form as any)[k] !== (settings as any)[k])
    : false

  if (!loaded) {
    return (
      <Card className="xl:col-span-7">
        <div className="px-5 pt-5 pb-4 text-cardtitle text-ink-700">界面自定义</div>
        <div className="space-y-3 px-5 pb-5">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      </Card>
    )
  }

  return (
    <Card className="xl:col-span-7">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-3">
        <IconTile icon={Palette} tone="purple" size="md" />
        <div className="min-w-0 flex-1">
          <div className="text-cardtitle text-ink-900">界面自定义</div>
          <div className="text-tiny text-ink-400">
            改成你自己公司的名字和说话方式 —— 侧边栏、浏览器标签页、登录页、首页欢迎语都会跟着变
          </div>
        </div>
        {dirty && <Pill tone="orange">有未保存的改动</Pill>}
      </div>

      <div className="space-y-4 px-5 pb-5">
        {/* 公司名 + 系统名 */}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-ink-600">公司名称</span>
            <Input value={form.company_name} onChange={e => set('company_name', e.target.value)}
              placeholder="项目团队" className="!h-10" />
            <span className="mt-1 block text-tiny text-ink-400">
              欢迎语里的 <code className="rounded bg-slate-100 px-1">{'{公司名}'}</code> 会替换成它
            </span>
          </label>
          <label className="block">
            <span className="mb-1 block text-tiny font-medium text-ink-600">系统名称</span>
            <Input value={form.system_name} onChange={e => set('system_name', e.target.value)}
              placeholder="弱电智能化工程项目管理系统" className="!h-10" />
            <span className="mt-1 block text-tiny text-ink-400">
              显示在侧边栏、浏览器标签页、登录页
            </span>
          </label>
        </div>

        {/* 三个时段 */}
        <div className="rounded-tile bg-slate-50 px-3.5 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-tiny font-medium text-ink-600">
            <Sparkles size={13} className="text-brand" /> 首页欢迎语（按时间自动切换）
          </div>
          <div className="space-y-2.5">
            {SLOTS.map(s => (
              <label key={s.key} className="flex flex-wrap items-center gap-2">
                <span className={cn('w-[132px] flex-none text-tiny',
                  activeKey === s.key ? 'font-semibold text-brand' : 'text-ink-500')}>
                  {s.label}
                  {activeKey === s.key && <span className="ml-1 text-[10px]">← 当前</span>}
                </span>
                <Input value={String(form[s.key] ?? '')} onChange={e => set(s.key, e.target.value)}
                  placeholder={s.hint} className="!h-9 min-w-[200px] flex-1 text-tiny" />
              </label>
            ))}
            <label className="flex flex-wrap items-center gap-2">
              <span className="w-[132px] flex-none text-tiny text-ink-500">副标题</span>
              <Input value={form.welcome_subtitle} onChange={e => set('welcome_subtitle', e.target.value)}
                placeholder="以下是您团队今日的工作概览" className="!h-9 min-w-[200px] flex-1 text-tiny" />
            </label>
          </div>
        </div>

        {/* 即时预览 */}
        <div className="rounded-tile bg-gradient-to-br from-[#3B82F6] to-[#6366F1] px-4 py-3 text-white">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-white/70">
            <Eye size={12} /> 实时预览（现在这个点首页会显示）
          </div>
          <div className="text-body font-bold">{preview}</div>
          <div className="mt-0.5 text-tiny text-white/80">{form.welcome_subtitle}</div>
        </div>
{/* 备份异地存放 */} <div className="rounded-tile bg-slate-50 px-3.5 py-3">   <div className="mb-2 text-tiny font-medium text-ink-600">备份异地存放</div>   <div className="space-y-2.5">     <label className="flex flex-wrap items-center gap-2">       <span className="w-[92px] flex-none text-tiny text-ink-500">方式</span>       <select         value={String((form as any).backup_remote ?? 'off')}         onChange={e => set('backup_remote' as any, e.target.value)}         className="h-9 min-w-[180px] flex-1 rounded-tile bg-white px-3 text-tiny text-ink-800 outline-none"       >         <option value="off">只留本地（默认）</option>         <option value="share">复制到局域网共享目录</option>         <option value="minio">上传到 MinIO（网络版）</option>       </select>     </label>     {String((form as any).backup_remote) === 'share' && (       <label className="flex flex-wrap items-center gap-2">         <span className="w-[92px] flex-none text-tiny text-ink-500">共享目录</span>         <Input           value={String((form as any).backup_share ?? '')}           onChange={e => set('backup_share' as any, e.target.value)}           placeholder="\\\\NAS\\backup\\elv-pms  或  Z:\\备份"           className="!h-9 min-w-[200px] flex-1 text-tiny"         />       </label>     )}     <span className="block text-tiny leading-relaxed text-ink-400">       本地备份只防手滑删库，防不了这台电脑坏掉。异地失败不会影响本地备份。     </span>   </div> </div> 

        {/* 操作日志保留期 */}
        <label className="block">
          <span className="mb-1 block text-tiny font-medium text-ink-600">操作日志保留期</span>
          <select
            value={String((form as any).log_retention_days ?? '365')}
            onChange={e => set('log_retention_days' as any, e.target.value)}
            className="h-10 w-full rounded-tile bg-slate-50 px-3 text-body text-ink-800 outline-none"
          >
            <option value="90">保留 3 个月</option>
            <option value="180">保留 6 个月</option>
            <option value="365">保留 1 年</option>
            <option value="0">永久保留</option>
          </select>
          <span className="mt-1 block text-tiny text-ink-400">
            超期的操作日志会在启动时和每天自动清理（数据本身不受影响）
          </span>
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={save} disabled={busy}>
            <Save size={14} /> {busy ? '保存中…' : '保存'}
          </Button>
          <Button size="sm" variant="soft" onClick={reset} disabled={busy}>
            <RotateCcw size={14} /> 恢复默认
          </Button>
          <span className="text-tiny text-ink-400">改了要保存才生效</span>
        </div>
      </div>
    </Card>
  )
}

