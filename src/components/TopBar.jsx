import { useStore } from '../store'

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

export default function TopBar({ onNewAgent, onNewTask, onSettings, onMcp }) {
  const { conn, system, checkUpdate, tasks, logout } = useStore()

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
        <button className="btn-ghost" onClick={checkUpdate} title="检查 GitHub Releases 上的新版本">
          ⟳ 检查更新
        </button>

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
