import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { ROLE_PRESETS, fmtBytes } from '../lib/meta'
import { LATEST_NOTES, notesFor, plainLines } from '../lib/changelog'
import { useT } from '../lib/useT'
import PipelineEditor from './PipelineEditor'

function Shell({ title, subtitle, children, onClose, width = 'w-[32rem]' }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6" onClick={onClose}>
      <div
        className={`${width} max-h-[88vh] animate-slideUp overflow-y-auto rounded-xl border border-ink-500 bg-ink-800 p-5 shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4">
          <h3 className="text-base font-semibold text-slate-100">{title}</h3>
          {subtitle && <p className="mt-0.5 text-[11px] text-slate-500">{subtitle}</p>}
        </div>
        {children}
      </div>
    </div>
  )
}

const AVATARS = ['🤖', '👨💻', '👩💻', '🧑🔬', '🎨', '🧪', '🔍', '⚙️', '📊', '✍️', '🛡️', '📋', '🧠', '🚀', '🦾', '👾', '📱']

/**
 * Claude 权限模式的中文说明。取值与 server/config.js 的
 * VALID_PERMISSION_MODES 一一对应；这里只管措辞，不认识的值照旧显示原文，
 * 免得后端加了新模式而前端把它显示成空白。
 */
const PERMISSION_MODE_HINTS = {
  default: {
    option: 'default —— 每一步都要你点头（最安全，也最啰嗦）',
    desc: '读文件、写文件、执行命令之前都先问你。最安全，代价是任务常常停在「等你点同意」。',
    tone: 'text-slate-300',
  },
  acceptEdits: {
    option: 'acceptEdits —— 自动改文件，危险操作仍会问（推荐）',
    desc: '读写文件不用问，直接干；执行命令这类危险动作仍会被 CLI 拦下来等审批。默认档。',
    tone: 'text-emerald-400',
  },
  plan: {
    option: 'plan —— 只出方案，不动文件',
    desc: '只读不改：它调研、分析、给方案，但不会碰你的文件。适合「先说说打算怎么做」。',
    tone: 'text-sky-400',
  },
  bypassPermissions: {
    option: 'bypassPermissions —— 全部放行（高风险）',
    desc: '关掉全部审批闸门，它想干什么就干什么，包括删文件和跑任意命令。除非你完全清楚后果，否则别选。',
    tone: 'text-rose-400',
  },
}

/* ------------------------------------------------------------------ *
 * 版本行
 * ------------------------------------------------------------------ */

/**
 * 一行版本信息：标签 + 标记 + 体积/日期，右侧留一个动作槽给调用方。
 * 动作做成 children，是为了以后别处要复用同一套行样式时不必再抄一遍。
 */
function ReleaseRow({ release, selected, onClick, children }) {
  const clickable = typeof onClick === 'function'
  return (
    <div
      onClick={onClick}
      className={`flex items-center gap-2 rounded border px-2.5 py-1.5 ${
        selected ? 'border-boss/60 bg-ink-600' : 'border-ink-600 bg-ink-800'
      } ${clickable ? 'cursor-pointer transition-colors hover:border-ink-400' : ''}`}
    >
      <span className="font-mono text-[11px] text-slate-300">{release.tag}</span>
      {release.current && <span className="chip bg-emerald-900/50 text-emerald-300">当前</span>}
      {release.prerelease && <span className="chip">预发布</span>}
      <span className="ml-auto text-[10px] text-slate-600">
        {release.size ? fmtBytes(release.size) : ''} {release.publishedAt ? release.publishedAt.slice(0, 10) : ''}
      </span>
      {children}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * Agent 的模型选择复用块
 * ------------------------------------------------------------------ */

function ExecutorModelPicker({ executor, model, onChange }) {
  const executors = useStore((s) => s.system?.executors) || []
  const list = executors.find((e) => e.id === executor)
  const models = list?.models || []

  return (
    <div className="flex gap-3">
      <div className="flex-1">
        <label className="mb-1 block text-[11px] text-slate-400">执行器（用哪个 CLI 干活）</label>
        <select
          className="field"
          value={executor}
          onChange={(e) => onChange({ executor: e.target.value, model: '' })}
        >
          {executors.map((e) => (
            <option key={e.id} value={e.id} disabled={!e.available}>
              {e.label}
              {e.available ? '' : '（未安装）'}
            </option>
          ))}
        </select>
      </div>
      <div className="flex-1">
        <label className="mb-1 block text-[11px] text-slate-400">模型</label>
        <select className="field" value={model} onChange={(e) => onChange({ model: e.target.value })}>
          <option value="">（用默认模型）</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label || m.id}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 新岗位
 * ------------------------------------------------------------------ */

export function NewAgentModal({ onClose }) {
  const createAgent = useStore((s) => s.createAgent)
  const [form, setForm] = useState({
    functionLabel: '',
    role: 'Coder',
    avatar: '🤖',
    executor: 'claude',
    model: '',
    systemPrompt: '',
  })
  const [busy, setBusy] = useState(false)
  const ref = useRef(null)

  useEffect(() => ref.current?.focus(), [])

  const submit = async () => {
    const label = form.functionLabel.trim()
    if (!label || busy) return
    setBusy(true)
    // 姓名只作为内部标识，界面上不展示；这里直接用职能名兜底
    const created = await createAgent({ ...form, name: label })
    setBusy(false)
    if (created) onClose()
  }

  return (
    <Shell
      title="新增岗位"
      subtitle="每个岗位是一个独立 Agent。界面上只显示「是干什么的」，不显示姓名。"
      onClose={onClose}
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-[11px] text-slate-400">是干什么的 *</label>
          <input
            ref={ref}
            className="field"
            value={form.functionLabel}
            onChange={(e) => setForm({ ...form, functionLabel: e.target.value })}
            placeholder="例如：数据库调优 / 鸿蒙应用开发 / 埋点设计"
          />
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-[11px] text-slate-400">职能分类（决定自动派单）</label>
            <select className="field" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLE_PRESETS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="w-40">
            <label className="mb-1 block text-[11px] text-slate-400">头像</label>
            <div className="flex flex-wrap gap-1 rounded-md border border-ink-500 bg-ink-900 p-1.5">
              {AVATARS.map((a) => (
                <button
                  key={a}
                  onClick={() => setForm({ ...form, avatar: a })}
                  className={`rounded px-1 py-0.5 text-sm leading-none transition-colors ${
                    form.avatar === a ? 'bg-boss/25 ring-1 ring-boss/60' : 'hover:bg-ink-600'
                  }`}
                >
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>

        <ExecutorModelPicker
          executor={form.executor}
          model={form.model}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
        />

        <div>
          <label className="mb-1 block text-[11px] text-slate-400">系统提示词</label>
          <textarea
            rows={7}
            className="field resize-none font-mono text-[11px] leading-relaxed"
            value={form.systemPrompt}
            onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            placeholder={'你是团队里的「数据库调优」工程师。\n专长：索引设计、慢查询分析、执行计划解读。\n工作要求：\n1. …'}
          />
          <p className="mt-1 text-[10px] text-slate-600">
            每次执行任务时，这段文字会连同任务一起通过 stdin 发送给 CLI。
          </p>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn-primary" disabled={!form.functionLabel.trim() || busy} onClick={submit}>
          {busy ? '创建中…' : '创建岗位'}
        </button>
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------------ *
 * 新任务（看板手动派单用）
 * ------------------------------------------------------------------ */

const TAG_PRESETS = ['WebSearch', 'Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Task']

export function NewTaskModal({ onClose }) {
  const t = useT()
  const createTask = useStore((s) => s.createTask)
  const system = useStore((s) => s.system)
  const agents = useStore((s) => s.agents)
  const tasks = useStore((s) => s.tasks)
  const templates = useStore((s) => s.templates)
  const loadTemplates = useStore((s) => s.loadTemplates)
  const createTemplate = useStore((s) => s.createTemplate)
  const [form, setForm] = useState({
    title: '',
    description: '',
    tags: [],
    cwd: system?.defaultCwd || '',
    agentId: '',
    executor: '',
    model: '',
    parentId: '',
    dependsOn: [],
    pipeline: [],
  })
  const [busy, setBusy] = useState(false)
  const [templateId, setTemplateId] = useState('')
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false)
  const [templateName, setTemplateName] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const titleRef = useRef(null)

  useEffect(() => {
    titleRef.current?.focus()
    loadTemplates()
  }, [loadTemplates])

  const toggleTag = (tag) =>
    setForm((f) => ({ ...f, tags: f.tags.includes(tag) ? f.tags.filter((x) => x !== tag) : [...f.tags, tag] }))

  const toggleDep = (id) =>
    setForm((f) => ({
      ...f,
      dependsOn: f.dependsOn.includes(id)
        ? f.dependsOn.filter((x) => x !== id)
        : f.dependsOn.length >= 20
          ? f.dependsOn
          : [...f.dependsOn, id],
    }))

  const roleOptions = [...new Set(agents.map((a) => a.role))].map((role) => ({
    role,
    functionLabel: (agents.find((a) => a.role === role) || {}).functionLabel || role,
  }))

  const applyTemplate = (id) => {
    setTemplateId(id)
    const tpl = templates.find((x) => x.id === id)
    if (!tpl) return
    setForm((f) => ({
      ...f,
      title: tpl.title || f.title,
      description: tpl.description || '',
      tags: Array.isArray(tpl.tags) ? tpl.tags : [],
      cwd: tpl.cwd || f.cwd,
      agentId: tpl.agentId || '',
      executor: tpl.executor || '',
      model: tpl.model || '',
      pipeline: Array.isArray(tpl.pipeline) ? tpl.pipeline : [],
    }))
  }

  const saveAsTemplate = async () => {
    if (!form.title.trim()) return
    const created = await createTemplate({
      name: templateName.trim() || form.title.trim(),
      title: form.title,
      description: form.description,
      tags: form.tags,
      cwd: form.cwd,
      agentId: form.agentId || null,
      executor: form.executor || '',
      model: form.model || '',
      pipeline: form.pipeline,
    })
    if (created) {
      setSaveTemplateOpen(false)
      setTemplateName('')
    }
  }

  const submit = async () => {
    if (!form.title.trim() || busy) return
    setBusy(true)
    const created = await createTask({
      title: form.title,
      description: form.description,
      tags: form.tags,
      cwd: form.cwd,
      agentId: form.agentId || undefined,
      executor: form.executor || undefined,
      model: form.model || undefined,
      parentId: form.parentId || undefined,
      dependsOn: form.dependsOn,
      pipeline: form.pipeline.length ? form.pipeline : undefined,
    })
    setBusy(false)
    if (created) onClose()
  }

  const otherTasks = tasks.filter((task) => task.id !== form.parentId)

  return (
    <Shell title={t('task.new')} subtitle={t('task.newSubtitle')} onClose={onClose} width="w-[36rem]">
      <div className="space-y-3">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="mb-1 block text-[11px] text-slate-400">{t('task.template')}</label>
            <select className="field" value={templateId} onChange={(e) => applyTemplate(e.target.value)}>
              <option value="">—</option>
              {templates.map((tpl) => (
                <option key={tpl.id} value={tpl.id}>
                  {tpl.name}
                </option>
              ))}
            </select>
          </div>
          <button className="btn-ghost" onClick={() => setSaveTemplateOpen((v) => !v)}>
            {t('task.saveTemplate')}
          </button>
        </div>

        {saveTemplateOpen && (
          <div className="flex gap-2 rounded-lg border border-ink-500 bg-ink-900 p-2">
            <input
              className="field flex-1 !py-1 text-[11px]"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder={t('task.templateName')}
            />
            <button className="btn-primary px-2 py-1 text-[11px]" onClick={saveAsTemplate}>
              {t('common.save')}
            </button>
          </div>
        )}

        <div>
          <label className="mb-1 block text-[11px] text-slate-400">{t('task.title')} *</label>
          <input
            ref={titleRef}
            className="field"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="例如：给登录页加上失败重试与错误提示"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-slate-400">{t('task.description')}</label>
          <textarea
            rows={4}
            className="field resize-none text-[12px] leading-relaxed"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="背景、要改哪些文件、验收标准、不要动什么…"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-slate-400">{t('task.tags')}</label>
          <div className="flex flex-wrap gap-1.5">
            {TAG_PRESETS.map((tag) => (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                className={`rounded px-2 py-1 font-mono text-[11px] transition-colors ${
                  form.tags.includes(tag)
                    ? 'bg-boss/20 text-boss-strong ring-1 ring-boss/50'
                    : 'bg-ink-600 text-slate-400 hover:bg-ink-500'
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-[11px] text-slate-400">{t('task.cwd')}</label>
            <input
              className="field font-mono text-[11px]"
              value={form.cwd}
              onChange={(e) => setForm({ ...form, cwd: e.target.value })}
              placeholder="D:\\你的项目目录"
            />
          </div>
          <div className="w-44">
            <label className="mb-1 block text-[11px] text-slate-400">{t('task.agent')}</label>
            <select className="field" value={form.agentId} onChange={(e) => setForm({ ...form, agentId: e.target.value })}>
              <option value="">{t('task.autoAssign')}</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.functionLabel}
                </option>
              ))}
            </select>
          </div>
        </div>

        <button className="text-[11px] text-slate-500 hover:text-slate-300" onClick={() => setAdvanced((v) => !v)}>
          {advanced ? '▾' : '▸'} {t('task.advanced')}
        </button>

        {advanced && (
          <div className="space-y-3 rounded-lg border border-ink-500 bg-ink-900 p-3">
            <div>
              <label className="mb-1 block text-[11px] text-slate-400">{t('task.parent')}</label>
              <select
                className="field !py-1 text-[11px]"
                value={form.parentId}
                onChange={(e) => setForm({ ...form, parentId: e.target.value })}
              >
                <option value="">{t('deps.none')}</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-slate-400">
                {t('task.dependencies')} ({form.dependsOn.length}/20)
              </label>
              <div className="max-h-28 overflow-y-auto rounded border border-ink-500 bg-ink-800 p-1.5">
                {otherTasks.length === 0 && <p className="px-1 text-[10.5px] text-slate-600">{t('deps.none')}</p>}
                {otherTasks.map((task) => (
                  <label key={task.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-[10.5px] hover:bg-ink-700">
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-boss"
                      checked={form.dependsOn.includes(task.id)}
                      onChange={() => toggleDep(task.id)}
                    />
                    <span className="min-w-0 flex-1 truncate text-slate-300">{task.title}</span>
                    <span className="shrink-0 font-mono text-[9.5px] text-slate-600">{task.status}</span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-[11px] text-slate-400">{t('task.advanced')}</label>
              <PipelineEditor value={form.pipeline} roles={roleOptions} onChange={(pipeline) => setForm({ ...form, pipeline })} />
            </div>
          </div>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          {t('common.cancel')}
        </button>
        <button className="btn-primary" disabled={!form.title.trim() || busy} onClick={submit}>
          {busy ? t('task.creating') : t('task.create')}
        </button>
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------------ *
 * MCP 管理
 * ------------------------------------------------------------------ */

/**
 * 换岗弹窗。
 *
 * 两条界面规则必须守住（e2e-check 有断言、也是产品既定规矩）：
 *  1. **只显示职能（functionLabel），永远不显示姓名**；
 *  2. 运行中点「换岗」走的是交接，不是取消 —— 文案要说清，否则用户会以为任务被中断了。
 */
export function HandoffModal() {
  const { handoffFor, tasks, agents, handoffTask, closeHandoff } = useStore()
  const [agentId, setAgentId] = useState('')
  const [stage, setStage] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const task = tasks.find((t) => t.id === handoffFor) || null
  const current = task ? agents.find((a) => a.id === task.agentId) || null : null
  const stages = Array.isArray(task?.pipeline) ? task.pipeline : []
  const running = task ? task.runState === 'running' || task.runState === 'queued' : false

  useEffect(() => {
    setAgentId('')
    setStage('')
    setReason('')
    setBusy(false)
  }, [handoffFor])

  if (!task) return null

  // 阶段选择与指定岗位是两种目标：选了阶段就按流水线里那个阶段的岗位交接
  const stageRole = (stages.find((s) => s.stage === stage) || {}).role || ''
  const candidates = agents.filter((a) => a.id !== task.agentId && a.status === 'idle')
  const busyOnes = agents.filter((a) => a.id !== task.agentId && a.status !== 'idle')

  const submit = async () => {
    setBusy(true)
    await handoffTask(task.id, {
      agentId: agentId || undefined,
      role: stageRole || undefined,
      stage: stage || undefined,
      reason: reason.trim() || undefined,
    })
    setBusy(false)
  }

  return (
    <Shell
      title="换岗"
      subtitle={
        running
          ? '任务正在执行：会停下当前回合并把任务、进展和排队指令一起交接过去（不是取消）。'
          : '把一个任务交给另一个岗位接手。'
      }
      onClose={closeHandoff}
    >
      <div className="rounded-lg border border-ink-500 bg-ink-900 p-3 text-[11.5px] text-slate-400">
        <div className="truncate text-slate-200">{task.title}</div>
        <div className="mt-1">
          当前：{current ? current.functionLabel : '未指派'}
          {task.stage ? ` · 阶段 ${task.stage}` : ''}
          {task.attempts ? ` · 已重试 ${task.attempts} 次` : ''}
        </div>
      </div>

      {stages.length > 0 && (
        <div className="mt-3">
          <label className="mb-1 block text-[11px] text-slate-400">推进到阶段（可选）</label>
          <select className="field" value={stage} onChange={(e) => setStage(e.target.value)}>
            <option value="">不改变阶段</option>
            {stages.map((s) => (
              <option key={s.stage} value={s.stage}>
                {s.stage}
                {s.role ? ` · ${s.role}` : ''}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="mt-3">
        <label className="mb-1 block text-[11px] text-slate-400">指定接手岗位（可选）</label>
        <select
          className="field"
          value={agentId}
          onChange={(e) => setAgentId(e.target.value)}
          disabled={Boolean(stageRole)}
        >
          <option value="">自动挑一个空闲岗位{stageRole ? `（${stageRole}）` : ''}</option>
          {candidates.map((a) => (
            <option key={a.id} value={a.id}>
              {a.functionLabel} · {a.executor}
            </option>
          ))}
        </select>
        {busyOnes.length > 0 && (
          <p className="mt-1 text-[10.5px] text-slate-500">
            忙碌中（不可选）：{busyOnes.map((a) => a.functionLabel).join('、')}
          </p>
        )}
      </div>

      <div className="mt-3">
        <label className="mb-1 block text-[11px] text-slate-400">交接原因（可选，会写进交接说明）</label>
        <input
          className="field"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="例：这一步要让鸿蒙构建岗位来签包"
        />
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={closeHandoff}>
          取消
        </button>
        <button className="btn-primary" disabled={busy} onClick={submit}>
          {busy ? '换岗中…' : '换岗'}
        </button>
      </div>
    </Shell>
  )
}

function McpRow({ server, onToggle, busy }) {
  const [expanded, setExpanded] = useState(false)
  const [envValues, setEnvValues] = useState({})
  const [argValue, setArgValue] = useState('')
  const needsInput = server.category === 'needs-key'
  const canEnable = !needsInput || (server.envKeys.every((k) => envValues[k]) && (!server.requiresArg || argValue))

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 transition-colors ${
        server.enabled ? 'border-emerald-700/50 bg-emerald-950/20' : 'border-ink-500 bg-ink-900/40'
      }`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
            server.enabled ? 'bg-emerald-500' : server.installed ? 'bg-slate-500' : 'bg-ink-500'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[12.5px] font-medium text-slate-200">{server.label}</span>
            <span className="font-mono text-[10px] text-slate-600">{server.id}</span>
            {server.category === 'needs-key' && (
              <span className="rounded bg-boss/15 px-1.5 py-[1px] text-[9.5px] text-boss-strong">需密钥</span>
            )}
          </div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-slate-500">{server.desc}</p>
          <p className="mt-0.5 font-mono text-[10px] text-slate-700">{server.pkg}</p>

          {expanded && needsInput && !server.enabled && (
            <div className="mt-2 space-y-2">
              {server.envKeys.map((k) => (
                <input
                  key={k}
                  className="field font-mono text-[11px]"
                  placeholder={k}
                  value={envValues[k] || ''}
                  onChange={(e) => setEnvValues({ ...envValues, [k]: e.target.value })}
                />
              ))}
              {server.requiresArg && (
                <input
                  className="field font-mono text-[11px]"
                  placeholder={server.requiresArg}
                  value={argValue}
                  onChange={(e) => setArgValue(e.target.value)}
                />
              )}
              {server.keyHint && <p className="text-[10px] text-slate-600">{server.keyHint}</p>}
            </div>
          )}

          {server.enabled && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {server.enabledClaude && <span className="chip bg-sky-500/15 text-sky-300">claude</span>}
              {server.enabledDeveco && <span className="chip bg-violet-500/15 text-violet-300">deveco</span>}
            </div>
          )}
        </div>

        <div className="flex shrink-0 gap-1.5">
          {needsInput && !server.enabled && (
            <button className="btn-ghost px-2 py-1 text-[11px]" onClick={() => setExpanded((v) => !v)}>
              {expanded ? '收起' : '填密钥'}
            </button>
          )}
          {server.enabled ? (
            <button className="btn-danger px-2 py-1 text-[11px]" disabled={busy} onClick={() => onToggle(server, false)}>
              停用
            </button>
          ) : (
            <button
              className="btn-primary px-2 py-1 text-[11px]"
              disabled={busy || !canEnable}
              onClick={() => onToggle(server, true, { env: envValues, arg: argValue })}
            >
              启用
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export function McpModal({ onClose }) {
  const { mcpServers, mcpSummary, mcpLoading, loadMcp, enableMcp, disableMcp } = useStore()
  const [tab, setTab] = useState('installable')

  useEffect(() => {
    loadMcp()
  }, [loadMcp])

  const installable = mcpServers.filter((s) => s.category === 'installable')
  const needsKey = mcpServers.filter((s) => s.category === 'needs-key')
  // 按岗位：只列会被按岗位挂载的（internal 的是运行期按需注入的，不参与）
  const byRole = mcpServers.filter((s) => !s.internal)
  const shown = tab === 'installable' ? installable : tab === 'needsKey' ? needsKey : []

  const onToggle = async (server, enable, opts) => {
    if (enable) await enableMcp(server.id, opts)
    else await disableMcp(server.id)
  }

  return (
    <Shell
      title="MCP 服务器"
      subtitle="MCP 让 Agent 能读写文件、查文档、开浏览器等。启用后会同时写入 claude 与 deveco 两个 CLI 的配置。"
      onClose={onClose}
      width="w-[44rem]"
    >
      {mcpSummary && (
        <div className="mb-3 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg border border-ink-500 bg-ink-900 p-3 text-[11px]">
          {[
            ['已启用', `${mcpSummary.enabled} / ${mcpSummary.total}`],
            ['运行环境', `node ${mcpSummary.node}`],
            ['claude', mcpSummary.claudeAvailable ? '已就绪' : '未检测到'],
            ['deveco', mcpSummary.devecoAvailable ? '已就绪' : '未检测到'],
          ].map(([k, v]) => (
            <div key={k} className="flex gap-2">
              <span className="w-16 shrink-0 text-slate-500">{k}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-slate-400" title={String(v)}>
                {v}
              </span>
            </div>
          ))}
          <div className="col-span-2 flex gap-2 border-t border-ink-600 pt-1.5">
            <span className="w-16 shrink-0 text-slate-500">安装目录</span>
            <span className="min-w-0 flex-1 break-all font-mono text-slate-500">{mcpSummary.dir}</span>
          </div>
        </div>
      )}

      <div className="mb-3 flex gap-1 border-b border-ink-600">
        {[
          { key: 'installable', label: '即装即用', count: installable.length },
          { key: 'needsKey', label: '需要密钥', count: needsKey.length },
          { key: 'byRole', label: '按岗位', count: byRole.length },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-[12px] transition-colors ${
              tab === t.key ? 'border-boss text-slate-100' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.label}
            <span className="ml-1.5 font-mono text-[10px] text-slate-600">{t.count}</span>
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {mcpLoading && shown.length === 0 && <p className="py-8 text-center text-xs text-slate-600">加载中…</p>}
        {shown.map((s) => (
          <McpRow key={s.id} server={s} onToggle={onToggle} busy={mcpLoading} />
        ))}

        {/* 按岗位视图：一眼看出「谁默认挂什么」。改挂载在岗位详情里（点侧栏岗位 → 保存） */}
        {tab === 'byRole' &&
          byRole.map((s) => (
            <div
              key={s.id}
              className="rounded-lg border border-ink-500 bg-ink-900 p-2.5 text-[11.5px]"
            >
              <div className="flex items-center gap-2">
                <span className={s.enabled ? 'text-emerald-400' : 'text-slate-600'}>
                  {s.enabled ? '●' : '○'}
                </span>
                <span className="text-slate-200">{s.label}</span>
                {!s.enabled && <span className="text-[10.5px] text-slate-500">（尚未全局启用，挂载也不会生效）</span>}
              </div>
              <div className="mt-1 pl-4 text-[10.5px] text-slate-500">
                {s.roles && s.roles.length ? `默认岗位：${s.roles.join('、')}` : '默认不挂给任何岗位'}
              </div>
            </div>
          ))}
      </div>

      <div className="mt-5 flex items-center justify-between">
        <p className="max-w-[70%] text-[10px] leading-relaxed text-slate-600">
          提示：每启用一个 MCP，它都会注入到 Agent 的每次会话里。装太多会挤占上下文、拖慢每个任务，
          建议只开当前用得上的。
        </p>
        <button className="btn-ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

/**
 * 下载加速镜像的状态显示（**只读**）。
 *
 * 开不开由服务端定（默认启用，见 server/config.js 的 DOWNLOAD_MIRROR），界面上
 * 只告诉用户「现在走不走镜像、走的是哪个」。理由：本机 hosts 被加速器改过，GitHub
 * 的发布包域名被指到 127.0.0.1，直连实测只有 ~0.1MB/s（87MB 要十几分钟），走镜像
 * 能到 5MB/s —— 这么个技术细节没道理让用户先理解再自己填。
 * 要改（换镜像 / 关掉）用环境变量 CHAOS_DOWNLOAD_MIRROR，见 README。
 */
function DownloadMirrorField() {
  const system = useStore((s) => s.system)
  const mirror = system?.downloadMirror || ''

  return (
    <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-slate-200">下载加速镜像</span>
        <span className={`flex items-center gap-1.5 font-mono text-[10px] ${mirror ? 'text-emerald-400' : 'text-slate-500'}`}>
          <span className={`h-1.5 w-1.5 rounded-full ${mirror ? 'bg-emerald-500' : 'bg-slate-600'}`} />
          {mirror ? '已启用' : '未启用'}
        </span>
      </div>
      <p className="mt-1 break-all font-mono text-[10px] text-slate-500">
        {mirror || '直连 GitHub'}
      </p>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-500">
        升级和版本回退的安装包都从这里下。GitHub 的发布包域名被本机加速器劫持到
        <b className="text-slate-400"> 127.0.0.1</b>，直连实测只有 ~0.1MB/s（87MB 要十几分钟），
        走镜像能到 <b className="text-emerald-400">5MB/s</b> 左右，所以<b className="text-slate-400">默认开启</b>。
        <br />
        镜像返回的就是接下来会被执行的安装包，等于把下载交给第三方 —— 因此下载完会拿该版本自己的
        <b className="text-slate-400"> latest.yml </b>校验 sha512（基准走 GitHub API、不经镜像），
        不符就丢弃、不装。
        <br />
        要换镜像或关掉：设环境变量 <b className="text-slate-400">CHAOS_DOWNLOAD_MIRROR</b>
        （换成别的镜像地址；填 <b className="text-slate-400">off</b> 则直连）。
      </p>
    </div>
  )
}

/**
 * 外观：深色 / 浅色 / 跟随系统。
 *
 * 「跟随系统」是首次启动的默认值，也是唯一能一直跟着 Windows 走的档位；显式选了
 * 深或浅之后就固定住，系统再变也不跟。顶栏那个按钮只做深/浅翻转，三态收在这里。
 *
 * 用三个 <button> 而不是 <select>：分段控件一眼能看出「现在在哪一档」，而且
 * scripts/e2e-check.js 会数页面上的 select 个数（`selectCount >= 2`），
 * 多一个原生 select 会动到那条断言的语义。
 */
function AppearanceField() {
  const t = useT()
  const theme = useStore((s) => s.theme)
  const resolvedTheme = useStore((s) => s.resolvedTheme)
  const setTheme = useStore((s) => s.setTheme)
  const language = useStore((s) => s.language)
  const setLanguage = useStore((s) => s.setLanguage)
  const accent = useStore((s) => s.accent)
  const setAccent = useStore((s) => s.setAccent)

  const OPTIONS = [
    { key: 'light', label: t('settings.light'), glyph: '☀' },
    { key: 'dark', label: t('settings.dark'), glyph: '☾' },
    { key: 'system', label: t('settings.system'), glyph: '⌾' },
  ]
  const ACCENTS = [
    { key: 'amber', color: '#f5a524' },
    { key: 'sky', color: '#38bdf8' },
    { key: 'violet', color: '#8b5cf6' },
    { key: 'emerald', color: '#34d399' },
  ]

  return (
    <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-slate-200">{t('settings.appearance')}</span>
        <span className="font-mono text-[10px] text-slate-500">
          {theme === 'system'
            ? `${t('settings.system')} · ${resolvedTheme === 'light' ? t('settings.light') : t('settings.dark')}`
            : t('common.enabled')}
        </span>
      </div>

      <div className="mt-2 flex gap-1.5">
        {OPTIONS.map((o) => {
          const active = theme === o.key
          return (
            <button
              key={o.key}
              onClick={() => setTheme(o.key)}
              className={`flex-1 rounded-md border px-2 py-1.5 text-[11.5px] transition-colors ${
                active
                  ? 'border-boss/50 bg-boss/15 text-boss-strong'
                  : 'border-ink-500 bg-ink-800 text-slate-400 hover:bg-ink-600 hover:text-slate-200'
              }`}
            >
              <span className="mr-1">{o.glyph}</span>
              {o.label}
            </button>
          )
        })}
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">{t('settings.language')}</span>
        <div className="flex gap-1.5">
          {[
            ['zh', t('settings.chinese')],
            ['en', t('settings.english')],
          ].map(([key, label]) => (
            <button
              key={key}
              onClick={() => setLanguage(key)}
              className={`rounded-md border px-2 py-1 text-[11px] ${
                language === key
                  ? 'border-boss/50 bg-boss/15 text-boss-strong'
                  : 'border-ink-500 bg-ink-800 text-slate-400 hover:bg-ink-600'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between">
        <span className="text-[11px] text-slate-400">{t('settings.accent')}</span>
        <div className="flex gap-2">
          {ACCENTS.map((item) => (
            <button
              key={item.key}
              onClick={() => setAccent(item.key)}
              title={item.key}
              className={`h-5 w-5 rounded-full border-2 ${
                accent === item.key ? 'border-slate-100' : 'border-transparent'
              }`}
              style={{ backgroundColor: item.color }}
            />
          ))}
        </div>
      </div>

      <p className="mt-2 text-[10.5px] leading-relaxed text-slate-500">
        默认<b className="text-slate-400">跟随系统</b>，也就是跟着 Windows 的深色/浅色设置走。
        选「浅色」或「深色」之后就固定住，系统再变也不跟。顶栏那个 ☀ / ☾ 按钮可以随时在两者之间一键翻转。
        选择记在本机，重开还在。
      </p>
    </div>
  )
}

/**
 * 9.3.8：第三方 API（OpenAI 兼容）配置 —— 接口地址 / 密钥 / 模型名。
 * 只存本机 settings，密钥不回传（界面上只显示「已配置」）。
 * 配好后执行器下拉里会出现「第三方 API」选项。
 */
function ApiField() {
  const system = useStore((s) => s.system)
  const apiCfg = system?.api || {}
  const [baseUrl, setBaseUrl] = useState(apiCfg.baseUrl || '')
  const [key, setKey] = useState('')
  const [model, setModel] = useState(apiCfg.model || '')
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      const patch = { apiBaseUrl: baseUrl.trim(), apiModel: model.trim() }
      if (key.trim()) patch.apiKey = key.trim()
      const res = await api.setSettings(patch)
      if (!res.ok) throw new Error(res.error || '保存失败')
      useStore.getState().toast('第三方 API 已保存（密钥只存本机）', 'success')
      await useStore.getState().refreshSystem()
      setKey('')
    } catch (err) {
      useStore.getState().toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2.5 rounded-lg border border-ink-500 bg-ink-900 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-slate-200">🔗 第三方 API（OpenAI 兼容）</span>
        {apiCfg.ready ? (
          <span className="chip bg-emerald-500/15 text-emerald-300">已配置 · {apiCfg.model}</span>
        ) : (
          <span className="chip">未配置（可选）</span>
        )}
      </div>
      <p className="text-[10.5px] leading-relaxed text-slate-500">
        想用云端大模型时自己填：接口地址（如 https://api.openai.com/v1 或任意兼容服务）、API Key、模型名。
        密钥只保存在本机，不会上传。混沌本地模型始终免费可用，此项只是加一个可选项。
      </p>
      <div className="grid grid-cols-1 gap-2">
        <input
          className="field w-full py-1 text-[11.5px]"
          placeholder="接口地址，例如 https://api.openai.com/v1"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
        <div className="flex gap-2">
          <input
            className="field min-w-0 flex-1 py-1 font-mono text-[11.5px]"
            type="password"
            placeholder={apiCfg.hasKey ? 'API Key（已配置，留空则不修改）' : 'API Key'}
            value={key}
            onChange={(e) => setKey(e.target.value)}
          />
          <input
            className="field w-44 py-1 font-mono text-[11.5px]"
            placeholder="模型名，例如 gpt-4o-mini"
            value={model}
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
      </div>
      <button className="btn-primary px-3 py-1 text-[11.5px]" disabled={busy} onClick={save}>
        {busy ? '保存中…' : '保存第三方 API 配置'}
      </button>
    </div>
  )
}

/**
 * 9.3.8：安全 —— 本地锁屏 PIN。PIN 只存本机；锁屏后输 PIN 才能进（Ctrl+L / 顶栏 🔒）。
 */
function SecurityField() {
  const system = useStore((s) => s.system)
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const hasPin = Boolean(system?.hasPin)

  const save = async () => {
    setBusy(true)
    try {
      const res = await api.setSettings({ appPin: pin.trim() })
      if (!res.ok) throw new Error(res.error || '保存失败')
      useStore.getState().toast(pin.trim() ? '已设置锁屏 PIN，Ctrl+L 或顶栏 🔒 即可锁定' : '已清除锁屏 PIN', 'success')
      setPin('')
      await useStore.getState().refreshSystem()
    } catch (err) {
      useStore.getState().toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-ink-500 bg-ink-900 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-slate-200">🔒 安全锁屏</span>
        {hasPin ? (
          <span className="chip bg-emerald-500/15 text-emerald-300">已启用</span>
        ) : (
          <span className="chip">未设置</span>
        )}
      </div>
      <p className="text-[10.5px] leading-relaxed text-slate-500">
        设置 4~12 位数字 PIN 后，按 Ctrl+L 或点顶栏 🔒 锁住整个界面，输 PIN 才能解锁。PIN 只保存在本机。
      </p>
      <div className="flex gap-2">
        <input
          className="field w-40 py-1 text-center font-mono tracking-[0.3em]"
          type="password"
          inputMode="numeric"
          placeholder={hasPin ? '输入新 PIN（留空=清除）' : '4~12 位数字'}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
        />
        <button className="btn-primary px-3 py-1 text-[11.5px]" disabled={busy} onClick={save}>
          {busy ? '保存中…' : hasPin ? '更新 / 清除' : '启用锁屏'}
        </button>
      </div>
    </div>
  )
}

/**
 * 9.6.1：工作区 —— Agent 干活、落文件的根目录。
 * Electron 里走系统选目录对话框；浏览器里就手填绝对路径（服务端会校验并创建）。
 */
function WorkspaceField() {
  const system = useStore((s) => s.system)
  const current = system?.workspaceDir || system?.defaultCwd || ''
  const isCustom = Boolean(system?.workspaceDirCustom)
  const [value, setValue] = useState(current)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValue(current)
  }, [current])

  const canPick = typeof window !== 'undefined' && window.chaos && typeof window.chaos.pickDirectory === 'function'

  const pick = async () => {
    try {
      const r = await window.chaos.pickDirectory()
      if (r && r.ok && r.path) setValue(r.path)
    } catch (_) {
      useStore.getState().toast('打开目录选择框失败，可以直接手动粘贴路径', 'error')
    }
  }

  const save = async (next) => {
    setBusy(true)
    try {
      const res = await api.setSettings({ workspaceDir: next })
      if (!res.ok) throw new Error(res.error || '保存失败')
      useStore
        .getState()
        .toast(next ? `工作区已切换到 ${next}` : '已恢复默认工作区', 'success')
      await useStore.getState().refreshSystem()
    } catch (err) {
      useStore.getState().toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2 rounded-lg border border-ink-500 bg-ink-900 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] font-medium text-slate-200">📁 工作区</span>
        {isCustom ? (
          <span className="chip bg-emerald-500/15 text-emerald-300">自定义</span>
        ) : (
          <span className="chip">默认</span>
        )}
      </div>
      <p className="text-[10.5px] leading-relaxed text-slate-500">
        Agent 干活、写文件、跑命令都从这个目录开始；不填任务路径时，新任务默认落在这里。
      </p>
      <div className="flex flex-wrap gap-2">
        <input
          className="field min-w-0 flex-1 py-1 font-mono text-[11px]"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="D:\\Projects（留空 = 用默认目录）"
        />
        {canPick && (
          <button className="btn-ghost shrink-0 px-2 py-1 text-[11.5px]" disabled={busy} onClick={pick}>
            📂 选择…
          </button>
        )}
        <button className="btn-primary shrink-0 px-3 py-1 text-[11.5px]" disabled={busy} onClick={() => save(value.trim())}>
          {busy ? '保存中…' : '应用'}
        </button>
        {isCustom && (
          <button className="btn-ghost shrink-0 px-2 py-1 text-[11.5px]" disabled={busy} onClick={() => save('')}>
            恢复默认
          </button>
        )}
      </div>
      <p className="break-all font-mono text-[9.5px] text-slate-600">当前生效：{current || '—'}</p>
    </div>
  )
}

/**
 * 10.0.2：运行期间禁止关机。
 *
 * 开关本身只是服务端一条设置（blockShutdown），**真正拦不拦得住**由主进程的
 * 守护进程决定（需要 .NET / PowerShell / Windows 三样齐）。所以这里的状态必须
 * 走 IPC 问主进程，不能拿 settings 的值当结果 —— 否则用户以为开了，其实没拦住。
 */
function ShutdownGuardField() {
  const t = useT()
  const system = useStore((s) => s.system)
  const setDesktopSetting = useStore((s) => s.setDesktopSetting)
  const [state, setState] = useState(null)
  const wanted = Boolean(system?.blockShutdown)
  const bridge = typeof window !== 'undefined' ? window.chaos : null
  const canQuery = Boolean(bridge && bridge.shutdownGuardStatus)

  useEffect(() => {
    if (!canQuery) return undefined
    let alive = true
    bridge
      .shutdownGuardStatus()
      .then((s) => {
        if (alive) setState(s)
      })
      .catch(() => {})
    const off = bridge.onShutdownGuardStatus?.((s) => {
      if (alive) setState((prev) => ({ ...(prev || {}), ...s }))
    })
    return () => {
      alive = false
      if (typeof off === 'function') off()
    }
  }, [canQuery, bridge, wanted])

  let status = ''
  let tone = 'text-slate-500'
  if (!canQuery) {
    status = t('settings.shutdownUnsupported')
  } else if (!wanted) {
    status = t('settings.shutdownOff')
  } else {
    const s = state?.status || ''
    if (s === 'running') {
      /* 权限被策略收走时只能拦界面发起的关机，撤不掉定时关机 —— 如实说 */
      if (state?.privileged === false) {
        status = t('settings.shutdownLimited')
        tone = 'text-amber-400'
      } else {
        status = t('settings.shutdownOn')
        tone = 'text-emerald-400'
      }
    } else if (s === 'running-fallback') {
      status = t('settings.shutdownFallback')
      tone = 'text-amber-400'
    } else if (s === 'restarting') {
      status = t('settings.shutdownRestarting')
      tone = 'text-amber-400'
    } else if (s === 'starting') {
      status = t('settings.shutdownStarting')
      tone = 'text-slate-400'
    } else if (s === 'unsupported') {
      status = t('settings.shutdownUnsupported')
      tone = 'text-amber-400'
    } else if (s === 'error') {
      status = `${t('settings.shutdownFailed')}${state?.detail ? `：${state.detail}` : ''}`
      tone = 'text-rose-400'
    } else {
      status = t('settings.shutdownPaused')
      tone = 'text-slate-500'
    }
  }

  return (
    <div className="space-y-1 rounded-lg border border-ink-500 bg-ink-900 p-3">
      <label className="flex cursor-pointer items-center justify-between gap-3">
        <span className="text-[11.5px] text-slate-400">{t('settings.blockShutdown')}</span>
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-boss"
          checked={wanted}
          onChange={(e) => setDesktopSetting('blockShutdown', e.target.checked)}
        />
      </label>
      <p className="text-[10px] leading-relaxed text-slate-500">{t('settings.blockShutdownHint')}</p>
      <p className={`text-[10px] ${tone}`}>{status}</p>
    </div>
  )
}

/**
 * 10.0.2：卸载应用。
 *
 * 确认框故意不画在这一层：卸载不可逆，确认要由主进程用系统对话框弹出，
 * 才能压过应用窗口、也不会被页面的浮层遮挡。这里只负责发起与回执。
 *
 * 三条失败路径对应三种真实情况，提示词不能混：
 *   not-found  绿色版 / 解压运行，安装目录里没有 Uninstall exe
 *   canceled   用户自己点了取消，属于正常操作，不提示
 *   其它       启动失败（权限、杀软拦截）
 */
function UninstallField() {
  const t = useT()
  const [busy, setBusy] = useState(false)
  const bridge = typeof window !== 'undefined' ? window.chaos : null
  const canUninstall = Boolean(bridge && bridge.uninstallApp)

  const onClick = async () => {
    if (!canUninstall || busy) return
    setBusy(true)
    try {
      const r = await bridge.uninstallApp()
      if (r?.ok) {
        useStore.getState().toast(t('settings.uninstallLaunching'), 'success')
      } else if (r?.canceled) {
        /* 用户主动取消，不打扰 */
      } else if (r?.error === 'not-found') {
        useStore.getState().toast(t('settings.uninstallNotFound'), 'error')
      } else {
        useStore
          .getState()
          .toast(`${t('settings.uninstallFailed')}${r?.error ? `：${r.error}` : ''}`, 'error')
      }
    } catch (err) {
      useStore.getState().toast(err?.message || t('settings.uninstallFailed'), 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1 rounded-lg border border-ink-500 bg-ink-900 p-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11.5px] text-slate-400">{t('settings.uninstall')}</span>
        <button
          className="btn-ghost px-2 py-1 text-[10.5px] !text-rose-300"
          onClick={onClick}
          disabled={!canUninstall || busy}
          title={canUninstall ? '' : t('settings.uninstallUnsupported')}
        >
          {busy ? t('settings.uninstallBusy') : t('settings.uninstallNow')}
        </button>
      </div>
      <p className="text-[10px] leading-relaxed text-slate-500">{t('settings.uninstallHint')}</p>
    </div>
  )
}

export function SettingsModal({ onClose }) {
  const t = useT()
  const system = useStore((s) => s.system)
  const openModal = useStore((s) => s.openModal)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const setDevecoAutoApprove = useStore((s) => s.setDevecoAutoApprove)
  const setAutoUpdateWhenIdle = useStore((s) => s.setAutoUpdateWhenIdle)
  const setMaxAttempts = useStore((s) => s.setMaxAttempts)
  const setPipelineEnabled = useStore((s) => s.setPipelineEnabled)
  const setMcpOption = useStore((s) => s.setMcpOption)
  const setDesktopSetting = useStore((s) => s.setDesktopSetting)
  const exportWorkspace = useStore((s) => s.exportWorkspace)
  const importWorkspace = useStore((s) => s.importWorkspace)
  const maybeShowWattPrompt = useStore((s) => s.maybeShowWattPrompt)
  const resetWattPrompt = useStore((s) => s.resetWattPrompt)
  const loadReleases = useStore((s) => s.loadReleases)
  const rollbackTo = useStore((s) => s.rollbackTo)
  const update = useStore((s) => s.update)
  const [rel, setRel] = useState(null)
  const [relBusy, setRelBusy] = useState(false)
  const clearAllTasks = useStore((s) => s.clearAllTasks)
  const [busy, setBusy] = useState(false)
  const importRef = useRef(null)

  if (!system) return null

  const onImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const data = JSON.parse(await file.text())
      if (!window.confirm(t('workspace.importConfirm'))) return
      await importWorkspace(data)
    } catch (_) {
      useStore.getState().toast(t('workspace.badFile'), 'error')
    }
  }

  return (
    <Shell title={t('settings.title')} subtitle="这些选项决定 Agent 如何被拉起执行" onClose={onClose}>
      <div className="space-y-4 text-[12px]">
        {/* 外观 */}
        <AppearanceField />

        {/* 9.3.8：第三方 API（OpenAI 兼容）—— 用户自己填 key */}
        <ApiField />

        {/* 9.3.8：安全锁屏 PIN */}
        <SecurityField />

        {/* 9.6.1：自定义工作区（Agent 干活的根目录） */}
        <WorkspaceField />

        {/* 9.5.4：允许 Agent 操作电脑（run_command / open_path 工具总闸） */}
        <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg border border-ink-500 bg-ink-900 p-3">
          <span>
            <span className="block text-[11.5px] text-slate-200">允许 Agent 操作电脑</span>
            <span className="mt-0.5 block text-[10px] text-slate-500">
              关闭后混沌岗位只能读写工作区文件，不能再执行命令或打开文件（每次调用都会记录在对话事件流里）
            </span>
          </span>
          <input
            type="checkbox"
            className="h-3.5 w-3.5 shrink-0 accent-boss"
            checked={system.agentComputerUse !== false}
            onChange={(e) => setDesktopSetting('agentComputerUse', e.target.checked)}
          />
        </label>

        {/* 8.0.0：派单策略 / 桌面集成 / 新面板入口 */}
        <div className="space-y-2.5 rounded-lg border border-ink-500 bg-ink-900 p-3">
          <div className="text-[12px] font-medium text-slate-200">{t('settings.desktop')}</div>

          <label className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-slate-400">{t('settings.dispatch')}</span>
            <select
              className="field max-w-[15rem] !py-1 text-[11px]"
              value={system.dispatchStrategy || 'keyword'}
              onChange={(e) => setDesktopSetting('dispatchStrategy', e.target.value)}
            >
              <option value="keyword">{t('settings.dispatchKeyword')}</option>
              <option value="least-busy">{t('settings.dispatchLeastBusy')}</option>
              <option value="round-robin">{t('settings.dispatchRoundRobin')}</option>
            </select>
          </label>

          {[
            ['trayEnabled', t('settings.tray')],
            ['closeToTray', t('settings.closeToTray')],
            ['notifyOnComplete', t('settings.notifyComplete')],
            ['notifyOnNeedsInput', t('settings.notifyNeedsInput')],
            ['notifyOnlyWhenUnfocused', t('settings.notifyOnlyUnfocused')],
          ].map(([key, label]) => (
            <label key={key} className="flex cursor-pointer items-center justify-between gap-3">
              <span className="text-[11.5px] text-slate-400">{label}</span>
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-boss"
                checked={key === 'closeToTray' ? Boolean(system.closeToTray) : system[key] !== false}
                onChange={(e) => setDesktopSetting(key, e.target.checked)}
              />
            </label>
          ))}

          {/* 10.0.2：运行期间禁止关机 */}
          <ShutdownGuardField />

          {/* 10.0.2：卸载入口（系统安装版才有卸载器） */}
          <UninstallField />

          <label className="flex items-center justify-between gap-3">
            <span className="text-[11.5px] text-slate-400">{t('settings.globalShortcut')}</span>
            <select
              className="field max-w-[15rem] !py-1 text-[11px]"
              value={system.globalShortcut || 'CommandOrControl+Shift+Space'}
              onChange={(e) => setDesktopSetting('globalShortcut', e.target.value)}
            >
              <option value="CommandOrControl+Shift+Space">Ctrl+Shift+Space</option>
              <option value="CommandOrControl+Alt+C">Ctrl+Alt+C</option>
              <option value="CommandOrControl+Shift+K">Ctrl+Shift+K</option>
              <option value="off">{t('settings.shortcutOff')}</option>
            </select>
          </label>

          <div className="flex flex-wrap gap-2 pt-1">
            <button className="btn-ghost px-2 py-1 text-[10.5px]" onClick={() => openModal('toolchain')}>
              🧰 {t('settings.toolchain')}
            </button>
            <button className="btn-ghost px-2 py-1 text-[10.5px]" onClick={() => openModal('stats')}>
              📊 {t('settings.stats')}
            </button>
            <button className="btn-ghost px-2 py-1 text-[10.5px]" onClick={() => openModal('diagnostics')}>
              🩺 {t('settings.diagnostics')}
            </button>
            <button className="btn-ghost px-2 py-1 text-[10.5px]" onClick={() => openModal('backups')}>
              🗄 {t('settings.backups')}
            </button>
            <button className="btn-ghost px-2 py-1 text-[10.5px]" onClick={resetWattPrompt}>
              ⚡ {t('settings.wattReset')}
            </button>
          </div>
        </div>

        {/* 执行器状态 */}
        <div className="space-y-2">
          {(Array.isArray(system.executors) ? system.executors : []).map((e) => (
            <div key={e.id} className="rounded-lg border border-ink-500 bg-ink-900 p-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${e.available ? 'bg-emerald-500' : 'bg-boss'}`} />
                <span className="font-medium text-slate-200">{e.label}</span>
                <span className="font-mono text-[10px] text-slate-600">
                  {e.available ? `${(Array.isArray(e.models) ? e.models : []).length} 个模型可用` : '未安装'}
                </span>
              </div>
              <p className="text-[10.5px] text-slate-500">{e.hint}</p>
              {e.available && (
                <p className="mt-1 break-all font-mono text-[10px] text-slate-600">
                  {(Array.isArray(e.models) ? e.models : []).map((m) => m.id).join(' · ')}
                </p>
              )}
            </div>
          ))}
        </div>

        {/* 权限 */}
        <div>
          <label className="mb-1 block text-[11px] text-slate-400">Claude 权限模式</label>
          <select
            className="field"
            value={system.permissionMode}
            onChange={(e) => setPermissionMode(e.target.value)}
          >
            {(system.validPermissionModes || []).map((m) => (
              <option key={m} value={m}>
                {(PERMISSION_MODE_HINTS[m] || {}).option || m}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-500">
            决定 Claude 岗位动手前要不要先问你。四个档位从紧到松：
          </p>
          <ul className="mt-1.5 space-y-1 text-[10.5px] leading-relaxed text-slate-500">
            {(system.validPermissionModes || []).map((m) => {
              const hint = PERMISSION_MODE_HINTS[m]
              const active = m === system.permissionMode
              return (
                <li key={m} className={active ? 'text-slate-300' : ''}>
                  <b className={hint?.tone || 'text-slate-400'}>
                    {m}
                    {active ? '（当前）' : ''}
                  </b>
                  ：{hint ? hint.desc : '未知模式，已按 CLI 默认行为处理。'}
                </li>
              )
            })}
          </ul>
        </div>

        {/* DevEco 自动放行 */}
        <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-boss"
              checked={Boolean(system.devecoAutoApprove)}
              onChange={(e) => setDevecoAutoApprove(e.target.checked)}
            />
            <span>
              <span className="block text-[12px] font-medium text-slate-200">DevEco 自动放行</span>
              <span className="mt-0.5 block text-[10.5px] leading-relaxed text-slate-500">
                DevEco Code 没有 acceptEdits 这种中间档，只有「全自动放行」。
                <b className="text-boss-strong"> 默认关闭</b>，此时它会驳回未经批准的敏感操作，
                表现为任务跑不动（事件里会看到「权限被拦截」）。
                打开后它才能自主读写文件、执行命令 —— 这等于让它不经确认地在你的机器上干活。
              </span>
            </span>
          </label>
        </div>

        {/* 下载加速镜像 */}
        <DownloadMirrorField />

        {/* 更新 */}
        <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-boss"
              checked={Boolean(system.autoUpdateWhenIdle)}
              onChange={(e) => setAutoUpdateWhenIdle(e.target.checked)}
            />
            <span>
              <span className="block text-[12px] font-medium text-slate-200">空闲时自动检查并下载更新</span>
              <span className="mt-0.5 block text-[10.5px] leading-relaxed text-slate-500">
                只在<b className="text-slate-400">没有任何任务在执行</b>的时候才会去检查并开始下载，
                下载进度显示在顶栏。<b className="text-emerald-400">安装始终需要你确认</b>——
                下载完只会出现「安装并重启」按钮，不会自己装上。
                <b className="text-slate-400"> 默认关闭</b>：不打开时，只有你点「检查更新」才会去查。
              </span>
            </span>
          </label>
        </div>

        {/* 换岗与阶段流水线 */}
        <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
          <label className="flex cursor-pointer items-start gap-2.5">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-boss"
              checked={Boolean(system?.pipelineEnabled)}
              onChange={(e) => setPipelineEnabled(e.target.checked)}
            />
            <span>
              <span className="block text-[12px] font-medium text-slate-200">阶段流水线（方案 → 编码 → 构建 → 测试）</span>
              <span className="mt-0.5 block text-[10.5px] leading-relaxed text-slate-500">
                开启后，每个任务有一条阶段链，Agent 干完一个阶段可以推进到下一阶段、由对应的岗位接手。
                岗位自带默认链，也能按任务单独指定。
                <b className="text-slate-400"> 默认开启</b>；关掉则退回「一个人干到底」。
              </span>
            </span>
          </label>

          <div className="mt-3 border-t border-ink-500/70 pt-3">
            <label className="mb-1 block text-[11px] text-slate-400">自动换岗重试上限</label>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min="0"
                className="field w-28"
                defaultValue={system?.maxAttempts ?? 0}
                onBlur={(e) => {
                  const n = Number(e.target.value)
                  if (Number.isInteger(n) && n >= 0 && n !== (system?.maxAttempts ?? 0)) setMaxAttempts(n)
                }}
              />
              <span className="text-[10.5px] text-slate-500">0 = 不限次数</span>
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">
              任务失败或超时后会自动交给另一个空闲岗位重试（换了人接着做，不是从头来）。
              护栏：同一阶段不会重复用同一个岗位、本阶段岗位都试过就转人工、
              每次重试指数退避（2 秒起、最多 1 分钟）。卡片上有「重试 ×N」和「停止重试」。
            </p>
          </div>

          <div className="mt-3 border-t border-ink-500/70 pt-3 space-y-2">
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-boss"
                checked={system?.mcpScopeEnabled !== false}
                onChange={(e) => setMcpOption('mcpScopeEnabled', e.target.checked)}
              />
              <span>
                <span className="block text-[12px] font-medium text-slate-200">按岗位挂载 MCP</span>
                <span className="mt-0.5 block text-[10.5px] leading-relaxed text-slate-500">
                  每个任务只把该岗位用得上的 MCP 交给 Agent（在侧栏岗位详情里勾选），
                  不再把所有已启用的服务器一股脑塞进每次会话。
                  <b className="text-slate-400"> 默认开启</b>；关掉则退回「全部已启用的都挂上」。
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-boss"
                checked={system?.mcpStrict !== false}
                onChange={(e) => setMcpOption('mcpStrict', e.target.checked)}
              />
              <span>
                <span className="block text-[12px] font-medium text-slate-200">严格模式（只认按岗位挂的那些）</span>
                <span className="mt-0.5 block text-[10.5px] leading-relaxed text-slate-500">
                  关掉的话，Agent 还能看到你在应用外（项目里的 .mcp.json、用户级配置）自己加的 MCP。
                  只在 claude 侧生效。
                </span>
              </span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-boss"
                checked={system?.mcpHandoffTool !== false}
                onChange={(e) => setMcpOption('mcpHandoffTool', e.target.checked)}
              />
              <span>
                <span className="block text-[12px] font-medium text-slate-200">给 Agent「换岗」工具</span>
                <span className="mt-0.5 block text-[10.5px] leading-relaxed text-slate-500">
                  让 Agent 能自己判断「这活该换人」并发起交接。
                  关掉后它仍可用文本指令（CHAOS_HANDOFF）交接。
                </span>
              </span>
            </label>
          </div>
        </div>

        {/* 版本回退 */}
        <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-medium text-slate-200">{t('settings.versionHistory')}</span>
            <button
              className="btn-ghost"
              disabled={relBusy}
              onClick={async () => {
                // 8.0.0：检查历史版本时提示 Watt Toolkit（可关闭/不再提示）
                maybeShowWattPrompt()
                setRelBusy(true)
                setRel(await loadReleases())
                setRelBusy(false)
              }}
            >
              {relBusy ? '读取中…' : rel ? t('common.refresh') : '加载历史版本'}
            </button>
          </div>
          <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
            列出 GitHub Releases 上的全部版本。选一个会下载它的安装包（进度显示在顶栏），
            下好后仍需点顶栏「安装并重启」才真正替换 —— 与升级共用同一套确认流程，
            不会自己装上；点下去之后会静默安装完并自动重新打开。
          </p>

          <div className="mb-2 flex items-center justify-between gap-2 rounded-md border border-amber-500/25 bg-amber-500/10 px-2.5 py-1.5 text-[10.5px] text-amber-200/90">
            <span>⚡ 历史版本从 GitHub 下载；国内建议开启 Watt Toolkit / Steam++ 加速。</span>
            <button className="shrink-0 text-[10px] underline" onClick={() => useStore.getState().openWattPrompt()}>
              查看
            </button>
          </div>

          {rel?.error && <p className="text-[11px] text-rose-300">{rel.error}</p>}
          {rel && !rel.error && (rel.releases || []).length === 0 && (
            <p className="text-[11px] text-slate-500">没有可用的版本。</p>
          )}

          <div className="space-y-1.5">
            {(rel?.releases || []).map((r) => (
              <ReleaseRow key={r.tag} release={r}>
                <button
                  className="btn-ghost"
                  disabled={r.current || !r.size}
                  onClick={() => rollbackTo(r.tag)}
                  title={r.current ? '当前已是这个版本' : `下载并准备安装 ${r.tag}`}
                >
                  {r.current ? '已是此版' : '切换'}
                </button>
              </ReleaseRow>
            ))}
          </div>

          {update?.rollbackTo && update.status === 'downloading' && (
            <p className="mt-2 text-[11px] text-sky-300">
              正在下载 {update.rollbackTo}… {update.percent || 0}%
            </p>
          )}
        </div>

        {/* 8.0.0：数据导出 / 导入 */}
        <div className="flex flex-wrap items-center gap-2 border-t border-ink-600 pt-3">
          <button className="btn-ghost" onClick={exportWorkspace}>
            ⭳ {t('settings.exportWorkspace')}
          </button>
          <button className="btn-ghost" onClick={() => importRef.current?.click()}>
            ⭱ {t('settings.importWorkspace')}
          </button>
          <input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={onImportFile} />
          <span className="text-[10px] text-slate-600">{t('workspace.importConfirm')}</span>
        </div>

        {/* 数据 */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-ink-600 pt-3 text-[11px]">
          {[
            ['版本', system.version],
            ['服务端口', String(system.port)],
            ['数据目录', system.dataDir],
            ['数据库', system.dbFile],
            ['默认工作目录', system.defaultCwd],
            ['运行环境', system.isElectron ? 'Electron 桌面端' : '浏览器（开发模式）'],
          ].map(([k, v]) => (
            <div key={k} className="col-span-2 flex gap-2">
              <span className="w-20 shrink-0 text-slate-500">{k}</span>
              <span className="min-w-0 flex-1 break-all font-mono text-slate-400">{v}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-ink-600 pt-3">
          <div>
            <div className="text-[11px] text-slate-400">清空所有任务</div>
            <div className="text-[10px] text-slate-600">把看板和对话记录全部归零，员工保留</div>
          </div>
          <button
            className="btn-danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm('确定清空所有任务与对话记录？此操作不可撤销。')) return
              setBusy(true)
              await clearAllTasks()
              setBusy(false)
            }}
          >
            清空
          </button>
        </div>
      </div>

      <div className="mt-5 flex justify-end">
        <button className="btn-ghost" onClick={onClose}>
          关闭
        </button>
      </div>
    </Shell>
  )
}

/**
 * 安装更新的最后一道确认。这是唯一必须打断用户的地方 ——
 * 下载全程都不弹窗，只有「装不装」要问一次。
 */
export function InstallUpdateModal({ onClose }) {
  const update = useStore((s) => s.update)
  const system = useStore((s) => s.system)
  const installUpdate = useStore((s) => s.installUpdate)
  const downloadUpdate = useStore((s) => s.downloadUpdate)
  const loadReleases = useStore((s) => s.loadReleases)
  const rollbackTo = useStore((s) => s.rollbackTo)
  const running = useStore((s) => s.tasks.filter((t) => t.runState === 'running').length)
  const [busy, setBusy] = useState(false)
  /* 10.0.5：装哪个版本由用户定。默认收起，不干扰「升级到最新」这条主路径。 */
  const [otherOpen, setOtherOpen] = useState(false)
  const [rel, setRel] = useState(null)
  const [relBusy, setRelBusy] = useState(false)
  const [rollbacking, setRollbacking] = useState('')

  const status = update?.status || 'idle'
  const target = update?.version || system?.version || '?'
  // 9.7.0：线上 Release 正文优先，拿不到就用内置的版本简介（离线也能说清更了什么）
  const online = plainLines(update?.notes)
  const local = notesFor(target) || LATEST_NOTES
  const lines = online.length ? online : local.items
  const pct = Math.max(0, Math.min(100, Number(update?.percent) || 0))

  const loadList = async () => {
    setRelBusy(true)
    setRel(await loadReleases())
    setRelBusy(false)
  }

  return (
    <Shell
      title={status === 'downloaded' ? '安装更新' : '版本更新'}
      subtitle={`v${system?.version ?? '?'} → v${target}`}
      onClose={onClose}
    >
      <div className="space-y-3 text-[12px]">
        {/* 本次更新内容 */}
        <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="text-[12px] font-medium text-slate-200">🆕 本次更新了哪些</span>
            <span className="chip">{local.title || '新版本简介'}</span>
          </div>
          <ul className="max-h-56 space-y-1 overflow-y-auto pr-1">
            {lines.map((l, i) => (
              <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-slate-400">
                <span className="shrink-0 text-boss-strong">·</span>
                <span className="min-w-0 flex-1">{l}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* 10.0.5：其他版本 */}
        <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-slate-200">其他版本</span>
            <button
              className="btn-ghost"
              disabled={relBusy}
              onClick={async () => {
                if (!otherOpen) setOtherOpen(true)
                await loadList()
              }}
            >
              {relBusy ? '读取中…' : rel ? '刷新列表' : otherOpen ? '加载版本列表' : '选择其他版本'}
            </button>
          </div>
          <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">
            要装回旧版、或换到某个特定版本，在这里下它的安装包。下载完仍要点「安装并重启」才生效，
            和正常升级走同一套确认流程。
          </p>
          {otherOpen && (
            <div className="mt-2 space-y-1.5">
              {rel?.error && <p className="text-[11px] text-rose-300">{rel.error}</p>}
              {rel && !rel.error && (rel.releases || []).length === 0 && (
                <p className="text-[11px] text-slate-500">没有可用的版本。</p>
              )}
              <div className="max-h-52 space-y-1.5 overflow-y-auto pr-1">
                {(rel?.releases || []).map((r) => (
                  <ReleaseRow key={r.tag} release={r}>
                    <button
                      className="btn-ghost"
                      disabled={r.current || !r.assetName || Boolean(rollbacking) || status === 'downloading'}
                      onClick={async () => {
                        setRollbacking(r.tag)
                        await rollbackTo(r.tag)
                        setRollbacking('')
                      }}
                      title={r.current ? '当前已是这个版本' : `下载 ${r.tag} 的安装包`}
                    >
                      {r.current ? '已是此版' : rollbacking === r.tag ? '下发中' : '下载'}
                    </button>
                  </ReleaseRow>
                ))}
              </div>
            </div>
          )}
        </div>

        {status === 'downloading' && (
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11.5px] text-sky-300">
              <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
              正在下载升级包… {pct}%
              {update?.total ? <span className="text-slate-500">（{fmtBytes(update.total)}）</span> : null}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-700">
              <span className="block h-full rounded-full bg-sky-400 transition-all" style={{ width: `${pct}%` }} />
            </div>
            <p className="mt-1 text-[10.5px] text-slate-500">下载期间可以继续用，下完再问你装不装。</p>
          </div>
        )}

        {status === 'downloaded' && (
          <>
            <p className="leading-relaxed text-slate-400">
              安装包已下载完成{update?.total ? `（${fmtBytes(update.total)}）` : ''}。点「安装并重启」后
              应用会退出并<b className="text-slate-300">静默安装</b>
              （不会再弹安装向导，屏幕上会安静十几秒），装完<b className="text-slate-300">自动重新打开</b>，
              不需要你再点任何东西。
            </p>
            <p className="rounded-lg border border-emerald-600/40 bg-emerald-900/20 px-3 py-2 text-[11px] leading-relaxed text-emerald-200/90">
              🔐 你的数据、岗位、对话、知识库都保存在用户目录里，升级不会动它们。
            </p>
            {running > 0 && (
              <p className="rounded-lg border border-rose-600/60 bg-rose-900/30 px-3 py-2 leading-relaxed text-rose-200">
                当前有 <b>{running}</b> 个任务正在执行，安装会中断它们。建议等任务跑完再来。
              </p>
            )}
          </>
        )}

        {(status === 'available' || status === 'idle' || status === 'latest') && (
          <p className="leading-relaxed text-slate-400">
            下载和安装都不会动你的数据。点下面的按钮开始升级，下载完会让你确认一次再安装。
          </p>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose} disabled={busy}>
          {status === 'downloading' ? '后台继续' : '稍后'}
        </button>
        {status === 'downloaded' ? (
          <button
            className="btn-success"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              await installUpdate()
              onClose()
            }}
          >
            安装并重启
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={busy || status === 'downloading'}
            onClick={async () => {
              setBusy(true)
              await downloadUpdate()
              setBusy(false)
            }}
          >
            {status === 'downloading' ? `下载中 ${pct}%` : `↓ 下载并升级到 v${target}`}
          </button>
        )}
      </div>
    </Shell>
  )
}
