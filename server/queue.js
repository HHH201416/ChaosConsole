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
  HarmonyOS: ['鸿蒙', 'harmonyos', 'arkts', 'arkui', 'deveco', '元服务', 'hvigor', 'ohos', '华为'],
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

  return settle(taskId, result)
}

function settle(taskId, result) {
  const task = store.getTask(taskId)
  if (!task) return

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
function startTask(taskId) {
  const task = store.getTask(taskId)
  if (!task) return { ok: false, error: '任务不存在' }
  if (runner.isRunning(taskId)) return { ok: false, error: '任务已在执行中' }

  let agentId = task.agentId
  if (!agentId || !store.getAgent(agentId)) {
    const agent = pickIdleAgent(task)
    if (!agent) {
      store.addEvent(taskId, { type: 'error', name: '无空闲员工', content: '所有员工都在忙，请稍后再试。' })
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

  const runState = status === 'complete' ? 'done' : status === 'backlog' ? 'idle' : task.runState
  store.updateTask(taskId, { status, runState })
  store.addEvent(taskId, { type: 'status', name: '状态变更', content: `移动到「${status}」` })

  if (status === 'in_progress') startTask(taskId)
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
    startTask(t.id)
  }
}

module.exports = {
  startTask,
  sendInput,
  cancelTask,
  markDone,
  moveTask,
  dispatch,
  recoverOnStartup,
  pickIdleAgent,
  scoreAgent,
  FUNCTION_KEYWORDS,
  pendingInputs,
}
