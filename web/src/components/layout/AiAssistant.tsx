import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Bot, Send, X, Sparkles, Settings2, Square, Trash2, Loader2,
  CircleAlert, ArrowRight, User, Copy, Check, Database, FileDown,
  Paperclip, FileSpreadsheet, ScanLine,
} from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { http, ApiError, type AiConfig, type AiMessage, type AiProposal, type AiIngestResult } from '@/lib/api'
import type { Dashboard } from '@/lib/api'
import { cn, fmtWan, n0 } from '@/lib/utils'
import { Button, Pill } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'
import { useApp } from '@/app-context'

/** 对话在浏览器本地的存放键 */
const CHAT_KEY = 'pms.ai.chat.v1'
/** 面板大小记在本地，下次打开还是你调过的尺寸 */
const SIZE_KEY = 'pms.ai.size.v1'

/** 识别等待上限：扫描件 OCR 慢的时候一张要十几秒，给足 3 分钟 */
const OCR_WAIT_MS = 3 * 60 * 1000
/** 轮询间隔 */
const OCR_POLL_MS = 2000

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

/** 识别出的字段名 → 中文（认不出类型时，把抽到的字段列给用户看） */
const FIELD_CN: Record<string, string> = {
  invoice_no: '发票号码', invoice_type: '发票种类', issue_date: '开票日期',
  amount: '金额(不含税)', tax_rate: '税率(%)', tax_amount: '税额', total_amount: '价税合计',
  code: '编号', name: '名称', sign_date: '签订日期', payment_terms: '付款条款',
  direction: '方向', remark: '备注',
}

/** 正在处理的文件（上传→识别→判断，三个阶段给用户看着） */
interface IngestTask { key: number; name: string; phase: 'upload' | 'ocr' | 'think' }

/** 进件结果里不适合做成方案卡片的两种：表格引导、认不出 */
interface IngestNote {
  key: number
  kind: 'import' | 'none'
  title: string
  body: string
  /** 可跳转的动作 */
  actionLabel?: string
  actionTo?: string
  fields?: [string, string][]
}

/** 取某条助手回复前面那条用户提问（导出报告时要写上"分析问题"） */
function prevQuestion (messages: AiMessage[], i: number): string {
  for (let k = i - 1; k >= 0; k--) {
    if (messages[k]?.role === 'user') return messages[k].content
  }
  return ''
}

/**
 * 右上角 AI 助手悬浮组件（全局）
 *
 * 两种工作模式：
 *  - 已配置大模型：真实对话，自动带上当前经营数据作为上下文
 *  - 未配置：退回到本地规则分析（原来的能力），并提示去配置
 */
export function AiAssistant({ dash }: { dash?: Dashboard | null }) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [cfg, setCfg] = useState<AiConfig | null>(null)
  // 对话记在本地：刷新页面、切来切去都不丢（只存有内容的轮次，最多留 30 条）
  const [messages, setMessages] = useState<AiMessage[]>(() => {
    try {
      const raw = localStorage.getItem(CHAT_KEY)
      const arr = raw ? JSON.parse(raw) : []
      return Array.isArray(arr) ? arr.filter((m: AiMessage) => m && m.content).slice(-30) : []
    } catch { return [] }
  })
  const [usage, setUsage] = useState<Record<string, number> | null>(null)
  // AI 生成的待确认录入方案：用户点「确认」才真正写库
  const [proposals, setProposals] = useState<AiProposal[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  /** 正在处理的文件（上传 → 识别 → 判断，三个阶段都让用户看见） */
  const [tasks, setTasks] = useState<IngestTask[]>([])
  /** 进件结果里不是"录入方案"的两种：表格引导、认不出 */
  const [notes, setNotes] = useState<IngestNote[]>([])
  const [drag, setDrag] = useState(false)
  const nav = useNavigate()
  const { meta } = useApp()

  const abortRef = useRef<AbortController | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const taskSeq = useRef(0)
  /** 上传串行化：识别队列在服务端本来就是串行的，一次甩 5 个文件没意义还刷屏 */
  const queueRef = useRef<Promise<void>>(Promise.resolve())

  /** 对话落盘 */
  useEffect(() => {
    try {
      const keep = messages.filter(m => m.content).slice(-30)
      if (keep.length) localStorage.setItem(CHAT_KEY, JSON.stringify(keep))
      else localStorage.removeItem(CHAT_KEY)
    } catch { /* 隐私模式下 localStorage 可能不可用 */ }
  }, [messages])

  // 首页那张「智能项目分析助手」卡片的「立即咨询」按钮会派发这个事件。
  // 之前只派发、没人监听，所以点了没反应 —— 这里补上监听。
  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener('open-ai-assistant', onOpen)
    return () => window.removeEventListener('open-ai-assistant', onOpen)
  }, [])

  // ---------- 面板大小（固定在右下角，拖左上角放大缩小）----------
  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem(SIZE_KEY)
      if (raw) return JSON.parse(raw)
    } catch { /* 用默认值 */ }
    return { w: 440, h: 620 }
  })
  const resizeRef = useRef<{ sx: number; sy: number; w0: number; h0: number } | null>(null)

  useEffect(() => {
    try { localStorage.setItem(SIZE_KEY, JSON.stringify(size)) } catch { /* 忽略 */ }
  }, [size])

  /**
   * 从左上角拖动缩放。
   * 面板钉在右下角，所以往左上拖 = 变大，往右下拖 = 变小。
   */
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const rect = e.currentTarget.parentElement?.getBoundingClientRect()
    resizeRef.current = { sx: e.clientX, sy: e.clientY, w0: size.w, h0: size.h }
    const maxW = Math.max(320, window.innerWidth - 48)
    const maxH = Math.max(320, window.innerHeight - 48)
    const onMove = (ev: MouseEvent) => {
      const d = resizeRef.current
      if (!d) return
      // 鼠标往左 → 宽变大；往上 → 高变大
      const w = Math.max(340, Math.min(maxW, d.w0 - (ev.clientX - d.sx)))
      const h = Math.max(320, Math.min(maxH, d.h0 - (ev.clientY - d.sy)))
      setSize({ w: Math.round(w), h: Math.round(h) })
    }
    const onUp = () => {
      resizeRef.current = null
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
    }
    void rect
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'nwse-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  /** 窗口变小的时候别让面板超出屏幕 */
  useEffect(() => {
    const onResize = () => {
      setSize(s => ({
        w: Math.min(s.w, Math.max(340, window.innerWidth - 48)),
        h: Math.min(s.h, Math.max(320, window.innerHeight - 48)),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** 双击标题栏恢复默认大小 */
  const resetSize = () => setSize({ w: 440, h: 620 })

  const clearChat = useCallback(() => {
    setMessages([])
    setUsage(null)
    setProposals([])
    setNotes([])
    setTasks([])
    setError('')
    try { localStorage.removeItem(CHAT_KEY) } catch { /* 忽略 */ }
  }, [])

  const reminders = dash?.reminders || []
  const localTips = useMemo(() => buildTips(dash?.totals || {}, reminders, dash), [dash, reminders])

  /** 首次展开时拉一次配置 */
  useEffect(() => {
    if (!open || cfg) return
    http.ai.config().then(setCfg).catch(() => setCfg(null))
  }, [open, cfg])

  /** 新内容进来时滚到底 */
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, status, open])

  const stop = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setStreaming(false)
    setStatus('')
  }, [])

  const ask = useCallback(async (question: string) => {
    const q = question.trim()
    if (!q || streaming) return
    setError('')
    setInput('')
    const history = messages.slice(-8)
    setMessages(m => [...m, { role: 'user', content: q }, { role: 'assistant', content: '' }])
    setStreaming(true)
    setStatus('正在整理经营数据…')

    const ac = new AbortController()
    abortRef.current = ac
    setUsage(null)
    try {
      await http.ai.chat({ question: q, messages: history }, {
        signal: ac.signal,
        onStatus: setStatus,
        onUsage: setUsage,
        onProposal: (p) => setProposals(list => [...list, p]),
        onDelta: (text) => {
          setStatus('')
          setMessages(m => {
            const next = m.slice()
            const last = next[next.length - 1]
            if (last && last.role === 'assistant') next[next.length - 1] = { ...last, content: last.content + text }
            return next
          })
        },
      })
    } catch (e: any) {
      if (ac.signal.aborted) {
        setMessages(m => {
          const next = m.slice()
          const last = next[next.length - 1]
          if (last && last.role === 'assistant' && !last.content) next[next.length - 1] = { ...last, content: '_（已停止）_' }
          return next
        })
      } else {
        const msg = e instanceof ApiError ? e.message : (e?.message || '调用失败')
        setError(msg)
        // 把刚才那条空的助手消息去掉，避免留个空气泡
        setMessages(m => (m[m.length - 1]?.role === 'assistant' && !m[m.length - 1].content ? m.slice(0, -1) : m))
      }
    } finally {
      setStreaming(false)
      setStatus('')
      abortRef.current = null
    }
  }, [messages, streaming])

  const ready = cfg?.ready === true
  const canEdit = cfg?.canEdit === true

  /* ---------------- 传文件进件：上传 → 识别 → 生成待确认方案 ---------------- */

  /** 一份文件的完整流水线 */
  const runIngest = useCallback(async (key: number, file: File, hint: string) => {
    const setPhase = (phase: IngestTask['phase']) =>
      setTasks(list => list.map(t => (t.key === key ? { ...t, phase } : t)))
    const finish = () => setTasks(list => list.filter(t => t.key !== key))

    try {
      const up = await http.upload(file)
      const att = up.attachment
      if (!att || !att.id) throw new Error('上传没有返回附件')

      // 图片 / PDF 上传后服务端自动进识别队列，这里等它跑完（扫描件慢，给 3 分钟）
      setPhase('ocr')
      let status = att.ocr_status
      const t0 = Date.now()
      while ((status === 'pending' || status === 'running') && Date.now() - t0 < OCR_WAIT_MS) {
        await sleep(OCR_POLL_MS)
        try {
          const one = await http.attachment(att.id)
          status = one?.ocr_status || status
        } catch { /* 单次查询失败就再等一轮，不要因此判失败 */ }
      }

      setPhase('think')
      const r = await http.ai.ingest({ attachmentId: att.id, hint })

      if (r.status === 'pending' || r.status === 'running') {
        // 超过等待上限还没识别完：如实说，不能假装失败也不能假装成功
        throw new Error('识别还在进行中（扫描件较慢）。稍后到「附件中心」能看到结果。')
      }

      finish()

      if (r.action === 'propose' && r.proposal) {
        setProposals(list => [...list, { ...r.proposal!, state: 'pending' }])
        return
      }
      if (r.action === 'import') {
        const label = r.tableLabel || (r.table ? (meta?.tables?.[r.table]?.label || r.table) : '')
        setNotes(list => [...list, {
          key, kind: 'import',
          title: `「${file.name}」是表格文件`,
          body: (r.message || '') + (label ? ` 看表头像是「${label}」的数据。` : ''),
          actionLabel: '去批量导入',
          actionTo: r.table ? `/import?table=${r.table}` : '/import',
        }])
        return
      }

      const fields = Object.entries(r.fields || {})
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .slice(0, 6)
        .map(([k, v]) => [FIELD_CN[k] || k, String(v)] as [string, string])
      setNotes(list => [...list, {
        key, kind: 'none',
        title: `「${file.name}」我没法直接录入`,
        body: r.message || '这份文件里没有能录入系统的信息。',
        actionLabel: '去附件中心处理',
        actionTo: '/attachments',
        fields,
      }])
    } catch (e) {
      finish()
      const msg = e instanceof ApiError ? e.message : ((e as Error)?.message || '处理失败')
      setNotes(list => [...list, {
        key, kind: 'none',
        title: `「${file.name}」没处理成功`,
        body: msg,
      }])
    }
  }, [meta])

  /**
   * 收文件入口：选文件 / 拖进来 / 粘贴图片都走这里。
   *
   * 输入框里先打的字会被当成**附言**用（"这是万祥项目的发票"），
   * 比让模型自己猜项目准得多 —— 所以打完字再拖文件，别反过来。
   */
  const takeFiles = useCallback((files: FileList | File[] | null) => {
    const arr = files ? Array.from(files as File[]) : []
    if (!arr.length) return
    const hint = input.trim()
    if (hint) setInput('')
    for (const f of arr) {
      const key = ++taskSeq.current
      setTasks(list => [...list, { key, name: f.name, phase: 'upload' }])
      setMessages(m => [...m, { role: 'user', content: hint ? `📎 ${f.name}（附言：${hint}）` : `📎 ${f.name}` }])
      // 串行：服务端识别队列本来就是串行的，一次甩 5 个文件只会刷屏
      queueRef.current = queueRef.current.then(() => runIngest(key, f, hint)).catch(() => { /* runIngest 内部已兜底 */ })
    }
  }, [input, runIngest])

  return (
    <div className="pointer-events-none fixed inset-0 z-[500]">
      {open && (
        <div
          className="pointer-events-auto absolute bottom-6 right-6 flex flex-col overflow-hidden rounded-card bg-surface shadow-pop"
          style={{ width: size.w, height: size.h }}
          onDragOver={e => { e.preventDefault(); if (!drag) setDrag(true) }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDrag(false) }}
          onDrop={e => {
            e.preventDefault()
            setDrag(false)
            takeFiles(e.dataTransfer?.files || null)
          }}
          onPaste={e => {
            // 截图直接粘贴进来（Ctrl+V）
            const items = Array.from(e.clipboardData?.items || [])
            const files = items.filter(i => i.kind === 'file').map(i => i.getAsFile()).filter(Boolean) as File[]
            const list = files.length ? files : Array.from(e.clipboardData?.files || [])
            if (list.length) { e.preventDefault(); takeFiles(list) }
          }}
        >
          {/* 拖拽悬停：整块面板变投放区 */}
          {drag && (
            <div className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-1.5 text-white"
              style={{ background: 'rgba(59,130,246,.95)' }}>
              <Paperclip size={24} />
              <span className="text-body font-semibold">松开就上传</span>
              <span className="px-8 text-center text-tiny leading-relaxed text-white/85">
                发票、合同、收据的图片和 PDF 会自动识别；表格会引导你去批量导入
              </span>
            </div>
          )}
          {/* 缩放手柄：面板钉在右下角，所以手柄放左上角，
              往左上拖变大、往右下拖变小 */}
          <div
            onMouseDown={startResize}
            title="拖动调整大小"
            className="absolute left-0 top-0 z-20 h-5 w-5 cursor-nwse-resize"
            style={{
              background: 'linear-gradient(135deg, rgba(255,255,255,.55) 50%, transparent 50%)',
              borderTopLeftRadius: 20,
            }}
          />
          {/* 头部（双击恢复默认大小） */}
          <div
            onDoubleClick={resetSize}
            title="双击恢复默认大小"
            className="grad-ai relative flex-none select-none px-5 pb-4 pt-5 text-white"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-11 w-11 items-center justify-center rounded-tile bg-white/20">
                <Bot size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[15px] font-bold">智能项目分析助手</div>
                <div className="truncate text-[11px] text-white/75">
                  {ready ? `${cfg?.providerLabel} · ${cfg?.model}` : '尚未配置大模型'}
                </div>
              </div>
              <div className="flex items-center gap-1">
                {messages.length > 0 && (
                  <button onClick={clearChat}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 transition-colors duration-200 hover:bg-white/30"
                    title="清空对话">
                    <Trash2 size={13} />
                  </button>
                )}
                {canEdit && (
                  <button onClick={() => { nav('/settings'); setOpen(false) }}
                    className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 transition-colors duration-200 hover:bg-white/30"
                    title="AI 设置">
                    <Settings2 size={13} />
                  </button>
                )}
                <button onClick={() => { stop(); setOpen(false) }}
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 transition-colors duration-200 hover:bg-white/30"
                  title="收起">
                  <X size={14} />
                </button>
              </div>
            </div>
          </div>

          {/* 消息区 */}
          <div ref={bodyRef} className="flex-1 space-y-3 overflow-y-auto bg-canvas/60 p-4">
            {messages.length === 0 && (
              <Welcome ready={ready} canEdit={canEdit} quick={cfg?.quick || []} tips={localTips}
                onAsk={ask} onGo={to => { nav(to); setOpen(false) }} onConfig={() => { nav('/settings'); setOpen(false) }} />
            )}

            {messages.map((m, i) => (
              <Bubble key={i} role={m.role} content={m.content}
                question={m.role === 'assistant' ? prevQuestion(messages, i) : ''}
                streaming={streaming && i === messages.length - 1 && m.role === 'assistant'} />
            ))}

            {/* 正在处理的文件：上传 → 识别 → 判断，三个阶段都让用户看见 */}
            {tasks.map(t => (
              <div key={t.key} className="flex items-center gap-2.5 rounded-card bg-surface px-3.5 py-3 shadow-soft">
                <span className="flex h-7 w-7 flex-none items-center justify-center rounded-tile bg-slate-100 text-ink-500">
                  <Loader2 size={14} className="animate-spin" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-tiny font-medium text-ink-900">{t.name}</div>
                  <div className="text-[11px] text-ink-400">
                    {t.phase === 'upload' ? '正在上传…'
                      : t.phase === 'ocr' ? '正在识别文字…（扫描件慢一些）'
                        : '正在判断该录到哪张表…'}
                  </div>
                </div>
              </div>
            ))}

            {/* 表格引导 / 认不出：这两种给不了"待确认方案"，但要说清下一步去哪 */}
            {notes.map(n => (
              <div key={n.key} className="rounded-card border border-slate-200 bg-surface px-4 py-3.5 shadow-soft">
                <div className="flex items-center gap-2">
                  <span className={cn('flex h-6 w-6 flex-none items-center justify-center rounded-full text-white',
                    n.kind === 'import' ? 'bg-brand' : 'bg-slate-400')}>
                    {n.kind === 'import' ? <FileSpreadsheet size={13} /> : <CircleAlert size={13} />}
                  </span>
                  <span className="min-w-0 flex-1 text-body font-semibold text-ink-900">{n.title}</span>
                  <button onClick={() => setNotes(list => list.filter(x => x.key !== n.key))}
                    className="text-ink-300 transition-colors duration-200 hover:text-ink-500" title="知道了">
                    <X size={13} />
                  </button>
                </div>
                <div className="mt-1.5 whitespace-pre-wrap text-tiny leading-relaxed text-ink-600">{n.body}</div>
                {n.fields && n.fields.length > 0 && (
                  <div className="mt-2 space-y-1 rounded-tile bg-slate-50 px-3 py-2">
                    {n.fields.map(([k, v], i) => (
                      <div key={i} className="flex gap-2 text-tiny">
                        <span className="w-[86px] flex-none text-ink-400">{k}</span>
                        <span className="min-w-0 font-medium text-ink-800">{v}</span>
                      </div>
                    ))}
                  </div>
                )}
                {n.actionLabel && n.actionTo && (
                  <button onClick={() => { nav(n.actionTo as string); setOpen(false) }}
                    className="mt-2.5 flex items-center gap-1 text-tiny font-medium text-brand hover:underline">
                    {n.actionLabel} <ArrowRight size={12} />
                  </button>
                )}
              </div>
            ))}

            {/* token 用量：让用户对花销有数 */}
            {usage && !streaming && (
              <div className="px-1 text-[11px] text-ink-300">
                本次消耗 {usage.total_tokens ?? ((usage.prompt_tokens || 0) + (usage.completion_tokens || 0))} tokens
                {usage.prompt_tokens ? `（输入 ${usage.prompt_tokens} / 输出 ${usage.completion_tokens || 0}）` : ''}
              </div>
            )}

            {/* AI 生成的录入方案：确认后才写库 */}
            {proposals.map((p, i) => (
              <ProposalCard key={i} prop={p} onDecide={async (ok, patch) => {
                if (!ok) {
                  setProposals(list => list.map((x, k) => k === i ? { ...x, state: 'cancelled' } : x))
                  return
                }
                try {
                  const r = await http.ai.applyProposal(p.token, patch)
                  setProposals(list => list.map((x, k) => k === i
                    ? { ...x, state: 'applied', appliedId: r.id, linkedAttachments: r.linkedAttachments } : x))
                } catch (e) {
                  // 后端可能回了"还差哪些字段"，补进卡片让用户接着补，而不是只报个错
                  const data = e instanceof ApiError ? e.data : null
                  setProposals(list => list.map((x, k) => k === i
                    ? {
                      ...x, state: 'error', error: (e as Error).message,
                      missing: (data && data.missing) || x.missing,
                    } : x))
                }
              }} />
            ))}

            {status && (
              <div className="flex items-center gap-2 px-1 text-tiny text-ink-400">
                <Loader2 size={13} className="animate-spin" />
                {status}
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-tile bg-red-50 px-3.5 py-3">
                <CircleAlert size={15} className="mt-0.5 flex-none text-down" />
                <div className="min-w-0 flex-1">
                  <div className="text-tiny leading-relaxed text-down">{error}</div>
                  {canEdit && (
                    <button onClick={() => { nav('/settings'); setOpen(false) }}
                      className="mt-1.5 text-tiny font-medium text-brand hover:underline">
                      去检查 AI 配置 →
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 输入区 */}
          <div className="flex-none border-t border-slate-100 bg-surface p-3">
            {!ready && cfg && (
              <div className="mb-2 flex items-center gap-2 rounded-tile bg-amber-50 px-3 py-2">
                <CircleAlert size={13} className="flex-none text-orange-500" />
                <span className="text-tiny text-ink-600">
                  {canEdit ? '还没配置大模型，当前只能用下面的本地分析' : '管理员还没配置大模型，当前只能用本地分析'}
                </span>
              </div>
            )}
            <div className="flex items-end gap-2">
              {/* 传文件：不需要配大模型也能用（识别 + 按字段填表这条路不花 token） */}
              <button onClick={() => fileRef.current?.click()} title="上传发票 / 合同 / 表格"
                className="flex h-10 w-10 flex-none items-center justify-center rounded-tile bg-slate-50 text-ink-500 transition-colors duration-200 hover:bg-slate-100 hover:text-brand">
                <Paperclip size={16} />
              </button>
              <input ref={fileRef} type="file" multiple hidden
                accept={meta?.upload?.accept}
                onChange={e => { takeFiles(e.target.files); e.target.value = '' }} />
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => {
                  setInput(e.target.value)
                  const el = e.target
                  el.style.height = 'auto'
                  el.style.height = Math.min(el.scrollHeight, 120) + 'px'
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input) }
                }}
                rows={1}
                disabled={!ready}
                placeholder={ready ? '问点什么…（发票图片可直接拖进来）' : '配置大模型后即可提问，文件现在也能传'}
                className="max-h-[120px] min-h-[40px] flex-1 resize-none rounded-tile bg-slate-50 px-3.5 py-2.5 text-body text-ink-900 outline-none transition-colors duration-200 placeholder:text-ink-300 focus:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
              />
              {streaming ? (
                <button onClick={stop} title="停止生成"
                  className="flex h-10 w-10 flex-none items-center justify-center rounded-tile bg-slate-100 text-ink-600 transition-colors duration-200 hover:bg-slate-200">
                  <Square size={15} />
                </button>
              ) : (
                <button onClick={() => ask(input)} disabled={!ready || !input.trim()} title="发送"
                  className="grad-ai flex h-10 w-10 flex-none items-center justify-center rounded-tile text-white transition-all duration-200 hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:translate-y-0">
                  <Send size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 收起态：小圆球悬浮按钮（点一下展开面板） */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          title="智能项目分析助手"
          className={cn(
            'pointer-events-auto absolute bottom-6 right-6 flex h-14 w-14 items-center justify-center rounded-full text-white transition-all duration-200',
            hover ? '-translate-y-1' : '',
          )}
          style={{
            backgroundImage: 'linear-gradient(135deg, #3B82F6 0%, #8B5CF6 100%)',
            boxShadow: hover
              ? '0 14px 32px rgba(99,102,241,.45), 0 0 0 6px rgba(99,102,241,.12)'
              : '0 10px 26px rgba(99,102,241,.38)',
          }}
        >
          <Bot size={26} />
          {/* 有待办时挂一个小红点（不加数字，保持圆球干净） */}
          {reminders.length > 0 && (
            <span className="absolute right-1 top-1 h-2.5 w-2.5 rounded-full bg-down ring-2 ring-surface" />
          )}
        </button>
      )}
    </div>
  )
}

/* ==================== AI 录入方案确认卡片 ==================== */
/**
 * AI 说要录入一条数据时，不直接写库，而是弹这张卡片让用户过目。
 * 只有点了「确认录入」才会真正保存 —— 业务系统里「改对了」比「改得快」重要。
 *
 * 单据进件这条路上，识别经常缺一两项（最常见是"所属项目"匹配不上），
 * 所以卡片支持就地补：补齐了才让点确认，不用退出去重传一遍。
 */
function ProposalCard ({ prop, onDecide }: { prop: AiProposal; onDecide: (ok: boolean, patch?: Record<string, any>) => void }) {
  const st = prop.state || 'pending'
  const missing = prop.missing || []
  const editable = prop.editable || {}
  /** 用户在卡片上补/改的字段 */
  const [patch, setPatch] = useState<Record<string, any>>({})
  const ready2save = missing.every(m => patch[m.name] !== undefined && String(patch[m.name]).trim() !== '')

  return (
    <div className={cn('rounded-card border-2 px-4 py-3.5',
      st === 'applied' ? 'border-green-200 bg-green-50'
        : st === 'cancelled' ? 'border-slate-200 bg-slate-50'
          : st === 'error' ? 'border-red-200 bg-red-50'
            : 'border-brand/30 bg-surface shadow-soft')}>
      <div className="flex items-center gap-2">
        <span className={cn('flex h-6 w-6 flex-none items-center justify-center rounded-full text-white',
          st === 'applied' ? 'bg-up' : st === 'cancelled' ? 'bg-slate-400' : st === 'error' ? 'bg-down' : 'grad-ai')}>
          {st === 'applied' ? <Check size={13} /> : st === 'error' ? <CircleAlert size={13} /> : <Sparkles size={13} />}
        </span>
        <span className="text-body font-semibold text-ink-900">
          {st === 'applied' ? '已录入' : st === 'cancelled' ? '已取消' : st === 'error' ? '录入失败' : 'AI 想录入这条数据'}
        </span>
        {st === 'pending' && <Pill tone="blue">待你确认</Pill>}
      </div>

      <div className="mt-2.5 space-y-1">
        {prop.detail.map(([k, v], i) => (
          <div key={i} className="flex gap-2 text-tiny">
            <span className="w-[92px] flex-none text-ink-400">{k}</span>
            <span className="min-w-0 font-medium text-ink-800">{String(v)}</span>
          </div>
        ))}
      </div>

      {prop.warnings && prop.warnings.length > 0 && (
        <div className="mt-2.5 space-y-1 rounded-tile bg-amber-50 px-3 py-2">
          {prop.warnings.map((w, i) => (
            <div key={i} className="flex gap-1.5 text-tiny text-ink-600">
              <CircleAlert size={12} className="mt-0.5 flex-none text-orange-500" />{w}
            </div>
          ))}
        </div>
      )}

      {/* 缺的必填项：直接在卡片上补（下拉/输入框），不用跳去表单再重来一遍 */}
      {st !== 'applied' && missing.length > 0 && (
        <div className="mt-2.5 space-y-2 rounded-tile bg-amber-50 px-3 py-2.5">
          <div className="flex items-center gap-1.5 text-tiny font-medium text-ink-700">
            <CircleAlert size={12} className="flex-none text-orange-500" />
            还差这几项，补完才能保存
          </div>
          {missing.map(m => {
            const ed = (editable[m.name] || {}) as { label?: string; kind?: string; options?: { value: any; label: string }[] }
            const kind = ed.kind || 'text'
            const val = patch[m.name] === undefined ? '' : String(patch[m.name])
            const set = (v: string) => setPatch(p => ({ ...p, [m.name]: v }))
            return (
              <div key={m.name} className="flex items-center gap-2">
                <span className="w-[84px] flex-none text-tiny text-ink-500">{ed.label || m.label}</span>
                {kind === 'select' ? (
                  <select value={val} onChange={e => set(e.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-tile border border-slate-200 bg-surface px-2 text-tiny text-ink-900 outline-none focus:border-brand">
                    <option value="">请选择…</option>
                    {(ed.options || []).map(o => (
                      <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input type={kind === 'number' ? 'number' : 'text'} value={val}
                    onChange={e => set(e.target.value)}
                    className="h-8 min-w-0 flex-1 rounded-tile border border-slate-200 bg-surface px-2 text-tiny text-ink-900 outline-none focus:border-brand" />
                )}
              </div>
            )
          })}
        </div>
      )}

      {st === 'error' && prop.error && <div className="mt-2 text-tiny text-down">{prop.error}</div>}
      {st === 'applied' && (
        <div className="mt-2 text-tiny text-up">
          已保存，可以到对应列表里查看或修改。
          {prop.linkedAttachments ? ` 原件也挂到这条记录上了（${prop.linkedAttachments} 份）。` : ''}
        </div>
      )}

      {/* 出错也留着按钮：缺字段被拦下来时，用户补完要能再点一次 */}
      {(st === 'pending' || st === 'error') && (
        <div className="mt-3 flex gap-2">
          <Button size="sm" variant="primary" disabled={!ready2save} onClick={() => onDecide(true, patch)}>
            <Check size={14} /> {st === 'error' ? '再试一次' : '确认录入'}
          </Button>
          <Button size="sm" variant="soft" onClick={() => onDecide(false)}>取消</Button>
        </div>
      )}
    </div>
  )
}

/* ==================== 欢迎页 ==================== */

function Welcome ({ ready, canEdit, quick, tips, onAsk, onGo, onConfig }: {
  ready: boolean
  canEdit: boolean
  quick: { icon: string; text: string }[]
  tips: Tip[]
  onAsk: (q: string) => void
  onGo: (to: string) => void
  onConfig: () => void
}) {
  // 已配置：给快捷提问
  if (ready) {
    return (
      <div className="space-y-2.5">
        <div className="flex items-center gap-2 px-1 pb-1">
          <Database size={13} className="text-brand" />
          <span className="text-tiny text-ink-400">
            提问时会自动带上当前的项目、合同、收付款和发票数据
          </span>
        </div>
        {quick.map((q, i) => (
          <button key={i} onClick={() => onAsk(q.text)}
            className="block w-full rounded-tile bg-surface px-3.5 py-3 text-left shadow-soft transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card-hover">
            <div className="flex items-start gap-2.5">
              <Sparkles size={15} className="mt-0.5 flex-none text-brand" />
              <span className="text-body leading-relaxed text-ink-700">{q.text}</span>
            </div>
          </button>
        ))}
      </div>
    )
  }

  // 未配置：退回本地分析，并提示去配置
  return (
    <div className="space-y-2.5">
      <div className="rounded-tile bg-surface px-3.5 py-3 shadow-soft">
        <div className="flex items-start gap-2.5">
          <Sparkles size={15} className="mt-0.5 flex-none text-brand" />
          <div>
            <div className="text-body font-medium text-ink-900">还没接入大模型</div>
            <div className="mt-1 text-tiny leading-relaxed text-ink-500">
              下面是根据当前数据算出的本地分析。接上 DeepSeek 等大模型后，
              就能直接问「哪些项目回款有问题」「哪个项目要超支」这类问题了。
            </div>
            {canEdit && (
              <button onClick={onConfig}
                className="mt-2 flex items-center gap-1 text-tiny font-medium text-brand hover:underline">
                去配置大模型 <ArrowRight size={12} />
              </button>
            )}
          </div>
        </div>
      </div>
      {tips.map((tip, i) => (
        <button key={i} onClick={() => tip.to && onGo(tip.to)}
          className={cn(
            'block w-full rounded-tile px-3.5 py-3 text-left transition-all duration-200',
            tip.to ? 'hover:-translate-y-0.5 hover:shadow-soft' : 'cursor-default',
            tip.tone === 'danger' ? 'bg-red-50' : tip.tone === 'warn' ? 'bg-amber-50' : 'bg-surface shadow-soft',
          )}>
          <div className="flex items-start gap-2.5">
            <Sparkles size={15}
              className={cn('mt-0.5 flex-none',
                tip.tone === 'danger' ? 'text-down' : tip.tone === 'warn' ? 'text-orange-500' : 'text-brand')} />
            <div className="min-w-0">
              <div className="text-body font-medium text-ink-900">{tip.title}</div>
              <div className="mt-0.5 text-tiny leading-relaxed text-ink-500">{tip.body}</div>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

/* ==================== 消息气泡 ==================== */

function Bubble ({ role, content, streaming, question }: {
  role: 'user' | 'assistant'
  content: string
  streaming?: boolean
  question?: string
}) {
  const [copied, setCopied] = useState(false)
  const [exporting, setExporting] = useState(false)
  const toast = useToast()
  const isUser = role === 'user'

  const copy = () => {
    navigator.clipboard?.writeText(content).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* 剪贴板不可用就算了 */ })
  }

  const exportWord = async () => {
    setExporting(true)
    try {
      await http.ai.exportReport({ question: question || '经营分析', answer: content, includeData: true })
      toast('Word 报告已导出', 'ok')
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally { setExporting(false) }
  }

  if (isUser) {
    return (
      <div className="flex items-start justify-end gap-2">
        <div className="max-w-[85%] rounded-card rounded-tr-tile bg-brand px-4 py-2.5 text-body leading-relaxed text-white">
          {content}
        </div>
        <span className="mt-1 flex h-6 w-6 flex-none items-center justify-center rounded-full bg-slate-200 text-ink-500">
          <User size={13} />
        </span>
      </div>
    )
  }

  return (
    <div className="group flex items-start gap-2">
      <span className="grad-ai mt-1 flex h-6 w-6 flex-none items-center justify-center rounded-full text-white">
        <Bot size={13} />
      </span>
      <div className="min-w-0 max-w-[88%] rounded-card rounded-tl-tile bg-surface px-4 py-3 shadow-soft">
        {content
          ? <Markdown text={content} />
          : <span className="flex items-center gap-1.5 text-tiny text-ink-300"><Loader2 size={12} className="animate-spin" />正在生成…</span>}
        {streaming && content && <span className="ml-0.5 inline-block h-3.5 w-[2px] animate-pulse bg-brand align-middle" />}
        {!streaming && content && (
          <div className="mt-2 flex items-center gap-3 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
            <button onClick={copy}
              className="flex items-center gap-1 text-[11px] text-ink-300 hover:text-brand">
              {copied ? <><Check size={11} />已复制</> : <><Copy size={11} />复制</>}
            </button>
            <button onClick={exportWord} disabled={exporting}
              className="flex items-center gap-1 text-[11px] text-ink-300 transition-colors duration-200 hover:text-brand disabled:opacity-50">
              {exporting ? <Loader2 size={11} className="animate-spin" /> : <FileDown size={11} />}
              {exporting ? '正在生成…' : '导出 Word'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ==================== 轻量 Markdown 渲染 ==================== */
/**
 * 只支持模型实际会用的几种语法：标题、有序/无序列表、粗体、行内代码、代码块、表格、分隔线。
 * 全程用 React 元素拼装（不用 dangerouslySetInnerHTML），所以没有 XSS 风险。
 */
function Markdown ({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  return (
    <div className="space-y-2 text-body leading-relaxed text-ink-700">
      {blocks.map(renderBlock)}
    </div>
  )
}

type Block =
  | { t: 'p'; text: string }
  | { t: 'h'; level: number; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] }
  | { t: 'code'; text: string }
  | { t: 'table'; head: string[]; rows: string[][] }
  | { t: 'hr' }

function parseBlocks (src: string): Block[] {
  const lines = String(src).split('\n')
  const out: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 代码块
    if (/^\s*```/.test(line)) {
      const buf: string[] = []
      i++
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++ }
      i++
      out.push({ t: 'code', text: buf.join('\n') })
      continue
    }

    // 表格：当前行和下一行都是 | 开头的行，且第二行是分隔行
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i++ }
      out.push({ t: 'table', head, rows })
      continue
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) { out.push({ t: 'h', level: h[1].length, text: h[2] }); i++; continue }

    // 分隔线
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { out.push({ t: 'hr' }); i++; continue }

    // 有序列表
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''))
        i++
      }
      out.push({ t: 'ol', items })
      continue
    }

    // 无序列表
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''))
        i++
      }
      out.push({ t: 'ul', items })
      continue
    }

    // 空行
    if (!line.trim()) { i++; continue }

    // 普通段落：连续的普通行合并
    const buf: string[] = []
    while (i < lines.length && lines[i].trim()
      && !/^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|```|\|)/.test(lines[i])) {
      buf.push(lines[i]); i++
    }
    if (buf.length) out.push({ t: 'p', text: buf.join('\n') })
    else i++
  }
  return out
}

function splitRow (line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(s => s.trim())
}

/** 行内：粗体、行内代码、斜体 */
function inline (text: string, keyPrefix = 'i'): ReactNode[] {
  const parts: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g
  let last = 0
  let m: RegExpExecArray | null
  let n = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index))
    const tok = m[0]
    const key = `${keyPrefix}-${n++}`
    if (tok.startsWith('**')) parts.push(<strong key={key} className="font-semibold text-ink-900">{tok.slice(2, -2)}</strong>)
    else if (tok.startsWith('`')) parts.push(<code key={key} className="rounded-[4px] bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-brand">{tok.slice(1, -1)}</code>)
    else parts.push(<em key={key} className="text-ink-600">{tok.slice(1, -1)}</em>)
    last = m.index + tok.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

function renderBlock (b: Block, i: number) {
  switch (b.t) {
    case 'h':
      return <div key={i} className={cn('font-semibold text-ink-900',
        b.level <= 2 ? 'text-[14.5px]' : 'text-body')}>{inline(b.text)}</div>
    case 'ul':
      return (
        <ul key={i} className="space-y-1 pl-1">
          {b.items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 flex-none rounded-full bg-brand/60" />
              <span className="min-w-0">{inline(it, `u${i}-${j}`)}</span>
            </li>
          ))}
        </ul>
      )
    case 'ol':
      return (
        <ol key={i} className="space-y-1">
          {b.items.map((it, j) => (
            <li key={j} className="flex gap-2">
              <span className="flex h-[18px] w-[18px] flex-none items-center justify-center rounded-full bg-brand/10 text-[11px] font-semibold text-brand">
                {j + 1}
              </span>
              <span className="min-w-0">{inline(it, `o${i}-${j}`)}</span>
            </li>
          ))}
        </ol>
      )
    case 'code':
      return <pre key={i} className="overflow-x-auto rounded-tile bg-slate-50 p-3 font-mono text-[12px] leading-relaxed text-ink-700">{b.text}</pre>
    case 'table':
      return (
        <div key={i} className="overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>{b.head.map((h, j) => (
                <th key={j} className="border-b border-slate-200 px-2 py-1.5 text-left font-semibold text-ink-900">{inline(h, `th${i}-${j}`)}</th>
              ))}</tr>
            </thead>
            <tbody>
              {b.rows.map((r, ri) => (
                <tr key={ri}>{r.map((c, ci) => (
                  <td key={ci} className="border-b border-slate-100 px-2 py-1.5 align-top">{inline(c, `td${i}-${ri}-${ci}`)}</td>
                ))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'hr':
      return <div key={i} className="h-px bg-slate-100" />
    default:
      return <p key={i} className="whitespace-pre-wrap">{inline(b.text, `p${i}`)}</p>
  }
}

/* ==================== 本地规则分析（未配置大模型时的兜底） ==================== */

interface Tip { title: string; body: string; tone?: 'danger' | 'warn' | 'info'; to?: string }

function buildTips (t: Record<string, number>, reminders: Dashboard['reminders'], dash?: Dashboard | null): Tip[] {
  const out: Tip[] = []
  const receivable = n0(t.receivable)
  const paidIn = n0(t.paid_in)
  const cost = n0(t.cost)
  const contractIn = n0(t.contract_in)
  const actualProfit = n0(t.actual_profit)

  if (receivable > 0) {
    const rate = contractIn > 0 ? (paidIn / contractIn) * 100 : 0
    out.push({
      tone: rate < 60 ? 'danger' : 'info',
      title: `应收未收 ${fmtWan(receivable)} 万元`,
      body: `收入合同额 ${fmtWan(contractIn)} 万，目前已回款 ${fmtWan(paidIn)} 万，回款率 ${rate.toFixed(1)}%。`
        + (rate < 60 ? '回款偏慢，建议排查逾期节点。' : '回款节奏正常。'),
      to: '/t/schedules',
    })
  }

  const overdue = reminders.filter(r => r.kind === 'overdue_in' || r.kind === 'overdue_out')
  if (overdue.length) {
    out.push({
      tone: 'danger',
      title: overdue[0].title,
      body: `${overdue[0].detail || ''}。逾期越久越难收，建议本周内跟进。`,
      to: overdue[0].href,
    })
  }

  const budget = n0(t.contract_out)
  if (budget > 0) {
    const used = n0(t.cost_used_rate)
    out.push({
      tone: used > 100 ? 'danger' : used > 85 ? 'warn' : 'info',
      title: `成本执行率 ${used.toFixed(1)}%`,
      body: `实际成本 ${fmtWan(cost)} 万 / 支出合同 ${fmtWan(budget)} 万。`
        + (used > 100 ? `已超支 ${fmtWan(n0(t.cost_over))} 万。` : `还剩 ${fmtWan(budget - cost)} 万预算空间。`),
      to: '/t/expenses',
    })
  }

  if (contractIn > 0) {
    const rate = n0(t.actual_rate)
    out.push({
      tone: rate < 10 ? 'warn' : 'info',
      title: `动态毛利率 ${rate.toFixed(1)}%`,
      body: `按真账口径（含税收入 − 实际成本）动态毛利 ${fmtWan(actualProfit)} 万。`
        + (rate < 10 ? '利润偏薄，注意控制材料与人工。' : '盈利状况健康。'),
      to: '/reports',
    })
  }

  if (n0(t.paid_in_no_inv) > 0) {
    out.push({
      tone: 'warn',
      title: `已收款未开票 ${fmtWan(t.paid_in_no_inv)} 万`,
      body: '钱已到账但发票还没开出去，注意税务申报口径。',
      to: '/t/invoices',
    })
  }

  const maintenance = reminders.find(r => r.kind === 'maint')
  if (maintenance) {
    out.push({ tone: 'warn', title: maintenance.title, body: `${maintenance.detail || ''}。`, to: maintenance.href })
  }

  if (!out.length) {
    out.push({
      tone: 'info',
      title: '经营数据一切正常',
      body: '当前没有逾期款项、没有超预算成本，也没有待处理的售后单。',
    })
  }
  return out.slice(0, 5)
}
