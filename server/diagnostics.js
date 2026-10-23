'use strict'

/**
 * 8.0.0：健康检查与诊断。
 *
 * 只汇总「能帮助排查问题」的信息，绝不出现在何令牌/授权码。
 * 错误进一个有上限的环形缓冲，导出时统一做一遍脱敏。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const CONFIG = require('./config')
const db = require('./db')
const store = require('./store')
const runner = require('./runner')
const executors = require('./executors')
const mcp = require('./mcp')
const backup = require('./backup')

const MAX_ERRORS = 100
const errors = []
let context = {}

function setContext(next = {}) {
  context = { ...context, ...next }
}

function redact(input) {
  let text = String(input === undefined || input === null ? '' : input)
  if (CONFIG.AUTH_CODE) text = text.split(CONFIG.AUTH_CODE).join('[REDACTED]')
  text = text.replace(/token=[^&\s"']+/gi, 'token=[REDACTED]')
  text = text.replace(/x-chaos-token[^,;\n]*/gi, 'x-chaos-token=[REDACTED]')
  return text
}

function recordError(scope, err) {
  errors.push({
    at: Date.now(),
    scope: redact(scope),
    message: redact(err && err.message ? err.message : err),
  })
  if (errors.length > MAX_ERRORS) errors.splice(0, errors.length - MAX_ERRORS)
}

function fileSize(file) {
  try {
    return fs.statSync(file).size
  } catch (_) {
    return 0
  }
}

function diskInfo() {
  try {
    const st = fs.statfsSync(CONFIG.DATA_DIR)
    const total = Number(st.blocks) * Number(st.bsize)
    const free = Number(st.bavail) * Number(st.bsize)
    return { total, free }
  } catch (_) {
    return { total: 0, free: 0 }
  }
}

function writable() {
  try {
    fs.accessSync(CONFIG.DATA_DIR, fs.constants.W_OK)
    return true
  } catch (_) {
    return false
  }
}

function safeSettings() {
  const keys = [
    'permissionMode',
    'autoUpdateWhenIdle',
    'downloadMirror',
    'pipelineEnabled',
    'maxAttempts',
    'dispatchStrategy',
    'uiLanguage',
    'accent',
    'trayEnabled',
    'closeToTray',
    'backupEnabled',
    'backupIntervalHours',
    'backupRetention',
  ]
  const out = {}
  for (const key of keys) out[key] = store.getSetting(key, null)
  return out
}

function snapshot() {
  const agents = store.listAgents()
  const tasks = store.listTasks()
  const backups = backup.list()
  const disk = diskInfo()
  const dbSize = fileSize(CONFIG.DB_FILE)
  const claudeBin = runner.resolveClaudeBin()
  const devecoBin = executors.resolveDevecoBin()
  const devecoTools = executors.resolveDevecoTools()
  const mcpSummary = mcp.summary()
  const wsClients = context.getWsClients ? context.getWsClients() : 0
  const lastBackup = backups[0] || null

  const checks = []
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail })

  add('db', '数据库文件', fs.existsSync(CONFIG.DB_FILE) ? 'ok' : 'warn', CONFIG.DB_FILE)
  add('data-writable', '数据目录可写', writable() ? 'ok' : 'error', CONFIG.DATA_DIR)
  add(
    'disk',
    '磁盘空间',
    !disk.total ? 'warn' : disk.free > 200 * 1024 * 1024 ? 'ok' : 'warn',
    disk.total ? `${(disk.free / 1024 ** 3).toFixed(1)} GB 可用` : '无法读取',
  )
  add('claude', 'Claude Code CLI', claudeBin ? 'ok' : 'warn', claudeBin || '未检测到')
  add('deveco', 'DevEco Code CLI', devecoBin ? 'ok' : 'warn', devecoBin || '未检测到')
  add(
    'deveco-studio',
    'DevEco Studio 工具链',
    devecoTools.found ? 'ok' : 'warn',
    devecoTools.studio || '未检测到 Studio',
  )
  add('ws', '实时连接', wsClients > 0 ? 'ok' : 'warn', `${wsClients} 个客户端`)
  add(
    'backup',
    '自动备份',
    store.getSetting('backupEnabled', '1') !== '1'
      ? 'warn'
      : lastBackup && Date.now() - lastBackup.createdAt < 48 * 3600 * 1000
        ? 'ok'
        : 'warn',
    lastBackup ? `${lastBackup.name}（${new Date(lastBackup.createdAt).toLocaleString()}）` : '还没有备份',
  )

  return {
    generatedAt: Date.now(),
    app: {
      version: require('../package.json').version,
      electron: process.versions.electron || null,
      node: process.versions.node,
      chromium: process.versions.chrome || null,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
    },
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      totalMem: os.totalmem(),
      freeMem: os.freemem(),
    },
    server: {
      port: context.getPort ? context.getPort() : null,
      isElectron: Boolean(process.versions.electron),
      wsClients,
      update: context.getUpdateStatus ? context.getUpdateStatus() : null,
    },
    data: {
      dir: CONFIG.DATA_DIR,
      dbFile: CONFIG.DB_FILE,
      dbSize,
      writable: writable(),
      backupsDir: backup.DIR,
      backups: backups.length,
      lastBackup,
      disk,
    },
    counts: {
      agents: agents.length,
      tasks: tasks.length,
      running: tasks.filter((t) => t.runState === 'running' || t.runState === 'queued').length,
      blocked: tasks.filter((t) => t.blocked).length,
      messages: Number((db.get('SELECT COUNT(*) AS n FROM messages') || {}).n) || 0,
      events: Number((db.get('SELECT COUNT(*) AS n FROM events') || {}).n) || 0,
      templates: store.listTemplates().length,
    },
    executors: {
      claude: { bin: claudeBin, available: runner.claudeAvailable() },
      deveco: { bin: devecoBin, available: executors.devecoAvailable(), tools: devecoTools },
      all: executors.describe(),
    },
    mcp: mcpSummary,
    settings: safeSettings(),
    checks,
    recentErrors: errors.slice(-MAX_ERRORS),
  }
}

function exportJson() {
  return JSON.stringify(
    { kind: 'chaosconsole-diagnostics', exportedAt: new Date().toISOString(), ...snapshot() },
    null,
    2,
  )
}

module.exports = {
  setContext,
  recordError,
  snapshot,
  exportJson,
  redact,
}
