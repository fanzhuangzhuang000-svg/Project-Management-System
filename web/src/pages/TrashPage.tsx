import { useEffect, useState } from 'react'
import { Trash2, RotateCcw, AlertTriangle, Flame } from 'lucide-react'
import { Button, Card, Pill, Empty, Skeleton, IconTile } from '@/components/ui/primitives'
import { useConfirm, useToast } from '@/components/ui/overlay'
import { useApp } from '@/app-context'
import { http } from '@/lib/api'
import { cn } from '@/lib/utils'

export default function TrashPage() {
  const [data, setData] = useState<{ rows: any[]; stats: any } | null>(null)
  const { refreshDash, meta } = useApp()
  const toast = useToast()
  const { confirm, confirmNode } = useConfirm()

  const load = async () => {
    try { setData(await http.trash()) } catch (e) { toast((e as Error).message, 'err'); setData({ rows: [], stats: {} }) }
  }
  useEffect(() => { void load() }, [])

  const label = (t: string) => meta?.tables?.[t]?.label || (t === 'attachments' ? '附件' : t)

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4 px-6 py-5">
        <IconTile icon={Trash2} tone="warm" />
        <div>
          <h1 className="text-page text-ink-900">回收站</h1>
          <p className="mt-1 text-body text-ink-500">
            删除的记录在这里保留 {meta?.trashKeepDays || 30} 天，随时可以还原
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          {!!data?.stats?.entries && (
            <Button variant="danger" onClick={async () => {
              const ok = await confirm('清空回收站？', '所有记录将被彻底删除，无法恢复。附件文件也会一起删掉。', '彻底删除', true)
              if (!ok) return
              try { const r = await http.purgeAll(); toast(`已彻底删除 ${r.purged} 项`, 'ok'); void load(); void refreshDash() }
              catch (e) { toast((e as Error).message, 'err') }
            }}><Flame size={15} /> 清空回收站</Button>
          )}
        </div>
      </Card>

      {data?.stats && (
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          <Stat label="回收站条目" value={data.stats.entries || 0} unit="项" />
          <Stat label="包含记录" value={data.stats.rows || 0} unit="条" />
          <Stat label="占用空间" value={(data.stats.bytes / 1024 / 1024).toFixed(1)} unit="MB" />
          <Stat label="保留天数" value={meta?.trashKeepDays || 30} unit="天" />
        </div>
      )}

      <Card>
        {!data ? (
          <div className="space-y-2 p-5">{[0, 1, 2].map(i => <Skeleton key={i} className="h-12" />)}</div>
        ) : !data.rows.length ? (
          <Empty icon={Trash2} title="回收站是空的" hint="删除的记录会出现在这里" />
        ) : (
          <div className="overflow-x-auto p-2">
            <table className="tbl min-w-full">
              <thead><tr><th>删除时间</th><th>类型</th><th>内容</th><th>记录数</th><th>操作人</th><th className="text-right">操作</th></tr></thead>
              <tbody>
                {data.rows.map(r => (
                  <tr key={r.id}>
                    <td className="tnum whitespace-nowrap text-tiny text-ink-400">{String(r.deleted_at || '').slice(0, 16)}</td>
                    <td><Pill tone="purple">{label(r.table_name)}</Pill></td>
                    <td className="max-w-[280px] truncate text-ink-900" title={r.label}>{r.label || '—'}</td>
                    <td className="tnum text-ink-500">{r.row_count}</td>
                    <td className="text-ink-500">{r.operator || '—'}</td>
                    <td>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button size="sm" variant="soft" onClick={async () => {
                          try { const x = await http.restore(r.id); toast(`已还原 ${x.restored} 条`, 'ok'); void load(); void refreshDash() }
                          catch (e) { toast((e as Error).message, 'err') }
                        }}><RotateCcw size={14} /> 还原</Button>
                        <Button size="sm" variant="danger" onClick={async () => {
                          const ok = await confirm('彻底删除？', '这条记录将无法恢复，附件文件也会一起删掉。', '彻底删除', true)
                          if (!ok) return
                          try { await http.purge(r.id); toast('已彻底删除', 'ok'); void load() }
                          catch (e) { toast((e as Error).message, 'err') }
                        }}><Trash2 size={14} /></Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {confirmNode}
    </div>
  )
}

function Stat({ label, value, unit }: { label: string; value: any; unit: string }) {
  return (
    <Card hover className="px-5 py-4">
      <div className="text-tiny text-ink-400">{label}</div>
      <div className="mt-1 flex items-baseline gap-1">
        <span className="text-[24px] font-extrabold tnum leading-none text-ink-900">{value}</span>
        <span className="text-tiny text-ink-400">{unit}</span>
      </div>
    </Card>
  )
}
