import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { relativeTime } from '../lib/meta'

/**
 * 9.1.0：WorkBuddy 式会话列表栏 —— 对话页的左列。
 * 搜索框 + 「＋ 新对话」主按钮 + 会话条目（标题 / 引擎徽标 / 最近消息 / 相对时间）。
 * 9.8.2：条目支持右键菜单 → 删除对话（删除走 /api/tasks/:id，级联清消息与事件）。
 */
export default function ConversationList() {
  const conversations = useStore((s) => s.conversations)
  const selectedTaskId = useStore((s) => s.selectedTaskId)
  const selectTask = useStore((s) => s.selectTask)
  const newConversation = useStore((s) => s.newConversation)
  const deleteTask = useStore((s) => s.deleteTask)
  const [q, setQ] = useState('')
  /* 右键菜单：{ id, x, y } —— 点别处 / Esc / 滚动列表都会关掉 */
  const [menu, setMenu] = useState(null)

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return conversations
    return conversations.filter(
      (c) =>
        String(c.title || '').toLowerCase().includes(kw) ||
        String(c.lastMessage || '').toLowerCase().includes(kw),
    )
  }, [conversations, q])

  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    const esc = (e) => e.key === 'Escape' && setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])

  const confirmDelete = () => {
    const target = conversations.find((c) => c.id === menu.id)
    const label = target?.title ? `「${target.title.slice(0, 24)}」` : ''
    if (window.confirm(`确定删除对话${label}？聊天记录会一并删除，无法恢复。`)) {
      deleteTask(menu.id)
    }
    setMenu(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 搜索 */}
      <div className="shrink-0 px-3 pt-2.5">
        <input
          className="field w-full py-1 text-[11.5px]"
          placeholder="搜索对话…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      {/* 新对话主按钮 */}
      <div className="shrink-0 px-3 py-2">
        <button
          className="w-full rounded-lg border border-boss/40 bg-boss/15 px-3 py-1.5 text-[12px] font-medium text-boss-strong transition-colors hover:bg-boss/25"
          onClick={() => newConversation()}
          title="开始一个新对话（混沌就绪时默认免费）"
        >
          ＋ 新对话
        </button>
      </div>

      {/* 列表 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {list.length === 0 && (
          <p className="px-2 py-8 text-center text-[11px] leading-relaxed text-slate-600">
            {q ? '没有匹配的对话。' : '还没有对话 —— 点上面「＋ 新对话」，\n或直接在右侧输入框说一句话。'}
          </p>
        )}
        {list.map((c) => (
          <button
            key={c.id}
            onClick={() => selectTask(c.id)}
            onContextMenu={(e) => {
              e.preventDefault()
              setMenu({ id: c.id, x: e.clientX, y: e.clientY })
            }}
            className={`mb-1 w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${
              c.id === selectedTaskId
                ? 'border-boss/50 bg-ink-600'
                : 'border-transparent hover:border-ink-500 hover:bg-ink-700'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-200">{c.title}</span>
              {c.running && <span className="h-1.5 w-1.5 shrink-0 animate-pulseDot rounded-full bg-sky-400" />}
              <span className="shrink-0 font-mono text-[9px] text-slate-600">
                {c.executor === 'chaos' ? '🌀' : c.executor}
              </span>
            </div>
            {c.lastMessage && <div className="mt-0.5 truncate text-[10px] text-slate-600">{c.lastMessage}</div>}
            <div className="mt-1 flex items-center gap-1.5 text-[9.5px] text-slate-600">
              {c.functionLabel && <span className="rounded bg-ink-500 px-1 py-[1px] text-slate-400">{c.functionLabel}</span>}
              <span className="ml-auto">{relativeTime(c.updatedAt)}</span>
            </div>
          </button>
        ))}
      </div>

      {/* 右键菜单：删除对话 */}
      {menu && (
        <div
          className="fixed z-50 min-w-[120px] rounded-lg border border-ink-500 bg-ink-600 py-1 shadow-xl"
          style={{ left: Math.min(menu.x, window.innerWidth - 140), top: Math.min(menu.y, window.innerHeight - 60) }}
          onClick={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="block w-full px-3 py-1.5 text-left text-[12px] text-slate-200 transition-colors hover:bg-rose-500/20 hover:text-rose-300"
            onClick={confirmDelete}
          >
            🗑 删除对话
          </button>
        </div>
      )}
    </div>
  )
}
