import { useEffect, useState } from 'react'
import {
  Settings, HardDrive, Camera, Trash2, Download, FolderOpen,
  CircleCheck, RefreshCw,
} from 'lucide-react'
import { Button, Card, Pill, Empty, Skeleton, IconTile } from '@/components/ui/primitives'
import { useConfirm, useToast } from '@/components/ui/overlay'
import { AiSettingsCard } from '@/components/settings/AiSettingsCard'
import { AppearanceSettingsCard } from '@/components/settings/AppearanceSettingsCard'
import { LicenseCard } from '@/components/settings/LicenseCard'
import { PushSettingsCard } from '@/components/settings/PushSettingsCard'
import { useApp } from '@/app-context'
import { http } from '@/lib/api'
import { cn, fmtSize, fmtInt } from '@/lib/utils'

/**
 * 系统设置。
 *
 * 版面规则（改之前先读，这是踩过的坑）：
 *   外层是 `xl:grid-cols-12` 的栅格，卡片高度天然不一样（授权卡 ~260px，
 *   界面自定义 ~700px）。栅格项默认 `align-items: stretch`，短卡会被强行
 *   拉到和同排最高的一样高 —— 深色下就是一整块空白底，肉眼看到的就是
 *   「设置页留白太多」。所以：
 *     ① 栅格必须带 `items-start`（不拉伸）；
 *     ② 同排的矮卡放进一个 `space-y-4` 的纵向堆叠里（占同一格），
 *        让几张小卡叠起来凑够高度，而不是留一大片空；
 *     ③ 叠的时候要**按实测高度配平**，别只叠一张就不管了。
 *        第一排实测：左「界面自定义」755px，右（授权 257 + 数据在哪 314）只有
 *        587px，底部仍空 168px。把「局域网访问地址」（138px）挪进来变成
 *        587+16+138 = 741px，差 14px —— 这才是真的配平。
 *        （局域网卡在窄列里会随 IP 条数换行，每多一行多 ~40px，所以只求量级
 *         接近，不要为了对齐去写死高度。）
 *    量高度的工具：node tools/ui-theme-audit.js --pages=settings --layout
 */
export default function SettingsPage() {
  const { meta, refreshDash } = useApp()
  const [ds, setDs] = useState<any>(null)
  const [snaps, setSnaps] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const toast = useToast()
  const { confirm, confirmNode } = useConfirm()

  const load = async () => {
    try {
      const [a, b] = await Promise.all([http.dbstatus(), http.snapshots()])
      setDs(a); setSnaps(b)
    } catch (e) { toast((e as Error).message, 'err') }
  }
  useEffect(() => { void load() }, [])

  /* ---- 数据体检 ---- */
  const healthCard = (
    <Card>
      <div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">数据体检</div>
      <div className="px-5 pb-5">
        {!ds ? <Skeleton className="h-64" /> : (
          <>
            <div className="space-y-0.5">
              {Object.entries(ds.counts || {}).map(([k, v]) => (
                <div key={k} className="flex items-center justify-between rounded-tile px-3 py-2 text-body odd:bg-subtle">
                  <span className="text-ink-500">{meta?.tables?.[k]?.label || (k === 'attachments' ? '附件' : k)}</span>
                  <b className="tnum text-ink-900">{fmtInt(v as number)} 条</b>
                </div>
              ))}
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <MiniBox label="数据库体积" value={fmtSize(ds.footprint?.total)} />
              <MiniBox label="写入模式" value={ds.walMode === 'wal' ? 'WAL 已开启' : '未开启 WAL'} ok={ds.walMode === 'wal'} />
              <MiniBox label="运行时长" value={`${Math.floor((ds.uptimeSec || 0) / 60)} 分钟`} />
              <MiniBox label="附件占用" value={fmtSize(ds.attachments?.bytes)} />
            </div>
            <div className="mt-4 flex flex-wrap gap-2.5">
              <Button variant="primary" disabled={busy} onClick={async () => {
                setBusy(true)
                try {
                  const r = await http.backup()
                  toast(`备份完成：${r.file}`, r.degraded ? 'err' : 'ok', r.degraded ? 6000 : 3600)
                  void load()
                }
                catch (e) { toast((e as Error).message, 'err') } finally { setBusy(false) }
              }}><HardDrive size={16} /> 立即备份</Button>
              <span className="self-center text-tiny text-ink-400">自动保留最近 30 份，启动时当天没备份过会自动备一份</span>
            </div>
            {/* 备份格式必须写出来：pg_dump 缺失时会退化成只含数据的 JSON，
                只显示「备份成功」会让人以为索引和约束也保住了。 */}
            {ds.backupFormat?.label && (
              <p className="mt-3 text-tiny leading-relaxed text-ink-400">
                备份格式：<b className={ds.backupFormat.format === 'pg-json' ? 'text-warn' : 'text-ink-600'}>{ds.backupFormat.label}</b>
                {ds.backupFormat.restore && <> · {ds.backupFormat.restore}</>}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  )

  /* ---- 月度快照 ---- */
  const snapshotsCard = (
    <Card>
      <div className="flex items-center gap-3 px-5 pt-5 pb-3">
        <span className="text-cardtitle text-ink-700">月度快照</span>
        <span className="text-tiny text-ink-400">用于「报表统计」查看经营趋势</span>
        <Button size="sm" variant="soft" className="ml-auto" onClick={async () => {
          try { const r = await http.captureSnapshot(); toast(`已记录 ${r.ym} 快照`, 'ok'); void load(); void refreshDash() }
          catch (e) { toast((e as Error).message, 'err') }
        }}><Camera size={14} /> 立即记一份</Button>
      </div>
      <div className="px-5 pb-5">
        {!snaps ? <Skeleton className="h-40" /> : !snaps.rows.length ? (
          <Empty icon={Camera} title="还没有快照"
            hint="系统每月自动记录一份经营数据；账龄和应收都是按今天实时算的，没快照就无法回溯历史" />
        ) : (
          <div className="overflow-hidden rounded-tile bg-subtle">
            <table className="w-full text-tiny">
              <thead><tr className="text-ink-400">
                <th className="px-4 py-2 text-left font-medium">月份</th>
                <th className="py-2 text-left font-medium">来源</th>
                <th className="py-2 text-left font-medium">记录时间</th>
                <th className="w-16 py-2"></th>
              </tr></thead>
              <tbody>
                {snaps.rows.map((s: any) => (
                  <tr key={s.ym} className="bg-surface/70">
                    <td className="px-4 py-2 font-semibold tnum text-ink-900">
                      {s.ym}
                      {s.ym === snaps.currentYm && <span className="ml-2"><Pill tone="blue">当月</Pill></span>}
                    </td>
                    <td className="py-2">
                      <Pill tone={s.kind === 'auto' ? 'gray' : 'green'}>{s.kind === 'auto' ? '自动补记' : '手动'}</Pill>
                    </td>
                    <td className="py-2 tnum text-ink-400">{String(s.captured_at || '').slice(0, 16)}</td>
                    <td className="py-2 pr-2 text-right">
                      <button className="text-ink-400 transition-colors duration-200 hover:text-down"
                        onClick={async () => {
                          const ok = await confirm(`删除 ${s.ym} 的快照？`, '删除后趋势线会少一个点，且无法恢复；业务数据不受影响。', '删除', true)
                          if (!ok) return
                          await http.deleteSnapshot(s.ym); toast('已删除', 'ok'); void load(); void refreshDash()
                        }}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-tiny leading-relaxed text-ink-400">
          最多保留 {snaps?.keepMonths || 60} 个月。服务启动时若发现上个月还没快照，会自动补记一份。
        </p>
      </div>
    </Card>
  )

  /* ---- 数据导出 ---- */
  const exportCard = (
    <Card>
      <div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">数据导出</div>
      <div className="px-5 pb-5">
        <div className="flex flex-wrap gap-2">
          {(meta?.order || []).map(t => (
            <a key={t} className="btn btn-soft !h-9 !px-3.5 text-tiny" href={http.exportUrl(t)}>
              <Download size={14} /> {meta?.tables?.[t]?.label}
            </a>
          ))}
        </div>
        <p className="mt-3 text-tiny text-ink-400">导出为 CSV，用 Excel 或 WPS 直接打开</p>
      </div>
    </Card>
  )

  /* ---- 数据在哪 ---- */
  const whereCard = (
    <Card>
      <div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">数据在哪</div>
      <div className="px-5 pb-5 space-y-3">
        <PathBox label="数据库文件" path={ds?.dbFile || meta?.dbFile} />
        <PathBox label="附件目录" path={meta?.upload?.attachDir} />
        <PathBox label="备份目录" path={ds?.backupDir} />
        <p className="text-tiny leading-relaxed text-ink-400">
          全部数据都在 <code className="rounded bg-subtle-strong px-1.5 py-0.5">pms.db</code> 里，附件在同目录的
          <code className="mx-1 rounded bg-subtle-strong px-1.5 py-0.5">attachments</code> 文件夹。
          <b className="text-ink-600">备份时两者都要拷</b>——用「立即备份」只备份数据库，附件请连文件夹一起复制。
        </p>
      </div>
    </Card>
  )

  /* ---- 局域网访问地址 ---- */
  const lanCard = (
    <Card>
      <div className="px-5 pt-5 pb-3 text-cardtitle text-ink-700">局域网访问地址</div>
      <div className="px-5 pb-5">
        <div className="flex flex-wrap gap-2.5">
          {['127.0.0.1', ...(meta?.lan || [])].filter((v, i, a) => a.indexOf(v) === i).map(ip => (
            <div key={ip} className="flex items-center gap-2 rounded-tile bg-subtle px-3.5 py-2">
              <CircleCheck size={14} className="text-up" />
              <span className="tnum text-body text-ink-700">http://{ip}:{meta?.port}</span>
            </div>
          ))}
        </div>
        <p className="mt-3 text-tiny text-ink-400">
          同事在同一局域网内用上面的地址就能访问，不需要装任何东西。
        </p>
      </div>
    </Card>
  )

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4 px-6 py-5">
        <IconTile icon={Settings} tone="brand" />
        <div>
          <h1 className="text-page text-ink-900">系统设置</h1>
          <p className="mt-1 text-body text-ink-500">界面自定义、数据体检、备份、月度快照与导出</p>
        </div>
        <Button variant="soft" className="ml-auto" onClick={load}><RefreshCw size={15} /> 刷新</Button>
      </Card>

      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
        {/* 界面自定义（公司名 / 系统名 / 欢迎语）—— 放最前，换品牌第一眼就看到 */}
        <AppearanceSettingsCard />

        {/* 授权 + 数据在哪 + 局域网访问地址：三张矮卡叠成一列，配平左侧「界面自定义」 */}
        <div className="space-y-4 xl:col-span-5">
          <LicenseCard />
          {whereCard}
          {lanCard}
        </div>

        {/* 智能助手 */}
        <AiSettingsCard />

        {/* 数据体检（左）+ 月度快照 / 简报推送 / 数据导出（右） */}
        <div className="xl:col-span-5">{healthCard}</div>
        <div className="space-y-4 xl:col-span-7">
          {snapshotsCard}
          <PushSettingsCard />
          {exportCard}
        </div>
      </div>
      {confirmNode}
    </div>
  )
}

function MiniBox({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="rounded-tile bg-subtle px-3.5 py-2.5">
      <div className="text-[11px] text-ink-400">{label}</div>
      <div className={cn('mt-0.5 text-body font-semibold', ok === false ? 'text-down' : 'text-ink-900')}>{value}</div>
    </div>
  )
}

function PathBox({ label, path }: { label: string; path?: string }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] text-ink-400">
        <FolderOpen size={12} /> {label}
      </div>
      <div className="break-all rounded-tile bg-subtle px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-600">
        {path || '—'}
      </div>
    </div>
  )
}
