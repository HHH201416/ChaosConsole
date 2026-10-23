'use strict'

/**
 * 「混沌」—— ChaosConsole 内置的本地大模型执行器后端。
 *
 * 设计：混沌不是一个需要我们从零训练的模型（那是几千张卡的事），而是一套
 * **完全免费、完全本地** 的开源权重模型 + 本机推理引擎的组合，对外统一以
 * 「混沌」品牌呈现，像 DeepSeek 一样开箱即聊，但数据永远不出这台电脑：
 *
 *   推理引擎 —— Ollama（免费开源，Ollama 兼容 API 跑在 127.0.0.1:11434）
 *   模型权重 —— Qwen2.5 / DeepSeek-R1 蒸馏版等开源权重（Apache/MIT 免费）
 *
 * 本模块负责：
 *   1. 探测 —— 本机有没有推理服务、装了哪些模型（probe，带缓存）
 *   2. 对话 —— 流式调用 /api/chat（runChaos 在 runner.js 里消费）
 *   3. 引导 —— 一键安装引擎（下载 OllamaSetup.exe 静默安装）+ 拉取模型，
 *      进度经 store.bus 以 chaos:job / chaos:log 推给前端
 *
 * 安全边界与 toolchain.js 一致：下载 URL 写死官方 Release，绝不自动安装
 * （必须 consent:true），外部进程用参数数组 spawn，可超时、可取消。
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const store = require('./store')
const CONFIG = require('./config')

/* ------------------------------------------------------------------ *
 * 模型目录（全部是免费开源权重，对外统一「混沌」品牌）
 * ------------------------------------------------------------------ */

const CATALOG = [
  { id: 'qwen2.5:1.5b', label: '混沌 · 轻羽 1.5B', size: '约 1 GB', note: '入门首选，旧电脑也能跑，日常问答够用' },
  { id: 'qwen2.5:7b', label: '混沌 · 均衡 7B', size: '约 4.7 GB', note: '推荐：质量与速度的平衡点，建议 8GB+ 内存' },
  { id: 'qwen2.5:14b', label: '混沌 · 进阶 14B', size: '约 9 GB', note: '更强写作与代码，建议 16GB+ 内存' },
  { id: 'deepseek-r1:1.5b', label: '混沌 · 思辨 Light 1.5B', size: '约 1.1 GB', note: 'DeepSeek-R1 蒸馏版，会先推理再回答' },
  { id: 'deepseek-r1:7b', label: '混沌 · 思辨 7B', size: '约 4.7 GB', note: 'DeepSeek-R1 蒸馏版，数学与推理更强' },
]

/** 引导安装时默认拉取的模型：体积小、机器要求低、中文好 */
const DEFAULT_PULL = 'qwen2.5:1.5b'

const BASE_DEFAULT = 'http://127.0.0.1:11434'

/** Ollama 官方 Windows 安装器（GitHub Release，可走加速镜像） */
const ENGINE_URL =
  'https://github.com/ollama/ollama/releases/latest/download/OllamaSetup.exe'

function baseUrl() {
  const raw = String(process.env.CHAOS_LLM_BASE || '').trim()
  return raw || BASE_DEFAULT
}

function ollamaBin() {
  const isWin = process.platform === 'win32'
  const names = isWin ? ['ollama.exe', 'ollama'] : ['ollama']
  const dirs = []
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama'))
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'Ollama'))
  dirs.push(path.join(os.homedir(), '.local', 'bin'))
  if (process.env.PATH) dirs.push(...process.env.PATH.split(path.delimiter))
  for (const dir of dirs) {
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

/* ------------------------------------------------------------------ *
 * 探测（带正/负缓存，模式与 deveco 模型列表一致）
 * ------------------------------------------------------------------ */

const PROBE_OK_TTL = 30 * 1000
const PROBE_FAIL_TTL = 10 * 1000

let probeCache = null
let probeAt = 0
let probeInFlight = null

/**
 * 探测本地推理服务。返回 { up, models, version }。
 * models 是服务端实际已拉取的模型（[{id, size}]）。
 * 永不 reject：服务不在、超时都算 up:false。
 */
function probe({ force = false } = {}) {
  if (!force && probeCache && Date.now() - probeAt < (probeCache.up ? PROBE_OK_TTL : PROBE_FAIL_TTL)) {
    return Promise.resolve(probeCache)
  }
  if (probeInFlight) return probeInFlight

  probeInFlight = (async () => {
    let result = { up: false, models: [], version: '' }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 2500)
      const res = await fetch(`${baseUrl()}/api/tags`, { signal: controller.signal })
      clearTimeout(timer)
      if (res.ok) {
        const body = await res.json()
        const models = (Array.isArray(body?.models) ? body.models : [])
          .map((m) => ({ id: String(m?.name || ''), size: Number(m?.size) || 0 }))
          .filter((m) => m.id)
        result = { up: true, models, version: String(body?.version || '') }
      }
    } catch (_) {
      /* 服务不在 / 超时 → up:false */
    }
    probeCache = result
    probeAt = Date.now()
    probeInFlight = null
    return result
  })()

  return probeInFlight
}

function invalidate() {
  probeCache = null
  probeAt = 0
}

/** 已安装（且在目录里）的模型；服务端有目录外的模型也一并显示 */
function catalogFor(models) {
  const known = new Map(CATALOG.map((m) => [m.id, m]))
  const out = []
  for (const m of models) {
    const meta = known.get(m.id)
    out.push({
      id: m.id,
      label: meta ? meta.label : m.id,
      size: meta ? meta.size : formatBytes(m.size),
      note: meta ? meta.note : '本地已安装的模型',
      installed: true,
    })
  }
  for (const meta of CATALOG) {
    if (!out.some((m) => m.id === meta.id)) {
      out.push({ ...meta, installed: false })
    }
  }
  return out
}

function formatBytes(n) {
  if (!n) return ''
  const units = ['B', 'KB', 'MB', 'GB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `约 ${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`
}

/** 供 executors.js 用的同步快照（探测没回来时给空） */
function snapshot() {
  return probeCache || { up: false, models: [] }
}

function summary() {
  const s = snapshot()
  return {
    base: baseUrl(),
    installed: Boolean(ollamaBin()),
    serverUp: s.up,
    models: s.models,
    catalog: catalogFor(s.models),
    defaultModel: DEFAULT_PULL,
  }
}

/* ------------------------------------------------------------------ *
 * 流式对话（runner.js 的 runChaos 消费）
 * ------------------------------------------------------------------ */

/**
 * 调 /api/chat 流式生成。onDelta(deltaText) 逐段回调。
 * 返回 { text, evalCount }；失败 throw（消息里带服务端原因）。
 * signal 用于取消；支持 stopIntent 的超时/换岗中断。
 */
async function chat({ model, messages, signal, onDelta } = {}) {
  const res = await fetch(`${baseUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: true }),
    signal,
  })
  if (!res.ok || !res.body) {
    let detail = ''
    try {
      const body = await res.json()
      detail = String(body?.error || '')
    } catch (_) {
      /* ignore */
    }
    throw new Error(`混沌推理服务返回错误（HTTP ${res.status}）${detail ? `：${detail}` : ''}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  let evalCount = 0

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let payload
      try {
        payload = JSON.parse(line)
      } catch (_) {
        continue
      }
      if (payload.error) throw new Error(`混沌推理服务报错：${payload.error}`)
      const delta = payload?.message?.content
      if (typeof delta === 'string' && delta) {
        text += delta
        if (onDelta) {
          try {
            onDelta(delta)
          } catch (_) {
            /* 回调异常不影响生成 */
          }
        }
      }
      if (payload.done) {
        evalCount = Number(payload.eval_count) || 0
        // done 帧之后不会再有内容
        return { text, evalCount }
      }
    }
  }
  return { text, evalCount }
}

/* ------------------------------------------------------------------ *
 * 安装任务（引擎下载安装 + 模型拉取）
 * ------------------------------------------------------------------ */

let desktopHost = null
function setDesktopHost(host) {
  desktopHost = host || null
}

function canDownload() {
  return Boolean(desktopHost && typeof desktopHost.downloadFile === 'function')
}

let activeJob = null
const history = []

function publicJob(job) {
  if (!job) return null
  return {
    id: job.id,
    kind: job.kind, // 'engine' | 'pull'
    model: job.model || '',
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
  store.bus.emit('chaos:job', publicJob(job))
}

function jobLog(job, stream, chunk) {
  const text = String(chunk || '')
  if (!text) return
  for (const line of text.split(/\r?\n|\r/)) {
    const clean = line.trimEnd()
    if (!clean.trim()) continue
    job.log.push(`[${stream}] ${clean}`)
    if (job.log.length > 500) job.log.splice(0, job.log.length - 500)
    store.bus.emit('chaos:log', { jobId: job.id, kind: job.kind, stream, line: clean })
  }
}

function setStep(job, step, percent, message) {
  job.step = step
  job.percent = Math.max(0, Math.min(100, Math.round(percent)))
  if (message) job.message = message
  emitJob(job)
}

function killTree(child) {
  if (!child) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch (_) {
    /* ignore */
  }
}

/** 等条件成立，最多 maxMs。轮询间隔 800ms。 */
async function waitFor(fn, maxMs) {
  const deadline = Date.now() + maxMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((r) => setTimeout(r, 800))
  }
  return Boolean(await fn())
}

/** 引擎装好后确保服务在跑：不在就 detached 拉起 `ollama serve` */
async function ensureServerUp(job, bin) {
  const s = await probe({ force: true })
  if (s.up) return true

  setStep(job, '启动服务', 78, '启动混沌推理服务…')
  const logFile = path.join(CONFIG.DATA_DIR, 'chaos-llm-serve.log')
  let child
  try {
    child = spawn(bin, ['serve'], {
      windowsHide: true,
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    })
  } catch (err) {
    jobLog(job, 'err', `启动推理服务失败：${err.message}（日志：${logFile}）`)
    return false
  }
  child.unref()

  const up = await waitFor(async () => (await probe({ force: true })).up, 25 * 1000)
  if (!up) jobLog(job, 'err', `推理服务未能就绪，日志见 ${logFile}`)
  return up
}

/**
 * `ollama pull <model>`，从输出流里实时抠百分比进度。
 * ollama 的进度条用 \r 刷新、不带换行，readline 会憋到最后 —— 所以这里
 * 直接收 chunk，从滚动尾窗里抓最后一个 "NN%"。
 */
async function pullModel(job, bin, model) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['pull', model], { windowsHide: true })
    let tail = ''
    let lastPercent = -1
    let stderr = ''

    const timer = setTimeout(
      () => {
        killTree(child)
        reject(new Error('拉取模型超时（30 分钟），请检查网络后重试'))
      },
      30 * 60 * 1000,
    )

    child.stdout.on('data', (chunk) => {
      tail = (tail + chunk.toString()).slice(-2000)
      const matches = [...tail.matchAll(/(\d{1,3})%/g)]
      if (matches.length) {
        const pct = Number(matches[matches.length - 1][1])
        if (pct !== lastPercent && pct >= 0 && pct <= 100) {
          lastPercent = pct
          setStep(job, '拉取模型', pct, `下载 ${model} ${pct}%（首次需要下载，请耐心等待）`)
        }
      }
      if (/success/.test(tail)) {
        setStep(job, '完成', 100, `${model} 已就绪`)
      }
      jobLog(job, 'out', chunk.toString().replace(/\r/g, '\n').trim())
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
      jobLog(job, 'err', chunk.toString().trim())
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) {
        setStep(job, '完成', 100, `${model} 已就绪`)
        resolve(true)
      } else {
        reject(new Error(`拉取失败（退出码 ${code}）：${stderr.trim().slice(-400) || '网络中断或磁盘空间不足'}`))
      }
    })
  })
}

/** 下载引擎安装包：优先 Electron 的 downloadFile（带进度），镜像加速与更新同路 */
async function downloadEngine(job, dest) {
  let url = ENGINE_URL
  const mirror = String(store.getSetting('downloadMirror', CONFIG.DOWNLOAD_MIRROR) || '').trim()
  if (mirror && mirror.startsWith('http')) url = `${mirror}/${ENGINE_URL}`

  setStep(job, '下载', 3, '下载混沌引擎（Ollama，约几百 MB，走加速镜像）…')
  if (canDownload()) {
    const r = await desktopHost.downloadFile({
      url,
      dest,
      maxBytes: 4 * 1024 * 1024 * 1024,
      signal: job.abort.signal,
      onProgress: ({ transferred, total }) => {
        const pct = total ? (transferred / total) * 100 : 0
        setStep(job, '下载', 3 + pct * 0.5, `下载混沌引擎 ${Math.round(pct)}%`)
      },
    })
    if (!r || r.ok === false) throw new Error(r?.error || '下载失败')
    return
  }

  // 非 Electron 环境（纯后端调试）：Node fetch 兜底
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
  const buf = Buffer.from(await res.arrayBuffer())
  fs.writeFileSync(dest, buf)
}

/** 一键安装：下载安装引擎 → 起服务 → 拉默认模型 */
async function runEngineInstall(job) {
  if (!canDownload() && process.versions.electron) {
    throw new Error('当前环境不支持下载安装')
  }
  const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const downloadDir = path.join(LOCAL, 'ChaosConsole', 'toolchain', 'downloads')
  fs.mkdirSync(downloadDir, { recursive: true })
  const installer = path.join(downloadDir, 'OllamaSetup.exe')

  let bin = ollamaBin()
  if (!bin) {
    await downloadEngine(job, installer)
    setStep(job, '安装', 55, '静默安装混沌引擎（无需管理员权限）…')
    await new Promise((resolve, reject) => {
      const child = spawn(installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], {
        windowsHide: true,
      })
      let stderr = ''
      const timer = setTimeout(() => {
        killTree(child)
        reject(new Error('安装超时（15 分钟）'))
      }, 15 * 60 * 1000)
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.stderr?.on('data', (c) => {
        stderr += c.toString()
        jobLog(job, 'err', c.toString().trim())
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`安装程序退出码 ${code}：${stderr.trim().slice(-300)}`))
      })
    })
    try {
      fs.rmSync(installer, { force: true })
    } catch (_) {
      /* 占用就留着，下次覆盖 */
    }
    bin = ollamaBin()
  }
  if (!bin) {
    bin = await waitFor(() => ollamaBin(), 60 * 1000) ? ollamaBin() : ''
  }
  if (!bin) throw new Error('安装程序已运行，但没有找到混沌引擎，请重启应用后再试')

  const up = await ensureServerUp(job, bin)
  if (!up) throw new Error('混沌引擎已安装，但推理服务未能启动，请重启应用后再试')

  const installed = (await probe({ force: true })).models
  if (!installed.some((m) => m.id === DEFAULT_PULL)) {
    setStep(job, '拉取模型', 80, `下载默认模型 ${DEFAULT_PULL}…`)
    await pullModel(job, bin, DEFAULT_PULL)
  }
}

function beginJob(kind, model = '') {
  const job = {
    id: crypto.randomUUID(),
    kind,
    model,
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

function finishJob(job, patch) {
  Object.assign(job, patch)
  job.finishedAt = Date.now()
  if (job.status === 'running') job.status = 'done'
  if (activeJob === job) activeJob = null
  history.unshift(publicJob(job))
  if (history.length > 10) history.length = 10
  emitJob(job)
  invalidate()
}

function startInstall({ consent } = {}) {
  if (consent !== true) return { ok: false, error: '需要用户确认后才能安装' }
  if (activeJob) return { ok: false, error: '已有混沌安装任务进行中，请稍候' }

  const job = beginJob('engine')
  runEngineInstall(job)
    .then(() => {
      if (job.abort.signal.aborted) finishJob(job, { status: 'cancelled', message: '已取消' })
      else finishJob(job, { status: 'done', message: '混沌已就绪（引擎 + 默认模型）' })
    })
    .catch((err) => {
      if (job.abort.signal.aborted) finishJob(job, { status: 'cancelled', message: '已取消' })
      else {
        jobLog(job, 'err', err.message)
        finishJob(job, { status: 'error', error: err.message, message: '安装失败' })
      }
    })
  return { ok: true, data: publicJob(job) }
}

function startPull(model) {
  const id = String(model || '').trim()
  if (!CATALOG.some((m) => m.id === id)) return { ok: false, error: '未知的混沌模型' }
  if (activeJob) return { ok: false, error: '已有混沌任务进行中，请稍候' }
  const bin = ollamaBin()
  if (!bin) return { ok: false, error: '还没有安装混沌引擎' }

  const job = beginJob('pull', id)
  ;(async () => {
    const up = await ensureServerUp(job, bin)
    if (!up) throw new Error('推理服务未启动，请重启应用后再试')
    await pullModel(job, bin, id)
  })()
    .then(() => {
      if (job.abort.signal.aborted) finishJob(job, { status: 'cancelled', message: '已取消' })
      else finishJob(job, { status: 'done', message: `${id} 已就绪` })
    })
    .catch((err) => {
      if (job.abort.signal.aborted) finishJob(job, { status: 'cancelled', message: '已取消' })
      else {
        jobLog(job, 'err', err.message)
        finishJob(job, { status: 'error', error: err.message, message: '拉取失败' })
      }
    })
  return { ok: true, data: publicJob(job) }
}

function cancelJob(jobId) {
  if (!activeJob || (jobId && activeJob.id !== jobId)) return { ok: false, error: '没有可取消的任务' }
  activeJob.abort.abort()
  return { ok: true }
}

function status() {
  return {
    ...summary(),
    supported: canDownload() || !process.versions.electron,
    activeJob: publicJob(activeJob),
    history: history.slice(0, 10),
  }
}

async function statusAsync() {
  await probe()
  return status()
}

module.exports = {
  CATALOG,
  DEFAULT_PULL,
  baseUrl,
  ollamaBin,
  probe,
  invalidate,
  snapshot,
  summary,
  catalogFor,
  chat,
  setDesktopHost,
  startInstall,
  startPull,
  cancelJob,
  status,
  statusAsync,
  _private: { pullModel, ensureServerUp },
}
