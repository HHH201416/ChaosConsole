import { useStore } from '../store'
import { fmtBytes } from '../lib/meta'

/**
 * 更新控件。状态由 Electron 主进程推送（update:status），这里只负责呈现。
 *
 * 默认什么都不做；用户点「检查更新」、确实有新版本时，才出现「下载」；
 * 下载过程显示实时进度；下好之后才出现「安装并重启」。
 * 不存在静默下载，也不会自动安装。
 */
function UpdateControl({ onInstallUpdate }) {
  const update = useStore((s) => s.update)
  const checkUpdate = useStore((s) => s.checkUpdate)
  const downloadUpdate = useStore((s) => s.downloadUpdate)
  const status = update?.status || 'idle'
  const percent = Math.min(100, Math.max(0, update?.percent || 0))

  if (status === 'checking') {
    return (
      <button className="btn-ghost" disabled>
        ⟳ 检查中…
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
      <button className="btn-success" onClick={onInstallUpdate} title="安装已下载的新版本">
        ⤓ 安装并重启
      </button>
    )
  }

  if (status === 'installing') {
    return (
      <button className="btn-ghost" disabled>
        正在安装…
      </button>
    )
  }

  if (status === 'available') {
    return (
      <button className="btn-primary" onClick={() => downloadUpdate()} title={update.message}>
        ↓ 下载 v{update.version}
      </button>
    )
  }

  // idle / latest / error / timeout / unsupported 都落在这里
  return (
    <button
      className="btn-ghost"
      onClick={checkUpdate}
      disabled={status === 'unsupported'}
      title={status === 'unsupported' ? update.message : '检查 GitHub Releases 上的新版本'}
    >
      {status === 'error' ? '⟳ 重试' : '⟳ 检查更新'}
    </button>
  )
}

function ConnBadge({ conn }) {
  const map = {
    open: { cls: 'bg-emerald-500', text: '实时连接', textCls: 'text-emerald-400' },
    connecting: { cls: 'bg-boss animate-pulseDot', text: '连接中', textCls: 'text-boss' },
    closed: { cls: 'bg-rose-500', text: '已断开', textCls: 'text-rose-400' },
  }
  const m = map[conn] || map.closed
  return (
    <div className="flex items-center gap-1.5" title={`WebSocket: ${conn}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.cls}`} />
      <span className={`text-[11px] ${m.textCls}`}>{m.text}</span>
    </div>
  )
}

export default function TopBar({ onNewAgent, onNewTask, onSettings, onMcp, onInstallUpdate }) {
  const { conn, system, tasks, logout } = useStore()

  const running = tasks.filter((t) => t.runState === 'running').length
  const version = system?.version ? `v${system.version}` : ''
  const mcpEnabled = system?.mcp?.enabled || 0

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-ink-600 bg-ink-800 px-4">
      {/* 左：标题 */}
      <div className="flex items-baseline gap-3">
        <h1 className="text-[17px] font-bold tracking-wide text-white">AI Agent开发控制台</h1>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-slate-600">
          ChaosConsole {version}
        </span>
        {running > 0 && (
          <span className="flex items-center gap-1.5 rounded-full bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300">
            <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
            {running} 个任务执行中
          </span>
        )}
      </div>

      {/* 右：操作 */}
      <div className="flex items-center gap-2">
        <ConnBadge conn={conn} />

        <div className="mx-1 h-5 w-px bg-ink-500" />

        <button className="btn-primary" onClick={onNewAgent} title="新增一个 Agent 岗位">
          <span className="text-sm leading-none">+</span> 新岗位
        </button>
        <button className="btn-success" onClick={onNewTask} title="创建一个新任务">
          <span className="text-sm leading-none">+</span> 新任务
        </button>
        <button
          className="btn-ghost"
          onClick={onMcp}
          title="管理 MCP 服务器（让 Agent 能读写文件、查文档、开浏览器）"
        >
          ⛓ MCP
          {mcpEnabled > 0 && <span className="ml-1 font-mono text-[10px] text-emerald-400">{mcpEnabled}</span>}
        </button>
        <UpdateControl onInstallUpdate={onInstallUpdate} />

        <div className="mx-1 h-5 w-px bg-ink-500" />

        <button className="btn-ghost" onClick={onSettings} title="运行设置">
          ⚙
        </button>
        <button className="btn-ghost" onClick={logout} title="退出登录">
          退出
        </button>
      </div>
    </header>
  )
}
