import { useStore } from '../store'
import { useT } from '../lib/useT'

const COLUMN_KEYS = ['backlog', 'in_progress', 'needs_input', 'complete']

/** 8.0.0：看板批量操作条 */
export default function BulkBar() {
  const t = useT()
  const selected = useStore((s) => s.selectedTaskIds)
  const batchTasks = useStore((s) => s.batchTasks)
  const clearTaskSelection = useStore((s) => s.clearTaskSelection)
  const selectAllTasks = useStore((s) => s.selectAllTasks)

  if (!selected.length) return null

  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 flex-wrap items-center gap-1.5 rounded-xl border border-ink-500 bg-ink-800/95 px-3 py-2 shadow-2xl backdrop-blur">
      <span className="mr-1 text-[11.5px] font-medium text-slate-200">
        {t('bulk.selected', { n: selected.length })}
      </span>
      <button className="btn-ghost px-2 py-1 text-[11px]" onClick={selectAllTasks}>
        {t('bulk.selectAll')}
      </button>
      <button className="btn-ghost px-2 py-1 text-[11px]" onClick={clearTaskSelection}>
        {t('bulk.clear')}
      </button>
      <span className="mx-1 h-4 w-px bg-ink-500" />
      <button className="btn-primary px-2 py-1 text-[11px]" onClick={() => batchTasks('start')}>
        {t('bulk.start')}
      </button>
      <button className="btn-danger px-2 py-1 text-[11px]" onClick={() => batchTasks('cancel')}>
        {t('bulk.cancel')}
      </button>
      <button className="btn-success px-2 py-1 text-[11px]" onClick={() => batchTasks('done')}>
        {t('bulk.done')}
      </button>
      <select
        className="rounded border border-ink-500 bg-ink-700 px-1.5 py-1 text-[11px] text-slate-300"
        defaultValue=""
        onChange={(e) => {
          if (e.target.value) batchTasks('move', { status: e.target.value })
          e.target.value = ''
        }}
      >
        <option value="" disabled>
          {t('bulk.moveTo')}
        </option>
        {COLUMN_KEYS.map((key) => (
          <option key={key} value={key}>
            {t(`board.${key}`)}
          </option>
        ))}
      </select>
      <button
        className="btn-danger px-2 py-1 text-[11px]"
        onClick={() => {
          if (window.confirm(t('common.delete') + '?')) batchTasks('delete')
        }}
      >
        {t('bulk.delete')}
      </button>
    </div>
  )
}
