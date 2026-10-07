import { useEffect, useState } from 'react'
import {
  Send, Plus, Trash2, Loader2, CircleCheck, CircleAlert, Bell, ExternalLink,
} from 'lucide-react'
import { Button, Card, Field, Input, Select, Pill, Skeleton, IconTile } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'
import { http, type AiPushConfig, type AiPushChannel } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * 系统设置 → 简报推送
 *
 * 每天定时把「今日经营简报」推到企业微信/钉钉/飞书群，或者通过 Server酱/PushPlus
 * 推到个人微信。都是普通 HTTP POST，不依赖邮件服务器。
 */
export function PushSettingsCard () {
  const [cfg, setCfg] = useState<AiPushConfig | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [time, setTime] = useState('08:30')
  const [channels, setChannels] = useState<AiPushChannel[]>([])
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; lines: string[] } | null>(null)
  const toast = useToast()

  const apply = (c: AiPushConfig) => {
    setCfg(c)
    setEnabled(c.enabled)
    setTime(c.time || '08:30')
    setChannels(c.channels || [])
  }

  useEffect(() => {
    http.ai.pushConfig().then(apply).catch(() => { /* 没权限就整块不显示 */ })
  }, [])

  if (!cfg) return <Card className="xl:col-span-12"><div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">简报推送</div><div className="px-5 pb-5"><Skeleton className="h-24" /></div></Card>

  const types = cfg.types || []
  const addChannel = () => {
    const t = types[0]
    setChannels([...channels, { type: t.value, url: '', key: '', secret: '', label: t.label }])
  }
  const setCh = (i: number, patch: Partial<AiPushChannel>) => {
    const next = channels.slice()
    next[i] = { ...next[i], ...patch }
    if (patch.type) next[i].label = types.find(t => t.value === patch.type)?.label || patch.type
    setChannels(next)
  }

  const save = async () => {
    setSaving(true)
    setResult(null)
    try {
      const saved = await http.ai.savePush({ enabled, time, channels })
      apply({ ...cfg, ...saved })
      toast('推送设置已保存', 'ok')
    } catch (e) { toast((e as Error).message, 'err') }
    finally { setSaving(false) }
  }

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      // 先存再试，否则试的是旧配置
      await http.ai.savePush({ enabled, time, channels })
      const r = await http.ai.testPush()
      setResult({
        ok: r.ok,
        lines: r.results.map(x => `${x.label}：${x.ok ? '✓ 已发送' : '✗ ' + x.error}`),
      })
    } catch (e) {
      setResult({ ok: false, lines: [(e as Error).message] })
    } finally { setTesting(false) }
  }

  return (
    <Card className="xl:col-span-12">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-3">
        <IconTile icon={Bell} tone="warm" size="sm" />
        <span className="text-cardtitle text-ink-700">简报推送</span>
        <span className="text-tiny text-ink-400">每天定时把经营简报推到群里或个人微信</span>
        <span className="ml-auto">
          {cfg.enabled && channels.length
            ? <Pill tone="green" dot>每天 {cfg.time}</Pill>
            : <Pill tone="gray">未启用</Pill>}
        </span>
      </div>

      <div className="px-5 pb-5 space-y-3.5">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex cursor-pointer items-center gap-2.5 rounded-tile bg-slate-50 px-3.5 py-2.5">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
              className="h-4 w-4 accent-[#3B82F6]" />
            <span className="text-body font-medium text-ink-900">启用每日推送</span>
          </label>
          <Field label="推送时间" className="w-32">
            <Input type="time" value={time} onChange={e => setTime(e.target.value)} />
          </Field>
          <span className="pb-2 text-tiny text-ink-400">
            服务器到点后自动发送；当天已经发过就不会重发
          </span>
        </div>

        <div className="space-y-2.5">
          {channels.map((ch, i) => {
            const def = types.find(t => t.value === ch.type)
            return (
              <div key={i} className="rounded-tile bg-slate-50 p-3.5">
                <div className="flex flex-wrap items-end gap-3">
                  <Field label="推送方式" className="w-52">
                    <Select value={ch.type} onChange={e => setCh(i, { type: e.target.value, url: '', key: '', secret: '' })}>
                      {types.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </Select>
                  </Field>
                  <Field label={def?.need?.includes('key') ? '密钥' : 'Webhook 地址'} className="min-w-[240px] flex-1"
                    hint={def?.hint}>
                    <Input
                      value={(def?.need?.includes('key') ? ch.key : ch.url) || ''}
                      onChange={e => setCh(i, def?.need?.includes('key') ? { key: e.target.value } : { url: e.target.value })}
                      placeholder={def?.urlHint}
                    />
                  </Field>
                  {ch.type === 'dingtalk' && (
                    <Field label="加签密钥（可选）" className="w-52" hint="安全设置选「加签」时填">
                      <Input value={ch.secret || ''} onChange={e => setCh(i, { secret: e.target.value })} placeholder="SEC..." />
                    </Field>
                  )}
                  <Button variant="plain" onClick={() => setChannels(channels.filter((_, k) => k !== i))} title="删除这个渠道">
                    <Trash2 size={15} />
                  </Button>
                </div>
              </div>
            )
          })}

          <Button variant="soft" onClick={addChannel}><Plus size={15} /> 添加推送渠道</Button>
        </div>

        <div className="flex flex-wrap gap-2.5">
          <Button variant="primary" disabled={saving} onClick={save}>
            {saving ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} 保存推送设置
          </Button>
          <Button variant="soft" disabled={testing || !channels.length} onClick={test} title={!channels.length ? '先添加一个渠道' : ''}>
            {testing ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />} 立即试推一次
          </Button>
          {cfg.lastSent && <span className="self-center text-tiny text-ink-400">上次推送：{cfg.lastSent}</span>}
        </div>

        {result && (
          <div className={cn('flex items-start gap-2 rounded-tile px-3.5 py-3', result.ok ? 'bg-green-50' : 'bg-red-50')}>
            {result.ok ? <CircleCheck size={14} className="mt-0.5 flex-none text-up" />
              : <CircleAlert size={14} className="mt-0.5 flex-none text-down" />}
            <div className="min-w-0 space-y-0.5">
              {result.lines.map((l, i) => (
                <div key={i} className={cn('text-tiny leading-relaxed', result.ok ? 'text-up' : 'text-down')}>{l}</div>
              ))}
            </div>
          </div>
        )}

        <div className="flex items-start gap-2 rounded-tile bg-amber-50 px-3.5 py-3">
          <CircleAlert size={14} className="mt-0.5 flex-none text-orange-500" />
          <div className="text-tiny leading-relaxed text-ink-600">
            <b>推送内容包含完整经营数据</b>（项目名、金额、往来单位），请确认收到的人有权查看。
            推送用的是管理员视角，不受个人权限限制。
            <a href="https://sct.ftqq.com" target="_blank" rel="noreferrer"
              className="ml-1 inline-flex items-center gap-0.5 text-brand hover:underline">
              Server酱申请地址 <ExternalLink size={11} />
            </a>
          </div>
        </div>
      </div>
    </Card>
  )
}
