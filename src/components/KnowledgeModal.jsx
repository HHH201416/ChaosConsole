import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { useT } from '../lib/useT'

/**
 * 知识库管理。
 *
 * 左侧：知识库列表（新建 / 重命名 / 删除）；右侧：文档列表 + 添加文档 +
 * 文件导入 + 导出 + 检索。数据都走 /api/kb* REST，实时性靠 ws 的 kb:changed
 * 触发 store.refreshSystem()（计数），本面板自己拉自己的数据。
 *
 * 文件导入在浏览器侧读文本：.chaoskb.json 导出包 → 整包导入；
 * .txt / .md → 每个文件一篇文档。导出走 download()（带 token）。
 */
export default function KnowledgeModal({ onClose }) {
  const t = useT()
  const toast = useStore((s) => s.toast)
  const system = useStore((s) => s.system)

  const [bases, setBases] = useState([])
  const [activeId, setActiveId] = useState(null)
  const [docs, setDocs] = useState([])
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [docTitle, setDocTitle] = useState('')
  const [docContent, setDocContent] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [hits, setHits] = useState(null)
  const [query, setQuery] = useState('')
  const fileRef = useRef(null)

  const kbInjectEnabled = system?.kbInjectEnabled !== false

  const loadBases = useCallback(async () => {
    try {
      const res = await api.kb()
      setBases(res.data.bases || [])
      setActiveId((prev) => {
        if (prev && (res.data.bases || []).some((b) => b.id === prev)) return prev
        return (res.data.bases || [])[0]?.id || null
      })
    } catch (err) {
      toast(err.message, 'error')
    }
  }, [toast])

  const loadDocs = useCallback(
    async (kbId) => {
      if (!kbId) {
        setDocs([])
        return
      }
      try {
        const res = await api.kbDocs(kbId)
        setDocs(res.data || [])
      } catch (err) {
        toast(err.message, 'error')
      }
    },
    [toast],
  )

  useEffect(() => {
    loadBases()
  }, [loadBases])

  useEffect(() => {
    setHits(null)
    setQuery('')
    setShowAdd(false)
    loadDocs(activeId)
  }, [activeId, loadDocs])

  const active = useMemo(() => bases.find((b) => b.id === activeId) || null, [bases, activeId])

  const createKb = async () => {
    if (!newName.trim()) return
    setBusy(true)
    try {
      const res = await api.createKb({ name: newName, description: newDesc })
      if (res.ok) {
        toast(t('kb.created'), 'success')
        setCreating(false)
        setNewName('')
        setNewDesc('')
        await loadBases()
        setActiveId(res.data.id)
      }
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const deleteKb = async (kb) => {
    const msg = t('kb.deleteKbConfirm', { name: kb.name, n: kb.docCount })
    if (!window.confirm(msg)) return
    try {
      await api.deleteKb(kb.id)
      toast(t('kb.deleted'), 'success')
      if (activeId === kb.id) setActiveId(null)
      await loadBases()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const addDoc = async () => {
    if (!activeId || !docTitle.trim() || !docContent.trim()) return
    setBusy(true)
    try {
      await api.addKbDoc(activeId, { title: docTitle, content: docContent })
      setDocTitle('')
      setDocContent('')
      setShowAdd(false)
      toast(t('kb.saved'), 'success')
      await Promise.all([loadDocs(activeId), loadBases()])
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const deleteDoc = async (doc) => {
    if (!window.confirm(t('kb.deleteDocConfirm', { title: doc.title }))) return
    try {
      await api.deleteKbDoc(activeId, doc.id)
      await Promise.all([loadDocs(activeId), loadBases()])
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const doExport = async (format) => {
    if (!activeId) return
    try {
      const { blob, filename } = await api.exportKb(activeId, format)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
      toast(t('kb.exported', { name: filename }), 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const onImportFiles = async (e) => {
    const files = [...(e.target.files || [])]
    e.target.value = ''
    if (!files.length || !activeId) return
    setBusy(true)
    try {
      let added = 0
      let skipped = 0
      for (const file of files) {
        const text = await file.text()
        if (/\.json$/i.test(file.name)) {
          let data = null
          try {
            data = JSON.parse(text)
          } catch (_) {
            throw new Error(`${file.name}: 不是有效的 JSON`)
          }
          const docsIn = Array.isArray(data?.docs) ? data.docs : null
          if (docsIn) {
            const r = await api.importKb({ ...data, targetId: activeId })
            added += r.data.added
            skipped += r.data.skipped
          } else {
            await api.addKbDoc(activeId, { title: file.name.replace(/\.json$/i, ''), content: text, source: file.name })
            added++
          }
        } else {
          // .txt / .md / 其它文本一律当单篇文档
          await api.addKbDoc(activeId, {
            title: file.name.replace(/\.(txt|md|markdown)$/i, ''),
            content: text,
            source: file.name,
          })
          added++
        }
      }
      toast(t('kb.imported', { n: added, m: skipped }), 'success')
      await Promise.all([loadDocs(activeId), loadBases()])
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const doSearch = async (e) => {
    e.preventDefault()
    const q = query.trim()
    if (!q) {
      setHits(null)
      return
    }
    try {
      const res = await api.kbSearch(q, { limit: 8 })
      setHits(res.data || [])
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const fmtChars = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万字` : `${n} 字`)

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[62rem] flex-col overflow-hidden rounded-xl border border-ink-500 bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between border-b border-ink-600 p-5">
          <div>
            <h3 className="text-base font-semibold text-slate-100">{t('kb.title')}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">{t('kb.subtitle')}</p>
          </div>
          <button className="btn-ghost" onClick={onClose}>
            {t('common.close')}
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左：库列表 */}
          <div className="flex w-60 shrink-0 flex-col border-r border-ink-600">
            <div className="border-b border-ink-600 p-3">
              <button className="btn-primary w-full" onClick={() => setCreating((v) => !v)}>
                {t('kb.new')}
              </button>
              {creating && (
                <div className="mt-2 space-y-2">
                  <input
                    className="field w-full"
                    placeholder={t('kb.name')}
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    autoFocus
                  />
                  <input
                    className="field w-full"
                    placeholder={t('kb.description')}
                    value={newDesc}
                    onChange={(e) => setNewDesc(e.target.value)}
                  />
                  <div className="flex justify-end gap-2">
                    <button className="btn-ghost" onClick={() => setCreating(false)}>
                      {t('common.cancel')}
                    </button>
                    <button className="btn-primary" disabled={busy || !newName.trim()} onClick={createKb}>
                      {t('common.confirm')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {!bases.length && <p className="px-2 py-4 text-[11px] text-slate-500">{t('kb.empty')}</p>}
              {bases.map((b) => (
                <div
                  key={b.id}
                  className={`group mb-1 cursor-pointer rounded-lg px-3 py-2 ${
                    b.id === activeId ? 'bg-boss/15' : 'hover:bg-ink-700'
                  }`}
                  onClick={() => setActiveId(b.id)}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-[12.5px] text-slate-200">{b.name}</span>
                    <button
                      className="shrink-0 text-[11px] text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-rose-400"
                      title={t('common.delete')}
                      onClick={(e) => {
                        e.stopPropagation()
                        deleteKb(b)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                  <div className="mt-0.5 text-[10.5px] text-slate-500">
                    {t('kb.docsCount', { n: b.docCount, c: fmtChars(b.chars) })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 右：文档 */}
          <div className="flex min-w-0 flex-1 flex-col">
            {!active ? (
              <div className="flex flex-1 items-center justify-center text-[12px] text-slate-500">
                {t('kb.noKbSelected')}
              </div>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2 border-b border-ink-600 p-3">
                  <span className="mr-auto text-[13px] font-medium text-slate-200">{active.name}</span>
                  <button className="btn-ghost" onClick={() => setShowAdd((v) => !v)}>
                    {t('kb.addDoc')}
                  </button>
                  <button className="btn-ghost" disabled={busy} onClick={() => fileRef.current?.click()}>
                    {t('kb.import')}
                  </button>
                  <button className="btn-ghost" onClick={() => doExport('json')}>
                    {t('kb.exportJson')}
                  </button>
                  <button className="btn-ghost" onClick={() => doExport('md')}>
                    {t('kb.exportMd')}
                  </button>
                </div>

                <form onSubmit={doSearch} className="flex gap-2 border-b border-ink-600 p-3">
                  <input
                    className="field flex-1"
                    placeholder={t('kb.search')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                  />
                  <button className="btn-ghost" type="submit">
                    {t('common.search')}
                  </button>
                  {hits && (
                    <button
                      className="btn-ghost"
                      type="button"
                      onClick={() => {
                        setHits(null)
                        setQuery('')
                      }}
                    >
                      {t('common.back')}
                    </button>
                  )}
                </form>

                <div className="min-h-0 flex-1 overflow-y-auto p-3">
                  {showAdd && (
                    <div className="mb-3 rounded-lg border border-ink-500 bg-ink-900 p-3">
                      <input
                        className="field mb-2 w-full"
                        placeholder={t('kb.docTitle')}
                        value={docTitle}
                        onChange={(e) => setDocTitle(e.target.value)}
                      />
                      <textarea
                        className="field mb-2 h-32 w-full resize-y"
                        placeholder={t('kb.docContent')}
                        value={docContent}
                        onChange={(e) => setDocContent(e.target.value)}
                      />
                      <div className="flex justify-end gap-2">
                        <button className="btn-ghost" onClick={() => setShowAdd(false)}>
                          {t('common.cancel')}
                        </button>
                        <button
                          className="btn-primary"
                          disabled={busy || !docTitle.trim() || !docContent.trim()}
                          onClick={addDoc}
                        >
                          {t('kb.docAdd')}
                        </button>
                      </div>
                    </div>
                  )}

                  {hits ? (
                    hits.length ? (
                      hits.map((h) => (
                        <div key={h.docId} className="mb-2 rounded-lg border border-ink-500 bg-ink-900 p-3">
                          <div className="flex items-center gap-2">
                            <span className="text-[12.5px] text-slate-200">{h.title}</span>
                            <span className="chip">{h.kbName}</span>
                            <span className="ml-auto font-mono text-[10px] text-slate-600">
                              {t('kb.searchIn')} {h.score}
                            </span>
                          </div>
                          <p className="mt-1 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-400">
                            {h.excerpt}
                          </p>
                        </div>
                      ))
                    ) : (
                      <p className="py-6 text-center text-[12px] text-slate-500">{t('kb.searchEmpty')}</p>
                    )
                  ) : !docs.length ? (
                    <p className="py-6 text-center text-[12px] text-slate-500">{t('kb.addDoc')} / {t('kb.import')}</p>
                  ) : (
                    docs.map((d) => (
                      <div key={d.id} className="group mb-2 rounded-lg border border-ink-500 bg-ink-900 p-3">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-[12.5px] text-slate-200">{d.title}</span>
                          <span className="ml-auto shrink-0 text-[10px] text-slate-600">{fmtChars(d.chars)}</span>
                          <button
                            className="shrink-0 text-[11px] text-slate-600 opacity-0 transition group-hover:opacity-100 hover:text-rose-400"
                            onClick={() => deleteDoc(d)}
                            title={t('common.delete')}
                          >
                            ✕
                          </button>
                        </div>
                        <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[11px] leading-relaxed text-slate-500">
                          {d.content?.slice(0, 300)}
                        </p>
                      </div>
                    ))
                  )}
                </div>

                <div className="flex items-center gap-2 border-t border-ink-600 p-3">
                  <label className="flex cursor-pointer items-center gap-2 text-[11px] text-slate-400">
                    <input
                      type="checkbox"
                      checked={kbInjectEnabled}
                      onChange={async (e) => {
                        try {
                          await api.setSettings({ kbInjectEnabled: e.target.checked })
                          toast(e.target.checked ? '已开启注入' : '已关闭注入', 'success')
                        } catch (err) {
                          toast(err.message, 'error')
                        }
                      }}
                    />
                    {t('kb.inject')}
                  </label>
                  <span className="ml-auto text-[10px] text-slate-600" title={t('kb.importHint')}>
                    {t('kb.importHint')}
                  </span>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        accept=".json,.txt,.md,.markdown"
        className="hidden"
        onChange={onImportFiles}
      />
    </div>
  )
}
