import { useEffect, useRef, useState } from 'react'
import { useStore } from './store'
import { loadToken } from './lib/api'
import Login from './components/Login'
import TopBar from './components/TopBar'
import ChatWorkspace from './components/ChatWorkspace'
import Board from './components/Board'
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
import { QuickOverlay } from './components/ChaosDock'
import NavRail from './components/NavRail'
import { HomePage, ExpertsPage, SkillsPage, AutomationsPage } from './components/ChaosPages'
import AipptPage from './components/AipptPage'

/* ------------------------------------------------------------------ *
 * 8.0.2：老板键遮罩 —— 一键把整个界面伪装成「编译日志终端」。
 * 再按 Ctrl+B（或点一下）恢复。纯视觉戏法，数据动都不动。
 * ------------------------------------------------------------------ */

const FAKE_LINES = [
  '$ npm run build --prod',
  '✔ compiling modules (1,284/1,284)',
  '✔ chunk optimization pass 3/3',
  '$ deploy --env=production --verify',
  '→ uploading artifacts … 67%',
  '✔ liveness probes passing (12/12)',
  '$ git push origin main',
  '✔ CI pipeline #4821 green in 2m 14s',
  '→ running integration suite (331 tests)',
  '✔ coverage 94.2% (+0.8)',
  '$ tail -f /var/log/service.log',
  '[INFO] healthcheck ok — uptime 99.98%',
]

function BossOverlay() {
  const toggleBossMode = useStore((s) => s.toggleBossMode)
  return (
    <div
      className="fixed inset-0 z-[80] cursor-pointer overflow-hidden bg-[#0a0e14] p-6 font-mono text-[12px] leading-relaxed text-emerald-500/90"
      onClick={toggleBossMode}
      title="点一下或按 Ctrl+B 回到工作台"
    >
      <div className="mb-3 text-emerald-400/60">build@chaosconsole:~/release-pipeline</div>
      {FAKE_LINES.map((l, i) => (
        <div key={i} className={i % 3 === 2 ? 'text-emerald-300/70' : ''}>
          {l}
        </div>
      ))}
      <div className="mt-2 animate-pulse text-emerald-300">▍</div>
      <div className="absolute bottom-4 right-5 text-[10px] text-emerald-600/50">Ctrl+B 返回</div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 9.3.8：安全锁屏遮罩 —— 设置了 PIN 后一键锁住整个界面，解锁要输 PIN。
 * ------------------------------------------------------------------ */

function LockOverlay() {
  const locked = useStore((s) => s.locked)
  const [pin, setPin] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => {
    if (locked) {
      setPin('')
      setErr('')
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [locked])
  if (!locked) return null

  const tryUnlock = async () => {
    if (!pin.trim() || busy) return
    setBusy(true)
    const ok = await useStore.getState().unlockApp(pin.trim())
    setBusy(false)
    if (!ok) {
      setErr('PIN 不正确，再试一次')
      setPin('')
      inputRef.current?.focus()
    }
  }

  return (
    <div className="fixed inset-0 z-[90] flex flex-col items-center justify-center bg-ink-900/98 backdrop-blur">
      <div className="mb-4 text-5xl">🔒</div>
      <div className="mb-1 text-[14px] font-semibold text-slate-100">ChaosConsole 已锁定</div>
      <p className="mb-5 text-[11px] text-slate-500">输入 PIN 解锁（PIN 只存在本机）</p>
      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') tryUnlock()
          }}
          placeholder="PIN"
          className="field w-44 py-1.5 text-center font-mono tracking-[0.4em]"
        />
        <button className="btn-primary px-3 text-[12px]" disabled={!pin.trim() || busy} onClick={tryUnlock}>
          解锁
        </button>
      </div>
      {err && <p className="mt-3 text-[11px] text-rose-400">{err}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 8.0.2：每日一句横幅（本地混沌生成，一天一次）
 * ------------------------------------------------------------------ */

function DailyQuoteBanner() {
  const quote = useStore((s) => s.dailyQuote)
  const [dismissed, setDismissed] = useState(false)
  if (!quote || dismissed) return null
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-ink-600 bg-gradient-to-r from-boss/10 via-transparent to-transparent px-4 py-1.5 text-[11.5px] text-slate-300">
      <span>🌅</span>
      <span className="min-w-0 flex-1 truncate italic">{quote.text}</span>
      <span className="shrink-0 text-[9.5px] text-slate-600">混沌 · 每日一句</span>
      <button className="shrink-0 text-slate-600 hover:text-slate-300" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 8.0.2：速答小窗页面（?quick=1，全局 Ctrl+Alt+Space 唤起的独立窗口）
 * ------------------------------------------------------------------ */

function QuickPage() {
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const authed = useStore((s) => s.authed)
  const inputRef = useRef(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  if (!authed) {
    return (
      <div className="flex h-full items-center justify-center bg-ink-900 text-[12px] leading-relaxed text-slate-500">
        <div className="max-w-[16rem] text-center">
          <div className="mb-2 text-2xl">🌀</div>
          先在 ChaosConsole 主窗口登录一次，速答窗就能直接用了。
        </div>
      </div>
    )
  }

  const ask = async () => {
    const q = text.trim()
    if (!q || busy) return
    setBusy(true)
    setAnswer('')
    try {
      const r = await useStore.getState().chaosQuick(q)
      setAnswer(r.text)
    } catch (err) {
      setAnswer(`⚠️ ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full flex-col bg-ink-900">
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-700 px-4 py-2">
        <span>🌀</span>
        <span className="text-[12.5px] font-semibold text-slate-100">混沌速答</span>
        <span className="text-[10px] text-slate-600">本地 · 免费 · 不留记录 · Ctrl+Alt+Space 唤起</span>
        <button
          className="ml-auto text-[11px] text-slate-600 hover:text-slate-300"
          onClick={() => window.close()}
          title="收起速答窗"
        >
          收起
        </button>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') ask()
              if (e.key === 'Escape') window.close()
            }}
            placeholder="随便问一句，回车即答…"
            className="field min-w-0 flex-1"
          />
          <button className="btn-primary px-3 text-[12px]" disabled={!text.trim() || busy} onClick={ask}>
            {busy ? '…' : '问'}
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto rounded-xl bg-ink-800 p-3 text-[12.5px] leading-relaxed whitespace-pre-wrap break-words text-slate-100">
          {busy ? '🌀 混沌正在本地思考…' : answer || <span className="text-slate-600">答案会出现在这里。</span>}
        </div>
      </div>
    </div>
  )
}

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

/** 8.0.2：速答小窗走独立路由（Electron 的 quick 窗口加载 ?quick=1） */
const IS_QUICK_PAGE =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('quick') === '1'

export default function App() {
  const authed = useStore((s) => s.authed)
  const bootstrap = useStore((s) => s.bootstrap)
  const modal = useStore((s) => s.uiModal)
  const setModal = useStore((s) => s.openModal)
  const system = useStore((s) => s.system)
  const mainView = useStore((s) => s.mainView)
  const [ready, setReady] = useState(false)
  const importRef = useRef(null)

  /* 启动屏（正在接管控制台）是否已经播完。一次应用启动播一遍 —— 判断放在
     useState 的初值里，要跳过的话连一帧都不渲染，不然会闪一下。
     5 秒的计时从主窗口真正显示出来那刻才起算，见 LifecycleFx 的 onAppShown。 */
  const [booted, setBooted] = useState(() => shouldSkipBoot())

  // 启动时用已保存的 token 自动登录（后端重启过的话 token 会失效，bootstrap 内部
  // 会静默补票）。9.3.8：授权码登录已关闭 —— 没有保存的 token 也直接以访客身份进。
  useEffect(() => {
    const token = loadToken()
    if (!token) {
      useStore.getState().login('').finally(() => setReady(true))
      return
    }
    bootstrap().finally(() => setReady(true))
  }, [bootstrap])

  // 8.0.2：每日一句 —— 系统信息就绪后取一次（本地混沌生成，当天只取一次）
  useEffect(() => {
    if (!authed || !system) return
    useStore.getState().fetchDailyQuote()
    useStore.getState().loadChaosMemory()
    useStore.getState().loadChaosAutomations()
  }, [authed, system])

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
        return
      }
      // 8.0.2：老板键（Ctrl+B）—— 全屏伪装成编译日志，再按恢复
      if (mod && String(e.key).toLowerCase() === 'b') {
        e.preventDefault()
        s.toggleBossMode()
        return
      }
      // 9.3.8：锁屏（Ctrl+L）—— 设置了 PIN 后锁住整个界面
      if (mod && String(e.key).toLowerCase() === 'l') {
        e.preventDefault()
        s.lockApp()
        return
      }
      // 8.0.2：速答浮层（Ctrl+Shift+Space；独立小窗另有全局 Ctrl+Alt+Space）
      if (mod && e.shiftKey && e.code === 'Space') {
        e.preventDefault()
        s.toggleQuick()
        return
      }
      // 8.0.2：Alt+↑/↓ 在历史对话间快速切换
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        const list = s.conversations
        if (!list.length) return
        e.preventDefault()
        const idx = list.findIndex((c) => c.id === s.selectedTaskId)
        const next =
          e.key === 'ArrowUp'
            ? list[Math.max(0, idx - 1)] || list[0]
            : list[Math.min(list.length - 1, idx + 1)] || list[list.length - 1]
        if (next && next.id !== s.selectedTaskId) s.selectTask(next.id)
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

  // 8.0.2：速答小窗（?quick=1）只渲染速答页本身，不带工作台
  if (IS_QUICK_PAGE) {
    return (
      <>
        <QuickPage />
        <Toasts />
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
      <DailyQuoteBanner />
      <div className="flex min-h-0 flex-1">
        {/* 9.0.0：WorkBuddy 式左侧导航栏，切换主工作区页面 */}
        <NavRail />
        {mainView === 'home' && <HomePage />}
        {mainView === 'experts' && <ExpertsPage />}
        {mainView === 'skills' && <SkillsPage />}
        {mainView === 'aippt' && <AipptPage />}
        {mainView === 'automations' && <AutomationsPage />}
        {/* 9.1.0：任务看板独立成页；对话页 = 会话列表 + 全宽聊天主区 */}
        {mainView === 'board' && <Board />}
        {mainView === 'chat' && <ChatWorkspace onNewAgent={() => setModal('agent')} />}
      </div>

      <BulkBar />
      <QuickPageHost />

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
      <BossModeHost />
      <input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={onImportFile} />

      <Toasts />
      {/* 9.5.1：绿色呼吸边框（纯装饰，不挡点击） */}
      <div className="breathing-border" aria-hidden="true" />
      <LockOverlay />
      <ShutdownOverlay />
    </div>
  )
}

/** 老板键遮罩的挂载点（独立小组件，避免主组件多订一层 store） */
function BossModeHost() {
  const bossMode = useStore((s) => s.bossMode)
  if (!bossMode) return null
  return <BossOverlay />
}

/** 速答浮层挂载点：应用内 Ctrl+Shift+Space / 工具坞 🚀 打开 */
function QuickPageHost() {
  const quickOpen = useStore((s) => s.quickOpen)
  if (!quickOpen) return null
  return <QuickOverlay onClose={() => useStore.getState().toggleQuick(false)} />
}
