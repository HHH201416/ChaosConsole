import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { formatTime } from '../lib/meta'

/**
 * 9.3.8：WorkBuddy 式右侧预览面板 —— 对话页旁边看文件和知识库。
 *
 *   📚 知识库：左侧库/文档列表 + 右侧文档全文预览（纯本地检索数据源）
 *   📁 文件：当前对话工作区（任务 cwd）的目录树 + 文本文件预览
 *
 * 数据全部走现有 REST；文件预览有越界防护（只能看工作区内的文本文件）。
 */
export default function PreviewPanel() {
  const [tab, setTab] = useState('kb')
  const togglePreview = useStore((s) => s.togglePreview)

  return (
    <aside className="flex w-[22rem] shrink-0 flex-col border-l border-ink-600 bg-ink-800">
      <div className="flex shrink-0 items-center gap-1 border-b border-ink-600 px-2 py-2">
        {[
          { id: 'kb', label: '📚 知识库' },
          { id: 'files', label: '📁 文件' },
        ].map((it) => (
          <button
            key={it.id}
            onClick={() => setTab(it.id)}
            className={`rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
              tab === it.id ? 'bg-ink-600 text-slate-100' : 'text-slate-500 hover:bg-ink-700 hover:text-slate-200'
            }`}
          >
            {it.label}
          </button>
        ))}
        <button
          className="ml-auto rounded px-1.5 py-1 text-[11px] text-slate-500 hover:bg-ink-600 hover:text-slate-200"
          onClick={() => togglePreview(false)}
          title="收起预览面板"
        >
          ✕
        </button>
      </div>

      {tab === 'kb' ? <KbPreview /> : <FilesPreview />}
    </aside>
  )
}

/* ---------------- 知识库预览 ---------------- */

function KbPreview() {
  const [kbs, setKbs] = useState([])
  const [activeKb, setActiveKb] = useState(null)
  const [docs, setDocs] = useState([])
  const [activeDoc, setActiveDoc] = useState(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const res = await api.kb()
        if (!alive) return
        const list = res.data || []
        setKbs(list)
        if (list.length && !activeKb) setActiveKb(list[0].id)
      } catch (_) {
        /* 静默：预览面板不打断对话 */
      }
    })()
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!activeKb) {
      setDocs([])
      setActiveDoc(null)
      return
    }
    let alive = true
    setLoading(true)
    ;(async () => {
      try {
        const res = await api.kbDocs(activeKb)
        if (!alive) return
        const list = res.data || []
        setDocs(list)
        setActiveDoc(list[0]?.id || null)
      } catch (_) {
        /* ignore */
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [activeKb])

  const doc = docs.find((d) => d.id === activeDoc) || null

  return (
    <div className="flex min-h-0 flex-1">
      {/* 左列：库 + 文档列表 */}
      <div className="flex w-[9.5rem] min-h-0 shrink-0 flex-col overflow-y-auto border-r border-ink-600/70 px-1.5 py-2">
        {kbs.map((k) => (
          <button
            key={k.id}
            onClick={() => setActiveKb(k.id)}
            className={`mb-0.5 flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] transition-colors ${
              activeKb === k.id ? 'bg-ink-600 text-slate-100' : 'text-slate-400 hover:bg-ink-700'
            }`}
            title={k.description || k.name}
          >
            <span>📚</span>
            <span className="min-w-0 flex-1 truncate">{k.name}</span>
          </button>
        ))}
        {kbs.length === 0 && <p className="px-2 py-4 text-center text-[10px] leading-relaxed text-slate-600">还没有知识库</p>}
        <div className="my-1.5 border-t border-ink-600/70" />
        {loading && <p className="px-2 py-2 text-[10px] text-slate-600">加载中…</p>}
        {docs.map((d) => (
          <button
            key={d.id}
            onClick={() => setActiveDoc(d.id)}
            className={`mb-0.5 rounded-lg px-2 py-1.5 text-left text-[10.5px] transition-colors ${
              activeDoc === d.id ? 'bg-boss/15 text-boss-strong' : 'text-slate-400 hover:bg-ink-700'
            }`}
          >
            <span className="block truncate">📄 {d.title}</span>
          </button>
        ))}
        {!loading && activeKb && docs.length === 0 && (
          <p className="px-2 py-3 text-center text-[10px] text-slate-600">这个库还没有文档</p>
        )}
      </div>

      {/* 右侧：文档全文 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        {doc ? (
          <>
            <div className="mb-1.5 text-[12px] font-semibold text-slate-100">{doc.title}</div>
            <div className="mb-2 font-mono text-[9.5px] text-slate-600">
              {formatTime(doc.createdAt)}
              {doc.updatedAt ? ` · 更新于 ${formatTime(doc.updatedAt)}` : ''}
            </div>
            <pre className="whitespace-pre-wrap break-words font-sans text-[11.5px] leading-relaxed text-slate-300">
              {doc.content}
            </pre>
          </>
        ) : (
          <p className="pt-8 text-center text-[11px] text-slate-600">选一篇文档预览</p>
        )}
      </div>
    </div>
  )
}

/* ---------------- 文件预览（当前对话工作区） ---------------- */

function FilesPreview() {
  const detail = useStore((s) => s.detail)
  const system = useStore((s) => s.system)
  const root = detail?.task?.cwd || system?.defaultCwd || ''
  const [items, setItems] = useState([])
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [file, setFile] = useState(null) // { path, content, truncated, size }
  const [fileErr, setFileErr] = useState('')

  const reload = useMemo(
    () => async () => {
      if (!root) return
      setLoading(true)
      setErr('')
      try {
        const res = await api.workspaceTree(root)
        if (!res.ok) throw new Error(res.error || '读取失败')
        setItems(res.data?.items || [])
      } catch (e) {
        setErr(e.message)
        setItems([])
      } finally {
        setLoading(false)
      }
    },
    [root],
  )

  useEffect(() => {
    setFile(null)
    setFileErr('')
    reload()
  }, [reload])

  const open = async (it) => {
    setFileErr('')
    try {
      const res = await api.workspaceFile(root, it.path)
      if (!res.ok) throw new Error(res.error || '读取失败')
      setFile(res.data)
    } catch (e) {
      setFile(null)
      setFileErr(e.message)
    }
  }

  if (!root) {
    return <p className="px-3 py-8 text-center text-[11px] leading-relaxed text-slate-600">当前对话没有指定工作目录。</p>
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-ink-600/70 px-2.5 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[9.5px] text-slate-600" title={root}>
          {root}
        </span>
        <button className="shrink-0 text-[10.5px] text-slate-500 hover:text-slate-200" onClick={reload} title="刷新">
          ↻
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 目录树（一层） */}
        <div className="w-[9.5rem] min-h-0 shrink-0 overflow-y-auto border-r border-ink-600/70 px-1.5 py-2">
          {loading && <p className="px-2 py-2 text-[10px] text-slate-600">读取中…</p>}
          {!loading && err && <p className="px-2 py-2 text-[10px] leading-relaxed text-amber-400/80">{err}</p>}
          {!loading && !err && (
            <>
              {items
                .filter((it) => it.dir)
                .map((it) => (
                  <div key={it.path} className="rounded-lg px-2 py-1 text-[10.5px] text-slate-500" title={`${it.name}/（目录）`}>
                    📂 {it.name}
                  </div>
                ))}
              {items
                .filter((it) => !it.dir)
                .map((it) => (
                  <button
                    key={it.path}
                    onClick={() => it.previewable && open(it)}
                    className={`mb-0.5 block w-full truncate rounded-lg px-2 py-1 text-left text-[10.5px] transition-colors ${
                      file?.path === it.path
                        ? 'bg-boss/15 text-boss-strong'
                        : it.previewable
                          ? 'text-slate-400 hover:bg-ink-700 hover:text-slate-200'
                          : 'text-slate-600'
                    }`}
                    title={it.previewable ? `预览 ${it.name}` : `${it.name}（不支持预览的类型）`}
                  >
                    📄 {it.name}
                  </button>
                ))}
              {items.length === 0 && <p className="px-2 py-3 text-center text-[10px] text-slate-600">空目录</p>}
            </>
          )}
        </div>
        {/* 文件内容 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
          {fileErr && <p className="text-[10.5px] leading-relaxed text-amber-400/80">⚠️ {fileErr}</p>}
          {file ? (
            <>
              <div className="mb-1.5 flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-300">{file.path}</span>
                <span className="shrink-0 font-mono text-[9px] text-slate-600">{(file.size / 1024).toFixed(1)} KB</span>
              </div>
              {file.truncated && <p className="mb-1.5 text-[10px] text-amber-400/80">文件较大，只显示前 256KB。</p>}
              <pre className="whitespace-pre-wrap break-words font-mono text-[10.5px] leading-relaxed text-slate-300">
                {file.content}
              </pre>
            </>
          ) : (
            !fileErr && <p className="pt-8 text-center text-[11px] text-slate-600">点左侧文本文件预览内容</p>
          )}
        </div>
      </div>
    </div>
  )
}
