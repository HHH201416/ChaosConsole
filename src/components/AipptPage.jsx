import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../store'

/**
 * 9.5.4：AIPPT —— 左侧 TAB 页。主题 + 页数 + 语气 → 混沌（本地模型）生成
 * 大纲 → pptxgenjs 本地渲染 .pptx → 点下载直接保存文件。
 * 生成是同步长请求（最长 180s 模型 + 渲染），页面给出阶段提示。
 */

const PAGE_OPTIONS = [4, 6, 8, 10, 12, 16]

const TONE_OPTIONS = [
  { id: 'formal', label: '正式专业', desc: '结构严谨，用词规范' },
  { id: 'casual', label: '轻松口语', desc: '有亲和力，像聊天' },
  { id: 'academic', label: '学术客观', desc: '重数据与逻辑推演' },
  { id: 'marketing', label: '营销感染', desc: '短句有号召力' },
  { id: 'concise', label: '简洁要点', desc: '每句话短而准' },
]

const EXAMPLES = ['新能源汽车行业分析', '鸿蒙应用开发入门', '季度工作总结汇报', 'AI 大模型技术演进']

export default function AipptPage() {
  const toast = useStore((s) => s.toast)
  const system = useStore((s) => s.system)

  const [topic, setTopic] = useState('')
  const [pages, setPages] = useState(6)
  const [tone, setTone] = useState('formal')
  const [model, setModel] = useState('')
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState('')
  const [result, setResult] = useState(null)
  const [files, setFiles] = useState([])

  const chaosModels = system?.executors?.find((e) => e.id === 'chaos')?.models || []

  const refreshFiles = async () => {
    try {
      const res = await api.aipptList()
      setFiles(Array.isArray(res.data) ? res.data : [])
    } catch (_) {
      /* ignore */
    }
  }
  useEffect(() => {
    refreshFiles()
  }, [])

  const generate = async () => {
    if (!topic.trim() || busy) return
    setBusy(true)
    setResult(null)
    setStep('正在让本地模型策划大纲（页数越多越慢，最长约 3 分钟）…')
    try {
      const res = await api.aipptGenerate({ topic: topic.trim(), pages, tone, model: model || undefined })
      if (!res.ok) throw new Error(res.error || '生成失败')
      setResult(res.data)
      setStep('')
      toast(`PPT 已生成：《${res.data.title}》共 ${res.data.pages} 页`, 'success')
      refreshFiles()
    } catch (err) {
      setStep('')
      toast(err.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const download = (id, name) => {
    const a = document.createElement('a')
    a.href = `/api/aippt/file?id=${encodeURIComponent(id)}&token=${encodeURIComponent(localStorage.getItem('chaos.token') || '')}`
    a.download = name || 'AIPPT.pptx'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-5">
        <div className="mb-4 flex items-center gap-2">
          <span className="text-xl">🖼️</span>
          <h2 className="text-[15px] font-semibold text-slate-100">AIPPT · 一句话生成 PPT</h2>
          <span className="chip">完全本地 · 由混沌模型策划内容</span>
        </div>

        {/* 表单 */}
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

          <div className="mt-4 grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1 block text-[11px] text-slate-400">页数</label>
              <select value={pages} onChange={(e) => setPages(Number(e.target.value))} className="field w-full text-[12px]">
                {PAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n} 页
                  </option>
                ))}
              </select>
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
          </div>

          <label className="mb-1 mt-4 block text-[11px] text-slate-400">文字语气</label>
          <div className="grid grid-cols-5 gap-1.5">
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

          <button className="btn-primary mt-4 w-full" disabled={busy || !topic.trim()} onClick={generate}>
            {busy ? '生成中…' : `🖼️ 生成 ${pages} 页 PPT`}
          </button>
          {busy && (
            <div className="mt-2 flex items-center gap-2 text-[11px] text-sky-300">
              <span className="h-1.5 w-1.5 animate-pulseDot rounded-full bg-sky-400" />
              {step}
            </div>
          )}
        </div>

        {/* 结果 */}
        {result && (
          <div className="mt-4 rounded-xl border border-emerald-600/50 bg-emerald-900/20 p-4">
            <p className="text-[13px] font-medium text-emerald-300">✓ 《{result.title}》已生成（{result.pages} 页）</p>
            <p className="mt-1 text-[10.5px] text-slate-400">
              消耗约 {Number(result.tokens || 0).toLocaleString()} token · 文件保存在应用数据目录 aippt/ 下
            </p>
            <button className="btn-success mt-2" onClick={() => download(result.id, `${result.title}.pptx`)}>
              ⬇️ 下载 PPT 文件
            </button>
          </div>
        )}

        {/* 历史产物 */}
        {files.length > 0 && (
          <div className="mt-4">
            <div className="panel-title mb-1.5">最近生成的 PPT</div>
            <div className="space-y-1.5">
              {files.map((f) => (
                <div key={f.id || f.name} className="flex items-center gap-2 rounded-lg border border-ink-500 bg-ink-800 px-3 py-2">
                  <span>🖼️</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] text-slate-200" title={f.name}>
                    {f.name.replace(/_[a-f0-9]{16}\.pptx$/, '')}
                  </span>
                  <span className="shrink-0 font-mono text-[10px] text-slate-500">
                    {(f.size / 1024).toFixed(0)} KB
                  </span>
                  <button
                    className="btn-ghost shrink-0 px-2 py-0.5 text-[11px]"
                    disabled={!f.id}
                    onClick={() => download(f.id, f.name)}
                  >
                    ⬇️ 下载
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
