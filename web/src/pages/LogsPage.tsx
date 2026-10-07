import { useEffect, useState } from 'react'
import { History, Search, Trash2, RefreshCw } from 'lucide-react'
import { Button, Card, Input, Pill, Empty, Skeleton, Select } from '@/components/ui/primitives'
import { useConfirm, useToast } from '@/components/ui/overlay'
import { http } from '@/lib/api'
import { fmtInt } from '@/lib/utils'

const ACTION_TONE: Record<string, 'blue' | 'green' | 'red' | 'orange' | 'gray' | 'purple' | 'cyan'> = {
  create: 'green', update: 'blue', delete: 'red', batch_delete: 'red',
  restore: 'cyan', purge: 'gray', import: 'purple', backup: 'gray',
  login: 'gray', logout: 'gray',
}
const ACTION_LABEL: Record<string, string> = {
  create: '新增', update: '修改', delete: '删除', batch_delete: '批量删除',
  restore: '还原', purge: '彻底删除', import: '导入', backup: '备份',
  login: '登录', logout: '退出',
}

export default function LogsPage() {
  const [rows, setRows] = useState<any[] | null>(null)
  const [total, setTotal] = useState(0)
  const [q, setQ] = useState('')
  const [action, setAction] = useState('')
  const [stats, setStats] = useState<any>(null)
  const toast = useToast()
  const { confirm, confirmNode } = useConfirm()

  const load = async () => {
    try {
      const r = await http.logs({ q, action, limit: 100 })
      setRows(r.rows); setTotal(r.total); setStats(r.stats)
    } catch (e) { toast((e as Error).message, 'err'); setRows([]) }
  }
  useEffect(() => { const t = setTimeout(load, 240); return () => clearTimeout(t) }, [q, action])

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-3 px-6 py-5">
        <div>
          <h1 className="text-page text-ink-900">操作日志</h1>
          <p className="mt-1 text-body text-ink-500">
            谁在什么时候新增、修改、删除了什么，全部留痕
            {stats && <span className="ml-1 text-ink-400">（共 {fmtInt(stats.total)} 条）</span>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2.5">
          <Button variant="soft" onClick={load}><RefreshCw size={15} /> 刷新</Button>
          <Button variant="danger" onClick={async () => {
            const ok = await confirm('清理旧日志？', '将删除 365 天以前的日志记录，不可恢复。', '清理', true)
            if (!ok) return
            try { const r = await http.purgeLogs(365); toast(`已清理 ${r.purged} 条`, 'ok'); void load() }
            catch (e) { toast((e as Error).message, 'err') }
          }}><Trash2 size={15} /> 清理旧日志</Button>
        </div>
      </Card>

      <Card>
        <div className="flex flex-wrap items-center gap-2.5 px-5 pt-5 pb-3">
          <div className="relative w-[260px]">
            <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-400" />
            <Input value={q} onChange={e => setQ(e.target.value)} placeholder="搜索操作人、内容…" className="!h-9 !pl-9 text-tiny" />
          </div>
          <Select value={action} onChange={e => setAction(e.target.value)} className="!h-9 w-auto min-w-[130px] text-tiny">
            <option value="">全部操作类型</option>
            {Object.entries(ACTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </Select>
          <span className="ml-auto text-tiny text-ink-400">显示最近 {rows?.length || 0} 条 / 共 {total} 条</span>
        </div>

        {rows === null ? (
          <div className="space-y-2 px-5 pb-5">{[0, 1, 2, 3, 4, 5].map(i => <Skeleton key={i} className="h-11" />)}</div>
        ) : !rows.length ? (
          <Empty icon={History} title="没有日志记录" />
        ) : (
          <div className="overflow-x-auto px-2 pb-4">
            <table className="tbl min-w-full">
              <thead><tr><th>时间</th><th>操作人</th><th>操作</th><th>对象</th><th>说明</th></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td className="tnum whitespace-nowrap text-tiny text-ink-400">{String(r.at || '').slice(0, 16)}</td>
                    <td className="whitespace-nowrap font-medium text-ink-900">{r.operator || '—'}</td>
                    <td><Pill tone={ACTION_TONE[r.action] || 'gray'} dot>{ACTION_LABEL[r.action] || r.action}</Pill></td>
                    <td className="text-ink-500">{r.table_name || '—'}</td>
                    <td className="text-ink-500">{r.summary || r.label || ''}</td>
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
