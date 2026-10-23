import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { loadToken } from './lib/api'
import Login from './components/Login'
import TopBar from './components/TopBar'
import AgentSidebar from './components/AgentSidebar'
import Board from './components/Board'
import ChatPanel from './components/ChatPanel'
import CommandPalette from './components/CommandPalette'
import ShortcutHelp from './components/ShortcutHelp'
import ToolchainModal from './components/ToolchainModal'
import WattToolkitModal from './components/WattToolkitModal'
import KnowledgeModal from './components/KnowledgeModal'
import ChaosModal from './components/ChaosModal'
import StatsModal from './components/StatsModal'
import DiagnosticsModal from './components/DiagnosticsModal'
import BackupsModal from './components/BackupsModal'
import BulkBar from './components/BulkBar'
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
  const modal = useStore((s) => s.uiModal)
  const setModal = useStore((s) => s.openModal)
  const system = useStore((s) => s.system)
  const [ready, setReady] = useState(false)
  const importRef = useRef(null)

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
    const offFocus = bridge.onFocusTask?.((taskId) => {
      if (taskId) {
        setModal(null)
        useStore.getState().selectTask(taskId)
        useStore.setState({ chatOpen: true })
      }
    })
    const offNotice = bridge.onDesktopNotice?.((payload) => {
      if (payload?.text) useStore.getState().toast(payload.text, payload.kind || 'info')
    })
    return () => {
      offTask?.()
      offUpdate?.()
      offFocus?.()
      offNotice?.()
    }
  }, [])

  // 8.0.0：全局快捷键
  useEffect(() => {
    const onKey = (e) => {
      const tag = String(e.target?.tagName || '').toLowerCase()
      const typing =
        ['input', 'textarea', 'select'].includes(tag) || Boolean(e.target?.isContentEditable)
      const mod = e.ctrlKey || e.metaKey
      const s = useStore.getState()

      if (mod && String(e.key).toLowerCase() === 'k') {
        e.preventDefault()
        if (s.paletteOpen) s.closePalette()
        else s.openPalette()
        return
      }
      if (e.key === 'Escape') {
        if (s.paletteOpen) {
          s.closePalette()
          return
        }
        if (s.helpOpen) {
          s.toggleHelp(false)
          return
        }
        if (s.wattPromptOpen) {
          s.closeWattPrompt()
          return
        }
        if (modal) {
          setModal(null)
          return
        }
      }
      if ((mod && e.key === '/') || e.key === 'F1') {
        e.preventDefault()
        s.toggleHelp(true)
        return
      }
      if (typing) return
      if (mod && String(e.key).toLowerCase() === 'n') {
        e.preventDefault()
        setModal(e.shiftKey ? 'agent' : 'task')
        return
      }
      if (mod && e.key === ',') {
        e.preventDefault()
        setModal('settings')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal])

  // 新用户首次打开：推荐安装本地大模型「混沌」。
  // 只在「系统信息已加载、没标记过已引导、本次不是自检」时弹一次；
  // 用户关掉面板即写 chaosGuideDone，之后只从顶栏入口进。
  useEffect(() => {
    if (!authed || !system) return
    if (system.chaosGuideDone) return
    // 自检 / 脚本环境（CHAOS_SKIP_BOOT=1）：绝不弹窗打断，也不动引导标记，
    // 真人下次打开还能看到推荐
    if (shouldSkipBoot()) return
    const s = useStore.getState()
    if (!s.uiModal) s.openModal('chaos')
  }, [authed, system])

  const runCommand = (id) => {
    const s = useStore.getState()
    if (id === 'new-task') setModal('task')
    else if (id === 'new-agent') setModal('agent')
    else if (id === 'settings') setModal('settings')
    else if (id === 'toolchain') setModal('toolchain')
    else if (id === 'knowledge') setModal('knowledge')
    else if (id === 'chaos') setModal('chaos')
    else if (id === 'stats') setModal('stats')
    else if (id === 'diagnostics') setModal('diagnostics')
    else if (id === 'backups') setModal('backups')
    else if (id === 'export') s.exportWorkspace()
    else if (id === 'import') importRef.current?.click()
    else if (id === 'theme') s.toggleTheme()
    else if (id === 'accent') {
      const order = ['amber', 'sky', 'violet', 'emerald']
      s.setAccent(order[(order.indexOf(s.accent) + 1) % order.length])
    } else if (id === 'help') s.toggleHelp(true)
    else if (id === 'watt') s.openWattPrompt()
  }

  const onImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const s = useStore.getState()
    try {
      const data = JSON.parse(await file.text())
      if (!window.confirm(s.t('workspace.importConfirm'))) return
      await s.importWorkspace(data)
    } catch (_) {
      s.toast(s.t('workspace.badFile'), 'error')
    }
  }

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
        onToolchain={() => setModal('toolchain')}
        onKnowledge={() => setModal('knowledge')}
        onChaos={() => setModal('chaos')}
        onPalette={() => useStore.getState().openPalette()}
      />
      <div className="flex min-h-0 flex-1">
        <AgentSidebar onNewAgent={() => setModal('agent')} />
        <Board />
        <ChatPanel />
      </div>

      <BulkBar />

      {modal === 'agent' && <NewAgentModal onClose={() => setModal(null)} />}
      {modal === 'task' && <NewTaskModal onClose={() => setModal(null)} />}
      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} />}
      {modal === 'mcp' && <McpModal onClose={() => setModal(null)} />}
      {modal === 'update' && <InstallUpdateModal onClose={() => setModal(null)} />}
      {modal === 'toolchain' && <ToolchainModal onClose={() => setModal(null)} />}
      {modal === 'knowledge' && <KnowledgeModal onClose={() => setModal(null)} />}
      {/* 混沌引导：首启推荐走 isFirstRun（底部有「跳过」，关掉即不再推荐）；
          顶栏入口是普通管理面板，关掉不影响推荐标记 */}
      {modal === 'chaos' && (
        <ChaosModal
          isFirstRun={Boolean(system && !system.chaosGuideDone)}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'stats' && <StatsModal onClose={() => setModal(null)} />}
      {modal === 'diagnostics' && <DiagnosticsModal onClose={() => setModal(null)} />}
      {modal === 'backups' && <BackupsModal onClose={() => setModal(null)} />}
      {/* 换岗弹窗不走 modal 字符串：看板卡片和聊天页都要能直接打开它，
          状态放在 store 里（handoffFor），省掉一路传回调 */}
      <HandoffModal />

      <CommandPalette onCommand={runCommand} />
      <ShortcutHelp />
      <WattToolkitModal />
      <input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={onImportFile} />

      <Toasts />
      <ShutdownOverlay />
    </div>
  )
}
