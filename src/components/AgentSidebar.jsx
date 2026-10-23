import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { AGENT_STATUS_META, roleColor } from '../lib/meta'
import { useT } from '../lib/useT'
import PipelineEditor from './PipelineEditor'

/** 悬停提示。展开态和折叠态共用一份，免得两边描述的岗位信息各说各话。 */
const agentHint = (agent) =>
  `${agent.functionLabel} · ${agent.role}\n执行器：${agent.executor}${agent.model ? ` · ${agent.model}` : ''}\n点击查看系统提示词`

/** 界面上只显示「是干什么的」，不显示姓名 */
function AgentRow({ agent, taskCount, selected, onClick }) {
  const st = AGENT_STATUS_META[agent.status] || AGENT_STATUS_META.idle
  return (
    <button
      onClick={onClick}
      title={agentHint(agent)}
      className={`group flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
        selected
          ? 'border-boss/50 bg-ink-600'
          : 'border-transparent hover:border-ink-500 hover:bg-ink-700'
      }`}
    >
      <span className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-ink-600 text-base">
        {agent.avatar}
        <span
          className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-800 ${st.dot}`}
        />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-slate-200">{agent.functionLabel}</span>
        <span className="mt-0.5 flex items-center gap-1.5">
          <span className={`rounded px-1.5 py-[1px] font-mono text-[9.5px] ${roleColor(agent.role)}`}>
            {agent.executor}
          </span>
          <span className={`text-[10px] ${st.text}`}>{st.label}</span>
        </span>
      </span>

      <span
        className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
          taskCount > 0 ? 'bg-boss/15 text-boss-strong' : 'bg-ink-600 text-slate-600'
        }`}
        title={`名下未完成任务数：${taskCount}`}
      >
        {taskCount}
      </span>
    </button>
  )
}

/**
 * 折叠态的头像格子。这必须是一套独立的子元素，不能靠把 AgentRow 压窄 ——
 * AgentRow 的 min-content 有 86px 左右（头像 32 + 间距 10 + 计数徽标 24 + 内边距 20），
 * 塞进 56px 的窄条只会被撑破。岗位名靠 title 悬停给出，不额外做浮层。
 */
function AgentRailRow({ agent, onClick }) {
  const st = AGENT_STATUS_META[agent.status] || AGENT_STATUS_META.idle
  return (
    <button
      onClick={onClick}
      title={agentHint(agent)}
      className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-base transition-colors hover:bg-ink-600"
    >
      {agent.avatar}
      <span
        className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-800 ${st.dot}`}
      />
    </button>
  )
}

function AgentDetail({ agent, onClose }) {
  const t = useT()
  const deleteAgent = useStore((s) => s.deleteAgent)
  const saveAgentConfig = useStore((s) => s.saveAgentConfig)
  const mcpServers = useStore((s) => s.mcpServers)
  const agents = useStore((s) => s.agents)

  // 挂载 / 流水线的草稿：勾完点「保存」才写库（避免每点一下都发请求）
  const [mcpDraft, setMcpDraft] = useState(agent.mcp || [])
  const [pipeline, setPipeline] = useState(agent.pipeline || [])
  const [saving, setSaving] = useState(false)

  // MCP 目录可能还没加载过（面板没开过）—— 直接进岗位详情时要能拿到列表。
  // 用 ref 只触发一次：没有可挂载服务器时 mcpServers.length 恒为 0，
  // 依赖 mcpLoading 的写法会在 loading 结束后来回触发，无限打接口。
  const mcpLoading = useStore((s) => s.mcpLoading)
  const loadMcp = useStore((s) => s.loadMcp)
  const mcpRequested = useRef(false)
  useEffect(() => {
    if (mcpRequested.current || mcpServers.length || mcpLoading) return
    mcpRequested.current = true
    loadMcp()
  }, [mcpServers.length, mcpLoading, loadMcp])

  const roles = [...new Set(agents.map((a) => a.role))]
  const roleOptions = roles.map((r) => ({
    role: r,
    functionLabel: (agents.find((a) => a.role === r) || {}).functionLabel || r,
  }))
  const toggles = mcpServers.filter((s) => !s.internal)

  const save = async () => {
    setSaving(true)
    await saveAgentConfig(agent.id, { mcp: mcpDraft, pipeline })
    setSaving(false)
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className="w-[34rem] max-h-[88vh] animate-slideUp overflow-y-auto rounded-xl border border-ink-500 bg-ink-800 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-ink-600 text-2xl">
            {agent.avatar}
          </span>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold text-slate-100">{agent.functionLabel}</h3>
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${roleColor(agent.role)}`}>
                {agent.role}
              </span>
            </div>
            <p className="mt-0.5 font-mono text-[11px] text-slate-500">
              {agent.executor}
              {agent.model ? ` · ${agent.model}` : ' · 默认模型'}
            </p>
          </div>
          <button className="btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

        <div className="panel-title mb-1.5">{t('agent.prompt')}</div>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border border-ink-500 bg-ink-900 p-3 font-mono text-[11px] leading-relaxed text-slate-300">
          {agent.systemPrompt || '（未设置）'}
        </pre>

        {/* 该岗位挂载的 MCP：每个任务起跑时只把这些工具给它 */}
        <div className="panel-title mb-1.5 mt-4">{t('agent.mcp')}</div>
        <div className="space-y-1.5 rounded-lg border border-ink-500 bg-ink-900 p-3">
          {toggles.length === 0 && <p className="text-[11px] text-slate-500">MCP 面板里还没有可挂载的服务器。</p>}
          {toggles.map((s) => (
            <label key={s.id} className="flex cursor-pointer items-start gap-2 text-[11.5px]">
              <input
                type="checkbox"
                className="mt-0.5 h-3.5 w-3.5 accent-boss"
                checked={mcpDraft.includes(s.id)}
                onChange={(e) =>
                  setMcpDraft((prev) =>
                    e.target.checked ? [...prev, s.id] : prev.filter((x) => x !== s.id),
                  )
                }
              />
              <span className="flex-1">
                <span className="text-slate-200">{s.label}</span>
                {!s.enabled && (
                  <span className="ml-1 text-[10.5px] text-amber-400/80">
                    尚未在 MCP 面板启用，勾了也不会生效
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>

        {/* 该岗位的默认流水线（8.0.0：可视化排序） */}
        <div className="panel-title mb-1.5 mt-4">{t('agent.pipeline')}</div>
        <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
          <PipelineEditor value={pipeline} roles={roleOptions} onChange={setPipeline} />
          <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
            {t('agent.customPipeline')}
          </p>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <button
            className="btn-danger"
            onClick={() => {
              if (confirm(`确定移除「${agent.functionLabel}」这个岗位？其名下未完成的任务会变成未指派状态。`)) {
                deleteAgent(agent.id)
                onClose()
              }
            }}
          >
            {t('agent.fire')}
          </button>
          <button className="btn-primary" disabled={saving} onClick={save}>
            {saving ? t('common.loading') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function AgentSidebar({ onNewAgent }) {
  const t = useT()
  const agents = useStore((s) => s.agents)
  const tasks = useStore((s) => s.tasks)
  const open = useStore((s) => s.sidebarOpen)
  const openAgentId = useStore((s) => s.agentDetailId)
  const openAgentDetail = useStore((s) => s.openAgentDetail)
  const closeAgentDetail = useStore((s) => s.closeAgentDetail)

  const activeCount = (agentId) =>
    tasks.filter((task) => task.agentId === agentId && task.status !== 'complete').length

  const working = agents.filter((a) => a.status === 'working').length
  const current = openAgentId ? agents.find((a) => a.id === openAgentId) : null

  const newAgentBtn = (
    <button
      className="rounded px-1.5 py-0.5 text-xs text-slate-500 hover:bg-ink-600 hover:text-slate-100"
      onClick={onNewAgent}
      title={t('agent.add')}
    >
      +
    </button>
  )

  return (
    /* 宽度分三档：<1024 192px / ≥1024 208px / ≥1560 256px（desk 档 = 原来的样子）。
       下档不能再窄了：AgentRow 一行要 153px（内边距 20 + 头像 32 + 间距 10 + 中间列 63 +
       间距 10 + 计数 18），176px 时中间那列只剩 58px，岗位名和状态会被折成两行。
       折叠只改宽度、不用 transform —— transform 会让这个祖先成为 fixed 元素的包含块，
       把 AgentDetail 那个 fixed 弹窗连带裁掉。 */
    <aside
      className={`flex shrink-0 flex-col border-r border-ink-600 bg-ink-800 transition-[width] duration-200 ${
        open ? 'w-48 lg:w-52 desk:w-64' : 'w-14'
      }`}
    >
      {open ? (
        <>
          <div className="flex items-center justify-between px-3 py-2.5">
            <div className="panel-title">
              {t('agent.employees')} <span className="text-slate-400">{agents.length}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-sky-400">{t('agent.busy', { n: working })}</span>
              {newAgentBtn}
            </div>
          </div>

          <div className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
            {agents.map((a) => (
              <AgentRow
                key={a.id}
                agent={a}
                taskCount={activeCount(a.id)}
                selected={openAgentId === a.id}
                onClick={() => openAgentDetail(a.id)}
              />
            ))}
            {agents.length === 0 && (
              <p className="px-2 py-6 text-center text-xs text-slate-600">{t('agent.empty')}</p>
            )}
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col items-center gap-1 border-b border-ink-600/70 py-2">
            {newAgentBtn}
            <span
              className="font-mono text-[10px] leading-none text-slate-500"
              title={`共 ${agents.length} 个岗位${working > 0 ? `，${working} 个忙碌` : ''}`}
            >
              {agents.length}
            </span>
          </div>
          <div className="flex flex-1 flex-col items-center gap-1.5 overflow-y-auto py-2">
            {agents.map((a) => (
              <AgentRailRow key={a.id} agent={a} onClick={() => openAgentDetail(a.id)} />
            ))}
          </div>
        </>
      )}

      {current && <AgentDetail agent={current} onClose={closeAgentDetail} />}
    </aside>
  )
}
