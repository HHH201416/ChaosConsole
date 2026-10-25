import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { SKILLS } from '../lib/skills'

/* ------------------------------------------------------------------ *
 * 9.0.0：WorkBuddy 式功能页面（工作台 / 专家中心 / 技能 / 自动化）。
 * 从左侧 NavRail 切换，整页展示；数据与动作全部复用现有 store。
 * ------------------------------------------------------------------ */

/** 页面外壳：标题 + 副标题 + 内容区 */
function PageShell({ icon, title, desc, children, actions }) {
  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden bg-ink-900">
      <header className="flex shrink-0 items-center gap-3 border-b border-ink-600 px-6 py-4">
        <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-ink-700 text-xl">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold text-slate-100">{title}</h2>
          {desc && <p className="mt-0.5 text-[11px] text-slate-500">{desc}</p>}
        </div>
        {actions}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
    </section>
  )
}

/* ---------------- 工作台（首页仪表盘） ---------------- */

export function HomePage() {
  const system = useStore((s) => s.system)
  const conversations = useStore((s) => s.conversations)
  const tasks = useStore((s) => s.tasks)
  const agents = useStore((s) => s.agents)
  const chaosStatus = useStore((s) => s.chaosStatus)
  const dailyQuote = useStore((s) => s.dailyQuote)
  const setMainView = useStore((s) => s.setMainView)
  const openModal = useStore((s) => s.openModal)
  const openPalette = useStore((s) => s.openPalette)
  const selectTask = useStore((s) => s.selectTask)
  const createTask = useStore((s) => s.createTask)
  const startTask = useStore((s) => s.startTask)

  const chaos = system?.chaos || {}
  const quota = chaos.quota || null
  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'
  const running = tasks.filter((t) => t.runState === 'running').length

  /**
   * 9.3.8：自修改 —— 建一个 cwd=应用自身源码目录的任务并立刻开跑，
   * 混沌用本地工具（读/写文件）直接改造这个应用自己的功能与页面。
   *
   * 9.7.0：不再用 window.prompt —— Electron 里没有实现它，一点就抛
   * 「界面脚本出错」。改成应用内的小弹窗（见下面的 SelfModifyDialog）。
   */
  const [modifyOpen, setModifyOpen] = useState(false)
  const [modifyBusy, setModifyBusy] = useState(false)

  const selfModify = () => {
    const root = system?.appRoot
    if (!root) {
      openModal('task')
      return
    }
    setModifyOpen(true)
  }

  const runSelfModify = async (raw) => {
    const what = String(raw || '').trim()
    const root = system?.appRoot
    if (!what || !root) return
    setModifyBusy(true)
    try {
      const created = await createTask({
        title: `🔧 自修改：${what.slice(0, 30)}`,
        description:
          `【自修改任务】ChaosConsole 要改造它自己。\n\n目标：${what}\n\n` +
          `这是本应用的源码目录，你可以用 list_files / read_file / write_file 工具直接查看与修改：\n` +
          `- 界面在 src/components/（React + Tailwind）\n` +
          `- 后端在 server/（Express）\n` +
          `- 改完先保证改动最小、不破坏现有功能；用户会重启应用来生效。\n` +
          `请先 read_file 看清相关文件再动手；完成后总结你改了哪些文件、各改了什么。`,
        tags: ['自修改'],
        cwd: root,
        executor: 'chaos',
      })
      if (created) await startTask(created.id)
      setModifyOpen(false)
    } finally {
      setModifyBusy(false)
    }
  }

  const quickActions = [
    { icon: '💬', label: '新对话', desc: '跟混沌或 Claude 聊一句', go: () => setMainView('chat') },
    { icon: '🎭', label: '专家中心', desc: '给混沌换个人格', go: () => setMainView('experts') },
    { icon: '⚡', label: '技能库', desc: '斜杠指令一键调用', go: () => setMainView('skills') },
    { icon: '⏰', label: '自动化', desc: '定时让混沌干活', go: () => setMainView('automations') },
    { icon: '📚', label: '知识库', desc: '导入文档，Agent 自动检索', go: () => openModal('knowledge') },
    { icon: '🌀', label: '混沌中心', desc: '模型安装与 Token 管理', go: () => openModal('chaos') },
    { icon: '🔧', label: '自修改', desc: '让混沌改造这个应用自己', go: selfModify },
  ]

  return (
    <PageShell icon="🏠" title={`${greet}，要干点什么？`} desc="ChaosConsole · 本地多 Agent 控制台 — 免费混沌模型 · 数据不出电脑">
      {dailyQuote && (
        <div className="mb-5 rounded-xl border border-boss/30 bg-boss/5 px-4 py-3 text-[12px] italic leading-relaxed text-slate-300">
          🌅 {dailyQuote.text}
        </div>
      )}

      {/* 状态卡 */}
      <div className="mb-5 grid grid-cols-2 gap-3 xl:grid-cols-4">
        <StatCard icon="🌀" label="混沌引擎" value={chaos.up ? '运行中' : '未启动'} tone={chaos.up ? 'ok' : 'warn'} />
        <StatCard
          icon="🧮"
          label="今日 Token"
          value={quota ? (quota.unlimited ? '∞ 永久' : `${((quota.remaining || 0) / 10000).toFixed(0)} 万剩余`) : '—'}
          tone={quota?.unlimited || (quota?.remaining || 0) > 0 ? 'ok' : 'bad'}
        />
        <StatCard icon="💬" label="历史对话" value={`${conversations.length} 场`} tone="plain" />
        <StatCard icon="🤖" label="运行中的任务" value={`${running} 个 / ${agents.length} 岗位`} tone={running ? 'ok' : 'plain'} />
      </div>

      {/* 快捷入口 */}
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {quickActions.map((a) => (
          <button
            key={a.label}
            onClick={a.go}
            className="rounded-xl border border-ink-500 bg-ink-800 p-3.5 text-left transition-colors hover:border-boss/50 hover:bg-ink-700"
          >
            <div className="text-xl">{a.icon}</div>
            <div className="mt-1.5 text-[12.5px] font-semibold text-slate-100">{a.label}</div>
            <div className="mt-0.5 text-[10px] leading-snug text-slate-500">{a.desc}</div>
          </button>
        ))}
      </div>

      {/* 最近对话 */}
      <div className="panel-title mb-2">最近对话</div>
      <div className="space-y-1.5">
        {conversations.slice(0, 6).map((c) => (
          <button
            key={c.id}
            onClick={() => {
              setMainView('chat')
              selectTask(c.id)
            }}
            className="flex w-full items-center gap-3 rounded-lg border border-ink-600 bg-ink-800/60 px-3 py-2 text-left hover:border-ink-400"
          >
            <span className="text-[14px]">{chaos.up && c.executor === 'chaos' ? '🌀' : '🤖'}</span>
            <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200">{c.title}</span>
            <span className="shrink-0 font-mono text-[9.5px] text-slate-600">{c.executor || '自动'}</span>
          </button>
        ))}
        {conversations.length === 0 && (
          <p className="rounded-lg border border-dashed border-ink-500 px-4 py-8 text-center text-[12px] text-slate-600">
            还没有对话 —— 点上面的「新对话」开一场，混沌就绪时默认免费。
          </p>
        )}
      </div>

      {/* 兜底引用，避免 chaosStatus 未用时被裁 */}
      <span className="hidden">{chaosStatus ? '' : ''}</span>
      <button className="hidden" onClick={openPalette} />

      {modifyOpen && (
        <SelfModifyDialog
          appRoot={system?.appRoot || ''}
          busy={modifyBusy}
          onClose={() => setModifyOpen(false)}
          onSubmit={runSelfModify}
        />
      )}
    </PageShell>
  )
}

/**
 * 9.7.0：应用内输入框，替代 window.prompt。
 * Electron 没有实现 prompt()，调用会直接抛异常 —— 之前「自修改」一点就报
 * 「界面脚本出错」就是这个原因。
 */
function SelfModifyDialog({ appRoot, busy, onClose, onSubmit }) {
  const [text, setText] = useState('')
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 px-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-xl border border-ink-500 bg-ink-800 p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="text-base">🔧</span>
          <h3 className="text-[13.5px] font-semibold text-slate-100">让混沌改造这个应用</h3>
          <button className="ml-auto text-slate-500 hover:text-slate-200" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
        <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
          混沌会以「自修改」任务运行，直接在源码目录里读写文件。改完需要重启应用才生效。
        </p>
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={3}
          placeholder="想改什么？例如：把技能页加一个搜索框"
          className="field w-full resize-none text-[12.5px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onSubmit(text)
          }}
        />
        <p className="mt-1 break-all font-mono text-[9.5px] text-slate-600">源码目录：{appRoot || '—'}</p>
        <div className="mt-3 flex justify-end gap-2">
          <button className="btn-ghost px-3 py-1.5 text-[12px]" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            className="btn-primary px-3 py-1.5 text-[12px]"
            disabled={busy || !text.trim()}
            onClick={() => onSubmit(text)}
          >
            {busy ? '创建中…' : '开始改造（Ctrl+Enter）'}
          </button>
        </div>
      </div>
    </div>
  )
}

function StatCard({ icon, label, value, tone }) {
  const toneCls =
    tone === 'ok' ? 'text-emerald-300' : tone === 'warn' ? 'text-amber-300' : tone === 'bad' ? 'text-rose-300' : 'text-slate-200'
  return (
    <div className="rounded-xl border border-ink-500 bg-ink-800 px-4 py-3">
      <div className="flex items-center gap-2 text-[10.5px] text-slate-500">
        <span className="text-[14px]">{icon}</span>
        {label}
      </div>
      <div className={`mt-1 text-[14px] font-semibold ${toneCls}`}>{value}</div>
    </div>
  )
}

/* ---------------- 专家中心（卡片墙） ---------------- */

export function ExpertsPage() {
  const system = useStore((s) => s.system)
  const setChaosExpert = useStore((s) => s.setChaosExpert)
  const experts = system?.chaos?.experts || []
  const active = system?.chaosExpert || 'default'

  return (
    <PageShell icon="🎭" title="专家中心" desc="给混沌换个人格 —— 纯本地提示词工程，随时可换，对所有新对话生效">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
        {experts.map((e) => (
          <button
            key={e.id}
            onClick={() => setChaosExpert(e.id)}
            className={`rounded-2xl border p-4 text-left transition-all ${
              active === e.id
                ? 'border-boss/60 bg-boss/10 shadow-lg shadow-boss/10'
                : 'border-ink-500 bg-ink-800 hover:border-ink-400 hover:bg-ink-700/60'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink-700 text-lg">{e.emoji}</span>
              <span className="text-[13px] font-semibold text-slate-100">{e.label}</span>
              {active === e.id && (
                <span className="ml-auto rounded-full bg-boss/20 px-2 py-0.5 text-[9.5px] font-medium text-boss-strong">使用中</span>
              )}
            </div>
            <p className="mt-2.5 line-clamp-4 min-h-[3.4rem] text-[11px] leading-relaxed text-slate-500">
              {e.prompt ? e.prompt.slice(0, 120) : '不加任何预设人格，平衡全能。适合日常问答与任务。'}
            </p>
            <div className={`mt-3 text-center text-[11px] font-medium ${active === e.id ? 'text-boss-strong' : 'text-slate-400'}`}>
              {active === e.id ? '✓ 正在使用' : '切换到这位'}
            </div>
          </button>
        ))}
        {experts.length === 0 && (
          <p className="col-span-full rounded-xl border border-dashed border-ink-500 px-4 py-10 text-center text-[12px] text-slate-600">
            专家包随混沌引擎一起提供 —— 先把混沌装好（左侧 🌀 混沌中心）。
          </p>
        )}
      </div>
    </PageShell>
  )
}

/* ---------------- 技能库 ---------------- */

export function SkillsPage() {
  const setMainView = useStore((s) => s.setMainView)
  const setSkillDraft = useStore((s) => s.setSkillDraft)

  const use = (skill) => {
    setSkillDraft(skill.template)
    setMainView('chat')
  }

  return (
    <PageShell icon="⚡" title="技能库" desc="WorkBuddy 式斜杠快捷指令 —— 点一条跳到对话页并填好模板，{text} 处换成你的内容">
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2 xl:grid-cols-3">
        {SKILLS.map((s) => (
          <button
            key={s.cmd}
            onClick={() => use(s)}
            className="group rounded-xl border border-ink-500 bg-ink-800 p-3.5 text-left transition-colors hover:border-boss/50 hover:bg-ink-700/60"
          >
            <div className="flex items-center gap-2">
              <span className="text-lg">{s.icon}</span>
              <span className="font-mono text-[11.5px] font-semibold text-boss-strong">{s.cmd}</span>
              <span className="ml-auto text-[11px] text-slate-300 group-hover:text-slate-100">{s.label}</span>
            </div>
            <p className="mt-2 line-clamp-2 text-[10px] leading-snug text-slate-600">{s.template}</p>
          </button>
        ))}
      </div>
    </PageShell>
  )
}

/* ---------------- 定时自动化 ---------------- */

export function AutomationsPage() {
  const automations = useStore((s) => s.chaosAutomations)
  const upsertChaosAutomation = useStore((s) => s.upsertChaosAutomation)
  const deleteChaosAutomation = useStore((s) => s.deleteChaosAutomation)
  const chaosStatus = useStore((s) => s.chaosStatus)
  const system = useStore((s) => s.system)
  const [name, setName] = useState('')
  const [time, setTime] = useState('08:00')
  const [prompt, setPrompt] = useState('')

  const ready = Boolean(system?.chaos?.up)

  const add = async () => {
    const r = await upsertChaosAutomation({ name: name.trim() || '定时任务', time, prompt: prompt.trim() })
    if (r?.ok !== false) {
      setName('')
      setPrompt('')
    }
  }

  return (
    <PageShell
      icon="⏰"
      title="定时自动化"
      desc="到点自动让混沌本地跑一条提示词，结果落成一场新对话 —— 全本地调度，重启不丢"
      actions={
        <span className={`rounded-full px-2.5 py-1 text-[10px] ${ready ? 'bg-emerald-900/50 text-emerald-300' : 'bg-amber-900/40 text-amber-300'}`}>
          {ready ? '混沌就绪 · 调度中' : '混沌未启动 · 到点会跳过'}
        </span>
      }
    >
      {/* 新建 */}
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-xl border border-ink-500 bg-ink-800 p-3">
        <input className="field w-36" placeholder="任务名" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="field w-24" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
        <input
          className="field min-w-0 flex-1"
          placeholder="要让混沌做什么，例如：给我一句晨间建议 + 今日待办提醒"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button className="btn-primary shrink-0 px-3 text-[12px]" disabled={!prompt.trim()} onClick={add}>
          ＋ 添加
        </button>
      </div>

      {/* 列表 */}
      <div className="space-y-2">
        {automations.map((a) => (
          <div key={a.id} className="flex items-center gap-3 rounded-xl border border-ink-600 bg-ink-800/70 px-4 py-3">
            <span className="rounded-lg bg-ink-700 px-2 py-1 font-mono text-[11px] text-boss-strong">{a.time}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12.5px] font-medium text-slate-100">{a.name}</div>
              <div className="mt-0.5 truncate text-[10.5px] text-slate-500">{a.prompt}</div>
            </div>
            {a.lastRunAt ? (
              <span className="shrink-0 text-[9.5px] text-slate-600" title="上次执行时间">
                上次 {new Date(a.lastRunAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            ) : null}
            <button
              className="btn-danger shrink-0 px-2 py-1 text-[10.5px]"
              onClick={() => {
                if (confirm(`删除自动化「${a.name}」？`)) deleteChaosAutomation(a.id)
              }}
            >
              删除
            </button>
          </div>
        ))}
        {automations.length === 0 && (
          <p className="rounded-xl border border-dashed border-ink-500 px-4 py-10 text-center text-[12px] text-slate-600">
            还没有自动化 —— 上面加一条，每天到点混沌自动开工。
          </p>
        )}
      </div>
    </PageShell>
  )
}
