import { useState } from 'react'
import { Link } from 'react-router-dom'
import { CircleAlert, X, KeyRound } from 'lucide-react'
import { useApp } from '@/app-context'
import { cn } from '@/lib/utils'

/**
 * 授权到期提醒条。
 *
 * - 到期前 30 天：橙色，可关掉（这个会话内不再出现）
 * - 已过期：红色，不可关（现在是只读，得让人一直看得见）
 * - 正常/未填：什么都不渲染
 */
export function LicenseBanner () {
  const { license } = useApp()
  const [dismissed, setDismissed] = useState(false)

  if (!license) return null
  const st = license.status
  if (st !== 'warn' && st !== 'expired') return null
  if (st === 'warn' && dismissed) return null

  const expired = st === 'expired'
  const days = license.daysLeft

  return (
    <div className={cn('flex flex-wrap items-center gap-2 rounded-card px-4 py-2.5 text-tiny',
      expired ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-800')}>
      <CircleAlert size={15} className="flex-none" />
      <span className="min-w-0 flex-1">
        {expired ? (
          <>
            <b>授权已到期，现在是只读模式。</b>
            数据都在，可以查看和导出，但不能再录入 —— 填入新的授权码即可恢复。
          </>
        ) : (
          <>
            <b>授权即将到期</b>
            {typeof days === 'number' && <>（还有 {days} 天，{license.expiry} 到期）</>}
            ，请联系续费，以免到期后无法继续录入。
          </>
        )}
      </span>
      <Link to="/settings"
        className={cn('flex flex-none items-center gap-1 rounded-full bg-surface/70 px-2.5 py-1 font-medium transition-colors duration-200',
          expired ? 'text-red-700 hover:bg-surface' : 'text-amber-800 hover:bg-surface')}>
        <KeyRound size={12} /> 去填授权码
      </Link>
      {!expired && (
        <button onClick={() => setDismissed(true)} title="本次登录不再提醒"
          className="flex-none text-amber-700 transition-colors duration-200 hover:text-amber-900">
          <X size={14} />
        </button>
      )}
    </div>
  )
}
