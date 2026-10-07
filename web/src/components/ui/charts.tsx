import * as React from 'react'
import {
  Area, AreaChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { cn } from '@/lib/utils'

/* ============================ 悬停提示框（深色） ============================ */
function DarkTip({ active, payload, label, unit = '', formatter }: any) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-tile bg-[#0F172A]/95 px-3 py-2 text-tiny text-white shadow-pop backdrop-blur">
      {label !== undefined && <div className="mb-1 font-medium text-white/70">{label}</div>}
      {payload.map((p: any, i: number) => (
        <div key={i} className="flex items-center gap-2 whitespace-nowrap">
          <i className="h-2 w-2 rounded-full" style={{ background: p.color || p.stroke || p.fill }} />
          <span className="text-white/75">{p.name}</span>
          <b className="ml-auto tnum font-semibold">
            {formatter ? formatter(p.value, p) : `${Number(p.value).toLocaleString('zh-CN')}${unit}`}
          </b>
        </div>
      ))}
    </div>
  )
}

/* ============================ 迷你趋势面积图（指标卡右下角） ============================ */
export function Sparkline({
  data, dataKey = 'v', tone = 'brand', height = 30,
}: { data: any[]; dataKey?: string; tone?: 'brand' | 'purple' | 'warm' | 'cyan' | 'green'; height?: number }) {
  const gid = React.useId().replace(/[:]/g, '')
  const COLORS = {
    brand: ['#3B82F6', '#6366F1'],
    purple: ['#8B5CF6', '#A78BFA'],
    warm: ['#F97316', '#EF4444'],
    cyan: ['#06B6D4', '#22D3EE'],
    green: ['#10B981', '#34D399'],
  }[tone]

  if (!data?.length) return <div style={{ height }} />

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id={`sp-${gid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={COLORS[0]} stopOpacity={0.34} />
              <stop offset="100%" stopColor={COLORS[1]} stopOpacity={0} />
            </linearGradient>
          </defs>
          <Area
            type="monotone" dataKey={dataKey} stroke={COLORS[0]} strokeWidth={2}
            fill={`url(#sp-${gid})`} dot={false} isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ============================ 多线趋势图（带渐变填充） ============================ */
export interface LineSeries { key: string; name: string; color: string; fill?: boolean }

export function TrendLines({
  data, series, xKey = 'label', height = 260, unit = '', yWidth = 34,
}: { data: any[]; series: LineSeries[]; xKey?: string; height?: number; unit?: string; yWidth?: number }) {
  const gid = React.useId().replace(/[:]/g, '')
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -14 }}>
          <defs>
            {series.map(s => (
              <linearGradient key={s.key} id={`ln-${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={0.26} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0.01} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="4 6" stroke="#EEF2F7" vertical={false} />
          <XAxis
            dataKey={xKey} tickLine={false} axisLine={false}
            tick={{ fill: '#94A3B8', fontSize: 12 }} dy={6}
          />
          <YAxis
            tickLine={false} axisLine={false} width={yWidth}
            tick={{ fill: '#94A3B8', fontSize: 12 }}
          />
          <Tooltip content={<DarkTip unit={unit} />} cursor={{ stroke: '#CBD5E1', strokeDasharray: '4 4' }} />
          {series.map(s => (
            <Area
              key={s.key} type="monotone" dataKey={s.key} name={s.name}
              stroke={s.color} strokeWidth={2.6} fill={`url(#ln-${gid}-${s.key})`}
              dot={{ r: 3, fill: '#fff', stroke: s.color, strokeWidth: 2 }}
              activeDot={{ r: 5, fill: s.color, stroke: '#fff', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ============================ 单线面积图（燃尽预测等） ============================ */
export function AreaTrend({
  data, series, xKey = 'label', height = 240, yWidth = 34, dashedKeys = [],
}: { data: any[]; series: LineSeries[]; xKey?: string; height?: number; yWidth?: number; dashedKeys?: string[] }) {
  const gid = React.useId().replace(/[:]/g, '')
  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 10, bottom: 0, left: -14 }}>
          <defs>
            {series.map(s => (
              <linearGradient key={s.key} id={`ar-${gid}-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={s.color} stopOpacity={s.fill === false ? 0 : 0.28} />
                <stop offset="100%" stopColor={s.color} stopOpacity={0} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid strokeDasharray="4 6" stroke="#EEF2F7" vertical={false} />
          <XAxis dataKey={xKey} tickLine={false} axisLine={false} tick={{ fill: '#94A3B8', fontSize: 12 }} dy={6} />
          <YAxis tickLine={false} axisLine={false} width={yWidth} tick={{ fill: '#94A3B8', fontSize: 12 }} />
          <Tooltip content={<DarkTip unit=" 项" />} cursor={{ stroke: '#CBD5E1', strokeDasharray: '4 4' }} />
          {series.map(s => (
            <Area
              key={s.key} type="monotone" dataKey={s.key} name={s.name}
              stroke={s.color} strokeWidth={2.4}
              strokeDasharray={dashedKeys.includes(s.key) ? '6 6' : undefined}
              fill={s.fill === false ? 'transparent' : `url(#ar-${gid}-${s.key})`}
              dot={false} activeDot={{ r: 5, fill: s.color, stroke: '#fff', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

/* ============================ 环形图（中心大数字 + 图例） ============================ */
export interface DonutSlice { key: string; name: string; value: number; color: string }

export function DonutWithLegend({
  slices, centerValue, centerLabel, height = 210, legendWidth = 'auto',
}: { slices: DonutSlice[]; centerValue: React.ReactNode; centerLabel?: string; height?: number; legendWidth?: string }) {
  const total = slices.reduce((s, x) => s + Number(x.value || 0), 0)
  const data = slices.filter(s => s.value > 0)
  const [active, setActive] = React.useState<number | null>(null)

  return (
    <div className="flex flex-col items-center gap-5 lg:flex-row lg:items-center">
      <div className="relative flex-none" style={{ width: height, height }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data.length ? data : [{ key: 'empty', name: '暂无', value: 1, color: '#E2E8F0' }]}
              dataKey="value" nameKey="name" innerRadius="66%" outerRadius="96%"
              paddingAngle={data.length > 1 ? 2.5 : 0} stroke="none"
              onMouseEnter={(_, i) => setActive(i)} onMouseLeave={() => setActive(null)}
              isAnimationActive={false}
            >
              {(data.length ? data : [{ color: '#E2E8F0' }]).map((s, i) => (
                <Cell
                  key={i}
                  fill={s.color}
                  opacity={active === null || active === i ? 1 : 0.42}
                  style={{ transition: 'opacity 200ms cubic-bezier(0,0,.2,1)' }}
                />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-metric tnum text-ink-900">{centerValue}</span>
          {centerLabel && <span className="mt-0.5 text-tiny text-ink-400">{centerLabel}</span>}
        </div>
      </div>

      <div className="flex w-full flex-col gap-2.5" style={{ width: legendWidth }}>
        {slices.map((s, i) => {
          const pct = total > 0 ? (s.value / total) * 100 : 0
          return (
            <div
              key={s.key}
              className="flex items-center gap-2.5 rounded-tile px-2 py-1.5 transition-colors duration-200 hover:bg-slate-50"
              onMouseEnter={() => setActive(data.indexOf(s))}
              onMouseLeave={() => setActive(null)}
            >
              <i className="h-2.5 w-2.5 flex-none rounded-full" style={{ background: s.color }} />
              <span className="text-tiny text-ink-500">{s.name}</span>
              <b className="ml-auto tnum text-tiny font-semibold text-ink-700">{pct.toFixed(1)}%</b>
              <span className="tnum w-10 text-right text-tiny text-ink-400">{s.value}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ============================ 横向迷你柱（月度资金） ============================ */
export function MiniBars({ data, height = 120 }: { data: { label: string; a: number; b: number }[]; height?: number }) {
  const max = Math.max(1, ...data.flatMap(d => [d.a, d.b]))
  return (
    <div className="flex items-end gap-1.5" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="group flex flex-1 flex-col items-center gap-1">
          <div className="flex h-full w-full items-end justify-center gap-[3px]">
            <span className="w-1/3 rounded-t-[3px] bg-gradient-to-t from-blue-500/70 to-blue-400 transition-all duration-200"
              style={{ height: `${Math.max(3, (d.a / max) * 100)}%` }} title={`${d.label} ${d.a}`} />
            <span className="w-1/3 rounded-t-[3px] bg-gradient-to-t from-rose-500/70 to-rose-400 transition-all duration-200"
              style={{ height: `${Math.max(3, (d.b / max) * 100)}%` }} title={`${d.label} ${d.b}`} />
          </div>
          <span className="truncate text-[10px] text-ink-400">{d.label}</span>
        </div>
      ))}
    </div>
  )
}

export { DarkTip }
