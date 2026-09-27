'use strict'

/**
 * 任务队列。
 *
 * 规则：
 *  - 任务进入 in_progress 时，若尚未指派 Agent，后端自动挑一个空闲的顶上。
 *  - 挑选策略：先按标签/标题里的关键词匹配角色，匹配不上就取最早入职的空闲员工。
 *  - 同一时刻一个 Agent 只跑一个任务；一个任务也只会有一个在跑的回合。
 *  - 回合结束后按结果落位：成功 → complete；提问 → needs_input；出错 → needs_input（带错误）；
 *    被取消 → 退回 backlog。
 *  - 运行期间用户发来的补充指令会排队，当前回合结束后自动续跑（--resume 同一会话）。
 */

const store = require('./store')
const runner = require('./runner')
const CONFIG = require('./config')
const pipeline = require('./pipeline')
const { DEFAULT_AGENTS } = require('./seed')

/** taskId -> string[] 待发送的补充指令 */
const pendingInputs = new Map()

/**
 * 正在跑回合的 taskId（同步登记，用来堵住 runner.isRunning 之前的空窗期，
 * 见 runTurn 里的说明）。
 */
const activeTurns = new Set()

/**
 * 职能关键词画像：用来把一句需求路由给最合适的 Agent。
 * 命中越多分越高。对话页的自动派单和看板的自动派单共用这一份。
 */
const FUNCTION_KEYWORDS = {
  Coder: ['代码', '实现', '重构', '开发', '函数', '组件', 'bug', '修复', '接口', '报错', '编译', 'code', 'api', '前端', '后端'],
  Architect: ['架构', '设计模式', '拆分', '技术方案', '扩展性', '性能', '选型', '模块', '解耦'],
  Designer: ['设计', 'ui', 'ux', '界面', '配色', '布局', '交互', '视觉', '样式', 'css', '好看', '美观'],
  Tester: ['测试', '用例', '覆盖', '回归', 'test', 'qa', '断言', '复现', '验证'],
  Researcher: ['调研', '研究', '对比', '检索', '资料', 'search', '调查', '查一下', '最新', '怎么样'],
  DevOps: ['部署', '打包', '发布', 'ci', 'cd', '构建', '运维', 'docker', 'build', 'release', '安装包', '流水线'],
  Analyst: ['数据', '分析', '统计', '指标', '报表', '图表', 'metric', '趋势'],
  Writer: ['文档', 'readme', '说明', '写作', '手册', '注释', 'doc', '教程', '介绍'],
  Security: ['安全', '漏洞', '审计', '权限', '加密', '攻击', 'security', '注入', '越权'],
  PM: ['需求', '排期', '计划', '拆解', '管理', '协调', '项目', '优先级', '里程碑'],
  /* 日常闲聊/杂事。关键词一律避开「写」「做」这种会误伤的泛用词，
     也别用 hi / ok 这类短英文 —— 关键词是子串匹配，会命中 this / which。 */
  Chat: [
    '闲聊', '聊天', '聊聊', '随便聊', '你好', '您好', '在吗', 'hello',
    '翻译', '写邮件', '写文案', '取名', '起名', '起个名', '出主意', '拿主意',
    '科普', '是什么意思', '怎么理解', '建议一下',
  ],
  /* DevEco 那 10 位。关键词一律带鸿蒙限定，别用「界面」「布局」「构建」这种
     泛用词 —— 否则会把本该给 Claude 岗位的活抢过来。 */
  HarmonyOS: ['鸿蒙', 'harmonyos', 'arkts', 'deveco', 'ohos', '华为'],
  HarmonyUI: ['arkui', '鸿蒙界面', '鸿蒙布局', '声明式ui', '声明式 ui', '@state', '@prop', '@link', '鸿蒙动效', '鸿蒙适配'],
  HarmonyAtomic: ['元服务', '服务卡片', '万能卡片', '免安装', '原子化', '卡片刷新', 'form'],
  HarmonyArchitect: ['鸿蒙架构', '鸿蒙工程', 'har', 'hsp', 'ohpm', '多目标构建', 'build-profile', '鸿蒙模块'],
  HarmonyTester: ['hypium', '鸿蒙测试', '鸿蒙用例', '鸿蒙回归', '鸿蒙验证'],
  HarmonyBuild: ['hvigor', '鸿蒙打包', '鸿蒙构建', '鸿蒙签名', 'appgallery', 'p7b', 'p12', '鸿蒙上架'],
  HarmonyDistributed: ['分布式', '流转', '软总线', '跨设备', '设备发现', '接续', '多端协同'],
  HarmonyData: ['preferences', 'rdb', 'kvstore', '鸿蒙数据', '分布式数据', '首选项'],
  HarmonyPerf: ['鸿蒙性能', '启动优化', '帧率', '丢帧', '功耗', 'profiler', '鸿蒙内存'],
  HarmonySecurity: ['鸿蒙权限', '隐私合规', '个人信息保护', '动态授权', '鸿蒙安全', '上架审核'],
}

function scoreAgent(agent, task) {
  const haystack = `${task.title} ${task.description} ${(task.tags || []).join(' ')}`.toLowerCase()
  const words = FUNCTION_KEYWORDS[agent.role] || []
  let score = 0
  for (const w of words) {
    if (haystack.includes(w.toLowerCase())) score += 2
  }
  // 职能名本身命中时权重更高（用户直接说「文档」「测试」这种）
  if (agent.functionLabel && haystack.includes(agent.functionLabel.toLowerCase())) score += 4
  return score
}

/**
 * 这个 Agent 是不是正忙着别的任务。
 *
 * 判据用 runState 而不是 tasks.status：needs_input 的任务虽然还算「在它名下」，
 * 但回合早就结束了，Agent 应该已经空闲下来。
 */
function agentIsBusy(agentId, exceptTaskId) {
  if (!agentId) return false
  return store
    .listTasks()
    .some(
      (t) =>
        t.agentId === agentId &&
        t.id !== exceptTaskId &&
        (t.runState === 'running' || t.runState === 'queued'),
    )
}

/** 一个关键词都没命中时，交给这个岗位兜底（见 pickIdleAgent） */
const FALLBACK_ROLE = 'Chat'

/** 挑一个空闲 Agent；没有空闲的返回 null */
function pickIdleAgent(task) {
  const agents = store.listAgents()
  const idle = agents.filter((a) => a.status === 'idle')
  if (!idle.length) return null

  let best = null
  let bestScore = -1
  for (const a of idle) {
    const s = scoreAgent(a, task)
    if (s > bestScore) {
      bestScore = s
      best = a
    }
  }
  // 谁都匹配不上：交给「日常对话」兜底。
  // 以前这种任务会按并列最低分落到「代码实现」（最早入职的那位）头上，
  // 结果闲聊和没头绪的杂事全被当成开发任务派下去。
  // 库里没有这个岗位（用户删了）就退回原来的行为。
  if (bestScore <= 0) {
    const chat = idle.find((a) => a.role === FALLBACK_ROLE)
    if (chat) return chat
  }
  return best
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

function looksLikeQuestion(text) {
  const t = String(text || '').trim()
  if (!t) return false
  const tail = t.slice(-160)
  if (/[?？]\s*["'）)】]*\s*$/.test(tail)) return true
  return /(请提供|需要你|请确认|需要确认|请告知|请选择|等待你|麻烦确认|无法继续|缺少)/.test(tail)
}

function lastAssistantText(taskId) {
  const msgs = store.listMessages(taskId)
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') return msgs[i].content
  }
  return ''
}

/**
 * 跑一个回合。task 必须已经处于 in_progress 且绑定了 agent。
 */
async function runTurn(taskId, { extraInstruction = '', handoffBrief = '' } = {}) {
  const task = store.getTask(taskId)
  if (!task) return
  if (runner.isRunning(taskId)) return
  // runner.isRunning 只在 runner.execute 真正拉起进程之后才为真，而 deveco 那条路
  // 在拉进程之前还要 await 一次模型列表（冷启动时好几秒）。光靠它挡不住
  // 「这段空窗期内又来一次 runTurn」，会变成同一个任务跑两个回合。
  // activeTurns 是同步打上的标记，专门用来补这个空窗。
  if (activeTurns.has(taskId)) return
  activeTurns.add(taskId)

  // 整个回合体都包在 try/finally 里：中间任何一条提前 return（比如任务没有
  // 可用的 Agent）都必须把标记撤掉，否则这个任务会被永久锁住，再也跑不起来。
  try {
    const agent = store.getAgent(task.agentId)
    if (!agent) {
      store.updateTask(taskId, { runState: 'error', error: '没有可用的 Agent' })
      store.addEvent(taskId, { type: 'error', name: '派单失败', content: '任务没有绑定 Agent，且当前没有空闲员工。' })
      return
    }

    store.updateTask(taskId, { runState: 'running', status: 'in_progress', error: '' })
    store.updateAgent(agent.id, { status: 'working' })
    // 事件里也只写「是干什么的」，跟界面保持一致，不暴露姓名
    const who = agent.functionLabel || agent.role
    store.addEvent(taskId, {
      type: 'status',
      name: handoffBrief ? '接手' : extraInstruction ? '续跑' : '开始执行',
      content: handoffBrief
        ? `「${who}」接手交接（${agent.executor}），工作目录 ${task.cwd}`
        : extraInstruction
          ? `向「${who}」发送补充指令`
          : `「${who}」接手任务（${agent.executor}），工作目录 ${task.cwd}`,
    })

    let result
    try {
      result = await runner.execute({
        task: store.getTask(taskId),
        agent,
        extraInstruction,
        handoffBrief,
        // 交接自带背景说明，不需要也不应该续旧会话（旧会话是上一位的上下文，
        // 而且新岗位的人设只在首轮注入）
        resumeSessionId:
          extraInstruction && !handoffBrief ? store.getTask(taskId).sessionId : null,
      })
    } catch (err) {
      result = { ok: false, error: err.message || String(err) }
    }

    // settle 里可能会通过 drainPending 立刻派下一个回合，所以要等 settle 跑完
    // 再撤掉标记，否则中间那一瞬间又会被放进来。
    return settle(taskId, result)
  } finally {
    activeTurns.delete(taskId)
  }
}

function settle(taskId, result) {
  const task = store.getTask(taskId)
  if (!task) return

  // 用户可能在这一回合还没跑完时就手动把卡片拖走 / 标记完成 / 取消了，
  // 那些操作会立刻改写 status 和 runState。此时这一回合的结果已经过期：
  // 再按结果落位就会把卡片从用户放的位置拽回去（看起来像卡片「自己跳回原列」）。
  // runTurn 开始时把状态设成 in_progress + running，所以只要这两个值还保持着，
  // 就说明这一回合仍然是最新的那个。
  if (task.status !== 'in_progress' || task.runState !== 'running') {
    pendingInputs.delete(taskId)
    pendingHandoff.delete(taskId)
    store.releaseAgentIfIdle(task.agentId)
    return
  }

  if (result.sessionId) store.updateTask(taskId, { sessionId: result.sessionId })

  // ---- 换岗：优先于所有落位 ------------------------------------------
  //
  // 三种来源在这里汇合：用户手动换岗（pendingHandoff，且 runner 带着 handoff
  // 意图结束）、agent 主动请求（result.directive）、阶段推进（同一个 directive）。
  const handoffReq = pendingHandoff.get(taskId) || null
  pendingHandoff.delete(taskId)
  // 用户主动取消优先于 agent 的换岗请求：人都喊停了就别再自动往下交接
  const userCancelled = Boolean(result.cancelled) && !result.handoff
  const req = handoffReq || (userCancelled ? null : directiveToRequest(taskId, result.directive))
  if (req || result.handoff) {
    const applied = applyHandoff(taskId, req || { source: 'user', reason: '换岗' })
    if (applied.ok) return
    // 换岗没成功（目标在忙、岗位不存在、阶段不合法）：记一条事件就好，
    // 继续按下面的正常规则落位，绝不让任务悬在半空
    store.addEvent(taskId, { type: 'error', name: '换岗未执行', content: applied.error })
  }

  // ---- 被取消 -------------------------------------------------------
  if (result.cancelled) {
    pendingInputs.delete(taskId)
    store.updateTask(taskId, { status: 'backlog', runState: 'cancelled' })
    store.addEvent(taskId, { type: 'status', name: '已取消', content: '任务已退回「待处理」。' })
    store.releaseAgentIfIdle(task.agentId)
    return
  }

  // ---- 出错 / 超时 ---------------------------------------------------
  if (!result.ok) {
    // 先让自动换岗决定要不要接手（不限次数 + 四道护栏，见 maybeAutoRetry）
    if (maybeAutoRetry(taskId, result)) return
    const msg = result.error || '执行失败'
    store.updateTask(taskId, { status: 'needs_input', runState: 'error', error: msg })
    store.releaseAgentIfIdle(task.agentId)
    drainPending(taskId)
    return
  }

  // ---- 成功 ---------------------------------------------------------
  store.updateTask(taskId, { result: result.resultText || '' })

  // 有排队的补充指令 → 继续跑，不落位
  if (drainPending(taskId)) return

  const finalText = result.resultText || lastAssistantText(taskId)
  if (looksLikeQuestion(finalText)) {
    store.updateTask(taskId, { status: 'needs_input', runState: 'waiting' })
    store.addEvent(taskId, { type: 'status', name: '等待输入', content: 'Agent 提出了问题，等待老板回复。' })
    store.releaseAgentIfIdle(task.agentId)
  } else {
    store.updateTask(taskId, { status: 'complete', runState: 'done' })
    store.addEvent(taskId, { type: 'status', name: '已完成', content: '任务已完成并移入「已完成」。' })
    store.releaseAgentIfIdle(task.agentId)
  }
}

/** 若该任务有排队的补充指令，取出全部并发起下一回合；返回是否真的续跑了 */
function drainPending(taskId) {
  const queue = pendingInputs.get(taskId)
  if (!queue || !queue.length) return false
  const merged = queue.join('\n\n')
  pendingInputs.delete(taskId)

  const task = store.getTask(taskId)
  if (!task || task.status === 'complete') return false
  if (!task.agentId || !store.getAgent(task.agentId)) return false

  // 异步发起，避免在 settle 里递归 await
  setImmediate(() => {
    runTurn(taskId, { extraInstruction: merged }).catch((err) => {
      console.error('[queue] 续跑失败:', err.message)
    })
  })
  return true
}

/* ------------------------------------------------------------------ *
 * 换岗（交接）
 *
 * 四种触发共用这一套：
 *   - 用户手动换岗        source='user'
 *   - agent 自己请求      source='agent'（输出里的 CHAOS_HANDOFF / MCP 工具）
 *   - 阶段推进            source='stage'（输出里的 CHAOS_STAGE）
 *   - 失败/超时自动换岗    source='failure'
 *
 * 一个关键区别：**运行中换岗会把当前进程掐掉**（runner.cancel 带 handoff 意图），
 * 但 settle 会先看到意图，因此它不会被当成「用户取消」落进 backlog，
 * 排队的补充指令也不会被丢掉 —— 而是折进交接说明交给下一位。
 * ------------------------------------------------------------------ */

/** taskId -> 待执行的换岗请求（进程还没退干净，等 settle 消费） */
const pendingHandoff = new Map()
/** taskId -> 退避定时器（失败自动换岗用） */
const retryTimers = new Map()
/** taskId -> [{stage, role, agentId, at}]：本任务在某阶段试过谁（护栏 1 的判据） */
const runHistory = new Map()

const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60000
const BRIEF_MAX_CHARS = 4000
const HISTORY_MAX = 30

function pipelineEnabled() {
  return store.getSetting('pipelineEnabled', '1') === '1'
}

function seedFor(agent) {
  return DEFAULT_AGENTS.find((a) => a.role === (agent && agent.role)) || null
}

function stagesFor(task, agent) {
  return pipeline.resolve(task, agent, pipelineEnabled(), seedFor(agent))
}

function currentStageOf(task, stages) {
  return task.stage || (stages[0] && stages[0].stage) || ''
}

function historyOf(taskId) {
  return runHistory.get(taskId) || []
}

function rememberTry(taskId, entry) {
  const list = historyOf(taskId)
  list.push(entry)
  while (list.length > HISTORY_MAX) list.shift()
  runHistory.set(taskId, list)
}

function stopRetry(taskId) {
  const timer = retryTimers.get(taskId)
  if (timer) {
    clearTimeout(timer)
    retryTimers.delete(taskId)
  }
}

/** 任务离开「进行中」时把这一轮换岗/重试的临时状态清干净 */
function clearHandoffState(taskId) {
  pendingHandoff.delete(taskId)
  stopRetry(taskId)
  runHistory.delete(taskId)
}

/**
 * 挑接手的人。
 * exclude 里的岗位不会被选中 —— 自动换岗靠它保证「同一个岗位不在同一阶段连续撞两次」，
 * 这也是「不限次数重试」能终止的原因。
 */
function pickAgentForStage(task, role, { exclude = new Set() } = {}) {
  const idle = store.listAgents().filter((a) => a.status === 'idle' && !exclude.has(a.id))
  if (!idle.length) return null
  if (role) {
    const exact = idle.find((a) => a.role === role)
    if (exact) return exact
  }
  // 同执行器优先：跨执行器交接等于换工具链、换会话，代价更大
  const prev = task.agentId ? store.getAgent(task.agentId) : null
  if (prev) {
    const sameExec = idle.find((a) => a.executor === prev.executor)
    if (sameExec) return sameExec
  }
  // 退回到既有的「按内容打分」挑选（在 exclude 之后挑，规则与 pickIdleAgent 一致）
  let best = null
  let bestScore = -1
  for (const a of idle) {
    const s = scoreAgent(a, task)
    if (s > bestScore) {
      bestScore = s
      best = a
    }
  }
  if (bestScore <= 0) {
    const chat = idle.find((a) => a.role === FALLBACK_ROLE)
    if (chat) return chat
  }
  return best
}

const clipText = (s, n) => {
  const t = String(s || '').trim()
  return t.length > n ? `${t.slice(0, n)}…` : t
}

/**
 * 交接说明。**不依赖 CLI 会话** —— 会话在换人（尤其跨执行器）之后本来就不可移植，
 * 所以这里只从库里取事实：任务原文 + 最近几条消息 + 上一位的遗留说明 + 排队指令。
 */
function composeBrief(task, { from, to, reason, queued = [], stages = [], stage = '', note = '' }) {
  const fromLabel = from ? from.functionLabel || from.role : '（无人）'
  const toLabel = to ? to.functionLabel || to.role : '（新岗位）'
  const parts = [
    '# 交接说明',
    `你接手了任务「${task.title}」。上一位负责人「${fromLabel}」因为「${reason || '需要换人'}」把任务交给你（现在是「${toLabel}」）。`,
    '',
    '## 任务原始需求',
    clipText(task.description || '(原始需求为空，按标题理解)', 1200),
  ]

  const stagesText = pipeline.describe(stages)
  if (stagesText) {
    parts.push('', '## 当前阶段', `${pipeline.labelOf(stage)}（流程：${stagesText}）`)
  }

  const msgs = store.listMessages(task.id).slice(-6)
  if (msgs.length) {
    parts.push('', '## 最近进展')
    for (const m of msgs) {
      const who = m.role === 'user' ? '老板' : m.role === 'assistant' ? '上一位' : '系统'
      parts.push(`- ${who}：${clipText(m.content, 300)}`)
    }
  }

  // 交接说明优先用上一位**自己写的**（文本指令里的 summary / MCP 工具的 summary），
  // 它比「错误信息」准确得多：错误可能只是环境问题，而 summary 说的是做到哪了。
  const leftover = note || task.error || task.handoffNote || ''
  if (leftover) parts.push('', '## 遗留问题 / 上一位的说明', clipText(leftover, 600))

  if (queued.length) {
    parts.push('', '## 老板的补充指令（尚未处理）', clipText(queued.join('\n'), 600))
  }

  parts.push('', '## 工作目录', task.cwd || CONFIG.DEFAULT_CWD)
  parts.push('', '请接着往下做，不要重复已完成的部分。')
  return clipText(parts.join('\n'), BRIEF_MAX_CHARS)
}

/** 指令 -> 换岗请求。非法指令只记事件，绝不打断任务 */
function directiveToRequest(taskId, directive) {
  if (!directive) return null
  if (directive.parseError) {
    store.addEvent(taskId, { type: 'error', name: '指令无法解析', content: clipText(directive.raw, 600) })
    return null
  }
  const p = directive.payload || {}
  if (directive.kind === 'handoff') {
    if (!p.role) {
      store.addEvent(taskId, { type: 'error', name: '换岗未执行', content: '换岗指令缺少 role。' })
      return null
    }
    return {
      role: String(p.role),
      reason: p.reason || 'Agent 请求交接',
      summary: p.summary || '',
      source: 'agent',
    }
  }
  if (directive.kind === 'stage') {
    if (!p.next) return null // 没有 next = 走完了，正常收官
    return {
      stage: String(p.next),
      reason: p.summary || '阶段推进',
      summary: p.summary || '',
      source: 'stage',
    }
  }
  return null
}

/**
 * 执行一次换岗。所有触发最终都到这里。
 * 失败（目标岗位在忙/不存在/阶段不合法）返回 {ok:false}，由调用方记事件并放行正常落位。
 */
function applyHandoff(taskId, req = {}) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  stopRetry(taskId)

  const prevAgent = task.agentId ? store.getAgent(task.agentId) : null
  const stages = stagesFor(task, prevAgent)
  const fromStage = currentStageOf(task, stages)
  let targetStage = req.stage || fromStage

  // 阶段指令要校验：必须在这条流水线里，而且不许往回退
  if (req.source === 'stage') {
    const idx = pipeline.stageIndex(stages, targetStage)
    const curIdx = pipeline.stageIndex(stages, fromStage)
    if (idx < 0) {
      return { ok: false, error: `阶段「${targetStage}」不在本任务的流水线里（${pipeline.describe(stages)}）` }
    }
    if (curIdx >= 0 && idx <= curIdx) {
      return { ok: false, error: `不能从「${pipeline.labelOf(fromStage)}」退回「${pipeline.labelOf(targetStage)}」` }
    }
  }

  const allRoles = new Set(store.listAgents().map((a) => a.role))
  if (req.role && !allRoles.has(req.role)) {
    return { ok: false, error: `没有「${req.role}」这个岗位` }
  }

  let target = null
  if (req.agentId) {
    const explicit = store.getAgent(req.agentId)
    if (!explicit) return { ok: false, error: '指定的岗位不存在' }
    if (agentIsBusy(explicit.id, taskId)) {
      return { ok: false, error: `「${explicit.functionLabel || explicit.role}」正在忙别的任务` }
    }
    target = explicit
  } else {
    const wantRole = req.role || pipeline.stageRole(stages, targetStage) || (prevAgent && prevAgent.role) || ''
    target = pickAgentForStage(task, wantRole, { exclude: new Set() })
    if (!target) return { ok: false, error: '没有空闲岗位可以接手' }
  }

  const newSession =
    target.id !== task.agentId ||
    Boolean(prevAgent && prevAgent.executor !== target.executor)

  const queued = pendingInputs.get(taskId) || []
  pendingInputs.delete(taskId)

  const reason = req.reason || '换岗'
  const brief = composeBrief(task, {
    from: prevAgent,
    to: target,
    reason,
    queued,
    stages,
    stage: targetStage,
    note: req.summary || '',
  })

  rememberTry(taskId, { stage: targetStage, role: target.role, agentId: task.agentId, at: Date.now() })

  store.updateTask(taskId, {
    agentId: target.id,
    stage: targetStage,
    handoffNote: clipText(brief, 600),
    handoffAt: Date.now(),
    error: '',
    status: 'in_progress',
    runState: 'queued',
    // 换了人或换了执行器就必须开新会话：岗位的 system_prompt 只在会话首轮注入，
    // 沿用旧会话等于新岗位的人设根本没生效
    ...(newSession ? { sessionId: '' } : {}),
  })
  if (prevAgent && prevAgent.id !== target.id) store.releaseAgentIfIdle(prevAgent.id)
  store.updateAgent(target.id, { status: 'working' })

  const fromLabel = prevAgent ? prevAgent.functionLabel || prevAgent.role : '（无人）'
  const toLabel = target.functionLabel || target.role
  store.addEvent(taskId, {
    type: 'status',
    name: '换岗',
    content: `${fromLabel} → ${toLabel} · ${reason}${queued.length ? ` · 带上 ${queued.length} 条排队指令` : ''}`,
  })

  const stageInstruction = newSession
    ? ''
    : `进入「${pipeline.labelOf(targetStage)}」阶段（${reason}）。请接着往下做。`

  setImmediate(() => {
    runTurn(taskId, newSession ? { handoffBrief: brief } : { extraInstruction: stageInstruction }).catch(
      (err) => console.error('[queue] 交接后起跑失败:', err.message),
    )
  })
  return { ok: true, agentId: target.id }
}

/**
 * 对外入口。运行中 → 记下意图并掐掉当前回合（settle 会接手）；
 * 没在跑 → 直接换。
 */
function requestHandoff(taskId, req = {}) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (runner.isRunning(taskId) || activeTurns.has(taskId)) {
    pendingHandoff.set(taskId, req)
    stopRetry(taskId)
    runner.cancel(taskId, 'handoff')
    store.addEvent(taskId, { type: 'status', name: '正在换岗', content: '当前回合结束后交接。' })
    return { ok: true, pending: true }
  }
  return applyHandoff(taskId, req)
}

/**
 * 失败/超时后的自动换岗。返回 true 表示「接管了这次落位」，
 * 调用方就不要再落 needs_input/error 了。
 *
 * 四道护栏（缺一不可，见计划文件）：
 *   1. 同一阶段不重复用同一个岗位（tried 集合）—— 这是「不限次数」能终止的证明
 *   2. 候选耗尽 → 转人工（落 needs_input 并写明试过谁）
 *   3. 指数退避 2s → 60s 上限（限速率，不限次数）
 *   4. 次数可见 + 可停（attempts 落库、POST /retry {enabled:false}）
 */
function maybeAutoRetry(taskId, result) {
  const task = store.getTask(taskId)
  if (!task || !task.autoRetry) return false
  // 找不到 CLI / 起不了进程属于环境故障，换人也没用，别把整个花名册烧一遍
  if (result && result.spawnFailed) return false

  const agent = task.agentId ? store.getAgent(task.agentId) : null
  const stages = stagesFor(task, agent)
  const stage = currentStageOf(task, stages)
  const role = pipeline.stageRole(stages, stage) || (agent && agent.role) || ''

  const attempts = (task.attempts || 0) + 1
  const maxAttempts = Number(store.getSetting('maxAttempts', '0')) || 0

  const tried = new Set(historyOf(taskId).filter((h) => h.stage === stage).map((h) => h.agentId))
  tried.add(task.agentId) // 刚失败的这个也别再上（护栏 1）

  const overBudget = maxAttempts > 0 && attempts > maxAttempts
  const target = overBudget ? null : pickAgentForStage(task, role, { exclude: tried })

  if (!target) {
    const names = [...tried].map((id) => {
      const a = store.getAgent(id)
      return a ? a.functionLabel || a.role : id
    })
    store.updateTask(taskId, {
      attempts,
      status: 'needs_input',
      runState: 'error',
      error: result && result.error ? result.error : '执行失败',
      nextRetryAt: 0,
    })
    store.releaseAgentIfIdle(task.agentId)
    store.addEvent(taskId, {
      type: 'status',
      name: '转人工',
      content: overBudget
        ? `已重试 ${attempts - 1} 次（达到上限 ${maxAttempts}），需要老板介入。`
        : `本阶段可用岗位都已试过${names.length ? `（${names.join('、')}）` : ''}，需要老板介入。`,
    })
    return true
  }

  const delay = Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS)
  store.updateTask(taskId, {
    agentId: target.id,
    attempts,
    status: 'in_progress',
    // 退避期间保持 queued：dispatch 只跳过 running/queued 的任务，
    // 这样它不会把退避中的任务抢跑（也就不会变成自激循环）
    runState: 'queued',
    nextRetryAt: Date.now() + delay,
    error: result && result.error ? result.error : '执行失败',
  })
  store.releaseAgentIfIdle(task.agentId)
  store.updateAgent(target.id, { status: 'working' })
  rememberTry(taskId, { stage, role: target.role, agentId: task.agentId, at: Date.now() })

  store.addEvent(taskId, {
    type: 'status',
    name: '自动换岗',
    content: `${result && result.timedOut ? '执行超时' : '执行失败'} → 交给「${
      target.functionLabel || target.role
    }」，${Math.round(delay / 1000)} 秒后重试（第 ${attempts} 次）`,
  })

  stopRetry(taskId)
  retryTimers.set(
    taskId,
    setTimeout(() => {
      retryTimers.delete(taskId)
      const fresh = store.getTask(taskId)
      if (!fresh || fresh.status !== 'in_progress') return // 期间被取消/拖走/完成了
      store.updateTask(taskId, { nextRetryAt: 0 })
      const started = startTask(taskId, { quiet: true })
      if (started && started.ok === false) {
        // 没空闲岗位：退回 idle，让既有的 dispatch 在有人空出来时接手（与例 7 同一条路）
        store.updateTask(taskId, { runState: 'idle' })
      }
    }, delay),
  )
  return true
}

/** 停止/恢复自动重试（界面上的「停止重试」） */
function setAutoRetry(taskId, enabled) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (enabled) {
    store.updateTask(taskId, { autoRetry: true })
    return { ok: true }
  }
  const wasBackoff = retryTimers.has(taskId)
  stopRetry(taskId)
  store.updateTask(taskId, { autoRetry: false, nextRetryAt: 0 })
  if (wasBackoff && !runner.isRunning(taskId)) {
    store.updateTask(taskId, { status: 'needs_input', runState: 'waiting' })
    store.addEvent(taskId, { type: 'status', name: '已停止自动重试', content: '任务停在「需要输入」，等老板处理。' })
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * 对外操作
 * ------------------------------------------------------------------ */

/** 开始 / 继续一个任务 */
function startTask(taskId, { quiet = false } = {}) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (runner.isRunning(taskId)) return { ok: false, error: '任务已在执行中' }
  // 手动起跑优先于还在退避里的自动重试。注意只停定时器、
  // **不清 runHistory** —— 那张表是「本阶段试过谁」的记忆，清了护栏 1 就失效了。
  stopRetry(taskId)

  let agentId = task.agentId
  const boundAgent = agentId ? store.getAgent(agentId) : null
  // 两种情况下要换人：绑定的员工已经不存在，或者它正在忙别的任务。
  // 「同一个员工同一时刻只干一个任务」是 queue 的既定约束（见文件头），
  // 由这里守住 —— 否则对话页收到一条正好命中某个忙碌员工的消息时，
  // 会在同一个人身上并发跑起两个 CLI。
  if (!boundAgent || agentIsBusy(agentId, taskId)) {
    const agent = pickIdleAgent(task)
    if (!agent) {
      // dispatch 会自动重试，别让它每次都往事件流里写一条同样的抱怨
      if (!quiet) {
        store.addEvent(taskId, { type: 'error', name: '无空闲员工', content: '所有员工都在忙，请稍后再试。' })
      }
      return { ok: false, error: '没有空闲员工' }
    }
    agentId = agent.id
    store.updateTask(taskId, { agentId })
  }

  // 起跑时把「实际要走的流水线」快照到任务上，并把阶段定位到第一站。
  //
  // 为什么要快照：默认链是按岗位/执行器现算的，不落库的话前端根本看不到 ——
  // 卡片上的阶段徽章、换岗弹窗里的阶段选择都需要这条链。
  // 只写这**一个**任务的字段，不动岗位与 seed 的默认值（那条规则见 pipeline.js）。
  // 「谁先上」不受影响：第一个人仍然按任务内容打分决定。
  const fresh = store.getTask(taskId)
  const resolved = stagesFor(fresh, store.getAgent(agentId))
  const snapshot = {}
  if (resolved.length && !(fresh.pipeline && fresh.pipeline.length)) snapshot.pipeline = resolved
  if (resolved.length && !fresh.stage) snapshot.stage = resolved[0].stage

  store.updateTask(taskId, { status: 'in_progress', runState: 'queued', ...snapshot })
  store.updateAgent(agentId, { status: 'working' })

  setImmediate(() => {
    runTurn(taskId).catch((err) => {
      console.error('[queue] 执行失败:', err.message)
      store.updateTask(taskId, { status: 'needs_input', runState: 'error', error: err.message })
      store.releaseAgentIfIdle(agentId)
    })
  })

  return { ok: true }
}

/** 发送补充指令：运行中排队，空闲则立刻续跑 */
function sendInput(taskId, text) {
  const content = String(text || '').trim()
  if (!content) return { ok: false, error: '内容为空' }

  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }

  store.addMessage(taskId, 'user', content)

  // 退避等待中 / 换岗交接中也算「忙」：这时候直接起跑会撞上 activeTurns 的空窗，
  // 指令会永远留在消息里没被送达。排进队列，由下一回合（或交接说明）带上。
  const busy = runner.isRunning(taskId) || retryTimers.has(taskId) || pendingHandoff.has(taskId)
  if (busy) {
    const queue = pendingInputs.get(taskId) || []
    queue.push(content)
    pendingInputs.set(taskId, queue)
    store.addEvent(taskId, {
      type: 'status',
      name: '指令已排队',
      content: '当前回合结束后会自动把这条指令发给 Agent。',
    })
    return { ok: true, queued: true }
  }

  // 没在跑：补一个 Agent（如果需要），然后带上指令续跑
  let agentId = task.agentId
  if (!agentId || !store.getAgent(agentId)) {
    const agent = pickIdleAgent(task)
    if (!agent) return { ok: false, error: '没有空闲员工' }
    agentId = agent.id
    store.updateTask(taskId, { agentId })
  }

  store.updateTask(taskId, { status: 'in_progress', runState: 'queued' })
  setImmediate(() => {
    runTurn(taskId, { extraInstruction: content }).catch((err) => {
      console.error('[queue] 续跑失败:', err.message)
    })
  })
  return { ok: true }
}

/** 取消：停进程 + 退回待处理 */
function cancelTask(taskId) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }

  const had = runner.cancel(taskId)
  pendingInputs.delete(taskId)
  clearHandoffState(taskId)

  if (!had) {
    // 没有在跑的进程（也可能正卡在退避里），直接落位
    store.updateTask(taskId, { status: 'backlog', runState: 'cancelled', nextRetryAt: 0 })
    store.addEvent(taskId, { type: 'status', name: '已取消', content: '任务已退回「待处理」。' })
    store.releaseAgentIfIdle(task.agentId)
  }
  return { ok: true }
}

/**
 * 任务被删除 / 被清空时调用：掐掉还在跑的回合，并丢掉排队的补充指令。
 * 这里刻意不写任何事件 —— 调用方紧接着就会把这个任务的所有记录删掉。
 */
function forgetTask(taskId) {
  runner.cancel(taskId)
  pendingInputs.delete(taskId)
  activeTurns.delete(taskId)
  clearHandoffState(taskId)
  // 模拟执行器按 taskId 记「第几次」，任务删了就把这条一起清掉
  runner.forgetAttempts(taskId)
}

/** 手动标记完成 */
function markDone(taskId) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  runner.cancel(taskId)
  pendingInputs.delete(taskId)
  clearHandoffState(taskId)
  store.updateTask(taskId, { status: 'complete', runState: 'done', error: '', nextRetryAt: 0 })
  store.addEvent(taskId, { type: 'status', name: '手动完成', content: '老板手动把任务标记为已完成。' })
  store.releaseAgentIfIdle(task.agentId)
  return { ok: true }
}

/** 拖动 / 切换列 */
function moveTask(taskId, status) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (!store.TASK_STATUSES.includes(status)) return { ok: false, error: '非法状态' }
  if (task.status === status) return { ok: true }

  if (status !== 'in_progress') {
    const wasRunning = runner.isRunning(taskId)
    if (wasRunning) runner.cancel(taskId)
    pendingInputs.delete(taskId)
    clearHandoffState(taskId)
    if (status === 'backlog') store.releaseAgentIfIdle(task.agentId)
  }

  // 手动拖列时 runState 也要落到一个自洽的值：沿用旧的 runState 会让
  // 「进行中 → 需要输入」留下 runState=running，卡片上同时挂着「执行中」标记，
  // 但进程其实已经被上面掐掉了。
  const runState =
    status === 'complete'
      ? 'done'
      : status === 'backlog'
        ? 'idle'
        : status === 'needs_input'
          ? 'waiting'
          : task.runState
  store.updateTask(taskId, { status, runState })
  store.addEvent(taskId, { type: 'status', name: '状态变更', content: `移动到「${status}」` })

  if (status === 'in_progress') {
    const started = startTask(taskId)
    // 起不来（最常见的是所有员工都在忙）：把卡片退回原列并说明原因，
    // 否则它会停在「进行中」假装在跑，既没有进程也没有 Agent。
    if (started && started.ok === false) {
      store.updateTask(taskId, { status: task.status, runState: task.runState })
      store.addEvent(taskId, {
        type: 'error',
        name: '无法开始',
        content: started.error || '没有可用的员工，任务已退回原列。',
      })
      return started
    }
  }
  return { ok: true }
}

/** 应用启动时：把上次崩溃/强退时卡在 running 的任务收敛掉 */
function recoverOnStartup() {
  const tasks = store.listTasks()
  let recovered = 0
  for (const t of tasks) {
    if (t.runState === 'running' || t.runState === 'queued') {
      store.updateTask(t.id, {
        runState: 'idle',
        status: t.status === 'in_progress' ? 'needs_input' : t.status,
        // 退避定时器活在内存里，重启就没了 —— 顺手把退避标记清掉，
        // 否则任务会永远停在「退避中」却没有任何人在等它
        nextRetryAt: 0,
      })
      store.addEvent(t.id, {
        type: 'system',
        name: '已恢复',
        content: '上次退出时该任务仍在执行，已重置为可重跑状态。',
      })
      recovered++
    }
  }
  // 内存里的调度状态一律清空（进程已随上次退出消失）
  for (const timer of retryTimers.values()) clearTimeout(timer)
  retryTimers.clear()
  pendingHandoff.clear()
  runHistory.clear()
  // 所有 Agent 一律置空闲（进程已随上次退出而消失）
  for (const a of store.listAgents()) {
    if (a.status !== 'idle') store.updateAgent(a.id, { status: 'idle' })
  }
  if (recovered) console.log(`[queue] 已恢复 ${recovered} 个中断的任务`)
  return recovered
}

/**
 * 调度循环：任何状态变化后调用，把 in_progress 但没在跑的任务推起来。
 * 这样「后端自动分配空闲 Agent」对拖拽、API 改状态等所有入口都生效。
 */
function dispatch() {
  const tasks = store.listTasks()
  for (const t of tasks) {
    if (t.status !== 'in_progress') continue
    if (runner.isRunning(t.id)) continue
    if (t.runState === 'running' || t.runState === 'queued') continue
    // quiet：这是自动重试，失败时不要反复往事件流里写「无空闲员工」
    startTask(t.id, { quiet: true })
  }
}

module.exports = {
  startTask,
  sendInput,
  cancelTask,
  forgetTask,
  markDone,
  moveTask,
  dispatch,
  recoverOnStartup,
  pickIdleAgent,
  scoreAgent,
  FUNCTION_KEYWORDS,
  pendingInputs,
  // V3.6.0：换岗
  requestHandoff,
  applyHandoff,
  setAutoRetry,
  pickAgentForStage,
  pendingHandoff,
  retryTimers,
}
