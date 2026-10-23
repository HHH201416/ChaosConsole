import { useState, useEffect, useRef } from 'react'
import { useStore } from '../store'
import { SKILLS, matchSkill } from '../lib/skills'

/* ------------------------------------------------------------------ *
 * 8.0.2：混沌工具坞 —— WorkBuddy 式的「一排小图标 + 弹出面板」。
 *
 * 专家中心 / 技能 / 魔法棒 / 擂台 / 记忆 / 自动化 / 仪表盘 / 时光机 /
 * 钉住 / 导出 / 纸质模式 / 禅模式 / 老板键 全部挂在这一排上。
 * ------------------------------------------------------------------ */

/* ---------------- 本地小存储（钉住 / 时光机快照 / 草稿） ---------------- */

function ls(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : fallback
  } catch (_) {
    return fallback
  }
}
function lsSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (_) {
    /* 隐私模式写不进就算了 */
  }
}

export const Pins = {
  key: (taskId) => `chaos.pins.${taskId}`,
  list: (taskId) => ls(Pins.key(taskId), []),
  toggle: (taskId, msg) => {
    const cur = Pins.list(taskId)
    const exists = cur.some((p) => p.id === msg.id)
    const next = exists ? cur.filter((p) => p.id !== msg.id) : [...cur, { id: msg.id, text: msg.content, at: Date.now() }].slice(-50)
    lsSet(Pins.key(taskId), next)
    return !exists
  },
  has: (taskId, msgId) => Pins.list(taskId).some((p) => p.id === msgId),
}

export const Snaps = {
  key: (taskId) => `chaos.snaps.${taskId}`,
  list: (taskId) => ls(Snaps.key(taskId), []),
  push(taskId, keep, preview) {
    if (keep <= 0) return
    const cur = Snaps.list(taskId)
    if (cur.length && cur[0].keep === keep) return // 没变化不重复记
    cur.unshift({ keep, preview, ts: Date.now() })
    lsSet(Snaps.key(taskId), cur.slice(0, 20))
  },
}

export const Drafts = {
  key: (taskId) => `chaos.draft.${taskId || 'new'}`,
  load: (taskId) => ls(Drafts.key(taskId), ''),
  save(taskId, text) {
    lsSet(Drafts.key(taskId), text)
  },
}

/* ---------------- 本地朗读（Web Speech，免费离线） ---------------- */

export const TTS = {
  speaking: () => typeof window !== 'undefined' && window.speechSynthesis?.speaking,
  toggle(text) {
    const synth = window.speechSynthesis
    if (!synth) return
    if (synth.speaking) {
      synth.cancel()
      return
    }
    const u = new SpeechSynthesisUtterance(String(text).slice(0, 2000))
    u.lang = 'zh-CN'
    u.rate = 1.05
    synth.speak(u)
  },
}

/* ---------------- 通用弹出面板壳 ---------------- */

function Pop({ title, onClose, children, wide = false }) {
  return (
    <>
      <div className="fixed inset-0 z-20" onClick={onClose} />
      <div
        className={`absolute bottom-full right-0 z-30 mb-2 flex max-h-[26rem] flex-col overflow-hidden rounded-2xl border border-ink-500 bg-ink-800 shadow-2xl ${
          wide ? 'w-[21rem]' : 'w-80'
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-ink-600 px-3 py-2">
          <span className="text-[12px] font-semibold text-slate-100">{title}</span>
          <button className="text-[11px] text-slate-500 hover:text-slate-200" onClick={onClose}>
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
      </div>
    </>
  )
}

function DockButton({ icon, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      className={`relative rounded-lg border px-1.5 py-1 text-[13px] leading-none transition-colors ${
        active
          ? 'border-boss/60 bg-boss/15 text-boss-strong'
          : 'border-ink-500 bg-ink-700/60 text-slate-400 hover:border-ink-400 hover:text-slate-100'
      }`}
    >
      {icon}
    </button>
  )
}

/* ---------------- 专家中心（WorkBuddy 式卡片墙） ---------------- */

function ExpertPanel({ onClose }) {
  const system = useStore((s) => s.system)
  const setChaosExpert = useStore((s) => s.setChaosExpert)
  const experts = system?.chaos?.experts || []
  const active = system?.chaosExpert || 'default'
  return (
    <Pop title="🎭 专家中心 · 混沌人格包" onClose={onClose} wide>
      <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
        选一位专家，混沌会按 TA 的方式回答所有新对话。纯本地提示词工程，随时可换。
      </p>
      <div className="grid grid-cols-2 gap-2">
        {experts.map((e) => (
          <button
            key={e.id}
            onClick={() => setChaosExpert(e.id)}
            className={`rounded-xl border p-2 text-left transition-colors ${
              active === e.id ? 'border-boss/60 bg-boss/10' : 'border-ink-500 bg-ink-700/50 hover:border-ink-400'
            }`}
          >
            <div className="flex items-center gap-1.5">
              <span className="text-[15px]">{e.emoji}</span>
              <span className="text-[11.5px] font-semibold text-slate-100">{e.label}</span>
              {active === e.id && <span className="ml-auto text-[9px] text-boss-strong">使用中</span>}
            </div>
            {e.prompt ? (
              <p className="mt-1 line-clamp-2 text-[10px] leading-snug text-slate-500">{e.prompt.slice(0, 42)}…</p>
            ) : (
              <p className="mt-1 text-[10px] text-slate-500">不加任何预设人格，平衡全能</p>
            )}
          </button>
        ))}
      </div>
    </Pop>
  )
}

/* ---------------- 技能（斜杠快捷指令） ---------------- */

function SkillPanel({ onClose, onPick }) {
  return (
    <Pop title="⚡ 技能库 · 斜杠快捷指令" onClose={onClose} wide>
      <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
        点一条直接把模板填进输入框（{`{text}`} 处填你的内容）；输入框里敲 <span className="font-mono text-slate-300">/</span> 也会弹出过滤。
      </p>
      <div className="space-y-1.5">
        {SKILLS.map((s) => (
          <button
            key={s.cmd}
            onClick={() => onPick(s)}
            className="flex w-full items-center gap-2 rounded-lg border border-ink-500 bg-ink-700/50 px-2.5 py-1.5 text-left hover:border-ink-400"
          >
            <span className="text-[14px]">{s.icon}</span>
            <span className="font-mono text-[11px] text-boss-strong">{s.cmd}</span>
            <span className="text-[11px] text-slate-300">{s.label}</span>
          </button>
        ))}
      </div>
    </Pop>
  )
}

/* ---------------- 长期记忆 ---------------- */

function MemoryPanel({ onClose }) {
  const memory = useStore((s) => s.chaosMemory)
  const loadChaosMemory = useStore((s) => s.loadChaosMemory)
  const saveChaosMemory = useStore((s) => s.saveChaosMemory)
  const [text, setText] = useState('')
  useEffect(() => {
    loadChaosMemory()
  }, [loadChaosMemory])

  return (
    <Pop title="🧠 长期记忆 · 混沌会一直记得" onClose={onClose}>
      <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
        对话里说「记住：…」也会存进来。每次混沌对话都会自动带上这些记忆。全本地，最多 100 条。
      </p>
      <div className="mb-2 flex gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && text.trim()) {
              saveChaosMemory([{ text: text.trim() }, ...memory])
              setText('')
            }
          }}
          placeholder="比如：我喜欢简洁的中文回答"
          className="field min-w-0 flex-1 py-1 text-[11px]"
        />
        <button
          className="btn-primary shrink-0 px-2 py-1 text-[11px]"
          disabled={!text.trim()}
          onClick={() => {
            saveChaosMemory([{ text: text.trim() }, ...memory])
            setText('')
          }}
        >
          记住
        </button>
      </div>
      {memory.length === 0 && <p className="py-4 text-center text-[11px] text-slate-600">还没有记忆。</p>}
      {memory.map((m) => (
        <div key={m.id} className="mb-1 flex items-start gap-2 rounded-lg bg-ink-700/60 px-2 py-1.5">
          <span className="min-w-0 flex-1 break-words text-[11px] leading-snug text-slate-200">{m.text}</span>
          <button
            className="shrink-0 text-[10px] text-slate-500 hover:text-rose-300"
            onClick={() => saveChaosMemory(memory.filter((x) => x.id !== m.id))}
            title="忘掉这条"
          >
            ✕
          </button>
        </div>
      ))}
    </Pop>
  )
}

/* ---------------- 定时自动化 ---------------- */

function AutomationsPanel({ onClose }) {
  const list = useStore((s) => s.chaosAutomations)
  const load = useStore((s) => s.loadChaosAutomations)
  const upsert = useStore((s) => s.upsertChaosAutomation)
  const remove = useStore((s) => s.deleteChaosAutomation)
  const [form, setForm] = useState({ name: '', time: '09:30', prompt: '' })
  useEffect(() => {
    load()
  }, [load])

  return (
    <Pop title="⏰ 定时自动化 · 到点混沌自动干活" onClose={onClose} wide>
      <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
        每天到设定时间，混沌会自动开一个新对话执行提示词（WorkBuddy 式自动化，全本地调度）。
      </p>
      {list.map((a) => (
        <div key={a.id} className="mb-1.5 rounded-lg bg-ink-700/60 px-2 py-1.5">
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={a.enabled}
              onChange={(e) => upsert({ ...a, enabled: e.target.checked })}
              title="启用 / 暂停"
            />
            <span className="text-[11.5px] font-medium text-slate-100">{a.name}</span>
            <span className="font-mono text-[10px] text-boss-strong">{a.time}</span>
            <button
              className="ml-auto text-[10px] text-slate-500 hover:text-rose-300"
              onClick={() => remove(a.id)}
            >
              删除
            </button>
          </div>
          <p className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-slate-500">{a.prompt}</p>
        </div>
      ))}
      <div className="mt-2 rounded-xl border border-dashed border-ink-500 p-2">
        <div className="mb-1.5 flex gap-1.5">
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="名称（如：晨间规划）"
            className="field min-w-0 flex-1 py-1 text-[11px]"
          />
          <input
            type="time"
            value={form.time}
            onChange={(e) => setForm({ ...form, time: e.target.value })}
            className="field w-[6.2rem] shrink-0 py-1 text-[11px]"
          />
        </div>
        <textarea
          rows={2}
          value={form.prompt}
          onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          placeholder="到点要混沌执行的提示词（如：用三句话帮我规划今天的工作重点）"
          className="field resize-none py-1 text-[11px]"
        />
        <button
          className="btn-primary mt-1.5 w-full py-1 text-[11px]"
          disabled={!form.name.trim() || !form.prompt.trim()}
          onClick={async () => {
            const ok = await upsert(form)
            if (ok) setForm({ name: '', time: '09:30', prompt: '' })
          }}
        >
          添加自动化
        </button>
      </div>
    </Pop>
  )
}

/* ---------------- 上下文仪表盘 ---------------- */

function DashboardPanel({ task, messages, events, onClose }) {
  const chaosStatus = useStore((s) => s.chaosStatus)
  const stats = [...events].reverse().find((e) => e.name === 'chaos:stats')
  let last = null
  try {
    last = stats ? JSON.parse(stats.content) : null
  } catch (_) {
    /* ignore */
  }
  const chars = messages.reduce((n, m) => n + (m.content?.length || 0), 0)
  const kbOn = chaosStatus ? true : true
  const quota = chaosStatus?.quota
  return (
    <Pop title="📊 上下文仪表盘" onClose={onClose}>
      <div className="space-y-1.5 text-[11px]">
        <Row k="执行器 / 模型" v={`${task?.executor || '自动派单'}${task?.model ? ` · ${task.model}` : ''}`} />
        <Row k="消息条数" v={`${messages.length} 条（估算 ${(chars / 2 / 1000).toFixed(1)}k tokens）`} />
        <Row k="知识库" v="每回合自动检索，命中片段自动注入" />
        {quota && (
          <Row
            k="Token 额度"
            v={
              quota.unlimited
                ? '永久 Token · 不限量'
                : `今日剩余 ${Number(quota.remaining).toLocaleString()} / ${Number(quota.dailyFree).toLocaleString()}`
            }
          />
        )}
        {last && (
          <Row
            k="上一回合"
            v={`${last.chars} 字 · ${last.tokens} tokens${last.speed ? ` · ${last.speed} tokens/s` : ''}`}
          />
        )}
        {last?.model && <Row k="上一回合模型" v={last.model} />}
        <Row k="推理方" v="本机 GPU/CPU · 完全免费 · 数据不出电脑" />
      </div>
    </Pop>
  )
}

function Row({ k, v }) {
  return (
    <div className="flex items-start gap-2 rounded-lg bg-ink-700/60 px-2 py-1.5">
      <span className="w-[5.5rem] shrink-0 text-[10.5px] text-slate-500">{k}</span>
      <span className="min-w-0 flex-1 break-words text-[10.5px] text-slate-200">{v}</span>
    </div>
  )
}

/* ---------------- 时光机 ---------------- */

function TimeMachinePanel({ taskId, onClose }) {
  const rollbackTask = useStore((s) => s.rollbackTask)
  const [, force] = useState(0)
  const snaps = taskId ? Snaps.list(taskId) : []
  return (
    <Pop title="⏪ 时光机 · 回滚对话" onClose={onClose}>
      <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
        每次对话变化都会自动留快照（本地存最近 20 个）。回滚会删掉快照之后的消息，不可撤销。
      </p>
      {snaps.length === 0 && <p className="py-4 text-center text-[11px] text-slate-600">还没有快照。</p>}
      {snaps.map((s, i) => (
        <button
          key={s.ts}
          onClick={async () => {
            await rollbackTask(taskId, s.keep)
            const rest = Snaps.list(taskId).slice(i + 1)
            lsSet(Snaps.key(taskId), rest)
            force((n) => n + 1)
            onClose()
          }}
          className="mb-1 w-full rounded-lg border border-ink-500 bg-ink-700/50 px-2 py-1.5 text-left hover:border-ink-400"
        >
          <div className="flex items-center gap-2 text-[10px] text-slate-500">
            <span className="font-mono">{new Date(s.ts).toLocaleTimeString()}</span>
            <span>保留前 {s.keep} 条</span>
          </div>
          <div className="mt-0.5 truncate text-[10.5px] text-slate-300">{s.preview}</div>
        </button>
      ))}
    </Pop>
  )
}

/* ---------------- 多模型擂台 ---------------- */

function ArenaPanel({ draft, onClose }) {
  const chaosStatus = useStore((s) => s.chaosStatus)
  const toast = useStore((s) => s.toast)
  const installed = (chaosStatus?.catalog || []).filter((m) => m.installed)
  const [a, setA] = useState(installed[0]?.id || '')
  const [b, setB] = useState(installed[1]?.id || installed[0]?.id || '')
  const [text, setText] = useState(draft)
  const [running, setRunning] = useState(false)
  const [results, setResults] = useState(null)

  const fight = async () => {
    if (!text.trim() || !a || !b || a === b) {
      toast('需要内容，且两个模型不能相同', 'error')
      return
    }
    setRunning(true)
    setResults(null)
    try {
      const r = await useStore.getState().chaosArena(text.trim(), [a, b])
      setResults(r.data)
    } catch (err) {
      toast(err.message, 'error')
    } finally {
      setRunning(false)
    }
  }

  return (
    <Pop title="🥊 模型擂台 · 同题对决" onClose={onClose} wide>
      <p className="mb-2 text-[10.5px] leading-relaxed text-slate-500">
        同一个问题同时发给两个已装的混沌模型，并排比拼质量与速度。
      </p>
      <div className="mb-2 flex gap-1.5">
        <select value={a} onChange={(e) => setA(e.target.value)} className="field min-w-0 flex-1 py-1 text-[11px]">
          {installed.map((m) => (
            <option key={m.id} value={m.id}>
              🅰 {m.label}
            </option>
          ))}
        </select>
        <span className="self-center text-[11px] text-slate-500">vs</span>
        <select value={b} onChange={(e) => setB(e.target.value)} className="field min-w-0 flex-1 py-1 text-[11px]">
          {installed.map((m) => (
            <option key={m.id} value={m.id}>
              🅱 {m.label}
            </option>
          ))}
        </select>
      </div>
      <textarea
        rows={2}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="要对比的问题"
        className="field resize-none py-1 text-[11px]"
      />
      <button className="btn-primary mt-1.5 w-full py-1 text-[11px]" disabled={running} onClick={fight}>
        {running ? '对决中…（本地并行推理）' : '开始对决'}
      </button>
      {results && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {results.map((r) => (
            <div key={r.model} className="rounded-xl border border-ink-500 bg-ink-700/50 p-2">
              <div className="mb-1 flex items-center gap-1 text-[10px]">
                <span className="truncate font-mono text-slate-300">{r.model}</span>
                {r.ok ? (
                  <span className="ml-auto shrink-0 text-slate-500">
                    {(r.ms / 1000).toFixed(1)}s{r.speed ? ` · ${r.speed}/s` : ''}
                  </span>
                ) : (
                  <span className="ml-auto shrink-0 text-rose-300">失败</span>
                )}
              </div>
              <p className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words text-[10.5px] leading-snug text-slate-200">
                {r.ok ? r.text : r.error}
              </p>
            </div>
          ))}
        </div>
      )}
    </Pop>
  )
}

/* ---------------- 钉住列表 ---------------- */

function PinsPanel({ taskId, onClose }) {
  const [, force] = useState(0)
  const pins = taskId ? Pins.list(taskId) : []
  return (
    <Pop title="📌 钉住的重要回答" onClose={onClose}>
      {pins.length === 0 && <p className="py-4 text-center text-[11px] text-slate-600">在任意回答上点 📌 钉住它。</p>}
      {pins.map((p) => (
        <div key={p.id} className="mb-1 rounded-lg bg-ink-700/60 px-2 py-1.5">
          <p className="line-clamp-3 whitespace-pre-wrap break-words text-[10.5px] leading-snug text-slate-200">
            {p.text}
          </p>
          <div className="mt-1 flex gap-2 text-[10px]">
            <button
              className="text-slate-500 hover:text-slate-200"
              onClick={() => {
                navigator.clipboard?.writeText(p.text)
              }}
            >
              复制
            </button>
            <button
              className="ml-auto text-slate-500 hover:text-rose-300"
              onClick={() => {
                lsSet(Pins.key(taskId), Pins.list(taskId).filter((x) => x.id !== p.id))
                force((n) => n + 1)
              }}
            >
              取消钉住
            </button>
          </div>
        </div>
      ))}
    </Pop>
  )
}

/* ---------------- 主工具坞 ---------------- */

export default function ChaosDock({ task, messages, events, draft, setDraft, inputRef }) {
  const toast = useStore((s) => s.toast)
  const branchTask = useStore((s) => s.branchTask)
  const togglePaperMode = useStore((s) => s.togglePaperMode)
  const toggleZenMode = useStore((s) => s.toggleZenMode)
  const toggleBossMode = useStore((s) => s.toggleBossMode)
  const toggleQuick = useStore((s) => s.toggleQuick)
  const paperMode = useStore((s) => s.paperMode)
  const chaosStatus = useStore((s) => s.chaosStatus)

  const [pop, setPop] = useState('')
  const [wandBusy, setWandBusy] = useState(false)
  const taskId = task?.id || ''
  const toggle = (name) => setPop((cur) => (cur === name ? '' : name))

  const magicWand = async () => {
    const text = draft.trim()
    if (!text) {
      toast('先随便写一句口语草稿，再点魔法棒', 'info')
      inputRef.current?.focus()
      return
    }
    setWandBusy(true)
    try {
      const r = await useStore.getState().chaosRewrite(text)
      setDraft(r.text)
      toast('已改写为结构化提示词（可继续编辑）', 'success')
    } catch (err) {
      toast(`魔法棒失灵：${err.message}`, 'error')
    } finally {
      setWandBusy(false)
    }
  }

  const exportMd = () => {
    if (!task) {
      toast('先打开一个对话再导出', 'info')
      return
    }
    const lines = [`# ${task.title}`, '', `> 导出于 ${new Date().toLocaleString()} · ChaosConsole 混沌`, '']
    for (const m of messages) {
      const who = m.role === 'user' ? '🧑 我' : m.role === 'assistant' ? '🌀 混沌' : '⚙️ 系统'
      lines.push(`**${who}**（${new Date(m.createdAt).toLocaleString()}）`, '', m.content, '')
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${task.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '对话'}.md`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const chaosUp = Boolean(chaosStatus?.serverUp)
  const chaosReady = chaosUp && (chaosStatus?.catalog || []).some((m) => m.installed)

  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-1">
      {/* 专家 */}
      <div className="relative">
        <DockButton icon="🎭" label="专家中心：切换混沌人格" active={pop === 'expert'} onClick={() => toggle('expert')} />
        {pop === 'expert' && <ExpertPanel onClose={() => setPop('')} />}
      </div>
      {/* 技能 */}
      <div className="relative">
        <DockButton icon="⚡" label="技能库：斜杠快捷指令" active={pop === 'skills'} onClick={() => toggle('skills')} />
        {pop === 'skills' && (
          <SkillPanel
            onClose={() => setPop('')}
            onPick={(s) => {
              setDraft(`${s.template.replace('{text}', draft.trim() || '（在这里填内容）')}\n`)
              setPop('')
              inputRef.current?.focus()
            }}
          />
        )}
      </div>
      {/* 魔法棒 */}
      <DockButton icon={wandBusy ? '⏳' : '🪄'} label="提示词魔法棒：口语 → 结构化提示词" onClick={magicWand} />
      {/* 擂台 */}
      <div className="relative">
        <DockButton icon="🥊" label="模型擂台：两个混沌模型同题对决" active={pop === 'arena'} onClick={() => toggle('arena')} />
        {pop === 'arena' && <ArenaPanel draft={draft} onClose={() => setPop('')} />}
      </div>
      {/* 记忆 */}
      <div className="relative">
        <DockButton icon="🧠" label="长期记忆：让混沌记住你的偏好" active={pop === 'memory'} onClick={() => toggle('memory')} />
        {pop === 'memory' && <MemoryPanel onClose={() => setPop('')} />}
      </div>
      {/* 自动化 */}
      <div className="relative">
        <DockButton icon="⏰" label="定时自动化：到点自动开跑" active={pop === 'auto'} onClick={() => toggle('auto')} />
        {pop === 'auto' && <AutomationsPanel onClose={() => setPop('')} />}
      </div>
      {/* 仪表盘 */}
      <div className="relative">
        <DockButton icon="📊" label="上下文仪表盘" active={pop === 'dash'} onClick={() => toggle('dash')} />
        {pop === 'dash' && <DashboardPanel task={task} messages={messages} events={events} onClose={() => setPop('')} />}
      </div>
      {/* 时光机 */}
      <div className="relative">
        <DockButton icon="⏪" label="时光机：回滚对话" active={pop === 'tm'} onClick={() => toggle('tm')} />
        {pop === 'tm' && <TimeMachinePanel taskId={taskId} onClose={() => setPop('')} />}
      </div>
      {/* 钉住 */}
      <div className="relative">
        <DockButton icon="📌" label="钉住的重要回答" active={pop === 'pins'} onClick={() => toggle('pins')} />
        {pop === 'pins' && <PinsPanel taskId={taskId} onClose={() => setPop('')} />}
      </div>
      {/* 分支 */}
      <DockButton icon="🌿" label="对话分支：岔出一条新路线" onClick={() => branchTask(taskId)} />
      {/* 导出 */}
      <DockButton icon="⬇" label="导出为 Markdown" onClick={exportMd} />
      {/* 速答 */}
      <DockButton icon="🚀" label="速答浮层：一问一答不留记录" onClick={() => toggleQuick(true)} />
      {/* 纸质模式 */}
      <DockButton icon="📖" label="纸质书阅读模式" active={paperMode} onClick={togglePaperMode} />
      {/* 禅模式 */}
      <DockButton icon="⛶" label="禅模式：全屏专注对话" onClick={toggleZenMode} />
      {/* 老板键 */}
      <DockButton icon="🐟" label="老板键：一键伪装成工作界面" onClick={toggleBossMode} />

      {wandBusy && <span className="text-[10px] text-slate-500">魔法棒改写中…</span>}
      {!chaosReady && (
        <span className="text-[10px] text-amber-300/80" title={chaosUp ? '还没有已安装的混沌模型' : '混沌服务未启动'}>
          混沌未就绪，部分功能不可用
        </span>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 速答浮层（WorkBuddy 式全局唤起的小窗问法）
 * ------------------------------------------------------------------ */

export function QuickOverlay({ onClose }) {
  const [text, setText] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const ask = async () => {
    const q = text.trim()
    if (!q || busy) return
    setBusy(true)
    setAnswer('')
    try {
      const r = await useStore.getState().chaosQuick(q)
      setAnswer(r.text)
    } catch (err) {
      setAnswer(`⚠️ ${err.message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-[34rem] max-w-[92vw] overflow-hidden rounded-2xl border border-ink-400 bg-ink-800 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-ink-600 px-4 py-2.5">
          <span className="text-[14px]">🌀</span>
          <span className="text-[12.5px] font-semibold text-slate-100">混沌速答</span>
          <span className="text-[10px] text-slate-500">本地 · 免费 · 不留记录</span>
          <button className="ml-auto text-[11px] text-slate-500 hover:text-slate-200" onClick={onClose}>
            Esc 关闭
          </button>
        </div>
        <div className="p-3">
          <div className="flex gap-2">
            <input
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') ask()
                if (e.key === 'Escape') onClose()
              }}
              placeholder="随便问一句，回车即答…"
              className="field min-w-0 flex-1"
            />
            <button className="btn-primary px-3 text-[12px]" disabled={!text.trim() || busy} onClick={ask}>
              {busy ? '思考中…' : '问'}
            </button>
          </div>
          {(answer || busy) && (
            <div className="mt-3 max-h-[40vh] overflow-y-auto rounded-xl bg-ink-700/60 p-3 text-[12.5px] leading-relaxed text-slate-100 whitespace-pre-wrap break-words">
              {busy ? '🌀 混沌正在本地思考…' : answer}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* 导出 matchSkill 供 ChatPanel 的斜杠菜单复用 */
export { matchSkill }
