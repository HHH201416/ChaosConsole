import { useState } from 'react'
import { STAGE_KEYS, stageLabel } from '../lib/meta'
import { useT } from '../lib/useT'

/**
 * 8.0.0：流水线阶段可视化编辑。
 * value = [{ stage, role }]，顺序就是执行顺序。
 */
export default function PipelineEditor({ value = [], roles = [], onChange, disabled = false }) {
  const t = useT()
  const [addStage, setAddStage] = useState('')

  const used = new Set(value.map((s) => s.stage))
  const addable = STAGE_KEYS.filter((k) => !used.has(k))

  const update = (next) => onChange?.(next)
  const move = (index, delta) => {
    const next = [...value]
    const target = index + delta
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    update(next)
  }

  return (
    <div className="space-y-1.5">
      {value.length === 0 && (
        <p className="rounded border border-dashed border-ink-500 px-2 py-2 text-[10.5px] text-slate-600">
          {t('deps.none')}
        </p>
      )}
      {value.map((item, index) => (
        <div key={item.stage} className="flex items-center gap-1.5">
          <span className="w-5 shrink-0 text-right font-mono text-[10px] text-slate-600">{index + 1}</span>
          <span className="w-10 shrink-0 text-[11px] text-slate-400">{stageLabel(item.stage)}</span>
          <select
            className="field flex-1 !py-1 text-[11px]"
            value={item.role || ''}
            disabled={disabled}
            onChange={(e) => {
              const next = value.map((x, i) => (i === index ? { ...x, role: e.target.value } : x))
              update(next)
            }}
          >
            <option value="">{t('pipeline.skip')}</option>
            {roles.map((r) => (
              <option key={r.role} value={r.role}>
                {r.functionLabel || r.role}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost shrink-0 px-1.5 py-0.5 text-[10px]"
            disabled={disabled || index === 0}
            onClick={() => move(index, -1)}
            title={t('pipeline.up')}
          >
            ↑
          </button>
          <button
            className="btn-ghost shrink-0 px-1.5 py-0.5 text-[10px]"
            disabled={disabled || index === value.length - 1}
            onClick={() => move(index, 1)}
            title={t('pipeline.down')}
          >
            ↓
          </button>
          <button
            className="btn-danger shrink-0 px-1.5 py-0.5 text-[10px]"
            disabled={disabled}
            onClick={() => update(value.filter((_, i) => i !== index))}
            title={t('pipeline.remove')}
          >
            ×
          </button>
        </div>
      ))}

      {!disabled && addable.length > 0 && (
        <div className="flex items-center gap-1.5 pt-1">
          <select
            className="field max-w-[8rem] !py-1 text-[11px]"
            value={addStage}
            onChange={(e) => setAddStage(e.target.value)}
          >
            <option value="">{t('pipeline.addStage')}</option>
            {addable.map((k) => (
              <option key={k} value={k}>
                {stageLabel(k)}
              </option>
            ))}
          </select>
          <button
            className="btn-ghost px-2 py-1 text-[10.5px]"
            disabled={!addStage}
            onClick={() => {
              if (!addStage) return
              update([...value, { stage: addStage, role: roles[0]?.role || '' }])
              setAddStage('')
            }}
          >
            {t('pipeline.add')}
          </button>
        </div>
      )}
    </div>
  )
}
