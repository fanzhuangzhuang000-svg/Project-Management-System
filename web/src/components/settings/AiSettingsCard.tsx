import { useEffect, useState } from 'react'
import {
  Bot, CircleCheck, CircleAlert, Loader2, ExternalLink, Sparkles, Eye, EyeOff, Zap,
} from 'lucide-react'
import { Button, Card, Field, Input, Select, Pill, Skeleton } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'
import { http, type AiConfig, type AiProvider } from '@/lib/api'
import { cn } from '@/lib/utils'

/**
 * 系统设置 → 智能助手
 *
 * 关键点：
 *  - API 密钥只在保存时提交一次，之后页面只会显示掩码，服务端从不回传原文
 *  - 「测试连接」支持边填边测：用当前输入框里的值直接试，不用先保存
 *  - 所有真实调用都经过后端代理，浏览器里拿不到密钥
 */
export function AiSettingsCard() {
  const [cfg, setCfg] = useState<AiConfig | null>(null)
  const [provider, setProvider] = useState('deepseek')
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [includeContext, setIncludeContext] = useState(true)
  const [useTools, setUseTools] = useState(true)
  const [allowWrite, setAllowWrite] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const toast = useToast()

  const apply = (c: AiConfig) => {
    setCfg(c)
    setProvider(c.provider)
    setBaseUrl(c.baseUrl || '')
    setModel(c.model || '')
    setEnabled(c.enabled)
    setIncludeContext(c.includeContext !== false)
    setUseTools(c.useTools !== false)
    setAllowWrite(c.allowWrite === true)
  }

  const load = async () => {
    try { apply(await http.ai.config()) }
    catch (e) { toast((e as Error).message, 'err') }
  }
  useEffect(() => { void load() }, [])

  const meta: AiProvider | undefined = cfg?.providers?.find(p => p.value === provider)

  /** 换厂商：自动带上该厂商的默认地址和模型 */
  const onProvider = (v: string) => {
    setProvider(v)
    const p = cfg?.providers?.find(x => x.value === v)
    if (p) { setBaseUrl(p.baseUrl); setModel(p.defaultModel) }
    setResult(null)
  }

  const save = async () => {
    setSaving(true)
    setResult(null)
    try {
      const body: Record<string, any> = { provider, baseUrl, model, enabled, includeContext, useTools, allowWrite }
      // 只在用户真的输入了密钥时才提交，空着表示「不改动已保存的密钥」
      if (apiKey.trim()) body.apiKey = apiKey.trim()
      const saved = await http.ai.saveConfig(body)
      apply(saved)
      setApiKey('')
      toast('AI 助手设置已保存', 'ok')
    } catch (e) { toast((e as Error).message, 'err') }
    finally { setSaving(false) }
  }

  const test = async () => {
    setTesting(true)
    setResult(null)
    try {
      const r = await http.ai.test({ provider, baseUrl, model, apiKey: apiKey.trim() || undefined })
      setResult({ ok: true, text: `连接成功（${r.ms} ms）· ${r.provider} / ${r.model}${r.reply ? ` · 模型回复：「${r.reply}」` : ''}` })
    } catch (e) {
      setResult({ ok: false, text: (e as Error).message })
    } finally { setTesting(false) }
  }

  const clearKey = async () => {
    try {
      const saved = await http.ai.saveConfig({ apiKey: null })
      apply(saved)
      toast('已清除密钥', 'ok')
    } catch (e) { toast((e as Error).message, 'err') }
  }

  if (!cfg) {
    return (
      <Card className="xl:col-span-12">
        <div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">智能助手</div>
        <div className="px-5 pb-5"><Skeleton className="h-40" /></div>
      </Card>
    )
  }

  if (!cfg.canEdit) {
    return (
      <Card className="xl:col-span-12">
        <div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">智能助手</div>
        <div className="px-5 pb-5 text-body text-ink-500">
          当前状态：{cfg.ready ? `已接入 ${cfg.providerLabel} / ${cfg.model}` : '尚未配置'}
          <span className="ml-2 text-tiny text-ink-400">（只有管理员能修改）</span>
        </div>
      </Card>
    )
  }

  return (
    <Card className="xl:col-span-12">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-3">
        <span className="text-cardtitle text-ink-700">智能助手</span>
        <span className="text-tiny text-ink-400">接入 DeepSeek 等大模型，让它基于你的真实经营数据回答问题</span>
        <span className="ml-auto flex items-center gap-2">
          {cfg.ready
            ? <Pill tone="green" dot>已启用</Pill>
            : <Pill tone="gray">未启用</Pill>}
        </span>
      </div>

      <div className="px-5 pb-5">
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          {/* 左：基本配置 */}
          <div className="space-y-3.5 lg:col-span-7">
            <Field label="模型厂商" hint={meta?.note}>
              <Select value={provider} onChange={e => onProvider(e.target.value)}>
                {(cfg.providers || []).map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
              </Select>
            </Field>

            <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
              <Field label="模型名称" hint={meta?.models?.length ? `常用：${meta.models.slice(0, 3).join('、')}` : '按厂商要求填写'}>
                <Input value={model} onChange={e => setModel(e.target.value)} placeholder="deepseek-chat" list="ai-models" />
                <datalist id="ai-models">
                  {(meta?.models || []).map(m => <option key={m} value={m} />)}
                </datalist>
              </Field>
              <Field label="接口地址" hint="一般不用改，换厂商会自动填">
                <Input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://api.deepseek.com/v1" />
              </Field>
            </div>

            <Field label="API 密钥"
              hint={cfg.hasKey ? `已保存：${cfg.keyHint}（留空则不改动）` : '密钥只保存在本机服务器上，不会发到浏览器'}>
              <div className="relative">
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={cfg.hasKey ? '留空表示不修改' : 'sk-...'}
                  autoComplete="off"
                  className="pr-10"
                />
                <button type="button" onClick={() => setShowKey(v => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-ink-300 transition-colors duration-200 hover:text-ink-500"
                  title={showKey ? '隐藏' : '显示'}>
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </Field>

            {meta?.keyUrl && (
              <a href={meta.keyUrl} target="_blank" rel="noreferrer"
                className="inline-flex items-center gap-1 text-tiny text-brand hover:underline">
                去 {meta.label} 申请密钥 <ExternalLink size={12} />
              </a>
            )}
          </div>

          {/* 右：开关与操作 */}
          <div className="space-y-3 lg:col-span-5">
            <label className="flex cursor-pointer items-start gap-2.5 rounded-tile bg-slate-50 px-3.5 py-3">
              <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-none accent-[#3B82F6]" />
              <span>
                <span className="block text-body font-medium text-ink-900">启用智能助手</span>
                <span className="mt-0.5 block text-tiny leading-relaxed text-ink-400">
                  关掉后所有人只能看到本地的数据分析，不会产生任何模型调用费用。
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-tile bg-slate-50 px-3.5 py-3">
              <input type="checkbox" checked={includeContext} onChange={e => setIncludeContext(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-none accent-[#3B82F6]" />
              <span>
                <span className="block text-body font-medium text-ink-900">自动附带经营数据</span>
                <span className="mt-0.5 block text-tiny leading-relaxed text-ink-400">
                  强烈建议开启。开启后模型能看到你的项目、合同、收付款数据，
                  才能回答「哪个项目要超支」这类问题；关掉就只能聊通用话题。
                  数据按当前用户的权限过滤，看不到的模块不会发出去。
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-tile bg-slate-50 px-3.5 py-3">
              <input type="checkbox" checked={useTools} onChange={e => setUseTools(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-none accent-[#3B82F6]" />
              <span>
                <span className="flex items-center gap-1.5 text-body font-medium text-ink-900">
                  允许模型自己查明细
                  <Pill tone="blue">推荐</Pill>
                </span>
                <span className="mt-0.5 block text-tiny leading-relaxed text-ink-400">
                  开启后模型可以按需查询项目、合同、收付款、计划、发票、费用等明细，
                  回答「第一人民医院那笔验收款什么时候到期」这类具体问题，也更省 token。
                  需要模型支持 function calling（DeepSeek、通义、Kimi、智谱、OpenAI 都支持）。
                  <b className="text-ink-500">Claude 暂不支持，会自动跳过。</b>
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 rounded-tile bg-slate-50 px-3.5 py-3">
              <input type="checkbox" checked={allowWrite} onChange={e => setAllowWrite(e.target.checked)}
                className="mt-0.5 h-4 w-4 flex-none accent-[#3B82F6]" />
              <span>
                <span className="flex flex-wrap items-center gap-1.5 text-body font-medium text-ink-900">
                  允许 AI 帮忙录入数据
                  <Pill tone="gray">默认关闭</Pill>
                </span>
                <span className="mt-0.5 block text-tiny leading-relaxed text-ink-400">
                  开启后可以直接跟它说「帮我把这个合同录进去」。
                  <b className="text-ink-600">它不会偷偷写库</b>——只会生成一张「待确认」卡片，
                  你核对过、点了「确认录入」才真正保存。没有写权限的账号用不了。
                </span>
              </span>
            </label>

            <div className="rounded-tile bg-amber-50 px-3.5 py-3">
              <div className="flex items-start gap-2">
                <CircleAlert size={14} className="mt-0.5 flex-none text-orange-500" />
                <div className="text-tiny leading-relaxed text-ink-600">
                  开启后，你的经营数据（项目名、金额、往来单位）会发送给所选的模型厂商。
                  涉密项目请慎用，或改用「本地 Ollama」离线跑。
                </div>
              </div>
            </div>

            <div className="flex flex-wrap gap-2.5 pt-1">
              <Button variant="primary" disabled={saving} onClick={save}>
                {saving ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} 保存设置
              </Button>
              <Button variant="soft" disabled={testing} onClick={test}>
                {testing ? <Loader2 size={15} className="animate-spin" /> : <Zap size={15} />} 测试连接
              </Button>
              {cfg.hasKey && (
                <Button variant="plain" onClick={clearKey}>清除密钥</Button>
              )}
            </div>

            {result && (
              <div className={cn('flex items-start gap-2 rounded-tile px-3.5 py-3',
                result.ok ? 'bg-green-50' : 'bg-red-50')}>
                {result.ok
                  ? <CircleCheck size={14} className="mt-0.5 flex-none text-up" />
                  : <CircleAlert size={14} className="mt-0.5 flex-none text-down" />}
                <span className={cn('text-tiny leading-relaxed', result.ok ? 'text-up' : 'text-down')}>
                  {result.text}
                </span>
              </div>
            )}

            <div className="flex items-start gap-2 pt-1 text-tiny leading-relaxed text-ink-400">
              <Bot size={13} className="mt-0.5 flex-none" />
              <span>
                保存后，页面右下角的「智能项目分析助手」就会变成真实对话。
                每个账号每分钟最多问 10 次，避免误操作烧钱。
              </span>
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}
