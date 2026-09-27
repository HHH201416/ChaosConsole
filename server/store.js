'use strict'

const crypto = require('crypto')
const EventEmitter = require('events')
const db = require('./db')
const CONFIG = require('./config')
const { DEFAULT_AGENTS } = require('./seed')

/** 全局事件总线：runner / queue 产生事件，index.js 负责广播给所有 WebSocket 客户端 */
const bus = new EventEmitter()
bus.setMaxListeners(0)

const TASK_STATUSES = ['backlog', 'in_progress', 'needs_input', 'complete']
const AGENT_STATUSES = ['idle', 'working']

const now = () => Date.now()
const uid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`

/* ------------------------------------------------------------------ *
 * 行 -> 前端对象
 * ------------------------------------------------------------------ */

function mapAgent(row) {
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    avatar: row.avatar,
    status: row.status,
    systemPrompt: row.system_prompt,
    executor: row.executor || 'claude',
    model: row.model || '',
    // 「是干什么的」。界面上只显示这个，不显示姓名
    functionLabel: row.function_label || row.role,
    // 该岗位可挂的 MCP（catalog id 数组）。空 = 用 seed 里该 role 的默认集
    mcp: safeParseArray(row.mcp),
    // 该岗位的默认流水线。空 = 用 executor 的默认流水线
    pipeline: safeParseArray(row.pipeline),
    createdAt: row.created_at,
  }
}

function safeParseArray(text) {
  try {
    const v = JSON.parse(text)
    return Array.isArray(v) ? v : []
  } catch (_) {
    return []
  }
}

/** 字符串数组 -> 存库字符串（MCP id 这类）。只留字符串元素，防止前端塞进对象把库里写脏 */
function toJsonArray(v) {
  return JSON.stringify(Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [])
}

/**
 * 通用数组 -> 存库字符串（**保留对象元素**）。
 * 流水线是 [{stage, role}]，用上面那个只留字符串的会把整条链过滤成 []
 * —— 而且是在 updateTask 里静默发生的，表现为「流水线建完就没了」，极难查。
 */
function toJsonList(v) {
  return JSON.stringify(Array.isArray(v) ? v : [])
}

function mapTask(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    runState: row.run_state,
    agentId: row.agent_id,
    tags: safeParseArray(row.tags),
    cwd: row.cwd,
    sessionId: row.session_id || null,
    result: row.result,
    error: row.error,
    // 执行器/模型的覆盖值：为空表示跟随所属 Agent
    executor: row.executor || '',
    model: row.model || '',
    // 阶段流水线：本任务覆盖 > 岗位 > executor 默认（解析在 pipeline.js）
    stage: row.stage || '',
    pipeline: safeParseArray(row.pipeline),
    // 自动换岗：已尝试次数 / 是否允许 / 退避到什么时候
    attempts: row.attempts || 0,
    autoRetry: row.auto_retry !== 0,
    nextRetryAt: row.next_retry_at || 0,
    // 最近一次交接
    handoffNote: row.handoff_note || '',
    handoffAt: row.handoff_at || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function mapMessage(row) {
  return { id: row.id, taskId: row.task_id, role: row.role, content: row.content, createdAt: row.created_at }
}

function mapEvent(row) {
  return { id: row.id, taskId: row.task_id, type: row.type, name: row.name, content: row.content, createdAt: row.created_at }
}

/* ------------------------------------------------------------------ *
 * 员工
 * ------------------------------------------------------------------ */

function listAgents() {
  return db.all('SELECT * FROM agents ORDER BY created_at ASC, rowid ASC').map(mapAgent)
}

function getAgent(id) {
  return mapAgent(db.get('SELECT * FROM agents WHERE id = ?', [id]))
}

function createAgent({ name, role, avatar, systemPrompt, system_prompt, executor, model, functionLabel, function_label, mcp, pipeline }) {
  // 同时接受 camelCase 与 snake_case：seed.js 用 snake_case，HTTP API 用 camelCase
  const prompt = systemPrompt !== undefined ? systemPrompt : system_prompt
  const fnLabel = functionLabel !== undefined ? functionLabel : function_label
  const id = uid('agt')
  db.run(
    `INSERT INTO agents (id, name, role, avatar, status, system_prompt, executor, model, function_label,
                         mcp, pipeline, created_at)
     VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      String(name || '新员工').trim(),
      role || 'Coder',
      avatar || '🤖',
      prompt || '',
      executor || 'claude',
      model || '',
      fnLabel || role || 'Coder',
      toJsonArray(mcp),
      toJsonList(pipeline),
      now(),
    ],
  )
  const agent = getAgent(id)
  bus.emit('agent:updated', agent)
  return agent
}

function updateAgent(id, patch) {
  const current = getAgent(id)
  if (!current) return null
  const pick = (key, fallback) => (patch[key] !== undefined ? patch[key] : fallback)
  const next = {
    name: pick('name', current.name),
    role: pick('role', current.role),
    avatar: pick('avatar', current.avatar),
    status: pick('status', current.status),
    system_prompt: pick('systemPrompt', current.systemPrompt),
    executor: pick('executor', current.executor),
    model: pick('model', current.model),
    function_label: pick('functionLabel', current.functionLabel),
    mcp: pick('mcp', current.mcp),
    pipeline: pick('pipeline', current.pipeline),
  }
  db.run(
    `UPDATE agents SET name = ?, role = ?, avatar = ?, status = ?, system_prompt = ?,
            executor = ?, model = ?, function_label = ?, mcp = ?, pipeline = ? WHERE id = ?`,
    [
      next.name,
      next.role,
      next.avatar,
      AGENT_STATUSES.includes(next.status) ? next.status : 'idle',
      next.system_prompt,
      next.executor,
      next.model,
      next.function_label,
      toJsonArray(next.mcp),
      toJsonList(next.pipeline),
      id,
    ],
  )
  const agent = getAgent(id)
  bus.emit('agent:updated', agent)
  return agent
}

function deleteAgent(id) {
  const agent = getAgent(id)
  if (!agent) return false
  db.run('DELETE FROM agents WHERE id = ?', [id])
  // 删的是默认岗位就留个记号 —— 否则下次启动 syncRoster 会把它当「缺席」补回来，
  // 变成「这岗位删不掉，重启就复活」。
  if (DEFAULT_AGENTS.some((a) => a.role === agent.role)) rememberRemovedRole(agent.role)
  db.run("UPDATE tasks SET agent_id = NULL WHERE agent_id = ? AND status != 'complete'", [id])
  bus.emit('agent:deleted', { id })
  for (const t of listTasks({ agentId: id })) bus.emit('task:updated', t)
  return true
}

/**
 * 释放某个 Agent：仅当它名下没有**正在跑**的任务时才置为空闲。
 *
 * 判据是 run_state 而不是 status —— 这一点很关键：以前用
 * status IN ('in_progress','needs_input')，于是一个失败落到 needs_input 的任务
 * 会把岗位永久钉在 working（明明没人干活，却再也接不了新单），岗位池会被慢慢抽干。
 * 现在与 queue.js 的 agentIsBusy 口径一致：只有 running/queued 才算占用。
 */
function releaseAgentIfIdle(agentId) {
  if (!agentId) return
  const busy = db.get(
    "SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND run_state IN ('running', 'queued')",
    [agentId],
  )
  if (!busy || busy.n === 0) {
    const agent = getAgent(agentId)
    if (agent && agent.status !== 'idle') updateAgent(agentId, { status: 'idle' })
  }
}

/* ------------------------------------------------------------------ *
 * 任务
 * ------------------------------------------------------------------ */

function listTasks(filter = {}) {
  let sql = 'SELECT * FROM tasks'
  const params = []
  if (filter.agentId) {
    sql += ' WHERE agent_id = ?'
    params.push(filter.agentId)
  }
  sql += ' ORDER BY created_at DESC, rowid DESC'
  return db.all(sql, params).map(mapTask)
}

function getTask(id) {
  return mapTask(db.get('SELECT * FROM tasks WHERE id = ?', [id]))
}

function createTask({ title, description, tags, cwd, agentId, status, executor, model, pipeline }) {
  const id = uid('task')
  const ts = now()
  db.run(
    `INSERT INTO tasks (id, title, description, status, run_state, agent_id, tags, cwd, result, error,
                        executor, model, pipeline, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, '', '', ?, ?, ?, ?, ?)`,
    [
      id,
      String(title || '未命名任务').trim(),
      description || '',
      TASK_STATUSES.includes(status) ? status : 'backlog',
      agentId || null,
      JSON.stringify(Array.isArray(tags) ? tags : []),
      cwd || CONFIG.DEFAULT_CWD,
      executor || '',
      model || '',
      // 任务级流水线覆盖。空 = 跟随岗位/执行器默认（见 pipeline.resolve）
      JSON.stringify(Array.isArray(pipeline) ? pipeline : []),
      ts,
      ts,
    ],
  )
  const task = getTask(id)
  bus.emit('task:updated', task)
  return task
}

function updateTask(id, patch) {
  const current = getTask(id)
  if (!current) return null

  const next = {
    title: patch.title !== undefined ? patch.title : current.title,
    description: patch.description !== undefined ? patch.description : current.description,
    status: patch.status !== undefined ? patch.status : current.status,
    runState: patch.runState !== undefined ? patch.runState : current.runState,
    agentId: patch.agentId !== undefined ? patch.agentId : current.agentId,
    tags: patch.tags !== undefined ? patch.tags : current.tags,
    cwd: patch.cwd !== undefined ? patch.cwd : current.cwd,
    sessionId: patch.sessionId !== undefined ? patch.sessionId : current.sessionId,
    result: patch.result !== undefined ? patch.result : current.result,
    error: patch.error !== undefined ? patch.error : current.error,
    executor: patch.executor !== undefined ? patch.executor : current.executor,
    model: patch.model !== undefined ? patch.model : current.model,
    stage: patch.stage !== undefined ? patch.stage : current.stage,
    pipeline: patch.pipeline !== undefined ? patch.pipeline : current.pipeline,
    attempts: patch.attempts !== undefined ? Number(patch.attempts) || 0 : current.attempts,
    autoRetry:
      patch.autoRetry !== undefined ? (patch.autoRetry ? 1 : 0) : current.autoRetry ? 1 : 0,
    nextRetryAt:
      patch.nextRetryAt !== undefined ? Number(patch.nextRetryAt) || 0 : current.nextRetryAt,
    handoffNote: patch.handoffNote !== undefined ? patch.handoffNote : current.handoffNote,
    handoffAt: patch.handoffAt !== undefined ? Number(patch.handoffAt) || 0 : current.handoffAt,
  }

  if (!TASK_STATUSES.includes(next.status)) next.status = current.status

  db.run(
    `UPDATE tasks SET title = ?, description = ?, status = ?, run_state = ?, agent_id = ?,
            tags = ?, cwd = ?, session_id = ?, result = ?, error = ?,
            executor = ?, model = ?, stage = ?, pipeline = ?, attempts = ?, auto_retry = ?,
            next_retry_at = ?, handoff_note = ?, handoff_at = ?, updated_at = ?
     WHERE id = ?`,
    [
      next.title,
      next.description,
      next.status,
      next.runState,
      next.agentId || null,
      JSON.stringify(next.tags || []),
      next.cwd,
      next.sessionId || null,
      next.result || '',
      next.error || '',
      next.executor || '',
      next.model || '',
      next.stage || '',
      toJsonList(next.pipeline),
      next.attempts,
      next.autoRetry,
      next.nextRetryAt,
      next.handoffNote || '',
      next.handoffAt,
      now(),
      id,
    ],
  )

  const task = getTask(id)
  bus.emit('task:updated', task)
  return task
}

function deleteTask(id) {
  const task = getTask(id)
  if (!task) return false
  db.run('DELETE FROM tasks WHERE id = ?', [id])
  db.run('DELETE FROM messages WHERE task_id = ?', [id])
  db.run('DELETE FROM events WHERE task_id = ?', [id])
  bus.emit('task:deleted', { id })
  releaseAgentIfIdle(task.agentId)
  return true
}

/* ------------------------------------------------------------------ *
 * 对话记录 / 事件
 * ------------------------------------------------------------------ */

function listMessages(taskId) {
  return db.all('SELECT * FROM messages WHERE task_id = ? ORDER BY id ASC', [taskId]).map(mapMessage)
}

function addMessage(taskId, role, content) {
  // 解析器是异步收尾的：任务被删掉之后，可能还有几行 stdout 在往回写。
  // 那些记录会变成永远没人清的孤儿行（task_id 已经没有对应任务了），这里直接丢掉。
  if (!getTask(taskId)) return null
  const id = db.insert('INSERT INTO messages (task_id, role, content, created_at) VALUES (?, ?, ?, ?)', [
    taskId,
    role,
    String(content ?? ''),
    now(),
  ])
  const msg = mapMessage(db.get('SELECT * FROM messages WHERE id = ?', [id]))
  bus.emit('message:added', msg)
  return msg
}

function listEvents(taskId) {
  return db.all('SELECT * FROM events WHERE task_id = ? ORDER BY id ASC', [taskId]).map(mapEvent)
}

function addEvent(taskId, { type, name, content }) {
  // 同 addMessage：任务已删除时丢弃收尾阶段的写入，避免孤儿行
  if (!getTask(taskId)) return null
  const id = db.insert(
    'INSERT INTO events (task_id, type, name, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [taskId, type || 'info', name || '', typeof content === 'string' ? content : JSON.stringify(content ?? ''), now()],
  )
  const ev = mapEvent(db.get('SELECT * FROM events WHERE id = ?', [id]))
  bus.emit('event:added', ev)
  return ev
}

function clearTaskHistory(taskId) {
  db.run('DELETE FROM messages WHERE task_id = ?', [taskId])
  db.run('DELETE FROM events WHERE task_id = ?', [taskId])
  bus.emit('task:history-cleared', { taskId })
}

/* ------------------------------------------------------------------ *
 * 设置
 * ------------------------------------------------------------------ */

function getSetting(key, fallback = null) {
  const row = db.get('SELECT value FROM settings WHERE key = ?', [key])
  return row ? row.value : fallback
}

function setSetting(key, value) {
  db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
    key,
    String(value),
  ])
}

/* ------------------------------------------------------------------ *
 * 初始化：首次运行灌入默认员工与示例任务
 * ------------------------------------------------------------------ */

/** 被用户删掉的默认岗位 role，存 settings 里，避免重启复活 */
const REMOVED_ROLES_KEY = 'removedDefaultRoles'

function removedRoles() {
  try {
    const arr = JSON.parse(getSetting(REMOVED_ROLES_KEY, '[]'))
    return Array.isArray(arr) ? arr : []
  } catch (_) {
    return []
  }
}

function rememberRemovedRole(role) {
  const roles = new Set(removedRoles())
  if (roles.has(role)) return
  roles.add(role)
  setSetting(REMOVED_ROLES_KEY, JSON.stringify([...roles]))
}

/**
 * 把默认花名册里「缺席」的岗位补进库里，返回补了哪些。
 *
 * 判据用 role：它是自动派单关键词的索引键（见 queue.js 的 FUNCTION_KEYWORDS），
 * 默认花名册里不重复。
 *
 * 只补不删、只补不改：role 已存在就跳过，用户改过的提示词/执行器/模型不会被覆盖；
 * 用户手动删掉的默认岗位记在 settings 里，不在这里复活。
 */
function syncRoster() {
  const removed = new Set(removedRoles())
  const existing = new Set(listAgents().map((a) => a.role))
  const missing = DEFAULT_AGENTS.filter((a) => !existing.has(a.role) && !removed.has(a.role))
  for (const a of missing) createAgent(a)
  return missing
}

function bootstrap() {
  // 首次启动时库是空的，此刻「缺席」的就是全部默认岗位，等于全量灌入；
  // 老库则只补后来新增的那几个。
  //
  // 这里必须是增量补齐、不能只在空库灌一次：seed.js 里扩编过的岗位
  // （鸿蒙从 1 个岗位拆成 10 个）在有存量数据的库里永远进不来 —— 表非空，
  // 一次性灌入直接跳过，用户看到的就是「说好拆 10 个，界面上只有一个」。
  const added = syncRoster()
  if (added.length) {
    console.log(`[store] 花名册补齐 ${added.length} 个岗位：${added.map((a) => a.functionLabel).join('、')}`)
  }

  // 刻意不预置任何任务：首次启动与重启后看板都是 0 任务，
  // 由用户在对话页发起第一个任务。
}

/** 清空全部任务（含对话与事件），用于「一键归零」 */
function clearAllTasks() {
  for (const t of listTasks()) bus.emit('task:deleted', { id: t.id })
  db.run('DELETE FROM tasks')
  db.run('DELETE FROM messages')
  db.run('DELETE FROM events')
  for (const a of listAgents()) {
    if (a.status !== 'idle') updateAgent(a.id, { status: 'idle' })
  }
  bus.emit('tasks:cleared', {})
  return true
}

function snapshot() {
  return { agents: listAgents(), tasks: listTasks() }
}

module.exports = {
  bus,
  TASK_STATUSES,
  AGENT_STATUSES,
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  releaseAgentIfIdle,
  listTasks,
  getTask,
  createTask,
  updateTask,
  deleteTask,
  listMessages,
  addMessage,
  listEvents,
  addEvent,
  clearTaskHistory,
  getSetting,
  setSetting,
  bootstrap,
  clearAllTasks,
  snapshot,
}
