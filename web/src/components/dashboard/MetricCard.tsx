import type { LucideIcon } from 'lucide-react'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import { Card, IconTile, type TileTone } from '@/components/ui/primitives'
import { Sparkline } from '@/components/ui/charts'
import { cn, fmtWan, n0, splitMoney } from '@/lib/utils'

/**
 * 核心指标卡（规格第二区块）
 * 结构：彩色图标底 + 指标名 + 大数字（数字与单位分开）+ 涨跌 + 右下角迷你趋势面积图
 */
export function MetricCard({
  icon, tone, label, value, unit, delta, foot, spark, sparkTone, loading,
}: {
  icon: LucideIcon
  tone: TileTone
  label: string
  /** 已格式化好的数字字符串（金额请传「万」为单位的数值，由这里格式化） */
  value: number
  unit: string
  delta?: { text: string; up: boolean } | null
  foot?: string
  spark?: { v: number }[]
  sparkTone?: TileTone
  loading?: boolean
}) {
  const { int, dec } = splitMoney(value)

  return (
    <Card hover className="relative overflow-hidden p-5">
      <div className="flex items-start gap-3.5">
        <IconTile icon={icon} tone={tone} />
        <div className="min-w-0 flex-1">
          <div className="text-tiny font-medium text-ink-400">{label}</div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className={cn('text-metric tnum leading-none text-ink-900', loading && 'opacity-40')}>
              {int}
            </span>
            {dec && <span className="text-[15px] font-bold tnum leading-none text-ink-400">{dec}</span>}
            <span className="ml-0.5 text-tiny font-medium text-ink-400">{unit}</span>
          </div>
          <div className="mt-1.5 flex items-center gap-2">
            {delta && (
              <span className={cn(
                'inline-flex items-center gap-0.5 text-tiny font-semibold',
                delta.up ? 'text-up' : 'text-down',
              )}>
                {delta.up ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}
                {delta.text}
              </span>
            )}
            {foot && <span className="truncate text-tiny text-ink-400">{foot}</span>}
          </div>
        </div>
      </div>

      {/* 右下角迷你趋势面积图（高 30px） */}
      <div className="pointer-events-none absolute -bottom-0.5 right-0 left-0">
        <Sparkline data={spark || []} tone={(sparkTone || tone) as any} height={30} />
      </div>
    </Card>
  )
}

/** 把一串金额换算成「万」，供指标卡直接使用 */
export const toWan = (v: unknown) => n0(v) / 10000
export { fmtWan }
