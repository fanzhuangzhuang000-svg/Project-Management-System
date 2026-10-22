import { CircleAlert } from 'lucide-react'
import { useApp } from '@/app-context'

/**
 * 数据库结构升级失败提醒条。
 *
 * 背景：升级前会自动备份一次，备份文件名曾经被写死成 `pre-upgrade--.db`，
 * 第二次升级时 SQLite 的 VACUUM INTO 报「文件已存在」→ 备份算失败 → 迁移中止。
 * 而服务照常启动、控制台只留一行 console.error —— 用户的库就这么停在旧结构上，
 * 录入时缺字段也不明所以。这条横幅就是让那件事无法被忽略。
 *
 * 正常情况下（error 为空）什么都不渲染。
 */
export function DbMigrationBanner () {
  const { dbMigration } = useApp()
  if (!dbMigration?.error) return null

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-card bg-red-50 px-4 py-2.5 text-tiny text-red-700">
      <CircleAlert size={15} className="flex-none" />
      <span className="min-w-0 flex-1">
        <b>数据库结构没能升级到最新版本。</b>
        当前停在 v{dbMigration.version}，部分新功能可能取不到字段。
        原因：{dbMigration.error}
        {dbMigration.backup && <>（升级前的备份在 <code>{dbMigration.backup}</code>）</>}
        。请先关掉系统，把 data 目录整份复制一份留底，再重新启动；仍失败请把这段原因发给技术支持。
      </span>
    </div>
  )
}
