import { useId } from 'react'
import { cn } from '@/lib/utils'

/** 环形进度条（侧栏底部卡片、报表页复用） */
export function RingProgress({
  value, size = 64, stroke = 7, gradient = ['#60A5FA', '#818CF8'], track = 'rgba(255,255,255,.16)',
  showText = true, textClass = 'text-white',
}: {
  value: number
  size?: number
  stroke?: number
  gradient?: [string, string] | string[]
  track?: string
  showText?: boolean
  textClass?: string
}) {
  const gid = useId().replace(/[:]/g, '')
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const dash = (c * v) / 100

  return (
    <span className="relative inline-flex flex-none items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <defs>
          <linearGradient id={`ring-${gid}`} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={gradient[0]} />
            <stop offset="100%" stopColor={gradient[1]} />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none"
          stroke={`url(#ring-${gid})`} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${dash} ${c - dash}`}
          style={{ transition: 'stroke-dasharray 320ms cubic-bezier(0,0,.2,1)' }}
        />
      </svg>
      {showText && (
        <span className={cn('absolute inset-0 flex items-center justify-center font-bold tnum', textClass)}
          style={{ fontSize: Math.max(11, Math.round(size * 0.26)) }}>
          {Math.round(v)}%
        </span>
      )}
    </span>
  )
}
