import React, { Suspense, lazy } from 'react'
import ReactDOM from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { AppProvider, useApp } from './app-context'
import { ToastProvider } from './components/ui/overlay'
import { AppShell } from './components/layout/AppShell'
import './index.css'

// 主题在首帧渲染前就位（深浅切换记在 localStorage，下次进来自动带）
document.documentElement.setAttribute('data-theme',
  (localStorage.getItem('pms.theme') as 'light' | 'dark') || 'light')

import { Route, Routes, Navigate } from 'react-router-dom'

/**
 * 页面按路由分包。
 * 图表库（Recharts）就有 400KB，登录页和大多数业务页根本用不到，
 * 打进首包会让第一次打开白等好几秒（尤其局域网或弱网）。
 */
const LoginPage = lazy(() => import('./pages/LoginPage'))
const DashboardPage = lazy(() => import('./pages/DashboardPage'))
const TablePage = lazy(() => import('./pages/TablePage'))
const ProjectDetailPage = lazy(() => import('./pages/ProjectDetailPage'))
const StatementPage = lazy(() => import('./pages/StatementPage'))
const ReportsPage = lazy(() => import('./pages/ReportsPage'))
const AttachmentsPage = lazy(() => import('./pages/AttachmentsPage'))
const ImportPage = lazy(() => import('./pages/ImportPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))
const LogsPage = lazy(() => import('./pages/LogsPage'))
const TrashPage = lazy(() => import('./pages/TrashPage'))
const SettingsPage = lazy(() => import('./pages/SettingsPage'))

/** 页面切换时的占位（保持和登录页一致的品牌视觉，避免闪白） */
function PageLoading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <span className="grad-brand flex h-11 w-11 animate-pulse items-center justify-center rounded-[13px] text-white">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <rect x="3" y="10" width="18" height="11" rx="2.5" /><path d="M7 10V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v3" />
          </svg>
        </span>
        <span className="text-tiny text-ink-400">加载中…</span>
      </div>
    </div>
  )
}

/** 顶层：未登录走登录页，登录后进 Shell */
function Root() {
  const { user, loading, needLogin, firstRun } = useApp()

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <span className="grad-brand flex h-12 w-12 animate-pulse items-center justify-center rounded-[14px] text-white">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
              <rect x="3" y="10" width="18" height="11" rx="2.5" /><path d="M7 10V7a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v3" />
            </svg>
          </span>
          <span className="text-body text-ink-400">正在加载…</span>
        </div>
      </div>
    )
  }

  if (needLogin || !user) {
    return (
      <Suspense fallback={<PageLoading />}>
        <LoginPage firstRun={firstRun} initialMsg={needLogin && !firstRun ? '登录已过期，请重新登录' : undefined} />
      </Suspense>
    )
  }

  return (
    <Suspense fallback={<PageLoading />}>
      <Routes>
        <Route element={<AppShell />}>
          {/* 根路径归一到 /dashboard，这样侧栏「首页概览」才会高亮 */}
          <Route path="/" element={<Navigate to="/dashboard" replace />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/t/:table" element={<TablePage />} />
          <Route path="/p/:id" element={<ProjectDetailPage />} />
          <Route path="/statement/:id" element={<StatementPage />} />
          <Route path="/reports" element={<ReportsPage />} />
          <Route path="/attachments" element={<AttachmentsPage />} />
          <Route path="/import" element={<ImportPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/trash" element={<TrashPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<DashboardPage />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <HashRouter>
      <ToastProvider>
        <AppProvider>
          <Root />
        </AppProvider>
      </ToastProvider>
    </HashRouter>
  </React.StrictMode>,
)
