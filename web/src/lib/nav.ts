import {
  LayoutDashboard, FolderKanban, ScrollText, CalendarClock, Wallet, ReceiptText,
  Coins, Package, Wrench, Building2, FilePenLine, Paperclip, Upload, ChartPie,
  Users, History, Trash2, Settings, type LucideIcon,
} from 'lucide-react'
import type { Perms } from './api'

export interface NavItem {
  key: string
  label: string
  to: string
  icon: LucideIcon
  /** 业务表：按表级读权限控制显隐 */
  table?: string
  /** 系统页：按 sys 权限控制显隐 */
  sys?: string
  badge?: 'trash' | 'attachments'
}
export interface NavGroup { title: string; items: NavItem[] }

/**
 * 侧边栏菜单。
 * 规格里给的是软件开发团队的模块名（任务中心/需求池/迭代看板…），
 * 本系统是弱电工程管理，所以按用户选定的方案映射到真实业务模块，
 * 但视觉规格（高度、圆角、选中态、发光指示条）完全照做。
 */
export const NAV: NavGroup[] = [
  {
    title: '工作台',
    items: [
      { key: 'dashboard', label: '首页概览', to: '/dashboard', icon: LayoutDashboard },
    ],
  },
  {
    title: '项目管理',
    items: [
      { key: 'projects', label: '项目管理', to: '/t/projects', icon: FolderKanban, table: 'projects' },
      { key: 'contracts', label: '合同管理', to: '/t/contracts', icon: ScrollText, table: 'contracts' },
      { key: 'contract_changes', label: '合同变更', to: '/t/contract_changes', icon: FilePenLine, table: 'contract_changes' },
      { key: 'schedules', label: '收付款计划', to: '/t/schedules', icon: CalendarClock, table: 'schedules' },
      { key: 'payments', label: '收付款', to: '/t/payments', icon: Wallet, table: 'payments' },
      { key: 'invoices', label: '发票管理', to: '/t/invoices', icon: ReceiptText, table: 'invoices' },
      { key: 'expenses', label: '项目费用', to: '/t/expenses', icon: Coins, table: 'expenses' },
      { key: 'materials', label: '材料设备', to: '/t/materials', icon: Package, table: 'materials' },
      { key: 'maintenance', label: '售后维修', to: '/t/maintenance', icon: Wrench, table: 'maintenance' },
      { key: 'partners', label: '往来单位', to: '/t/partners', icon: Building2, table: 'partners' },
    ],
  },
  {
    title: '分析与协作',
    items: [
      { key: 'reports', label: '报表统计', to: '/reports', icon: ChartPie },
      { key: 'attachments', label: '附件中心', to: '/attachments', icon: Paperclip, badge: 'attachments' },
      { key: 'import', label: '数据导入', to: '/import', icon: Upload, sys: 'import' },
    ],
  },
  {
    title: '系统',
    items: [
      { key: 'users', label: '成员管理', to: '/users', icon: Users, sys: 'users' },
      { key: 'logs', label: '操作日志', to: '/logs', icon: History, sys: 'logs' },
      { key: 'trash', label: '回收站', to: '/trash', icon: Trash2, sys: 'trash', badge: 'trash' },
      { key: 'settings', label: '系统设置', to: '/settings', icon: Settings, sys: 'settings' },
    ],
  },
]

/** 当前账号看得到的菜单 */
export function visibleNav(perms: Perms | undefined): NavGroup[] {
  if (!perms) return []
  const canRead = (t?: string) => !t || perms.all || perms.read.includes(t)
  const canSys = (k?: string) => !k || perms.all || perms.sys.includes(k)
  return NAV
    .map(g => ({ ...g, items: g.items.filter(i => canRead(i.table) && canSys(i.sys)) }))
    .filter(g => g.items.length > 0)
}

/** 由路径反查标题（面包屑用） */
export function titleOf(pathname: string, tables: Record<string, { label: string }> = {}): string {
  if (pathname.startsWith('/t/')) {
    const k = pathname.split('/')[2]
    return tables[k]?.label || '数据表'
  }
  if (pathname.startsWith('/p/')) return '项目详情'
  for (const g of NAV) for (const i of g.items) if (i.to === pathname) return i.label
  return '首页概览'
}
