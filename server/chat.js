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
const CONFIG = require('./config')

/**
 * 按一句话的内容挑 Agent。
 * 优先挑空闲的；都忙就挑匹配度最高的那个（任务会排队）。
 * 关键词画像与看板自动派单共用 queue.FUNCTION_KEYWORDS。
 */
function routeAgent(text, { preferIdle = true } = {}) {
  const haystack = String(text || '').toLowerCase()
  const agents = store.listAgents()
  if (!agents.length) return null

  const scored = agents.map((a) => {
    // 复用 queue 的评分口径：把这句话当成一个「只有一个标题的任务」
    const base = queue.scoreAgent(a, { title: haystack, description: '', tags: [] })
    const score = base + (preferIdle && a.status === 'idle' ? 1 : 0)
    return { agent: a, score }
  })

  scored.sort((x, y) => y.score - x.score || x.agent.createdAt - y.agent.createdAt)

  // 有明确命中就用命中的；一个都没命中则退回「第一个空闲的」
  if (scored[0].score > 0) return scored[0].agent
  const idle = scored.filter((s) => s.agent.status === 'idle')
  return (idle[0] || scored[0]).agent
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
function send({ conversationId, text, cwd, executor, model, agentId }) {
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

  // ---- 新对话 ----
  const target = agentId ? store.getAgent(agentId) : routeAgent(content)
  if (!target) return { ok: false, error: '还没有任何员工，请先招聘' }

  const task = store.createTask({
    title: summarizeTitle(content),
    description: content,
    tags: [],
    cwd: cwd || CONFIG.DEFAULT_CWD,
    agentId: target.id,
    executor: executor || '',
    model: model || '',
  })

  store.addMessage(task.id, 'user', content)
  store.addEvent(task.id, {
    type: 'status',
    name: '自动派单',
    content: `已把这条请求分配给「${target.functionLabel}」（${target.executor}）`,
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

module.exports = {
  send,
  routeAgent,
  listConversations,
  summarizeTitle,
}
