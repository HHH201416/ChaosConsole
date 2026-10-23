'use strict'

/**
 * 8.0.0：运行环境 / 工具链管理器。
 *
 * 负责检测与「一键安装」：
 *   - Node.js（便携版，装到 %LOCALAPPDATA%\ChaosConsole\toolchain，不改系统 PATH）
 *   - Claude Code CLI（npm 全局装到应用自己的 prefix）
 *   - DevEco Code CLI（同上）
 *   - DevEco Studio（winget 官方包；需要 UAC 和华为账号，失败回退到官网）
 *
 * 安全边界：
 *   - 工具 ID、版本、URL、winget ID 全部写死；用户输入只用于选择白名单里的 id。
 *   - 下载走注入的 desktopHost（Electron 的 electron.net.fetch），带校验和。
 *   - 外部进程用参数数组 spawn，超时/取消会杀掉整棵进程树。
 *   - 绝不自动安装；每次安装都必须带 consent:true。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')

const store = require('./store')
const runner = require('./runner')
const executors = require('./executors')
const { runAsync } = require('./exec-util')

const NODE_VERSION = '24.15.0'
const CLAUDE_PACKAGE = '@anthropic-ai/claude-code'
const CLAUDE_VERSION = '2.1.303'
const DEVECO_CLI_PACKAGE = '@deveco/deveco-code'
const DEVECO_CLI_VERSION = '0.2.4'
const STUDIO_WINGET_ID = 'Huawei.DevEco'
const STUDIO_URL = 'https://developer.huawei.com/consumer/cn/deveco-studio/'

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const TOOLCHAIN_ROOT = path.join(LOCAL, 'ChaosConsole', 'toolchain')
const NODE_DIR = path.join(TOOLCHAIN_ROOT, `node-v${NODE_VERSION}-win-x64`)
const NPM_PREFIX = path.join(TOOLCHAIN_ROOT, 'npm-global')
const DOWNLOAD_DIR = path.join(TOOLCHAIN_ROOT, 'downloads')
const NODE_ZIP = `node-v${NODE_VERSION}-win-x64.zip`
const NODE_BASE = `https://nodejs.org/dist/v${NODE_VERSION}`
const NODE_ZIP_URL = `${NODE_BASE}/${NODE_ZIP}`
const NODE_SHASUM_URL = `${NODE_BASE}/SHASUMS256.txt`

const TOOLS = {
  node: {
    id: 'node',
    label: 'Node.js',
    version: NODE_VERSION,
    size: '约 30 MB',
    requiresElevation: false,
    requiresAccount: false,
    note: '装到应用自己的目录，不改系统 PATH。',
  },
  claude: {
    id: 'claude',
    label: 'Claude Code CLI',
    version: CLAUDE_VERSION,
    size: '约 20 MB',
    requiresElevation: false,
    requiresAccount: false,
    note: 'npm 全局安装到应用自己的 prefix；需要 Node.js。',
  },
  'deveco-cli': {
    id: 'deveco-cli',
    label: 'DevEco Code CLI',
    version: DEVECO_CLI_VERSION,
    size: '约 10 MB',
    requiresElevation: false,
    requiresAccount: false,
    note: 'npm 全局安装到应用自己的 prefix；需要 Node.js。',
  },
  'deveco-studio': {
    id: 'deveco-studio',
    label: 'DevEco Studio',
    version: '',
    size: '约 1.5 GB',
    requiresElevation: true,
    requiresAccount: true,
    note: '通过 winget 安装官方包；需要 UAC，首次启动需要华为账号登录。',
  },
}
const TOOL_IDS = Object.keys(TOOLS)

let desktopHost = null
let detectionCache = null
let detectionAt = 0
const DETECT_TTL = 30 * 1000

let activeJob = null
const history = []

function setDesktopHost(host) {
  desktopHost = host || null
}

function supported() {
  return Boolean(desktopHost && typeof desktopHost.downloadFile === 'function')
}

function ensureDirs() {
  for (const dir of [TOOLCHAIN_ROOT, NPM_PREFIX, DOWNLOAD_DIR]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

function isFile(p) {
  try {
    return Boolean(p) && fs.existsSync(p) && fs.statSync(p).isFile()
  } catch (_) {
    return false
  }
}

function findBin(names, extraDirs = []) {
  const dirs = [...extraDirs]
  if (process.env.PATH) dirs.push(...process.env.PATH.split(path.delimiter))
  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (isFile(candidate)) return candidate
    }
  }
  return ''
}

async function versionOf(bin, args = ['--version']) {
  if (!bin) return ''
  const r = await runAsync(bin, args, { timeout: 10000 })
  const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim()
  if (!text) return ''
  return text.split(/\r?\n/).find((line) => line.trim())?.trim() || ''
}

function studioVersion(dir) {
  const files = ['product-info.json', 'build.txt']
  for (const name of files) {
    const file = path.join(dir, name)
    if (!isFile(file)) continue
    try {
      const raw = fs.readFileSync(file, 'utf8')
      if (name.endsWith('.json')) {
        const info = JSON.parse(raw)
        return info.version || info.buildNumber || info.productVersion || ''
      }
      return raw.trim().split(/\r?\n/)[0] || ''
    } catch (_) {
      /* ignore */
    }
  }
  return ''
}

/** 把应用私有的 Node/npm 目录放到子进程 PATH 最前面（不改系统环境） */
function applyPath() {
  const parts = [NPM_PREFIX, NODE_DIR].filter((p) => fs.existsSync(p))
  if (!parts.length) return
  const current = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const next = [...parts, ...current.filter((p) => !parts.includes(p))]
  process.env.PATH = next.join(path.delimiter)
}

function sourceOf(bin) {
  if (!bin) return 'unknown'
  return bin.startsWith(TOOLCHAIN_ROOT) ? 'toolchain' : 'system'
}

async function detect(force = false) {
  if (!force && detectionCache && Date.now() - detectionAt < DETECT_TTL) return detectionCache
  applyPath()

  const isWin = process.platform === 'win32'
  const nodeBin = findBin(isWin ? ['node.exe', 'node'] : ['node'], [
    NODE_DIR,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  ])
  const npmBin = findBin(isWin ? ['npm.cmd', 'npm.exe', 'npm'] : ['npm'], [
    NODE_DIR,
    path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  ])
  const claudeBin = runner.resolveClaudeBin()
  const devecoBin = executors.resolveDevecoBin()
  const tools = executors.resolveDevecoTools()
  const wingetBin = findBin(
    isWin ? ['winget.exe'] : ['winget'],
    [path.join(LOCAL, 'Microsoft', 'WindowsApps')],
  )

  const [nodeVersion, npmVersion, claudeVersion, devecoVersion] = await Promise.all([
    versionOf(nodeBin, ['-v']),
    versionOf(npmBin, ['-v']),
    versionOf(claudeBin, ['--version']),
    versionOf(devecoBin, ['--version']),
  ])

  const data = {
    supported: supported(),
    detectedAt: Date.now(),
    root: TOOLCHAIN_ROOT,
    nodePrefix: NPM_PREFIX,
    winget: Boolean(wingetBin),
    tools: {
      node: {
        ...TOOLS.node,
        installed: Boolean(nodeBin),
        version: nodeVersion || (nodeBin ? '' : ''),
        path: nodeBin,
        source: sourceOf(nodeBin),
        npm: npmBin,
        npmVersion,
      },
      claude: {
        ...TOOLS.claude,
        installed: Boolean(claudeBin),
        version: claudeVersion || '',
        path: claudeBin,
        source: sourceOf(claudeBin),
      },
      'deveco-cli': {
        ...TOOLS['deveco-cli'],
        installed: Boolean(devecoBin),
        version: devecoVersion || '',
        path: devecoBin,
        source: sourceOf(devecoBin),
      },
      'deveco-studio': {
        ...TOOLS['deveco-studio'],
        installed: Boolean(tools.found),
        version: tools.found ? studioVersion(tools.studio) : '',
        path: tools.studio || '',
        source: tools.found ? 'system' : 'unknown',
        tools: {
          hvigorw: tools.hvigorw,
          hdc: tools.hdc,
          ohpm: tools.ohpm,
          sdk: tools.sdk,
        },
      },
    },
  }
  detectionCache = data
  detectionAt = Date.now()
  return data
}

function invalidate() {
  detectionCache = null
  detectionAt = 0
  runner.setClaudeBin(null)
  executors.invalidateCaches()
  applyPath()
  store.bus.emit('toolchain:changed', { at: Date.now() })
}

/* ------------------------------------------------------------------ *
 * 安装任务
 * ------------------------------------------------------------------ */

function uid() {
  return crypto.randomUUID()
}

function publicJob(job) {
  if (!job) return null
  return {
    id: job.id,
    tool: job.tool,
    status: job.status,
    step: job.step,
    percent: job.percent,
    message: job.message,
    error: job.error || '',
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
    log: job.log.slice(-300),
  }
}

function emitJob(job) {
  store.bus.emit('toolchain:job', publicJob(job))
}

function log(job, stream, chunk) {
  const text = String(chunk || '')
  if (!text) return
  for (const line of text.split(/\r?\n/)) {
    const clean = line.trimEnd()
    if (!clean.trim()) continue
    job.log.push(`[${stream}] ${clean}`)
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500)
    store.bus.emit('toolchain:log', { jobId: job.id, tool: job.tool, stream, line: clean })
  }
}

function setStep(job, step, percent, message) {
  job.step = step
  job.percent = Math.max(0, Math.min(100, Math.round(percent)))
  job.message = message
  emitJob(job)
}

function begin(tool) {
  const job = {
    id: uid(),
    tool,
    status: 'running',
    step: '准备',
    percent: 0,
    message: '准备中…',
    error: '',
    startedAt: Date.now(),
    finishedAt: null,
    log: [],
    abort: new AbortController(),
  }
  activeJob = job
  emitJob(job)
  return job
}

function finish(job, patch) {
  Object.assign(job, patch)
  job.finishedAt = Date.now()
  if (job.status === 'running') job.status = 'done'
  activeJob = null
  history.unshift(publicJob(job))
  if (history.length > 10) history.length = 10
  emitJob(job)
  if (job.status === 'done') invalidate()
}

async function download(job, url, dest, expected) {
  if (!desktopHost?.downloadFile) throw new Error('当前环境不支持下载（需要 Electron 主进程）')
  const r = await desktopHost.downloadFile({
    url,
    dest,
    sha256: expected?.sha256,
    sha512: expected?.sha512,
    maxBytes: expected?.maxBytes,
    signal: job.abort.signal,
    onProgress: ({ transferred, total, percent }) => {
      const pct = total ? (transferred / total) * 100 : percent || 0
      setStep(job, '下载', 10 + pct * 0.5, `下载 ${path.basename(dest)} ${Math.round(pct)}%`)
    },
  })
  if (!r || r.ok === false) throw new Error(r?.error || '下载失败')
  return r
}

async function installNode(job) {
  ensureDirs()
  const zip = path.join(DOWNLOAD_DIR, NODE_ZIP)
  const shasums = path.join(DOWNLOAD_DIR, 'SHASUMS256.txt')

  setStep(job, '下载', 5, '下载 Node.js 校验清单…')
  await download(job, NODE_SHASUM_URL, shasums, { maxBytes: 1024 * 1024 })
  const text = fs.readFileSync(shasums, 'utf8')
  const line = text
    .split(/\r?\n/)
    .find((l) => l.trim().endsWith(`  ${NODE_ZIP}`) || l.trim().endsWith(` *${NODE_ZIP}`))
  const sha256 = line ? line.trim().split(/\s+/)[0] : ''
  if (!sha256) throw new Error('官方校验清单里找不到 Node.js 安装包')

  setStep(job, '下载', 10, '下载 Node.js…')
  await download(job, NODE_ZIP_URL, zip, { sha256, maxBytes: 200 * 1024 * 1024 })

  setStep(job, '解压', 65, '解压 Node.js…')
  if (fs.existsSync(NODE_DIR)) fs.rmSync(NODE_DIR, { recursive: true, force: true })
  const tar = await runAsync('tar', ['-xf', zip, '-C', TOOLCHAIN_ROOT], {
    timeout: 5 * 60 * 1000,
    signal: job.abort.signal,
    onStdout: (c) => log(job, 'out', c),
    onStderr: (c) => log(job, 'err', c),
  })
  if (tar.status !== 0 || !isFile(path.join(NODE_DIR, 'node.exe'))) {
    throw new Error(`解压失败：${tar.stderr || tar.status}`)
  }
  applyPath()
  setStep(job, '完成', 100, 'Node.js 已就绪')
}

async function installNpmTool(job, pkg, binNames) {
  const npmBin = findBin(['npm.cmd', 'npm.exe', 'npm'], [NODE_DIR, path.join(process.env.APPDATA || '', 'npm')])
  if (!npmBin) throw new Error('没有找到 npm，请先安装 Node.js')
  ensureDirs()
  setStep(job, '安装', 35, `npm install -g ${pkg}…`)
  const r = await runAsync(
    npmBin,
    ['install', '-g', '--prefix', NPM_PREFIX, pkg, '--no-fund', '--no-audit'],
    {
      cwd: TOOLCHAIN_ROOT,
      timeout: 10 * 60 * 1000,
      signal: job.abort.signal,
      env: {
        PATH: [NPM_PREFIX, NODE_DIR, process.env.PATH || ''].join(path.delimiter),
        npm_config_prefix: NPM_PREFIX,
      },
      onStdout: (c) => log(job, 'out', c),
      onStderr: (c) => log(job, 'err', c),
    },
  )
  if (r.cancelled) return false
  if (r.status !== 0) throw new Error(`安装失败（退出码 ${r.status}）：${(r.stderr || '').slice(-600)}`)
  applyPath()
  const bin = findBin(binNames, [NPM_PREFIX])
  if (!bin) throw new Error('安装命令返回成功，但找不到可执行文件')
  setStep(job, '完成', 100, `已安装到 ${bin}`)
  return bin
}

async function installStudio(job) {
  const winget = findBin(['winget.exe', 'winget'])
  if (!winget) {
    setStep(job, '需要手动操作', 20, '未检测到 winget，已打开官方下载页。')
    await desktopHost?.openExternal?.(STUDIO_URL)
    return { ok: true, needsUserAction: true }
  }
  setStep(job, '安装', 25, '正在通过 winget 安装 DevEco Studio（可能弹出 UAC）…')
  const r = await runAsync(
    winget,
    [
      'install',
      '--id',
      STUDIO_WINGET_ID,
      '--exact',
      '--accept-package-agreements',
      '--accept-source-agreements',
      '--silent',
    ],
    {
      timeout: 30 * 60 * 1000,
      signal: job.abort.signal,
      onStdout: (c) => log(job, 'out', c),
      onStderr: (c) => log(job, 'err', c),
    },
  )
  if (r.cancelled) return { ok: false, cancelled: true }
  if (r.status !== 0) {
    const detail = `${r.stdout || ''}\n${r.stderr || ''}`.trim().slice(-800)
    setStep(job, '需要手动操作', 40, 'winget 安装未完成，已打开官方页面。')
    await desktopHost?.openExternal?.(STUDIO_URL)
    return {
      ok: false,
      needsUserAction: true,
      error: `winget 安装未完成（退出码 ${r.status}）。可能需要 UAC 权限或华为账号。\n${detail}`,
    }
  }
  setStep(job, '完成', 100, 'DevEco Studio 已安装，首次启动需要华为账号登录。')
  return { ok: true, needsUserAction: true }
}

async function runInstall(job) {
  if (job.tool === 'node') {
    if (isFile(path.join(NODE_DIR, 'node.exe'))) {
      setStep(job, '完成', 100, 'Node.js 已存在')
      return
    }
    await installNode(job)
    return
  }

  if (job.tool === 'claude' || job.tool === 'deveco-cli') {
    const hasNode = findBin(['node.exe', 'node'], [NODE_DIR, path.join(process.env.APPDATA || '', 'npm')])
    if (!hasNode) {
      setStep(job, '安装 Node.js', 5, '先安装 Node.js…')
      await installNode(job)
    }
    setStep(job, '安装', 30, `安装 ${job.tool === 'claude' ? 'Claude Code' : 'DevEco Code'}…`)
    const pkg =
      job.tool === 'claude'
        ? `${CLAUDE_PACKAGE}@${CLAUDE_VERSION}`
        : `${DEVECO_CLI_PACKAGE}@${DEVECO_CLI_VERSION}`
    const names = job.tool === 'claude' ? ['claude.cmd', 'claude.exe', 'claude'] : ['deveco.cmd', 'deveco.exe', 'deveco']
    await installNpmTool(job, pkg, names)
    return
  }

  if (job.tool === 'deveco-studio') {
    const result = await installStudio(job)
    if (result && result.cancelled) return
    if (result && result.ok === false) throw new Error(result.error)
    return
  }

  throw new Error('未知的工具')
}

function startInstall(tool, { consent } = {}) {
  if (!TOOL_IDS.includes(tool)) return { ok: false, error: '未知的工具' }
  if (consent !== true) return { ok: false, error: '需要用户确认后才能安装' }
  if (!supported() && tool !== 'deveco-studio') {
    return { ok: false, error: '当前环境不支持下载安装（需要 Electron 主进程）' }
  }
  if (activeJob) return { ok: false, error: '已有安装任务进行中，请稍候' }

  const job = begin(tool)
  runInstall(job)
    .then(() => {
      if (job.abort.signal.aborted) {
        finish(job, { status: 'cancelled', message: '已取消' })
      } else {
        finish(job, { status: 'done', message: `${TOOLS[tool].label} 安装完成` })
      }
    })
    .catch((err) => {
      if (job.abort.signal.aborted) {
        finish(job, { status: 'cancelled', message: '已取消' })
      } else {
        log(job, 'err', err.message)
        finish(job, { status: 'error', error: err.message, message: '安装失败' })
      }
    })

  return { ok: true, data: publicJob(job) }
}

function cancel(jobId) {
  if (!activeJob || (jobId && activeJob.id !== jobId)) return { ok: false, error: '没有可取消的任务' }
  activeJob.abort.abort()
  return { ok: true }
}

function status() {
  return {
    supported: supported(),
    tools: detectionCache?.tools || null,
    activeJob: publicJob(activeJob),
    history: history.slice(0, 10),
    root: TOOLCHAIN_ROOT,
    nodePrefix: NPM_PREFIX,
  }
}

module.exports = {
  TOOL_IDS,
  TOOLCHAIN_ROOT,
  NPM_PREFIX,
  setDesktopHost,
  supported,
  detect,
  invalidate,
  startInstall,
  cancel,
  status,
  // 供测试
  _private: { versionOf, studioVersion, applyPath, findBin },
}
