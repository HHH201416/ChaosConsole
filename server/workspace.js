'use strict'

/**
 * 8.0.0：工作区导出 / 导入。
 *
 * 导出 = agents / tasks / messages / events / templates / 白名单设置 的 JSON 快照。
 * 导入 = 先自动备份，再在事务里整体替换；任何校验失败都不会动现有数据。
 * 导入进来的任务一律回到可重跑状态（idle / 清空 session），避免恢复出坏会话。
 */

const db = require('./db')
const store = require('./store')
const backup = require('./backup')
const queue = require('./queue')

const SCHEMA_VERSION = 1
const MAX = {
  agents: 500,
  tasks: 10000,
  messages: 200000,
  events: 200000,
  templates: 500,
}

const SETTING_KEYS = [
  'permissionMode',
  'devecoAutoApprove',
  'autoUpdateWhenIdle',
  'downloadMirror',
  'maxAttempts',
  'pipelineEnabled',
  'mcpScopeEnabled',
  'mcpStrict',
  'mcpHandoffTool',
  'dispatchStrategy',
  'uiLanguage',
  'accent',
  'trayEnabled',
  'blockShutdown',
  'closeToTray',
  'notifyOnComplete',
  'notifyOnNeedsInput',
  'notifyOnlyWhenUnfocused',
  'globalShortcut',
  'backupEnabled',
  'backupIntervalHours',
  'backupRetention',
]

function appVersion() {
  return require('../package.json').version
}

function exportWorkspace() {
  const settings = {}
  for (const key of SETTING_KEYS) {
    const value = store.getSetting(key, null)
    if (value !== null) settings[key] = value
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    appVersion: appVersion(),
    exportedAt: new Date().toISOString(),
    agents: store.listAgents(),
    tasks: store.listTasks(),
    messages: db.all('SELECT * FROM messages ORDER BY id ASC').map((r) => ({
      taskId: r.task_id,
      role: r.role,
      content: r.content,
      createdAt: r.created_at,
    })),
    events: db.all('SELECT * FROM events ORDER BY id ASC').map((r) => ({
      taskId: r.task_id,
      type: r.type,
      name: r.name,
      content: r.content,
      createdAt: r.created_at,
    })),
    templates: store.listTemplates(),
    settings,
  }
}

function assertSafe(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) assertSafe(item, depth + 1)
    return
  }
  for (const key of Object.keys(value)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      throw new Error('导入数据包含非法字段')
    }
    assertSafe(value[key], depth + 1)
  }
}

function validate(data) {
  if (!data || typeof data !== 'object') throw new Error('导入内容不是有效对象')
  assertSafe(data)
  if (data.schemaVersion !== SCHEMA_VERSION) throw new Error('不支持的备份版本')
  for (const key of ['agents', 'tasks', 'messages', 'events', 'templates']) {
    if (data[key] !== undefined && !Array.isArray(data[key])) throw new Error(`${key} 必须是数组`)
    if (Array.isArray(data[key]) && data[key].length > MAX[key]) {
      throw new Error(`${key} 数量超过上限（${MAX[key]}）`)
    }
  }
  const ids = new Set()
  for (const a of data.agents || []) {
    if (!a || typeof a.id !== 'string' || !a.id) throw new Error('岗位记录缺少 id')
    if (ids.has(`a:${a.id}`)) throw new Error('岗位 id 重复')
    ids.add(`a:${a.id}`)
  }
  for (const t of data.tasks || []) {
    if (!t || typeof t.id !== 'string' || !t.id) throw new Error('任务记录缺少 id')
    if (ids.has(`t:${t.id}`)) throw new Error('任务 id 重复')
    ids.add(`t:${t.id}`)
  }
}

function str(value, fallback = '') {
  return value === undefined || value === null ? fallback : String(value)
}

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function json(value, fallback) {
  if (value === undefined) return JSON.stringify(fallback)
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch (_) {
    return JSON.stringify(fallback)
  }
}

function importWorkspace(data) {
  validate(data)

  // 先留退路，再清场
  backup.create('pre-import')
  for (const t of store.listTasks()) queue.forgetTask(t.id)

  const now = Date.now()
  const counts = { agents: 0, tasks: 0, messages: 0, events: 0, templates: 0 }

  db.transaction(() => {
    db.run('DELETE FROM messages')
    db.run('DELETE FROM events')
    db.run('DELETE FROM tasks')
    db.run('DELETE FROM task_templates')
    db.run('DELETE FROM agents')

    for (const a of data.agents || []) {
      db.run(
        `INSERT INTO agents (id, name, role, avatar, status, system_prompt, executor, model,
                             function_label, mcp, pipeline, created_at)
         VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?, ?)`,
        [
          str(a.id),
          str(a.name, '新员工'),
          str(a.role, 'Coder'),
          str(a.avatar, '🤖'),
          str(a.systemPrompt),
          str(a.executor, 'claude'),
          str(a.model),
          str(a.functionLabel, a.role || 'Coder'),
          json(a.mcp, []),
          json(a.pipeline, []),
          num(a.createdAt, now),
        ],
      )
      counts.agents++
    }

    const taskIds = new Set((data.tasks || []).map((t) => t.id))
    for (const t of data.tasks || []) {
      // 导入后一律回到可重跑状态
      const status = t.status === 'in_progress' ? 'needs_input' : str(t.status, 'backlog')
      const deps = (Array.isArray(t.dependsOn) ? t.dependsOn : []).filter(
        (d) => typeof d === 'string' && d !== t.id && taskIds.has(d),
      )
      const parentId = t.parentId && taskIds.has(t.parentId) && t.parentId !== t.id ? t.parentId : null
      db.run(
        `INSERT INTO tasks (id, title, description, status, run_state, agent_id, tags, cwd, session_id,
                            result, error, executor, model, stage, pipeline, attempts, auto_retry,
                            next_retry_at, handoff_note, handoff_at, parent_id, depends_on,
                            completed_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`,
        [
          str(t.id),
          str(t.title, '未命名任务'),
          str(t.description),
          store.TASK_STATUSES.includes(status) ? status : 'backlog',
          t.agentId || null,
          json(t.tags, []),
          str(t.cwd),
          str(t.result),
          str(t.error),
          str(t.executor),
          str(t.model),
          str(t.stage),
          json(t.pipeline, []),
          num(t.attempts),
          t.autoRetry === false ? 0 : 1,
          str(t.handoffNote),
          num(t.handoffAt),
          parentId,
          JSON.stringify(deps),
          num(t.completedAt),
          num(t.createdAt, now),
          num(t.updatedAt, now),
        ],
      )
      counts.tasks++
    }

    for (const m of data.messages || []) {
      db.run('INSERT INTO messages (task_id, role, content, created_at) VALUES (?, ?, ?, ?)', [
        str(m.taskId),
        str(m.role, 'user'),
        str(m.content),
        num(m.createdAt, now),
      ])
      counts.messages++
    }

    for (const e of data.events || []) {
      db.run(
        'INSERT INTO events (task_id, type, name, content, created_at) VALUES (?, ?, ?, ?, ?)',
        [str(e.taskId), str(e.type, 'info'), str(e.name), str(e.content), num(e.createdAt, now)],
      )
      counts.events++
    }

    for (const tpl of data.templates || []) {
      db.run(
        `INSERT INTO task_templates (id, name, title, description, tags, cwd, agent_id, executor,
                                      model, pipeline, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          str(tpl.id),
          str(tpl.name, '未命名模板'),
          str(tpl.title),
          str(tpl.description),
          json(tpl.tags, []),
          str(tpl.cwd),
          tpl.agentId || null,
          str(tpl.executor),
          str(tpl.model),
          json(tpl.pipeline, []),
          num(tpl.createdAt, now),
          num(tpl.updatedAt, now),
        ],
      )
      counts.templates++
    }

    for (const [key, value] of Object.entries(data.settings || {})) {
      if (SETTING_KEYS.includes(key) && ['string', 'number', 'boolean'].includes(typeof value)) {
        store.setSetting(key, String(value))
      }
    }
  })

  queue.recoverOnStartup()
  const snapshot = store.snapshot()
  store.bus.emit('tasks:cleared', {})
  store.bus.emit('workspace:imported', snapshot)
  return { ok: true, counts, snapshot }
}

module.exports = {
  SCHEMA_VERSION,
  exportWorkspace,
  importWorkspace,
  validate,
}
