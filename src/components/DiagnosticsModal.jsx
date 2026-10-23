import { useEffect } from 'react'
import { useStore } from '../store'
import { useT } from '../lib/useT'

const STATUS_CLS = {
  ok: 'bg-emerald-500',
  warn: 'bg-amber-500',
  error: 'bg-rose-500',
}

/** 8.0.0：健康检查 / 诊断中心 */
export default function DiagnosticsModal({ onClose }) {
  const t = useT()
  const data = useStore((s) => s.diagnostics)
  const loading = useStore((s) => s.diagnosticsLoading)
  const loadDiagnostics = useStore((s) => s.loadDiagnostics)
  const exportDiagnostics = useStore((s) => s.exportDiagnostics)

  useEffect(() => {
    loadDiagnostics()
  }, [loadDiagnostics])

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[44rem] flex-col overflow-hidden rounded-xl border border-ink-500 bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-center justify-between border-b border-ink-600 p-5">
          <h3 className="text-base font-semibold text-slate-100">{t('diagnostics.title')}</h3>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={loadDiagnostics}>
              ⟳ {t('common.refresh')}
            </button>
            <button className="btn-ghost" onClick={exportDiagnostics}>
              ⭳ {t('diagnostics.export')}
            </button>
            <button className="btn-ghost" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading && !data && <p className="py-8 text-center text-xs text-slate-600">{t('common.loading')}</p>}
          {data && (
            <>
              <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ['App', data.app?.version],
                  ['Node', data.app?.node],
                  ['Electron', data.app?.electron || '—'],
                  ['Uptime', `${Math.round((data.app?.uptimeSec || 0) / 60)}m`],
                  [t('stats.tasks'), data.counts?.tasks],
                  [t('stats.running'), data.counts?.running],
                  [t('stats.blocked'), data.counts?.blocked],
                  [t('palette.agents'), data.counts?.agents],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border border-ink-500 bg-ink-900 p-2.5">
                    <div className="text-[10px] text-slate-500">{label}</div>
                    <div className="mt-0.5 font-mono text-[12px] text-slate-200">{value ?? '—'}</div>
                  </div>
                ))}
              </div>

              <div className="panel-title mb-2">{t('diagnostics.checks')}</div>
              <div className="space-y-1.5">
                {(data.checks || []).map((c) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-md bg-ink-900 px-3 py-1.5">
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_CLS[c.status] || 'bg-slate-600'}`} />
                    <span className="w-40 shrink-0 text-[11.5px] text-slate-300">{c.label}</span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-500" title={c.detail}>
                      {c.detail}
                    </span>
                    <span className="text-[10px] text-slate-500">{t(`diagnostics.${c.status}`)}</span>
                  </div>
                ))}
              </div>

              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-lg border border-ink-500 bg-ink-900 p-3 text-[10.5px] leading-relaxed text-slate-400">
                  <div className="panel-title mb-1">Data</div>
                  <div className="font-mono break-all">{data.data?.dir}</div>
                  <div className="mt-1">
                    DB: {Math.round((data.data?.dbSize || 0) / 1024)} KB · {data.data?.backups || 0}{' '}
                    backups
                  </div>
                  <div>WS: {data.server?.wsClients ?? 0}</div>
                </div>
                <div className="rounded-lg border border-ink-500 bg-ink-900 p-3 text-[10.5px] leading-relaxed text-slate-400">
                  <div className="panel-title mb-1">Executors</div>
                  <div className="truncate font-mono" title={data.executors?.claude?.bin}>
                    claude: {data.executors?.claude?.bin || '—'}
                  </div>
                  <div className="truncate font-mono" title={data.executors?.deveco?.bin}>
                    deveco: {data.executors?.deveco?.bin || '—'}
                  </div>
                  <div className="truncate font-mono" title={data.executors?.deveco?.tools?.studio}>
                    studio: {data.executors?.deveco?.tools?.studio || '—'}
                  </div>
                </div>
              </div>

              <div className="mt-4">
                <div className="panel-title mb-2">{t('diagnostics.recentErrors')}</div>
                <div className="max-h-40 overflow-y-auto rounded-lg border border-ink-500 bg-ink-900 p-2 font-mono text-[10px] text-slate-400">
                  {(data.recentErrors || []).length === 0 && (
                    <p className="text-slate-600">{t('diagnostics.noErrors')}</p>
                  )}
                  {(data.recentErrors || []).slice().reverse().map((e, i) => (
                    <div key={`${e.at}-${i}`} className="py-0.5">
                      <span className="text-slate-600">[{new Date(e.at).toLocaleTimeString()}]</span>{' '}
                      <span className="text-rose-400">{e.scope}</span> {e.message}
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
