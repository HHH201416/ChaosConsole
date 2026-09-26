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

/** 上一次真正去跑 `deveco models` 的时间，用来做失败时的负缓存 */
let devecoLastAttemptAt = 0
/**
 * 拿不到模型时的重试间隔。
 *
 * 以前只有「成功」才会写缓存，失败一律不记；而 execute() 在每个没有模型的
 * deveco 回合里都会 await 一次 refreshDevecoModels()，于是每个回合都要白等
 * 2~30 秒起一个注定失败的子进程。这里给它加一个短负缓存：
 * 一分钟内不重复尝试，既不拖慢回合，也不会永久放弃。
 */
const DEVECO_NEGATIVE_TTL_MS = 60 * 1000

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

/* ------------------------------------------------------------------ *
 * DevEco Studio 工具链
 *
 * 装了 DevEco Studio 的机器上，hvigorw / hdc / ohpm 都在安装目录里，但 Studio
 * 默认不把它们加进 PATH。结果是 Agent 明明可以构建、可以连设备，却因为敲不到
 * 命令而干不成事。这里统一探一遍，结果会写进 DevEco Agent 的提示词。
 * ------------------------------------------------------------------ */

const DEVECO_TOOLS_TTL_MS = 5 * 60 * 1000
let devecoToolsCache = null
let devecoToolsAt = 0

const DEVECO_STUDIO_CANDIDATES = [
  process.env.CHAOS_DEVECO_STUDIO,
  'D:\\DevEco Studio',
  'C:\\Program Files\\Huawei\\DevEco Studio',
  path.join(os.homedir(), 'DevEco Studio'),
].filter(Boolean)

function isFile(p) {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile()
  } catch (_) {
    return false
  }
}

function resolveDevecoTools() {
  if (devecoToolsCache && Date.now() - devecoToolsAt < DEVECO_TOOLS_TTL_MS) return devecoToolsCache

  const isWin = process.platform === 'win32'
  const out = { found: false, studio: '', studioExe: '', hvigorw: '', hdc: '', ohpm: '', sdk: '' }
  const firstFile = (...cands) => cands.find((p) => isFile(p)) || ''

  for (const root of DEVECO_STUDIO_CANDIDATES) {
    if (!root || !fs.existsSync(root)) continue
    out.studio = root
    out.studioExe = firstFile(
      path.join(root, 'bin', isWin ? 'devecostudio64.exe' : 'devecostudio'),
      path.join(root, 'bin', 'devecostudio.bat'),
    )
    out.hvigorw = firstFile(
      path.join(root, 'tools', 'hvigor', 'bin', isWin ? 'hvigorw.bat' : 'hvigorw'),
      path.join(root, 'tools', 'hvigor', 'bin', 'hvigorw'),
    )
    out.ohpm = firstFile(path.join(root, 'tools', 'ohpm', 'bin', isWin ? 'ohpm.bat' : 'ohpm'))
    out.hdc = firstFile(
      path.join(root, 'sdk', 'default', 'openharmony', 'toolchains', isWin ? 'hdc.exe' : 'hdc'),
    )
    const sdkDir = path.join(root, 'sdk')
    if (fs.existsSync(sdkDir)) out.sdk = sdkDir
    out.found = true
    break
  }

  devecoToolsCache = out
  devecoToolsAt = Date.now()
  return out
}

/**
 * 给 DevEco Agent 的环境说明。拼进提示词，免得每个回合都浪费一轮去找命令。
 * 没探到 Studio 时返回空串，让 Agent 按自己的判断来。
 */
function devecoEnvNote() {
  const t = resolveDevecoTools()
  if (!t.found) return ''
  const lines = ['## 本机 DevEco 工具链', 'DevEco Studio 没有把这些命令加进 PATH，用绝对路径调用：']
  if (t.hvigorw) lines.push(`- 构建：\`"${t.hvigorw}" assembleHap --mode module -p product=default\`（在工程根目录执行）`)
  if (t.ohpm) lines.push(`- 依赖：\`"${t.ohpm}" install\``)
  if (t.hdc) lines.push(`- 设备：\`"${t.hdc}" list targets\`、\`"${t.hdc}" install <hap 路径>\`、\`"${t.hdc}" hilog\``)
  if (t.studioExe) lines.push(`- 打开 IDE：\`"${t.studioExe}" <工程目录>\``)
  if (t.sdk) lines.push(`- SDK：${t.sdk}`)
  return lines.join('\n')
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
  if (!force) {
    // 正缓存：拿到过模型，5 分钟内直接复用
    if (devecoModelsCache && Date.now() - devecoModelsAt < DEVECO_CACHE_MS) {
      return Promise.resolve(devecoModelsCache)
    }
    // 负缓存：上一次什么都没拿到，一分钟内不再重试（见 DEVECO_NEGATIVE_TTL_MS）
    if (!devecoModelsCache && Date.now() - devecoLastAttemptAt < DEVECO_NEGATIVE_TTL_MS) {
      return Promise.resolve([])
    }
  }
  if (devecoRefreshInFlight) return devecoRefreshInFlight

  devecoLastAttemptAt = Date.now()
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

/**
 * 模型 id 白名单校验。
 *
 * 模型值来自任务 / 员工记录，而这两处都能被 HTTP API 直接改写（PATCH），
 * 最终它会进 argv；Windows 上两个 CLI 都是经 cmd.exe 转发的（shell: true），
 * 没校验的值等于把 shell 交给了调用方。所以这里只放行认识的 id。
 */
function isValidModel(executor, model) {
  const id = String(model || '').trim()
  if (!id) return false

  if (executor === 'deveco') {
    // deveco 的模型是 vendor/model 形式，列表是动态拉的
    if (!/^[\w.-]+\/[\w.-]+$/.test(id)) return false
    const known = listDevecoModels()
    // 列表还没拉回来时无法比对，放行形式合法的值即可（正则已挡掉危险字符）
    return known.length === 0 || known.some((m) => m.id === id)
  }

  return CLAUDE_MODELS.some((m) => m.id === id)
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
  isValidModel,
  resolveDevecoBin,
  devecoAvailable,
  resolveDevecoTools,
  devecoEnvNote,
  listDevecoModels,
  refreshDevecoModels,
  warmup,
}
