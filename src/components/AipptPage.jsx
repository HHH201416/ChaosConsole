import { useEffect, useMemo, useRef, useState } from 'react'
import { api, getToken, streamPost } from '../lib/api'
import { useStore } from '../store'
import { asArr } from '../lib/meta'

/**
 * 10.0.1：AIPPT 改成 WPS AI 那样的三步向导。
 *
 * 为什么改流程：旧版是「一句话 → 等两分钟 → 出来一份改不动的成片」，
 * 用户唯一的补救手段是重跑一遍模型。真正决定 PPT 好不好用的其实是大纲那一步 ——
 * 页序、页型、每页写几条要点，全都该在花时间出片之前定下来。
 *
 *   ① 填需求 → 生成大纲（只跑文本模型，约 1 分钟）
 *   ② 逐页编辑大纲（增删页 / 换页型 / 改要点 / 写演讲备注 / 换模板实时看效果）
 *   ③ 生成（配图 + 渲染，秒级到十几秒）→ 下载
 *
 * 第 ② 步是重点：所有改动都只改本地状态，随改随预览，不烧推理时间。
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

/** 页型登记表：代号与服务端 COMPACT_SPEC 对齐，用户看得懂就行 */
const KIND_META = {
  cover: { label: '封面', code: '01', hint: '整份稿子的第一页' },
  section: { label: '章节过渡', code: 'P', hint: '把长稿切段，只写章节名 + 一句导语' },
  bullets: { label: '要点', code: 'B', hint: '最常见：标题 + 3 条要点' },
  stats: { label: '数据卡', code: 'S', hint: '2-3 个大数字并排，突出指标' },
  twocol: { label: '双栏对比', code: 'C', hint: '左右对立两组观点' },
  compare: { label: '表格对比', code: 'TB', hint: '带表头的两列对照表' },
  chart: { label: '图表', code: 'CH', hint: '柱 / 折线 / 饼 / 环形，真图表可编辑' },
  timeline: { label: '时间轴', code: 'TL', hint: '讲过程、阶段、里程碑' },
  process: { label: '流程步骤', code: 'PS', hint: '3-5 步的做法拆解' },
  quote: { label: '金句', code: 'Q', hint: '一页只放一句话' },
  closing: { label: '结尾', code: 'E', hint: '收尾 + 行动号召' },
}

const EDITABLE_KINDS = ['section', 'bullets', 'stats', 'twocol', 'compare', 'chart', 'timeline', 'process', 'quote']

const EXAMPLES = ['新能源汽车行业分析', '鸿蒙应用开发入门', '季度工作总结汇报', 'AI 大模型技术演进']

const MIN_PAGES = 3
const MAX_PAGES = 30

/* ------------------------------------------------------------------ *
 * 小工具
 * ------------------------------------------------------------------ */

/** 从主色推同色系色阶，给饼图分区上色，和 pptx 里的 chartPalette 口径一致 */
function palette(hex, n) {
  const h = String(hex || '#2563EB').replace('#', '').padEnd(6, '0').slice(0, 6)
  const base = [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]
  const out = []
  for (let i = 0; i < Math.max(3, n); i++) {
    const t = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.26
    const mix = (v) => Math.max(0, Math.min(255, Math.round(t >= 0 ? v + (255 - v) * t : v * (1 + t))))
    out.push(`rgb(${mix(base[0])},${mix(base[1])},${mix(base[2])})`)
  }
  return out
}

/** 新建一页（用于「加一页」和类型切换时的字段补齐） */
function blankSlide(kind = 'bullets') {
  return {
    kind,
    title: '',
    kicker: '',
    body: [],
    extra: [],
    stats: [],
    chart: { type: 'bar', labels: [], values: [] },
    timeline: [],
    head: [],
    note: '',
    image: '',
    imageName: '',
  }
}

/* ------------------------------------------------------------------ *
 * 幻灯预览：和 pptx 一一对应的 HTML 版
 * ------------------------------------------------------------------ */

function ChartBox({ T, chart, compact }) {
  const labels = asArr(chart?.labels)
  const values = asArr(chart?.values).map((x) => Number(x) || 0)
  if (values.length < 2) {
    return <p className="text-[9px] text-slate-500">数据不足两个，出片时会自动退回要点页</p>
  }
  const type = chart?.type || 'bar'
  const cols = palette(T.accent, values.length)

  if (type === 'pie' || type === 'doughnut') {
    const total = values.reduce((a, b) => a + Math.abs(b), 0) || 1
    let acc = 0
    const R = 44
    const C = 50
    return (
      <div className="flex h-full items-center gap-2">
        <svg viewBox="0 0 100 100" className={compact ? 'h-full w-[64%]' : 'h-full w-[58%]'}>
          {values.map((v, i) => {
            const frac = Math.abs(v) / total
            const a0 = acc * Math.PI * 2 - Math.PI / 2
            acc += frac
            const a1 = acc * Math.PI * 2 - Math.PI / 2
            const large = frac > 0.5 ? 1 : 0
            const x0 = C + R * Math.cos(a0)
            const y0 = C + R * Math.sin(a0)
            const x1 = C + R * Math.cos(a1)
            const y1 = C + R * Math.sin(a1)
            return <path key={i} d={`M ${C} ${C} L ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} Z`} fill={cols[i]} />
          })}
          {type === 'doughnut' && <circle cx={C} cy={C} r={23} fill={T.pageBg} />}
        </svg>
        <div className="min-w-0 flex-1 space-y-0.5">
          {labels.map((l, i) => (
            <p key={i} className="flex items-center gap-1 truncate text-[8px]" style={{ color: T.text }}>
              <span className="h-1.5 w-1.5 shrink-0 rounded-sm" style={{ background: cols[i] }} />
              <span className="truncate">{l}</span>
              <span className="ml-auto shrink-0 font-mono opacity-70">{values[i]}</span>
            </p>
          ))}
        </div>
      </div>
    )
  }

  const max = Math.max(...values.map(Math.abs), 1)
  if (type === 'line') {
    const n = values.length
    const pts = values.map((v, i) => `${(i / Math.max(n - 1, 1)) * 96 + 2},${58 - (Math.abs(v) / max) * 50}`).join(' ')
    return (
      <div className="flex h-full flex-col">
        <svg viewBox="0 0 100 62" className="min-h-0 w-full flex-1" preserveAspectRatio="none">
          <polyline points={pts} fill="none" stroke={cols[0]} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          {values.map((v, i) => (
            <circle key={i} cx={(i / Math.max(n - 1, 1)) * 96 + 2} cy={58 - (Math.abs(v) / max) * 50} r="1.6" fill={cols[0]} />
          ))}
        </svg>
        <div className="mt-0.5 flex justify-between">
          {labels.map((l, i) => (
            <span key={i} className="truncate text-[7px]" style={{ color: T.text }}>
              {l}
            </span>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1 items-end gap-1.5">
        {values.map((v, i) => (
          <div key={i} className="flex min-w-0 flex-1 flex-col items-center justify-end">
            <span className="mb-0.5 font-mono text-[7px]" style={{ color: T.accent }}>
              {v}
            </span>
            <div
              className="w-full rounded-t-sm"
              style={{ height: `${Math.max(4, (Math.abs(v) / max) * 78)}%`, background: cols[i] }}
            />
          </div>
        ))}
      </div>
      <div className="mt-0.5 flex gap-1.5">
        {labels.map((l, i) => (
          <span key={i} className="min-w-0 flex-1 truncate text-center text-[7px]" style={{ color: T.text }}>
            {l}
          </span>
        ))}
      </div>
    </div>
  )
}

function Frame({ T, f, picUrl, cur, total }) {
  const base = f.kind === 'cover' || f.kind === 'closing' || f.kind === 'section' ? T.coverBg : f.kind === 'toc' ? T.tocBg : T.pageBg
  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-ink-600" style={{ background: base }}>
      {/* 封面 */}
      {f.kind === 'cover' && (
        <>
          {picUrl && T.coverStyle === 'full' && <img src={picUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-70" />}
          {picUrl && T.coverStyle === 'split' && <img src={picUrl} alt="" className="absolute inset-y-0 right-0 h-full w-[45%] object-cover" />}
          <div className="absolute right-3 top-3 h-16 w-16 rounded-full opacity-20" style={{ background: T.accent }} />
          <div className="absolute -bottom-6 right-10 h-24 w-24 rounded-full opacity-10" style={{ background: T.accent }} />
          <div className="relative flex h-full flex-col justify-center px-5">
            <p className="mb-2 font-mono text-[7px] font-bold tracking-[0.28em]" style={{ color: T.accent }}>
              演 示 文 稿
            </p>
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
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 overflow-hidden">
            {f.items.slice(0, 8).map((t, i) => (
              <p key={i} className="truncate text-[9px]" style={{ color: T.text }}>
                <span className="mr-1 font-mono" style={{ color: T.accent }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                {t}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* 章节过渡 */}
      {f.kind === 'section' && (
        <>
          <p className="absolute right-4 top-2 font-bold leading-none opacity-[0.13]" style={{ fontSize: 130, color: T.accent }}>
            {String(f.no).padStart(2, '0')}
          </p>
          {picUrl && <img src={picUrl} alt="" className="absolute inset-0 h-full w-full object-cover opacity-25" />}
          <div className="relative flex h-full flex-col justify-center px-6">
            <p className="font-mono text-[8px] font-bold tracking-[0.24em]" style={{ color: T.accent }}>
              第 {f.no} 章
            </p>
            <div className="my-1.5 h-[2px] w-7" style={{ background: T.accent }} />
            <p className="line-clamp-2 text-[19px] font-bold leading-snug" style={{ color: T.coverTitle }}>
              {f.title}
            </p>
            {f.body[0] && (
              <p className="mt-1.5 line-clamp-2 text-[9.5px]" style={{ color: T.coverSub }}>
                {f.body[0]}
              </p>
            )}
          </div>
        </>
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
      {['bullets', 'twocol', 'stats', 'quote', 'chart', 'timeline', 'process', 'compare'].includes(f.kind) && (
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

          {/* 要点 */}
          {f.kind === 'bullets' && (
            <div className="flex min-h-0 flex-1 gap-2">
              {f.body.length >= 2 && f.body.length <= 4 && !picUrl ? (
                <div className="flex w-full flex-col justify-center gap-1">
                  {f.body.slice(0, 4).map((t, i) => (
                    <div key={i} className="flex items-center gap-1.5 rounded-sm px-2 py-1.5" style={{ background: T.panel }}>
                      <span className="h-4 w-[2px] shrink-0 rounded" style={{ background: T.accent }} />
                      <span className="line-clamp-2 text-[9.5px] leading-snug" style={{ color: T.text }}>
                        {t}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <ul className={`space-y-1 ${picUrl ? 'w-[58%]' : 'w-full'}`}>
                  {f.body.slice(0, 5).map((t, i) => (
                    <li key={i} className="flex gap-1 text-[9.5px] leading-snug" style={{ color: T.text }}>
                      <span style={{ color: T.accent }}>•</span>
                      <span className="line-clamp-2">{t}</span>
                    </li>
                  ))}
                </ul>
              )}
              {picUrl && (
                <div className="min-w-0 flex-1">
                  <img src={picUrl} alt="" className="h-[62%] w-full rounded-sm object-cover" />
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

          {/* 表格 */}
          {f.kind === 'compare' && (
            <div className="min-h-0 flex-1 overflow-hidden rounded-sm border" style={{ borderColor: '#E2E8F0' }}>
              <div className="flex" style={{ background: T.accent }}>
                {(f.head?.length === 2 ? f.head : ['现在', '之后']).map((h, k) => (
                  <span key={k} className="flex-1 px-1.5 py-1 text-[8.5px] font-bold text-white">
                    {h}
                  </span>
                ))}
              </div>
              {f.body.slice(0, 4).map((t, i) => (
                <div key={i} className="flex" style={{ background: i % 2 ? T.panel : '#FFFFFF' }}>
                  <span className="flex-1 px-1.5 py-1 text-[8.5px]" style={{ color: T.text }}>
                    {t}
                  </span>
                  <span className="flex-1 px-1.5 py-1 text-[8.5px]" style={{ color: T.title }}>
                    {f.extra[i] || ''}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* 图表 */}
          {f.kind === 'chart' && (
            <div className="flex min-h-0 flex-1 gap-2">
              <div className={f.body.length ? 'w-[62%]' : 'w-full'}>
                <ChartBox T={T} chart={f.chart} compact={!f.body.length} />
              </div>
              {f.body.length > 0 && (
                <div className="min-w-0 flex-1">
                  <p className="mb-0.5 text-[7.5px] font-bold" style={{ color: T.accent }}>
                    看懂这张图
                  </p>
                  <ul className="space-y-0.5">
                    {f.body.slice(0, 3).map((t, i) => (
                      <li key={i} className="line-clamp-2 text-[8.5px] leading-snug" style={{ color: T.text }}>
                        ▪ {t}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          {/* 时间轴 */}
          {f.kind === 'timeline' && (
            <div className="relative flex min-h-0 flex-1 items-center">
              <div className="absolute left-0 right-0 top-1/2 h-[1px]" style={{ background: '#CBD5E1' }} />
              <div className="relative flex w-full items-start justify-between">
                {asArr(f.timeline).slice(0, 6).map((nd, i) => (
                  <div key={i} className="flex min-w-0 flex-1 flex-col items-center" style={{ marginTop: i % 2 ? 12 : -30 }}>
                    {i % 2 === 0 && (
                      <>
                        <p className="mb-0.5 text-[8px] font-bold" style={{ color: T.accent }}>
                          {nd.t}
                        </p>
                        <p className="mb-1 line-clamp-2 text-center text-[7.5px] leading-tight" style={{ color: T.text }}>
                          {nd.d}
                        </p>
                      </>
                    )}
                    <span className="h-2 w-2 shrink-0 rounded-full ring-2 ring-white" style={{ background: T.accent }} />
                    {i % 2 === 1 && (
                      <>
                        <p className="mt-0.5 text-[8px] font-bold" style={{ color: T.accent }}>
                          {nd.t}
                        </p>
                        <p className="mt-0.5 line-clamp-2 text-center text-[7.5px] leading-tight" style={{ color: T.text }}>
                          {nd.d}
                        </p>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 流程步骤 */}
          {f.kind === 'process' && (
            <div className="flex min-h-0 flex-1 items-start gap-1 pt-1">
              {f.body.slice(0, 5).map((t, i) => (
                <div key={i} className="min-w-0 flex-1 rounded-sm p-1.5" style={{ background: T.panel }}>
                  <span
                    className="mb-1 flex h-3.5 w-3.5 items-center justify-center rounded-full text-[7px] font-bold text-white"
                    style={{ background: T.accent, opacity: i === f.body.length - 1 ? 1 : 0.75 }}
                  >
                    {i + 1}
                  </span>
                  <p className="line-clamp-3 text-[8px] leading-tight" style={{ color: T.text }}>
                    {t}
                  </p>
                </div>
              ))}
            </div>
          )}

          {/* 数据卡 */}
          {f.kind === 'stats' && (
            <div className="flex min-h-0 flex-1 flex-col justify-center">
              <div className="flex gap-2">
                {f.stats.slice(0, 3).map((st, i) => (
                  <div key={i} className="flex-1 rounded-sm pb-1.5 text-center" style={{ background: T.panel }}>
                    <div className="mx-auto mb-1 h-[2px] w-[70%]" style={{ background: T.accent }} />
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
        style={{ color: ['cover', 'closing', 'section'].includes(f.kind) ? T.coverSub : '#94A3B8' }}
      >
        {cur + 1} / {total}
      </span>
    </div>
  )
}

/** 把大纲摊平成「成片页序」（含自动目录页、章节序号） */
function buildFrames(outline, withToc) {
  const slides = asArr(outline?.slides)
  if (!slides.length) return []
  const toc = withToc && slides.length >= 5
  const out = [
    {
      kind: 'cover',
      title: outline?.title || '（未填标题）',
      sub: outline?.subtitle || slides[0]?.body?.[0] || '',
      pic: slides[0]?.imageName,
    },
  ]
  if (toc) out.push({ kind: 'toc', items: slides.slice(1, -1).map((s) => s.title) })
  let no = 0
  for (let i = 1; i < slides.length; i++) {
    const s = slides[i]
    if (s.kind === 'section') no += 1
    out.push({
      kind: s.kind || 'bullets',
      no,
      title: s.title,
      kicker: s.kicker,
      body: asArr(s.body),
      extra: asArr(s.extra),
      stats: asArr(s.stats),
      chart: s.chart,
      timeline: asArr(s.timeline),
      head: asArr(s.head),
      pic: s.imageName,
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 进度条
 * ------------------------------------------------------------------ */

const PHASES = [
  { id: 'plan', label: '联网搜集资料' },
  { id: 'outline', label: '逐页写内容' },
  { id: 'refine', label: '质量修订' },
  { id: 'image', label: '生成配图' },
  { id: 'render', label: '排版渲染' },
]

function ProgressSteps({ phase, labels }) {
  const activeIdx = PHASES.findIndex((p) => p.id === phase)
  return (
    <div className="space-y-1">
      {PHASES.map((p, i) => {
        const done = activeIdx > i || phase === 'done'
        const active = p.id === phase
        if (p.id === 'refine' && !labels?.[p.id] && !active && !done) return null
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
 * 大纲编辑：单页卡片
 * ------------------------------------------------------------------ */

function SlideCard({ T, slide, index, total, onChange, onMove, onRemove, onInsertAfter, active, onFocus }) {
  const kind = slide.kind || 'bullets'
  const meta = KIND_META[kind] || KIND_META.bullets
  const multi = ['bullets', 'process'].includes(kind)
  const lines = (arr) => asArr(arr).join('\n')
  const toLines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean)

  const statsText = asArr(slide.stats).map((s) => `${s.v}|${s.l}`).join('\n')
  const chartText = asArr(slide.chart?.labels).map((l, i) => `${l}|${asArr(slide.chart?.values)[i] ?? 0}`).join('\n')
  const tlText = asArr(slide.timeline).map((x) => `${x.t}|${x.d}`).join('\n')
  const cmpText = asArr(slide.body).map((l, i) => `${l}|${asArr(slide.extra)[i] || ''}`).join('\n')

  return (
    <div
      onFocus={onFocus}
      className={`rounded-lg border p-2.5 transition-colors ${
        active ? 'border-boss/60 bg-boss/[0.06]' : 'border-ink-600 bg-ink-900'
      }`}
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="shrink-0 rounded bg-ink-700 px-1.5 py-0.5 font-mono text-[9.5px] text-slate-400">{index + 1}</span>
        <select
          value={kind}
          onChange={(e) => onChange({ ...blankSlide(e.target.value), title: slide.title, note: slide.note, body: slide.body, extra: slide.extra, stats: slide.stats, chart: slide.chart, timeline: slide.timeline, head: slide.head })}
          title={meta.hint}
          className="shrink-0 rounded border border-ink-600 bg-ink-800 px-1 py-0.5 text-[10px] text-slate-300"
        >
          {EDITABLE_KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_META[k].label}
            </option>
          ))}
        </select>
        <input
          value={slide.title || ''}
          onChange={(e) => onChange({ ...slide, title: e.target.value })}
          placeholder={kind === 'quote' ? '（金句页可留空，内容写在下面）' : '这一页的标题'}
          className="field min-w-0 flex-1 py-0.5 text-[11.5px]"
        />
        <div className="flex shrink-0 items-center gap-0.5 text-[11px] text-slate-500">
          <button className="rounded px-1 hover:bg-ink-700 hover:text-slate-200" disabled={index <= 1} title="上移" onClick={() => onMove(-1)}>
            ↑
          </button>
          <button
            className="rounded px-1 hover:bg-ink-700 hover:text-slate-200"
            disabled={index >= total - 1}
            title="下移"
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button className="rounded px-1 hover:bg-boss/15 hover:text-boss-strong" title="删除这一页" onClick={onRemove}>
            ✕
          </button>
        </div>
      </div>

      {/* 按页型给不同的编辑控件 */}
      {multi && (
        <textarea
          value={lines(slide.body)}
          onChange={(e) => onChange({ ...slide, body: toLines(e.target.value) })}
          rows={Math.max(3, Math.min(6, asArr(slide.body).length + 1))}
          placeholder={kind === 'process' ? '每行一个步骤（3-5 行）' : '每行一条要点（建议 3 条，每条 16-24 字）'}
          className="field w-full resize-y text-[11px] leading-relaxed"
        />
      )}

      {kind === 'twocol' && (
        <div className="grid grid-cols-2 gap-1.5">
          <textarea
            value={lines(slide.body)}
            onChange={(e) => onChange({ ...slide, body: toLines(e.target.value) })}
            rows={3}
            placeholder="左栏（每行一条）"
            className="field w-full resize-y text-[11px] leading-relaxed"
          />
          <textarea
            value={lines(slide.extra)}
            onChange={(e) => onChange({ ...slide, extra: toLines(e.target.value) })}
            rows={3}
            placeholder="右栏（每行一条）"
            className="field w-full resize-y text-[11px] leading-relaxed"
          />
        </div>
      )}

      {kind === 'compare' && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-2 gap-1.5">
            <input
              value={asArr(slide.head)[0] || ''}
              onChange={(e) => onChange({ ...slide, head: [e.target.value, asArr(slide.head)[1] || ''] })}
              placeholder="左列名（表头）"
              className="field w-full py-0.5 text-[11px]"
            />
            <input
              value={asArr(slide.head)[1] || ''}
              onChange={(e) => onChange({ ...slide, head: [asArr(slide.head)[0] || '', e.target.value] })}
              placeholder="右列名（表头）"
              className="field w-full py-0.5 text-[11px]"
            />
          </div>
          <textarea
            value={cmpText}
            onChange={(e) => {
              const rows = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)
              onChange({
                ...slide,
                body: rows.map((r) => r.split('|')[0].trim()),
                extra: rows.map((r) => (r.split('|')[1] || '').trim()),
              })
            }}
            rows={Math.max(3, Math.min(6, asArr(slide.body).length + 1))}
            placeholder={'每行一组「左值|右值」\n等待 4 分 12 秒|等待 1 分 52 秒'}
            className="field w-full resize-y font-mono text-[10.5px] leading-relaxed"
          />
        </div>
      )}

      {kind === 'stats' && (
        <textarea
          value={statsText}
          onChange={(e) => {
            const rows = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)
            onChange({
              ...slide,
              stats: rows.slice(0, 3).map((r) => ({ v: (r.split('|')[0] || '').trim(), l: (r.split('|')[1] || '').trim() })),
            })
          }}
          rows={3}
          placeholder={'每行「数值|指标名」，2-3 行\n-55%|高峰期等待时长'}
          className="field w-full resize-y font-mono text-[10.5px] leading-relaxed"
        />
      )}

      {kind === 'chart' && (
        <div className="space-y-1.5">
          <div className="flex gap-1">
            {['bar', 'line', 'pie', 'doughnut'].map((ty) => (
              <button
                key={ty}
                type="button"
                onClick={() => onChange({ ...slide, chart: { ...blankSlide('chart').chart, ...(slide.chart || {}), type: ty } })}
                className={`flex-1 rounded border px-1 py-1 text-[10.5px] transition ${
                  (slide.chart?.type || 'bar') === ty
                    ? 'border-sky-500/70 bg-sky-500/15 text-sky-200'
                    : 'border-ink-600 bg-ink-800 text-slate-400 hover:border-slate-500'
                }`}
              >
                {{ bar: '柱状', line: '折线', pie: '饼图', doughnut: '环形' }[ty]}
              </button>
            ))}
          </div>
          <textarea
            value={chartText}
            onChange={(e) => {
              const rows = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)
              onChange({
                ...slide,
                chart: {
                  type: slide.chart?.type || 'bar',
                  labels: rows.map((r) => (r.split('|')[0] || '').trim()),
                  values: rows.map((r) => Number((r.split('|')[1] || '0').replace(/[^0-9.\-]/g, '')) || 0),
                },
              })
            }}
            rows={Math.max(4, Math.min(8, asArr(slide.chart?.labels).length + 1))}
            placeholder={'每行「类目|数值」，只写纯数字，至少 3 行\n排队等待|168\n制作出杯|38'}
            className="field w-full resize-y font-mono text-[10.5px] leading-relaxed"
          />
          <textarea
            value={lines(slide.body)}
            onChange={(e) => onChange({ ...slide, body: toLines(e.target.value) })}
            rows={2}
            placeholder="右侧结论（可选，每行一条）"
            className="field w-full resize-y text-[11px] leading-relaxed"
          />
        </div>
      )}

      {kind === 'timeline' && (
        <textarea
          value={tlText}
          onChange={(e) => {
            const rows = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean)
            onChange({
              ...slide,
              timeline: rows.slice(0, 6).map((r) => ({
                t: (r.split('|')[0] || '').trim(),
                d: (r.split('|')[1] || '').trim(),
              })),
            })
          }}
          rows={Math.max(3, Math.min(7, asArr(slide.timeline).length + 1))}
          placeholder={'每行「时点|发生了什么」，2-6 行\n第 1 周|画出 32 家店的走动图'}
          className="field w-full resize-y font-mono text-[10.5px] leading-relaxed"
        />
      )}

      {(kind === 'quote' || kind === 'section' || kind === 'closing') && (
        <textarea
          value={lines(slide.body)}
          onChange={(e) => onChange({ ...slide, body: toLines(e.target.value) })}
          rows={2}
          placeholder={kind === 'section' ? '章节导语（一句，可留空）' : kind === 'quote' ? '金句内容' : '行动号召（一句）'}
          className="field w-full resize-y text-[11px] leading-relaxed"
        />
      )}

      <div className="mt-1.5 flex items-center gap-1.5">
        <input
          value={slide.note || ''}
          onChange={(e) => onChange({ ...slide, note: e.target.value })}
          placeholder="演讲备注（放映时不显示，写给自己听）"
          className="field min-w-0 flex-1 py-0.5 text-[10.5px] text-slate-400"
        />
        <button
          type="button"
          className="shrink-0 rounded border border-ink-600 px-1.5 py-0.5 text-[10px] text-slate-500 hover:border-slate-500 hover:text-slate-300"
          title="在这一页后面插入一页"
          onClick={onInsertAfter}
        >
          + 插页
        </button>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 主页面
 * ------------------------------------------------------------------ */

export default function AipptPage() {
  const toast = useStore((s) => s.toast)

  /* 需求设置 */
  const [topic, setTopic] = useState('')
  const [pages, setPages] = useState(6)
  const [tone, setTone] = useState('formal')
  const [theme, setTheme] = useState('emerald')
  const [language, setLanguage] = useState('zh')
  const [audience, setAudience] = useState('')
  const [withToc, setWithToc] = useState(true)
  const [withImages, setWithImages] = useState(true)
  const [speed, setSpeed] = useState('auto')
  const [imageSource, setImageSource] = useState('auto')
  const [webReady, setWebReady] = useState(false)
  const [keyOpen, setKeyOpen] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keySaving, setKeySaving] = useState(false)

  /* 流程状态：setup → outline → build */
  const [step, setStep] = useState('setup')
  const [phase, setPhase] = useState('') // ''|plan|outline|refine|image|render|done
  const [phaseLabels, setPhaseLabels] = useState({})
  const [elapsed, setElapsed] = useState(0)
  const [planText, setPlanText] = useState('')
  const [partial, setPartial] = useState([])
  const [liveOutline, setLiveOutline] = useState(null)
  const [usedModel, setUsedModel] = useState('')
  const [imgProgress, setImgProgress] = useState({ done: 0, total: 0 })
  const [thumbs, setThumbs] = useState([])

  /* 内容状态 */
  const [outline, setOutline] = useState(null)
  const [result, setResult] = useState(null)
  const [files, setFiles] = useState([])
  const [slideIndex, setSlideIndex] = useState(0)

  const timer = useRef(null)
  const abortRef = useRef(null)
  const planBuf = useRef('')

  const busy = ['plan', 'outline', 'refine', 'image', 'render'].includes(phase)
  const generatingOutline = busy && step === 'setup'
  const building = busy && step === 'build'

  const frames = useMemo(() => buildFrames(outline || liveOutline, withToc), [outline, liveOutline, withToc])
  const cur = Math.min(Math.max(slideIndex, 0), Math.max(0, frames.length - 1))
  const themeMeta = THEMES.find((t) => t.id === theme) || THEMES[0]

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
    api
      .aipptImageSource()
      .then((res) => setWebReady(Boolean(res?.data?.webReady)))
      .catch(() => setWebReady(false))
  }, [])

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

  const stop = () => {
    try {
      abortRef.current?.abort()
    } catch (_) {
      /* ignore */
    }
    setPhase('')
    toast('已停止', 'info')
  }

  /* ---------------- 第一步：生成大纲 ---------------- */

  /** 跑一次大纲流式请求。抽出来是为了失败重试时能清干净缓冲再重来。 */
  const runOutlineOnce = async () => {
    planBuf.current = ''
    setPlanText('')
    setPartial([])
    setLiveOutline(null)
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
        withImages: false,
        speed,
        outlineOnly: true,
      },
      (ev) => {
        if (ev.type === 'model') {
          setUsedModel(ev.outlineModel || '')
          return
        }
        if (ev.type === 'notice') return
        if (ev.type === 'phase') {
          setPhase(ev.phase)
          if (ev.label) setPhaseLabels((prev) => ({ ...prev, [ev.phase]: ev.label }))
        } else if (ev.type === 'delta' && ev.phase === 'plan') {
          planBuf.current += ev.text
          setPlanText(planBuf.current)
        } else if (ev.type === 'preview' && ev.outline) {
          setLiveOutline(ev.outline)
          setPartial(asArr(ev.outline.slides).map((s) => s.title))
        } else if (ev.type === 'outline' && ev.outline) {
          setLiveOutline(ev.outline)
          setPartial(asArr(ev.outline.slides).map((s) => s.title))
        }
      },
      ctrl.signal,
    )

    abortRef.current = null
    return res
  }

  /**
   * 没拿到大纲就不收工 —— 断流、服务端报错、模型吐垃圾一律自动重来，最多 3 轮。
   * 只有用户点「停止」才算真的结束。
   */
  const genOutline = async () => {
    if (!topic.trim() || busy) return
    setStep('setup')
    setOutline(null)
    setLiveOutline(null)
    setResult(null)
    setThumbs([])
    setSlideIndex(0)

    let lastErr = ''
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await runOutlineOnce()
      if (res.aborted) {
        setPhase('')
        return
      }
      if (res.ok) {
        const o = res.result?.outline
        if (!o || !asArr(o.slides).length) {
          lastErr = '模型没写出有效大纲'
        } else {
          setOutline(o)
          setLiveOutline(null)
          setPhase('done')
          setStep('outline')
          setSlideIndex(0)
          /* 页数没写满时如实说一句 —— 别让用户以为大纲就这么长，
           * 缺的页可以在编辑器里插（这是他自己的稿子，不是模型说了算）。 */
          const short = Number(res.result?.pagesShort) || 0
          toast(
            short > 0
              ? `大纲已生成：${asArr(o.slides).length} 页，还差 ${short} 页没写满，可以自己插页补上`
              : `大纲已生成：${asArr(o.slides).length} 页，可以逐页改了`,
            short > 0 ? 'info' : 'success',
          )
          return
        }
      } else {
        lastErr = res.error || '大纲生成失败'
      }
      if (attempt < 3) {
        toast(`大纲没写成功（${lastErr}），第 ${attempt} 次自动重试…`, 'info')
        await new Promise((r) => setTimeout(r, 900 * attempt))
      }
    }
    setPhase('')
    toast(lastErr, 'error')
  }

  /* ---------------- 第三步：按大纲出片 ---------------- */

  const build = async () => {
    if (!outline || busy) return
    setStep('build')
    setPhase('image')
    setPhaseLabels({})
    setThumbs([])
    setImgProgress({ done: 0, total: 0 })

    const ctrl = new AbortController()
    abortRef.current = ctrl

    const res = await streamPost(
      '/api/aippt/assemble',
      { outline, theme, withToc, withImages, imageSource },
      (ev) => {
        if (ev.type === 'phase') {
          setPhase(ev.phase)
          if (ev.label) setPhaseLabels((prev) => ({ ...prev, [ev.phase]: ev.label }))
          if (ev.phase === 'image' && typeof ev.total === 'number') setImgProgress({ done: 0, total: ev.total })
        } else if (ev.type === 'progress') {
          if (!ev.pending) setImgProgress({ done: ev.done || 0, total: ev.total || 0 })
          if (ev.name) {
            setThumbs((prev) => [...prev, ev.name])
            setOutline((prev) =>
              prev
                ? { ...prev, slides: asArr(prev.slides).map((s, i) => (i === ev.index ? { ...s, imageName: ev.name } : s)) }
                : prev,
            )
          }
        } else if (ev.type === 'notice') {
          if (ev.field === 'image') toast('配图通道不可用，已自动降级', 'info')
        }
      },
      ctrl.signal,
    )

    abortRef.current = null

    if (res.aborted) {
      setPhase('')
      setStep('outline')
      return
    }
    if (!res.ok) {
      setPhase('')
      setStep('outline')
      toast(res.error || '出片失败', 'error')
      return
    }
    const data = res.result
    setPhase('done')
    setResult(data)
    if (data?.outline) setOutline(data.outline)
    setSlideIndex(0)
    toast(`PPT 已生成：《${data.title}》${data.pages} 页${data.images ? ` · ${data.images} 张配图` : ''}`, 'success')
    useStore.getState().loadChaosStatus?.()
    refreshFiles()
  }

  /* ---------------- 大纲编辑操作 ---------------- */

  const patchSlide = (index, patch) => {
    setOutline((prev) => {
      if (!prev) return prev
      return { ...prev, slides: asArr(prev.slides).map((s, i) => (i === index ? patch : s)) }
    })
  }

  const moveSlide = (index, dir) => {
    setOutline((prev) => {
      if (!prev) return prev
      const list = [...asArr(prev.slides)]
      const to = index + dir
      // 首页（封面）和末页（结尾）不参与移动，避免把封面挪到中间
      if (to < 1 || to > list.length - 1) return prev
      ;[list[index], list[to]] = [list[to], list[index]]
      return { ...prev, slides: list }
    })
    setSlideIndex((i) => (i === index ? index + dir : i))
  }

  const removeSlide = (index) => {
    setOutline((prev) => {
      if (!prev) return prev
      const list = asArr(prev.slides)
      if (list.length <= 3) return prev
      return { ...prev, slides: list.filter((_, i) => i !== index) }
    })
    setSlideIndex((i) => Math.max(0, i - 1))
  }

  const insertAfter = (index) => {
    setOutline((prev) => {
      if (!prev) return prev
      const list = [...asArr(prev.slides)]
      list.splice(index + 1, 0, blankSlide(index + 1 === list.length ? 'bullets' : 'bullets'))
      return { ...prev, slides: list }
    })
    setSlideIndex(index + 1)
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

  const loadOutline = async (id) => {
    try {
      const res = await api.aipptOutline(id)
      if (!res.ok) throw new Error(res.error || '这份 PPT 没有保存大纲')
      const o = res.data?.outline || res.data
      setOutline({ title: o.title || '', subtitle: o.subtitle || '', slides: asArr(o.slides) })
      setResult({ id, title: o.title || '（已载入大纲）', pages: asArr(o.slides).length })
      setSlideIndex(0)
      setPhase('done')
      setStep('outline')
      toast('已载入大纲，改完直接点「生成 PPT」', 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const removeFile = async (id) => {
    if (!id) return
    try {
      const res = await api.aipptDelete(id)
      if (!res.ok) throw new Error(res.error || '删除失败')
      if (result?.id === id) {
        setResult(null)
        setOutline(null)
        setPhase('')
        setStep('setup')
      }
      toast('已删除', 'success')
      refreshFiles()
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  const clampPageInput = (v) => {
    const n = Math.round(Number(v))
    if (!Number.isFinite(n) || n <= 0) return pages || 6
    return Math.min(MAX_PAGES, Math.max(MIN_PAGES, n))
  }

  const slideCount = asArr(outline?.slides).length

  /* ---------------- 渲染 ---------------- */

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-5">
        {/* 顶部：标题 + 步骤指示 */}
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <span className="text-xl">🖼️</span>
          <h2 className="text-[15px] font-semibold text-slate-100">AIPPT</h2>
          <span className="chip">11 种版式 · 真图表 · 大纲可编辑</span>
          <div className="ml-auto flex items-center gap-1">
            {[
              { id: 'setup', label: '① 定需求' },
              { id: 'outline', label: '② 改大纲' },
              { id: 'build', label: '③ 出片' },
            ].map((s, i) => {
              const idx = ['setup', 'outline', 'build'].indexOf(step)
              const done = idx > i
              const active = step === s.id
              return (
                <button
                  key={s.id}
                  disabled={i > idx || busy || (s.id !== 'setup' && !outline)}
                  onClick={() => setStep(s.id)}
                  className={`rounded-full border px-2.5 py-0.5 text-[10.5px] transition ${
                    active
                      ? 'border-boss/70 bg-boss/15 text-boss-strong'
                      : done
                        ? 'border-emerald-600/40 bg-emerald-900/20 text-emerald-300'
                        : 'border-ink-600 text-slate-500'
                  } disabled:cursor-not-allowed`}
                >
                  {done ? '✓ ' : ''}
                  {s.label}
                </button>
              )
            })}
          </div>
        </div>

        {/* ================= 第一步：定需求 ================= */}
        {step === 'setup' && (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(26rem,38rem)]">
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

                <div className="mt-4">
                  <div className="mb-1 flex items-center gap-2">
                    <label className="text-[11px] text-slate-400">页数</label>
                    <span className="text-[10px] text-slate-600">
                      {MIN_PAGES}-{MAX_PAGES} 页，成品就是这么多页
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
                    />
                    <span className="text-[10.5px] text-slate-500">页</span>
                  </div>
                </div>

                <div className="mb-1 mt-4 flex items-center gap-2">
                  <label className="text-[11px] text-slate-400">模板</label>
                  <span className="text-[10px] text-slate-600">{themeMeta.desc}</span>
                </div>
                <div className="grid grid-cols-5 gap-1.5">
                  {THEMES.map((th) => (
                    <button
                      key={th.id}
                      onClick={() => setTheme(th.id)}
                      title={th.desc}
                      className={`rounded-lg border p-1.5 text-left transition-colors ${
                        theme === th.id ? 'border-boss bg-boss/15' : 'border-ink-500 hover:border-ink-400 hover:bg-ink-700/40'
                      }`}
                    >
                      <span className="mb-1 flex h-6 w-full items-end justify-end gap-[2px] overflow-hidden rounded" style={{ background: th.coverBg }}>
                        <span className="h-3 w-1.5 rounded-t-sm" style={{ background: th.accent }} />
                        <span className="h-4 w-1.5 rounded-t-sm opacity-70" style={{ background: th.coverSub }} />
                        <span className="h-2 w-1.5 rounded-t-sm opacity-40" style={{ background: th.coverTitle }} />
                      </span>
                      <span className={`block truncate text-[10px] ${theme === th.id ? 'text-boss-strong' : 'text-slate-300'}`}>
                        {th.label}
                      </span>
                    </button>
                  ))}
                </div>

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
                        ['auto', '自动'],
                        ['fast', '极速'],
                        ['balanced', '标准'],
                        ['quality', '精品'],
                      ].map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
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
                      <input type="checkbox" checked={withToc} onChange={(e) => setWithToc(e.target.checked)} />
                      生成目录页（5 页以上）
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 text-[11.5px] text-slate-300">
                      <input type="checkbox" checked={withImages} onChange={(e) => setWithImages(e.target.checked)} />
                      自动配图（第 ③ 步才出图）
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
                    {keyOpen ? (
                      <div className="mt-2 rounded-md border border-slate-700/70 bg-slate-800/40 p-2">
                        <p className="mb-1.5 text-[10.5px] leading-relaxed text-slate-400">
                          填 Pexels 免费 Key（pexels.com 注册即可获取，免费）。留空表示清除。
                        </p>
                        <div className="flex gap-1.5">
                          <input
                            value={keyInput}
                            onChange={(e) => setKeyInput(e.target.value)}
                            placeholder="粘贴 Pexels API Key"
                            className="field flex-1 text-[11px]"
                            type="password"
                          />
                          <button type="button" className="btn-ghost px-2.5 text-[11px]" disabled={keySaving} onClick={saveImageKey}>
                            {keySaving ? '保存中…' : '保存'}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                <div className="mt-4 flex gap-2">
                  <button className="btn-primary flex-1" disabled={busy || !topic.trim()} onClick={genOutline}>
                    {generatingOutline ? '正在写大纲…' : '📝 生成大纲'}
                  </button>
                  {busy ? (
                    <button className="btn-ghost shrink-0 px-3" onClick={stop} title="停下当前生成">
                      ⏹ 停止
                    </button>
                  ) : null}
                </div>
                <p className="mt-1.5 text-[10px] leading-relaxed text-slate-500">
                  先只跑文本模型出大纲（不配图、不排版），改满意了再出片 —— 改大纲不烧额外时间。
                </p>
              </div>

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
                          <button className="btn-ghost shrink-0 px-2 py-0.5 text-[11px]" onClick={() => loadOutline(f.id)}>
                            ✏️ 改
                          </button>
                        )}
                        <button className="btn-ghost shrink-0 px-2 py-0.5 text-[11px]" disabled={!f.id} onClick={() => download(f.id, f.name)}>
                          ⬇️ 下载
                        </button>
                        <button
                          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-boss/15 hover:text-boss-strong"
                          onClick={() => removeFile(f.id)}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 右侧：生成过程 */}
            <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
              <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11.5px] font-medium text-slate-300">大纲生成中</span>
                  {busy ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[9.5px] text-sky-300">
                      <span className="h-1 w-1 animate-pulseDot rounded-full bg-sky-400" />
                      {elapsed}s
                    </span>
                  ) : null}
                  <span className="chip ml-auto">{partial.length ? `${partial.length} 页` : '待生成'}</span>
                </div>
                <ProgressSteps phase={phase} labels={phaseLabels} />
                <div className="mt-2.5 rounded-lg border border-ink-600 bg-ink-900 p-2.5">
                  <p className="mb-1 text-[10px] font-medium text-slate-500">已写出的页</p>
                  <ol className="max-h-52 space-y-0.5 overflow-y-auto pr-1">
                    {partial.length ? (
                      partial.map((t, i) => (
                        <li key={i} className="flex gap-1.5 text-[10.5px] text-slate-400">
                          <span className="shrink-0 font-mono text-slate-600">{String(i + 1).padStart(2, '0')}</span>
                          <span className="min-w-0 truncate">{t || '（正在写）'}</span>
                        </li>
                      ))
                    ) : (
                      <li className="text-[10px] text-slate-600">
                        {busy ? '等待模型开始…' : '填好主题点「生成大纲」，这里会一页页长出来'}
                      </li>
                    )}
                  </ol>
                </div>
                <details className="mt-2 rounded-lg border border-ink-600 bg-ink-900 p-2.5">
                  <summary className="cursor-pointer text-[10.5px] font-medium text-slate-400">
                    素材与论据 {planText ? `· ${planText.length} 字` : ''}
                  </summary>
                  <pre className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap break-words font-sans text-[10px] leading-relaxed text-slate-500">
                    {planText || '联网搜到的真实资料会显示在这里'}
                  </pre>
                </details>
              </div>
            </aside>
          </div>
        )}

        {/* ================= 第二步：改大纲 ================= */}
        {step === 'outline' && outline && (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(26rem,38rem)]">
            <div className="min-w-0 space-y-3">
              <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="panel-title !mb-0">大纲</span>
                  <span className="chip">{slideCount} 页</span>
                  {withToc && slideCount >= 5 ? <span className="chip">含目录</span> : null}
                  <button className="ml-auto text-[10.5px] text-slate-500 hover:text-slate-300" onClick={() => setStep('setup')}>
                    改需求重新生成
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-1.5">
                  <input
                    value={outline.title || ''}
                    onChange={(e) => setOutline({ ...outline, title: e.target.value })}
                    placeholder="整份稿子的标题"
                    className="field w-full text-[12.5px] font-semibold"
                  />
                  <input
                    value={outline.subtitle || ''}
                    onChange={(e) => setOutline({ ...outline, subtitle: e.target.value })}
                    placeholder="副标题（封面用）"
                    className="field w-full text-[11.5px]"
                  />
                </div>
              </div>

              <div className="max-h-[38rem] space-y-2 overflow-y-auto pr-1">
                {asArr(outline.slides).map((s, i) => (
                  <SlideCard
                    key={i}
                    T={(THEMES.find((t) => t.id === theme) || THEMES[0])}
                    slide={s}
                    index={i}
                    total={slideCount}
                    active={false}
                    onFocus={() => {
                      const toc = withToc && slideCount >= 5
                      setSlideIndex(toc && i > 0 ? i + 1 : i)
                    }}
                    onChange={(next) => patchSlide(i, next)}
                    onMove={(dir) => moveSlide(i, dir)}
                    onRemove={() => removeSlide(i)}
                    onInsertAfter={() => insertAfter(i)}
                  />
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  className="btn-primary flex-1"
                  disabled={busy || slideCount < 2}
                  onClick={() => build()}
                  title="按当前大纲配图并排版"
                >
                  {building ? '出片中…' : `🎬 生成 PPT（${slideCount + (withToc && slideCount >= 5 ? 1 : 0)} 页）`}
                </button>
                <button className="btn-ghost shrink-0 px-3" disabled={busy} onClick={genOutline}>
                  ♻️ 重新生成大纲
                </button>
                {busy ? (
                  <button className="btn-ghost shrink-0 px-3" onClick={stop}>
                    ⏹ 停止
                  </button>
                ) : null}
              </div>
            </div>

            {/* 右侧：实时预览 + 模板切换 */}
            <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
              <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11.5px] font-medium text-slate-300">实时预览</span>
                  <span className="chip">{frames.length} 页</span>
                  {building ? (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9.5px] text-amber-300">
                      <span className="h-1 w-1 animate-pulseDot rounded-full bg-amber-400" />
                      出片中 {elapsed}s
                    </span>
                  ) : null}
                </div>

                {frames.length ? (
                  <Frame T={themeMeta} f={frames[cur]} picUrl={frames[cur]?.pic ? api.aipptImageUrl(frames[cur].pic) : ''} cur={cur} total={frames.length} />
                ) : (
                  <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-dashed border-ink-600 bg-ink-900">
                    <p className="text-[12px] text-slate-600">还没有内容</p>
                  </div>
                )}

                <div className="mt-1.5 flex items-center gap-1">
                  <button className="btn-ghost px-2 py-0.5 text-[13px]" disabled={cur <= 0} onClick={() => setSlideIndex(cur - 1)}>
                    ‹
                  </button>
                  <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto">
                    {frames.map((it, i) => (
                      <button
                        key={i}
                        onClick={() => setSlideIndex(i)}
                        title={it.title || `第 ${i + 1} 页`}
                        className={`h-1.5 shrink-0 rounded-full transition-all ${i === cur ? 'w-5 bg-boss' : 'w-1.5 bg-ink-600 hover:bg-ink-500'}`}
                      />
                    ))}
                  </div>
                  <button className="btn-ghost px-2 py-0.5 text-[13px]" disabled={cur >= frames.length - 1} onClick={() => setSlideIndex(cur + 1)}>
                    ›
                  </button>
                </div>

                {/* 换模板实时生效 */}
                <div className="mt-2.5">
                  <p className="mb-1 text-[10px] text-slate-500">换模板（预览立刻变，不用重新生成）</p>
                  <div className="grid grid-cols-5 gap-1">
                    {THEMES.map((th) => (
                      <button
                        key={th.id}
                        onClick={() => setTheme(th.id)}
                        title={th.desc}
                        className={`rounded border p-1 text-center transition ${
                          theme === th.id ? 'border-boss bg-boss/15' : 'border-ink-600 hover:border-slate-500'
                        }`}
                      >
                        <span className="mb-0.5 flex h-3 w-full overflow-hidden rounded-sm" style={{ background: th.coverBg }}>
                          <span className="h-full w-1/2" style={{ background: th.accent }} />
                        </span>
                        <span className={`block truncate text-[9px] ${theme === th.id ? 'text-boss-strong' : 'text-slate-400'}`}>
                          {th.label}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {frames[cur]?.kind === 'toc' ? (
                  <p className="mt-2 text-[10px] leading-relaxed text-slate-600">目录页按内容页标题自动生成，不需要单独编辑。</p>
                ) : null}
              </div>
            </aside>
          </div>
        )}

        {/* ================= 第三步：出片 ================= */}
        {step === 'build' && (
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(26rem,38rem)]">
            <div className="min-w-0">
              <div className="rounded-xl border border-ink-500 bg-ink-800 p-4">
                <div className="mb-2 flex items-center gap-2">
                  <span className="panel-title !mb-0">出片</span>
                  <span className="chip">{outline?.title}</span>
                  <button className="ml-auto text-[10.5px] text-slate-500 hover:text-slate-300" onClick={() => !busy && setStep('outline')}>
                    返回改大纲
                  </button>
                </div>

                <ProgressSteps phase={phase} labels={phaseLabels} />
                {busy ? <p className="mt-1.5 font-mono text-[10px] text-slate-500">已用时 {elapsed}s</p> : null}

                {thumbs.length > 0 ? (
                  <div className="mt-2.5">
                    <p className="mb-1 text-[10px] text-slate-500">
                      已生成配图 {imgProgress.done}/{imgProgress.total || thumbs.length}
                    </p>
                    <div className="flex gap-1 overflow-x-auto">
                      {thumbs.map((n, i) => (
                        <img key={`${n}-${i}`} src={api.aipptImageUrl(n)} alt="" className="h-10 w-16 shrink-0 rounded border border-ink-600 object-cover" />
                      ))}
                    </div>
                  </div>
                ) : null}

                {result && phase === 'done' ? (
                  <div className="mt-3 space-y-2">
                    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-emerald-600/40 bg-emerald-900/15 px-3 py-2">
                      <span className="text-[12px] text-emerald-300">
                        ✓ 《{result.title}》{result.pages} 页
                      </span>
                      {result.images ? <span className="chip bg-emerald-500/15 text-emerald-300">{result.images} 张配图</span> : null}
                      <button
                        className="btn-success ml-auto px-2.5 py-1 text-[11.5px]"
                        onClick={() => download(result.id, `${result.title}.pptx`)}
                      >
                        ⬇️ 下载 PPT
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button className="btn-ghost px-3 py-1 text-[11.5px]" onClick={() => setStep('outline')}>
                        ✏️ 继续改大纲
                      </button>
                      <button className="btn-ghost px-3 py-1 text-[11.5px]" onClick={build} disabled={busy}>
                        ♻️ 重新出片
                      </button>
                      <button
                        className="btn-ghost px-3 py-1 text-[11.5px]"
                        onClick={() => {
                          setStep('setup')
                          setOutline(null)
                          setResult(null)
                          setPhase('')
                        }}
                      >
                        ＋ 做一份新的
                      </button>
                    </div>
                    <p className="text-[10px] leading-relaxed text-slate-500">
                      演讲备注已经写进 pptx 的备注栏，放映时看不到，演示者视图能看。
                    </p>
                  </div>
                ) : null}

                {!busy && !result ? (
                  <p className="mt-2 text-[11px] text-slate-500">还没有生成结果。点右侧的「生成」开始。</p>
                ) : null}
              </div>
            </div>

            <aside className="min-w-0 xl:sticky xl:top-4 xl:self-start">
              <div className="rounded-xl border border-ink-500 bg-ink-800 p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-[11.5px] font-medium text-slate-300">成片预览</span>
                  <span className="chip">{frames.length} 页</span>
                </div>
                {frames.length ? (
                  <Frame T={themeMeta} f={frames[cur]} picUrl={frames[cur]?.pic ? api.aipptImageUrl(frames[cur].pic) : ''} cur={cur} total={frames.length} />
                ) : null}
                <div className="mt-1.5 flex gap-1">
                  {frames.map((it, i) => (
                    <button
                      key={i}
                      onClick={() => setSlideIndex(i)}
                      title={it.title || `第 ${i + 1} 页`}
                      className={`h-1.5 shrink-0 rounded-full transition-all ${i === cur ? 'w-5 bg-boss' : 'w-1.5 bg-ink-600 hover:bg-ink-500'}`}
                    />
                  ))}
                </div>
              </div>
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}
