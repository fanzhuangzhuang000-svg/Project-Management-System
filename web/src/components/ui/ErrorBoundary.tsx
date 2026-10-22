import React from 'react'
import { Button } from './primitives'

/**
 * 顶层错误边界。
 *
 * ── 为什么必须有 ──
 * React 18 起，渲染期间抛出未捕获异常会**卸载整棵树**，用户看到的就是纯白屏：
 * 没有侧栏、没有报错、也没有任何办法回去，只能自己想到刷新页面。
 * 项目里任何一个页面（表格、图表、详情）读到了 undefined 字段都会走到这一步。
 *
 * 有了它，出错时至少能：看到一句人话、回到首页、把技术细节复制出来。
 *
 * ── 它抓不到什么 ──
 * 事件处理器、setTimeout、Promise 里的异常不经过渲染阶段，错误边界抓不到
 * （那是 window.onerror / unhandledrejection 的范围）。这里只负责「别白屏」。
 */

type Props = { children: React.ReactNode }
type State = { error: Error | null; componentStack: string }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, componentStack: '' }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 完整堆栈留在控制台：用户按 F12 截图就能直接定位到组件
    console.error('[界面异常]', error, info.componentStack)
    this.setState({ componentStack: String(info.componentStack || '') })
  }

  private retry = () => this.setState({ error: null, componentStack: '' })

  private goHome = () => {
    // 出错后组件树已经不完整，整页刷新比「局部重试」更可靠
    location.hash = '#/dashboard'
    location.reload()
  }

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    const detail = [String(error.stack || error.message || error), componentStack].filter(Boolean).join('\n\n')

    return (
      <div className="flex min-h-screen items-center justify-center bg-subtle px-6">
        <div className="w-full max-w-xl rounded-[18px] border border-line/30 bg-surface p-8 shadow-sm">
          <div className="flex items-start gap-4">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[13px] bg-red-50 text-down">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 9v4M12 17h.01" />
                <path d="M10.3 3.9 2.4 17.5A1.9 1.9 0 0 0 4 20.4h16a1.9 1.9 0 0 0 1.6-2.9L13.7 3.9a1.9 1.9 0 0 0-3.4 0Z" />
              </svg>
            </span>
            <div className="min-w-0 flex-1">
              <h1 className="text-page text-ink-900">这个页面出错了</h1>
              <p className="mt-2 text-body text-ink-500">
                数据没有丢，只是这一页在显示的时候遇到了问题。可以先回首页继续用；
                如果总是停在这一页，把下面的技术细节发给我，能直接定位到具体位置。
              </p>
              <div className="mt-5 flex flex-wrap gap-2">
                <Button variant="primary" onClick={this.goHome}>回到首页</Button>
                <Button onClick={this.retry}>重试这一页</Button>
                <Button
                  onClick={() => { navigator.clipboard?.writeText(detail).catch(() => { /* 浏览器不给权限就算了 */ }) }}
                >
                  复制错误信息
                </Button>
              </div>
              <details className="mt-5">
                <summary className="cursor-pointer text-tiny text-ink-400 hover:text-ink-600">查看技术细节</summary>
                <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-subtle p-3 text-[11px] leading-relaxed text-ink-500">
                  {detail}
                </pre>
              </details>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
