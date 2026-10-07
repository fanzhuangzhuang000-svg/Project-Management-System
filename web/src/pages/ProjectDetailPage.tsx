import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import {
  ArrowLeft, FolderKanban, Wallet, Coins, ReceiptText, Calendar, TrendingUp,
  Paperclip, Download, FileText, CircleCheck, ScrollText,
} from 'lucide-react'
import {
  Button, Card, Pill, Empty, Skeleton, IconTile, Progress, Avatar,
} from '@/components/ui/primitives'
import { TrendLines } from '@/components/ui/charts'
import { useApp } from '@/app-context'
import { http } from '@/lib/api'
import { cn, fmtMoney, fmtWan, n0, fmtInt } from '@/lib/utils'

const TABS: { key: string; label: string; icon: any }[] = [
  { key: 'contracts', label: '合同', icon: FileText },
  { key: 'schedules', label: '收付款计划', icon: Calendar },
  { key: 'payments', label: '收付款', icon: Wallet },
  { key: 'invoices', label: '发票', icon: ReceiptText },
  { key: 'expenses', label: '项目费用', icon: Coins },
  { key: 'materials', label: '材料设备', icon: FolderKanban },
  { key: 'maintenance', label: '售后维修', icon: TrendingUp },
  { key: 'attachments', label: '附件', icon: Paperclip },
]

export default function ProjectDetailPage() {
  const { id = '' } = useParams()
  const { meta } = useApp()
  const [data, setData] = useState<any>(null)
  const [tab, setTab] = useState('contracts')
  const [err, setErr] = useState('')

  useEffect(() => {
    setData(null); setErr('')
    http.project(id).then(setData).catch(e => setErr((e as Error).message))
  }, [id])

  const p = data?.project
  const s = (data?.stats || {}) as Record<string, number>

  if (err) return <Empty title="打不开这个项目" hint={err} />
  if (!data) return <div className="space-y-4"><Skeleton className="h-40" /><Skeleton className="h-80" /></div>

  const tabs = TABS.map(t => ({
    ...t,
    count: t.key === 'attachments' ? (data.attachment_total || 0) : (data[t.key]?.length || 0),
  }))

  return (
    <div className="space-y-4">
      {/* 项目头部 */}
      <Card className="overflow-hidden">
        <div className="grad-brand relative px-6 py-6 text-white">
          <div className="flex items-center gap-3">
            <Link to="/t/projects" className="inline-flex items-center gap-1.5 text-tiny text-white/80 transition-opacity duration-200 hover:opacity-100">
              <ArrowLeft size={14} /> 返回项目列表
            </Link>
            <Link
              to={`/statement/${id}`}
              className="ml-auto inline-flex items-center gap-1.5 rounded-tile bg-white/20 px-3.5 py-1.5 text-tiny font-medium text-white backdrop-blur transition-all duration-200 hover:-translate-y-0.5 hover:bg-white/30"
            >
              <ScrollText size={14} /> 生成对账单
            </Link>
          </div>
          <div className="mt-3 flex flex-wrap items-start gap-4">
            <span className="flex h-14 w-14 flex-none items-center justify-center rounded-[16px] bg-white/20 backdrop-blur">
              <FolderKanban size={26} />
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-[22px] font-bold leading-snug">{p.name}</h1>
              <div className="mt-1.5 flex flex-wrap items-center gap-2.5 text-tiny text-white/80">
                {p.code && <span className="tnum">{p.code}</span>}
                {p.client_id_name && <span>甲方：{p.client_id_name}</span>}
                {p.manager && <span>项目经理：{p.manager}</span>}
                {p.location && <span>{p.location}</span>}
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-white/20 px-2.5 py-[3px] text-tiny">{p.status}</span>
                {String(p.category || '').split(',').filter(Boolean).map((c: string, i: number) => (
                  <span key={i} className="rounded-full bg-white/15 px-2.5 py-[3px] text-tiny">{c}</span>
                ))}
              </div>
            </div>
            <div className="w-44 flex-none">
              <div className="mb-1.5 flex items-center justify-between text-tiny text-white/80">
                <span>完工进度</span><span className="tnum font-semibold text-white">{n0(p.progress)}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-white/25">
                <div className="h-full rounded-full bg-white transition-all duration-200" style={{ width: `${n0(p.progress)}%` }} />
              </div>
              <div className="mt-2 text-[11px] text-white/70">
                {p.start_date || '—'} → {p.end_date || '—'}
              </div>
            </div>
          </div>
          <span className="pointer-events-none absolute -right-12 -top-12 h-44 w-44 rounded-full bg-white/10" />
        </div>

        {/* 项目指标 */}
        <div className="grid grid-cols-2 gap-4 p-5 xl:grid-cols-5">
          <Stat icon={TrendingUp} tone="brand" label="收入合同额" value={fmtWan(s.contract_in)} unit="万元"
            foot={`不含税 ${fmtWan(s.contract_in_ex)} 万`} />
          <Stat icon={Wallet} tone="green" label="已回款" value={fmtWan(s.paid_in)} unit="万元"
            foot={`回款率 ${n0(s.collect_rate).toFixed(1)}%`} />
          <Stat icon={Coins} tone="warm" label="实际成本" value={fmtWan(s.cost)} unit="万元"
            foot={`执行率 ${n0(s.cost_used_rate).toFixed(1)}%`} />
          <Stat icon={TrendingUp} tone={n0(s.actual_profit) >= 0 ? 'green' : 'warm'} label="动态毛利" value={fmtWan(s.actual_profit)} unit="万元"
            foot={`毛利率 ${n0(s.actual_rate).toFixed(1)}%`} />
          <Stat icon={ReceiptText} tone="purple" label="应收未收" value={fmtWan(s.receivable)} unit="万元"
            foot={n0(s.inv_out_unpaid) > 0 ? `已开票未收 ${fmtWan(s.inv_out_unpaid)} 万` : '开票已覆盖收款'} />
        </div>
      </Card>

      {/* 页签 */}
      <Card>
        <div className="flex overflow-x-auto px-5 pt-5">
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'relative flex flex-none items-center gap-2 px-4 py-2.5 text-body transition-colors duration-200',
                tab === t.key ? 'font-semibold text-brand' : 'text-ink-400 hover:text-ink-700',
              )}
            >
              <t.icon size={15} />
              {t.label}
              <span className={cn('rounded-full px-1.5 text-[11px] tnum',
                tab === t.key ? 'bg-blue-50 text-brand' : 'bg-slate-100 text-ink-400')}>
                {t.count}
              </span>
              {tab === t.key && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-500" />}
            </button>
          ))}
        </div>

        <div className="p-5">
          {tab === 'attachments' ? (
            data.attachments?.length ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
                {data.attachments.map((a: any) => (
                  <a key={a.id} href={http.fileUrl(a.id, true)} target="_blank" rel="noreferrer"
                    className="group overflow-hidden rounded-tile bg-slate-50 transition-all duration-200 hover:-translate-y-0.5 hover:shadow-card">
                    <span className="flex h-24 items-center justify-center bg-white text-ink-300">
                      <FileText size={28} />
                    </span>
                    <span className="block truncate px-2.5 py-2 text-tiny text-ink-700">{a.original_name}</span>
                  </a>
                ))}
              </div>
            ) : <Empty icon={Paperclip} title="这个项目还没有附件" />
          ) : (
            <SubTable table={tab} rows={data[tab] || []} meta={meta} projectId={id} />
          )}
        </div>
      </Card>
    </div>
  )
}

function Stat({ icon, tone, label, value, unit, foot }: any) {
  return (
    <div className="flex items-start gap-3">
      <IconTile icon={icon} tone={tone} size="sm" />
      <div className="min-w-0">
        <div className="text-tiny text-ink-400">{label}</div>
        <div className="mt-0.5 flex items-baseline gap-1">
          <span className="text-[20px] font-extrabold tnum leading-none text-ink-900">{value}</span>
          <span className="text-tiny text-ink-400">{unit}</span>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-ink-400">{foot}</div>
      </div>
    </div>
  )
}

/** 项目下的子表：只展示列表列，用统一风格 */
function SubTable({ table, rows, meta, projectId }: { table: string; rows: any[]; meta: any; projectId: string }) {
  const def = meta?.tables?.[table]
  if (!def) return <Empty title="未知数据表" />
  if (!rows.length) return <Empty icon={FolderKanban} title={`这个项目还没有${def.label}记录`} />

  const cols = def.fields.filter((f: any) => f.list).slice(0, 7)

  return (
    <div className="overflow-x-auto">
      <table className="tbl min-w-full">
        <thead>
          <tr>{cols.map((f: any) => <th key={f.name} style={{ minWidth: f.width }}>{f.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r: any) => (
            <tr key={r.id}>
              {cols.map((f: any) => <td key={f.name}>{cell(table, f, r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function cell(table: string, f: any, r: any) {
  const v = r[f.name]
  const label = r[`${f.name}_name`]
  if (f.type === 'ref') return <span className="text-ink-700">{label || <span className="text-ink-300">—</span>}</span>
  if (f.type === 'money') return <span className={cn('tnum', f.danger && n0(v) > 0 ? 'font-semibold text-down' : 'text-ink-900')}>¥{fmtMoney(v)}</span>
  if (f.name === 'state') {
    const tone = ({ 待收付: 'gray', 部分收付: 'orange', 已完成: 'green', 已逾期: 'red' } as any)[v] || 'gray'
    return <Pill tone={tone} dot>{v || '—'}</Pill>
  }
  if (f.badge) {
    const tone = ({
      进行中: 'blue', 已完工: 'green', 草稿: 'gray', 执行中: 'blue', 已完成: 'green',
      已开具: 'blue', 已认证: 'green', 已付: 'green', 未付: 'orange', 待处理: 'orange',
    } as any)[v] || 'gray'
    if (v === 'in' || v === 'out') {
      const isIn = v === 'in'
      return <Pill tone={isIn ? 'green' : 'red'} dot>{table === 'invoices' ? (isIn ? '进项' : '销项') : (isIn ? '收款' : '付款')}</Pill>
    }
    return v ? <Pill tone={tone} dot>{v}</Pill> : <span className="text-ink-300">—</span>
  }
  if (f.type === 'date') return <span className="tnum text-ink-500">{v ? String(v).slice(0, 10) : '—'}</span>
  if (f.name === 'progress') return <span className="tnum text-ink-700">{n0(v)}%</span>
  const txt = v === null || v === undefined || v === '' ? null : String(v)
  return txt ? <span className="block max-w-[240px] truncate text-ink-700" title={txt}>{txt}</span>
    : <span className="text-ink-300">—</span>
}
