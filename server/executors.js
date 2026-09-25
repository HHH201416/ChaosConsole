'use strict'

/**
 * 执行器（Executor）注册表。
 *
 * 一个「员工」最终是由某个 CLI 拉起去干活的。目前支持两种：
 *
 *   claude  —— Anthropic Claude Code CLI
 *   deveco  —— 华为 DevEco Code CLI（@deveco/deveco-code）
 *
 * 两者的命令行接口、事件流格式、模型命名体系完全不同，所以各自有独立的
 * 适配器（见 runner.js）。这个模块只负责回答「有哪些执行器、各自能用哪些
 * 模型、装没装」。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')

const CONFIG = require('./config')

/* ------------------------------------------------------------------ *
 * Claude
 * ------------------------------------------------------------------ */

/** claude --model 接受别名，用别名比写全名更抗版本升级 */
const CLAUDE_MODELS = [
  { id: 'opus', label: 'Opus · 最强推理' },
  { id: 'sonnet', label: 'Sonnet · 均衡' },
  { id: 'fable', label: 'Fable · 最新' },
  { id: 'haiku', label: 'Haiku · 最快' },
]

/* ------------------------------------------------------------------ *
 * DevEco Code
 * ------------------------------------------------------------------ */

let devecoModelsCache = null
let devecoModelsAt = 0
const DEVECO_CACHE_MS = 5 * 60 * 1000

function resolveDevecoBin() {
  if (process.env.CHAOS_DEVECO_BIN && fs.existsSync(process.env.CHAOS_DEVECO_BIN)) {
    return process.env.CHAOS_DEVECO_BIN
  }
  const isWin = process.platform === 'win32'
  const names = isWin ? ['deveco.cmd', 'deveco.exe', 'deveco'] : ['deveco']
  const dirs = []
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
  dirs.push(path.join(os.homedir(), '.local', 'bin'))
  if (process.env.PATH) dirs.push(...process.env.PATH.split(path.delimiter))

  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
      } catch (_) {
        /* ignore */
      }
    }
  }
  return ''
}

function devecoAvailable() {
  return Boolean(resolveDevecoBin())
}

/** 直接从缓存取，不会阻塞（缓存为空就先返回空数组，后台会补上） */
function listDevecoModels() {
  return devecoModelsCache || []
}

let devecoRefreshInFlight = null

/**
 * 异步刷新 deveco 模型列表。
 *
 * 必须异步：`deveco models` 要起一个 node 进程（实测 2~5 秒）。之前用的是
 * execFileSync，会把整个 Node 事件循环按住 —— 于是 /api/system 一被请求，
 * /api/state 也跟着卡住，表现为登录后侧边栏好几秒是空的。
 */
function refreshDevecoModels({ force = false } = {}) {
  if (!force && devecoModelsCache && Date.now() - devecoModelsAt < DEVECO_CACHE_MS) {
    return Promise.resolve(devecoModelsCache)
  }
  if (devecoRefreshInFlight) return devecoRefreshInFlight

  const bin = resolveDevecoBin()
  if (!bin) return Promise.resolve([])

  devecoRefreshInFlight = new Promise((resolve) => {
    let settled = false
    const finish = (models) => {
      if (settled) return
      settled = true
      devecoRefreshInFlight = null
      resolve(models)
    }

    let child
    try {
      child = spawn(bin, ['models'], { windowsHide: true, shell: process.platform === 'win32' })
    } catch (err) {
      console.error('[executors] 启动 deveco models 失败:', err.message)
      return finish([])
    }

    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      finish(devecoModelsCache || [])
    }, 30000)

    child.stdout?.on('data', (c) => {
      out += c.toString()
    })
    child.stderr?.on('data', () => {})
    child.on('error', () => {
      clearTimeout(timer)
      finish(devecoModelsCache || [])
    })
    child.on('close', () => {
      clearTimeout(timer)
      const models = out
        .split('\n')
        .map((l) => l.replace(/\u001b\[[0-9;]*m/g, '').trim())
        .filter((l) => /^[\w.-]+\/[\w.-]+$/.test(l))
        .map((id) => ({ id, label: id }))

      if (models.length) {
        devecoModelsCache = models
        devecoModelsAt = Date.now()
      }
      finish(devecoModelsCache || [])
    })
  })

  return devecoRefreshInFlight
}

/** 启动时在后台预热一次，避免第一次打开设置页时模型列表是空的 */
function warmup() {
  Promise.all([refreshDevecoModels()]).catch(() => {
    /* ignore */
  })
}

/* ------------------------------------------------------------------ *
 * 汇总
 * ------------------------------------------------------------------ */

const EXECUTORS = [
  {
    id: 'claude',
    label: 'Claude Code',
    hint: 'Anthropic 官方 CLI，事件流为 stream-json',
    models: () => CLAUDE_MODELS,
    available: () => Boolean(require('./runner').resolveClaudeBin()),
  },
  {
    id: 'deveco',
    label: 'DevEco Code',
    hint: '华为 DevEco Code CLI，事件流为 NDJSON',
    models: () => listDevecoModels(),
    available: devecoAvailable,
  },
]

const EXECUTOR_IDS = EXECUTORS.map((e) => e.id)

function isValidExecutor(id) {
  return EXECUTOR_IDS.includes(id)
}

/** 供 /api/system 与前端下拉框使用 */
function describe() {
  return EXECUTORS.map((e) => ({
    id: e.id,
    label: e.label,
    hint: e.hint,
    available: e.available(),
    models: e.models(),
  }))
}

/** 取某个执行器的默认模型（用户没指定员工模型时用） */
function defaultModel(executor) {
  const e = EXECUTORS.find((x) => x.id === executor)
  if (!e) return null
  const models = e.models()
  return models.length ? models[0].id : null
}

module.exports = {
  EXECUTORS,
  EXECUTOR_IDS,
  CLAUDE_MODELS,
  isValidExecutor,
  describe,
  defaultModel,
  resolveDevecoBin,
  devecoAvailable,
  listDevecoModels,
  refreshDevecoModels,
  warmup,
}
