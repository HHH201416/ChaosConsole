import { useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken, streamPost } from '../lib/api'
import { useStore } from '../store'
import { asArr } from '../lib/meta'

/**
 * 9.8.0：AIPPT —— 左侧 TAB 页。
 *
 * 左栏：主题 + 页数 + 模板 + 语气 + 语言 + 受众 + 配图开关 → 生成
 * 右栏：**边生成边看** ——
 *   · 实时思路：模型先把可用的数据与论据流式列出来，再据此成稿（避免写出没有内容的空话页）
 *   · 成品预览：大纲一成页就按真实版式/配色画出来，和下载的 pptx 一一对应
 *   · 配图进度：每出一张图立刻显示缩略图
 *
 * 为什么右栏能当真预览：pptx 用的是「同一份大纲 + 同一套模板 + 同一批配图」渲染的，
 * 预览不是示意图，是成品的样子。
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
  { id: 'emerald', label: '暗夜绿', desc: '深色封面 + 亮绿', coverStyle: 'full', coverBg: '#0F172A', coverTitle: '#FFFFFF', coverSub: '#A7F3D0', pageBg: '#FFFFFF', title: '#0F172A', text: '#334155', accent: '#22C55E', tocBg: '#F8FAFC', panel: '#F1F5F9' },
  { id: 'business', label: '商务蓝', desc: '藏青配亮蓝', coverStyle: 'split', coverBg: '#0B2545', coverTitle: '#FFFFFF', coverSub: '#93B4D8', pageBg: '#FFFFFF', title: '#0B2545', text: '#334155', accent: '#2563EB', tocBg: '#F5F8FC', panel: '#EEF4FC' },
  { id: 'minimal', label: '极简白', desc: '白底大字', coverStyle: 'band', coverBg: '#F4F5F7', coverTitle: '#111827', coverSub: '#6B7280', pageBg: '#FFFFFF', title: '#111827', text: '#374151', accent: '#111827', tocBg: '#FAFAFA', panel: '#F3F4F6' },
  { id: 'sunset', label: '活力橙', desc: '暖色，路演有劲', coverStyle: 'band', coverBg: '#2A1503', coverTitle: '#FFFFFF', coverSub: '#FDBA74', pageBg: '#FFFFFF', title: '#7C2D12', text: '#44403C', accent: '#F97316', tocBg: '#FFF7ED', panel: '#FFF1E5' },
  { id: 'violet', label: '科技紫', desc: '深紫配亮紫', coverStyle: 'full', coverBg: '#170B2E', coverTitle: '#FFFFFF', coverSub: '#C4B5FD', pageBg: '#FFFFFF', title: '#1E1B4B', text: '#3730A3', accent: '#8B5CF6', tocBg: '#F5F3FF', panel: '#F1ECFE' },
  { id: 'ocean', label: '深海青', desc: '青蓝冷静', coverStyle: 'split', coverBg: '#042F2E', coverTitle: '#FFFFFF', coverSub: '#99F6E4', pageBg: '#FFFFFF', title: '#134E4A', text: '#334155', accent: '#0D9488', tocBg: '#F0FDFA', panel: '#E7F8F4' },
  { id: 'crimson', label: '玫瑰红', desc: '沉稳酒红', coverStyle: 'full', coverBg: '#2B0A14', coverTitle: '#FFFFFF', coverSub: '#FDA4AF', pageBg: '#FFFFFF', title: '#4C0519', text: '#3F3F46', accent: '#E11D48', tocBg: '#FFF1F2', panel: '#FFE4E6' },
  { id: 'graphite', label: '石墨灰', desc: '黑白灰最保险', coverStyle: 'band', coverBg: '#E4E4E7', coverTitle: '#18181B', coverSub: '#52525B', pageBg: '#FFFFFF', title: '#18181B', text: '#3F3F46', accent: '#18181B', tocBg: '#FAFAFA', panel: '#F4F4F5' },
  { id: 'sky', label: '天空蓝', desc: '清爽天蓝，产品介绍', coverStyle: 'full', coverBg: '#082F49', coverTitle: '#FFFFFF', coverSub: '#BAE6FD', pageBg: '#FFFFFF', title: '#0C4A6E', text: '#334155', accent: '#0EA5E9', tocBg: '#F0F9FF', panel: '#E0F2FE' },
  { id: 'sand', label: '暖沙金', desc: '大地暖调，文化生活', coverStyle: 'split', coverBg: '#292018', coverTitle: '#FFFFFF', coverSub: '#FDE68A', pageBg: '#FFFFFF', title: '#78350F', text: '#44403C', accent: '#D97706', tocBg: '#FFFBEB', panel: '#FEF3C7' },
]

const EXAMPLES = ['新能源汽车行业分析', '鸿蒙应用开发入门', '季度工作总结汇报', 'AI 大模型技术演进']

const MIN_PAGES = 3
const MAX_PAGES = 30

const PHASE_LABELS = [
  { id: 'plan', label: '搜集数据与论据' },
  { id: 'outline', label: '逐页排大纲' },
  { id: 'image', label: '生成配图' },
  { id: 'render', label: '排版渲染' },
]

/** 从流式 JSON 里抢跑出已完成页的标题（模型还没写完就能看到大纲在长出来） */
function sniffTitles(text) {
  const out = []
  const re = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(String(text || '')))) {
    const t = m[1].replace(/\\"/g, '').trim()
    if (t && out[out.length - 1] !== t) out.push(t)
  }
  return out.slice(0, 40)
}

/* ------------------------------------------------------------------ *
 * 成品预览：按真实模板/版式画幻灯片
 * ------------------------------------------------------------------ */

function SlidePreview({ outline, themeId, withToc, index, onIndex }) {
  const T = THEMES.find((t) => t.id === themeId) || THEMES[0]
  const slides = asArr(outline?.slides)
  const toc = withToc && slides.length >= 5

  const frames = useMemo(() => {
    if (!outline || !slides.length) return []
    const out = []
    out.push({
      kind: 'cover',
      title: outline.title || '（未填标题）',
      sub: outline.subtitle || slides[0]?.body?.[0] || '',
      pic: slides[0]?.imageName,
    })
    if (toc) out.push({ kind: 'toc', items: slides.slice(1, -1).map((s) => s.title) })
    for (let i = 1; i < slides.length; i++) {
      const s = slides[i]
      out.push({
        kind: s.kind || 'bullets',
        title: s.title,
        kicker: s.kicker,
        body: asArr(s.body),
        extra: asArr(s.extra),
        stats: asArr(s.stats),
        pic: s.imageName,
      })
    }
    return out
  }, [outline, toc, slides])

  const cur = Math.min(Math.max(index, 0), Math.max(0, frames.length - 1))
  const f = frames[cur]

  if (!outline || !frames.length) {
    return (
      <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-ink-600 bg-ink-900">
        <p className="px-4 text-center text-[12.5px] leading-relaxed text-slate-600">
          开始生成后，这里的页面会一页页长出来
          <br />
          版式和配色就是下载的 pptx 里的样子
        </p>
      </div>
    )
  }

  const picUrl = f.pic ? api.aipptImageUrl(f.pic) : ''

  return (
    <div>
      <div
        className="relative aspect-video w-full overflow-hidden rounded-lg border border-ink-600"
        style={{ background: f.kind === 'cover' || f.kind === 'closing' ? T.coverBg : f.kind === 'toc' ? T.tocBg : T.pageBg }}
      >
        {/* 封面 */}
        {f.kind === 'cover' && (
          <>
            {picUrl && T.coverStyle === 'full' && (
              <img src={picUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />
            )}
            {picUrl && T.coverStyle === 'split' && (
              <img src={picUrl} alt="" className="absolute inset-y-0 right-0 h-full w-[45%] object-cover" />
            )}
            <div className="relative flex h-full flex-col justify-center px-5">
              <div className="mb-2 h-[2px] w-8" style={{ background: T.accent }} />
              <p className="line-clamp-3 text-[18px] font-bold leading-snug" style={{ color: T.coverTitle }}>
                {f.title}
              </p>
              {f.sub && (
                <p className="mt-1.5 line-clamp-2 text-[10.5px] leading-relaxed" style={{ color: T.coverSub }}>
                  {f.sub}
                </p>
              )}
            </div>
          </>
        )}

        {/* 目录 */}
        {f.kind === 'toc' && (
          <div className="h-full px-5 py-3">
            <p className="text-[14px] font-bold" style={{ color: T.title }}>
              目录
            </p>
            <div className="my-1 h-[2px] w-6" style={{ background: T.accent }} />
            <div className="space-y-0.5 overflow-hidden">
              {f.items.slice(0, 7).map((t, i) => (
                <p key={i} className="truncate text-[9.5px]" style={{ color: T.text }}>
                  {String(i + 1).padStart(2, '0')} {t}
                </p>
              ))}
            </div>
          </div>
        )}

        {/* 结尾 */}
        {f.kind === 'closing' && (
          <>
            {picUrl && <img src={picUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-35" />}
            <div className="relative flex h-full flex-col items-center justify-center px-6 text-center">
              <div className="mb-2 h-[2px] w-10" style={{ background: T.accent }} />
              <p className="line-clamp-2 text-[14px] font-bold" style={{ color: T.coverTitle }}>
                {f.title}
              </p>
              {f.body[0] && (
                <p className="mt-1.5 line-clamp-2 text-[8.5px]" style={{ color: T.coverSub }}>
                  {f.body[0]}
                </p>
              )}
            </div>
          </>
        )}

        {/* 内容页公共页眉 */}
        {(f.kind === 'bullets' || f.kind === 'twocol' || f.kind === 'stats' || f.kind === 'quote') && (
          <div className="flex h-full flex-col px-4 py-3">
            <div className="shrink-0">
              {f.kicker && (
                <p className="mb-0.5 font-mono text-[7px] font-bold tracking-[0.2em]" style={{ color: T.accent }}>
                  {f.kicker}
                </p>
              )}
              <p className="line-clamp-1 text-[13px] font-bold" style={{ color: T.title }}>
                {f.title}
              </p>
              <div className="my-1 h-[2px] w-5" style={{ background: T.accent }} />
            </div>

            {/* 要点（有图则左文右图） */}
            {f.kind === 'bullets' && (
              <div className="flex min-h-0 flex-1 gap-2">
                <ul className={`space-y-1 ${picUrl ? 'w-[58%]' : 'w-full'}`}>
                  {f.body.slice(0, 5).map((t, i) => (
                    <li key={i} className="flex gap-1 text-[9.5px] leading-snug" style={{ color: T.text }}>
                      <span style={{ color: T.accent }}>•</span>
                      <span className="line-clamp-2">{t}</span>
                    </li>
                  ))}
                </ul>
                {picUrl && (
                  <div className="min-w-0 flex-1">
                    <img src={picUrl} alt="" className="h-[60%] w-full rounded-sm object-cover" />
                  </div>
                )}
              </div>
            )}

            {/* 双栏 */}
            {f.kind === 'twocol' && (
              <div className="flex min-h-0 flex-1 gap-2">
                {[f.body, f.extra].map((list, k) => (
                  <div key={k} className="flex-1 rounded-sm p-1.5" style={{ background: T.panel }}>
                    <div className="mb-0.5 h-[2px] w-4" style={{ background: k === 0 ? T.accent : T.text }} />
                    <ul className="space-y-0.5">
                      {asArr(list).slice(0, 3).map((t, i) => (
                        <li key={i} className="line-clamp-2 text-[9px] leading-snug" style={{ color: T.text }}>
                          • {t}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}

            {/* 数据卡 */}
            {f.kind === 'stats' && (
              <div className="flex min-h-0 flex-1 flex-col justify-center">
                <div className="flex gap-2">
                  {f.stats.slice(0, 3).map((st, i) => (
                    <div key={i} className="flex-1 rounded-sm py-1.5 text-center" style={{ background: T.panel }}>
                      <p className="text-[15px] font-bold leading-none" style={{ color: T.accent }}>
                        {st.v}
                      </p>
                      <p className="mt-0.5 line-clamp-2 px-1 text-[7px]" style={{ color: T.text }}>
                        {st.l}
                      </p>
                    </div>
                  ))}
                </div>
                {f.body[0] && (
                  <p className="mt-1.5 line-clamp-2 text-center text-[9px]" style={{ color: T.text }}>
                    {f.body[0]}
                  </p>
                )}
              </div>
            )}

            {/* 金句 */}
            {f.kind === 'quote' && (
              <div className="flex min-h-0 flex-1 items-center gap-2">
                <div className="h-[70%] w-[3px] shrink-0" style={{ background: T.accent }} />
                <p className="line-clamp-4 text-[12.5px] leading-relaxed" style={{ color: T.title }}>
                  {f.body[0] || f.title}
                </p>
              </div>
            )}
          </div>
        )}

        <span
          className="absolute bottom-1 right-2 font-mono text-[9px]"
          style={{ color: f.kind === 'cover' || f.kind === 'closing' ? T.coverSub : '#94A3B8' }}
        >
          {cur + 1} / {frames.length}
        </span>
      </div>

      {/* 翻页 */}
      <div className="mt-1.5 flex items-center gap-1">
        <button className="btn-ghost px-2 py-0.5 text-[13px]" disabled={cur <= 0} onClick={() => onIndex(cur - 1)} title="上一页">
          ‹
        </button>
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
          {frames.map((it, i) => (
            <button
              key={i}
              onClick={() => onIndex(i)}
              title={it.title || `第 ${i + 1} 页`}
              className={`h-1.5 shrink-0 rounded-full transition-all ${i === cur ? 'w-5 bg-boss' : 'w-1.5 bg-ink-600 hover:bg-ink-500'}`}
            />
          ))}
        </div>
        <button
          className="btn-ghost px-2 py-0.5 text-[13px]"
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

function ProgressSteps({ phase, labels }) {
  const activeIdx = PHASE_LABELS.findIndex((p) => p.id === phase)
  return (
    <div className="space-y-1">
      {PHASE_LABELS.map((p, i) => {
        const done = activeIdx > i || phase === 'done'
        const active = p.id === phase
        return (
          <div key={p.id} className="flex items-center gap-2 text-[11px]">
            <span
              className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[9px] ${
                done ? 'bg-emerald-500/20 text-emerald-300' : active ? 'bg-sky-500/20 text-sky-300' : 'bg-ink-700 text-slate-600'
              }`}
            >
              {done ? '✓' : active ? '•' : i + 1}
            </span>
            <span className={done ? 'text-slate-400' : active ? 'text-sky-300' : 'text-slate-600'}>
              {labels?.[p.id] || p.label}
            </span>
            {active && <span className="ml-auto h-1 w-1 animate-pulseDot rounded-full bg-sky-400" />}
          </div>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 页面
 * ------------------------------------------------------------------ */

export default function AipptPage() {
  const toast = useStore((s) => s.toast)

  const [topic, setTopic] = useState('')
  const [pages, setPages] = useState(6)
  const [tone, setTone] = useState('formal')
  const [theme, setTheme] = useState('emerald')
  const [language, setLanguage] = useState('zh')
  const [audience, setAudience] = useState('')
  const [withToc, setWithToc] = useState(true)
  const [withImages, setWithImages] = useState(true)
  const model = '' // 9.8.2：档位取代了手动选模型，保留入参兼容老的大纲重渲染
  // 9.8.2：速度档位。纯 CPU 上 7B 出一份 6 页稿子约 70 秒，1.5B 约 25 秒但要点偏少。
  // 默认 auto 走 7B —— 多等 40 秒拿一份能直接讲的稿子，比快但空洞划算。
  const [speed, setSpeed] = useState('auto')
  const [usedModel, setUsedModel] = useState('')
  // 9.8.2：配图来源。auto = 有 Key 就联网找照片、没有就 AI 生成；
  // web = 只用真实照片（搜不到才退回 AI）；ai = 只用 AI 生成。
  const [imageSource, setImageSource] = useState('auto')
  const [webReady, setWebReady] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keySaving, setKeySaving] = useState(false)

  const [phase, setPhase] = useState('') // ''|plan|outline|image|render|done
  const [phaseLabels, setPhaseLabels] = useState({})
  const [elapsed, setElapsed] = useState(0)
  const [planText, setPlanText] = useState('')
  const [outlineDraft, setOutlineDraft] = useState('')
  const [partial, setPartial] = useState([])
  // 9.8.2：边写边预览 —— 服务端每写完一页就推一份「还不完整的大纲」过来，
  // 大预览框里能看见页面一页页长出来，而不是等全部写完才一次性弹出。
  const [liveOutline, setLiveOutline] = useState(null)
  const [imgProgress, setImgProgress] = useState({ done: 0, total: 0 })
  const [thumbs, setThumbs] = useState([])

  const [result, setResult] = useState(null)
  const [files, setFiles] = useState([])
  const [outline, setOutline] = useState(null)
  const [rendering, setRendering] = useState(false)
  const [slideIndex, setSlideIndex] = useState(0)
  const [showEditor, setShowEditor] = useState(false)

  const timer = useRef(null)
  const abortRef = useRef(null)
  const planBuf = useRef('')
  const outlineBuf = useRef('')
  const lastFlush = useRef(0)
  const thinkRef = useRef(null)

  const busy = phase === 'plan' || phase === 'outline' || phase === 'image' || phase === 'render'
  // 大预览显示谁：定稿大纲优先，没有就显示「还在写」的实时大纲
  const showing = outline || liveOutline
  const liveView = !outline && Boolean(liveOutline)
  const showCount = asArr(showing?.slides).length
  // 左侧页码条（WPS 那种胶片条）：页码 + 页型色点，点一下直接跳页
  const filmstrip = useMemo(() => {
    if (!showCount) return []
    const out = [{ i: 0, label: '封面', kind: 'cover' }]
    if (withToc && showCount >= 5) out.push({ i: 1, label: '目录', kind: 'toc' })
    const base = out.length
    const slides = asArr(showing?.slides)
    for (let k = 1; k < showCount; k++) {
      out.push({ i: base + k - 1, label: slides[k]?.title || `第 ${k + 1} 页`, kind: slides[k]?.kind || 'bullets' })
    }
    return out
  }, [showing, withToc, showCount])

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
    // 图库 Key 是否配置决定「联网查找照片」能不能真的用上，进页面就问一次
    api
      .aipptImageSource()
      .then((res) => setWebReady(Boolean(res?.data?.webReady)))
      .catch(() => setWebReady(false))
  }, [])

  const saveImageKey = async () => {
    const k = keyInput.trim()
    setKeySaving(true)
    try {
      const res = await api.aipptSetImageKey(k)
      if (res?.ok) {
        setWebReady(Boolean(res.data?.webReady))
        setKeyInput('')
        setKeyOpen(false)
        toast(k ? '已保存图库 Key，联网找图可用了' : '已清空图库 Key，配图将用 AI 生成', 'success')
      } else {
        toast(res?.error || '保存失败', 'error')
      }
    } catch (err) {
      toast(err?.message || '保存失败', 'error')
    } finally {
      setKeySaving(false)
    }
  }

  // 思考文本在长：跟着滚到底，不然用户只能看到最开头那几行
  useEffect(() => {
    const el = thinkRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [planText, outlineDraft])

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

  /* 流式增量：攒 80ms 再刷一次，避免每个 token 都触发一次渲染 */
  const flush = (force = false) => {
    const now = Date.now()
    if (!force && now - lastFlush.current < 80) return
    lastFlush.current = now
    if (outlineBuf.current) {
      setOutlineDraft(outlineBuf.current)
      setPartial(sniffTitles(outlineBuf.current))
    }
    if (planBuf.current) setPlanText(planBuf.current)
  }

  const stop = () => {
    try {
      abortRef.current?.abort()
    } catch (_) {
      /* ignore */
    }
    setPhase('')
    toast('已停止生成', 'info')
  }

  // 单次流式请求。抽出来是为了「没拿到成品就自动重来」——重试时得把缓冲、
  // 大纲、缩略图都清干净再发一份新请求，不然界面上会残留上一次的碎片。
  const runOnce = async () => {
    planBuf.current = ''
    outlineBuf.current = ''
    setPlanText('')
    setOutlineDraft('')
    setPartial([])
    setThumbs([])
    setOutline(null)
    setLiveOutline(null)
    setImgProgress({ done: 0, total: 0 })
    setPhaseLabels({})
    setPhase('plan')

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const res = await streamPost(
      '/api/aippt/stream',
      {
        topic: topic.trim(),
        pages,
        tone,
        theme,
        language,
        audience: audience.trim(),
        withToc,
        withImages,
        speed,
        imageSource: withImages ? imageSource : undefined,
        model: model || undefined,
      },
      (ev) => {
        if (ev.type === 'model') {
          setUsedModel(ev.outlineModel || '')
          return
        }
        if (ev.type === 'notice') {
          // 联网通道不可用（没 Key / 限流 / 搜不到）——只提示一次，配图已自动降级
          if (ev.field === 'image') {
            const why =
              ev.reason === 'no-key'
                ? '未配置图库 Key，配图已改用 AI 生成'
                : ev.reason === 'rate-limited'
                  ? '图库今天额度用完了，配图已改用 AI 生成'
                  : '没搜到合适的照片，配图已改用 AI 生成'
            toast(why, 'info')
          }
          return
        }
        if (ev.type === 'phase') {
          setPhase(ev.phase)
          if (ev.label) setPhaseLabels((prev) => ({ ...prev, [ev.phase]: ev.label }))
          if (ev.phase === 'image' && typeof ev.total === 'number') setImgProgress({ done: 0, total: ev.total })
        } else if (ev.type === 'delta') {
          if (ev.phase === 'plan') {
            planBuf.current += ev.text
            flush()
          } else if (ev.phase === 'outline') {
            outlineBuf.current += ev.text
            flush()
          }
        } else if (ev.type === 'progress') {
          // pending 只是「在排队」，别拿它推进进度条，否则 3 路同时起跑会一下跳到 3/3
          if (!ev.pending) setImgProgress({ done: ev.done || 0, total: ev.total || 0 })
          setPhaseLabels((prev) => ({ ...prev, image: ev.label || prev.image }))
          if (ev.name) setThumbs((prev) => [...prev, ev.name])
          // 配图一出就把 imageName 写回大纲，预览立刻能看见图
          if (ev.name && typeof ev.index === 'number') {
            setOutline((prev) =>
              prev
                ? { ...prev, slides: asArr(prev.slides).map((s, i) => (i === ev.index ? { ...s, imageName: ev.name } : s)) }
                : prev,
            )
          }
        } else if (ev.type === 'preview' && ev.outline) {
          // 还在写的大纲：先渲染成真版式给用户看，页数会一页页往上加
          setLiveOutline(ev.outline)
          setPartial(asArr(ev.outline.slides).map((s) => s.title))
        } else if (ev.type === 'outline' && ev.outline) {
          // 大纲定稿：立刻把预览切出来，用户不用等到渲染完才看到东西
          setOutline(ev.outline)
          setLiveOutline(null)
          setPartial(asArr(ev.outline.slides).map((s) => s.title))
        }
      },
      ctrl.signal,
    )

    abortRef.current = null
    flush(true)
    return res
  }

  const finish = (data) => {
    setPhase('done')
    setResult(data)
    setOutline(data.outline || null)
    setSlideIndex(0)
    toast(`PPT 已生成：《${data.title}》${data.pages} 页${data.images ? ` · ${data.images} 张配图` : ''}`, 'success')
    // AIPPT 的消耗已经记进每日额度，刷新额度卡让用户看到
    useStore.getState().loadChaosStatus?.()
    refreshFiles()
  }

  /**
   * 9.8.2：任务没完成就不收工。
   * 断流、服务端报错、模型吐垃圾 —— 一律自动重来，最多 3 轮；
   * 只有用户点「停止」才算真的结束。
   */
  const generate = async () => {
    if (!topic.trim() || busy) return
    setResult(null)
    setSlideIndex(0)

    let lastErr = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await runOnce()
      if (res.aborted) {
        setPhase('')
        return
      }
      if (res.ok) {
        finish(res.result)
        return
      }
      lastErr = res.error || '生成失败'
      if (attempt < 3) {
        toast(`生成中断（${lastErr}），第 ${attempt} 次自动重试…`, 'info')
        // 稍等一下再重来：模型刚吐完垃圾就立刻再问，很容易再撞一次同样的错
        await new Promise((r) => setTimeout(r, 900 * attempt))
        continue
      }
    }
    setPhase('')
    toast(lastErr, 'error')
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
      setResult((prev) => ({ ...prev, ...res.data }))
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
      setPhase('done')
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
        setPhase('')
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

  const themeMeta = THEMES.find((t) => t.id === theme) || THEMES[0]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xl">🖼️</span>
          <h2 className="text-[15px] font-semibold text-slate-100">AIPPT · 一句话生成 PPT</h2>
          <span className="chip">先推理再成稿 · 自动配图 · 10 套模板</span>
        </div>

        {/* 9.8.2：预览框放大 —— 以前右栏只有 23rem，幻灯片小到看不清正文；
            现在右栏吃 28-44rem，左栏表单保持能用的最小宽度。 */}
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(28rem,44rem)]">
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

              {/* 页数 */}
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

              {/* 模板 */}
              <div className="mb-1 mt-4 flex items-center gap-2">
                <label className="text-[11px] text-slate-400">模板</label>
                <span className="text-[10px] text-slate-600">{themeMeta.desc}</span>
              </div>
              <div className="grid grid-cols-4 gap-1.5">
                {THEMES.map((th) => (
                  <button
                    key={th.id}
                    onClick={() => setTheme(th.id)}
                    title={th.desc}
                    className={`group rounded-lg border p-1.5 text-left transition-colors ${
                      theme === th.id
                        ? 'border-boss bg-boss/15'
                        : 'border-ink-500 hover:border-ink-400 hover:bg-ink-700/40'
                    }`}
                  >
                    <span
                      className="mb-1 flex h-6 w-full items-end justify-end gap-[2px] overflow-hidden rounded"
                      style={{ background: th.coverBg }}
                    >
                      <span className="h-3 w-1.5 rounded-t-sm" style={{ background: th.accent }} />
                      <span className="h-4 w-1.5 rounded-t-sm opacity-70" style={{ background: th.coverSub }} />
                      <span className="h-2 w-1.5 rounded-t-sm opacity-40" style={{ background: th.coverTitle }} />
                    </span>
                    <span className={`block truncate text-[10.5px] ${theme === th.id ? 'text-boss-strong' : 'text-slate-300'}`}>
                      {th.label}
                    </span>
                  </button>
                ))}
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

              {/* 语言 / 受众 / 模型 / 开关 */}
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
                  <label className="mb-1 block text-[11px] text-slate-400">生成速度</label>
                  <div className="flex gap-1">
                    {[
                      ['auto', '自动', '按机器自动选'],
                      ['fast', '极速', '小模型，约 1 分钟'],
                      ['balanced', '标准', '7B，约 2 分钟'],
                      ['quality', '精品', '7B 精细，最慢'],
                    ].map(([id, label, tip]) => (
                      <button
                        key={id}
                        type="button"
                        title={tip}
                        onClick={() => setSpeed(id)}
                        className={`flex-1 rounded-md border px-1.5 py-1.5 text-[11px] transition ${
                          speed === id
                            ? 'border-sky-500/70 bg-sky-500/15 text-sky-200'
                            : 'border-slate-700/70 bg-slate-800/40 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {usedModel ? (
                    <p className="mt-1 truncate text-[10px] text-slate-500" title={usedModel}>
                      本次使用 {usedModel}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-col justify-end gap-1.5 pb-1">
                  <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-slate-300">
                    <input type="checkbox" checked={withImages} onChange={(e) => setWithImages(e.target.checked)} />
                    自动配图（按内容决定张数）
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-slate-300">
                    <input type="checkbox" checked={withToc} onChange={(e) => setWithToc(e.target.checked)} />
                    生成目录页（5 页以上）
                  </label>
                </div>
              </div>

              {withImages ? (
                <div className="mt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <label className="text-[11px] text-slate-400">配图来源</label>
                    <button
                      type="button"
                      className="text-[10.5px] text-sky-300/80 hover:text-sky-200"
                      onClick={() => setKeyOpen((v) => !v)}
                    >
                      {webReady ? '图库已连接 · 修改' : '配置图库 Key'}
                    </button>
                  </div>
                  <div className="flex gap-1">
                    {[
                      ['auto', '自动', webReady ? '有 Key 就用真实照片，否则 AI 生成' : '未配置 Key，先用 AI 生成'],
                      ['web', '联网照片', '从图库搜真实照片，搜不到才退回 AI'],
                      ['ai', 'AI 生成', '全部由 AI 绘制插画'],
                    ].map(([id, label, tip]) => (
                      <button
                        key={id}
                        type="button"
                        title={tip}
                        onClick={() => setImageSource(id)}
                        className={`flex-1 rounded-md border px-1.5 py-1.5 text-[11px] transition ${
                          imageSource === id
                            ? 'border-sky-500/70 bg-sky-500/15 text-sky-200'
                            : 'border-slate-700/70 bg-slate-800/40 text-slate-400 hover:border-slate-600'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] leading-relaxed text-slate-500">
                    {imageSource === 'web' && !webReady
                      ? '还没配置图库 Key，会先尝试联网，搜不到再退回 AI 生成。'
                      : '张数按内容自动决定：讲场景、讲客户的页面才配图，纯指标页不硬凑。'}
                  </p>
                  {keyOpen ? (
                    <div className="mt-2 rounded-md border border-slate-700/70 bg-slate-800/40 p-2">
                      <p className="mb-1.5 text-[10.5px] leading-relaxed text-slate-400">
                        填 Pexels 免费 Key（pexels.com 注册即可获取）。留空表示清除。
                      </p>
                      <div className="flex gap-1.5">
                        <input
                          value={keyInput}
                          onChange={(e) => setKeyInput(e.target.value)}
                          placeholder="粘贴 Pexels API Key"
                          className="field flex-1 text-[11px]"
                          type="password"
                        />
                        <button
                          type="button"
                          className="btn-ghost px-2.5 text-[11px]"
                          disabled={keySaving}
                          onClick={saveImageKey}
                        >
                          {keySaving ? '保存中…' : '保存'}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="mt-4 flex gap-2">
                <button className="btn-primary flex-1" disabled={busy || !topic.trim()} onClick={generate}>
                  {busy ? '生成中…' : `🖼️ 生成 ${pages || 6} 页 PPT`}
                </button>
                {busy ? (
                  <button className="btn-ghost shrink-0 px-3" onClick={stop} title="停下当前生成">
                    ⏹ 停止
                  </button>
                ) : (
                  outline && (
                    <button className="btn-ghost shrink-0 px-3" disabled={rendering} onClick={rerender} title="用当前大纲重新渲染（不重新问模型）">
                      {rendering ? '渲染中…' : '♻️ 重新渲染'}
                    </button>
                  )
                )}
              </div>

              {result && phase === 'done' && (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-emerald-600/40 bg-emerald-900/15 px-3 py-2">
                  <span className="text-[12px] text-emerald-300">
                    ✓ 《{result.title}》{result.pages} 页
                  </span>
                  {result.images ? <span className="chip bg-emerald-500/15 text-emerald-300">{result.images} 张配图</span> : null}
                  {result.tokens ? (
                    <span className="font-mono text-[10px] text-slate-500" title="已计入今日 Token 额度">
                      ~{Number(result.tokens).toLocaleString()} token
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
                <button className="flex w-full items-center gap-2 text-left" onClick={() => setShowEditor((v) => !v)}>
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
                    <div className="max-h-[26rem] space-y-2.5 overflow-y-auto pr-1">
                      {asArr(outline.slides).map((s, i) => (
                        <div key={i} className="rounded-lg border border-ink-600 bg-ink-900 p-2.5">
                          <div className="mb-1 flex items-center gap-1.5">
                            <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[9.5px] text-slate-400">
                              {i === 0 ? '封面' : i === asArr(outline.slides).length - 1 ? '结尾' : `P${i + 1}`}
                            </span>
                            <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 text-[9px] text-slate-500">
                              {({ cover: '封面', bullets: '要点', twocol: '双栏', stats: '数据', quote: '金句', closing: '结尾' })[s.kind] || '要点'}
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
                          {s.kind === 'stats' && (
                            <p className="mt-1 text-[9.5px] text-slate-600">
                              数据卡：{asArr(s.stats).map((x) => `${x.v} ${x.l}`).join(' · ') || '（无）'}
                            </p>
                          )}
                          {s.image && (
                            <p className="mt-1 truncate text-[9.5px] text-slate-600" title={s.image}>
                              🖼️ {s.image}
                            </p>
                          )}
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

          {/* ---------------- 右：大预览（大纲边写边出 · 配图边出边插 · 排版实时回填） ---------------- */}
          <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
            <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
              <div className="mb-2 flex flex-wrap items-center gap-1.5">
                <span className="text-[11.5px] font-medium text-slate-300">成品预览</span>
                {liveView && busy ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[9.5px] text-sky-300">
                    <span className="h-1 w-1 animate-pulseDot rounded-full bg-sky-400" />
                    实时生成
                  </span>
                ) : null}
                {rendering ? (
                  <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] text-amber-300">
                    <span className="h-1 w-1 animate-pulseDot rounded-full bg-amber-400" />
                    重新排版中
                  </span>
                ) : null}
                <div className="ml-auto flex items-center gap-1">
                  <span className="chip">{showCount ? `${showCount} 页` : '待生成'}</span>
                  {withToc && showCount >= 5 ? <span className="chip">含目录</span> : null}
                </div>
              </div>

              <div className="flex min-h-0 gap-2">
                {/* 胶片条：像 WPS 左侧那排页码，一页页长出来 */}
                {filmstrip.length ? (
                  <div className="hidden w-11 shrink-0 flex-col gap-1 overflow-y-auto pr-0.5 sm:flex" style={{ maxHeight: '32rem' }}>
                    {filmstrip.map((it) => (
                      <button
                        key={it.i}
                        onClick={() => setSlideIndex(it.i)}
                        title={it.label}
                        className={`relative flex h-7 shrink-0 items-center justify-center rounded border font-mono text-[10px] transition ${
                          slideIndex === it.i
                            ? 'border-boss/60 bg-boss/15 text-boss-strong'
                            : 'border-ink-600 bg-ink-900 text-slate-500 hover:border-slate-600 hover:text-slate-300'
                        }`}
                      >
                        {it.i + 1}
                        <span
                          className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full"
                          style={{ background: it.kind === 'cover' ? '#22C55E' : it.kind === 'toc' ? '#94A3B8' : '#64748B' }}
                        />
                      </button>
                    ))}
                  </div>
                ) : null}

                <div className="relative min-w-0 flex-1">
                  <SlidePreview
                    outline={showing}
                    themeId={theme}
                    withToc={withToc}
                    index={slideIndex}
                    onIndex={setSlideIndex}
                  />
                  {rendering ? (
                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-ink-900/45">
                      <span className="rounded-md bg-ink-800/90 px-2 py-1 text-[10.5px] text-amber-300">重新排版中…</span>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* 配图缩略图：出一张插一张，图立刻能在预览里看到 */}
              {thumbs.length > 0 ? (
                <div className="mt-2">
                  <p className="mb-1 text-[10px] text-slate-500">
                    已生成配图 {imgProgress.done}/{imgProgress.total || thumbs.length}
                  </p>
                  <div className="flex gap-1 overflow-x-auto">
                    {thumbs.map((n, i) => (
                      <img
                        key={`${n}-${i}`}
                        src={api.aipptImageUrl(n)}
                        alt=""
                        className="h-10 w-16 shrink-0 rounded border border-ink-600 object-cover"
                      />
                    ))}
                  </div>
                </div>
              ) : null}

              <div className="mt-2.5 rounded-lg border border-ink-600 bg-ink-900 p-2.5">
                <div className="mb-1.5 flex items-center justify-between">
                  <p className="text-[10.5px] font-medium text-slate-400">
                    制作进度 {busy ? <span className="font-mono text-[9.5px] text-slate-500">· {elapsed}s</span> : null}
                  </p>
                  {phase === 'done' ? <span className="text-[9.5px] text-emerald-400/80">已完成</span> : null}
                </div>
                <ProgressSteps phase={phase} labels={phaseLabels} />
                {!phase ? <p className="mt-1.5 text-[10px] text-slate-600">填好主题后点「生成」开始</p> : null}
                {phase === 'done' ? (
                  <p className="mt-1.5 text-[10px] text-emerald-400/80">可直接下载，也可以改完大纲再重新排版</p>
                ) : null}
              </div>

              {/* 实时思路：默认在生成时展开，成品出来后收起，不抢预览的地方 */}
              <details className="mt-2 rounded-lg border border-ink-600 bg-ink-900 p-2.5" open={!outline && busy}>
                <summary className="cursor-pointer text-[10.5px] font-medium text-slate-400">
                  实时思路 {planText ? `· 素材 ${planText.length} 字` : ''}
                  {partial.length ? ` · 已出 ${partial.length} 页` : ''}
                </summary>
                <div ref={thinkRef} className="mt-1.5 max-h-56 overflow-y-auto pr-1">
                  <p className="mb-1 text-[10px] font-medium text-slate-500">
                    素材与论据（模型先搜集可落到页面上的硬信息）
                  </p>
                  <pre className="whitespace-pre-wrap break-words font-sans text-[10.5px] leading-relaxed text-slate-400">
                    {planText || (busy ? '等待模型开始推理…' : '还没开始。填好主题点「生成」就能看到模型的思考过程。')}
                  </pre>
                  {outlineDraft ? (
                    <details className="mt-1.5">
                      <summary className="cursor-pointer text-[9.5px] text-slate-600 hover:text-slate-400">
                        原始输出（全文 · {outlineDraft.length} 字）
                      </summary>
                      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px] leading-relaxed text-slate-600">
                        {outlineDraft}
                      </pre>
                    </details>
                  ) : null}
                </div>
              </details>
            </div>

            {/* 大纲速览 */}
            <div className="mt-3 rounded-xl border border-ink-500 bg-ink-800 p-3">
              <p className="mb-1.5 text-[10.5px] font-medium text-slate-400">
                大纲速览 {showCount ? `· ${showCount} 页` : ''}
              </p>
              {showCount ? (
                <ol className="max-h-64 space-y-0.5 overflow-y-auto pr-1">
                  {asArr(showing.slides).map((s, i) => (
                    <li key={i}>
                      <button
                        className="flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left text-[10.5px] text-slate-400 hover:bg-ink-700 hover:text-slate-200"
                        onClick={() => {
                          setSlideIndex(withToc && showCount >= 5 && i > 0 ? i + 1 : i)
                        }}
                        title={asArr(s.body).join(' / ')}
                      >
                        <span className="shrink-0 font-mono text-slate-600">{i + 1}</span>
                        <span className="min-w-0 flex-1 truncate">{s.title || '（这一页还没写出来）'}</span>
                        {s.imageName ? <span className="shrink-0 text-[9px] text-slate-600">🖼️</span> : null}
                      </button>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[10px] leading-relaxed text-slate-600">
                  开始生成后，这里会随模型写作一页页长出来，点一下跳到对应成品页。
                </p>
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
