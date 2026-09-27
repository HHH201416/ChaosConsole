/** 看板列定义 —— 顺序即列顺序 */
export const COLUMNS = [
  {
    key: 'backlog',
    label: '待处理',
    en: 'Backlog',
    dot: 'bg-slate-500',
    text: 'text-slate-400',
    ring: 'border-slate-600/60',
    glow: '',
    bar: 'bg-slate-600',
  },
  {
    key: 'in_progress',
    label: '进行中',
    en: 'In Progress',
    dot: 'bg-sky-400',
    text: 'text-sky-400',
    ring: 'border-sky-500/40',
    glow: 'shadow-[0_0_0_1px_rgba(56,189,248,0.15)]',
    bar: 'bg-sky-500',
  },
  {
    key: 'needs_input',
    label: '需要输入',
    en: 'Needs Input',
    dot: 'bg-boss',
    text: 'text-boss',
    ring: 'border-boss/40',
    glow: 'shadow-[0_0_0_1px_rgba(245,165,36,0.15)]',
    bar: 'bg-boss',
  },
  {
    key: 'complete',
    label: '已完成',
    en: 'Complete',
    dot: 'bg-emerald-500',
    text: 'text-emerald-400',
    ring: 'border-emerald-600/40',
    glow: '',
    bar: 'bg-emerald-600',
  },
]

export const COLUMN_MAP = Object.fromEntries(COLUMNS.map((c) => [c.key, c]))

/** 运行状态展示 */
export const RUN_STATE_META = {
  idle: { label: '空闲', cls: 'text-slate-400' },
  queued: { label: '排队中', cls: 'text-sky-400' },
  running: { label: '执行中', cls: 'text-sky-400' },
  waiting: { label: '等待回复', cls: 'text-boss' },
  done: { label: '已结束', cls: 'text-emerald-400' },
  cancelled: { label: '已取消', cls: 'text-slate-500' },
  error: { label: '出错', cls: 'text-rose-400' },
}

export const AGENT_STATUS_META = {
  idle: { label: '空闲', dot: 'bg-emerald-500', text: 'text-emerald-400' },
  working: { label: '工作中', dot: 'bg-sky-400', text: 'text-sky-400' },
}

/** 事件类型 -> 左侧色条与图标 */
export const EVENT_META = {
  system: { icon: '◆', cls: 'text-slate-400', bar: 'bg-slate-600' },
  status: { icon: '▸', cls: 'text-slate-300', bar: 'bg-slate-500' },
  tool_use: { icon: '⚙', cls: 'text-sky-300', bar: 'bg-sky-500' },
  tool_result: { icon: '←', cls: 'text-slate-400', bar: 'bg-slate-600' },
  tool_error: { icon: '✕', cls: 'text-rose-400', bar: 'bg-rose-600' },
  thinking: { icon: '…', cls: 'text-violet-300', bar: 'bg-violet-600' },
  success: { icon: '✓', cls: 'text-emerald-400', bar: 'bg-emerald-600' },
  error: { icon: '!', cls: 'text-rose-400', bar: 'bg-rose-600' },
  raw: { icon: '·', cls: 'text-slate-500', bar: 'bg-slate-700' },
  info: { icon: 'i', cls: 'text-slate-400', bar: 'bg-slate-600' },
}

export const ROLE_PRESETS = [
  'Coder',
  'Architect',
  'Designer',
  'Tester',
  'Researcher',
  'DevOps',
  'Analyst',
  'Writer',
  'Security',
  'PM',
  'Chat',
]

export const ROLE_COLORS = {
  Coder: 'bg-sky-500/15 text-sky-300',
  Architect: 'bg-indigo-500/15 text-indigo-300',
  Designer: 'bg-pink-500/15 text-pink-300',
  Tester: 'bg-lime-500/15 text-lime-300',
  Researcher: 'bg-violet-500/15 text-violet-300',
  DevOps: 'bg-orange-500/15 text-orange-300',
  Analyst: 'bg-teal-500/15 text-teal-300',
  Writer: 'bg-amber-500/15 text-amber-300',
  Security: 'bg-rose-500/15 text-rose-300',
  PM: 'bg-cyan-500/15 text-cyan-300',
  Chat: 'bg-fuchsia-500/15 text-fuchsia-300',
}

export function roleColor(role) {
  return ROLE_COLORS[role] || 'bg-slate-500/15 text-slate-300'
}

const pad = (n) => String(n).padStart(2, '0')

export function formatTime(ts) {
  if (!ts) return '—'
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function formatClock(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export function relativeTime(ts) {
  if (!ts) return ''
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  return `${Math.floor(diff / 86_400_000)} 天前`
}

/** 字节数格式化。更新进度里直接摆 90951519 这种数字没人看得懂 */
export function fmtBytes(n) {
  const v = Number(n)
  if (!Number.isFinite(v) || v <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let x = v
  let i = 0
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024
    i += 1
  }
  return `${i > 0 && x < 10 ? x.toFixed(1) : Math.round(x)} ${units[i]}`
}
