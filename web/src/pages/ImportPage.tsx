import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Upload, Download, FileSpreadsheet, CircleCheck, TriangleAlert, ArrowRight } from 'lucide-react'
import { Button, Card, Pill, Empty, Skeleton, IconTile, Select } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'
import { useApp } from '@/app-context'
import { http } from '@/lib/api'
import { cn } from '@/lib/utils'

export default function ImportPage() {
  const { meta, refreshDash, refreshMeta } = useApp()
  // AI 助手把表格文件引导过来时会带上 ?table=xxx（按表头猜的目标表），
  // 用户少点一次；猜错了也无所谓，上面的表切换按钮还在
  const [sp] = useSearchParams()
  const presetTable = sp.get('table') || ''
  const [im, setIm] = useState<any>(null)
  const [table, setTable] = useState(presetTable || 'partners')
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [autoCreate, setAutoCreate] = useState(true)
  const fileRef = useRef<HTMLInputElement>(null)
  const toast = useToast()

  useEffect(() => {
    http.importMeta().then(setIm).catch(e => toast((e as Error).message, 'err'))
  }, [])

  const order: string[] = im?.order || ['partners', 'projects', 'contracts', 'schedules', 'payments', 'invoices', 'materials']
  const info = im?.tables?.[table]

  const run = async (file: File) => {
    setBusy(true); setResult(null)
    try {
      const r = await http.runImport(table, file, { autoCreatePartners: autoCreate })
      setResult(r)
      if (r.inserted > 0) { void refreshDash(); void refreshMeta() }
      toast(`成功导入 ${r.inserted} 条`, r.inserted ? 'ok' : 'warn')
    } catch (e) { toast((e as Error).message, 'err', 5000) }
    finally { setBusy(false) }
  }

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4 px-6 py-5">
        <IconTile icon={Upload} tone="purple" />
        <div>
          <h1 className="text-page text-ink-900">数据导入</h1>
          <p className="mt-1 text-body text-ink-500">从 Excel / CSV 批量导入历史台账，自动匹配表头、识别单位与项目</p>
        </div>
      </Card>

      {/* 步骤条 */}
      <Card className="px-6 py-5">
        <div className="flex flex-wrap items-center gap-3">
          {order.map((k, i) => (
            <div key={k} className="flex items-center gap-3">
              <button
                onClick={() => { setTable(k); setResult(null) }}
                className={cn(
                  'flex items-center gap-2.5 rounded-tile px-4 py-2.5 transition-all duration-200',
                  table === k ? 'grad-brand text-white shadow-soft' : 'bg-slate-50 text-ink-600 hover:bg-slate-100',
                )}
              >
                <span className={cn('flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-bold',
                  table === k ? 'bg-white/25' : 'bg-surface text-ink-400')}>
                  {i + 1}
                </span>
                <span className="text-body font-medium">{meta?.tables?.[k]?.label || k}</span>
              </button>
              {i < order.length - 1 && <ArrowRight size={15} className="text-ink-300" />}
            </div>
          ))}
        </div>
        <p className="mt-3 text-tiny text-ink-400">
          按这个顺序导入最稳妥：先建单位和项目，再导合同与计划，最后导收付款、发票、材料。
        </p>
      </Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* 上传区 */}
        <Card className="xl:col-span-2">
          <div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">
            导入「{meta?.tables?.[table]?.label || table}」
          </div>
          <div className="px-5 pb-5">
            <div className="flex flex-wrap items-center gap-2.5">
              <a className="btn btn-soft" href={http.importTemplateUrl(table)}>
                <Download size={16} /> 下载导入模板
              </a>
              <label className="flex cursor-pointer items-center gap-2 text-tiny text-ink-500">
                <input type="checkbox" className="h-4 w-4 cursor-pointer accent-blue-500"
                  checked={autoCreate} onChange={e => setAutoCreate(e.target.checked)} />
                遇到不存在的往来单位自动新建
              </label>
            </div>

            <div
              onClick={() => fileRef.current?.click()}
              className="mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-tile bg-slate-50 py-10 transition-colors duration-200 hover:bg-slate-100"
            >
              <span className="grad-purple flex h-12 w-12 items-center justify-center rounded-tile text-white">
                <FileSpreadsheet size={22} />
              </span>
              <p className="text-body font-medium text-ink-700">{busy ? '正在导入…' : '点击选择 Excel / CSV 文件'}</p>
              <p className="text-tiny text-ink-400">支持 .csv / .xlsx / .xlsm，单个最大 {im?.maxMB || 40}MB</p>
            </div>
            <input ref={fileRef} type="file" hidden accept={im?.accept || '.csv,.xlsx'}
              onChange={e => { const f = e.target.files?.[0]; if (f) void run(f); e.target.value = '' }} />

            {/* 导入结果 */}
            {result && (
              <div className="mt-4 rounded-tile bg-slate-50 p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <Pill tone="green" dot>成功 {result.inserted}</Pill>
                  <Pill tone="gray">跳过 {result.skipped}</Pill>
                  {!!result.failed && <Pill tone="red" dot>失败 {result.failed}</Pill>}
                  <span className="text-tiny text-ink-400">共 {result.totalRows} 行 · {result.kind}</span>
                </div>
                {!!result.unknownHeaders?.length && (
                  <div className="mt-3 flex items-start gap-2 text-tiny text-orange-600">
                    <TriangleAlert size={14} className="mt-0.5 flex-none" />
                    <span>这些列没认出来，已忽略：{result.unknownHeaders.join('、')}</span>
                  </div>
                )}
                {!!result.errors?.length && (
                  <div className="mt-3 space-y-1 text-tiny text-red-600">
                    {result.errors.slice(0, 8).map((e: any, i: number) => (
                      <div key={i}>第 {e.row} 行：{e.message}</div>
                    ))}
                    {result.errors.length > 8 && <div className="text-ink-400">…还有 {result.errors.length - 8} 条</div>}
                  </div>
                )}
              </div>
            )}
          </div>
        </Card>

        {/* 列说明 */}
        <Card>
          <div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">这一版要填哪些列</div>
          <div className="px-5 pb-5">
            {!info ? <Skeleton className="h-40" /> : (
              <div className="space-y-1.5">
                {(info.columns || []).map((c: any, i: number) => (
                  <div key={i} className="flex items-center gap-2.5 rounded-tile bg-slate-50 px-3 py-2">
                    <CircleCheck size={14} className={c.required ? 'text-brand' : 'text-ink-300'} />
                    <span className="text-tiny font-medium text-ink-900">{c.label}</span>
                    <span className="ml-auto text-[11px] text-ink-400">
                      {c.required ? '必填' : c.type === 'ref' ? '按名称匹配' : '选填'}
                    </span>
                  </div>
                ))}
                {(info.columns || []).length === 0 && <Empty title="暂无列说明" />}
              </div>
            )}
            <p className="mt-3 text-tiny leading-relaxed text-ink-400">
              表头名称不必完全一致——系统会按同义词匹配（比如「单位名称」「甲方」「供应商」都能认）。
              参考关系列请填名称而不是编号。
            </p>
          </div>
        </Card>
      </div>
    </div>
  )
}
