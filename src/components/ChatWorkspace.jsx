import { useState } from 'react'
import { useStore } from '../store'
import ConversationList from './ConversationList'
import AgentSidebar from './AgentSidebar'
import ChatPanel from './ChatPanel'
import PreviewPanel from './PreviewPanel'

/**
 * 9.1.0：对话页工作区 —— WorkBuddy 式布局。
 * 左列：可切换的会话列表 / 岗位列表；右侧：全宽聊天主区。
 * 9.3.8：可开关的预览面板（文件 / 知识库）挂在最右侧。
 */
export default function ChatWorkspace({ onNewAgent }) {
  const [tab, setTab] = useState('chats')
  const previewOpen = useStore((s) => s.previewOpen)

  return (
    <div className="flex min-w-0 flex-1">
      {/* 左列：对话 / 岗位 两个标签页 */}
      <div className="flex w-64 shrink-0 flex-col border-r border-ink-600 bg-ink-800">
        <div className="flex shrink-0 gap-1 px-2 pt-2">
          {[
            { id: 'chats', label: '对话' },
            { id: 'agents', label: '岗位' },
          ].map((it) => (
            <button
              key={it.id}
              onClick={() => setTab(it.id)}
              className={`flex-1 rounded-lg px-2 py-1.5 text-[11.5px] font-medium transition-colors ${
                tab === it.id ? 'bg-ink-600 text-slate-100' : 'text-slate-500 hover:bg-ink-700 hover:text-slate-200'
              }`}
            >
              {it.label}
            </button>
          ))}
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          {tab === 'chats' ? <ConversationList /> : <AgentSidebar onNewAgent={onNewAgent} />}
        </div>
      </div>

      {/* 全宽聊天主区 */}
      <ChatPanel />

      {/* 9.3.8：右侧预览面板（文件 / 知识库） */}
      {previewOpen && <PreviewPanel />}
    </div>
  )
}
