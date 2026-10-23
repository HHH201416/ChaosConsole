import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { useT } from '../lib/useT'
import { fmtBytes } from '../lib/meta'

/** 8.0.0：备份管理（自动/手动、恢复、保留策略） */
export default function BackupsModal({ onClose }) {
  const t = useT()
  const backups = useStore((s) => s.backups)
  const meta = useStore((s) => s.backupsMeta)
  const loadBackups = useStore((s) => s.loadBackups)
  const createBackup = useStore((s) => s.createBackup)
  const restoreBackup = useStore((s) => s.restoreBackup)
  const deleteBackup = useStore((s) => s.deleteBackup)
  const setDesktopSetting = useStore((s) => s.setDesktopSetting)
  const system = useStore((s) => s.system)
  const [confirmRestore, setConfirmRestore] = useState(null)

  useEffect(() => {
    loadBackups()
  }, [loadBackups])

  const enabled = system?.backupEnabled !== false
  const interval = system?.backupIntervalHours || 24
  const retention = system?.backupRetention || 10

  return (
    <div className="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-6" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-[42rem] flex-col overflow-hidden rounded-xl border border-ink-500 bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-center justify-between border-b border-ink-600 p-5">
          <h3 className="text-base font-semibold text-slate-100">{t('backups.title')}</h3>
          <div className="flex gap-2">
            <button className="btn-primary" onClick={createBackup}>
              {t('settings.backupNow')}
            </button>
            <button className="btn-ghost" onClick={onClose}>
              {t('common.close')}
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <div className="mb-4 grid grid-cols-3 gap-2">
            <label className="flex cursor-pointer items-center justify-between rounded-lg border border-ink-500 bg-ink-900 px-3 py-2 text-[11.5px] text-slate-300">
              <span>{t('settings.backupEnabled')}</span>
              <input
                type="checkbox"
                className="h-3.5 w-3.5 accent-boss"
                checked={enabled}
                onChange={(e) => setDesktopSetting('backupEnabled', e.target.checked)}
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-ink-500 bg-ink-900 px-3 py-2 text-[11.5px] text-slate-300">
              <span className="shrink-0">{t('settings.backupInterval')}</span>
              <input
                type="number"
                min="1"
                max="720"
                defaultValue={interval}
                onBlur={(e) => setDesktopSetting('backupIntervalHours', Number(e.target.value))}
                className="w-16 rounded border border-ink-500 bg-ink-800 px-1.5 py-0.5 text-right font-mono text-[11px]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-ink-500 bg-ink-900 px-3 py-2 text-[11.5px] text-slate-300">
              <span className="shrink-0">{t('settings.backupRetention')}</span>
              <input
                type="number"
                min="1"
                max="200"
                defaultValue={retention}
                onBlur={(e) => setDesktopSetting('backupRetention', Number(e.target.value))}
                className="w-16 rounded border border-ink-500 bg-ink-800 px-1.5 py-0.5 text-right font-mono text-[11px]"
              />
            </label>
          </div>

          <div className="space-y-1.5">
            {backups.length === 0 && <p className="py-6 text-center text-xs text-slate-600">{t('backups.none')}</p>}
            {backups.map((b) => (
              <div key={b.name} className="flex items-center gap-2 rounded-lg border border-ink-500 bg-ink-900 px-3 py-2">
                <span className="chip">{t(`backups.reason.${b.reason}`)}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10.5px] text-slate-400" title={b.name}>
                  {b.name}
                </span>
                <span className="shrink-0 font-mono text-[10px] text-slate-600">{fmtBytes(b.size)}</span>
                <span className="shrink-0 font-mono text-[10px] text-slate-600">
                  {new Date(b.createdAt).toLocaleString()}
                </span>
                <button className="btn-ghost px-2 py-1 text-[10.5px]" onClick={() => setConfirmRestore(b.name)}>
                  {t('common.view')}
                </button>
                <button
                  className="btn-danger px-2 py-1 text-[10.5px]"
                  onClick={() => {
                    if (window.confirm(t('backups.deleteConfirm'))) deleteBackup(b.name)
                  }}
                >
                  {t('common.delete')}
                </button>
              </div>
            ))}
          </div>
        </div>
      </div>

      {confirmRestore && (
        <div className="fixed inset-0 z-[66] flex items-center justify-center bg-black/60 p-6" onClick={(e) => e.stopPropagation()}>
          <div className="w-[26rem] rounded-xl border border-ink-500 bg-ink-800 p-5 shadow-2xl">
            <h4 className="text-sm font-semibold text-slate-100">{t('common.confirm')}</h4>
            <p className="mt-1 text-[11.5px] leading-relaxed text-slate-400">{t('backups.restoreConfirm')}</p>
            <p className="mt-1 break-all font-mono text-[10px] text-slate-500">{confirmRestore}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn-ghost" onClick={() => setConfirmRestore(null)}>
                {t('common.cancel')}
              </button>
              <button
                className="btn-primary"
                onClick={async () => {
                  const name = confirmRestore
                  setConfirmRestore(null)
                  await restoreBackup(name)
                  await loadBackups()
                }}
              >
                {t('common.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
