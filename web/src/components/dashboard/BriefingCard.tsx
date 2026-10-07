import { useEffect, useState } from 'react'
import { Newspaper, RefreshCw, Loader2, Sparkles, Settings2, CircleAlert } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { http, type AiBriefing } from '@/lib/api'
import { Card, IconTile, Button } from '@/components/ui/primitives'
import { useApp } from '@/app-context'
import { cn } from '@/lib/utils'

/**
 * 总览页的「今日经营简报」卡片
 *
 * 简报由大模型对当天经营数据生成，后端按天缓存（同一天只调一次模型）。
 * 没配置大模型时，这张卡片自己隐藏，不占地方。
 */
export function BriefingCard () {
  const [data, setData] = useState<AiBriefing | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [err, setErr] = useState('')
  const { user } = useApp()
  const nav = useNavigate()

  const canEdit = !!(user?.perms && (user.perms.all || user.perms.sys?.includes('settings')))

  const load = async (refresh = false) => {
    if (refresh) setRefreshing(true)
    try {
      const r = await http.ai.briefing(refresh)
      setData(r)
      setErr('')
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }

  useEffect(() => { void load() }, [])

  // 没配置就整张卡片不显示，别占着首页地方
  if (loading || !data || (!data.available && (data.reason || '').includes('还没启用'))) return null

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-3">
        <IconTile icon={Newspaper} tone="purple" size="sm" />
        <div className="min-w-0">
          <span className="text-cardtitle text-ink-700">今日经营简报</span>
          <span className="ml-2 text-tiny text-ink-400">{data.day}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {data.available && !data.cached && <span className="text-[11px] text-ink-300">刚刚生成</span>}
          {data.available && data.cached && <span className="text-[11px] text-ink-300">今日已生成</span>}
          {canEdit && (
            <Button size="sm" variant="soft" disabled={refreshing} onClick={() => load(true)}>
              {refreshing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} 重新生成
            </Button>
          )}
        </div>
      </div>

      <div className="px-5 pb-5">
        {!data.available ? (
          <div className="flex items-start gap-2.5 rounded-tile bg-amber-50 px-4 py-3.5">
            <CircleAlert size={15} className="mt-0.5 flex-none text-orange-500" />
            <div className="min-w-0">
              <div className="text-body text-ink-700">{data.reason}</div>
              <div className="mt-0.5 text-tiny leading-relaxed text-ink-500">{data.hint}</div>
              {canEdit && (
                <button onClick={() => nav('/settings')}
                  className="mt-1.5 flex items-center gap-1 text-tiny font-medium text-brand hover:underline">
                  <Settings2 size={12} /> 去配置
                </button>
              )}
            </div>
          </div>
        ) : err ? (
          <div className="text-tiny text-down">{err}</div>
        ) : (
          <>
            <BriefingText text={data.text || ''} />
            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-300">
              <Sparkles size={11} />
              由 {data.provider} / {data.model} 基于今日数据生成，仅供参考，决策前请自行核实
            </div>
          </>
        )}
      </div>
    </Card>
  )
}

/** 简报正文：模型给的是带 **粗体** 的短句，这里做轻量渲染 */
function BriefingText ({ text }: { text: string }) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
  return (
    <div className="space-y-2">
      {lines.map((line, i) => {
        // 以 ** 开头的行是「关注项」，做成独立条目
        const isItem = /^[-*•]?\s*\*\*/.test(line) || /^\d+[.)]\s/.test(line)
        const clean = line.replace(/^[-*•]\s*/, '')
        return (
          <div key={i}
            className={cn('text-body leading-relaxed',
              isItem ? 'rounded-tile bg-slate-50 px-3.5 py-2.5' : 'text-ink-700')}>
            <Inline text={clean} />
          </div>
        )
      })}
    </div>
  )
}

function Inline ({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith('**') && p.endsWith('**')) {
          return <strong key={i} className="font-semibold text-ink-900">{p.slice(2, -2)}</strong>
        }
        if (p.startsWith('`') && p.endsWith('`')) {
          return <code key={i} className="rounded-[4px] bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-brand">{p.slice(1, -1)}</code>
        }
        return <span key={i}>{p}</span>
      })}
    </>
  )
}
