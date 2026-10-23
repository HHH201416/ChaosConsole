import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../lib/useT'

/**
 * 8.0.0：命令面板 / 全局搜索（Ctrl+K）。
 *
 * 结果分四组：任务、岗位、消息、事件；最后是固定命令。
 * 顶部输入框边输边搜（2 个字起），方向键 + Enter 选择，Esc 关闭。
 */
export default function CommandPalette({ onCommand }) {
  const t = useT()
  const open = useStore((s) => s.paletteOpen)
  const query = useStore((s) => s.paletteQuery)
  const results = useStore((s) => s.paletteResults)
  const agents = useStore((s) => s.agents)
  const searchGlobal = useStore((s) => s.searchGlobal)
  const closePalette = useStore((s) => s.closePalette)
  const selectTask = useStore((s) => s.selectTask)
  const openAgentDetail = useStore((s) => s.openAgentDetail)
  const inputRef = useRef(null)
  const [active, setActive] = useState(0)

  useEffect(() => {
    if (!open) return
    setActive(0)
    const timer = setTimeout(() => inputRef.current?.focus(), 20)
    return () => clearTimeout(timer)
  }, [open])

  useEffect(() => {
    if (!open) return
    const timer = setTimeout(() => searchGlobal(query), 160)
    return () => clearTimeout(timer)
  }, [query, open, searchGlobal])

  const commands = useMemo(
    () => [
      { id: 'new-task', label: t('palette.cmdNewTask'), hint: 'Ctrl+N' },
      { id: 'new-agent', label: t('palette.cmdNewAgent'), hint: 'Ctrl+Shift+N' },
      { id: 'settings', label: t('palette.cmdSettings'), hint: 'Ctrl+,' },
      { id: 'toolchain', label: t('palette.cmdToolchain') },
      { id: 'stats', label: t('palette.cmdStats') },
      { id: 'diagnostics', label: t('palette.cmdDiagnostics') },
      { id: 'backups', label: t('palette.cmdBackups') },
      { id: 'export', label: t('palette.cmdExport') },
      { id: 'import', label: t('palette.cmdImport') },
      { id: 'theme', label: t('palette.cmdTheme') },
      { id: 'accent', label: t('palette.cmdAccent') },
      { id: 'help', label: t('palette.cmdHelp'), hint: 'Ctrl+/' },
      { id: 'watt', label: t('palette.cmdWatt') },
    ],
    [t],
  )

  const matchedCommands = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => c.label.toLowerCase().includes(q))
  }, [commands, query])

  const flat = useMemo(() => {
    const items = []
    for (const task of results.tasks || []) {
      items.push({ type: 'task', id: task.id, label: task.title, hint: t('palette.tasks') })
    }
    for (const agent of results.agents || []) {
      items.push({
        type: 'agent',
        id: agent.id,
        label: agent.functionLabel,
        hint: `${t('palette.agents')} · ${agent.role}`,
      })
    }
    for (const m of results.messages || []) {
      items.push({ type: 'message', id: m.taskId, label: m.content, hint: `${t('palette.messages')} · ${m.taskTitle}` })
    }
    for (const ev of results.events || []) {
      items.push({
        type: 'event',
        id: ev.taskId,
        label: ev.name || ev.content || ev.type,
        hint: `${t('palette.events')} · ${ev.taskTitle}`,
      })
    }
    for (const cmd of matchedCommands) items.push({ type: 'command', id: cmd.id, label: cmd.label, hint: cmd.hint })
    return items
  }, [results, matchedCommands, t])

  useEffect(() => {
    if (active >= flat.length) setActive(0)
  }, [flat.length, active])

  if (!open) return null

  const choose = (item) => {
    if (!item) return
    closePalette()
    if (item.type === 'task' || item.type === 'message' || item.type === 'event') {
      selectTask(item.id)
      return
    }
    if (item.type === 'agent') {
      openAgentDetail(item.id)
      return
    }
    onCommand?.(item.id)
  }

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      closePalette()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (flat.length ? (i + 1) % flat.length : 0))
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (flat.length ? (i - 1 + flat.length) % flat.length : 0))
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      choose(flat[active])
    }
  }

  const group = (type, label) => {
    const items = flat.filter((x) => x.type === type)
    if (!items.length) return null
    return (
      <div className="mb-2">
        <div className="panel-title px-3 py-1">{label}</div>
        {items.map((item) => {
          const index = flat.indexOf(item)
          return (
            <button
              key={`${type}-${item.id}-${item.label}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => choose(item)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-[12px] ${
                index === active ? 'bg-ink-600 text-slate-100' : 'text-slate-300 hover:bg-ink-700'
              }`}
            >
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && <span className="shrink-0 font-mono text-[10px] text-slate-500">{item.hint}</span>}
            </button>
          )
        })}
      </div>
    )
  }

  const noResults =
    !results.tasks?.length &&
    !results.agents?.length &&
    !results.messages?.length &&
    !results.events?.length &&
    !matchedCommands.length

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/50 p-6 pt-[12vh]" onClick={closePalette}>
      <div
        className="w-full max-w-[42rem] overflow-hidden rounded-xl border border-ink-500 bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('palette.title')}
      >
        <div className="border-b border-ink-600 p-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('palette.placeholder')}
            className="field py-2 text-[13px]"
          />
        </div>
        <div className="max-h-[55vh] overflow-y-auto p-2">
          {query.trim().length >= 2 && noResults && (
            <p className="px-3 py-6 text-center text-xs text-slate-600">{t('palette.noResults')}</p>
          )}
          {group('task', t('palette.tasks'))}
          {group('agent', t('palette.agents'))}
          {group('message', t('palette.messages'))}
          {group('event', t('palette.events'))}
          {group('command', t('palette.commands'))}
        </div>
        <div className="flex items-center justify-between border-t border-ink-600 px-3 py-1.5 text-[10px] text-slate-600">
          <span>Ctrl+K</span>
          <span>↑ ↓ · Enter · Esc</span>
        </div>
      </div>
    </div>
  )

  function setQuery(value) {
    useStore.setState({ paletteQuery: value })
  }
}
