'use strict'

/**
 * 对话页的后端逻辑。
 *
 * 模型设计：**一个对话 = 一个任务**。
 * 这样复用已有的 tasks / messages / events 三张表，以及 runner 的 session 续跑，
 * 不需要再引入一套并行的「会话」概念；对话记录 = 任务详情，看板 = 对话列表，
 * 两边天然同步。
 *
 * 用户在对话页输入第一句话时：
 *   建任务（标题取首句摘要）→ 按语义挑一个 Agent → 派单执行
 * 之后在同一对话里继续输入时：
 *   复用任务，走 sendInput → 用同一个 session 续跑，Agent 保留上下文
 */

const store = require('./store')
const queue = require('./queue')
const runner = require('./runner')
const executors = require('./executors')
const chaosLlm = require('./chaos-llm')
const CONFIG = require('./config')

/**
 * 按一句话的内容挑 Agent。
 * 优先挑空闲的；都忙就挑匹配度最高的那个（任务会排队）。
 * 关键词画像与看板自动派单共用 queue.FUNCTION_KEYWORDS。
 */
function routeAgent(text, { preferIdle = true } = {}) {
  // 8.0.0：对话与看板共用同一套派单策略（keyword / least-busy / round-robin）。
  // queue.pickAgentForText 内部保留「空闲优先」硬约束，并处理全员忙碌的退化情况。
  return queue.pickAgentForText(text, { preferIdle })
}

function summarizeTitle(text) {
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
  if (!clean) return '新对话'
  return clean.length > 40 ? clean.slice(0, 40) + '…' : clean
}

/**
 * 在对话里发一条消息。
 *  - 没带 conversationId：开一个新对话（= 建一个任务）并立刻执行
 *  - 带了 conversationId：续跑那个对话
 */
/**
 * 9.3.8：调度员智能分派 —— 新对话没指定岗位时，由「任务调度」岗位用混沌本地
 * 模型判断这条请求该交给谁。失败/超时/混沌没起 → 退回关键词派单。
 */
async function dispatchAgent(content) {
  const agents = store.listAgents().filter((a) => a.role !== 'Dispatcher')
  const dispatcher = store.listAgents().find((a) => a.role === 'Dispatcher')
  if (!dispatcher || !agents.length) return routeAgent(content)

  try {
    const roster = agents
      .map((a, i) => `${i + 1}. ${a.functionLabel}（${a.role}）`)
      .join('\n')
    const answer = await chaosLlm.quickAnswer({
      prompt:
        `用户请求：${content.slice(0, 300)}\n\n候选岗位：\n${roster}\n\n` +
        `只输出最合适岗位的序号（1~${agents.length} 的一个数字），不要输出任何其他内容。`,
      system:
        '你是团队的任务调度主管。你的唯一任务是把请求分派给最合适的岗位。' +
        '只回答一个序号数字，禁止解释。',
      timeoutMs: 20 * 1000,
    })
    const idx = Number(String(answer.text || '').trim().match(/\d+/)?.[0])
    if (Number.isInteger(idx) && idx >= 1 && idx <= agents.length) {
      return agents[idx - 1]
    }
  } catch (_) {
    /* 混沌没起 / 超时 → 关键词兜底 */
  }
  return routeAgent(content)
}

async function send({ conversationId, text, cwd, executor, model, agentId }) {
  const content = String(text || '').trim()
  if (!content) return { ok: false, error: '内容为空' }

  // ---- 续跑已有对话 ----
  if (conversationId) {
    const task = store.getTask(conversationId)
    if (!task) return { ok: false, error: '对话不存在' }
    // 允许在对话里临时切换模型 / 执行器
    if (executor || model) {
      store.updateTask(task.id, {
        executor: executor !== undefined ? executor : task.executor,
        model: model !== undefined ? model : task.model,
      })
    }
    const res = queue.sendInput(task.id, content)
    return { ...res, taskId: task.id }
  }

  // ---- 新对话（9.3.8：未指定岗位时由调度员智能分派） ----
  const target = agentId ? store.getAgent(agentId) : await dispatchAgent(content)
  if (!target) return { ok: false, error: '还没有任何员工，请先招聘' }

  // 8.0.2：混沌优先 —— 没显式指定执行器、且本机混沌可用时，新对话默认走混沌
  // （完全免费、数据不出本机）。用户在对话页选择器里点了别的执行器时不干扰。
  let useExecutor = executor || ''
  let useModel = model || ''
  if (!useExecutor) {
    const chaos = chaosLlm.snapshot()
    const installed = (chaos.models || []).map((m) => m.id)
    if (chaos.up && installed.length) {
      useExecutor = 'chaos'
      if (!useModel) useModel = installed.includes(chaosLlm.DEFAULT_PULL) ? chaosLlm.DEFAULT_PULL : installed[0]
    }
  }

  const task = store.createTask({
    title: summarizeTitle(content),
    description: content,
    tags: [],
    cwd: cwd || CONFIG.DEFAULT_CWD,
    agentId: target.id,
    executor: useExecutor,
    model: useModel,
  })

  store.addMessage(task.id, 'user', content)
  store.addEvent(task.id, {
    type: 'status',
    name: '自动派单',
    content: `已把这条请求分配给「${target.functionLabel}」（${useExecutor || target.executor}）`,
  })

  queue.startTask(task.id)
  return { ok: true, taskId: task.id, agent: target }
}

/** 对话列表（就是任务列表，按最近活跃排序） */
function listConversations() {
  return store
    .listTasks()
    .map((t) => {
      const msgs = store.listMessages(t.id)
      const agent = t.agentId ? store.getAgent(t.agentId) : null
      const last = msgs.length ? msgs[msgs.length - 1] : null
      return {
        id: t.id,
        title: t.title,
        status: t.status,
        runState: t.runState,
        functionLabel: agent ? agent.functionLabel : '',
        executor: t.executor || (agent ? agent.executor : '') || 'claude',
        model: t.model || (agent ? agent.model : '') || '',
        messageCount: msgs.length,
        running: runner.isRunning(t.id),
        lastMessage: last ? String(last.content).slice(0, 80) : '',
        updatedAt: t.updatedAt,
        createdAt: t.createdAt,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/**
 * 8.0.2：对话分支（岔路）—— 从当前对话复制出一条新对话（含全部历史消息），
 * 不自动执行。用户可以在岔路上继续追问，探索不同的答案，原对话不动。
 */
function branchConversation(conversationId) {
  const src = store.getTask(conversationId)
  if (!src) return { ok: false, error: '对话不存在' }
  const task = store.createTask({
    title: `${src.title}（分支）`,
    description: src.description,
    tags: src.tags || [],
    cwd: src.cwd,
    agentId: src.agentId,
    executor: src.executor,
    model: src.model,
  })
  for (const m of store.listMessages(conversationId)) {
    if (m.role === 'user' || m.role === 'assistant') {
      store.addMessage(task.id, m.role, m.content)
    }
  }
  store.addEvent(task.id, {
    type: 'status',
    name: '分支',
    content: `从「${src.title}」岔出的新分支，可以放心试不同方向。`,
  })
  return { ok: true, taskId: task.id }
}

module.exports = {
  send,
  routeAgent,
  listConversations,
  summarizeTitle,
  branchConversation,
}
