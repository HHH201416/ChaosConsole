import { useState, useRef, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { COLUMN_MAP, RUN_STATE_META, EVENT_META, formatTime, relativeTime, roleColor, stageLabel } from '../lib/meta'
import { useT } from '../lib/useT'
import ChaosDock, { Pins, Snaps, Drafts, TTS } from './ChaosDock'

/* ------------------------------------------------------------------ *
 * 单条消息
 * ------------------------------------------------------------------ */

/** 拆出 <think>…</think> 思考过程（思辨模型的标志性输出） */
function splitThink(content) {
  const text = String(content || '')
  const parts = []
  const re = /<think>([\s\S]*?)(<\/think>|$)/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ think: false, text: text.slice(last, m.index) })
    parts.push({ think: true, text: m[1] })
    last = m.index + m[0].length
  }
  if (last < text.length) parts.push({ think: false, text: text.slice(last) })
  return parts.filter((p) => p.text.trim())
}

function ThinkBlock({ text }) {
  // 9.8.0：默认展开 —— 用户要求「深度思考中生成的内容都要显示」，
  // 所以不再折叠、也不再限制高度，推理草稿原样铺开（内容本身服务端已不截断）
  const [open, setOpen] = useState(true)
  const chars = String(text || '').length
  // 9.6.1：思考草稿统一用灰色（原来紫色太抢眼，抢了正文的注意力）
  return (
    <div className="mb-1.5 rounded-lg border border-ink-500 bg-ink-700/40">
      <button
        className="flex w-full items-center gap-1.5 px-2 py-1 text-[10.5px] text-slate-400 hover:text-slate-300"
        onClick={() => setOpen((v) => !v)}
      >
        🧠 思考过程
        <span className="font-mono text-[9.5px] text-slate-600">{chars} 字</span>
        <span className="ml-auto">{open ? '收起' : '展开'}</span>
      </button>
      {open && (
        <pre className="whitespace-pre-wrap break-words border-t border-ink-500 px-2 py-1.5 font-mono text-[10.5px] leading-snug text-slate-500">
          {text.trim()}
        </pre>
      )}
    </div>
  )
}

function Bubble({ message, agent, executorLabel, taskId }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'
  const [pinned, setPinned] = useState(() => (taskId ? Pins.has(taskId, message.id) : false))

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[92%] rounded-lg border border-boss/25 bg-boss/10 px-3 py-1.5 text-[11px] leading-relaxed text-boss-strong">
          {message.content}
        </div>
      </div>
    )
  }

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-xl rounded-br-sm bg-boss/15 px-3 py-2 text-[12.5px] leading-relaxed text-amber-50">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
          <div className="mt-1 text-right font-mono text-[10px] text-amber-200/40">
            {formatTime(message.createdAt).slice(11)}
          </div>
        </div>
      </div>
    )
  }

  // Agent 回复：只显示「是干什么的」，不显示姓名
  const fnLabel = agent?.functionLabel || 'Agent'
  // 9.3.8：控制指令行（CHAOS_ASK/STAGE/HANDOFF）不在气泡里露原文 —— 提问已由
  // 系统消息高亮，阶段/换岗由事件流展示
  const sections = splitThink(message.content)
    .map((p) =>
      p.think
        ? p
        : {
            ...p,
            text: p.text
              .split('\n')
              .filter((l) => !/^\s*CHAOS_(STAGE|HANDOFF|ASK):/.test(l))
              .join('\n'),
          },
    )
    .filter((p) => p.text.trim())
  const visible = sections.filter((p) => !p.think).map((p) => p.text).join('\n')
  const chars = message.content?.length || 0

  return (
    <div className="group flex justify-start">
      <div className="max-w-[92%]">
        <div className="mb-1 flex items-center gap-1.5 pl-1">
          <span className={`rounded px-1.5 py-[1px] text-[10px] font-medium ${roleColor(agent?.role)}`}>
            {fnLabel}
          </span>
          {executorLabel && (
            <span className="font-mono text-[10px] text-slate-600">{executorLabel}</span>
          )}
          <span className="ml-1 hidden items-center gap-1 group-hover:flex">
            <button
              className={`text-[10px] ${pinned ? 'text-boss-strong' : 'text-slate-600 hover:text-slate-300'}`}
              title={pinned ? '取消钉住' : '钉住这条回答'}
              onClick={() => {
                if (!taskId) return
                setPinned(Pins.toggle(taskId, message))
              }}
            >
              📌
            </button>
            <button
              className="text-[10px] text-slate-600 hover:text-slate-300"
              title="朗读 / 停止（本地语音）"
              onClick={() => TTS.toggle(visible || message.content)}
            >
              🔊
            </button>
            <button
              className="text-[10px] text-slate-600 hover:text-slate-300"
              title="复制全文"
              onClick={() => navigator.clipboard?.writeText(message.content)}
            >
              📋
            </button>
          </span>
        </div>
        <div className="rounded-xl rounded-bl-sm bg-ink-600/70 px-3 py-2 text-[12.5px] leading-relaxed text-slate-200">
          {sections.map((p, i) =>
            p.think ? <ThinkBlock key={i} text={p.text} /> : (
              <div key={i} className="whitespace-pre-wrap break-words">
                {p.text}
              </div>
            ),
          )}
          <div className="mt-1 flex items-center gap-2 font-mono text-[10px] text-slate-500">
            <span>{formatTime(message.createdAt).slice(11)}</span>
            <span>· {chars} 字</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 9.3.8：单条事件（对话流内联显示）—— 工具调用 / 派单 / 知识库命中 / 统计等
 * ------------------------------------------------------------------ */

function EventRow({ e }) {
  const meta = EVENT_META[e.type] || EVENT_META.info
  return (
    <div className="flex gap-2 rounded-md bg-ink-700/50 px-2 py-1.5">
      <span className={`mt-[1px] w-3 shrink-0 text-center text-[11px] ${meta.cls}`}>{meta.icon}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          {e.name && <span className={`text-[11px] font-medium ${meta.cls}`}>{e.name}</span>}
          <span className="ml-auto shrink-0 font-mono text-[10px] text-slate-600">
            {formatTime(e.createdAt).slice(11)}
          </span>
        </div>
        {e.content && (
          <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[10.5px] leading-snug text-slate-400">
            {e.content}
          </pre>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 模型选择器（8.0.2：混沌置顶默认，新对话也能选）
 * ------------------------------------------------------------------ */

function ModelPicker({ task, agent, executors, onChange, disabled, chaosUp }) {
  const draftExecutor = useStore((s) => s.draftExecutor)
  const draftModel = useStore((s) => s.draftModel)
  const setDraftExecutor = useStore((s) => s.setDraftExecutor)
  const hasTask = Boolean(task || agent)

  // 混沌排最前（可置默认），其余执行器按原顺序跟在后面
  const ordered = useMemo(() => {
    const chaos = executors.filter((e) => e.id === 'chaos')
    const rest = executors.filter((e) => e.id !== 'chaos')
    return [...chaos, ...rest]
  }, [executors])

  // 9.5.0：岗位/新对话挂上混沌就一路用混沌 —— 不再因为引擎没起而退回其他执行器
  const currentExecutor = hasTask
    ? task?.executor || agent?.executor || 'chaos'
    : draftExecutor || 'chaos'
  const list = ordered.find((e) => e.id === currentExecutor)
  const models = list?.models || []
  const currentModel = hasTask
    ? task?.model || agent?.model || models[0]?.id || ''
    : draftModel || models[0]?.id || ''

  const change = (patch) => {
    if (hasTask) onChange(patch)
    else setDraftExecutor(patch.executor, patch.model || '')
  }

  return (
    /* min-w-0 一路给到 select：窄面板（288px）时这一行只差 1px 就放不下，
       不给它们让位的空间，右边那句「自动派单」就会被折成两行。 */
    <div className="flex min-w-0 items-center gap-1.5">
      <select
        value={currentExecutor}
        disabled={disabled}
        onChange={(e) => change({ executor: e.target.value, model: '' })}
        className="min-w-0 rounded border border-ink-500 bg-ink-700 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-300 focus:border-boss focus:outline-none"
        title="用哪个引擎干活（混沌 = 本地免费模型）"
      >
        {ordered.map((e) => (
          <option key={e.id} value={e.id} disabled={!e.available}>
            {e.id === 'chaos' ? '🌀 ' : ''}
            {e.label}
            {e.available ? '' : '（未安装）'}
          </option>
        ))}
      </select>

      <select
        value={currentModel}
        disabled={disabled || !models.length}
        onChange={(e) => change({ model: e.target.value })}
        className="min-w-0 rounded border border-ink-500 bg-ink-700 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-300 focus:border-boss focus:outline-none"
        title="这次对话用哪个模型"
      >
        {models.length === 0 && <option value="">无可用模型</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.id === 'chaos' ? '🌀 ' : ''}
            {m.label || m.id}
            {m.installed ? '' : '（未下载）'}
          </option>
        ))}
      </select>
    </div>
  )
}

/** ⚡🧠：快思 / 慢想一键切换（在已装的模型里来回切普通档与思辨档） */
function ThinkToggle({ task, onChange, disabled }) {
  const chaosStatus = useStore((s) => s.chaosStatus)
  const installed = (chaosStatus?.catalog || []).filter((m) => m.installed)
  const thinking = installed.find((m) => m.id.startsWith('deepseek-r1'))
  const normal = installed.find((m) => m.id.startsWith('qwen2.5'))
  if (!task?.id || !thinking) return null
  const isThink = String(task.model || '').startsWith('deepseek-r1')
  return (
    <button
      disabled={disabled}
      onClick={() => onChange({ model: isThink ? normal?.id || thinking.id : thinking.id })}
      className="shrink-0 rounded border border-ink-500 bg-ink-700 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-300 hover:border-ink-400 disabled:opacity-50"
      title={isThink ? '当前是「慢想」思辨模式，点此切回快速回答' : '切到「慢想」：思辨模型先推理再回答（更慢但更深）'}
    >
      {isThink ? '🧠 慢想' : '⚡ 快思'}
    </button>
  )
}

/* ------------------------------------------------------------------ *
 * 主面板
 * ------------------------------------------------------------------ */

const EXAMPLES = [
  '帮我给这个项目补一个 README',
  '调研一下 Electron 自动更新的最佳实践',
  '鸿蒙 ArkTS 里怎么做一个列表页面',
  '给登录接口写一组边界测试',
]

const MEMORY_RE = /^\s*记住[:：]\s*/i

export default function ChatPanel() {
  const t = useT()
  const detail = useStore((s) => s.detail)
  const detailLoading = useStore((s) => s.detailLoading)
  const system = useStore((s) => s.system)
  const paperMode = useStore((s) => s.paperMode)
  const zenMode = useStore((s) => s.zenMode)
  const toggleZenMode = useStore((s) => s.toggleZenMode)
  const chaosStatus = useStore((s) => s.chaosStatus)
  const addChaosMemory = useStore((s) => s.addChaosMemory)
  const regenerateTask = useStore((s) => s.regenerateTask)
  const { sendChat, selectTask, newConversation, setConversationModel, startTask, cancelTask, openHandoff } =
    useStore()

  const [draft, setDraft] = useState('')
  const [showEvents, setShowEvents] = useState(false)
  const [voiceOn, setVoiceOn] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)
  const voiceRef = useRef(null)
  const loadDraftFor = useRef(null)

  const executors = Array.isArray(system?.executors) ? system.executors : []
  const chaosUp = Boolean(system?.chaos?.serverUp)
  const messages = Array.isArray(detail?.messages) ? detail.messages : []
  const events = Array.isArray(detail?.events) ? detail.events : []
  const task = detail?.task
  const agent = detail?.agent

  const executorLabel = useMemo(() => {
    if (!task && !agent) return ''
    const id = task?.executor || agent?.executor || 'claude'
    const model = task?.model || agent?.model || ''
    return model ? `${id} · ${model}` : id
  }, [task, agent])

  const isRunning = task?.runState === 'running' || task?.runState === 'queued'

  // 阶段徽章与重试次数（与看板卡片同一套口径）
  const stages = Array.isArray(task?.pipeline) ? task.pipeline : []
  const stageIdx = stages.findIndex((s) => s.stage === task?.stage)
  const stageText =
    stages.length && task?.stage ? `${stageLabel(task.stage)} ${stageIdx >= 0 ? stageIdx + 1 : '?'}/${stages.length}` : ''
  const attempts = task?.attempts || 0

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, events.length])

  // 8.0.2：草稿自动保存（按对话隔离；换对话 / 重启都不丢）
  useEffect(() => {
    const key = task?.id || null
    if (loadDraftFor.current !== key) {
      loadDraftFor.current = key
      setDraft(Drafts.load(key))
      return
    }
    Drafts.save(key, draft)
  }, [draft, task?.id])

  // 9.0.0：技能页 / 专家页选中的模板 → 填进输入框（消费后清空 store 字段）
  const skillDraft = useStore((s) => s.skillDraft)
  const setSkillDraft = useStore((s) => s.setSkillDraft)
  useEffect(() => {
    if (!skillDraft) return
    setDraft(skillDraft)
    setSkillDraft(null)
    inputRef.current?.focus()
  }, [skillDraft, setSkillDraft])

  // 8.0.2：时光机快照 —— 消息一变就记一个本地快照（最近 20 个）
  useEffect(() => {
    if (!task?.id || !messages.length) return
    const lastUser = [...messages].reverse().find((m) => m.role === 'user')
    Snaps.push(task.id, messages.length, lastUser ? lastUser.content.slice(0, 60) : task.title)
  }, [messages.length, task?.id])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    // 8.0.2：长期记忆 —— 「记住：xxx」不发给模型，直接沉淀进本地记忆
    if (MEMORY_RE.test(text)) {
      addChaosMemory(text)
      setDraft('')
      return
    }
    // 执行中也允许发送：后端会把它排队，等当前回合结束再用同一个会话续跑
    // （queue.sendInput）—— 上面「执行中 · 可继续补充指令」的提示和这个按钮
    // 一直是这么承诺的，之前这里却被 isRunning 直接挡掉了，按了没有任何反应。
    setDraft('')
    sendChat({ text })
  }

  const onModelChange = (patch) => {
    if (!selectedTaskId) return
    setConversationModel(selectedTaskId, patch)
  }

  // 8.0.2：语音输入（Web Speech Recognition；不可用时按钮不出现）
  const voiceSupported =
    typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

  const toggleVoice = () => {
    if (voiceOn) {
      voiceRef.current?.stop?.()
      setVoiceOn(false)
      return
    }
    const Rec = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!Rec) return
    const rec = new Rec()
    rec.lang = 'zh-CN'
    rec.continuous = true
    rec.interimResults = false
    rec.onresult = (e) => {
      let add = ''
      for (let i = e.resultIndex; i < e.results.length; i += 1) {
        if (e.results[i].isFinal) add += e.results[i][0].transcript
      }
      if (add) setDraft((cur) => `${cur}${cur && !cur.endsWith(' ') ? ' ' : ''}${add}`)
    }
    rec.onend = () => setVoiceOn(false)
    rec.onerror = () => setVoiceOn(false)
    voiceRef.current = rec
    rec.start()
    setVoiceOn(true)
  }

  const panel = (
    <aside
      className={`relative flex min-w-0 flex-1 flex-col bg-ink-800 ${
        zenMode ? 'h-full w-full max-w-4xl border border-ink-500 shadow-2xl' : 'border-l border-ink-600'
      }`}
    >
      {/* 头部 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-600 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-slate-100">{t('chat.title')}</span>
            {isRunning && (
              <span className="flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300">
                <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
                {t('chat.running')}
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-slate-500">
            {task ? task.title : t('chat.emptyTitle')}
          </div>
        </div>

        <button
          className="btn-ghost shrink-0 px-2 py-1 text-[11px]"
          onClick={() => useStore.getState().togglePreview()}
          title="预览面板：在旁边查看文件与知识库"
        >
          👁 预览
        </button>
        <button
          className="btn-ghost shrink-0 px-2 py-1 text-[11px]"
          onClick={() => {
            newConversation()
            inputRef.current?.focus()
          }}
          title="开始一个新对话"
        >
          {t('chat.newConversation')}
        </button>
        {zenMode && (
          <button className="btn-ghost shrink-0 px-2 py-1 text-[11px]" onClick={toggleZenMode}>
            退出禅模式
          </button>
        )}
      </div>

      {/* 元信息条 */}
      {task && (
        <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-ink-600 px-4 py-2 text-[10.5px]">
          <span className={`chip bg-ink-600 ${(COLUMN_MAP[task.status] || {}).text || ''}`}>
            {(COLUMN_MAP[task.status] || {}).label || task.status}
          </span>
          <span className={`chip bg-ink-600 ${(RUN_STATE_META[task.runState] || {}).cls || ''}`}>
            {(RUN_STATE_META[task.runState] || {}).label || task.runState}
          </span>
          {agent && (
            <span className={`rounded px-1.5 py-[1px] text-[10px] font-medium ${roleColor(agent.role)}`}>
              {agent.functionLabel}
            </span>
          )}
          <span className="chip">{executorLabel}</span>
          {stageText && <span className="chip bg-violet-500/15 text-violet-300">{stageText}</span>}
          {attempts > 0 && (
            <span className="chip bg-amber-500/15 text-amber-300">{t('task.retryTimes', { n: attempts })}</span>
          )}
          {(task.blockedBy || []).length > 0 && (
            <span className="chip bg-rose-500/15 text-rose-300" title={(task.blockedBy || []).join(', ')}>
              🔒 {t('task.blockedCount', { n: task.blockedBy.length })}
            </span>
          )}

          <div className="ml-auto flex gap-1">
            <button
              className="rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-ink-600 hover:text-slate-100"
              onClick={() => regenerateTask(task.id)}
              disabled={isRunning}
              title="重新生成最后一条回答（🔁 换个思路再答一次）"
            >
              🔁
            </button>
            {/* 9.5.4：右上角「事件」切换按钮已按用户要求移除 ——
                事件仍按时间线内联在对话流里（9.3.8 的设计），不需要独立视图入口 */}
            <button
              className="rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-ink-600 hover:text-slate-100"
              onClick={() => openHandoff(task.id)}
              title="交给另一个岗位接手（运行中会交接，不是中断）"
            >
              {t('task.handoff')}
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-ink-600 hover:text-slate-100"
              onClick={() => (isRunning ? cancelTask(task.id) : startTask(task.id))}
              disabled={task.status === 'complete' && !isRunning || (task.blockedBy || []).length > 0}
              title={isRunning ? '中断执行' : '重跑这个对话'}
            >
              {isRunning ? t('chat.stop') : t('chat.rerun')}
            </button>
          </div>
        </div>
      )}

      {/* 消息流（9.1.0：居中阅读列，全宽下更好读） */}
      <div
        className={`min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3 ${
          paperMode ? 'bg-[#f4ecd8] [--paper:on]' : ''
        }`}
      >
        <div className="mx-auto w-full max-w-3xl">
        {!task && !detailLoading && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 text-4xl opacity-25">💬</div>
            <p className="text-[12px] leading-relaxed text-slate-500">{t('chat.emptyTitle')}</p>
            <div className="mt-5 flex w-full flex-col gap-1.5">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  onClick={() => {
                    setDraft(ex)
                    inputRef.current?.focus()
                  }}
                  className="rounded-lg border border-ink-500 bg-ink-700/50 px-3 py-1.5 text-left text-[11.5px] text-slate-400 transition-colors hover:border-ink-400 hover:text-slate-200"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}

        {detailLoading && !task && <p className="py-8 text-center text-xs text-slate-600">{t('chat.loading')}</p>}

        {/* 9.3.8：消息 + 事件按时间线穿插，工具调用/派单/知识库命中等全程可见。
            showEvents 打开时回到纯事件清单视图。 */}
        {task &&
          !showEvents &&
          [
            ...messages.map((m) => ({ kind: 'msg', t: m.createdAt, m })),
            ...events.map((e) => ({ kind: 'evt', t: e.createdAt, e })),
          ]
            .sort((a, b) => a.t - b.t)
            .map((it) =>
              it.kind === 'msg' ? (
                <Bubble
                  key={`m${it.m.id}`}
                  message={it.m}
                  agent={agent}
                  executorLabel={it.m.role === 'assistant' ? executorLabel : ''}
                  taskId={task.id}
                />
              ) : (
                <EventRow key={`e${it.e.id}`} e={it.e} />
              ),
            )}

        {task && showEvents && (
          <div className="space-y-1.5">
            {events.length === 0 && <p className="py-8 text-center text-xs text-slate-600">{t('chat.noEvents')}</p>}
            {events.map((e) => (
              <EventRow key={e.id} e={e} />
            ))}
          </div>
        )}

        {isRunning && (
          <div className="flex items-center gap-2 pl-1 text-[11px] text-sky-300">
            <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
            {t('chat.runningHint', { name: agent?.functionLabel || 'Agent' })}
          </div>
        )}

        <div ref={endRef} />
        </div>
      </div>

      {/* 输入区（9.1.0：与消息列同宽居中） */}
      <div className="shrink-0 border-t border-ink-600 p-3">
        <div className="mx-auto w-full max-w-3xl">
        {/* 8.0.2：Token 用尽的友好提醒（每日 3000 万免费 + 手机号绑定出路） */}
        {(() => {
          const q = chaosStatus?.quota
          if (!q || q.unlimited || Number(q.remaining) > 0) return null
          return (
            <div className="mb-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[10.5px] leading-relaxed text-amber-200">
              今日 Token 已用完，混沌暂时不能回答（每天自动重发 3000 万）。可打开顶栏 🌀 面板填手机号完成绑定。
            </div>
          )
        })()}
        <ChaosDock
          task={task}
          messages={messages}
          events={events}
          draft={draft}
          setDraft={setDraft}
          inputRef={inputRef}
        />

        <div className="mb-2 flex items-center justify-between">
          <div className="flex min-w-0 items-center gap-1.5">
            <ModelPicker
              task={task}
              agent={agent}
              executors={executors}
              onChange={onModelChange}
              disabled={isRunning}
              chaosUp={chaosUp}
            />
            <ThinkToggle task={task} onChange={onModelChange} disabled={isRunning} />
          </div>
          <span className="shrink-0 whitespace-nowrap pl-1.5 text-[10px] text-slate-600">
            {isRunning ? t('chat.executionHint') : task ? t('chat.continue') : t('chat.autoAssign')}
          </span>
        </div>

        <div className="flex items-end gap-2">
          {voiceSupported && (
            <button
              onClick={toggleVoice}
              title="语音输入（说完自动转文字填进输入框）"
              className={`shrink-0 rounded-lg border px-2 py-1.5 text-[14px] leading-none ${
                voiceOn ? 'animate-pulse border-rose-400/60 bg-rose-500/15' : 'border-ink-500 bg-ink-700/60 hover:border-ink-400'
              }`}
            >
              🎙
            </button>
          )}
          <textarea
            ref={inputRef}
            rows={2}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder={task ? t('chat.placeholderTask') : t('chat.placeholder')}
            className="field resize-none py-1.5 text-[12px]"
          />
          <button className="btn-primary h-9 px-3 text-[12px]" disabled={!draft.trim()} onClick={submit}>
            {t('chat.send')}
          </button>
        </div>
        </div>
      </div>
    </aside>
  )

  // 禅模式：面板浮成全屏（遮住看板），其余照旧
  if (zenMode) {
    return <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-6">{panel}</div>
  }
  return panel
}
