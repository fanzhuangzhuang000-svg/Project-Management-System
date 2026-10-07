import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Plus, Search, Download, Trash2, Pencil, ArrowUpDown, ChevronLeft, ChevronRight,
  Inbox, Calendar, FileSpreadsheet, Link2, FolderKanban, Wallet, AlertTriangle,
  TrendingUp, Coins, ReceiptText, Package, Wrench, Building2, FilePenLine, ScrollText,
} from 'lucide-react'
import {
  Button, Card, CardHeader, CardTitle, CardAction, Pill, Input, Select, Empty,
  Skeleton, Progress, Avatar, IconTile,
} from '@/components/ui/primitives'
import { TrendLines, DonutWithLegend, MiniBars } from '@/components/ui/charts'
import { RecordForm } from '@/components/form/RecordForm'
import { useConfirm, useToast } from '@/components/ui/overlay'
import { useApp } from '@/app-context'
import { http, api, type Row } from '@/lib/api'
import { cn, fmtMoney, fmtWan, n0, fmtInt } from '@/lib/utils'

const TABLE_ICON: Record<string, any> = {
  projects: FolderKanban, contracts: ScrollText, contract_changes: FilePenLine,
  schedules: Calendar, payments: Wallet, invoices: ReceiptText, expenses: Coins,
  materials: Package, maintenance: Wrench, partners: Building2,
}
const BADGE_TONE: Record<string, 'blue' | 'purple' | 'orange' | 'green' | 'red' | 'gray' | 'cyan'> = {
  进行中: 'blue', 未开工: 'gray', 已完工: 'green', 结算中: 'purple', 已结清: 'cyan', 已归档: 'gray',
  草稿: 'gray', 执行中: 'blue', 已完成: 'green', 已终止: 'red',
  已开具: 'blue', 已认证: 'green', 已作废: 'gray', 红冲: 'red',
  待收付: 'gray', 部分收付: 'orange', 已逾期: 'red',
  已付: 'green', 未付: 'orange', 有票: 'green', 无票: 'gray',
  待采购: 'gray', 已下单: 'blue', 部分到货: 'orange', 已到货: 'green', 已安装: 'cyan', 已退场: 'gray',
  待处理: 'orange', 处理中: 'blue', 已关闭: 'gray',
  质保内: 'cyan', 质保外: 'orange', 已确认: 'green',
  甲方: 'purple', 供应商: 'cyan', 分包商: 'orange', 劳务队: 'gray', 监理: 'gray', 设计院: 'gray',
  收款: 'green', 付款: 'red', 收入合同: 'green', 支出合同: 'orange',
  销项: 'green', 进项: 'orange', '销项（我开出）': 'green', '进项（收到）': 'orange',
}
const PAGE_SIZE = 20

export default function TablePage() {
  const { table = 'projects' } = useParams()
  const { meta, user, dash, refreshDash } = useApp()
  const nav = useNavigate()
  const toast = useToast()
  const { confirm, confirmNode } = useConfirm()

  const def = meta?.tables?.[table]
  const [rows, setRows] = useState<Row[] | null>(null)
  const [total, setTotal] = useState(0)
  const [sums, setSums] = useState<Record<string, number>>({})
  const [q, setQ] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [sort, setSort] = useState('')
  const [order, setOrder] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<number[]>([])
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [busy, setBusy] = useState(false)

  const canWrite = !!user?.perms && (user.perms.all || user.perms.write.includes(table))

  /* ---------- 取数 ---------- */
  const load = useCallback(async () => {
    if (!def) return
    setBusy(true)
    try {
      const r = await http.list(table, {
        q, sort, order,
        ...filters,
        limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE,
      })
      setRows(r.rows); setTotal(r.total); setSums(r.sums || {})
    } catch (e) {
      toast((e as Error).message, 'err')
      setRows([])
    } finally { setBusy(false) }
  }, [table, def, q, sort, order, filters, page, toast])

  useEffect(() => { setSelected([]) }, [table, q, filters, page])
  useEffect(() => { const t = setTimeout(load, 240); return () => clearTimeout(t) }, [load])

  /* ---------- 排序 ---------- */
  const toggleSort = (name: string) => {
    if (sort === name) setOrder(o => (o === 'desc' ? 'asc' : 'desc'))
    else { setSort(name); setOrder('desc') }
    setPage(1)
  }

  /* ---------- 删除 ---------- */
  const doDelete = async (row: Row) => {
    const label = row[def?.display || 'name'] ?? `#${row.id}`
    const ok = await confirm(`删除「${label}」？`, '删除的记录会进回收站，30 天内可以还原。', '删除', true)
    if (!ok) return
    try {
      const r: any = await http.remove(table, row.id)
      toast(`已删除${r?.removedAttachments ? `（含 ${r.removedAttachments} 个附件）` : ''}`, 'ok')
      void load(); void refreshDash()
    } catch (e: any) {
      // 409 = 有关联数据，需要二次确认级联
      if (e.status === 409 && e.data?.needConfirm) {
        const deps = Object.entries(e.data.dependents || {}).map(([k, v]) => `${k} ${v}`).join('、')
        const ok2 = await confirm('存在关联数据', `将同时处理：${deps}。确定继续？`, '确定删除', true)
        if (!ok2) return
        try {
          await http.remove(table, row.id, { cascade: true })
          toast('已删除', 'ok'); void load(); void refreshDash()
        } catch (e2) { toast((e2 as Error).message, 'err') }
      } else toast(e.message, 'err')
    }
  }

  const doBatchDelete = async () => {
    if (!selected.length) return
    const ok = await confirm(`删除选中的 ${selected.length} 条？`, '删除的记录会进回收站，30 天内可以还原。', '删除', true)
    if (!ok) return
    try {
      await http.batchDelete(table, selected, {})
      toast(`已删除 ${selected.length} 条`, 'ok')
      setSelected([]); void load(); void refreshDash()
    } catch (e: any) {
      if (e.status === 409 && e.data?.needConfirm) {
        const deps = Object.entries(e.data.dependents || {}).map(([k, v]) => `${k} ${v}`).join('、')
        const ok2 = await confirm('存在关联数据', `将同时处理：${deps}。确定继续？`, '确定删除', true)
        if (!ok2) return
        await http.batchDelete(table, selected, { cascade: true })
        toast(`已删除 ${selected.length} 条`, 'ok')
        setSelected([]); void load(); void refreshDash()
      } else toast(e.message, 'err')
    }
  }

  /* ---------- 按付款条款生成收付款计划 ---------- */
  const genPlan = async (row: Row) => {
    const name = row[def?.display || 'name'] ?? `#${row.id}`
    try {
      // 先预览：后端会解析付款条款，返回要生成的节点
      const p: any = await api(`/api/contract/${row.id}/plan`, {
        method: 'POST',
        body: JSON.stringify({ preview: true }),
      })
      const nodes: any[] = p.nodes || []
      if (!nodes.length) {
        toast('这份合同的「付款条款」里没读到付款比例，请先补充，例如：预付30%，到货40%，验收25%，质保5%', 'err', 6000)
        return
      }
      const existN = n0(p.existing)
      const body = (
        <div className="space-y-3">
          <div className="text-body text-ink-500">
            合同「{name}」金额 <b className="text-ink-900">¥{fmtMoney(p.contract?.amount)}</b>，
            按付款条款将生成 <b className="text-ink-900">{nodes.length}</b> 个收付款节点：
          </div>
          <div className="max-h-56 overflow-y-auto rounded-tile bg-slate-50 p-3">
            {nodes.map((n, i) => (
              <div key={i} className="flex items-center gap-3 py-1.5 text-tiny">
                <span className="w-16 flex-none text-ink-500">{n.phase}</span>
                <span className={cn('w-12 flex-none rounded-full px-2 text-center',
                  n.direction === 'in' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500')}>
                  {n.direction === 'in' ? '收' : '付'}
                </span>
                <span className="w-14 flex-none text-right tnum text-ink-900">¥{fmtMoney(n.amount)}</span>
                <span className="text-ink-400">计划日 {n.due_date || '按合同日期推算'}</span>
              </div>
            ))}
          </div>
          {existN > 0 && (
            <div className="rounded-tile bg-amber-50 px-3.5 py-2.5 text-tiny text-amber-700">
              这份合同已经有 {existN} 个计划节点了。继续生成会把这 {existN} 个节点删掉重建，
              之前手工调整过的节点会丢失。
            </div>
          )}
        </div>
      )
      const ok = await confirm(
        existN > 0 ? '覆盖已有的收付款计划？' : '生成收付款计划？',
        body,
        existN > 0 ? '覆盖生成' : '生成',
        existN > 0,
      )
      if (!ok) return
      const r: any = await http.generatePlan(row.id, existN > 0)
      toast(`已生成 ${r.created} 个收付款计划节点`, 'ok')
      ;(r.warnings || []).forEach((w: string) => toast(w, 'warn', 6000))
      void refreshDash()
      // 生成完直接跳到计划页，方便核对
      if (r.created > 0) setTimeout(() => nav('/t/schedules'), 800)
    } catch (e) {
      toast((e as Error).message, 'err', 5000)
    }
  }

  /* ---------- 统计条（项目页用） ---------- */
  const t = (dash?.totals || {}) as Record<string, number>
  const strip = useMemo(() => {
    switch (table) {
      case 'projects': return [
        { label: '项目总数', value: fmtInt(t.project_count), unit: '个', tone: 'brand' as const, icon: FolderKanban },
        { label: '进行中', value: fmtInt(t.project_active), unit: '个', tone: 'cyan' as const, icon: TrendingUp },
        { label: '应收未收', value: fmtWan(t.receivable), unit: '万元', tone: 'purple' as const, icon: Wallet },
        { label: '已完工', value: fmtInt(t.project_done), unit: '个', tone: 'green' as const, icon: Coins },
      ]
      case 'contracts': return [
        { label: '收入合同额', value: fmtWan(t.contract_in), unit: '万元', tone: 'brand' as const, icon: ScrollText },
        { label: '支出合同额', value: fmtWan(t.contract_out), unit: '万元', tone: 'warm' as const, icon: Coins },
        { label: '合同份数', value: fmtInt(t.contract_count), unit: '份', tone: 'cyan' as const, icon: FileSpreadsheet },
        { label: '变更金额', value: fmtWan(n0(t.change_in) + n0(t.change_out)), unit: '万元', tone: 'purple' as const, icon: FilePenLine },
      ]
      case 'payments': return [
        { label: '累计回款', value: fmtWan(t.paid_in), unit: '万元', tone: 'green' as const, icon: Wallet },
        { label: '累计付款', value: fmtWan(t.paid_out), unit: '万元', tone: 'warm' as const, icon: Coins },
        { label: '回款率', value: n0(t.collect_rate).toFixed(1), unit: '%', tone: 'brand' as const, icon: TrendingUp },
        { label: '笔数', value: fmtInt(t.payment_count), unit: '笔', tone: 'cyan' as const, icon: ReceiptText },
      ]
      case 'invoices': return [
        { label: '销项已开票', value: fmtWan(t.inv_out), unit: '万元', tone: 'brand' as const, icon: ReceiptText },
        { label: '进项已收票', value: fmtWan(t.inv_in), unit: '万元', tone: 'cyan' as const, icon: ReceiptText },
        { label: '已开票未收', value: fmtWan(t.inv_out_unpaid), unit: '万元', tone: 'warm' as const, icon: AlertTriangle },
        { label: '已收款未开票', value: fmtWan(t.paid_in_no_inv), unit: '万元', tone: 'purple' as const, icon: AlertTriangle },
      ]
      case 'expenses': return [
        { label: '实际成本', value: fmtWan(t.cost), unit: '万元', tone: 'warm' as const, icon: Coins },
        { label: '预算（支出合同）', value: fmtWan(t.contract_out), unit: '万元', tone: 'brand' as const, icon: ScrollText },
        { label: '成本执行率', value: n0(t.cost_used_rate).toFixed(1), unit: '%', tone: n0(t.cost_over) > 0 ? 'warm' as const : 'green' as const, icon: TrendingUp },
        { label: '动态毛利', value: fmtWan(t.actual_profit), unit: '万元', tone: 'green' as const, icon: Wallet },
      ]
      case 'schedules': return [
        { label: '计划节点', value: fmtInt((dash?.schedules?.totals as any)?.node_count), unit: '个', tone: 'brand' as const, icon: Calendar },
        { label: '逾期节点', value: fmtInt((dash?.schedules?.totals as any)?.overdue_count), unit: '个', tone: 'warm' as const, icon: AlertTriangle },
        { label: '7 天内到期', value: fmtInt(dash?.schedules?.buckets?.d7?.count), unit: '个', tone: 'purple' as const, icon: AlertTriangle },
        { label: '计划收款', value: fmtWan((dash?.schedules?.totals as any)?.plan_in), unit: '万元', tone: 'green' as const, icon: Wallet },
      ]
      default: return []
    }
  }, [table, t, dash])

  if (!def) return <Empty title="未知数据表" />
  const Icon = TABLE_ICON[table] || Inbox
  const listFields = def.fields.filter(f => f.list)
  const filterFields = def.fields.filter(f => (f.type === 'select' || f.type === 'ref') && f.list).slice(0, 3)
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE))
  const allChecked = rows?.length ? rows.every(r => selected.includes(r.id)) : false

  return (
    <div className="space-y-4">
      {/* ══════ 欢迎条 ══════ */}
      <Card className="flex flex-wrap items-center gap-4 px-6 py-5">
        <div className="min-w-0">
          <h1 className="text-page text-ink-900">
            {user?.name || '管理员'}，{greetWord()}
          </h1>
          <p className="mt-1 text-body text-ink-500">{SUBTITLE[table] || `管理${def.label}数据，随时掌握进展`}</p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {table === 'invoices' && canWrite && (
            <Button variant="soft" onClick={async () => {
              const ok = await confirm('自动关联收款到发票？',
                '系统会把还没填「对应发票」的收付款，按项目 + 合同匹配到开票日期最早的发票上。只改「对应发票」字段，不动金额。')
              if (!ok) return
              try { const r = await http.backfillInvoices(); toast(r.linked ? `已关联 ${r.linked} 笔` : '没有可自动关联的记录', r.linked ? 'ok' : 'warn'); void load() }
              catch (e) { toast((e as Error).message, 'err') }
            }}>
              <Link2 size={16} /> 自动关联收款
            </Button>
          )}
          <a className="btn btn-soft" href={http.exportUrl(table, { q, ...filters })}>
            <Download size={16} /> 导出
          </a>
          {canWrite && (
            <Button variant="primary" onClick={() => { setEditing(null); setFormOpen(true) }}>
              <Plus size={17} /> 新建{def.label}
            </Button>
          )}
        </div>
      </Card>

      {/* ══════ 小指标卡 ══════ */}
      {!!strip.length && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {strip.map((s, i) => (
            <Card key={i} hover className="flex items-center gap-3.5 p-4">
              <IconTile icon={s.icon} tone={s.tone} />
              <div className="min-w-0">
                <div className="text-tiny text-ink-400">{s.label}</div>
                <div className="mt-0.5 flex items-baseline gap-1">
                  <span className="text-[22px] font-extrabold tnum leading-none text-ink-900">{s.value}</span>
                  <span className="text-tiny text-ink-400">{s.unit}</span>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ══════ 主体：项目页右侧带图表 ══════ */}
      <div className={cn('grid grid-cols-1 gap-4', table === 'projects' ? 'xl:grid-cols-12' : '')}>
        <Card className={cn(table === 'projects' && 'xl:col-span-8')}>
          {/* 工具条 */}
          <div className="flex flex-wrap items-center gap-2.5 px-5 pt-5 pb-3">
            <div className="relative w-[240px]">
              <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
              <Input value={q} onChange={e => { setQ(e.target.value); setPage(1) }}
                placeholder={`搜索${def.label}…`} className="!h-9 !pl-9 text-tiny" />
            </div>
            {filterFields.map(f => {
              const opts = f.type === 'ref'
                ? (meta?.options?.[f.refTable!] || []).map(o => ({ value: String(o.value), label: o.label }))
                : (f.options || []).map(o => (typeof o === 'string' ? { value: o, label: o } : o))
              return (
                <Select key={f.name} value={filters[f.name] || ''}
                  onChange={e => { setFilters(s => ({ ...s, [f.name]: e.target.value })); setPage(1) }}
                  className="!h-9 w-auto min-w-[120px] text-tiny">
                  <option value="">全部{f.label}</option>
                  {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              )
            })}
            <span className="ml-auto text-tiny text-ink-400">共 {total} 条</span>
          </div>

          {/* 选中操作条 */}
          {selected.length > 0 && (
            <div className="mx-5 mb-3 flex items-center gap-3 rounded-tile bg-blue-50 px-4 py-2.5">
              <span className="text-tiny font-medium text-blue-700">已选 {selected.length} 条</span>
              <a className="btn btn-sm btn-soft !h-8 !px-3 text-tiny" href={http.exportUrl(table, { q, ...filters })}>导出所选</a>
              {canWrite && (
                <Button size="sm" variant="danger" onClick={doBatchDelete}>
                  <Trash2 size={14} /> 批量删除
                </Button>
              )}
              <button onClick={() => setSelected([])} className="ml-auto text-tiny text-ink-400 hover:text-ink-700">取消选择</button>
            </div>
          )}

          {/* 表格 */}
          {rows === null ? (
            <div className="space-y-2 px-5 pb-5">{[0, 1, 2, 3, 4].map(i => <Skeleton key={i} className="h-12" />)}</div>
          ) : !rows.length ? (
            <Empty icon={Icon} title={`还没有${def.label}数据`}
              hint={canWrite ? `点右上角「新建${def.label}」开始录入` : '当前筛选条件下没有记录'} />
          ) : (
            <div className="overflow-x-auto px-2 pb-2">
              <table className="tbl min-w-full">
                <thead>
                  <tr>
                    {canWrite && (
                      <th className="w-10">
                        <input type="checkbox" checked={allChecked}
                          onChange={e => setSelected(e.target.checked ? rows.map(r => r.id) : [])}
                          className="h-4 w-4 cursor-pointer rounded accent-blue-500" />
                      </th>
                    )}
                    {listFields.map(f => (
                      <th key={f.name} style={{ minWidth: f.width }}>
                        <button onClick={() => toggleSort(f.name)}
                          className="inline-flex items-center gap-1 transition-colors duration-200 hover:text-brand">
                          {f.label}
                          <ArrowUpDown size={11} className={cn('transition-opacity', sort === f.name ? 'text-brand opacity-100' : 'opacity-30')} />
                        </button>
                      </th>
                    ))}
                    <th className="text-right">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className={cn(selected.includes(r.id) && 'bg-blue-50/60')}>
                      {canWrite && (
                        <td>
                          <input type="checkbox" checked={selected.includes(r.id)}
                            onChange={e => setSelected(s => e.target.checked ? [...s, r.id] : s.filter(x => x !== r.id))}
                            className="h-4 w-4 cursor-pointer rounded accent-blue-500" />
                        </td>
                      )}
                      {listFields.map(f => <td key={f.name}>{renderCell(table, f, r, meta)}</td>)}
                      <td className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {table === 'projects' && (
                            <Link to={`/p/${r.id}`} className="rounded-[10px] px-2.5 py-1 text-tiny text-brand transition-colors duration-200 hover:bg-blue-50">
                              详情
                            </Link>
                          )}
                          {table === 'contracts' && canWrite && (
                            <button
                              onClick={() => genPlan(r)}
                              title="按合同里的付款条款自动拆出收付款计划节点"
                              className="flex h-8 items-center gap-1 rounded-[10px] px-2.5 text-tiny text-brand transition-colors duration-200 hover:bg-blue-50"
                            >
                              <Calendar size={14} /> 生成计划
                            </button>
                          )}
                          {canWrite && (
                            <>
                              <button onClick={() => { setEditing(r); setFormOpen(true) }}
                                className="flex h-8 w-8 items-center justify-center rounded-[10px] text-ink-400 transition-colors duration-200 hover:bg-slate-100 hover:text-ink-900"
                                title="编辑"><Pencil size={15} /></button>
                              <button onClick={() => doDelete(r)}
                                className="flex h-8 w-8 items-center justify-center rounded-[10px] text-ink-400 transition-colors duration-200 hover:bg-red-50 hover:text-down"
                                title="删除"><Trash2 size={15} /></button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 合计行 */}
          {rows?.length ? (
            <div className="mx-5 mb-4 flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-tile bg-slate-50 px-4 py-2.5">
              <span className="text-tiny font-medium text-ink-500">本页合计</span>
              {listFields.filter(f => f.type === 'money').map(f => (
                <span key={f.name} className="text-tiny text-ink-500">
                  {f.label} <b className="tnum text-ink-900">¥{fmtMoney(sums[f.name] || 0)}</b>
                </span>
              ))}
            </div>
          ) : null}

          {/* 分页 */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-5 pb-5">
              <span className="text-tiny text-ink-400">第 {page} / {totalPages} 页</span>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="soft" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
                  <ChevronLeft size={15} /> 上一页
                </Button>
                <Button size="sm" variant="soft" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
                  下一页 <ChevronRight size={15} />
                </Button>
              </div>
            </div>
          )}
        </Card>

        {/* 项目页右栏：趋势 + 分类 */}
        {table === 'projects' && (
          <div className="space-y-4 xl:col-span-4">
            <Card>
              <CardHeader>
                <CardTitle>合同额与回款趋势</CardTitle>
              </CardHeader>
              <div className="px-3 pb-4">
                <TrendLines
                  data={(dash?.monthly || []).slice(-6).map(m => ({
                    label: String(m.ym).slice(2),
                    inflow: n0(m.inflow) / 10000,
                    outflow: n0(m.outflow) / 10000,
                  }))}
                  height={180} unit=" 万"
                  series={[
                    { key: 'inflow', name: '回款', color: '#3B82F6' },
                    { key: 'outflow', name: '付款', color: '#F97316' },
                  ]}
                />
              </div>
            </Card>

            <Card>
              <CardHeader><CardTitle>子系统合同额分布</CardTitle></CardHeader>
              <div className="px-5 pb-5">
                <DonutWithLegend
                  height={150}
                  centerValue={Object.keys(dash?.by_category || {}).length}
                  centerLabel="个子系统"
                  slices={Object.entries(dash?.by_category || {})
                    .sort((a, b) => b[1].contract_in - a[1].contract_in)
                    .slice(0, 5)
                    .map(([k, v], i) => ({
                      key: k, name: k, value: Math.round(v.contract_in / 10000),
                      color: ['#3B82F6', '#8B5CF6', '#F97316', '#10B981', '#06B6D4'][i],
                    }))}
                />
              </div>
            </Card>
          </div>
        )}
      </div>

      {confirmNode}
      <RecordForm
        open={formOpen} table={table} record={editing} meta={meta!}
        onClose={() => setFormOpen(false)}
        onSaved={() => { void load(); void refreshDash() }}
      />
    </div>
  )
}

function greetWord() {
  const h = new Date().getHours()
  if (h < 6) return '凌晨好'
  if (h < 12) return '上午好'
  if (h < 14) return '中午好'
  if (h < 18) return '下午好'
  return '晚上好'
}

const SUBTITLE: Record<string, string> = {
  projects: '实时掌握项目进展，优化资源分配，提升交付效率',
  contracts: '收入与支出合同集中管理，变更金额自动计入最终金额',
  contract_changes: '增补、削减、工期与范围调整都记在这里，已确认的会计入合同最终金额',
  schedules: '按付款条款拆出的收付款节点，自动冲抵实际收付款',
  payments: '每一笔回款与付款，登记后自动冲抵对应的计划节点',
  invoices: '销项与进项分开管理，并与收款自动勾稽',
  expenses: '真实发生的人工、材料、分包等支出，决定项目的真实利润',
  materials: '设备线缆采购清单，跟踪到货与安装进度',
  maintenance: '质保期内的报修与处理记录，区分质保内外',
  partners: '甲方、供应商、分包商的联系方式与开票资料',
}

/* ---------------- 单元格渲染 ---------------- */
function renderCell(table: string, f: any, r: Row, meta: any) {
  const v = r[f.name]
  const nameKey = `${f.name}_name`

  if (f.type === 'ref') {
    const label = r[nameKey]
    if (!label) return <span className="text-ink-300">—</span>
    // 项目列做成可点链接
    if (f.refTable === 'projects') {
      return <Link to={`/p/${v}`} className="font-medium text-brand transition-opacity duration-200 hover:opacity-70">{label}</Link>
    }
    return <span className="text-ink-700">{label}</span>
  }

  if (f.type === 'money') {
    const danger = f.danger && n0(v) > 0
    return <span className={cn('tnum', danger ? 'font-semibold text-down' : 'text-ink-900')}>¥{fmtMoney(v)}</span>
  }

  if (f.type === 'percent') return <span className="tnum text-ink-700">{n0(v)}%</span>

  if (f.name === 'progress') {
    return (
      <div className="flex items-center gap-2">
        <Progress value={n0(v)} tone="brand" className="!w-16" />
        <span className="w-8 text-tiny tnum text-ink-400">{n0(v)}%</span>
      </div>
    )
  }

  if (f.name === 'state') {
    const tone = ({ 待收付: 'gray', 部分收付: 'orange', 已完成: 'green', 已逾期: 'red' } as any)[v] || 'gray'
    return <Pill tone={tone} dot>{v || '—'}</Pill>
  }

  if (f.badge) {
    const tone = BADGE_TONE[String(v)] || 'gray'
    // 收/付方向用颜色区分
    if (v === 'in' || v === 'out') {
      const isIn = v === 'in'
      const txt = table === 'invoices' ? (isIn ? '进项' : '销项') : (isIn ? '收款' : '付款')
      return <Pill tone={isIn ? 'green' : 'red'} dot>{txt}</Pill>
    }
    return v ? <Pill tone={tone} dot>{v}</Pill> : <span className="text-ink-300">—</span>
  }

  if (f.name === 'manager' || f.name === 'operator' || f.name === 'handler' || f.name === 'contact') {
    return v
      ? <span className="inline-flex items-center gap-2"><Avatar name={String(v)} size={24} /><span className="text-ink-700">{v}</span></span>
      : <span className="text-ink-300">—</span>
  }

  if (f.type === 'date') return <span className="tnum text-ink-500">{v ? String(v).slice(0, 10) : '—'}</span>
  if (f.type === 'multi') {
    const list = String(v || '').split(',').map(s => s.trim()).filter(Boolean)
    if (!list.length) return <span className="text-ink-300">—</span>
    return <span className="flex flex-wrap gap-1">{list.slice(0, 2).map((x, i) => <Pill key={i} tone="gray">{x}</Pill>)}
      {list.length > 2 && <Pill tone="gray">+{list.length - 2}</Pill>}</span>
  }

  const txt = v === null || v === undefined || v === '' ? null : String(v)
  if (!txt) return <span className="text-ink-300">—</span>
  return <span className={cn(truncateClass(f))} title={txt.length > 24 ? txt : undefined}>{txt}</span>
}

const truncateClass = (f: any) => f.width && f.width > 200 ? 'block max-w-[260px] truncate text-ink-900' : 'text-ink-700'
