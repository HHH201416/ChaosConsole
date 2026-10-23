/**
 * 8.0.2：混沌技能库 —— WorkBuddy 式「技能 / 快捷指令」。
 *
 * 每个技能 = 一条斜杠命令 + 一个提示词模板（{text} 会替换成用户输入）。
 * 纯前端模板，选中即填进输入框，由混沌本地执行，零成本、可自定义扩展
 * （往 SKILLS 里加一行就是一个新技能）。
 */

export const SKILLS = [
  {
    cmd: '/翻译',
    label: '中英互译',
    icon: '🌐',
    template: '请把下面的内容翻译成{目标语言:中文}，保留专有名词与格式，译文要自然地道：\n\n{text}',
  },
  {
    cmd: '/总结',
    label: '长文总结',
    icon: '📝',
    template: '请把下面的内容总结成：①一句话结论 ②3~5 个要点 ③待办清单（如有）。用中文：\n\n{text}',
  },
  {
    cmd: '/代码审查',
    label: '代码审查',
    icon: '🔍',
    template:
      '请以资深工程师视角审查下面的代码，按「正确性 / 边界情况 / 性能 / 安全 / 可读性」分别指出问题并给出修复建议：\n\n{text}',
  },
  {
    cmd: '/周报',
    label: '生成本周周报',
    icon: '📊',
    template: '请根据下面的工作记录生成一份周报：分「本周成果 / 数据亮点 / 下周计划」三段，语气务实，不夸大：\n\n{text}',
  },
  {
    cmd: '/头脑风暴',
    label: '头脑风暴',
    icon: '💡',
    template: '请围绕下面的主题做头脑风暴：给 10 个点子，先列一句话版本，再挑最有戏的 3 个展开说：\n\n{text}',
  },
  {
    cmd: '/正反方',
    label: '利弊分析',
    icon: '⚖️',
    template: '请就下面的决策分别列出支持方与反对方最有力的 3 个论据，最后给出你的倾向和理由：\n\n{text}',
  },
  {
    cmd: '/五岁小孩',
    label: '讲给外行听',
    icon: '🧸',
    template: '请把下面的概念讲给一个完全没接触过的人听：用生活里的比喻，不超过 300 字，不用术语：\n\n{text}',
  },
  {
    cmd: '/润色',
    label: '文案润色',
    icon: '✒️',
    template: '请润色下面的文字：保持原意，让表达更清晰有力，改完用一句话说明你主要改了什么：\n\n{text}',
  },
  {
    cmd: '/计划',
    label: '制定计划',
    icon: '🗺️',
    template: '请帮我把下面的目标拆成可执行计划：按周分阶段，每阶段列具体动作与验收标准，标出最大风险：\n\n{text}',
  },
  {
    cmd: '/改名',
    label: '起名大师',
    icon: '🏷️',
    template: '请为下面的产品/项目/变量起 10 个名字：分「正经可用 / 脑洞大开」两组，每个附一句理由：\n\n{text}',
  },
]

/** 解析草稿里的斜杠命令：返回 { skill, rest } 或 null */
export function matchSkill(draft) {
  const text = String(draft || '')
  const m = text.match(/^\/([^\s]*)/)
  if (!m) return null
  const q = m[1]
  // 输入到一半的命令（比如 /代）给过滤提示；带空格了说明命令已敲完，不再提示
  const candidates = SKILLS.filter((s) => s.cmd.slice(1).startsWith(q) || s.label.includes(q))
  if (!candidates.length) return null
  return { query: q, candidates, rest: text.slice(m[0].length) }
}
