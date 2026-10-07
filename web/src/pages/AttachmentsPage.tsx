import { useEffect, useRef, useState } from 'react'
import {
  Paperclip, Upload, Trash2, ScanLine, Link2, FileText, Download, RefreshCw,
  Sparkles, Wand2, CircleAlert, CircleCheck, Plus, X, ChevronDown,
} from 'lucide-react'
import { Button, Card, Pill, Empty, Skeleton, IconTile, Input } from '@/components/ui/primitives'
import { Modal, useConfirm, useToast } from '@/components/ui/overlay'
import { RecordForm } from '@/components/form/RecordForm'
import { useApp } from '@/app-context'
import { http } from '@/lib/api'
import { cn, fmtMoney, fmtSize, timeAgo } from '@/lib/utils'

const STATUS_TONE: Record<string, 'green' | 'orange' | 'red' | 'gray' | 'blue'> = {
  done: 'green', pending: 'orange', running: 'blue', failed: 'red',
}
const STATUS_LABEL: Record<string, string> = {
  done: '已识别', pending: '排队中', running: '识别中', failed: '识别失败',
}
/** OCR 识别出的字段名 → 中文标签（与 schema 的字段名一致） */
const FIELD_LABEL: Record<string, string> = {
  code: '编号', name: '名称', amount: '金额(含税)', tax_rate: '税率(%)',
  tax_amount: '税额', total_amount: '价税合计', amount_ex_tax: '不含税金额',
  invoice_no: '发票号码', invoice_type: '发票种类', issue_date: '开票日期',
  sign_date: '签订日期', start_date: '开始日期', end_date: '结束日期',
  payment_terms: '付款条款', location: '地点', category: '合同类别',
}
const MONEY_FIELDS = new Set(['amount', 'tax_amount', 'total_amount', 'amount_ex_tax'])

export default function AttachmentsPage() {
  const { meta, refreshDash } = useApp()
  const [rows, setRows] = useState<any[] | null>(null)
  const [q, setQ] = useState('')
  const [busy, setBusy] = useState(false)
  /** 正在查看识别结果的那张扫描件 */
  const [ocrView, setOcrView] = useState<any | null>(null)
  /** 识别结果要填进哪张表（点了「新建合同并填入」之后） */
  const [fill, setFill] = useState<{ table: string; preset: any; attachId: number } | null>(null)
  const toast = useToast()
  const { confirm, confirmNode } = useConfirm()
  const fileRef = useRef<HTMLInputElement>(null)
  const [drag, setDrag] = useState(false)

  const load = async () => {
    try { const r = await http.attachments({ q }); setRows(r.rows) }
    catch (e) { toast((e as Error).message, 'err'); setRows([]) }
  }
  useEffect(() => { const t = setTimeout(load, 240); return () => clearTimeout(t) }, [q])

  /* 有附件正在识别时自动轮询，识别完自动停（不然用户得手动刷新才看到结果） */
  useEffect(() => {
    const pending = (rows || []).some(a => a.ocr_status === 'pending' || a.ocr_status === 'running')
    if (!pending) return
    const t = window.setInterval(load, 2500)
    return () => window.clearInterval(t)
  }, [rows])

  const doUpload = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    let ok = 0
    for (const f of Array.from(files)) {
      try { await http.upload(f); ok++ }
      catch (e) { toast(`${f.name}：${(e as Error).message}`, 'err', 4000) }
    }
    setBusy(false)
    if (ok) { toast(`已上传 ${ok} 个文件，识别中…`, 'ok'); void load() }
  }

  const isImg = (n: string) => /\.(png|jpe?g|bmp|webp|gif|tiff?)$/i.test(n)

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4 px-6 py-5">
        <IconTile icon={Paperclip} tone="cyan" />
        <div>
          <h1 className="text-page text-ink-900">附件中心</h1>
          <p className="mt-1 text-body text-ink-500">
            扫描件、发票、合同原件集中管理；支持 OCR 识别后自动填表
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <Button variant="soft" onClick={load}><RefreshCw size={15} /> 刷新</Button>
          <Button variant="primary" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Upload size={16} /> {busy ? '上传中…' : '上传附件'}
          </Button>
          <input ref={fileRef} type="file" multiple hidden
            accept={meta?.upload?.accept} onChange={e => { void doUpload(e.target.files); e.target.value = '' }} />
        </div>
      </Card>

      {/* 拖拽上传区 */}
      <div
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); void doUpload(e.dataTransfer.files) }}
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-card py-8 transition-all duration-200',
          drag ? 'bg-blue-50 ring-2 ring-blue-300' : 'bg-white/60',
        )}
        style={{ boxShadow: '0 8px 30px rgba(99,102,241,.06)' }}
      >
        <span className="grad-brand flex h-12 w-12 items-center justify-center rounded-tile text-white">
          <Upload size={22} />
        </span>
        <p className="text-body font-medium text-ink-700">把文件拖到这里上传</p>
        <p className="text-tiny text-ink-400">
          支持 {String(meta?.upload?.accept || '').replace(/\./g, '').toUpperCase()}，单个最大 {meta?.upload?.maxMB || 40}MB；
          PDF 与图片会自动识别
        </p>
      </div>

      <Card>
        <div className="px-5 pt-5 pb-3">
          <div className="relative w-[280px]">
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索文件名或识别出的文字…" className="!h-9 text-tiny" />
          </div>
        </div>

        {rows === null ? (
          <div className="grid grid-cols-4 gap-3 p-5">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-40" />)}</div>
        ) : !rows.length ? (
          <Empty icon={Paperclip} title="还没有附件" hint="把合同、发票的扫描件拖上来，系统会自动识别关键信息" />
        ) : (
          <div className="grid grid-cols-2 gap-4 p-5 md:grid-cols-3 xl:grid-cols-4">
            {rows.map(a => {
              const img = isImg(a.original_name)
              return (
                <div key={a.id} className="group overflow-hidden rounded-tile bg-slate-50 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card">
                  <a href={http.fileUrl(a.id, true)} target="_blank" rel="noreferrer"
                    className="flex h-[104px] items-center justify-center overflow-hidden bg-white">
                    {img
                      ? <img src={http.fileUrl(a.id, true)} alt={a.original_name} className="h-full w-full object-cover" loading="lazy" />
                      : <span className="flex flex-col items-center gap-1 text-ink-300">
                        <FileText size={30} />
                        <span className="text-[11px] uppercase">{(a.ext || '').replace('.', '')}</span>
                      </span>}
                  </a>
                  <div className="p-3">
                    <div className="truncate text-tiny font-medium text-ink-900" title={a.original_name}>{a.original_name}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-400">
                      <span>{fmtSize(a.size)}</span>
                      <span>·</span>
                      <span>{timeAgo(a.created_at)}</span>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                      {a.ocr_status && <Pill tone={STATUS_TONE[a.ocr_status] || 'gray'} dot>{STATUS_LABEL[a.ocr_status] || a.ocr_status}</Pill>}
                      {a.record_label && <Pill tone="gray">{a.record_label}</Pill>}
                    </div>
                    <div className="mt-2.5 flex items-center gap-1 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                      {a.ocr_status === 'done' && a.ocr && (
                        <Button size="sm" variant="primary" className="!h-7 !px-2.5 !text-[11px]"
                          onClick={() => setOcrView(a)}>
                          <Wand2 size={12} /> 识别结果
                        </Button>
                      )}
                      <Button size="sm" variant="soft" onClick={() => window.open(http.fileUrl(a.id), '_blank')}>
                        <Download size={13} />
                      </Button>
                      {meta?.upload?.ocrExt?.includes(a.ext) && (
                        <Button size="sm" variant="soft" title="重新识别"
                          onClick={async () => { await http.recognizeAttachment(a.id); toast('已加入识别队列', 'ok'); setTimeout(load, 1500) }}>
                          <ScanLine size={13} />
                        </Button>
                      )}
                      {a.ocr_fields && (
                        <Button size="sm" variant="soft" title="重新匹配单位/项目"
                          onClick={async () => { await http.rematchAttachment(a.id); toast('已重新匹配', 'ok'); void load() }}>
                          <Link2 size={13} />
                        </Button>
                      )}
                      <Button size="sm" variant="danger" className="ml-auto"
                        onClick={async () => {
                          const ok = await confirm('删除附件？', `「${a.original_name}」的文件将被彻底删除。`, '删除', true)
                          if (!ok) return
                          await http.deleteAttachment(a.id); toast('已删除', 'ok'); void load()
                        }}>
                        <Trash2 size={13} />
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </Card>
      {confirmNode}

      {/* 识别结果面板：核对无误后一键新建记录并填入 */}
      {ocrView && (
        <OcrPanel
          att={ocrView}
          meta={meta}
          onClose={() => setOcrView(null)}
          onFill={(table, preset) => {
            setFill({ table, preset, attachId: ocrView.id })
            setOcrView(null)
          }}
        />
      )}

      {/* 由识别结果新建记录：表单已预填，保存时把扫描件挂上去 */}
      {fill && meta && (
        <RecordForm
          open
          table={fill.table}
          record={null}
          meta={meta}
          preset={fill.preset}
          linkAttachIds={[fill.attachId]}
          onClose={() => setFill(null)}
          onSaved={() => { void load(); void refreshDash() }}
        />
      )}
    </div>
  )
}

/* ══════════════════ 识别结果面板 ══════════════════ */
function OcrPanel({
  att, meta, onClose, onFill,
}: {
  att: any
  meta: any
  onClose: () => void
  onFill: (table: string, preset: Record<string, any>) => void
}) {
  const ocr = att.ocr || {}
  const fields: Record<string, any> = ocr.fields || {}
  const suggest: Record<string, any> = ocr.suggest || {}
  const parties: any[] = ocr.parties || []
  const checks: any[] = ocr.checks || []
  const hints: Record<string, any> = ocr.hints || {}

  const kind = ocr.kind === 'invoice' ? 'invoice' : ocr.kind === 'contract' ? 'contract' : null
  const targetTable = kind === 'invoice' ? 'invoices' : kind === 'contract' ? 'contracts' : null
  const targetLabel = kind === 'invoice' ? '发票' : '合同'

  // 把识别结果整理成表单的 preset
  const preset: Record<string, any> = {}
  for (const [k, v] of Object.entries(fields)) {
    if (k.endsWith('_value')) continue          // 大写金额只是校验用
    if (v === undefined || v === null || v === '') continue
    preset[k] = v
  }
  if (suggest.direction) preset.direction = suggest.direction
  if (suggest.partner_id) preset.partner_id = suggest.partner_id
  if (suggest.project_id) preset.project_id = suggest.project_id

  // 没匹配上的单位：提示用户可以用表单里的「＋」就地新建
  const unmatched = parties.filter(p => !p.match)
  const projectHint = !suggest.project_id && hints.project_name

  // 快捷选发票种类时用版本号强制重渲染
  const [presetVer, setPresetVer] = useState(0)

  // 识别原文：列表接口不带原文（太大），展开时单独取这一条
  const [raw, setRaw] = useState<{ text: string; normalized: string } | null>(null)
  const [rawOpen, setRawOpen] = useState(false)
  const [rawLoading, setRawLoading] = useState(false)
  const [rawTab, setRawTab] = useState<'normalized' | 'raw'>('normalized')
  const [rawCopied, setRawCopied] = useState(false)
  const [rawError, setRawError] = useState('')

  // 每个字段是从哪句话抽出来的（ocr.hits 里存的是命中的原文片段）
  const hitList = Object.entries((ocr.hits || {}) as Record<string, any>)
    .filter(([, v]) => typeof v === 'string' && v.trim()) as [string, string][]

  const toggleRaw = async () => {
    const next = !rawOpen
    setRawOpen(next)
    if (!next || raw || rawLoading) return
    setRawLoading(true)
    setRawError('')
    try {
      const full = await http.attachment(att.id)
      setRaw({
        text: String(full.ocr_text || ''),
        normalized: String((full.ocr && full.ocr.normalized) || ''),
      })
    } catch (e) {
      setRawError((e as Error).message)
    } finally { setRawLoading(false) }
  }

  const copyRaw = () => {
    const t = rawTab === 'normalized' ? (raw?.normalized || '') : (raw?.text || '')
    navigator.clipboard?.writeText(t).then(() => {
      setRawCopied(true)
      setTimeout(() => setRawCopied(false), 1500)
    }).catch(() => { /* 剪贴板不可用就算了 */ })
  }

  const shownFields = Object.entries(fields).filter(([k, v]) => !k.endsWith('_value') && v !== undefined && v !== null && v !== '')

  // 发票种类：按税率已能自动反推时这里直接带上；推不出来才显示快捷选择
  const isInvoice = kind === 'invoice'
  const needInvoiceType = isInvoice && !preset.invoice_type
  const INVOICE_TYPE_OPTS = ['增值税专用发票', '工程类增值税专用发票', '增值税普通发票', '劳务发票', '电子专票', '电子普票', '普票', '其他']

  return (
    <Modal
      open
      onClose={onClose}
      title={`识别结果 · ${att.original_name}`}
      width="lg"
      footer={<>
        <Button variant="ghost" onClick={onClose}>关闭</Button>
        {targetTable && (
          <Button variant="primary" onClick={() => onFill(targetTable, preset)}>
            <Wand2 size={16} /> 新建{targetLabel}并填入
          </Button>
        )}
      </>}
    >
      <div className="space-y-4 pb-2">
        {/* 可信度 */}
        <div className="flex flex-wrap items-center gap-2.5">
          <Pill tone={kind ? 'green' : 'gray'} dot>
            {kind === 'invoice' ? '发票' : kind === 'contract' ? '合同' : '未识别类型'}
          </Pill>
          <span className="text-tiny text-ink-400">
            共识别出 {shownFields.length} 个字段
            {/* confidence 本来就是 0-100，别再乘 100（曾显示成 10000%） */}
            {ocr.confidence ? ` · 置信度 ${Math.round(ocr.confidence)}%` : ''}
          </span>
          {/* 用的哪条通路：文字层是原文照搬（精确）；OCR 是看图认字（可能看错） */}
          {att.ocr_engine && (
            <Pill tone={att.ocr_engine === 'pdf-text' ? 'green' : 'gray'}>
              {att.ocr_engine === 'pdf-text' ? '文字层 · 精确' : 'OCR 识别'}
            </Pill>
          )}
          {needInvoiceType && (
            <div className="flex flex-wrap items-center gap-2 rounded-tile bg-amber-50 px-3 py-1.5">
              <span className="text-tiny text-ink-600">发票种类？</span>
              {INVOICE_TYPE_OPTS.map(opt => (
                <button
                  key={opt}
                  onClick={() => { preset.invoice_type = opt; setPresetVer(v => v + 1) }}
                  className="rounded-full bg-white px-2.5 py-0.5 text-tiny font-medium text-brand shadow-soft transition-colors duration-200 hover:bg-brand hover:text-white"
                >
                  {opt}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 字段表 */}
        <div className="overflow-hidden rounded-tile bg-slate-50">
          <table className="w-full text-tiny">
            <thead>
              <tr className="text-ink-400">
                <th className="px-4 py-2 text-left font-medium">字段</th>
                <th className="px-4 py-2 text-left font-medium">识别结果</th>
              </tr>
            </thead>
            <tbody>
              {shownFields.map(([k, v]) => (
                <tr key={k} className="bg-white/70">
                  <td className="px-4 py-2 text-ink-500">{FIELD_LABEL[k] || k}</td>
                  <td className="px-4 py-2 font-medium text-ink-900">
                    {MONEY_FIELDS.has(k) ? `¥${fmtMoney(v)}` : String(v)}
                  </td>
                </tr>
              ))}
              {!shownFields.length && (
                <tr><td colSpan={2} className="px-4 py-3 text-ink-400">没有从文件里抽到结构化字段，原文可在文件里查看</td></tr>
              )}
            </tbody>
          </table>
        </div>

        {/* 甲乙方 / 购销方 */}
        {!!parties.length && (
          <div>
            <div className="mb-1.5 text-tiny font-medium text-ink-700">关联线索</div>
            <div className="space-y-1.5">
              {parties.map((p, i) => (
                <div key={i} className="flex items-center gap-2 rounded-tile bg-slate-50 px-3 py-2 text-tiny">
                  <span className="w-12 flex-none text-ink-400">{p.label}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-900">{p.name}</span>
                  {p.match
                    ? <Pill tone="green" dot>已匹配到已有单位</Pill>
                    : <Pill tone="orange" dot>单位库里还没有</Pill>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 提示与校验 */}
        {(!!checks.length || unmatched.length || projectHint) && (
          <div className="space-y-1.5">
            {checks.map((c, i) => (
              <div key={i} className={cn('flex items-start gap-2 rounded-tile px-3 py-2 text-tiny',
                c.level === 'danger' ? 'bg-red-50 text-red-600' : c.level === 'warn' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700')}>
                {c.level === 'danger' ? <CircleAlert size={14} className="mt-0.5 flex-none" /> : <CircleCheck size={14} className="mt-0.5 flex-none" />}
                <span>{c.text}</span>
              </div>
            ))}
            {!!unmatched.length && (
              <div className="flex items-start gap-2 rounded-tile bg-amber-50 px-3 py-2 text-tiny text-amber-700">
                <Plus size={14} className="mt-0.5 flex-none" />
                <span>
                  这些单位系统里还没有：{unmatched.map(u => `${u.label}「${u.name}」`).join('、')}。
                  点「新建{targetLabel}并填入」后，在表单的「对方单位」旁点 <b>＋</b> 就能顺手建上。
                </span>
              </div>
            )}
            {projectHint && (
              <div className="flex items-start gap-2 rounded-tile bg-amber-50 px-3 py-2 text-tiny text-amber-700">
                <Plus size={14} className="mt-0.5 flex-none" />
                <span>识别到项目名「{hints.project_name}」，但系统里没找到；可在表单的「所属项目」旁点 <b>＋</b> 新建。</span>
              </div>
            )}
          </div>
        )}

        {/* 识别原文：抽出来的值不对时，这里能看到 OCR 到底读到了什么。
            区分「归一化后」和「原始输出」——前者才是抽取器实际匹配的内容。 */}
        <div className="rounded-tile bg-slate-50">
          <button onClick={toggleRaw}
            className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left transition-colors duration-200 hover:bg-slate-100">
            <FileText size={14} className="flex-none text-ink-400" />
            <span className="text-body text-ink-700">查看识别原文</span>
            <span className="text-tiny text-ink-400">
              {att.ocr_text_length ? `${att.ocr_text_length} 字` : '暂无'}
              {att.ocr && att.ocr.normalized_length ? ` → 归一化 ${att.ocr.normalized_length} 字` : ''}
            </span>
            {rawLoading && <RefreshCw size={13} className="animate-spin text-ink-400" />}
            <span className={cn('ml-auto flex-none text-ink-400 transition-transform duration-200', rawOpen && 'rotate-180')}>
              <ChevronDown size={14} />
            </span>
          </button>

          {rawOpen && !rawLoading && raw && (
            <div className="space-y-2.5 border-t border-slate-200 px-3.5 py-3">
              <div className="text-tiny leading-relaxed text-ink-500">
                {rawTab === 'normalized'
                  ? '抽取器实际匹配的就是下面这段（已去掉字间空格、统一了连字符）。值抽错了多半是这里被 OCR 读花了。'
                  : 'OCR 引擎的原始输出，字之间带空格。对比上面那段能看出归一化做了什么。'}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {([['normalized', '归一化后'], ['raw', 'OCR 原始输出']] as const).map(([k, label]) => (
                  <button key={k} onClick={() => setRawTab(k)}
                    className={cn('rounded-full px-2.5 py-1 text-tiny transition-colors duration-200',
                      rawTab === k ? 'bg-brand text-white' : 'bg-white text-ink-500 hover:text-ink-800')}>
                    {label}
                  </button>
                ))}
                <button onClick={copyRaw}
                  className="ml-auto rounded-full bg-white px-2.5 py-1 text-tiny text-ink-500 transition-colors duration-200 hover:text-ink-800">
                  {rawCopied ? '已复制' : '复制全文'}
                </button>
              </div>

              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-tile bg-white p-3 font-mono text-[11px] leading-relaxed text-ink-600">
                {(rawTab === 'normalized' ? raw.normalized : raw.text) || '（空）'}
              </pre>

              {/* 每个字段是从哪句话抽出来的 —— 抽错的时候看这个最快 */}
              {!!hitList.length && (
                <div className="space-y-1">
                  <div className="text-tiny font-medium text-ink-500">各字段的出处</div>
                  {hitList.map(([k, v]) => (
                    <div key={k} className="flex gap-2 text-tiny">
                      <span className="w-[92px] flex-none text-ink-400">{FIELD_LABEL[k] || k}</span>
                      <span className="min-w-0 break-all font-mono text-[11px] text-ink-700">{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {rawOpen && !rawLoading && rawError && (
            <div className="border-t border-slate-200 px-3.5 py-3 text-tiny text-red-600">
              取原文失败：{rawError}
            </div>
          )}

          {rawOpen && !rawLoading && !raw && !rawError && (
            <div className="border-t border-slate-200 px-3.5 py-3 text-tiny text-ink-400">
              这个附件没有留下识别原文（可能是老数据，或识别失败）。重新识别一次就有了。
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}
