import * as React from 'react'
import { cn } from '@/lib/utils'
import type { LucideIcon } from 'lucide-react'

/* ============================ 卡片 ============================ */
export const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { hover?: boolean; glass?: boolean }>(
  ({ className, hover, glass, ...props }, ref) => (
    <div ref={ref} className={cn(glass ? 'card-glass' : 'card', hover && 'card-hover', className)} {...props} />
  ),
)
Card.displayName = 'Card'

export function CardHeader({ className, children, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex items-center gap-3 px-5 pt-5 pb-3', className)} {...props}>{children}</div>
}

export function CardTitle({ className, children, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn('text-cardtitle text-ink-700', className)} {...props}>{children}</h3>
}

export function CardBody({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('px-5 pb-5', className)} {...props} />
}

/** 卡片右上角的轻量操作区（下拉、链接、切换） */
export function CardAction({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('ml-auto flex items-center gap-2', className)} {...props} />
}

/* ============================ 按钮 ============================ */
type BtnVariant = 'primary' | 'ghost' | 'soft' | 'plain' | 'danger'
type BtnSize = 'sm' | 'md' | 'lg' | 'icon'

const BTN_VARIANT: Record<BtnVariant, string> = {
  primary: 'btn-primary',
  ghost: 'btn-ghost',
  soft: 'btn-soft',
  plain: 'text-ink-500 hover:text-ink-900 hover:bg-slate-100/70',
  // 危险操作走柔和红底，避免生硬描边
  danger: 'bg-red-50 text-down hover:bg-red-100',
}
const BTN_SIZE: Record<BtnSize, string> = {
  sm: 'h-8 px-3 text-tiny rounded-[10px]',
  md: 'h-10 px-4',
  lg: 'h-11 px-5',
  icon: 'h-10 w-10 p-0',
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: BtnVariant
  size?: BtnSize
}
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'ghost', size = 'md', ...props }, ref) => (
    <button ref={ref} className={cn('btn', BTN_VARIANT[variant], BTN_SIZE[size], className)} {...props} />
  ),
)
Button.displayName = 'Button'

/* ============================ 图标底块（44×44 圆角方形） ============================ */
export type TileTone = 'brand' | 'purple' | 'warm' | 'cyan' | 'green'
const TILE_TONE: Record<TileTone, string> = {
  brand: 'grad-brand',
  purple: 'grad-purple',
  warm: 'grad-warm',
  cyan: 'grad-cyan',
  green: 'grad-green',
}
const TILE_SHADOW: Record<TileTone, string> = {
  brand: '0 8px 20px rgba(59,130,246,.28)',
  purple: '0 8px 20px rgba(139,92,246,.28)',
  warm: '0 8px 20px rgba(249,115,22,.28)',
  cyan: '0 8px 20px rgba(6,182,212,.28)',
  green: '0 8px 20px rgba(16,185,129,.28)',
}

export function IconTile({
  icon: Icon, tone = 'brand', size = 'md', className,
}: { icon: LucideIcon; tone?: TileTone; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const dim = size === 'sm' ? 'h-9 w-9' : size === 'lg' ? 'h-12 w-12' : 'h-11 w-11'
  const ico = size === 'sm' ? 17 : size === 'lg' ? 23 : 20
  return (
    <span className={cn('icon-tile', TILE_TONE[tone], dim, className)} style={{ boxShadow: TILE_SHADOW[tone] }}>
      <Icon size={ico} strokeWidth={2.1} />
    </span>
  )
}

/* ============================ 胶囊标签 ============================ */
export type PillTone = 'blue' | 'purple' | 'orange' | 'green' | 'red' | 'gray' | 'cyan'
const PILL_TONE: Record<PillTone, string> = {
  blue: 'bg-blue-50 text-blue-600',
  purple: 'bg-violet-50 text-violet-600',
  orange: 'bg-orange-50 text-orange-600',
  green: 'bg-emerald-50 text-emerald-600',
  red: 'bg-red-50 text-red-500',
  cyan: 'bg-cyan-50 text-cyan-600',
  gray: 'bg-slate-100 text-ink-500',
}
export function Pill({ tone = 'gray', className, children, dot }: { tone?: PillTone; className?: string; children: React.ReactNode; dot?: boolean }) {
  return (
    <span className={cn('pill', PILL_TONE[tone], className)}>
      {dot && <i className={cn('h-1.5 w-1.5 rounded-full', {
        blue: 'bg-blue-500', purple: 'bg-violet-500', orange: 'bg-orange-500',
        green: 'bg-emerald-500', red: 'bg-red-500', cyan: 'bg-cyan-500', gray: 'bg-slate-400',
      }[tone])} />}
      {children}
    </span>
  )
}

/* ============================ 头像 ============================ */
const AV_GRAD = [
  'from-blue-500 to-indigo-500', 'from-violet-500 to-purple-500',
  'from-cyan-500 to-sky-500', 'from-emerald-500 to-teal-500',
  'from-orange-500 to-amber-500', 'from-rose-500 to-pink-500',
]
export function Avatar({
  name, size = 36, src, online, className, seed,
}: { name?: string | null; size?: number; src?: string; online?: boolean; className?: string; seed?: string }) {
  const s = String(name || '').trim()
  const text = !s ? '—' : /^[A-Za-z]/.test(s) ? s.slice(0, 2).toUpperCase() : (s.length <= 2 ? s : s.slice(-2))
  let h = 0
  const key = seed || s
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 997
  return (
    <span className={cn('relative inline-flex flex-none', className)} style={{ width: size, height: size }}>
      {src
        ? <img src={src} alt={s} className="h-full w-full rounded-full object-cover" />
        : (
          <span
            className={cn('flex h-full w-full items-center justify-center rounded-full bg-gradient-to-br font-semibold text-white', AV_GRAD[h % AV_GRAD.length])}
            style={{ fontSize: Math.max(10, Math.round(size * 0.34)) }}
          >
            {text}
          </span>
        )}
      {online && (
        <span className="absolute -bottom-0 -right-0 h-3 w-3 rounded-full border-2 border-white bg-emerald-500" />
      )}
    </span>
  )
}

export function AvatarGroup({ names, max = 3, size = 28 }: { names: (string | null | undefined)[]; max?: number; size?: number }) {
  const list = names.filter(Boolean) as string[]
  const shown = list.slice(0, max)
  const rest = list.length - shown.length
  return (
    <span className="flex items-center">
      {shown.map((n, i) => (
        <span key={i} style={{ marginLeft: i ? -8 : 0 }}>
          <Avatar name={n} size={size} className="ring-2 ring-white" />
        </span>
      ))}
      {rest > 0 && (
        <span
          className="flex items-center justify-center rounded-full bg-slate-100 font-medium text-ink-500 ring-2 ring-white"
          style={{ width: size, height: size, marginLeft: -8, fontSize: Math.round(size * 0.32) }}
        >
          +{rest}
        </span>
      )}
    </span>
  )
}

/* ============================ 进度条 ============================ */
export function Progress({ value, className, tone = 'brand', size = 6 }: { value: number; className?: string; tone?: TileTone | 'plain'; size?: number }) {
  const v = Math.max(0, Math.min(100, Number(value) || 0))
  const bg = tone === 'plain' ? 'bg-slate-200' : TILE_TONE[tone]
  return (
    <span className={cn('block w-full overflow-hidden rounded-full bg-slate-100', className)} style={{ height: size }}>
      <span
        className={cn('block h-full rounded-full transition-all duration-200 ease-out', bg)}
        style={{ width: `${v}%` }}
      />
    </span>
  )
}

/* ============================ 表单控件 ============================ */
export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn('h-10 w-full rounded-tile px-3.5 text-body', className)} {...props} />
  ),
)
Input.displayName = 'Input'

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn('w-full rounded-tile px-3.5 py-2.5 text-body', className)} {...props} />
  ),
)
Textarea.displayName = 'Textarea'

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn('h-10 w-full cursor-pointer appearance-none rounded-tile px-3.5 pr-9 text-body', className)}
      style={{
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2.5' stroke-linecap='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E\")",
        backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center',
      }}
      {...props}
    >
      {children}
    </select>
  ),
)
Select.displayName = 'Select'

export function Field({ label, className, children, hint }: { label: string; className?: string; children: React.ReactNode; hint?: string }) {
  return (
    <label className={cn('block', className)}>
      <span className="mb-1.5 block text-tiny font-medium text-ink-500">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-tiny text-ink-400">{hint}</span>}
    </label>
  )
}

/* ============================ 骨架屏 ============================ */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton', className)} />
}

/* ============================ 空状态 ============================ */
export function Empty({ icon: Icon, title, hint, className }: { icon?: LucideIcon; title: string; hint?: string; className?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-2 py-12 text-center', className)}>
      {Icon && (
        <span className="mb-1 flex h-12 w-12 items-center justify-center rounded-tile bg-slate-100 text-ink-400">
          <Icon size={22} />
        </span>
      )}
      <p className="text-body font-medium text-ink-500">{title}</p>
      {hint && <p className="max-w-sm text-tiny text-ink-400">{hint}</p>}
    </div>
  )
}
