import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { ROLE_PRESETS, fmtBytes } from '../lib/meta'

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
          <h3 className="text-base font-semibold text-white">{title}</h3>
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
  const createTask = useStore((s) => s.createTask)
  const system = useStore((s) => s.system)
  const agents = useStore((s) => s.agents)
  const [form, setForm] = useState({
    title: '',
    description: '',
    tags: [],
    cwd: system?.defaultCwd || '',
    agentId: '',
  })
  const [busy, setBusy] = useState(false)
  const titleRef = useRef(null)

  useEffect(() => titleRef.current?.focus(), [])

  const toggleTag = (t) =>
    setForm((f) => ({ ...f, tags: f.tags.includes(t) ? f.tags.filter((x) => x !== t) : [...f.tags, t] }))

  const submit = async () => {
    if (!form.title.trim() || busy) return
    setBusy(true)
    const created = await createTask({
      title: form.title,
      description: form.description,
      tags: form.tags,
      cwd: form.cwd,
      agentId: form.agentId || undefined,
    })
    setBusy(false)
    if (created) onClose()
  }

  return (
    <Shell
      title="新建任务"
      subtitle="任务进入「进行中」时，后端会自动挑一个空闲岗位接手"
      onClose={onClose}
      width="w-[36rem]"
    >
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-[11px] text-slate-400">任务名称 *</label>
          <input
            ref={titleRef}
            className="field"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            placeholder="例如：给登录页加上失败重试与错误提示"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-slate-400">详细说明（会作为任务描述发给 Agent）</label>
          <textarea
            rows={5}
            className="field resize-none text-[12px] leading-relaxed"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder="背景、要改哪些文件、验收标准、不要动什么…"
          />
        </div>

        <div>
          <label className="mb-1 block text-[11px] text-slate-400">标签</label>
          <div className="flex flex-wrap gap-1.5">
            {TAG_PRESETS.map((t) => (
              <button
                key={t}
                onClick={() => toggleTag(t)}
                className={`rounded px-2 py-1 font-mono text-[11px] transition-colors ${
                  form.tags.includes(t)
                    ? 'bg-boss/20 text-boss ring-1 ring-boss/50'
                    : 'bg-ink-600 text-slate-400 hover:bg-ink-500'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-[11px] text-slate-400">执行路径（Agent 的工作目录）</label>
            <input
              className="field font-mono text-[11px]"
              value={form.cwd}
              onChange={(e) => setForm({ ...form, cwd: e.target.value })}
              placeholder="D:\\你的项目目录"
            />
          </div>
          <div className="w-44">
            <label className="mb-1 block text-[11px] text-slate-400">指定岗位</label>
            <select
              className="field"
              value={form.agentId}
              onChange={(e) => setForm({ ...form, agentId: e.target.value })}
            >
              <option value="">自动分配</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.functionLabel}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose}>
          取消
        </button>
        <button className="btn-primary" disabled={!form.title.trim() || busy} onClick={submit}>
          {busy ? '创建中…' : '创建任务'}
        </button>
      </div>
    </Shell>
  )
}

/* ------------------------------------------------------------------ *
 * MCP 管理
 * ------------------------------------------------------------------ */

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
              <span className="rounded bg-boss/15 px-1.5 py-[1px] text-[9.5px] text-boss">需密钥</span>
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
  const shown = tab === 'installable' ? installable : needsKey

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
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`-mb-px border-b-2 px-3 py-2 text-[12px] transition-colors ${
              tab === t.key ? 'border-boss text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
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
 * 下载加速镜像。留空 = 直连 GitHub。
 *
 * 为什么值得单独一个设置项：本机的 hosts 被加速器改过，GitHub 的发布包域名被指到
 * 127.0.0.1，于是所有下载都过本机代理 —— 实测只有 ~0.1MB/s，87MB 要十几分钟；
 * 给地址套一个公共镜像前缀能到 5MB/s 左右。
 *
 * 代价必须写清楚：镜像返回的就是接下来会被执行的安装包，等于把下载交给了第三方。
 * 应用会在下载完拿该版本自己的 latest.yml 校验 sha512（基准走 GitHub API，不经镜像），
 * 不符直接丢弃 —— 但这仍然是个需要用户知情的取舍。
 */
const MIRROR_PRESETS = ['https://gh-proxy.com', 'https://ghfast.top']

function DownloadMirrorField() {
  const system = useStore((s) => s.system)
  const setDownloadMirror = useStore((s) => s.setDownloadMirror)
  const saved = system?.downloadMirror || ''
  const [value, setValue] = useState(saved)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setValue(saved)
  }, [saved])

  const dirty = value.trim().replace(/\/+$/, '') !== saved

  const save = async (next) => {
    const v = next === undefined ? value.trim() : next
    setBusy(true)
    await setDownloadMirror(v)
    setBusy(false)
  }

  return (
    <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[12px] font-medium text-slate-200">下载加速镜像</span>
        <span className={`font-mono text-[10px] ${saved ? 'text-emerald-400' : 'text-slate-600'}`}>
          {saved ? '已开启' : '直连'}
        </span>
      </div>
      <div className="flex gap-2">
        <input
          className="field flex-1"
          placeholder="留空 = 直连；例：https://gh-proxy.com"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && dirty && !busy && save()}
          spellCheck={false}
        />
        <button className="btn-ghost shrink-0" disabled={busy || !dirty} onClick={() => save()}>
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {MIRROR_PRESETS.map((m) => (
          <button key={m} className="btn-ghost" disabled={busy || m === saved} onClick={() => save(m)}>
            {m.replace(/^https:\/\//, '')}
          </button>
        ))}
        {saved && (
          <button className="btn-ghost" disabled={busy} onClick={() => save('')}>
            关闭（直连）
          </button>
        )}
      </div>
      <p className="mt-1.5 text-[10.5px] leading-relaxed text-slate-500">
        升级和版本回退的安装包都走这里下。GitHub 的发布包域名被本机加速器劫持到
        <b className="text-slate-400"> 127.0.0.1</b>，实测只有 ~0.1MB/s（87MB 要十几分钟），
        套一个公共镜像前缀能到 <b className="text-emerald-400">5MB/s</b> 左右。
        <br />
        <b className="text-boss">代价</b>：镜像返回的就是接下来会被执行的安装包，
        等于把下载交给第三方。所以下载完会拿该版本自己的
        <b className="text-slate-400"> latest.yml </b>校验 sha512（基准走 GitHub API、不经镜像），
        不符就丢弃、不装。介意的话留空。
      </p>
    </div>
  )
}

export function SettingsModal({ onClose }) {
  const system = useStore((s) => s.system)
  const setPermissionMode = useStore((s) => s.setPermissionMode)
  const setDevecoAutoApprove = useStore((s) => s.setDevecoAutoApprove)
  const setAutoUpdateWhenIdle = useStore((s) => s.setAutoUpdateWhenIdle)
  const loadReleases = useStore((s) => s.loadReleases)
  const rollbackTo = useStore((s) => s.rollbackTo)
  const update = useStore((s) => s.update)
  const [rel, setRel] = useState(null)
  const [relBusy, setRelBusy] = useState(false)
  const clearAllTasks = useStore((s) => s.clearAllTasks)
  const [busy, setBusy] = useState(false)

  if (!system) return null

  return (
    <Shell title="运行设置" subtitle="这些选项决定 Agent 如何被拉起执行" onClose={onClose}>
      <div className="space-y-4 text-[12px]">
        {/* 执行器状态 */}
        <div className="space-y-2">
          {(system.executors || []).map((e) => (
            <div key={e.id} className="rounded-lg border border-ink-500 bg-ink-900 p-3">
              <div className="mb-1.5 flex items-center gap-2">
                <span className={`h-2 w-2 rounded-full ${e.available ? 'bg-emerald-500' : 'bg-boss'}`} />
                <span className="font-medium text-slate-200">{e.label}</span>
                <span className="font-mono text-[10px] text-slate-600">
                  {e.available ? `${e.models.length} 个模型可用` : '未安装'}
                </span>
              </div>
              <p className="text-[10.5px] text-slate-500">{e.hint}</p>
              {e.available && (
                <p className="mt-1 break-all font-mono text-[10px] text-slate-600">
                  {e.models.map((m) => m.id).join(' · ')}
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
                <b className="text-boss"> 默认关闭</b>，此时它会驳回未经批准的敏感操作，
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

        {/* 版本回退 */}
        <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-medium text-slate-200">版本回退</span>
            <button
              className="btn-ghost"
              disabled={relBusy}
              onClick={async () => {
                setRelBusy(true)
                setRel(await loadReleases())
                setRelBusy(false)
              }}
            >
              {relBusy ? '读取中…' : rel ? '刷新' : '加载历史版本'}
            </button>
          </div>
          <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
            列出 GitHub Releases 上的全部版本。选一个会下载它的安装包（进度显示在顶栏），
            下好后仍需点顶栏「安装并重启」才真正替换 —— 与升级共用同一套确认流程，
            不会自己装上。
          </p>

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
  const running = useStore((s) => s.tasks.filter((t) => t.runState === 'running').length)
  const [busy, setBusy] = useState(false)

  return (
    <Shell
      title="安装更新"
      subtitle={`v${system?.version ?? '?'} → v${update?.version ?? '?'}`}
      onClose={onClose}
    >
      <div className="space-y-3 text-[12px]">
        <p className="leading-relaxed text-slate-400">
          安装包已下载完成{update?.total ? `（${fmtBytes(update.total)}）` : ''}。点「安装并重启」后
          应用会退出，安装程序自动完成安装并重新打开，大约需要一分钟。
        </p>

        {running > 0 && (
          <p className="rounded-lg border border-rose-600/60 bg-rose-900/30 px-3 py-2 leading-relaxed text-rose-200">
            当前有 <b>{running}</b> 个任务正在执行，安装会中断它们。建议等任务跑完再来。
          </p>
        )}
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <button className="btn-ghost" onClick={onClose} disabled={busy}>
          稍后
        </button>
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
      </div>
    </Shell>
  )
}
