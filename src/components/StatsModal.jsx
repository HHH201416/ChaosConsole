import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../lib/useT'

function fmtDuration(ms) {
  const n = Number(ms) || 0
  if (n < 60_000) return `${Math.round(n / 1000)}s`
  if (n < 3_600_000) return `${Math.round(n / 60_000)}m`
  return `${(n / 3_600_000).toFixed(1)}h`
}

function pct(value) {
  if (value === null || value === undefined) return '—'
  return `${Math.round(value * 100)}%`
}

/** 8.0.0：任务统计仪表盘（纯 SVG，不引入图表库） */
export default function StatsModal({ onClose }) {
  const t = useT()
  const stats = useStore((s) => s.stats)
  const loading = useStore((s) => s.statsLoading)
  const loadStats = useStore((s) => s.loadStats)
  const [range, setRange] = useState('30')

  useEffect(() => {
    loadStats(range)
  }, [range, loadStats])

  const totals = stats?.totals || {}
  const days = stats?.perDay || []
  const max = Math.max(1, ...days.map((d) => Math.max(d.created, d.completed)))
  const W = 620
  const H = 120
  const barW = days.length ? Math.max(3, Math.floor((W - 20) / days.length) - 2) : 6

  const ranges = [
    ['7', t('stats.range7')],
    ['30', t('stats.range30')],
    ['90', t('stats.range90')],
    ['all', t('stats.rangeAll')],
  ]

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[48rem] flex-col overflow-hidden rounded-xl border border-ink-500 bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-center justify-between border-b border-ink-600 p-5">
          <h3 className="text-base font-semibold text-slate-100">{t('stats.title')}</h3>
          <div className="flex items-center gap-2">
            <div className="flex rounded-md border border-ink-500 p-0.5">
              {ranges.map(([key, label]) => (
                <button
                  key={key}
                  onClick={() => setRange(key)}
                  className={`rounded px-2 py-1 text-[10.5px] ${
                    range === key ? 'bg-boss/20 text-boss-strong' : 'text-slate-500 hover:text-slate-300'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button className="btn-ghost" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading && !stats && <p className="py-8 text-center text-xs text-slate-600">{t('common.loading')}</p>}
          {stats && (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  [t('stats.total'), totals.tasks],
                  [t('stats.completed'), totals.completedInRange],
                  [t('stats.successRate'), pct(totals.successRate)],
                  [t('stats.avgDuration'), fmtDuration(totals.avgDurationMs)],
                  [t('stats.avgAttempts'), (Number(totals.avgAttempts) || 0).toFixed(1)],
                  [t('stats.running'), totals.running],
                  [t('stats.blocked'), totals.blocked],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-ink-500 bg-ink-900 p-3">
                    <div className="text-[10px] text-slate-500">{label}</div>
                    <div className="mt-1 font-mono text-lg text-slate-100">{value ?? '—'}</div>
                  </div>
                ))}
              </div>

              <div className="mt-5">
                <div className="panel-title mb-2">{t('stats.perDay')}</div>
                <div className="rounded-lg border border-ink-500 bg-ink-900 p-3">
                  {days.length === 0 ? (
                    <p className="py-6 text-center text-xs text-slate-600">{t('stats.noData')}</p>
                  ) : (
                    <svg viewBox={`0 0 ${W} ${H + 18}`} className="w-full" role="img" aria-label={t('stats.perDay')}>
                      {days.map((d, i) => {
                        const x = 10 + i * (barW + 2)
                        const h1 = Math.round(((d.created || 0) / max) * H)
                        const h2 = Math.round(((d.completed || 0) / max) * H)
                        return (
                          <g key={d.date}>
                            <rect x={x} y={H - h1} width={barW} height={h1} rx="1.5" fill="rgb(var(--c-sky-500))" opacity="0.55" />
                            <rect
                              x={x + Math.max(1, barW / 2)}
                              y={H - h2}
                              width={Math.max(1, barW / 2)}
                              height={h2}
                              rx="1.5"
                              fill="rgb(var(--c-emerald-500))"
                              opacity="0.8"
                            />
                          </g>
                        )
                      })}
                      <line x1="10" y1={H} x2={W - 10} y2={H} stroke="rgb(var(--c-ink-500))" strokeWidth="1" />
                    </svg>
                  )}
                  <div className="mt-1 flex gap-4 text-[10px] text-slate-500">
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-sm bg-sky-500/60" /> {t('stats.tasks')}
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="h-1.5 w-1.5 rounded-sm bg-emerald-500/80" /> {t('stats.completed')}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-5">
                <div className="panel-title mb-2">{t('stats.perAgent')}</div>
                <div className="overflow-hidden rounded-lg border border-ink-500">
                  <table className="w-full text-[11px]">
                    <thead className="bg-ink-900 text-slate-500">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-normal">{t('palette.agents')}</th>
                        <th className="px-3 py-1.5 text-right font-normal">{t('stats.tasks')}</th>
                        <th className="px-3 py-1.5 text-right font-normal">{t('stats.completed')}</th>
                        <th className="px-3 py-1.5 text-right font-normal">{t('stats.successRate')}</th>
                        <th className="px-3 py-1.5 text-right font-normal">{t('stats.avgDuration')}</th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {(stats.perAgent || []).map((a) => (
                        <tr key={a.id} className="border-t border-ink-600">
                          <td className="px-3 py-1.5">{a.functionLabel}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{a.total}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{a.completed}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{pct(a.successRate)}</td>
                          <td className="px-3 py-1.5 text-right font-mono">{fmtDuration(a.avgDurationMs)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
