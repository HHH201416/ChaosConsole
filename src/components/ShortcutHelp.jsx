import { useStore } from '../store'
import { useT } from '../lib/useT'

/** 8.0.0：快捷键帮助浮层（Ctrl+/ 或 F1） */
export default function ShortcutHelp() {
  const t = useT()
  const open = useStore((s) => s.helpOpen)
  const toggleHelp = useStore((s) => s.toggleHelp)
  if (!open) return null

  const isMac = /Mac/i.test(navigator.platform || '')
  const mod = isMac ? '⌘' : 'Ctrl'
  const rows = [
    [`${mod}+K`, t('help.palette')],
    [`${mod}+N`, t('help.newTask')],
    [`${mod}+Shift+N`, t('help.newAgent')],
    [`${mod}+,`, t('help.settings')],
    [`${mod}+/`, t('help.help')],
    [`${mod}+Enter`, t('help.send')],
    ['Esc', t('help.escape')],
    [`${mod}+Shift+Space`, t('help.toggle')],
  ]

  return (
    <div className="fixed inset-0 z-[72] flex items-center justify-center bg-black/50 p-6" onClick={() => toggleHelp(false)}>
      <div
        className="w-full max-w-[30rem] rounded-xl border border-ink-500 bg-ink-800 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('help.title')}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold text-slate-100">{t('help.title')}</h3>
          <button className="btn-ghost" onClick={() => toggleHelp(false)}>
            {t('common.close')}
          </button>
        </div>
        <div className="space-y-1.5">
          {rows.map(([key, label]) => (
            <div key={key} className="flex items-center justify-between rounded-md bg-ink-900 px-3 py-1.5">
              <span className="text-[12px] text-slate-300">{label}</span>
              <kbd className="rounded border border-ink-500 bg-ink-700 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                {key}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
