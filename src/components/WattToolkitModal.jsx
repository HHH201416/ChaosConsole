import { useState } from 'react'
import { useStore } from '../store'
import { useT } from '../lib/useT'

const WEBSITE = 'https://steampp.net'
const WINGET = 'winget install --id 9MTCFHS560NG --source msstore'

/**
 * 8.0.0：Watt Toolkit 提示。
 *
 * 只在「检查历史版本 / 回退下载失败」等场景出现；明确说明：
 * 不是必需项、ChaosConsole 不会自动安装它。
 */
export default function WattToolkitModal() {
  const t = useT()
  const open = useStore((s) => s.wattPromptOpen)
  const close = useStore((s) => s.closeWattPrompt)
  const snooze = useStore((s) => s.snoozeWattPrompt)
  const dismiss = useStore((s) => s.dismissWattPrompt)
  const [copied, setCopied] = useState(false)
  if (!open) return null

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(WINGET)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch (_) {
      /* 剪贴板不可用就保持命令可手动复制 */
    }
  }

  return (
    <div className="fixed inset-0 z-[68] flex items-center justify-center bg-black/50 p-6" onClick={close}>
      <div
        className="w-[30rem] rounded-xl border border-ink-500 bg-ink-800 p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('watt.title')}
      >
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xl">⚡</span>
          <h3 className="text-base font-semibold text-slate-100">{t('watt.title')}</h3>
        </div>
        <p className="text-[11.5px] leading-relaxed text-slate-400">{t('watt.body')}</p>

        <div className="mt-3 rounded-lg border border-ink-500 bg-ink-900 p-3">
          <div className="text-[10.5px] text-slate-500">{t('watt.command')}</div>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[10.5px] text-slate-300">{WINGET}</code>
            <button className="btn-ghost shrink-0 px-2 py-1 text-[10.5px]" onClick={copy}>
              {copied ? t('common.copied') : t('watt.copy')}
            </button>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
          <a href={WEBSITE} target="_blank" rel="noreferrer" className="btn-primary">
            {t('watt.website')}
          </a>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={snooze}>
              {t('watt.later')}
            </button>
            <button className="btn-ghost" onClick={dismiss}>
              {t('watt.never')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
