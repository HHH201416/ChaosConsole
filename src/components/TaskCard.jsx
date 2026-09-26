import { useStore } from '../store'
import { COLUMN_MAP, RUN_STATE_META, formatClock } from '../lib/meta'

export default function TaskCard({ task, agent, selected, onSelect }) {
  const { startTask, cancelTask, doneTask } = useStore()
  const col = COLUMN_MAP[task.status] || COLUMN_MAP.backlog
  const run = RUN_STATE_META[task.runState] || RUN_STATE_META.idle

  const isRunning = task.runState === 'running' || task.runState === 'queued'
  const isDone = task.status === 'complete'

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
      <div className="mt-2 flex items-center gap-1.5 pl-3.5">
        {agent ? (
          <>
            <span className="text-[13px] leading-none">{agent.avatar}</span>
            <span className="text-[11px] text-slate-400">{agent.functionLabel}</span>
            <span className="font-mono text-[10px] text-slate-600">· {agent.executor}</span>
          </>
        ) : (
          <span className="text-[11px] italic text-slate-600">未指派（Start 时自动分配空闲岗位）</span>
        )}
      </div>

      {/* 标签 / 状态标记：needs_input 也要放进来，否则「等待回复」这枚角标
          只会出现在带标签的任务上，而对话页建的任务 tags 恒为空 —— 也就是
          说最需要你回话的那张卡片反而没有任何提示。 */}
      {(task.tags.length > 0 || isRunning || task.status === 'needs_input') && (
        <div className="mt-2 flex flex-wrap items-center gap-1 pl-3.5">
          {task.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
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

      {/* 操作 */}
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-ink-500/70 pt-2 pl-3.5">
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
      </div>
    </div>
  )
}
