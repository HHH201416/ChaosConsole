import { useStore } from '../store'
import { fmtBytes } from '../lib/meta'
import { useT } from '../lib/useT'

/**
 * 更新控件。状态由 Electron 主进程推送（update:status），这里只负责呈现。
 *
 * 默认什么都不做；用户点「检查更新」、确实有新版本时，才出现「下载」；
 * 下载过程显示实时进度；下好之后才出现「安装并重启」。
 * 不存在静默下载，也不会自动安装。
 */
function UpdateControl({ onInstallUpdate }) {
  const t = useT()
  const update = useStore((s) => s.update)
  const checkUpdate = useStore((s) => s.checkUpdate)
  const downloadUpdate = useStore((s) => s.downloadUpdate)
  const status = update?.status || 'idle'
  const percent = Math.min(100, Math.max(0, update?.percent || 0))

  if (status === 'checking') {
    return (
      <button className="btn-ghost" disabled>
        ⟳ {t('topbar.checking')}
      </button>
    )
  }

  if (status === 'downloading') {
    return (
      <span
        className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300"
        title={`${fmtBytes(update.transferred)} / ${fmtBytes(update.total)} · ${fmtBytes(update.bytesPerSecond)}/s`}
      >
        <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
        ↓ {percent}%
        <span className="progress-track">
          <span className="progress-fill" style={{ width: `${percent}%` }} />
        </span>
      </span>
    )
  }

  if (status === 'downloaded') {
    return (
      <button className="btn-success" onClick={onInstallUpdate} title={t('topbar.installTitle')}>
        ⤓ {t('topbar.installRestart')}
      </button>
    )
  }

  if (status === 'installing') {
    return (
      <button className="btn-ghost" disabled>
        {t('topbar.installing')}
      </button>
    )
  }

  if (status === 'available') {
    return (
      <button className="btn-primary" onClick={() => downloadUpdate()} title={update.message}>
        ↓ {t('topbar.download', { version: update.version })}
      </button>
    )
  }

  // idle / latest / error / timeout / unsupported 都落在这里
  return (
    <button
      className="btn-ghost"
      onClick={checkUpdate}
      disabled={status === 'unsupported'}
      title={status === 'unsupported' ? update.message : t('topbar.checkTitle')}
    >
      {status === 'error' ? `⟳ ${t('topbar.retryCheck')}` : `⟳ ${t('topbar.checkUpdate')}`}
    </button>
  )
}

function ConnBadge({ conn }) {
  const t = useT()
  const map = {
    open: { cls: 'bg-emerald-500', text: t('topbar.connected'), textCls: 'text-emerald-400' },
    connecting: { cls: 'bg-boss animate-pulseDot', text: t('topbar.connecting'), textCls: 'text-boss-strong' },
    closed: { cls: 'bg-rose-500', text: t('topbar.disconnected'), textCls: 'text-rose-400' },
  }
  const m = map[conn] || map.closed
  return (
    <div className="flex items-center gap-1.5" title={`WebSocket: ${conn}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.cls}`} />
      <span className={`text-[11px] ${m.textCls}`}>{m.text}</span>
    </div>
  )
}

/**
 * 深/浅主题切换。
 *
 * 图标画的是「**当前生效**的主题」，点一下翻到另一个；「跟随系统」这个档位只在
 * 设置里选，顶栏不做三态循环 —— 一键切换要的是可预期，不是让人猜点第几下。
 * 当前是 system 模式时，第一次点会从「现在生效的那个」翻面（并就此变成显式选择），
 * 这是 store 里 toggleTheme() 定的语义。
 *
 * 是三态里那个 resolvedTheme 而不是 theme 决定图标：system 模式下必须显示真实
 * 生效的那个，否则图标会和肉眼看到的界面对不上。
 */
function ThemeToggle() {
  const t = useT()
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const toggleTheme = useStore((s) => s.toggleTheme)
  const light = resolvedTheme === 'light'

  return (
    <button
      className="btn-ghost shrink-0 px-2"
      onClick={toggleTheme}
      title={light ? t('topbar.themeToDark') : t('topbar.themeToLight')}
    >
      {light ? '☾' : '☀'}
    </button>
  )
}

/**
 * 面板折叠开关。是 <button> 不是 <aside> —— 全应用只有两个 aside（员工列表与对话面板），
 * 且顺序被 scripts/e2e-check.js 依赖，不能多出第三个。
 */
function PaneToggle({ onClick, active, title, glyph }) {
  return (
    <button
      className={`btn-ghost shrink-0 px-2 ${active ? '' : 'bg-ink-600 text-slate-500'}`}
      onClick={onClick}
      title={title}
    >
      {glyph}
    </button>
  )
}

export default function TopBar({
  onNewAgent,
  onNewTask,
  onSettings,
  onMcp,
  onInstallUpdate,
  onToolchain,
  onKnowledge,
  onChaos,
  onPalette,
}) {
  const t = useT()
  const { conn, system, tasks, logout, sidebarOpen, chatOpen, toggleSidebar, toggleChat } = useStore()

  const running = tasks.filter((t) => t.runState === 'running').length
  const version = system?.version ? `v${system.version}` : ''
  const mcpEnabled = system?.mcp?.enabled || 0
  const chaosUp = Boolean(system?.chaos?.serverUp)

  return (
    /* 窄屏时这个 header 是唯一「看不见就点不到」的地方（body 是 overflow:hidden，
       裁掉就真的没了）。所以：标题那一侧 min-w-0 + truncate 可以让步，
       右侧操作组 shrink-0 一步不让 —— 宁可截断标题，也绝不裁掉按钮。 */
    <header className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-ink-600 bg-ink-800 px-4">
      {/* 左：折叠开关 + 标题 */}
      <div className="flex min-w-0 items-center gap-3">
        <PaneToggle
          onClick={toggleSidebar}
          active={sidebarOpen}
          title={sidebarOpen ? t('topbar.collapseSidebar') : t('topbar.expandSidebar')}
          glyph="☰"
        />
        {/* 这几项之间是基线对齐的，外面这层不参与，免得按钮把标题挤歪 */}
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="truncate text-[17px] font-bold tracking-wide text-slate-100">AI Agent开发控制台</h1>
          {/* 版本号比「任务执行中」徽标先让位：后者是活信息，前者是装饰。
              阈值也不能再高了 —— 150% 缩放的 1080p 内宽只有约 1264。 */}
          <span className="hidden shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-slate-600 xl:inline">
            ChaosConsole {version}
          </span>
          {running > 0 && (
            <span className="hidden shrink-0 items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300 lg:flex">
              <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
              {t('topbar.runningTasks', { n: running })}
            </span>
          )}
        </div>
      </div>

      {/* 右：操作 */}
      <div className="flex shrink-0 items-center gap-2">
        <ConnBadge conn={conn} />

        <div className="mx-1 h-5 w-px bg-ink-500" />

        <button className="btn-primary" onClick={onNewAgent} title={t('topbar.newAgentTitle')}>
          <span className="text-sm leading-none">+</span> {t('topbar.newAgent')}
        </button>
        <button className="btn-success" onClick={onNewTask} title={t('topbar.newTaskTitle')}>
          <span className="text-sm leading-none">+</span> {t('topbar.newTask')}
        </button>
        <button className="btn-ghost" onClick={onMcp} title={t('topbar.mcpTitle')}>
          ⛓ MCP
          {mcpEnabled > 0 && <span className="ml-1 font-mono text-[10px] text-emerald-400">{mcpEnabled}</span>}
        </button>
        <button className="btn-ghost" onClick={onKnowledge} title={t('kb.subtitle')}>
          📚
        </button>
        <button
          className="btn-ghost"
          onClick={onChaos}
          title={system?.chaos ? `${t('chaos.title')} · ${t('chaos.subtitle')}` : t('chaos.title')}
        >
          🌀 {t('topbar.chaos')}
          {chaosUp && <span className="ml-1 h-1.5 w-1.5 rounded-full bg-emerald-500" />}
        </button>
        {/* 9.3.8：安全锁屏（Ctrl+L）—— 设置了 PIN 才生效 */}
        <button
          className="btn-ghost shrink-0"
          onClick={() => useStore.getState().lockApp()}
          title="锁定界面（Ctrl+L）—— 到 设置 → 安全 设置 PIN 后生效"
        >
          🔒
        </button>
        <UpdateControl onInstallUpdate={onInstallUpdate} />

        <div className="mx-1 h-5 w-px bg-ink-500" />

        <button
          className="btn-ghost shrink-0 px-2"
          onClick={onPalette}
          title={t('topbar.commandPalette')}
          data-testid="palette-button"
        >
          ⌕
        </button>
        <button className="btn-ghost shrink-0 px-2" onClick={onToolchain} title={t('topbar.toolchain')}>
          🧰
        </button>

        <ThemeToggle />

        <button className="btn-ghost" onClick={onSettings} title={t('topbar.settings')}>
          ⚙
        </button>
        <button className="btn-ghost" onClick={logout} title={t('topbar.logout')}>
          {t('topbar.logout')}
        </button>
      </div>
    </header>
  )
}
