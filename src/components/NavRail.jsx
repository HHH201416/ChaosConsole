import { useStore } from '../store'

/**
 * 9.0.0：WorkBuddy 式左侧图标导航栏。
 * 竖排图标按钮切换主工作区页面：工作台 / 对话 / 专家 / 技能 / 自动化 / 知识库 / 混沌。
 * 底部固定「设置」。当前页高亮（左侧亮条 + 亮色图标）。
 */
const NAV_ITEMS = [
  { id: 'home', icon: '🏠', label: '工作台' },
  { id: 'chat', icon: '💬', label: '对话' },
  { id: 'board', icon: '📋', label: '任务看板' },
  { id: 'experts', icon: '🎭', label: '专家中心' },
  { id: 'skills', icon: '⚡', label: '技能' },
  { id: 'aippt', icon: '🖼️', label: 'AIPPT' },
  { id: 'image', icon: '🎨', label: 'AI 绘图' },
  { id: 'automations', icon: '⏰', label: '自动化' },
  { id: 'library', icon: '📚', label: '知识库', modal: 'knowledge' },
  { id: 'chaos', icon: '🌀', label: '混沌中心', modal: 'chaos' },
]

export default function NavRail() {
  const mainView = useStore((s) => s.mainView)
  const setMainView = useStore((s) => s.setMainView)
  const openModal = useStore((s) => s.openModal)
  const system = useStore((s) => s.system)

  const chaosUp = Boolean(system?.chaos?.up)
  const quota = system?.chaos?.quota || null

  return (
    <nav className="flex w-[4.25rem] shrink-0 flex-col items-center border-r border-ink-600 bg-ink-800 py-2">
      {/* 顶部品牌标记 */}
      <button
        className="mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-boss/80 to-boss/40 text-lg shadow"
        onClick={() => setMainView('home')}
        title="ChaosConsole 工作台"
      >
        🌀
      </button>

      <div className="flex min-h-0 flex-1 flex-col items-center gap-1">
        {NAV_ITEMS.map((item) => {
          const active = !item.modal && mainView === item.id
          return (
            <button
              key={item.id}
              title={item.label}
              onClick={() => (item.modal ? openModal(item.modal) : setMainView(item.id))}
              className={`relative flex h-11 w-11 flex-col items-center justify-center rounded-xl transition-colors ${
                active ? 'bg-boss/15 text-boss-strong' : 'text-slate-400 hover:bg-ink-600 hover:text-slate-100'
              }`}
            >
              <span className="text-[17px] leading-none">{item.icon}</span>
              <span className="mt-0.5 text-[8.5px] leading-none">{item.label}</span>
              {item.id === 'chaos' && !chaosUp && (
                <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-amber-400" title="混沌未就绪" />
              )}
              {active && <span className="absolute -left-[9px] top-2 bottom-2 w-[3px] rounded-full bg-boss" />}
            </button>
          )
        })}
      </div>

      {/* 底部：Token 余量徽标 + 设置 */}
      {quota && !quota.unlimited && (
        <span
          className="mb-1 rounded-md bg-ink-600 px-1.5 py-0.5 font-mono text-[8.5px] text-slate-400"
          title={`今日 Token 剩余 ${(quota.remaining || 0).toLocaleString()} / ${(quota.dailyFree || 0).toLocaleString()}`}
        >
          {quota.remaining > 9_000_000 ? 'token ✓' : `${Math.round(((quota.remaining || 0) / (quota.dailyFree || 1)) * 100)}%`}
        </span>
      )}
      {quota?.unlimited && (
        <span
          className="mb-1 rounded-md bg-emerald-900/60 px-1.5 py-0.5 font-mono text-[8.5px] text-emerald-300"
          title="已绑定手机号 · 额度不限量"
        >
          ∞
        </span>
      )}
      <button
        className="flex h-9 w-9 items-center justify-center rounded-xl text-[16px] text-slate-400 transition-colors hover:bg-ink-600 hover:text-slate-100"
        onClick={() => openModal('settings')}
        title="设置"
      >
        ⚙️
      </button>
    </nav>
  )
}
