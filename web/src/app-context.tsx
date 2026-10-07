import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { http, setUnauthorizedHandler, type AppSettings, type Dashboard, type LicenseInfo, type Meta, type User } from '@/lib/api'

interface AppState {
  user: User | null
  meta: Meta | null
  dash: Dashboard | null
  loading: boolean
  /** 重新拉总览（写操作后调用） */
  refreshDash: () => Promise<void>
  /** 重新拉元数据（表结构 / 下拉选项变了之后） */
  refreshMeta: () => Promise<void>
  /** 后端返回 401 时由 api() 触发 */
  setUser: (u: User | null) => void
  needLogin: boolean
  firstRun: boolean
  trashCount: number
  setTrashCount: (n: number) => void
  /** 系统设置（欢迎语、公司名、系统名称） */
  settings: AppSettings | null
  refreshSettings: () => Promise<void>
  /** 授权状态（离线校验） */
  license: LicenseInfo | null
  refreshLicense: () => Promise<void>
}

/** 后端拿不到设置时的兜底，和后端 DEFAULT_SETTINGS 保持一致 */
export const DEFAULT_SETTINGS: AppSettings = {
  company_name: '项目团队',
  system_name: '弱电智能化工程项目管理系统',
  welcome_morning: '上午好，{公司名} 👋',
  welcome_afternoon: '下午好，{公司名} ☕',
  welcome_evening: '晚上好，{公司名} 🌙',
  welcome_subtitle: '以下是您团队今日的工作概览',
  license_key: '',
}

const Ctx = createContext<AppState>(null as any)
export const useApp = () => useContext(Ctx)

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [dash, setDash] = useState<Dashboard | null>(null)
  const [loading, setLoading] = useState(true)
  const [needLogin, setNeedLogin] = useState(false)
  const [firstRun, setFirstRun] = useState(false)
  const [trashCount, setTrashCount] = useState(0)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [license, setLicense] = useState<LicenseInfo | null>(null)
  const booted = useRef(false)

  const refreshDash = useCallback(async () => {
    try { setDash(await http.dashboard()) } catch { /* 无权限时忽略 */ }
  }, [])
  const refreshMeta = useCallback(async () => {
    try { setMeta(await http.meta()) } catch { /* 忽略 */ }
  }, [])
  const refreshSettings = useCallback(async () => {
    try {
      const r = await http.settings()
      setSettings(r.settings)
      if (r.license) setLicense(r.license)
    } catch { /* 无权限/未登录时忽略 */ }
  }, [])
  const refreshLicense = useCallback(async () => {
    try { setLicense((await http.settings()).license) } catch { /* 忽略 */ }
  }, [])

  /**
   * 设置当前用户。登录成功时顺手清掉 needLogin ——
   * 否则启动时那次 /api/me 的 401 会把 needLogin 一直留在 true，
   * 登录成功后仍然停在登录页。
   */
  const applyUser = useCallback((u: User | null) => {
    setUser(u)
    if (u) setNeedLogin(false)
  }, [])

  const boot = useCallback(async () => {
    try {
      const me = await http.me()
      setUser(me.user)
      setNeedLogin(false)
      if (me.settings) setSettings(me.settings)
      if (me.license) setLicense(me.license)
      await Promise.all([refreshMeta(), refreshDash()])
    } catch (e: any) {
      setNeedLogin(true)
      setFirstRun(!!e?.data?.firstRun)
      // 未登录时后端也会回品牌信息，登录页才能显示正确的系统名
      if (e?.data?.settings) setSettings({ ...DEFAULT_SETTINGS, ...e.data.settings })
      setUser(null)
    } finally {
      setLoading(false)
    }
  }, [refreshMeta, refreshDash])

  useEffect(() => {
    setUnauthorizedHandler(() => { setUser(null); setNeedLogin(true) })
    return () => setUnauthorizedHandler(null)
  }, [])

  // 浏览器标签页标题跟着「系统名称」走
  useEffect(() => {
    if (settings?.system_name) document.title = settings.system_name
  }, [settings?.system_name])

  useEffect(() => { if (!booted.current) { booted.current = true; void boot() } }, [boot])

  useEffect(() => {
    if (!user) return
    http.trash().then(r => setTrashCount(r.stats.entries)).catch(() => {})
  }, [user, dash])

  const value = useMemo<AppState>(() => ({
    user, meta, dash, loading, refreshDash, refreshMeta, setUser: applyUser,
    needLogin, firstRun, trashCount, setTrashCount, settings, refreshSettings, license, refreshLicense,
  }), [user, meta, dash, loading, refreshDash, refreshMeta, applyUser, needLogin, firstRun, trashCount, settings, refreshSettings, license, refreshLicense])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
