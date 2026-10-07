import { useEffect, useState } from 'react'
import { useStore } from './store'
import { loadToken } from './lib/api'
import Login from './components/Login'
import TopBar from './components/TopBar'
import AgentSidebar from './components/AgentSidebar'
import Board from './components/Board'
import ChatPanel from './components/ChatPanel'
import {
  NewAgentModal,
  NewTaskModal,
  SettingsModal,
  McpModal,
  InstallUpdateModal,
  HandoffModal,
} from './components/Modals'
import { BootScreen, ShutdownOverlay, shouldSkipBoot } from './components/LifecycleFx'

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  const styles = {
    info: 'border-ink-500 bg-ink-700 text-slate-200',
    success: 'border-emerald-600/60 bg-emerald-900/40 text-emerald-200',
    error: 'border-rose-600/60 bg-rose-900/40 text-rose-200',
  }
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`animate-slideUp rounded-lg border px-4 py-2 text-[12px] shadow-xl backdrop-blur ${
            styles[t.kind] || styles.info
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  )
}

export default function App() {
  const authed = useStore((s) => s.authed)
  const bootstrap = useStore((s) => s.bootstrap)
  const [modal, setModal] = useState(null)
  const [ready, setReady] = useState(false)

  /* 启动屏（正在接管控制台）是否已经播完。一次应用启动播一遍 —— 判断放在
     useState 的初值里，要跳过的话连一帧都不渲染，不然会闪一下。
     5 秒的计时从主窗口真正显示出来那刻才起算，见 LifecycleFx 的 onAppShown。 */
  const [booted, setBooted] = useState(() => shouldSkipBoot())

  // 启动时用已保存的 token 自动登录（后端重启过的话 token 会失效，会退回登录页）
  useEffect(() => {
    const token = loadToken()
    if (!token) {
      setReady(true)
      return
    }
    bootstrap().finally(() => setReady(true))
  }, [bootstrap])

  // 主进程菜单项 -> 界面动作（仅在 Electron 里存在）
  useEffect(() => {
    const bridge = window.chaos
    if (!bridge) return
    const offTask = bridge.onMenuNewTask?.(() => setModal('task'))
    const offUpdate = bridge.onMenuCheckUpdate?.(() => useStore.getState().checkUpdate())
    return () => {
      offTask?.()
      offUpdate?.()
    }
  }, [])

  if (!booted) {
    return (
      <>
        <BootScreen ready={ready} onDone={() => setBooted(true)} />
        <ShutdownOverlay />
      </>
    )
  }

  if (!authed) {
    return (
      <>
        <Login />
        <Toasts />
        <ShutdownOverlay />
      </>
    )
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-ink-900">
      <TopBar
        onNewAgent={() => setModal('agent')}
        onNewTask={() => setModal('task')}
        onSettings={() => setModal('settings')}
        onMcp={() => setModal('mcp')}
        onInstallUpdate={() => setModal('update')}
      />
      <div className="flex min-h-0 flex-1">
        <AgentSidebar onNewAgent={() => setModal('agent')} />
        <Board />
        <ChatPanel />
      </div>

      {modal === 'agent' && <NewAgentModal onClose={() => setModal(null)} />}
      {modal === 'task' && <NewTaskModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'mcp' && <McpModal onClose={() => setModal(null)} />}
      {modal === 'update' && <InstallUpdateModal onClose={() => setModal(null)} />}
      {/* 换岗弹窗不走 modal 字符串：看板卡片和聊天页都要能直接打开它，
          状态放在 store 里（handoffFor），省掉一路传回调 */}
      <HandoffModal />

      <Toasts />
      <ShutdownOverlay />
    </div>
  )
}
