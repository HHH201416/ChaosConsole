import { useEffect, useMemo, useRef, useState } from 'react'
import { useStore } from '../store'
import { api } from '../lib/api'
import { useT } from '../lib/useT'

/**
 * 「混沌」本地大模型面板 —— 两用：
 *
 *   1. 新用户第一次打开应用时的推荐引导（App 检测 chaosGuideDone 后自动弹出）；
 *   2. 之后的常驻管理入口（顶栏「混沌」按钮）。
 *
 * 流程：检测 → 未装引擎展示欢迎页（一键安装 / 跳过）→ 安装进度（ws 推送
 * chaos:job / chaos:log）→ 就绪后展示模型列表（可继续下载）→ 一键把
 * 「日常对话」岗位切到混沌执行器。跳过后写 chaosGuideDone，不再自动弹出。
 */
export default function ChaosModal({ onClose, isFirstRun = false }) {
  const t = useT()
  const toast = useStore((s) => s.toast)
  const status = useStore((s) => s.chaosStatus)
  const job = useStore((s) => s.chaosJob)
  const logs = useStore((s) => s.chaosLogs)
  const loadChaosStatus = useStore((s) => s.loadChaosStatus)
  const installChaos = useStore((s) => s.installChaos)
  const pullChaosModel = useStore((s) => s.pullChaosModel)
  const cancelChaosJob = useStore((s) => s.cancelChaosJob)
  const agents = useStore((s) => s.agents)
  const refreshSystem = useStore((s) => s.refreshSystem)

  const [switched, setSwitched] = useState(false)
  const logRef = useRef(null)

  useEffect(() => {
    loadChaosStatus()
  }, [loadChaosStatus])

  useEffect(() => {
    if (!logRef.current) return
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs.length, job?.percent])

  const engineInstalled = Boolean(status?.installed)
  const serverUp = Boolean(status?.serverUp)
  const models = useMemo(() => status?.catalog || [], [status])
  const hasReadyModel = models.some((m) => m.installed)
  const allReady = engineInstalled && hasReadyModel
  const running = job?.status === 'running'
  const percent = job?.percent || 0

  const skip = async () => {
    try {
      await api.chaosGuideDone()
    } catch (_) {
      /* 忽略：跳过不成功也只是下次再推荐一次 */
    }
    onClose()
  }

  const switchDailyChat = async () => {
    const chat = agents.find((a) => a.role === 'Chat')
    if (!chat) {
      toast('找不到「日常对话」岗位', 'error')
      return
    }
    try {
      await api.updateAgent(chat.id, { executor: 'chaos', model: models.find((m) => m.installed)?.id || '' })
      await refreshSystem()
      setSwitched(true)
      toast(t('chaos.switched'), 'success')
    } catch (err) {
      toast(err.message, 'error')
    }
  }

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-6" onClick={skip}>
      <div
        className="flex max-h-[88vh] w-[40rem] flex-col overflow-hidden rounded-xl border border-ink-500 bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        {/* 头部 */}
        <div className="border-b border-ink-600 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-100">
                <span className="mr-2">🌀</span>
                {t('chaos.title')}
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-500">{t('chaos.subtitle')}</p>
            </div>
            <div className="flex shrink-0 gap-2">
              <button className="btn-ghost" onClick={() => loadChaosStatus()} title={t('chaos.refresh')}>
                ⟳
              </button>
              <button className="btn-ghost" onClick={skip}>
                {t('common.close')}
              </button>
            </div>
          </div>
          {isFirstRun && !allReady && !running && (
            <p className="mt-2 text-[11.5px] leading-relaxed text-slate-400">
              {t('chaos.welcomeBody')}
            </p>
          )}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {/* 欢迎页：还没装引擎时展示推荐理由 */}
          {!engineInstalled && !running && (
            <div className="rounded-xl border border-boss/40 bg-boss/10 p-4">
              <p className="text-[13px] font-semibold text-boss-strong">✨ {t('chaos.welcomeTitle')}</p>
              <ul className="mt-2 space-y-1.5 text-[12px] text-slate-300">
                <li>✦ {t('chaos.f1')}</li>
                <li>✦ {t('chaos.f2')}</li>
                <li>✦ {t('chaos.f3')}</li>
              </ul>
              <div className="mt-4 flex items-center gap-2">
                <button className="btn-primary" onClick={installChaos}>
                  {t('chaos.install')}
                </button>
                <button className="btn-ghost" onClick={skip}>
                  {t('chaos.skip')}
                </button>
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-slate-500">{t('chaos.tip')}</p>
            </div>
          )}

          {/* 引擎状态 */}
          <div className="mt-4 rounded-lg border border-ink-500 bg-ink-900 p-3">
            <div className="flex items-center gap-3">
              <span className={`mt-0 h-2 w-2 shrink-0 rounded-full ${engineInstalled ? 'bg-emerald-500' : 'bg-slate-600'}`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13px] font-medium text-slate-200">{t('chaos.engine')}</span>
                  <span className="chip">{engineInstalled ? t('chaos.installed') : t('chaos.notInstalled')}</span>
                  <span className="chip">{t('chaos.server')}: {serverUp ? t('chaos.up') : t('chaos.down')}</span>
                </div>
                {status?.base && (
                  <p className="mt-1 truncate font-mono text-[10px] text-slate-600">{status.base}</p>
                )}
              </div>
              {!engineInstalled && !running && (
                <button className="btn-primary shrink-0" onClick={installChaos}>
                  {t('chaos.install')}
                </button>
              )}
            </div>
          </div>

          {/* 模型列表 */}
          {engineInstalled && (
            <div className="mt-4">
              <div className="panel-title mb-1">{t('chaos.models')}</div>
              <div className="space-y-2">
                {models.map((m) => (
                  <div key={m.id} className="flex items-start gap-3 rounded-lg border border-ink-500 bg-ink-900 p-3">
                    <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${m.installed ? 'bg-emerald-500' : 'bg-slate-600'}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[12.5px] font-medium text-slate-200">{m.label}</span>
                        <span className="font-mono text-[10px] text-slate-600">{m.id}</span>
                        <span className="chip">{m.size}</span>
                        {m.installed && <span className="chip bg-emerald-500/15 text-emerald-300">{t('chaos.ready')}</span>}
                      </div>
                      <p className="mt-1 text-[10.5px] text-slate-500">{m.note}</p>
                    </div>
                    {m.installed ? null : (
                      <button className="btn-ghost shrink-0" disabled={running} onClick={() => pullChaosModel(m.id)}>
                        ↓ {t('chaos.pull')}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 就绪状态 + 切换日常对话 */}
          {allReady && (
            <div className="mt-4 rounded-lg border border-emerald-600/50 bg-emerald-900/20 p-3">
              <p className="text-[12.5px] font-medium text-emerald-300">✓ {t('chaos.done')}</p>
              <p className="mt-1 text-[11px] text-slate-400">{switched ? t('chaos.switched') : t('chaos.doneBody')}</p>
              {!switched && (
                <button className="btn-success mt-2" onClick={switchDailyChat}>
                  {t('chaos.switchChat')}
                </button>
              )}
            </div>
          )}

          {/* 安装/下载进度 */}
          {job && (
            <div className="mt-4 rounded-lg border border-ink-500 bg-ink-900 p-3">
              <div className="flex items-center justify-between text-[11.5px]">
                <span className="text-slate-300">
                  {job.kind === 'engine' ? t('chaos.engine') : job.model} · {job.message || job.step}
                </span>
                <span className="font-mono text-[10px] text-slate-500">
                  {running ? `${percent}%` : job.status}
                </span>
              </div>
              <div className="progress-track mt-2 !w-full">
                <span className="progress-fill" style={{ width: `${percent}%` }} />
              </div>
              {running && (
                <button className="btn-danger mt-2" onClick={cancelChaosJob}>
                  {t('common.cancel')}
                </button>
              )}
              {job.error && <p className="mt-2 whitespace-pre-wrap text-[10.5px] text-rose-400">{job.error}</p>}
            </div>
          )}

          {/* 日志 */}
          {logs.length > 0 && (
            <div className="mt-3">
              <div className="panel-title mb-1">{t('chaos.log')}</div>
              <div
                ref={logRef}
                className="max-h-40 overflow-y-auto rounded-lg border border-ink-500 bg-ink-900 p-2 font-mono text-[10px] leading-relaxed text-slate-400"
              >
                {logs.map((entry, i) => (
                  <div key={`${entry.jobId}-${i}`} className={entry.stream === 'err' ? 'text-rose-400' : ''}>
                    {entry.line}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* 底部：不再推荐 */}
        {isFirstRun && (
          <div className="flex items-center justify-between border-t border-ink-600 p-4">
            <span className="text-[10.5px] text-slate-600">{t('chaos.neverAsk')}</span>
            <button className="btn-ghost" onClick={skip}>
              {t('chaos.skip')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
