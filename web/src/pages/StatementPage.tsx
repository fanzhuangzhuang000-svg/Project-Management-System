import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Printer, Download, FileCheck2 } from 'lucide-react'
import { Button, Card, Pill, Empty, Skeleton } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'
import { http } from '@/lib/api'
import { cn, fmtMoney, fmtWan, n0, fmtDateCN } from '@/lib/utils'

/**
 * 项目对账单（给甲方/供应商核对用）
 * 顶部是汇总，下面按 合同 / 收款 / 付款 / 发票 分段列明细，可直接打印或导出。
 */
export default function StatementPage() {
  const { id = '' } = useParams()
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState('')
  const toast = useToast()

  useEffect(() => {
    setData(null); setErr('')
    http.statement(id).then(setData).catch(e => setErr((e as Error).message))
  }, [id])

  if (err) return <Empty title="打不开对账单" hint={err} />
  if (!data) return <div className="space-y-4"><Skeleton className="h-48" /><Skeleton className="h-96" /></div>

  const p = data.project
  const s = (data.stats || {}) as Record<string, number>
  const paymentsIn = (data.payments || []).filter((x: any) => x.direction === 'in')
  const paymentsOut = (data.payments || []).filter((x: any) => x.direction === 'out')
  const invOut = (data.invoices || []).filter((x: any) => x.direction === 'out')
  const invIn = (data.invoices || []).filter((x: any) => x.direction === 'in')

  return (
    <div className="space-y-4">
      {/* 操作条（打印时隐藏） */}
      <Card className="flex flex-wrap items-center gap-3 px-6 py-4 print:hidden">
        <Link to={`/p/${id}`} className="inline-flex items-center gap-1.5 text-tiny text-ink-500 transition-colors duration-200 hover:text-brand">
          <ArrowLeft size={14} /> 返回项目详情
        </Link>
        <div className="ml-auto flex items-center gap-2.5">
          <Button variant="soft" onClick={() => window.print()}><Printer size={15} /> 打印</Button>
          <Button variant="primary" onClick={() => window.open(http.exportUrl('payments', { project_id: id }), '_blank')}>
            <Download size={15} /> 导出收付款明细
          </Button>
        </div>
      </Card>

      {/* 对账单主体 */}
      <Card className="px-8 py-8">
        <div className="flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[22px] font-bold text-ink-900">项目对账单</h1>
            <div className="mt-1 text-tiny text-ink-400">
              制表日期：{fmtDateCN(data.generatedAt)}
            </div>
          </div>
          <div className="text-right text-tiny text-ink-500">
            <div className="text-[13px] font-semibold text-ink-900">{p.name}</div>
            {p.code && <div className="tnum">{p.code}</div>}
            {data.client && <div>甲方：{data.client.name}</div>}
          </div>
        </div>

        {/* 汇总 */}
        <div className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-tile bg-slate-100 md:grid-cols-4">
          {[
            { k: '收入合同额', v: s.contract_in, tone: 'text-ink-900' },
            { k: '累计回款', v: s.paid_in, tone: 'text-up' },
            { k: '应收未收', v: s.receivable, tone: n0(s.receivable) > 0 ? 'text-down' : 'text-up' },
            { k: '回款率', v: null, extra: `${n0(s.collect_rate).toFixed(1)}%`, tone: 'text-brand' },
          ].map((x, i) => (
            <div key={i} className="bg-white px-4 py-3.5">
              <div className="text-tiny text-ink-400">{x.k}</div>
              <div className={cn('mt-1 text-[19px] font-bold tnum', x.tone)}>
                {x.extra ?? `¥${fmtMoney(x.v)}`}
              </div>
            </div>
          ))}
        </div>

        {/* 合同明细 */}
        <Section title="合同明细" count={data.contracts?.length || 0}>
          <table className="tbl w-full">
            <thead><tr><th>合同名称</th><th>编号</th><th>方向</th><th className="text-right">金额</th><th className="text-right">不含税</th></tr></thead>
            <tbody>
              {(data.contracts || []).map((c: any) => (
                <tr key={c.id}>
                  <td className="text-ink-900">{c.name}</td>
                  <td className="tnum text-ink-500">{c.code || '—'}</td>
                  <td><Pill tone={c.direction === 'in' ? 'green' : 'red'} dot>{c.direction === 'in' ? '收入' : '支出'}</Pill></td>
                  <td className="text-right tnum text-ink-900">¥{fmtMoney(c.amount)}</td>
                  <td className="text-right tnum text-ink-500">¥{fmtMoney(c.amount_ex_tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* 收款明细 */}
        <Section title="收款明细" count={paymentsIn.length}>
          <PayTable rows={paymentsIn} />
        </Section>

        {/* 付款明细 */}
        <Section title="付款明细" count={paymentsOut.length}>
          <PayTable rows={paymentsOut} />
        </Section>

        {/* 发票明细 */}
        <Section title="发票明细" count={(data.invoices || []).length}>
          <table className="tbl w-full">
            <thead><tr><th>发票号码</th><th>销项/进项</th><th>开票日期</th><th className="text-right">价税合计</th></tr></thead>
            <tbody>
              {[...invOut, ...invIn].map((v: any) => (
                <tr key={v.id}>
                  <td className="tnum text-ink-900">{v.invoice_no || `#${v.id}`}</td>
                  <td><Pill tone={v.direction === 'out' ? 'green' : 'orange'} dot>{v.direction === 'out' ? '销项' : '进项'}</Pill></td>
                  <td className="tnum text-ink-500">{v.issue_date || '—'}</td>
                  <td className="text-right tnum text-ink-900">¥{fmtMoney(v.total_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        {/* 收付款计划 */}
        <Section title="收付款计划执行情况" count={data.schedules?.length || 0}>
          <table className="tbl w-full">
            <thead><tr>
              <th>节点</th><th>收/付</th><th>计划日期</th>
              <th className="text-right">计划金额</th><th className="text-right">已收付</th>
              <th className="text-right">未收付</th><th>状态</th>
            </tr></thead>
            <tbody>
              {(data.schedules || []).map((x: any) => (
                <tr key={x.id}>
                  <td className="text-ink-900">{x.phase}</td>
                  <td><Pill tone={x.direction === 'in' ? 'green' : 'red'} dot>{x.direction === 'in' ? '收' : '付'}</Pill></td>
                  <td className="tnum text-ink-500">{x.due_date || '—'}</td>
                  <td className="text-right tnum text-ink-700">¥{fmtMoney(x.amount)}</td>
                  <td className="text-right tnum text-ink-700">¥{fmtMoney(x.paid_amount)}</td>
                  <td className={cn('text-right tnum', n0(x.remaining) > 0 ? 'font-semibold text-down' : 'text-ink-300')}>
                    ¥{fmtMoney(x.remaining)}
                  </td>
                  <td><Pill tone={({ 已完成: 'green', 已逾期: 'red', 部分收付: 'orange' } as any)[x.state] || 'gray'} dot>{x.state}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>

        <div className="mt-8 flex items-start justify-between gap-10 text-tiny text-ink-400">
          <div>
            <div className="mb-8">甲方（盖章）：</div>
            <div className="w-48 border-t border-slate-200 pt-1.5">日期</div>
          </div>
          <div>
            <div className="mb-8">我方（盖章）：</div>
            <div className="w-48 border-t border-slate-200 pt-1.5">日期</div>
          </div>
        </div>
      </Card>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div className="mt-7">
      <div className="mb-2.5 flex items-center gap-2">
        <FileCheck2 size={15} className="text-brand" />
        <span className="text-cardtitle text-ink-700">{title}</span>
        <span className="rounded-full bg-slate-100 px-2 text-[11px] tnum text-ink-400">{count}</span>
      </div>
      {count ? (
        <div className="overflow-x-auto rounded-tile bg-slate-50/60 p-1">{children}</div>
      ) : (
        <div className="rounded-tile bg-slate-50 px-4 py-3 text-tiny text-ink-400">暂无记录</div>
      )}
    </div>
  )
}

function PayTable({ rows }: { rows: any[] }) {
  return (
    <table className="tbl w-full">
      <thead><tr><th>发生日期</th><th>款项性质</th><th>结算方式</th><th>凭证号</th><th className="text-right">金额</th></tr></thead>
      <tbody>
        {rows.map((x: any) => (
          <tr key={x.id}>
            <td className="tnum text-ink-500">{x.pay_date || '—'}</td>
            <td className="text-ink-900">{x.kind || '—'}</td>
            <td className="text-ink-500">{x.method || '—'}</td>
            <td className="tnum text-ink-500">{x.voucher_no || '—'}</td>
            <td className="text-right tnum text-ink-900">¥{fmtMoney(x.amount)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
