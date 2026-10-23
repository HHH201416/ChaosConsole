import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../lib/useT'

/** 8.0.0：运行环境 / 工具链管理（检测 + 一键安装） */
export default function ToolchainModal({ onClose }) {
  const t = useT()
  const toolchain = useStore((s) => s.toolchain)
  const job = useStore((s) => s.toolchainJob)
  const logs = useStore((s) => s.toolchainLogs)
  const loadToolchain = useStore((s) => s.loadToolchain)
  const refreshToolchain = useStore((s) => s.refreshToolchain)
  const installTool = useStore((s) => s.installTool)
  const cancelToolInstall = useStore((s) => s.cancelToolInstall)
  const [confirm, setConfirm] = useState(null) // { tools: [] }
  const [queue, setQueue] = useState([])
  const logRef = useRef(null)

  useEffect(() => {
    loadToolchain()
  }, [loadToolchain])

  useEffect(() => {
    if (!logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs.length, job?.id, job?.percent])

  // 串行安装：一个装完再装下一个
  useEffect(() => {
    if (!queue.length) return
    if (!job) {
      installTool(queue[0])
      return
    }
    if (job.tool !== queue[0]) return
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') {
      const rest = queue.slice(1)
      setQueue(rest)
      if (rest.length && job.status === 'done') installTool(rest[0])
    }
  }, [job, queue, installTool])

  const order = ['node', 'claude', 'deveco-cli', 'deveco-studio']
  const tools = toolchain?.tools || {}
  const missing = useMemo(
    () => order.filter((id) => toolchain?.supported !== false && !tools[id]?.installed),
    [order, tools, toolchain],
  )

  const running = job && job.status === 'running'
  const percent = job?.percent || 0

  const startConfirm = (ids) => {
    if (!ids.length) return
    setConfirm({ tools: ids })
  }

  const doInstall = () => {
    const ids = confirm?.tools || []
    setConfirm(null)
    if (!ids.length) return
    setQueue(ids)
    installTool(ids[0])
  }

  const labelOf = (id) => {
    if (id === 'node') return t('toolchain.node')
    if (id === 'claude') return t('toolchain.claude')
    if (id === 'deveco-cli') return t('toolchain.devecoCli')
    return t('toolchain.devecoStudio')
  }

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[46rem] flex-col overflow-hidden rounded-xl border border-ink-500 bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between border-b border-ink-600 p-5">
          <div>
            <h3 className="text-base font-semibold text-slate-100">{t('toolchain.title')}</h3>
            <p className="mt-0.5 text-[11px] text-slate-500">{t('toolchain.subtitle')}</p>
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={refreshToolchain}>
              ⟳ {t('toolchain.recheck')}
            </button>
            <button className="btn-ghost" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {toolchain?.supported === false && (
            <p className="mb-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[11.5px] text-amber-300">
              {t('toolchain.unsupported')}
            </p>
          )}

          <div className="mb-4 flex items-center justify-between">
            <div className="text-[11px] text-slate-500">
              {t('common.path')}: <span className="font-mono">{toolchain?.root || '…'}</span>
            </div>
            <button
              className="btn-primary"
              disabled={!missing.length || running || toolchain?.supported === false}
              onClick={() => startConfirm(missing)}
            >
              {t('toolchain.installAll')}
              {missing.length ? ` (${missing.length})` : ''}
            </button>
          </div>

          <div className="space-y-2">
            {order.map((id) => {
              const info = tools[id] || {}
              return (
                <div
                  key={id}
                  className="rounded-lg border border-ink-500 bg-ink-900 p-3"
                  data-testid={`tool-${id}`}
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        info.installed ? 'bg-emerald-500' : 'bg-slate-600'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[13px] font-medium text-slate-200">{labelOf(id)}</span>
                        <span className="chip">{info.installed ? t('common.installed') : t('common.notInstalled')}</span>
                        {info.version && <span className="font-mono text-[10px] text-slate-500">{info.version}</span>}
                        {info.requiresElevation && (
                          <span className="chip bg-amber-500/15 text-amber-300">{t('toolchain.requiresUac')}</span>
                        )}
                        {info.requiresAccount && (
                          <span className="chip bg-violet-500/15 text-violet-300">{t('toolchain.requiresAccount')}</span>
                        )}
                      </div>
                      {info.path && (
                        <p className="mt-1 truncate font-mono text-[10px] text-slate-600" title={info.path}>
                          {info.path}
                        </p>
                      )}
                      {info.note && <p className="mt-1 text-[10.5px] text-slate-500">{info.note}</p>}
                    </div>
                    <button
                      className={info.installed ? 'btn-ghost' : 'btn-primary'}
                      disabled={running || toolchain?.supported === false}
                      onClick={() => startConfirm([id])}
                    >
                      {info.installed ? t('common.install') : t('common.install')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {job && (
            <div className="mt-4 rounded-lg border border-ink-500 bg-ink-900 p-3">
              <div className="flex items-center justify-between text-[11.5px]">
                <span className="text-slate-300">
                  {labelOf(job.tool)} · {job.message || job.step}
                </span>
                <span className="font-mono text-[10px] text-slate-500">
                  {job.status === 'running' ? `${percent}%` : job.status}
                </span>
              </div>
              <div className="progress-track mt-2 !w-full">
                <span className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              {running && (
                <button className="btn-danger mt-2" onClick={cancelToolInstall}>
                  {t('toolchain.cancel')}
                </button>
              )}
              {job.error && <p className="mt-2 whitespace-pre-wrap text-[10.5px] text-rose-400">{job.error}</p>}
            </div>
          )}

          <div className="mt-3">
            <div className="panel-title mb-1">{t('toolchain.log')}</div>
            <div
              ref={logRef}
              className="max-h-48 overflow-y-auto rounded-lg border border-ink-500 bg-ink-900 p-2 font-mono text-[10px] leading-relaxed text-slate-400"
            >
              {logs.length === 0 && <p className="text-slate-600">{t('toolchain.noLog')}</p>}
              {logs.map((entry, i) => (
                <div key={`${entry.jobId}-${i}`} className={entry.stream === 'err' ? 'text-rose-400' : ''}>
                  {entry.line}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {confirm && (
        <div
          className="fixed inset-0 z-[66] flex items-center justify-center bg-black/60 p-6"
          onClick={(e) => {
            e.stopPropagation()
            setConfirm(null)
          }}
        >
          <div
            className="w-[30rem] rounded-xl border border-ink-500 bg-ink-800 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="text-sm font-semibold text-slate-100">{t('toolchain.consentTitle')}</h4>
            <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">{t('toolchain.consentBody')}</p>
            <ul className="mt-2 space-y-1 text-[11.5px] text-slate-300">
              {confirm.tools.map((id) => (
                <li key={id} className="flex items-center gap-2">
                  <span className="text-boss-strong">•</span>
                  <span>{labelOf(id)}</span>
                  <span className="font-mono text-[10px] text-slate-600">{tools[id]?.version || ''}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[10.5px] leading-relaxed text-slate-500">{t('toolchain.consentPath')}</p>
            <p className="mt-1 text-[10.5px] leading-relaxed text-slate-500">{t('toolchain.consentUac')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setConfirm(null)}>
                {t('common.cancel')}
              </button>
              <button className="btn-primary" onClick={doInstall}>
                {t('common.install')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
