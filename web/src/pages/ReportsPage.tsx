import { useEffect, useMemo, useState } from 'react'
import { ChartPie, TrendingUp, Activity, Wallet, Coins, AlertTriangle } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardAction, Empty, Skeleton, Pill, IconTile, Progress } from '@/components/ui/primitives'
import { TrendLines, DonutWithLegend, AreaTrend, MiniBars } from '@/components/ui/charts'
import { useApp } from '@/app-context'
import { http } from '@/lib/api'
import { cn, fmtWan, n0, fmtInt } from '@/lib/utils'

const EXPENSE_COLORS = ['#3B82F6', '#8B5CF6', '#F97316', '#10B981', '#06B6D4', '#EF4444', '#A78BFA', '#94A3B8', '#FBBF24']
const AGING_COLORS: Record<string, string> = {
  未到期: '#10B981', '1-30': '#3B82F6', '31-60': '#F59E0B', '61-90': '#F97316', '90+': '#EF4444',
}

export default function ReportsPage() {
  const { dash, loading, refreshDash } = useApp()
  const [range, setRange] = useState<'6' | '12'>('12')
  useEffect(() => { void refreshDash() }, [refreshDash])

  const d = dash
  const t = (d?.totals || {}) as Record<string, number>

  const flow = useMemo(() => (d?.monthly || []).slice(range === '6' ? -6 : -12).map(m => ({
    label: String(m.ym).slice(2),
    inflow: n0(m.inflow) / 10000,
    outflow: n0(m.outflow) / 10000,
    net: (n0(m.inflow) - n0(m.outflow)) / 10000,
  })), [d, range])

  const agingIn = useMemo(() => {
    const keys = ['未到期', '1-30', '31-60', '61-90', '90+']
    return keys.map(k => ({
      key: k, name: k, color: AGING_COLORS[k],
      value: Math.round(n0(d?.aging?.receivable?.[k]?.amount) / 10000),
    }))
  }, [d])

  const expenseSlices = useMemo(() => Object.entries(d?.by_expense || {})
    .sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, v], i) => ({ key: k, name: k, value: Math.round(n0(v) / 10000), color: EXPENSE_COLORS[i] })), [d])

  const trendData = useMemo(() => (d?.trend || []).map(x => ({
    label: String(x.ym).slice(2),
    profit: n0(x.actual_profit) / 10000,
    receivable: n0(x.receivable) / 10000,
    cost: n0(x.cost) / 10000,
  })), [d])

  if (loading && !d) {
    return <div className="grid grid-cols-2 gap-4">{[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-[300px]" />)}</div>
  }

  return (
    <div className="space-y-4">
      {/* 概览条 */}
      <Card className="flex flex-wrap items-center gap-4 px-6 py-5">
        <IconTile icon={ChartPie} tone="purple" />
        <div>
          <h1 className="text-page text-ink-900">报表统计</h1>
          <p className="mt-1 text-body text-ink-500">资金、成本、发票与账龄的多维分析</p>
        </div>
      </Card>

      {/* 关键指标 */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {[
          { icon: Wallet, tone: 'brand' as const, label: '收入合同额', v: fmtWan(t.contract_in), u: '万元' },
          { icon: Coins, tone: 'warm' as const, label: '实际成本', v: fmtWan(t.cost), u: '万元' },
          { icon: TrendingUp, tone: 'green' as const, label: '动态毛利', v: fmtWan(t.actual_profit), u: '万元' },
          { icon: AlertTriangle, tone: 'purple' as const, label: '应收未收', v: fmtWan(t.receivable), u: '万元' },
        ].map((m, i) => (
          <Card key={i} hover className="flex items-center gap-3.5 p-4">
            <IconTile icon={m.icon} tone={m.tone} />
            <div className="min-w-0">
              <div className="text-tiny text-ink-400">{m.label}</div>
              <div className="mt-0.5 flex items-baseline gap-1">
                <span className="text-[22px] font-extrabold tnum leading-none text-ink-900">{m.v}</span>
                <span className="text-tiny text-ink-400">{m.u}</span>
              </div>
            </div>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* 资金流水 */}
        <Card className="xl:col-span-8">
          <CardHeader>
            <CardTitle>资金流水（近 {range} 个月）</CardTitle>
            <CardAction>
              <div className="flex items-center gap-1 rounded-full bg-slate-100/80 p-1">
                {(['6', '12'] as const).map(v => (
                  <button key={v} onClick={() => setRange(v)}
                    className={cn('rounded-full px-3 py-1 text-tiny font-medium transition-all duration-200',
                      range === v ? 'bg-surface text-ink-900 shadow-soft' : 'text-ink-400 hover:text-ink-700')}>
                    近{v}个月
                  </button>
                ))}
              </div>
            </CardAction>
          </CardHeader>
          <div className="px-3 pb-5">
            {flow.length
              ? <TrendLines data={flow} height={268} unit=" 万" series={[
                { key: 'inflow', name: '回款', color: '#3B82F6' },
                { key: 'outflow', name: '付款', color: '#F97316' },
                { key: 'net', name: '净流入', color: '#8B5CF6' },
              ]} />
              : <Empty icon={Activity} title="还没有收付款数据" />}
          </div>
        </Card>

        {/* 应收账龄 */}
        <Card className="xl:col-span-4">
          <CardHeader><CardTitle>应收账龄分布</CardTitle></CardHeader>
          <div className="px-5 pb-5">
            {agingIn.some(x => x.value > 0) ? (
              <DonutWithLegend
                slices={agingIn}
                centerValue={fmtWan(t.receivable)}
                centerLabel="万元未收"
                height={190}
              />
            ) : <Empty icon={Wallet} title="没有未结清的应收款" />}
          </div>
        </Card>

        {/* 成本构成 */}
        <Card className="xl:col-span-5">
          <CardHeader><CardTitle>成本构成</CardTitle></CardHeader>
          <div className="px-5 pb-5">
            {expenseSlices.length ? (
              <DonutWithLegend
                slices={expenseSlices}
                centerValue={fmtWan(t.cost)}
                centerLabel="万元成本"
                height={190}
              />
            ) : <Empty icon={Coins} title="还没有费用记录" />}
          </div>
        </Card>

        {/* 经营趋势 */}
        <Card className="xl:col-span-7">
          <CardHeader><CardTitle>经营趋势（按月快照）</CardTitle></CardHeader>
          <div className="px-3 pb-5">
            {trendData.length >= 2
              ? <AreaTrend data={trendData} height={212} series={[
                { key: 'profit', name: '动态毛利', color: '#10B981' },
                { key: 'receivable', name: '应收未收', color: '#3B82F6' },
                { key: 'cost', name: '实际成本', color: '#F97316' },
              ]} />
              : <Empty icon={TrendingUp} title="快照还不够"
                hint="系统每月自动记录一份快照，积累 2 个月后这里会显示趋势线" />}
          </div>
        </Card>

        {/* 发票勾稽 */}
        <Card className="xl:col-span-12">
          <CardHeader><CardTitle>发票与收款勾稽</CardTitle></CardHeader>
          <div className="grid grid-cols-2 gap-4 px-5 pb-5 xl:grid-cols-5">
            {[
              { label: '销项已开票', v: t.inv_out, tone: 'text-brand', hint: '开给甲方的发票合计' },
              { label: '已开票未收', v: t.inv_out_unpaid, tone: n0(t.inv_out_unpaid) > 0 ? 'text-orange-500' : 'text-up', hint: '票已开、钱未收齐' },
              { label: '已收款未开票', v: t.paid_in_no_inv, tone: n0(t.paid_in_no_inv) > 0 ? 'text-down' : 'text-up', hint: '钱到账、票未开' },
              { label: '进项已收票', v: t.inv_in, tone: 'text-brand', hint: '供应商开来的发票合计' },
              { label: '已付款未收票', v: t.inv_in_unpaid, tone: n0(t.inv_in_unpaid) > 0 ? 'text-orange-500' : 'text-up', hint: '款已付、票未到' },
            ].map((x, i) => (
              <div key={i} className="rounded-tile bg-slate-50 px-4 py-3">
                <div className="text-tiny text-ink-500">{x.label}</div>
                <div className={cn('mt-1 flex items-baseline gap-1 font-bold tnum', x.tone)}>
                  <span className="text-[20px]">{fmtWan(x.v)}</span>
                  <span className="text-tiny font-medium">万元</span>
                </div>
                <div className="mt-1 text-[11px] text-ink-400">{x.hint}</div>
              </div>
            ))}
          </div>
          <div className="px-5 pb-5">
            <div className="flex items-center gap-3">
              <span className="text-tiny text-ink-500">开票覆盖率</span>
              <Progress value={n0(t.inv_cover_rate)} tone="cyan" className="!w-56" />
              <span className="text-tiny font-semibold tnum text-ink-900">{n0(t.inv_cover_rate).toFixed(1)}%</span>
              <span className="ml-auto text-tiny text-ink-400">
                {n0(t.linked_count) > 0 ? `${fmtInt(t.linked_count)} 笔已逐笔挂账` : '还没做逐笔挂账，可在发票页一键自动关联'}
              </span>
            </div>
          </div>
        </Card>
      </div>
    </div>
  )
}
