import { useState } from 'react'
import { useStore } from '../store'
import { COLUMNS } from '../lib/meta'
import TaskCard from './TaskCard'

function Column({ col, tasks, agentsById, selectedTaskId, onSelect, onDropTask, isDropTarget, setDropTarget }) {
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        if (!isDropTarget) setDropTarget(col.key)
      }}
      onDragLeave={(e) => {
        // 只有真正离开这一列才取消高亮（避免子元素冒泡误触）
        if (!e.currentTarget.contains(e.relatedTarget)) setDropTarget(null)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setDropTarget(null)
        const id = e.dataTransfer.getData('text/chaos-task')
        if (id) onDropTask(id, col.key)
      }}
      className={`flex h-full min-w-[10.5rem] flex-1 flex-col rounded-xl border bg-ink-800/60 transition-colors ${
        isDropTarget ? 'border-boss/60 bg-ink-700/70' : 'border-ink-600'
      }`}
    >
      {/* 列头。窄列（贴着上面那个地板宽度）时这四项一行放不下，必须换行 ——
          否则会溢出到相邻列上。窄屏放过不下的列由 main 的 overflow-x-auto 横向滚动。 */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <span className={`h-1 w-6 rounded-full ${col.bar}`} />
        <span className="text-[13px] font-semibold text-slate-200">{col.label}</span>
        {/* 英文名是装饰性的冗余信息。列宽 191px 时整行要 221px 才放得下（「需要输入 /
            NEEDS INPUT / 0」比「待处理 / BACKLOG / 0」宽），所以窄了就整条撤掉，
            而不是让它折行或把计数徽标挤到第二行去。whitespace-nowrap 保证它要么
            整条在、要么整条不在，不会断成「NEEDS / INPUT」。 */}
        <span className="hidden whitespace-nowrap font-mono text-[10px] uppercase tracking-wider text-slate-600 desk:inline">
          {col.en}
        </span>
        <span className="ml-auto rounded-full bg-ink-600 px-2 py-0.5 font-mono text-[11px] text-slate-400">
          {tasks.length}
        </span>
      </div>

      {/* 卡片列表 */}
      <div className="flex-1 space-y-2 overflow-y-auto px-2.5 pb-3">
        {tasks.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            agent={agentsById[t.agentId]}
            selected={selectedTaskId === t.id}
            onSelect={onSelect}
          />
        ))}
        {tasks.length === 0 && (
          <div className="flex h-24 items-center justify-center rounded-lg border border-dashed border-ink-500/70 text-[11px] text-slate-600">
            拖拽任务卡片到这里
          </div>
        )}
      </div>
    </div>
  )
}

export default function Board() {
  const tasks = useStore((s) => s.tasks)
  const agents = useStore((s) => s.agents)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const selectTask = useStore((s) => s.selectTask)
  const moveTask = useStore((s) => s.moveTask)
  const [dropTarget, setDropTarget] = useState(null)

  const agentsById = Object.fromEntries(agents.map((a) => [a.id, a]))

  return (
    /* 注意：`main > div` 恰好是 4 个列，这个结构被 scripts/e2e-check.js 依赖，
       别为了做横向滚动在 main 和列之间插包裹层 —— 列自己带 min-w，main 直接滚。 */
    <main className="flex min-w-0 flex-1 gap-3 overflow-x-auto p-3">
      {COLUMNS.map((col) => (
        <Column
          key={col.key}
          col={col}
          tasks={tasks.filter((t) => t.status === col.key)}
          agentsById={agentsById}
          selectedTaskId={selectedTaskId}
          onSelect={selectTask}
          onDropTask={moveTask}
          isDropTarget={dropTarget === col.key}
          setDropTarget={setDropTarget}
        />
      ))}
    </main>
  )
}
