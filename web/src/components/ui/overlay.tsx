import * as React from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from './primitives'

/* ============================ 模态框 ============================ */
export function Modal({
  open, onClose, title, children, footer, width = 'md', className,
}: {
  open: boolean
  onClose: () => void
  title?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  width?: 'sm' | 'md' | 'lg' | 'xl'
  className?: string
}) {
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [open, onClose])

  if (!open) return null
  const W = { sm: 'max-w-[460px]', md: 'max-w-[620px]', lg: 'max-w-[820px]', xl: 'max-w-[1040px]' }[width]

  return createPortal(
    <div
      className="fixed inset-0 z-[600] flex items-start justify-center overflow-y-auto p-6"
      style={{ background: 'rgba(15,23,42,.32)', backdropFilter: 'blur(6px)' }}
      onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className={cn('my-auto w-full animate-float-in rounded-card bg-white shadow-pop', W, className)}
        onMouseDown={e => e.stopPropagation()}
      >
        {title !== undefined && (
          <div className="flex items-center gap-3 px-6 pb-4 pt-6">
            <h3 className="text-[16px] font-bold text-ink-900">{title}</h3>
            <button
              onClick={onClose}
              className="ml-auto flex h-9 w-9 items-center justify-center rounded-tile text-ink-400 transition-colors duration-200 hover:bg-slate-100 hover:text-ink-700"
              aria-label="关闭"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="max-h-[70vh] overflow-y-auto px-6 pb-2">{children}</div>
        {footer && <div className="flex items-center justify-end gap-3 px-6 pb-6 pt-4">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}

/* ============================ 确认框 ============================ */
export function useConfirm() {
  const [state, setState] = React.useState<{
    open: boolean; title: string; body?: React.ReactNode; okText: string
    resolve?: (v: boolean) => void; danger?: boolean
  }>({ open: false, title: '', okText: '确认' })

  const confirm = React.useCallback((title: string, body?: React.ReactNode, okText = '确认', danger = false) =>
    new Promise<boolean>(resolve => setState({ open: true, title, body, okText, resolve, danger })), [])

  const close = (v: boolean) => { state.resolve?.(v); setState(s => ({ ...s, open: false })) }

  const node = (
    <Modal
      open={state.open}
      onClose={() => close(false)}
      title={state.title}
      width="sm"
      footer={<>
        <Button variant="ghost" onClick={() => close(false)}>取消</Button>
        <Button variant={state.danger ? 'danger' : 'primary'} onClick={() => close(true)}>{state.okText}</Button>
      </>}
    >
      <div className="pb-2 text-body text-ink-500">{state.body}</div>
    </Modal>
  )
  return { confirm, confirmNode: node }
}

/* ============================ 轻提示 ============================ */
type ToastKind = 'ok' | 'err' | 'warn' | 'info'
interface ToastItem { id: number; kind: ToastKind; text: string }

const ToastCtx = React.createContext<(text: string, kind?: ToastKind, ms?: number) => void>(() => {})
export const useToast = () => React.useContext(ToastCtx)

const KIND_STYLE: Record<ToastKind, string> = {
  ok: 'bg-emerald-50 text-emerald-700',
  err: 'bg-red-50 text-red-600',
  warn: 'bg-amber-50 text-amber-700',
  info: 'bg-blue-50 text-blue-700',
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = React.useState<ToastItem[]>([])
  const idRef = React.useRef(0)

  const push = React.useCallback((text: string, kind: ToastKind = 'ok', ms = 2600) => {
    const id = ++idRef.current
    setItems(list => [...list, { id, kind, text }])
    window.setTimeout(() => setItems(list => list.filter(t => t.id !== id)), ms)
  }, [])

  return (
    <ToastCtx.Provider value={push}>
      {children}
      {createPortal(
        <div className="pointer-events-none fixed left-1/2 top-6 z-[900] flex -translate-x-1/2 flex-col items-center gap-2">
          {items.map(t => (
            <div
              key={t.id}
              className={cn(
                'animate-float-in rounded-tile px-4 py-2.5 text-body font-medium shadow-pop',
                KIND_STYLE[t.kind],
              )}
            >
              {t.text}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastCtx.Provider>
  )
}
