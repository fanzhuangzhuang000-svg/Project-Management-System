import { useEffect, useMemo, useRef, useState } from 'react'
import { Paperclip, Plus, Trash2, Upload, ScanLine, FileText } from 'lucide-react'
import { Modal, useToast } from '@/components/ui/overlay'
import { Button, Field, Input, Pill, Select, Textarea, IconTile } from '@/components/ui/primitives'
import { http, type FieldDef, type Meta, type Row } from '@/lib/api'
import { cn, fmtSize, n0 } from '@/lib/utils'

/**
 * 表单由后端 schema 驱动（字段顺序、类型、必填、下拉选项都来自 /api/meta），
 * 所以以后给某张表加字段，前端不用改。
 *
 * 两个「录入时不打断」的能力：
 *  1) 关联字段下拉里没有想要的记录时，就地新建（不用退出表单丢掉已填内容）
 *  2) 直接在表单里挂扫描件；保存时按 token 自动挂到这条记录上
 */
export function RecordForm({
  open, table, record, meta, preset, linkAttachIds, onClose, onSaved,
}: {
  open: boolean
  table: string
  record: Row | null
  meta: Meta
  preset?: Record<string, any>
  /** 保存时把这几张已有附件挂到这条记录上（识别后「新建并填入」用） */
  linkAttachIds?: number[]
  onClose: () => void
  onSaved: (id: number, isNew: boolean) => void
}) {
  const def = meta.tables[table]
  const toast = useToast()
  const fields = useMemo(
    // quick 字段是「表单专用的快捷录入」：本身是虚拟列（不落库），
    // 但要出现在表单里，填了由后端转成真实的关联记录
    () => def.fields.filter(f => f.form !== false && (!f.virtual || f.quick) && !f.calc),
    [def],
  )

  const [val, setVal] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  /** 本次上传的暂存附件（保存时按 token 挂到新记录上） */
  const [attachments, setAttachments] = useState<any[]>([])
  const [uploading, setUploading] = useState(false)
  /** 就地新建关联记录：{ fieldName, refTable } */
  const [quickRef, setQuickRef] = useState<{ field: FieldDef } | null>(null)
  /** 下拉选项本地增量（快建成功后立刻可选） */
  const [extraOpts, setExtraOpts] = useState<Record<string, { value: number; label: string }[]>>({})
  const tokenRef = useRef('t' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8))
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    const base: Record<string, any> = {}
    for (const f of fields) {
      // 快捷字段在库里没有值，编辑时从它声明的来源列带出来（比如项目的合同额）
      base[f.name] = record
        ? (record[f.name] ?? (f.quick && f.prefillFrom ? record[f.prefillFrom] : undefined) ?? '')
        : (preset?.[f.name] ?? f.default ?? (f.type === 'multi' ? '' : ''))
    }
    if (record?.id) base.id = record.id
    setVal(base)
    setErr('')
    setAttachments([])
    setExtraOpts({})
    tokenRef.current = 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }, [open, record, fields, preset])

  /* 已保存的记录：把挂在它身上的附件读出来一起展示 */
  useEffect(() => {
    if (!open || !record?.id) return
    let alive = true
    http.recordAttachments(table, record.id)
      .then(r => { if (alive) setAttachments(r.rows || []) })
      .catch(() => { /* 忽略 */ })
    return () => { alive = false }
  }, [open, table, record?.id])

  const set = (k: string, v: any) => setVal(s => ({ ...s, [k]: v }))

  const toggleMulti = (k: string, opt: string) => {
    const cur = String(val[k] || '').split(',').map(s => s.trim()).filter(Boolean)
    const next = cur.includes(opt) ? cur.filter(x => x !== opt) : [...cur, opt]
    set(k, next.join(','))
  }

  /* ---- 表单内上传附件：先以 token 暂存，保存时自动归位 ---- */
  const doUpload = async (files: FileList | null) => {
    if (!files?.length) return
    setUploading(true)
    for (const f of Array.from(files)) {
      try {
        const r = await http.upload(f, record?.id
          ? { table_name: table, record_id: String(record.id) }
          : { token: tokenRef.current })
        setAttachments(list => [...list, r.attachment])
      } catch (e) {
        toast(`${f.name}：${(e as Error).message}`, 'err', 4000)
      }
    }
    setUploading(false)
    if (record?.id) toast('已上传并挂到本记录', 'ok')
  }

  const dropAttachment = async (a: any) => {
    try { await http.deleteAttachment(a.id) } catch { /* 忽略 */ }
    setAttachments(list => list.filter(x => x.id !== a.id))
  }

  const submit = async () => {
    setErr('')
    for (const f of fields) {
      if (f.required && (val[f.name] === undefined || val[f.name] === null || String(val[f.name]).trim() === '')) {
        setErr(`「${f.label}」不能为空`); return
      }
    }
    setBusy(true)
    try {
      const payload: Record<string, any> = { ...val }
      // 新建时把暂存附件的 token 带上，后端保存后会自动挂到这条记录上
      if (!record?.id && attachments.length) payload.__attach_token = tokenRef.current
      // 「识别后新建并填入」：把那张扫描件挂到新记录上
      if (!record?.id && linkAttachIds?.length) payload.__attach_ids = linkAttachIds
      const r = await http.save(table, payload)
      // 后端可能顺便做了别的事（比如项目金额自动建了主合同），要说一声
      const note = (r as any)?.note
      toast(note || (record?.id ? '已保存' : '已新增'), 'ok', note ? 5000 : undefined)
      onSaved(r.id, !record?.id)
      onClose()
    } catch (e) {
      setErr((e as Error).message)
    } finally { setBusy(false) }
  }

  if (!def) return null

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={`${record?.id ? '编辑' : '新增'}${def.label}`}
        width="lg"
        footer={<>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </Button>
        </>}
      >
        <div className="grid grid-cols-1 gap-x-5 gap-y-4 pb-2 sm:grid-cols-2">
          {fields.map(f => {
            const full = f.span === 2 || f.type === 'textarea' || f.type === 'multi'
            return (
              <div key={f.name} className={cn(full && 'sm:col-span-2')}>
                <Field label={f.label + (f.required ? ' *' : '')} hint={f.hint || f.placeholder}>
                  {renderField(f, val[f.name], v => set(f.name, v), toggleMulti, meta, {
                    extra: extraOpts[f.name],
                    onQuickCreate: () => setQuickRef({ field: f }),
                  })}
                </Field>
              </div>
            )
          })}
        </div>

        {/* ---- 表单内附件区 ---- */}
        <div className="mt-5 rounded-tile bg-slate-50 p-4">
          <div className="flex items-center gap-2">
            <Paperclip size={15} className="text-ink-400" />
            <span className="text-tiny font-medium text-ink-700">扫描件 / 附件</span>
            <span className="text-[11px] text-ink-400">
              {record?.id ? '上传后立即挂到本记录' : '保存后自动挂到这条记录'}
            </span>
            <Button
              size="sm" variant="soft" className="ml-auto" disabled={uploading}
              onClick={() => fileRef.current?.click()}
            >
              <Upload size={14} /> {uploading ? '上传中…' : '上传附件'}
            </Button>
            <input ref={fileRef} type="file" multiple hidden
              accept={meta.upload?.accept}
              onChange={e => { void doUpload(e.target.files); e.target.value = '' }} />
          </div>

          {attachments.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
              {attachments.map(a => (
                <div key={a.id} className="flex items-center gap-2 rounded-tile bg-surface px-2.5 py-2">
                  <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[10px] bg-slate-100 text-ink-400">
                    <FileText size={15} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] font-medium text-ink-900" title={a.original_name}>
                      {a.original_name}
                    </span>
                    <span className="block text-[10px] text-ink-400">
                      {fmtSize(a.size)}
                      {a.ocr_status === 'done' && ' · 已识别'}
                      {a.ocr_status === 'pending' && <span className="text-orange-500"> · 识别中</span>}
                    </span>
                  </span>
                  <button onClick={() => dropAttachment(a)}
                    className="flex-none text-ink-300 transition-colors duration-200 hover:text-down" title="删除">
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {err && <div className="mt-1 rounded-tile bg-red-50 px-3.5 py-2.5 text-tiny text-red-600">{err}</div>}
      </Modal>

      {/* 就地新建关联记录（比如填合同时顺手把甲方建了） */}
      {quickRef && (
        <QuickRefForm
          refTable={quickRef.field.refTable!}
          label={quickRef.field.label}
          meta={meta}
          onClose={() => setQuickRef(null)}
          onCreated={(id, name) => {
            setExtraOpts(s => ({
              ...s,
              [quickRef.field.name]: [...(s[quickRef.field.name] || []), { value: id, label: name }],
            }))
            set(quickRef.field.name, id)
            setQuickRef(null)
            toast(`已新建「${name}」并选中`, 'ok')
          }}
        />
      )}
    </>
  )
}

/* ============================ 就地新建关联记录 ============================ */
function QuickRefForm({
  refTable, label, meta, onClose, onCreated,
}: {
  refTable: string
  label: string
  meta: Meta
  onClose: () => void
  onCreated: (id: number, name: string) => void
}) {
  const def = meta.tables[refTable]
  const toast = useToast()
  const fields = (def?.fields || []).filter(f => f.form !== false && !f.virtual && !f.calc).slice(0, 6)
  const [v, setV] = useState<Record<string, any>>({})
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    const base: Record<string, any> = {}
    for (const f of fields) base[f.name] = f.default ?? ''
    setV(base)
  }, [refTable])

  const save = async () => {
    setErr('')
    for (const f of fields) {
      if (f.required && !String(v[f.name] ?? '').trim()) { setErr(`「${f.label}」不能为空`); return }
    }
    setBusy(true)
    try {
      const r = await http.save(refTable, v)
      onCreated(r.id, String(v[def.display] ?? `#${r.id}`))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  return (
    <Modal
      open onClose={onClose}
      title={`新建${def?.label || label}`}
      width="sm"
      footer={<>
        <Button variant="ghost" onClick={onClose}>取消</Button>
        <Button variant="primary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存并选中'}</Button>
      </>}
    >
      <div className="space-y-3.5 pb-2">
        {fields.map(f => (
          <Field key={f.name} label={f.label + (f.required ? ' *' : '')}>
            {f.type === 'textarea'
              ? <Textarea rows={2} value={v[f.name] ?? ''} onChange={e => setV(s => ({ ...s, [f.name]: e.target.value }))} />
              : f.type === 'select'
                ? (
                  <Select value={v[f.name] ?? ''} onChange={e => setV(s => ({ ...s, [f.name]: e.target.value }))}>
                    <option value="">请选择</option>
                    {(f.options || []).map(o => {
                      const val = typeof o === 'string' ? o : o.value
                      const lb = typeof o === 'string' ? o : o.label
                      return <option key={val} value={val}>{lb}</option>
                    })}
                  </Select>
                )
                : <Input value={v[f.name] ?? ''} onChange={e => setV(s => ({ ...s, [f.name]: e.target.value }))} placeholder={f.placeholder} />}
          </Field>
        ))}
        {err && <div className="rounded-tile bg-red-50 px-3.5 py-2.5 text-tiny text-red-600">{err}</div>}
      </div>
    </Modal>
  )
}

function renderField(
  f: FieldDef,
  value: any,
  onChange: (v: any) => void,
  toggleMulti: (k: string, opt: string) => void,
  meta: Meta,
  extra?: { extra?: { value: number; label: string }[]; onQuickCreate?: () => void },
) {
  switch (f.type) {
    case 'textarea':
      return <Textarea rows={3} value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={f.placeholder} />

    case 'select':
      return (
        <Select value={value ?? ''} onChange={e => onChange(e.target.value)}>
          <option value="">请选择</option>
          {(f.options || []).map(o => {
            const v = typeof o === 'string' ? o : o.value
            const l = typeof o === 'string' ? o : o.label
            return <option key={v} value={v}>{l}</option>
          })}
        </Select>
      )

    case 'ref': {
      const base = meta.options[f.refTable!] || []
      const merged = extra?.extra ? [...base, ...extra.extra] : base
      return (
        <div className="flex items-center gap-2">
          <Select value={value ?? ''} onChange={e => onChange(e.target.value)} className="flex-1">
            <option value="">请选择{f.label}</option>
            {merged.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </Select>
          {extra?.onQuickCreate && (
            <button
              type="button"
              onClick={extra.onQuickCreate}
              title={`没有想要的？就地新建一个${f.label}`}
              className="flex h-10 w-10 flex-none items-center justify-center rounded-tile bg-slate-100 text-ink-500 transition-all duration-200 hover:bg-blue-50 hover:text-brand"
            >
              <Plus size={17} />
            </button>
          )}
        </div>
      )
    }

    case 'multi': {
      const cur = String(value || '').split(',').map(s => s.trim()).filter(Boolean)
      const opts = (f.options || []).map(o => (typeof o === 'string' ? o : o.value))
      return (
        <div className="flex flex-wrap gap-2">
          {opts.map(o => {
            const on = cur.includes(o)
            return (
              <button
                key={o} type="button" onClick={() => toggleMulti(f.name, o)}
                className={cn(
                  'rounded-full px-3.5 py-1.5 text-tiny font-medium transition-all duration-200',
                  on ? 'grad-brand text-white shadow-soft' : 'bg-slate-100 text-ink-500 hover:bg-slate-200',
                )}
              >
                {o}
              </button>
            )
          })}
        </div>
      )
    }

    case 'money':
      return <NumberInput value={value} onChange={onChange} prefix="¥" step={f.step ?? 0.01} />

    case 'number':
    case 'percent':
      return <NumberInput value={value} onChange={onChange} suffix={f.type === 'percent' ? '%' : undefined} step={f.step ?? 1} />

    case 'date':
      return <Input type="date" value={value ?? ''} onChange={e => onChange(e.target.value)} />

    default:
      return <Input value={value ?? ''} onChange={e => onChange(e.target.value)} placeholder={f.placeholder} />
  }
}

/** 金额 / 数字输入：右侧显示格式化后的值，避免长数字看错位 */
function NumberInput({
  value, onChange, prefix, suffix, step = 1,
}: { value: any; onChange: (v: any) => void; prefix?: string; suffix?: string; step?: number }) {
  const [focus, setFocus] = useState(false)
  const n = n0(value)
  const pretty = n ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : ''

  return (
    <div className="relative">
      {prefix && <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-tiny text-ink-400">{prefix}</span>}
      <Input
        type="number" step={step} value={value ?? ''}
        onChange={e => onChange(e.target.value)}
        onFocus={() => setFocus(true)} onBlur={() => setFocus(false)}
        className={cn(prefix && '!pl-8', suffix && '!pr-9')}
      />
      {suffix && <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-tiny text-ink-400">{suffix}</span>}
      {!focus && !suffix && pretty && (
        <span className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-tiny tnum text-ink-300">
          {pretty}
        </span>
      )}
    </div>
  )
}
