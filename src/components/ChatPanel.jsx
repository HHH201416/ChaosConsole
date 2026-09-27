import { useState, useRef, useEffect, useMemo } from 'react'
import { useStore } from '../store'
import { COLUMN_MAP, RUN_STATE_META, EVENT_META, formatTime, relativeTime, roleColor, stageLabel } from '../lib/meta'

/* ------------------------------------------------------------------ *
 * 单条消息
 * ------------------------------------------------------------------ */

function Bubble({ message, agent, executorLabel }) {
  const isUser = message.role === 'user'
  const isSystem = message.role === 'system'

  if (isSystem) {
    return (
      <div className="flex justify-center">
        <div className="max-w-[92%] rounded-lg border border-boss/25 bg-boss/10 px-3 py-1.5 text-[11px] leading-relaxed text-boss">
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
  return (
    <div className="flex justify-start">
      <div className="max-w-[92%]">
        <div className="mb-1 flex items-center gap-1.5 pl-1">
          <span className={`rounded px-1.5 py-[1px] text-[10px] font-medium ${roleColor(agent?.role)}`}>
            {fnLabel}
          </span>
          {executorLabel && (
            <span className="font-mono text-[10px] text-slate-600">{executorLabel}</span>
          )}
        </div>
        <div className="rounded-xl rounded-bl-sm bg-ink-600/70 px-3 py-2 text-[12.5px] leading-relaxed text-slate-200">
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
          <div className="mt-1 font-mono text-[10px] text-slate-500">
            {formatTime(message.createdAt).slice(11)}
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 对话历史列表
 * ------------------------------------------------------------------ */

function HistoryList({ conversations, currentId, onPick, onClose }) {
  return (
    <div className="absolute inset-x-0 top-0 z-20 flex h-full flex-col border-r border-ink-600 bg-ink-800/98 backdrop-blur">
      <div className="flex shrink-0 items-center justify-between border-b border-ink-600 px-4 py-3">
        <div>
          <div className="text-[13px] font-semibold text-white">历史对话</div>
          <div className="text-[10px] text-slate-500">共 {conversations.length} 条 · 点任意一条继续</div>
        </div>
        <button className="btn-ghost" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {conversations.length === 0 && (
          <p className="px-2 py-8 text-center text-xs text-slate-600">
            还没有任何对话。
            <br />
            在下方输入框里说一句话，就会自动开一个。
          </p>
        )}
        {conversations.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick(c.id)}
            className={`mb-1 w-full rounded-lg border px-3 py-2 text-left transition-colors ${
              c.id === currentId
                ? 'border-boss/50 bg-ink-600'
                : 'border-transparent hover:border-ink-500 hover:bg-ink-700'
            }`}
          >
            <div className="flex items-center gap-2">
              <span className="truncate text-[12.5px] font-medium text-slate-200">{c.title}</span>
              {c.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulseDot rounded-full bg-sky-400" />}
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-[10px] text-slate-500">
              {c.functionLabel && (
                <span className="rounded bg-ink-500 px-1.5 py-[1px] text-slate-300">{c.functionLabel}</span>
              )}
              <span className="font-mono">{c.executor}</span>
              <span>·</span>
              <span>{c.messageCount} 条</span>
              <span className="ml-auto">{relativeTime(c.updatedAt)}</span>
            </div>
            {c.lastMessage && (
              <div className="mt-1 truncate text-[10.5px] text-slate-600">{c.lastMessage}</div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 模型选择器
 * ------------------------------------------------------------------ */

function ModelPicker({ task, agent, executors, onChange, disabled }) {
  const currentExecutor = task?.executor || agent?.executor || 'claude'
  const list = executors.find((e) => e.id === currentExecutor)
  const models = list?.models || []
  const currentModel = task?.model || agent?.model || models[0]?.id || ''

  return (
    /* min-w-0 一路给到 select：窄面板（288px）时这一行只差 1px 就放不下，
       不给它们让位的空间，右边那句「自动派单」就会被折成两行。 */
    <div className="flex min-w-0 items-center gap-1.5">
      <select
        value={currentExecutor}
        disabled={disabled}
        onChange={(e) => onChange({ executor: e.target.value, model: '' })}
        className="min-w-0 rounded border border-ink-500 bg-ink-700 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-300 focus:border-boss focus:outline-none"
        title="用哪个 CLI 干活"
      >
        {executors.map((e) => (
          <option key={e.id} value={e.id} disabled={!e.available}>
            {e.label}
            {e.available ? '' : '（未安装）'}
          </option>
        ))}
      </select>

      <select
        value={currentModel}
        disabled={disabled || !models.length}
        onChange={(e) => onChange({ model: e.target.value })}
        className="min-w-0 rounded border border-ink-500 bg-ink-700 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-300 focus:border-boss focus:outline-none"
        title="这次对话用哪个模型"
      >
        {models.length === 0 && <option value="">无可用模型</option>}
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label || m.id}
          </option>
        ))}
      </select>
    </div>
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

export default function ChatPanel() {
  const detail = useStore((s) => s.detail)
  const detailLoading = useStore((s) => s.detailLoading)
  const conversations = useStore((s) => s.conversations)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const system = useStore((s) => s.system)
  const chatOpen = useStore((s) => s.chatOpen)
  const { sendChat, selectTask, newConversation, setConversationModel, startTask, cancelTask, openHandoff } =
    useStore()

  const [draft, setDraft] = useState('')
  const [showHistory, setShowHistory] = useState(false)
  const [showEvents, setShowEvents] = useState(false)
  const endRef = useRef(null)
  const inputRef = useRef(null)

  const executors = system?.executors || []
  const messages = detail?.messages || []
  const events = detail?.events || []
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

  // 折叠时把历史浮层一并收掉，否则它（absolute inset-x-0）会挂在一个 0 宽的面板里
  useEffect(() => {
    if (!chatOpen) setShowHistory(false)
  }, [chatOpen])

  const submit = () => {
    const text = draft.trim()
    if (!text) return
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

  return (
    /* 宽度分三档：<1024 288px / ≥1024 320px / ≥1500 480px（desk 档 = 原来的样子）。
       折叠时这三个类一个都不能少：shrink-0 的 flex item，min-width:auto 会取 min-content
       （里面的 textarea 约 180px），只写 w-0 根本收不到 0；overflow-hidden 才会把
       自动最小尺寸置 0，min-w-0 是再兜一层。折叠不用 transform（会裁掉子元素的 fixed 定位）。 */
    <aside
      className={`relative flex shrink-0 flex-col bg-ink-800 transition-[width] duration-200 ${
        chatOpen
          ? 'w-[18rem] border-l border-ink-600 lg:w-[20rem] desk:w-[30rem]'
          : 'w-0 min-w-0 overflow-hidden'
      }`}
    >
      {showHistory && (
        <HistoryList
          conversations={conversations}
          currentId={selectedTaskId}
          onPick={(id) => {
            selectTask(id)
            setShowHistory(false)
          }}
          onClose={() => setShowHistory(false)}
        />
      )}

      {/* 头部 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-ink-600 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-white">对话</span>
            {isRunning && (
              <span className="flex items-center gap-1 rounded-full bg-sky-500/10 px-2 py-0.5 text-[10px] text-sky-300">
                <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
                执行中
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-slate-500">
            {task ? task.title : '说一句话，自动分配给合适的员工'}
          </div>
        </div>

        <button
          className="btn-ghost shrink-0 px-2 py-1 text-[11px]"
          onClick={() => setShowHistory((v) => !v)}
          title="查看历史对话"
        >
          历史 {conversations.length > 0 ? `(${conversations.length})` : ''}
        </button>
        <button
          className="btn-ghost shrink-0 px-2 py-1 text-[11px]"
          onClick={() => {
            newConversation()
            inputRef.current?.focus()
          }}
          title="开始一个新对话"
        >
          + 新对话
        </button>
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
            <span className="chip bg-amber-500/15 text-amber-300">重试 ×{attempts}</span>
          )}

          <div className="ml-auto flex gap-1">
            <button
              className="rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-ink-600 hover:text-white"
              onClick={() => setShowEvents((v) => !v)}
              title="查看事件列表（工具调用明细）"
            >
              {showEvents ? '看对话' : `事件 ${events.length}`}
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-ink-600 hover:text-white"
              onClick={() => openHandoff(task.id)}
              title="交给另一个岗位接手（运行中会交接，不是中断）"
            >
              换岗
            </button>
            <button
              className="rounded px-1.5 py-0.5 text-[10.5px] text-slate-500 hover:bg-ink-600 hover:text-white"
              onClick={() => (isRunning ? cancelTask(task.id) : startTask(task.id))}
              disabled={task.status === 'complete' && !isRunning}
              title={isRunning ? '中断执行' : '重跑这个对话'}
            >
              {isRunning ? '中断' : '重跑'}
            </button>
          </div>
        </div>
      )}

      {/* 消息流 */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {!task && !detailLoading && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 text-4xl opacity-25">💬</div>
            <p className="text-[12px] leading-relaxed text-slate-500">
              在这里直接说要做什么，
              <br />
              系统会按内容自动挑一个员工去做。
            </p>
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

        {detailLoading && !task && <p className="py-8 text-center text-xs text-slate-600">加载中…</p>}

        {task &&
          !showEvents &&
          messages.map((m) => (
            <Bubble key={m.id} message={m} agent={agent} executorLabel={m.role === 'assistant' ? executorLabel : ''} />
          ))}

        {task && showEvents && (
          <div className="space-y-1.5">
            {events.length === 0 && <p className="py-8 text-center text-xs text-slate-600">还没有事件。</p>}
            {events.map((e) => {
              const meta = EVENT_META[e.type] || EVENT_META.info
              return (
                <div key={e.id} className="flex gap-2 rounded-md bg-ink-700/60 px-2 py-1.5">
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
            })}
          </div>
        )}

        {isRunning && (
          <div className="flex items-center gap-2 pl-1 text-[11px] text-sky-300">
            <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
            {agent?.functionLabel || 'Agent'} 正在处理…
          </div>
        )}

        <div ref={endRef} />
      </div>

      {/* 输入区 */}
      <div className="shrink-0 border-t border-ink-600 p-3">
        <div className="mb-2 flex items-center justify-between">
          <ModelPicker
            task={task}
            agent={agent}
            executors={executors}
            onChange={onModelChange}
            disabled={!task || isRunning}
          />
          <span className="shrink-0 whitespace-nowrap pl-1.5 text-[10px] text-slate-600">
            {isRunning ? '执行中 · 可继续补充指令' : task ? '续跑同一会话' : '自动派单'}
          </span>
        </div>

        <div className="flex items-end gap-2">
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
            placeholder={
              task
                ? '继续说点什么，会接着当前会话讲（Ctrl+Enter 发送）'
                : '想让谁做什么？直接说，自动派单（Ctrl+Enter 发送）'
            }
            className="field resize-none py-1.5 text-[12px]"
          />
          <button className="btn-primary h-9 px-3 text-[12px]" disabled={!draft.trim()} onClick={submit}>
            发送
          </button>
        </div>
      </div>
    </aside>
  )
}
