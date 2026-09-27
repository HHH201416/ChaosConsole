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
async function runTurn(taskId, { extraInstruction = '' } = {}) {
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
      name: extraInstruction ? '续跑' : '开始执行',
      content: extraInstruction
        ? `向「${who}」发送补充指令`
        : `「${who}」接手任务（${agent.executor}），工作目录 ${task.cwd}`,
    })

    let result
    try {
      result = await runner.execute({
        task: store.getTask(taskId),
        agent,
        extraInstruction,
        resumeSessionId: extraInstruction ? store.getTask(taskId).sessionId : null,
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
    store.releaseAgentIfIdle(task.agentId)
    return
  }

  if (result.sessionId) store.updateTask(taskId, { sessionId: result.sessionId })

  // ---- 被取消 -------------------------------------------------------
  if (result.cancelled) {
    pendingInputs.delete(taskId)
    store.updateTask(taskId, { status: 'backlog', runState: 'cancelled' })
    store.addEvent(taskId, { type: 'status', name: '已取消', content: '任务已退回「待处理」。' })
    store.releaseAgentIfIdle(task.agentId)
    return
  }

  // ---- 出错 ---------------------------------------------------------
  if (!result.ok) {
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
 * 对外操作
 * ------------------------------------------------------------------ */

/** 开始 / 继续一个任务 */
function startTask(taskId, { quiet = false } = {}) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (runner.isRunning(taskId)) return { ok: false, error: '任务已在执行中' }

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

  store.updateTask(taskId, { status: 'in_progress', runState: 'queued' })
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

  if (runner.isRunning(taskId)) {
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

  if (!had) {
    // 没有在跑的进程，直接落位
    store.updateTask(taskId, { status: 'backlog', runState: 'cancelled' })
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
}

/** 手动标记完成 */
function markDone(taskId) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  runner.cancel(taskId)
  pendingInputs.delete(taskId)
  store.updateTask(taskId, { status: 'complete', runState: 'done', error: '' })
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
      store.updateTask(t.id, { runState: 'idle', status: t.status === 'in_progress' ? 'needs_input' : t.status })
      store.addEvent(t.id, {
        type: 'system',
        name: '已恢复',
        content: '上次退出时该任务仍在执行，已重置为可重跑状态。',
      })
      recovered++
    }
  }
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
}
