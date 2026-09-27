import { useStore } from '../store'
import { COLUMN_MAP, RUN_STATE_META, formatClock, stageLabel } from '../lib/meta'

export default function TaskCard({ task, agent, selected, onSelect }) {
  const { startTask, cancelTask, doneTask, openHandoff, stopRetry } = useStore()
  const col = COLUMN_MAP[task.status] || COLUMN_MAP.backlog
  const run = RUN_STATE_META[task.runState] || RUN_STATE_META.idle

  const isRunning = task.runState === 'running' || task.runState === 'queued'
  const isDone = task.status === 'complete'

  // 阶段徽章：只有配了流水线（任务上或岗位默认）才显示
  const stages = Array.isArray(task.pipeline) ? task.pipeline : []
  const stageIdx = stages.findIndex((s) => s.stage === task.stage)
  const stageText =
    stages.length && task.stage
      ? `${stageLabel(task.stage)} ${stageIdx >= 0 ? stageIdx + 1 : '?'}/${stages.length}`
      : ''
  const attempts = task.attempts || 0

  const onDragStart = (e) => {
    e.dataTransfer.setData('text/chaos-task', task.id)
    e.dataTransfer.effectAllowed = 'move'
  }

  const stop = (e, fn) => {
    e.stopPropagation()
    fn()
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={() => onSelect(task.id)}
      className={`group cursor-pointer rounded-lg border bg-ink-700 p-2.5 transition-all hover:bg-ink-600 ${
        selected ? 'border-boss/70 ring-1 ring-boss/30' : 'border-ink-500 hover:border-ink-400'
      } ${isDone ? 'opacity-75' : ''}`}
    >
      {/* 标题 */}
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${col.dot} ${isRunning ? 'animate-pulseDot' : ''}`} />
        <h4 className="flex-1 text-[13px] font-medium leading-snug text-slate-100">{task.title}</h4>
        <span className="shrink-0 font-mono text-[10px] text-slate-600">{formatClock(task.createdAt)}</span>
      </div>

      {/* 负责岗位：只显示「是干什么的」，不显示姓名 */}
      <div className="mt-2 flex min-w-0 items-center gap-1.5 pl-3.5">
        {agent ? (
          <>
            <span className="shrink-0 text-[13px] leading-none">{agent.avatar}</span>
            <span className="truncate text-[11px] text-slate-400">{agent.functionLabel}</span>
            <span className="shrink-0 font-mono text-[10px] text-slate-600">· {agent.executor}</span>
          </>
        ) : (
          <span className="text-[11px] italic text-slate-600">未指派（Start 时自动分配空闲岗位）</span>
        )}
      </div>

      {/* 标签 / 状态标记：needs_input 也要放进来，否则「等待回复」这枚角标
          只会出现在带标签的任务上，而对话页建的任务 tags 恒为空 —— 也就是
          说最需要你回话的那张卡片反而没有任何提示。 */}
      {(task.tags.length > 0 ||
        isRunning ||
        task.status === 'needs_input' ||
        stageText ||
        attempts > 0) && (
        <div className="mt-2 flex flex-wrap items-center gap-1 pl-3.5">
          {task.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
          {stageText && <span className="chip bg-violet-500/15 text-violet-300">{stageText}</span>}
          {attempts > 0 && (
            <span className="chip bg-amber-500/15 text-amber-300" title="失败后已自动换岗重试的次数">
              重试 ×{attempts}
            </span>
          )}
          {isRunning && (
            <span className="chip bg-sky-500/20 text-sky-300">
              <span className="mr-1 inline-block h-1 w-1 animate-pulseDot rounded-full bg-sky-400" />
              {run.label}
            </span>
          )}
          {task.status === 'needs_input' && (
            <span className="chip bg-boss/20 text-boss">等待回复</span>
          )}
        </div>
      )}

      {/* 操作。三个按钮的 min-content 加起来约 170px，比列地板宽下可用的 148px 还宽，
          所以要允许换行（窄列时排成两行）。 */}
      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-ink-500/70 pt-2 pl-3.5">
        <button
          className="btn-primary px-2 py-1 text-[11px]"
          disabled={isRunning || isDone}
          onClick={(e) => stop(e, () => startTask(task.id))}
          title={isDone ? '任务已完成' : isRunning ? '正在执行中' : '开始执行'}
        >
          Start
        </button>
        <button
          className="btn-danger px-2 py-1 text-[11px]"
          disabled={!isRunning && task.status !== 'needs_input'}
          onClick={(e) => stop(e, () => cancelTask(task.id))}
          title="中断执行并退回「待处理」"
        >
          Cancel
        </button>
        <button
          className="btn-success px-2 py-1 text-[11px]"
          disabled={isDone}
          onClick={(e) => stop(e, () => doneTask(task.id))}
          title="标记为已完成"
        >
          Done
        </button>
        {/* 换岗：运行中也能点，走的是「交接」不是「取消」 */}
        <button
          className="btn-ghost px-2 py-1 text-[11px]"
          disabled={isDone}
          onClick={(e) => stop(e, () => openHandoff(task.id))}
          title="交给另一个岗位接手（运行中会交接，不是取消）"
        >
          换岗
        </button>
        {attempts > 0 && task.autoRetry && (
          <button
            className="btn-ghost px-2 py-1 text-[11px] text-amber-300"
            onClick={(e) => stop(e, () => stopRetry(task.id))}
            title="停止失败后自动换岗重试"
          >
            停止重试
          </button>
        )}
      </div>
    </div>
  )
}
