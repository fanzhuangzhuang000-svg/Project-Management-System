import { useEffect, useState } from 'react'
import { KeyRound, Save, CircleCheck, CircleAlert, Trash2, Users } from 'lucide-react'
import { Button, Card, IconTile, Input, Pill } from '@/components/ui/primitives'
import { useToast } from '@/components/ui/overlay'
import { useApp } from '@/app-context'
import { http, type LicenseInfo } from '@/lib/api'

const TONE: Record<string, 'green' | 'orange' | 'red' | 'gray'> = {
  ok: 'green', warn: 'orange', expired: 'red', invalid: 'red', none: 'gray',
}
const LABEL: Record<string, string> = {
  ok: '已授权', warn: '即将到期', expired: '已过期（只读）', invalid: '授权码无效', none: '未填写授权码',
}

export function LicenseCard () {
  const { license, refreshLicense } = useApp()
  const toast = useToast()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState<LicenseInfo | null>(license)

  useEffect(() => { setInfo(license) }, [license])

  const save = async () => {
    const v = code.trim()
    if (!v) { toast('请先粘贴授权码', 'err'); return }
    setBusy(true)
    try {
      const r = await http.saveSettings({ license_key: v })
      // 保存后后端会回带最新状态，直接用它，免得再请求一次
      if (r.license) setInfo(r.license)
      await refreshLicense()
      if (r.license?.status === 'invalid') toast(r.license.error || '这个授权码无效，请核对后重试', 'err')
      else if (r.license?.status === 'expired') toast('授权码已过期，请联系续费', 'err')
      else toast('授权成功', 'ok')
      setCode('')
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally { setBusy(false) }
  }

  const clear = async () => {
    setBusy(true)
    try {
      const r = await http.saveSettings({ license_key: '' })
      if (r.license) setInfo(r.license)
      await refreshLicense()
      toast('已清除授权码', 'ok')
    } catch (e) {
      toast((e as Error).message, 'err')
    } finally { setBusy(false) }
  }

  const st = info?.status || 'none'

  return (
    <Card className="xl:col-span-5">
      <div className="flex flex-wrap items-center gap-3 px-5 pt-5 pb-3">
        <IconTile icon={KeyRound} tone={st === 'ok' ? 'green' : st === 'expired' || st === 'invalid' ? 'warm' : 'cyan'} size="md" />
        <div className="min-w-0 flex-1">
          <div className="text-cardtitle text-ink-900">授权</div>
          <div className="text-tiny text-ink-400">填入授权码以激活。到期后转为只读，数据不会丢</div>
        </div>
        <Pill tone={TONE[st] || 'gray'} dot={st === 'ok'}>{LABEL[st] || st}</Pill>
      </div>

      <div className="space-y-3.5 px-5 pb-5">
        {st !== 'none' && (
          <div className="space-y-1 rounded-tile bg-slate-50 px-3.5 py-3">
            {info?.company && (
              <div className="flex gap-2 text-tiny">
                <span className="w-[64px] flex-none text-ink-400">授权给</span>
                <span className="font-medium text-ink-800">{info.company}</span>
              </div>
            )}
            {info?.expiry && (
              <div className="flex gap-2 text-tiny">
                <span className="w-[64px] flex-none text-ink-400">到期日</span>
                <span className="font-medium text-ink-800">
                  {info.expiry}
                  {typeof info.daysLeft === 'number' && (
                    <span className={info.daysLeft < 0 ? ' text-red-600' : info.daysLeft <= (info.warnDays || 30) ? ' text-orange-600' : ' text-ink-400'}>
                      {' '}（{info.daysLeft < 0 ? `已过期 ${-info.daysLeft} 天` : `还有 ${info.daysLeft} 天`}）
                    </span>
                  )}
                </span>
              </div>
            )}
            {!!info?.seats && (
              <div className="flex gap-2 text-tiny">
                <span className="w-[64px] flex-none text-ink-400">账号数</span>
                <span className="font-medium text-ink-800">
                  <Users size={11} className="mr-1 inline-block align-[-1px]" />
                  {info.seats} 个
                  {typeof info.usedSeats === 'number' && (
                    <span className={info.seatsExceeded ? ' font-medium text-orange-600' : ' text-ink-400'}>
                      {' '}（已用 {info.usedSeats} 个{info.seatsExceeded ? '，已达上限' : ''}）
                    </span>
                  )}
                </span>
              </div>
            )}
            {info?.error && <div className="text-tiny text-red-600">{info.error}</div>}
          </div>
        )}

        {st === 'expired' && (
          <div className="flex items-start gap-2 rounded-tile bg-red-50 px-3.5 py-3 text-tiny text-red-700">
            <CircleAlert size={14} className="mt-0.5 flex-none" />
            <span>
              授权已到期，现在是<b>只读模式</b>：数据都还在，可以查看和导出，但不能再录入。
              把新的授权码粘贴到下面保存即可恢复。
            </span>
          </div>
        )}

        {info?.seatsExceeded && (
          <div className="flex items-start gap-2 rounded-tile bg-orange-50 px-3.5 py-3 text-tiny text-orange-700">
            <CircleAlert size={14} className="mt-0.5 flex-none" />
            <span>
              已启用 <b>{info.usedSeats}</b> 个账号，达到授权上限 <b>{info.seats}</b> 个，
              暂时不能新建账号。<b>已有账号可以照常使用</b>；需要增加请联系软件提供方升级授权。
            </span>
          </div>
        )}

        <label className="block">
          <span className="mb-1 block text-tiny font-medium text-ink-600">授权码</span>
          <Input value={code} onChange={e => setCode(e.target.value)}
            placeholder="ELV3.xxxxxxxx.xxxxxxxx" className="!h-10 font-mono text-tiny" />
        </label>

        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="primary" onClick={save} disabled={busy || !code.trim()}>
            {st === 'ok' ? <Save size={14} /> : <CircleCheck size={14} />} {busy ? '校验中…' : '保存授权码'}
          </Button>
          {st !== 'none' && (
            <Button size="sm" variant="soft" onClick={clear} disabled={busy}>
              <Trash2 size={14} /> 清除
            </Button>
          )}
        </div>

        <p className="text-tiny leading-relaxed text-ink-400">
          授权码由软件提供方生成，绑定<b>公司名</b>、<b>到期日期</b>和<b>账号数上限</b>。
          它是离线校验的，不需要联网 —— 所以在没有外网的工地上也能正常用。
        </p>
      </div>
    </Card>
  )
}
