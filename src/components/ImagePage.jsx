import { useEffect, useRef, useState } from 'react'
import { api, getToken } from '../lib/api'
import { useStore } from '../store'
import { asArr } from '../lib/meta'

/**
 * 9.8.2：AI 绘图 —— 高质量单图。
 *
 * 为什么单独做一个页面：PPT 里的配图是「为版面服务的插图」，尺寸固定、风格统一、
 * 由内容自动决定；而用户真正想要的常常是「我描述一个画面，给我一张能用的图」——
 * 那是另一件事，需要一个能写长提示词、选画幅、选风格、能反复重画的地方。
 *
 * 出图走的是同一条限流通道（免费额度每 IP 每 45 秒一张），所以这里做两件事：
 *   1. 把「排队中 / 生成中」实时显示出来，而不是一个转圈让人以为卡死；
 *   2. 画完立刻落盘缓存，同一提示词再点一次是秒回，不浪费额度。
 *
 * 10.0.0：Sora 级画质三件套 —— 分辨率拉高、提示词自动扩写成完整分镜、
 * 「换一张」一键换个演绎；生成过的图片可以单张删除也可以清空。
 */

const STYLES = [
  { id: 'photo', label: '照片写实', desc: '像摄影作品' },
  { id: 'illustration', label: '扁平插画', desc: '干净矢量风' },
  { id: 'cinematic', label: '电影感', desc: '强光比与氛围' },
  { id: 'threed', label: '3D 渲染', desc: '柔和棚拍光' },
  { id: 'minimal', label: '极简', desc: '大留白双色' },
  { id: 'ink', label: '水墨', desc: '宣纸笔触' },
]

const RATIOS = [
  { id: '16:9', label: '横屏 16:9', hint: '幻灯片 / 封面' },
  { id: '1:1', label: '方形 1:1', hint: '头像 / 社交' },
  { id: '9:16', label: '竖屏 9:16', hint: '手机 / 海报' },
  { id: '4:3', label: '标准 4:3', hint: '文档配图' },
]

const EXAMPLES = [
  '黄昏下的江南水乡，白墙黛瓦，河面倒影，薄雾',
  '一杯拉花咖啡放在木质桌面上，晨光从左侧照进来',
  '未来城市的夜景，玻璃幕墙反射霓虹，雨水打湿街道',
  '一间安静的书房，满墙书架，暖色台灯光',
]

export default function ImagePage() {
  const toast = useStore((s) => s.toast)

  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState('photo')
  const [ratio, setRatio] = useState('16:9')
  const [enhance, setEnhance] = useState(true)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [stage, setStage] = useState('') // '' | 'queue' | 'draw'
  const [current, setCurrent] = useState(null)
  const [history, setHistory] = useState([])

  const timer = useRef(null)

  const refresh = async () => {
    try {
      const res = await api.imageList()
      setHistory(asArr(res.data))
    } catch (_) {
      /* 列表失败不影响绘图 */
    }
  }

  useEffect(() => {
    refresh()
    return () => clearInterval(timer.current)
  }, [])

  const draw = async (seedOverride) => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    setCurrent(null)
    setElapsed(0)
    setStage('queue')
    const t0 = Date.now()
    timer.current = setInterval(() => {
      const s = Math.floor((Date.now() - t0) / 1000)
      setElapsed(s)
      // 免费额度下第一张图常见的前 45 秒基本都在排队，把预期说清楚
      setStage(s < 40 ? 'queue' : 'draw')
    }, 500)

    try {
      const res = await api.imageGenerate({
        prompt: prompt.trim(),
        style,
        ratio,
        enhance,
        /* 「换一张」走随机种子重画；缓存 key 含种子，所以必然是真重画 */
        seed: seedOverride || Math.floor(Math.random() * 90000),
      })
      if (!res.ok) {
        toast(res.error || '出图失败', 'error')
        return
      }
      setCurrent({ ...res.data, prompt: prompt.trim(), style, ratio })
      toast(res.data?.enhanced ? '图生成好了（已按分镜增强画质）' : '图生成好了', 'success')
      refresh()
    } catch (err) {
      toast(err?.message || '出图失败', 'error')
    } finally {
      clearInterval(timer.current)
      setBusy(false)
      setStage('')
    }
  }

  const removeOne = async (name) => {
    if (!window.confirm('删除这张图片？删除后不可恢复（同描述再生成一次即可得到新图）。')) return
    try {
      await api.imageDelete(name)
      if (current?.name === name) setCurrent(null)
      toast('已删除', 'success')
      refresh()
    } catch (err) {
      toast(err?.message || '删除失败', 'error')
    }
  }

  const clearAll = async () => {
    if (!window.confirm(`清空全部 ${history.length} 张生成图？只清「AI 绘图」页的历史，PPT 配图不受影响，删除后不可恢复。`)) return
    try {
      const r = await api.imageClear()
      setCurrent(null)
      toast(`已清空 ${r.data?.removed ?? history.length} 张`, 'success')
      refresh()
    } catch (err) {
      toast(err?.message || '清空失败', 'error')
    }
  }

  const url = (name) => `/api/image/file?name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken() || '')}`
  const download = (name) => {
    const a = document.createElement('a')
    a.href = url(name)
    a.download = name || 'image.jpg'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  const styleLabel = (id) => STYLES.find((s) => s.id === id)?.label || id

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <header className="flex shrink-0 items-baseline gap-2 border-b border-ink-600 px-4 py-2.5">
        <h1 className="text-[14px] font-semibold text-slate-100">AI 绘图</h1>
        <span className="text-[11px] text-slate-500">写一段画面描述，生成一张可以直接用的高质量图片</span>
      </header>

      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 xl:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        {/* ---------------- 左：提示词与参数 ---------------- */}
        <section className="min-w-0 space-y-3">
          <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
            <label className="mb-1 block text-[11px] text-slate-400">画面描述</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={5}
              maxLength={600}
              placeholder="例如：黄昏下的江南水乡，白墙黛瓦，河面倒影，薄雾，远处的乌篷船"
              className="field w-full resize-none text-[12px] leading-relaxed"
            />
            <div className="mt-1 flex items-center justify-between text-[10px] text-slate-600">
              <span>越具体越好：主体 + 环境 + 光线 + 氛围</span>
              <span className="font-mono">{prompt.length}/600</span>
            </div>
            <div className="mt-1.5 flex flex-wrap gap-1">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  className="rounded-full border border-ink-600 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-slate-600 hover:text-slate-300"
                  onClick={() => setPrompt(ex)}
                  title={ex}
                >
                  {ex.slice(0, 12)}…
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
            <p className="mb-1 text-[11px] text-slate-400">风格</p>
            <div className="grid grid-cols-3 gap-1.5">
              {STYLES.map((s) => (
                <button
                  key={s.id}
                  title={s.desc}
                  onClick={() => setStyle(s.id)}
                  className={`rounded-md border px-1.5 py-1.5 text-[11px] transition ${
                    style === s.id
                      ? 'border-sky-500/70 bg-sky-500/15 text-sky-200'
                      : 'border-slate-700/70 bg-slate-800/40 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  {s.label}
                </button>
              ))}
            </div>

            <p className="mb-1 mt-3 text-[11px] text-slate-400">画幅</p>
            <div className="grid grid-cols-2 gap-1.5">
              {RATIOS.map((r) => (
                <button
                  key={r.id}
                  title={r.hint}
                  onClick={() => setRatio(r.id)}
                  className={`rounded-md border px-1.5 py-1.5 text-[11px] transition ${
                    ratio === r.id
                      ? 'border-sky-500/70 bg-sky-500/15 text-sky-200'
                      : 'border-slate-700/70 bg-slate-800/40 text-slate-400 hover:border-slate-600'
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {/* 10.0.0：画质增强开关 —— 默认开。短描述会被扩写成完整分镜提示词 */}
            <label className="mt-3 flex cursor-pointer items-start gap-2 rounded-md border border-ink-600 bg-ink-900/60 px-2 py-1.5">
              <input
                type="checkbox"
                checked={enhance}
                onChange={(e) => setEnhance(e.target.checked)}
                className="mt-0.5 accent-sky-500"
              />
              <span className="text-[11px] leading-snug text-slate-300">
                画质增强
                <span className="ml-1 text-[10px] text-slate-500">AI 先把描述扩写成完整分镜（光线 / 镜头 / 氛围），画质明显更好，多花几秒</span>
              </span>
            </label>

            <button className="btn-primary mt-3 w-full" disabled={busy || !prompt.trim()} onClick={() => draw()}>
              {busy ? `生成中… ${elapsed}s` : '🎨 生成图片'}
            </button>
            <p className="mt-1.5 text-[10px] leading-relaxed text-slate-600">
              中文描述会先自动翻成英文提示词（文生图模型对中文长句几乎不认），所以第一张要多等几秒；
              免费额度下每 45 秒能出一张。
            </p>
          </div>
        </section>

        {/* ---------------- 右：大预览 + 历史 ---------------- */}
        <section className="min-w-0 space-y-3">
          <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-[11.5px] font-medium text-slate-300">预览</span>
              {current ? (
                <span className="chip">
                  {styleLabel(current.style)} · {current.width}×{current.height}
                </span>
              ) : null}
              <div className="ml-auto flex items-center gap-1.5">
                {current && !busy ? (
                  <>
                    <button className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => draw()} title="换个种子重画一张">
                      🔄 换一张
                    </button>
                    <button className="btn-ghost px-2 py-0.5 text-[11px]" onClick={() => download(current.name)}>
                      保存
                    </button>
                    <button
                      className="btn-ghost px-2 py-0.5 text-[11px] text-rose-400 hover:text-rose-300"
                      onClick={() => removeOne(current.name)}
                    >
                      删除
                    </button>
                  </>
                ) : null}
                {busy ? (
                  <span className="font-mono text-[10px] text-slate-500">
                    {stage === 'queue' ? '排队中' : '生成中'} · {elapsed}s
                  </span>
                ) : null}
              </div>
            </div>

            {current ? (
              <img
                src={url(current.name)}
                alt={current.prompt}
                className="mx-auto max-h-[60vh] w-auto max-w-full rounded-lg border border-ink-600 object-contain"
              />
            ) : (
              <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-ink-600 bg-ink-900">
                <div className="px-6 text-center">
                  {busy ? (
                    <>
                      <div className="mx-auto mb-2 h-6 w-6 animate-spin rounded-full border-2 border-sky-500/30 border-t-sky-400" />
                      <p className="text-[11.5px] text-slate-400">
                        {stage === 'queue' ? '在队列里等额度，通常 45 秒内开始画' : '正在画，请稍等'}
                      </p>
                      <p className="mt-0.5 font-mono text-[10px] text-slate-600">已等待 {elapsed}s</p>
                    </>
                  ) : (
                    <p className="text-[11.5px] text-slate-500">左边写一句画面描述，这里就会出现成品</p>
                  )}
                </div>
              </div>
            )}

            {current ? (
              <p className="mt-2 break-words text-[10.5px] leading-relaxed text-slate-500">{current.prompt}</p>
            ) : null}
          </div>

          <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
            <div className="mb-2 flex items-center gap-2">
              <p className="text-[11.5px] font-medium text-slate-300">
                最近生成 {history.length ? `· ${history.length} 张` : ''}
              </p>
              {history.length ? (
                <button
                  className="btn-ghost ml-auto px-2 py-0.5 text-[11px] text-rose-400 hover:text-rose-300"
                  onClick={clearAll}
                >
                  清空全部
                </button>
              ) : null}
            </div>
            {history.length ? (
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4">
                {history.map((h) => (
                  <div key={h.name} className="group relative">
                    <button
                      className="block w-full overflow-hidden rounded-md border border-ink-600"
                      onClick={() =>
                        setCurrent({
                          name: h.name,
                          prompt: h.prompt || '（历史记录）',
                          style: h.style || style,
                          ratio: h.ratio || '16:9',
                          width: h.width,
                          height: h.height,
                        })
                      }
                      title={h.prompt ? `${h.prompt}\n${new Date(h.at).toLocaleString()}` : new Date(h.at).toLocaleString()}
                    >
                      <img src={url(h.name)} alt="" className="aspect-video w-full object-cover" />
                    </button>
                    {/* 悬停出现删除角标 —— 生成的照片要能删 */}
                    <button
                      className="absolute right-1 top-1 hidden h-5 w-5 items-center justify-center rounded-full bg-black/70 text-[11px] leading-none text-rose-300 group-hover:flex hover:bg-rose-500/80 hover:text-white"
                      onClick={() => removeOne(h.name)}
                      title="删除这张"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[10.5px] text-slate-600">还没有生成过图片。</p>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
