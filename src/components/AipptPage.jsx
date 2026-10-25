import { useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken } from '../lib/api'
import { useStore } from '../store'
import { asArr } from '../lib/meta'

/**
 * 9.6.1：AIPPT —— 左侧 TAB 页。
 *
 * 左栏：选题 + 页数（预设或自己填）+ 语气 + 风格 + 语言 + 受众 + 目录页 → 生成
 * 右栏：**实时预览** —— 制作进度条、大纲、成品幻灯片（按真实配色和版式翻页看）
 *
 * 为什么右栏能当真预览：pptx 就是用「同一份大纲 + 同一套主题色」渲染出来的，
 * 预览和成品是一一对应的，不是示意图。
 */

const PAGE_PRESETS = [4, 6, 8, 10, 12, 16]

const TONE_OPTIONS = [
  { id: 'formal', label: '正式专业', desc: '结构严谨，用词规范' },
  { id: 'casual', label: '轻松口语', desc: '有亲和力，像聊天' },
  { id: 'academic', label: '学术客观', desc: '重数据与逻辑推演' },
  { id: 'marketing', label: '营销感染', desc: '短句有号召力' },
  { id: 'concise', label: '简洁要点', desc: '每句话短而准' },
]

/** 与服务端 aippt.js 的 THEMES 一一对应（预览用同一套色） */
const THEMES = [
  { id: 'emerald', label: '暗夜绿', coverBg: '#0F172A', coverTitle: '#FFFFFF', coverSub: '#94A3B8', pageBg: '#FFFFFF', title: '#0F172A', text: '#334155', accent: '#22C55E', tocBg: '#F8FAFC' },
  { id: 'business', label: '商务蓝', coverBg: '#0B2545', coverTitle: '#FFFFFF', coverSub: '#93B4D8', pageBg: '#FFFFFF', title: '#0B2545', text: '#334155', accent: '#2563EB', tocBg: '#F5F8FC' },
  { id: 'minimal', label: '极简白', coverBg: '#F4F5F7', coverTitle: '#111827', coverSub: '#6B7280', pageBg: '#FFFFFF', title: '#111827', text: '#374151', accent: '#111827', tocBg: '#FAFAFA' },
  { id: 'sunset', label: '活力橙', coverBg: '#2A1503', coverTitle: '#FFFFFF', coverSub: '#FDBA74', pageBg: '#FFFFFF', title: '#7C2D12', text: '#44403C', accent: '#F97316', tocBg: '#FFF7ED' },
  { id: 'violet', label: '科技紫', coverBg: '#170B2E', coverTitle: '#FFFFFF', coverSub: '#C4B5FD', pageBg: '#FFFFFF', title: '#1E1B4B', text: '#3730A3', accent: '#8B5CF6', tocBg: '#F5F3FF' },
]

const EXAMPLES = ['新能源汽车行业分析', '鸿蒙应用开发入门', '季度工作总结汇报', 'AI 大模型技术演进']

const MIN_PAGES = 3
const MAX_PAGES = 30

const STEP_LABELS = ['策划大纲', '排版渲染', '保存文件']

/* ------------------------------------------------------------------ *
 * 成品预览：把大纲按真实配色/版式画成幻灯片
 * ------------------------------------------------------------------ */

function SlidePreview({ outline, themeId, withToc, index, onIndex }) {
  const T = THEMES.find((t) => t.id === themeId) || THEMES[0]
  const slides = asArr(outline?.slides)
  const toc = withToc && slides.length >= 5

  // 预览页序列：封面 / (目录) / 内容页
  const frames = useMemo(() => {
    if (!outline || !slides.length) return []
    const out = []
    out.push({ kind: 'cover', title: outline.title || '（未填标题）', sub: outline.subtitle || slides[0]?.body?.[0] || '' })
    if (toc) out.push({ kind: 'toc', items: slides.slice(1, -1).map((s) => s.title) })
    for (let i = 1; i < slides.length; i++) out.push({ kind: 'page', no: i + 1, title: slides[i].title, body: asArr(slides[i].body) })
    return out
  }, [outline, toc, slides])

  const cur = Math.min(Math.max(index, 0), Math.max(0, frames.length - 1))
  const f = frames[cur]

  if (!outline || !frames.length) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-ink-600 bg-ink-900">
        <p className="px-4 text-center text-[10.5px] leading-relaxed text-slate-600">
          生成后这里就是成品预览
          <br />
          按真实版式和配色渲染，和下载的 pptx 一致
        </p>
      </div>
    )
  }

  return (
    <div>
      <div
        className="relative aspect-video w-full overflow-hidden rounded-lg border border-ink-600"
        style={{ background: f.kind === 'cover' ? T.coverBg : f.kind === 'toc' ? T.tocBg : T.pageBg }}
      >
        {f.kind === 'cover' && (
          <div className="flex h-full flex-col justify-center px-5">
            <div className="mb-2 h-[2px] w-8" style={{ background: T.accent }} />
            <p className="text-[15px] font-bold leading-snug" style={{ color: T.coverTitle }}>
              {f.title}
            </p>
            {f.sub && (
              <p className="mt-1.5 text-[9.5px] leading-relaxed" style={{ color: T.coverSub }}>
                {f.sub}
              </p>
            )}
          </div>
        )}

        {f.kind === 'toc' && (
          <div className="h-full px-5 py-4">
            <p className="text-[13px] font-bold" style={{ color: T.title }}>
              目录
            </p>
            <div className="my-1.5 h-[2px] w-6" style={{ background: T.accent }} />
            <div className="space-y-1 overflow-hidden">
              {f.items.slice(0, 7).map((t, i) => (
                <p key={i} className="truncate text-[8.5px]" style={{ color: T.text }}>
                  {String(i + 1).padStart(2, '0')} {t}
                </p>
              ))}
            </div>
          </div>
        )}

        {f.kind === 'page' && (
          <div className="h-full px-5 py-4">
            <p className="truncate text-[12px] font-bold" style={{ color: T.title }}>
              {f.title}
            </p>
            <div className="my-1.5 h-[2px] w-6" style={{ background: T.accent }} />
            <ul className="space-y-1">
              {f.body.slice(0, 5).map((t, i) => (
                <li key={i} className="flex gap-1 text-[8.5px] leading-snug" style={{ color: T.text }}>
                  <span style={{ color: T.accent }}>•</span>
                  <span className="line-clamp-2">{t}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <span className="absolute bottom-1.5 right-2 font-mono text-[8px]" style={{ color: f.kind === 'cover' ? T.coverSub : '#94A3B8' }}>
          {cur + 1} / {frames.length}
        </span>
      </div>

      {/* 翻页 */}
      <div className="mt-1.5 flex items-center gap-1">
        <button
          className="btn-ghost px-2 py-0.5 text-[11px]"
          disabled={cur <= 0}
          onClick={() => onIndex(cur - 1)}
          title="上一页"
        >
          ‹
        </button>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {frames.map((it, i) => (
            <button
              key={i}
              onClick={() => onIndex(i)}
              title={it.title || `第 ${i + 1} 页`}
              className={`h-1.5 shrink-0 rounded-full transition-all ${
                i === cur ? 'w-5 bg-boss' : 'w-1.5 bg-ink-600 hover:bg-ink-500'
              }`}
            />
          ))}
        </div>
        <button
          className="btn-ghost px-2 py-0.5 text-[11px]"
          disabled={cur >= frames.length - 1}
          onClick={() => onIndex(cur + 1)}
          title="下一页"
        >
          ›
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 制作进度
 * ------------------------------------------------------------------ */

function ProgressSteps({ phase, elapsed }) {
  return (
    <div className="space-y-1.5">
      {STEP_LABELS.map((label, i) => {
        const done = phase > i + 1
        const active = phase === i + 1
        return (
          <div key={label} className="flex items-center gap-2 text-[11px]">
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${
                done
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : active
                    ? 'bg-sky-500/20 text-sky-300'
                    : 'bg-ink-700 text-slate-600'
              }`}
            >
              {done ? '✓' : active ? '•' : i + 1}
            </span>
            <span className={done ? 'text-slate-400' : active ? 'text-sky-300' : 'text-slate-600'}>{label}</span>
            {active && (
              <span className="ml-auto flex items-center gap-1 font-mono text-[9.5px] text-slate-500">
                <span className="h-1 w-1 animate-pulseDot rounded-full bg-sky-400" />
                {elapsed}s
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default function AipptPage() {
  const toast = useStore((s) => s.toast)
  const system = useStore((s) => s.system)

  const [topic, setTopic] = useState('')
  const [pages, setPages] = useState(6)
  const [tone, setTone] = useState('formal')
  const [theme, setTheme] = useState('emerald')
  const [language, setLanguage] = useState('zh')
  const [audience, setAudience] = useState('')
  const [withToc, setWithToc] = useState(true)
  const [model, setModel] = useState('')

  const [phase, setPhase] = useState(0) // 0 待机 1 策划 2 渲染 3 完成
  const [elapsed, setElapsed] = useState(0)
  const [result, setResult] = useState(null)
  const [files, setFiles] = useState([])
  const [outline, setOutline] = useState(null)
  const [rendering, setRendering] = useState(false)
  const [slideIndex, setSlideIndex] = useState(0)
  const [showEditor, setShowEditor] = useState(false)

  const timer = useRef(null)
  const busy = phase === 1 || phase === 2
  const chaosModels = asArr(asArr(system?.executors).find((e) => e.id === 'chaos')?.models)

  const refreshFiles = async () => {
    try {
      const res = await api.aipptList()
      setFiles(asArr(res.data))
    } catch (_) {
      /* ignore */
    }
  }
  useEffect(() => {
    refreshFiles()
  }, [])

  // 计时器：让「正在策划」不是一个死转圈
  useEffect(() => {
    if (busy) {
      setElapsed(0)
      timer.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    } else if (timer.current) {
      clearInterval(timer.current)
      timer.current = null
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current)
        timer.current = null
      }
    }
  }, [busy])

  const clampPageInput = (v) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n <= 0) return pages || 6
    return Math.min(MAX_PAGES, Math.max(MIN_PAGES, n))
  }

  const generate = async () => {
    if (!topic.trim() || busy) return
    setResult(null)
    setOutline(null)
    setSlideIndex(0)
    setPhase(1)
    try {
      const res = await api.aipptGenerate({
        topic: topic.trim(),
        pages,
        tone,
        theme,
        language,
        audience: audience.trim(),
        withToc,
        model: model || undefined,
      })
      if (!res.ok) throw new Error(res.error || '生成失败')
      setPhase(2)
      setResult(res.data)
      setOutline(res.data.outline || null)
      setSlideIndex(0)
      setPhase(3)
      toast(`PPT 已生成：《${res.data.title}》共 ${res.data.pages} 页`, 'success')
      // 9.6.1：AIPPT 的消耗已经记进每日额度，刷新一下额度卡让用户看到
      useStore.getState().loadChaosStatus?.()
      refreshFiles()
    } catch (err) {
      setPhase(0)
      toast(err.message, 'error')
    }
  }

  const download = (id, name) => {
    if (!id) return
    const a = document.createElement('a')
    a.href = `/api/aippt/file?id=${encodeURIComponent(id)}&token=${encodeURIComponent(getToken() || '')}`
    a.download = name || 'AIPPT.pptx'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const rerender = async () => {
    if (!outline || rendering) return
    setRendering(true)
    try {
      const res = await api.aipptRender({ id: result?.id, outline, theme, withToc })
      if (!res.ok) throw new Error(res.error || '渲染失败')
      setResult(res.data)
      setOutline(res.data.outline || outline)
      toast(`已按修改重新渲染（${res.data.pages} 页）`, 'success')
      refreshFiles()
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setRendering(false)
    }
  }

  const loadOutline = async (id) => {
    try {
      const res = await api.aipptOutline(id)
      if (!res.ok) throw new Error(res.error || '这份 PPT 没有保存大纲')
      const o = res.data?.outline || res.data
      setOutline({ title: o.title || '', subtitle: o.subtitle || '', slides: asArr(o.slides) })
      setResult({ id, title: o.title || '（已载入大纲）', pages: asArr(o.slides).length })
      setSlideIndex(0)
      setPhase(3)
      setShowEditor(true)
      toast('已载入大纲，改完可「重新渲染」', 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const remove = async (id) => {
    if (!id) return
    try {
      const res = await api.aipptDelete(id)
      if (!res.ok) throw new Error(res.error || '删除失败')
      if (result?.id === id) {
        setResult(null)
        setOutline(null)
        setPhase(0)
      }
      toast('已删除', 'success')
      refreshFiles()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const patchSlide = (index, patch) => {
    setOutline((prev) => {
      if (!prev) return prev
      const slides = asArr(prev.slides).map((s, i) => (i === index ? { ...s, ...patch } : s))
      return { ...prev, slides }
    })
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xl">🖼️</span>
          <h2 className="text-[15px] font-semibold text-slate-100">AIPPT · 一句话生成 PPT</h2>
          <span className="chip">完全本地 · 由混沌模型策划内容</span>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
          {/* ---------------- 左：表单 + 历史 ---------------- */}
          <div className="min-w-0">
            <div className="rounded-xl border border-ink-500 bg-ink-800 p-4">
              <label className="mb-1 block text-[11px] text-slate-400">PPT 主题</label>
              <textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                rows={2}
                placeholder="想做什么 PPT？一句话描述，例如：鸿蒙应用开发入门"
                className="field w-full resize-none text-[12.5px]"
              />
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {EXAMPLES.map((ex) => (
                  <button
                    key={ex}
                    className="rounded-md border border-ink-500 px-2 py-0.5 text-[10.5px] text-slate-400 hover:border-boss hover:text-slate-100"
                    onClick={() => setTopic(ex)}
                  >
                    {ex}
                  </button>
                ))}
              </div>

              {/* 页数：预设 + 自己填 */}
              <div className="mt-4">
                <div className="mb-1 flex items-center gap-2">
                  <label className="text-[11px] text-slate-400">页数</label>
                  <span className="text-[10px] text-slate-600">
                    {MIN_PAGES}-{MAX_PAGES} 页，可直接填数字
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {PAGE_PRESETS.map((n) => (
                    <button
                      key={n}
                      onClick={() => setPages(n)}
                      className={`rounded-lg border px-2.5 py-1 text-[11px] transition-colors ${
                        pages === n
                          ? 'border-boss bg-boss/15 text-boss-strong'
                          : 'border-ink-500 text-slate-400 hover:border-ink-400 hover:text-slate-200'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                  <input
                    type="number"
                    min={MIN_PAGES}
                    max={MAX_PAGES}
                    value={pages}
                    onChange={(e) => setPages(e.target.value === '' ? '' : Number(e.target.value))}
                    onBlur={(e) => setPages(clampPageInput(e.target.value))}
                    className="field w-[4.5rem] py-1 text-center text-[11px]"
                    title={`自定义页数（${MIN_PAGES}-${MAX_PAGES}）`}
                  />
                  <span className="text-[10.5px] text-slate-500">页</span>
                </div>
              </div>

              {/* 语气 */}
              <label className="mb-1 mt-4 block text-[11px] text-slate-400">文字语气</label>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                {TONE_OPTIONS.map((tn) => (
                  <button
                    key={tn.id}
                    onClick={() => setTone(tn.id)}
                    title={tn.desc}
                    className={`rounded-lg border px-1 py-1.5 text-[11px] transition-colors ${
                      tone === tn.id
                        ? 'border-boss bg-boss/15 text-boss-strong'
                        : 'border-ink-500 text-slate-400 hover:border-ink-400 hover:text-slate-200'
                    }`}
                  >
                    {tn.label}
                  </button>
                ))}
              </div>

              {/* 风格 */}
              <label className="mb-1 mt-4 block text-[11px] text-slate-400">风格配色</label>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
                {THEMES.map((th) => (
                  <button
                    key={th.id}
                    onClick={() => setTheme(th.id)}
                    className={`flex items-center gap-1.5 rounded-lg border px-1.5 py-1.5 text-[11px] transition-colors ${
                      theme === th.id
                        ? 'border-boss bg-boss/15 text-boss-strong'
                        : 'border-ink-500 text-slate-400 hover:border-ink-400 hover:text-slate-200'
                    }`}
                  >
                    <span
                      className="h-3 w-3 shrink-0 rounded-full border border-white/20"
                      style={{ background: `linear-gradient(135deg, ${th.coverBg} 50%, ${th.accent} 50%)` }}
                    />
                    <span className="truncate">{th.label}</span>
                  </button>
                ))}
              </div>

              {/* 语言 / 受众 / 模型 / 目录页 */}
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-[11px] text-slate-400">语言</label>
                  <select value={language} onChange={(e) => setLanguage(e.target.value)} className="field w-full text-[12px]">
                    <option value="zh">中文</option>
                    <option value="en">English</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-slate-400">听众（可选）</label>
                  <input
                    value={audience}
                    onChange={(e) => setAudience(e.target.value)}
                    placeholder="例如：公司高管 / 技术团队"
                    className="field w-full text-[12px]"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-slate-400">模型（可选）</label>
                  <select value={model} onChange={(e) => setModel(e.target.value)} className="field w-full text-[12px]">
                    <option value="">默认模型</option>
                    {chaosModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label || m.id}
                        {m.installed ? '' : '（未下载）'}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="flex items-end pb-1.5">
                  <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-slate-300">
                    <input type="checkbox" checked={withToc} onChange={(e) => setWithToc(e.target.checked)} />
                    生成目录页（5 页以上）
                  </label>
                </div>
              </div>

              <div className="mt-4 flex gap-2">
                <button className="btn-primary flex-1" disabled={busy || !topic.trim()} onClick={generate}>
                  {phase === 1 ? '策划中…' : phase === 2 ? '渲染中…' : `🖼️ 生成 ${pages || 6} 页 PPT`}
                </button>
                {outline && (
                  <button className="btn-ghost shrink-0 px-3" disabled={rendering} onClick={rerender} title="用当前大纲重新渲染（不重新问模型）">
                    {rendering ? '渲染中…' : '♻️ 重新渲染'}
                  </button>
                )}
              </div>

              {result && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-600/40 bg-emerald-900/15 px-3 py-2">
                  <span className="text-[12px] text-emerald-300">✓ 《{result.title}》{result.pages} 页</span>
                  {result.tokens ? (
                    <span className="font-mono text-[10px] text-slate-500" title="已计入今日 Token 额度">
                      本次 ~{Number(result.tokens).toLocaleString()} token（已计入额度）
                    </span>
                  ) : null}
                  <button className="btn-success ml-auto px-2.5 py-1 text-[11.5px]" onClick={() => download(result.id, `${result.title}.pptx`)}>
                    ⬇️ 下载 PPT
                  </button>
                </div>
              )}
            </div>

            {/* 大纲编辑（折叠） */}
            {outline && (
              <div className="mt-3 rounded-xl border border-ink-500 bg-ink-800 p-4">
                <button
                  className="flex w-full items-center gap-2 text-left"
                  onClick={() => setShowEditor((v) => !v)}
                >
                  <span className="panel-title !mb-0">大纲编辑（改完点「重新渲染」）</span>
                  <span className="chip">{asArr(outline.slides).length} 页</span>
                  <span className="ml-auto text-[11px] text-slate-500">{showEditor ? '收起 ▲' : '展开 ▼'}</span>
                </button>
                {showEditor && (
                  <>
                    <label className="mb-1 mt-3 block text-[10.5px] text-slate-500">总标题</label>
                    <input
                      value={outline.title || ''}
                      onChange={(e) => setOutline({ ...outline, title: e.target.value })}
                      className="field mb-2 w-full text-[12px]"
                    />
                    <label className="mb-1 block text-[10.5px] text-slate-500">副标题</label>
                    <input
                      value={outline.subtitle || ''}
                      onChange={(e) => setOutline({ ...outline, subtitle: e.target.value })}
                      className="field mb-3 w-full text-[12px]"
                    />
                    <div className="max-h-[24rem] space-y-2.5 overflow-y-auto pr-1">
                      {asArr(outline.slides).map((s, i) => (
                        <div key={i} className="rounded-lg border border-ink-600 bg-ink-900 p-2.5">
                          <div className="mb-1 flex items-center gap-1.5">
                            <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[9.5px] text-slate-400">
                              {i === 0 ? '封面' : i === asArr(outline.slides).length - 1 ? '结尾' : `P${i + 1}`}
                            </span>
                            <input
                              value={s.title || ''}
                              onChange={(e) => patchSlide(i, { title: e.target.value })}
                              className="field min-w-0 flex-1 py-0.5 text-[11.5px]"
                            />
                          </div>
                          <textarea
                            value={asArr(s.body).join('\n')}
                            onChange={(e) =>
                              patchSlide(i, {
                                body: e.target.value
                                  .split('\n')
                                  .map((x) => x.trim())
                                  .filter(Boolean),
                              })
                            }
                            rows={Math.max(2, Math.min(5, asArr(s.body).length))}
                            placeholder="每行一条要点"
                            className="field w-full resize-y text-[11px] leading-relaxed"
                          />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 历史 */}
            {files.length > 0 && (
              <div className="mt-3">
                <div className="panel-title mb-1.5">最近生成的 PPT</div>
                <div className="space-y-1.5">
                  {files.map((f) => (
                    <div key={f.id || f.name} className="flex items-center gap-2 rounded-lg border border-ink-500 bg-ink-800 px-3 py-2">
                      <span>🖼️</span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200" title={f.name}>
                        {f.name.replace(/_[a-f0-9]{16}\.pptx$/, '')}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-500">{(f.size / 1024).toFixed(0)} KB</span>
                      {f.hasOutline && (
                        <button className="btn-ghost shrink-0 px-2 py-0.5 text-[11px]" onClick={() => loadOutline(f.id)} title="载入大纲改一改">
                          ✏️ 改
                        </button>
                      )}
                      <button className="btn-ghost shrink-0 px-2 py-0.5 text-[11px]" disabled={!f.id} onClick={() => download(f.id, f.name)}>
                        ⬇️ 下载
                      </button>
                      <button
                        className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-boss/15 hover:text-boss-strong"
                        title="删除这份 PPT"
                        onClick={() => remove(f.id)}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* ---------------- 右：实时预览 ---------------- */}
          <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
            <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="panel-title !mb-0">成品预览</span>
                <span className="chip">{withToc && asArr(outline?.slides).length >= 5 ? '含目录页' : '无目录'}</span>
              </div>
              <SlidePreview
                outline={outline}
                themeId={theme}
                withToc={withToc}
                index={slideIndex}
                onIndex={setSlideIndex}
              />

              <div className="mt-3 rounded-lg border border-ink-600 bg-ink-900 p-2.5">
                <p className="mb-1.5 text-[10.5px] font-medium text-slate-400">制作进度</p>
                <ProgressSteps phase={phase} elapsed={elapsed} />
                {phase === 3 && <p className="mt-1.5 text-[10px] text-emerald-400/80">已完成 · 可直接下载或继续改大纲</p>}
                {phase === 0 && <p className="mt-1.5 text-[10px] text-slate-600">填好主题后点「生成」开始</p>}
              </div>

              {/* 大纲速览 */}
              <div className="mt-3">
                <p className="mb-1.5 text-[10.5px] font-medium text-slate-400">
                  大纲速览 {asArr(outline?.slides).length ? `· ${asArr(outline.slides).length} 页` : ''}
                </p>
                {asArr(outline?.slides).length ? (
                  <ol className="max-h-56 space-y-0.5 overflow-y-auto pr-1">
                    {asArr(outline.slides).map((s, i) => (
                      <li key={i}>
                        <button
                          className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-[10.5px] text-slate-400 hover:bg-ink-700 hover:text-slate-200"
                          onClick={() => setSlideIndex(Math.min(i, 99))}
                          title={asArr(s.body).join(' / ')}
                        >
                          <span className="shrink-0 font-mono text-slate-600">{i + 1}</span>
                          <span className="min-w-0 flex-1 truncate">{s.title}</span>
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-[10px] leading-relaxed text-slate-600">生成后这里会列出每一页的标题，点一下跳到对应成品页。</p>
                )}
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
