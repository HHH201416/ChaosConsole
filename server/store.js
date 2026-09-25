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

function createAgent({ name, role, avatar, systemPrompt, system_prompt, executor, model, functionLabel, function_label }) {
  // 同时接受 camelCase 与 snake_case：seed.js 用 snake_case，HTTP API 用 camelCase
  const prompt = systemPrompt !== undefined ? systemPrompt : system_prompt
  const fnLabel = functionLabel !== undefined ? functionLabel : function_label
  const id = uid('agt')
  db.run(
    `INSERT INTO agents (id, name, role, avatar, status, system_prompt, executor, model, function_label, created_at)
     VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?)`,
    [
      id,
      String(name || '新员工').trim(),
      role || 'Coder',
      avatar || '🤖',
      prompt || '',
      executor || 'claude',
      model || '',
      fnLabel || role || 'Coder',
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
  }
  db.run(
    `UPDATE agents SET name = ?, role = ?, avatar = ?, status = ?, system_prompt = ?,
            executor = ?, model = ?, function_label = ? WHERE id = ?`,
    [
      next.name,
      next.role,
      next.avatar,
      AGENT_STATUSES.includes(next.status) ? next.status : 'idle',
      next.system_prompt,
      next.executor,
      next.model,
      next.function_label,
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
  db.run("UPDATE tasks SET agent_id = NULL WHERE agent_id = ? AND status != 'complete'", [id])
  bus.emit('agent:deleted', { id })
  for (const t of listTasks({ agentId: id })) bus.emit('task:updated', t)
  return true
}

/** 释放某个 Agent：仅当它名下没有仍在进行中的任务时才置为空闲 */
function releaseAgentIfIdle(agentId) {
  if (!agentId) return
  const busy = db.get(
    "SELECT COUNT(*) AS n FROM tasks WHERE agent_id = ? AND status IN ('in_progress', 'needs_input')",
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

function createTask({ title, description, tags, cwd, agentId, status, executor, model }) {
  const id = uid('task')
  const ts = now()
  db.run(
    `INSERT INTO tasks (id, title, description, status, run_state, agent_id, tags, cwd, result, error,
                        executor, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, '', '', ?, ?, ?, ?)`,
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
  }

  if (!TASK_STATUSES.includes(next.status)) next.status = current.status

  db.run(
    `UPDATE tasks SET title = ?, description = ?, status = ?, run_state = ?, agent_id = ?,
            tags = ?, cwd = ?, session_id = ?, result = ?, error = ?,
            executor = ?, model = ?, updated_at = ?
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

function bootstrap() {
  const agentCount = db.get('SELECT COUNT(*) AS n FROM agents')
  if (!agentCount || agentCount.n === 0) {
    for (const a of DEFAULT_AGENTS) createAgent(a)
    console.log(`[store] 已初始化 ${DEFAULT_AGENTS.length} 名默认员工`)
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
