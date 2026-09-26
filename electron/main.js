'use strict'

/**
 * Electron 主进程。
 *
 * 职责：
 *  1. 在进程内启动后端（Express + WS + SQLite），前端通过 HTTP 访问它。
 *  2. 开一个窗口加载前端：开发时是 Vite devServer，打包后是后端自己托管的 dist/。
 *  3. 接 electron-updater，实现「检查更新 → 下载 → 重启安装」。
 *
 * 为什么让后端跑在主进程里而不是单独 spawn 一个 node：
 *   打包后的机器上没有 node，而 Electron 自带的 node 就是这个进程。
 *   同进程启动最省事，也省掉一个要管的子进程生命周期。
 */

const path = require('path')
const net = require('net')
const fs = require('fs')
const os = require('os')
const { spawn } = require('child_process')
const { app, BrowserWindow, Menu, shell, dialog, session, screen } = require('electron')

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'
const DEV_URL = process.env.CHAOS_DEV_URL || 'http://127.0.0.1:5173'

// 打包后数据落在用户目录，Program Files 是只读的
process.env.CHAOS_DATA_DIR = process.env.CHAOS_DATA_DIR || path.join(app.getPath('userData'), 'data')

const serverModule = require('../server/index.js')
const storeModule = require('../server/store.js')
// 与 server/index.js 同进程，拿到的是同一个单例，用来判断「有没有任务在跑」
const runnerModule = require('../server/runner.js')

let mainWindow = null
let serverPort = null
let ownsServer = false
let splashWindow = null
let splashStartedAt = 0

/** 闪屏停留时长。启动通常远快于此，所以实际效果就是「启动页显示 5 秒」 */
const SPLASH_MIN_MS = 5000
/** 退场动画时长，比渲染进程的动画（LifecycleFx 里 1500ms）多留一点，别把收尾切掉 */
const EXIT_ANIM_MS = 1650

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 开发时 `npm run dev` 会同时起一个独立后端（dev:server，支持单独重启），
 * 这时 Electron 不能再起一个 —— 两个进程抢同一个端口，后起的那个会因
 * EADDRINUSE 退到 43118，而窗口还指着 43117，行为完全错乱。
 * 所以由环境变量显式声明「后端在外部」，Electron 只负责连上去。
 */
const USE_EXTERNAL_SERVER = process.env.CHAOS_EXTERNAL_SERVER === '1'

/* ------------------------------------------------------------------ *
 * 单实例：第二次启动时聚焦已有窗口
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

/* ------------------------------------------------------------------ *
 * 自动更新
 * ------------------------------------------------------------------ */

let updater = null
let updaterError = null

/**
 * 更新运行时状态。唯一事实来源，经 update:status 广播给界面。
 * status: idle | checking | latest | available | downloading | downloaded | installing | error
 */
let updateRuntime = {
  supported: Boolean(process.versions.electron),
  status: 'idle',
  message: '尚未检查更新',
}

let downloading = false
let installingUpdate = false
/** 检查序号：HTTP 路由与「空闲时自动」都可能发起检查，用它防止结果串台 */
let checkSeq = 0

/** 进度广播节流：事件本身可能高频，别把 WebSocket 打爆 */
const PROGRESS_MIN_INTERVAL_MS = 800
const PROGRESS_MIN_DELTA = 1
let lastProgressAt = 0
let lastProgressPercent = -1

function setRuntime(patch, { broadcast = true } = {}) {
  updateRuntime = { ...updateRuntime, ...patch }
  if (broadcast && ownsServer) {
    try {
      serverModule.broadcast('update:status', updateRuntime)
    } catch (_) {
      /* 广播失败不影响主流程 */
    }
  }
  return updateRuntime
}

function pushProgress(p) {
  const now = Date.now()
  const percent = Math.round(p.percent * 10) / 10
  // 既不太频繁、进度也没实质变化，就丢掉这一帧
  if (now - lastProgressAt < PROGRESS_MIN_INTERVAL_MS && Math.abs(percent - lastProgressPercent) < PROGRESS_MIN_DELTA) {
    return
  }
  lastProgressAt = now
  lastProgressPercent = percent
  setRuntime({
    status: 'downloading',
    percent,
    transferred: p.transferred,
    total: p.total,
    bytesPerSecond: p.bytesPerSecond,
    message: `正在下载 ${percent.toFixed(1)}%`,
  })
}

function initUpdater() {
  try {
    // electron-updater 只在打包后可 require（它依赖 app-update.yml）
    updater = require('electron-updater').autoUpdater
  } catch (err) {
    updaterError = err.message
    return null
  }

  // 两条自动行为都必须关掉：
  //   autoDownload          —— 否则检查到新版本就静默下载，界面上什么也看不见
  //   autoInstallOnAppQuit  —— 它默认 true，下载完成后只要正常退出就会自动装上，
  //                            而我们的要求是「安装必须经用户确认」
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false

  updater.on('download-progress', pushProgress)

  updater.on('update-downloaded', (info) => {
    downloading = false
    lastProgressPercent = -1
    setRuntime({
      status: 'downloaded',
      version: info?.version,
      percent: 100,
      message: `新版本 ${info?.version} 已下载，等待你确认安装`,
    })
  })

  updater.on('error', (err) => {
    downloading = false
    console.error('[updater] 出错:', err.message)
    setRuntime({ status: 'error', message: `更新出错：${err.message}` })
  })

  return updater
}

/**
 * 供 /api/update/check 调用。等待「有更新 / 无更新 / 出错」三者之一，
 * 并加一个超时兜底，避免前端按钮一直转圈。
 */
function checkForUpdates() {
  return new Promise((resolve) => {
    if (!app.isPackaged) {
      return resolve({
        supported: false,
        status: 'unsupported',
        message: '开发模式（未打包）下无法检查更新，打包安装后才生效。',
      })
    }
    if (!updater) {
      return resolve({
        supported: false,
        status: 'unsupported',
        message: `自动更新组件不可用：${updaterError || '未知原因'}`,
      })
    }

    // 串台守卫：先发起的检查若晚于后发起的返回（例如 30s 超时兜底），
    // 不应把后一次的结果改写成 timeout
    const seq = ++checkSeq

    let settled = false
    const cleanup = () => {
      updater.removeListener('update-available', onAvailable)
      updater.removeListener('update-not-available', onNotAvailable)
      updater.removeListener('error', onError)
    }
    const finish = (data) => {
      if (settled) return
      settled = true
      cleanup()
      // 只有自己仍是最新一次检查时才写共享状态，否则只把结果回给调用方
      if (seq === checkSeq) {
        // 让界面立刻跟上（按钮从「检查中」变成「下载」/「已是最新」）
        setRuntime(data)
      }
      resolve(data)
    }

    const onAvailable = (info) =>
      finish({
        supported: true,
        status: 'available',
        version: info?.version,
        message: `发现新版本 ${info?.version}，点击「下载」开始`,
      })
    const onNotAvailable = (info) =>
      finish({
        supported: true,
        status: 'latest',
        version: info?.version,
        message: `当前已是最新版本（v${app.getVersion()}）`,
      })
    const onError = (err) =>
      finish({ supported: true, status: 'error', message: `检查更新失败：${err.message}` })

    updater.once('update-available', onAvailable)
    updater.once('update-not-available', onNotAvailable)
    updater.once('error', onError)

    setRuntime({ status: 'checking', message: '正在检查更新…' })
    Promise.resolve(updater.checkForUpdates()).catch(onError)
    setTimeout(() => finish({ supported: true, status: 'timeout', message: '检查更新超时，请稍后重试。' }), 30000)
  })
}

const UPDATER_UNAVAILABLE = {
  supported: false,
  status: 'unsupported',
  message: `自动更新组件不可用：${updaterError || '开发模式（未打包）'}。`,
}

/**
 * 供 /api/update/download 调用。
 * autoDownload 关掉之后，只有用户点了「下载」才会走到这里。
 */
async function startDownload() {
  if (!app.isPackaged || !updater) return { ...UPDATER_UNAVAILABLE }

  // 已在下载 / 已下好 / 正在安装 —— 不重复触发，把现状回给界面。
  // 注意 downloadUpdate() 在 finally 里会把内部 promise 置空，库自己挡不住
  // 第二次调用（会真的重新下一遍），所以这道闸必须由我们来把。
  if (downloading || installingUpdate || updateRuntime.status === 'downloaded') {
    return { ...updateRuntime }
  }

  // electron-updater 的 downloadUpdate() 在「还没 check 过」时会直接 reject
  // （"Please check update first"），所以先补一次检查再决定要不要下。
  if (updateRuntime.status !== 'available') {
    const checked = await checkForUpdates()
    if (checked.status !== 'available') return checked
  }

  downloading = true
  lastProgressAt = 0
  lastProgressPercent = -1
  setRuntime({
    status: 'downloading',
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    message: '正在下载更新…',
  })

  try {
    await updater.downloadUpdate()
    // 正常结束时 update-downloaded 事件已把状态改成 downloaded
  } catch (err) {
    // 下载失败 / 被取消都会 reject，不能让界面卡在「下载中」
    downloading = false
    setRuntime({ status: 'error', message: `下载失败：${err.message}` })
  }
  return { ...updateRuntime }
}

function getUpdateStatus() {
  return updateRuntime
}

/* ------------------------------------------------------------------ *
 * 版本回退
 *
 * electron-updater 只会「升到最新」，没有「装回指定版本」这种能力 —— 它的
 * 整个模型就是拿当前版本和 feed 里的最新版比较。所以回退这条路自己实现：
 * 直接查 GitHub Releases，挑出目标版本的安装包，下下来，然后拉起它。
 * ------------------------------------------------------------------ */

/** 回退时下载好的安装包。非空时安装走它，而不是走 electron-updater。 */
let pendingInstallerPath = ''
let pendingInstallerVersion = ''

const GITHUB_API = 'https://api.github.com'

/** 从 app-update.yml 读出发布源。打包后它就在 resources 下。 */
function readFeedConfig() {
  const candidates = [
    path.join(process.resourcesPath || '', 'app-update.yml'),
    path.join(__dirname, '..', 'dev-app-update.yml'),
  ]
  for (const p of candidates) {
    try {
      const txt = fs.readFileSync(p, 'utf8')
      const pick = (k) => {
        const m = txt.match(new RegExp(`^${k}:\\s*(.+)$`, 'm'))
        return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''
      }
      const owner = pick('owner')
      const repo = pick('repo')
      if (owner && repo) return { owner, repo }
    } catch (_) {
      /* 换下一个 */
    }
  }
  return { owner: '', repo: '' }
}

function ghHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ChaosConsole-Updater',
  }
}

/** 列出仓库的 Release，供设置里的「版本回退」选择。 */
async function listReleases() {
  const { owner, repo } = readFeedConfig()
  if (!owner || !repo) {
    return { supported: false, error: '读不到发布源配置（app-update.yml），无法列出历史版本。', releases: [] }
  }
  try {
    const res = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=50`, {
      headers: ghHeaders(),
      signal: AbortSignal.timeout(20000),
    })
    if (!res.ok) {
      return { supported: true, error: `GitHub 返回 HTTP ${res.status}`, releases: [] }
    }
    const raw = await res.json()
    const current = `v${app.getVersion()}`
    const releases = (Array.isArray(raw) ? raw : [])
      .filter((r) => !r.draft)
      .map((r) => {
        const exe = (r.assets || []).find((a) => /\.exe$/i.test(a.name) && !/blockmap/i.test(a.name))
        return {
          tag: r.tag_name,
          name: r.name || r.tag_name,
          publishedAt: r.published_at,
          prerelease: Boolean(r.prerelease),
          current: r.tag_name === current || r.tag_name === app.getVersion(),
          size: exe ? exe.size : 0,
          assetName: exe ? exe.name : '',
          downloadUrl: exe ? exe.browser_download_url : '',
        }
      })
      .filter((r) => r.downloadUrl)
    return { supported: true, current, releases }
  } catch (err) {
    return { supported: true, error: `列出历史版本失败：${err.message}`, releases: [] }
  }
}

/**
 * 下载指定版本的安装包。进度复用 update:status 广播，界面不用再写一套。
 * 下载完把状态置为 downloaded 并带上 rollbackTo，前端据此把按钮变成「安装并重启」。
 */
async function downloadReleaseByTag(tag) {
  const list = await listReleases()
  const target = (list.releases || []).find((r) => r.tag === tag)
  if (!target) {
    return setRuntime({ status: 'error', message: `找不到版本 ${tag} 的安装包。` })
  }
  if (downloading || installingUpdate) {
    return { ...updateRuntime }
  }

  downloading = true
  lastProgressAt = 0
  lastProgressPercent = -1
  setRuntime({
    status: 'downloading',
    rollbackTo: tag,
    version: tag,
    percent: 0,
    transferred: 0,
    total: target.size || 0,
    bytesPerSecond: 0,
    message: `正在下载 ${tag}…`,
  })

  const outPath = path.join(os.tmpdir(), `chaos-rollback-${tag.replace(/[^\w.-]/g, '_')}.exe`)
  try {
    const res = await fetch(target.downloadUrl, {
      headers: { 'User-Agent': 'ChaosConsole-Updater' },
      signal: AbortSignal.timeout(30 * 60 * 1000),
      redirect: 'follow',
    })
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)

    const total = Number(res.headers.get('content-length')) || target.size || 0
    const chunks = []
    let received = 0
    let markAt = Date.now()
    let markBytes = 0
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.length
      const now = Date.now()
      if (now - markAt >= 900) {
        const bps = Math.round(((received - markBytes) * 1000) / (now - markAt))
        markAt = now
        markBytes = received
        const percent = total ? Math.round((received * 1000) / total) / 10 : 0
        if (Math.abs(percent - lastProgressPercent) >= 1 || percent >= 100) {
          lastProgressPercent = percent
          setRuntime({
            status: 'downloading',
            rollbackTo: tag,
            percent,
            transferred: received,
            total,
            bytesPerSecond: bps,
            message: `正在下载 ${tag} ${percent.toFixed(1)}%`,
          })
        }
      }
    }
    fs.writeFileSync(outPath, Buffer.concat(chunks.map((c) => Buffer.from(c))))
    pendingInstallerPath = outPath
    pendingInstallerVersion = tag
    downloading = false
    setRuntime({
      status: 'downloaded',
      rollbackTo: tag,
      version: tag,
      percent: 100,
      transferred: received,
      total,
      message: `${tag} 已下载（版本回退），点「安装并重启」生效`,
    })
  } catch (err) {
    downloading = false
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath)
    } catch (_) {
      /* ignore */
    }
    setRuntime({ status: 'error', message: `下载 ${tag} 失败：${err.message}` })
  }
  return { ...updateRuntime }
}

/**
 * 供 /api/update/install 调用：用户点「安装并重启」并确认后才走到这里。
 *
 * 这里不直接调 quitAndInstall()，而是把 intent 记下来、走既有的退出状态机
 * （requestQuit → 退场动画 → 停后端 → before-quit 的 finalizing 阶段才拉起安装器）。
 * 这样「先停服务、再装」的顺序与普通退出完全一致，不会出现后端还占着文件时
 * 安装器就要覆盖的情况。
 */
function installUpdate() {
  if (!app.isPackaged || !updater) return { ...UPDATER_UNAVAILABLE }
  if (installingUpdate) return { ...updateRuntime }
  if (updateRuntime.status !== 'downloaded') {
    return { ...updateRuntime, message: '还没有已下载的更新可以安装。' }
  }
  // 已经在退出途中就别再插一脚，否则界面会显示「正在安装」而实际只是普通退出
  if (closeState !== 'running') {
    return { ...updateRuntime, message: '应用正在退出，未开始安装。' }
  }
  // 版本回退走自己下载的安装包，此时不校验 electron-updater 的状态
  if (pendingInstallerPath) {
    if (!fs.existsSync(pendingInstallerPath)) {
      pendingInstallerPath = ''
      return setRuntime({ status: 'error', message: '回退安装包已被清理，请重新下载。' })
    }
  } else if (!updater.installerPath) {
    // 安装包可能已被清理（杀软、磁盘清理）。提前挡住，否则 quitAndInstall() 会
    // 静默失败，用户以为装上了其实没有。
    return setRuntime({ status: 'error', message: '安装包已不存在，请重新下载。' })
  }

  installingUpdate = true
  installRequested = true
  setRuntime({
    status: 'installing',
    message: pendingInstallerVersion ? `正在退出并安装 ${pendingInstallerVersion}…` : '正在退出并安装…',
  })
  requestQuit()
  return { ...updateRuntime }
}

/* ------------------------------------------------------------------ *
 * 空闲时自动检查并下载（默认关闭，设置里开启）
 *
 * 「空闲」取业务语义：没有任务在执行。定时器放主进程而不是渲染进程 ——
 * 窗口最小化或不可见时渲染进程的定时器会被节流，主进程不会。
 * 注意：即便自动下载，装不装仍然要用户点确认。
 * ------------------------------------------------------------------ */

/** 判定节拍：只做轻量判断，几乎零成本 */
const AUTO_TICK_MS = 60 * 1000
/** 真正打 GitHub 的最小间隔：2 次/小时，远低于未认证 API 的 60 次/小时配额 */
const AUTO_MIN_INTERVAL_MS = 30 * 60 * 1000
/** 启动后先让应用喘口气，别和启动期抢资源 */
const AUTO_BOOT_DELAY_MS = 90 * 1000

let autoTimer = null
let lastAutoCheckAt = 0

/**
 * 「空闲」= 没有任务在执行。
 *
 * runningTaskIds() 只覆盖「进程已经拉起来」的任务；而 runState 在 runner.execute
 * 之前就已经写成 running，两者都看才盖得住「已派单但进程还没起来」的空窗。
 */
function isBusinessIdle() {
  try {
    if ((runnerModule.runningTaskIds() || []).length > 0) return false
    return !(storeModule.listTasks() || []).some(
      (t) => t.runState === 'running' || t.runState === 'queued',
    )
  } catch (_) {
    // 读不出状态（例如 CHAOS_EXTERNAL_SERVER=1 时主进程没初始化过 db）
    // → 按「忙」处理，宁可不自动也不误判
    return false
  }
}

function autoUpdateEnabled() {
  try {
    return storeModule.getSetting('autoUpdateWhenIdle', '0') === '1'
  } catch (_) {
    return false
  }
}

async function maybeAutoUpdateWhenIdle() {
  if (!app.isPackaged || !updater) return
  if (!autoUpdateEnabled()) return
  // 已经在下载 / 下好待装 / 安装中，都别插手
  if (['downloading', 'downloaded', 'installing'].includes(updateRuntime.status)) return
  if (Date.now() - lastAutoCheckAt < AUTO_MIN_INTERVAL_MS) return
  if (!isBusinessIdle()) return

  lastAutoCheckAt = Date.now()
  const res = await checkForUpdates()
  // 检查期间可能刚有任务起来 —— 再确认一次。
  // 但一旦开始下载就不再打断：下到一半停下比下完更糟。
  if (res && res.status === 'available' && autoUpdateEnabled() && isBusinessIdle()) {
    await startDownload()
  }
}

function scheduleIdleAutoUpdate() {
  if (!app.isPackaged || !updater || autoTimer) return
  // 预置 lastAutoCheckAt，使第一次真正可查落在启动后约 AUTO_BOOT_DELAY_MS
  lastAutoCheckAt = Date.now() + AUTO_BOOT_DELAY_MS - AUTO_MIN_INTERVAL_MS
  autoTimer = setInterval(() => {
    maybeAutoUpdateWhenIdle().catch(() => {})
  }, AUTO_TICK_MS)
}

/* ------------------------------------------------------------------ *
 * 启动闪屏
 * ------------------------------------------------------------------ */

/**
 * 闪屏是一个独立无边框窗口，盖在启动期上面。
 * 它的动画全在 electron/splash.html 里用 CSS 做，这里只负责：
 *   1. 尽早把它显示出来（后端还没起，主窗口还是空白）；
 *   2. 用 executeJavaScript 往里面追加真实的启动日志；
 *   3. 主窗口能显示了就淡出关掉它。
 *
 * 日志用 executeJavaScript 注入而不是 IPC，是因为闪屏不需要 preload，
 * 而且 executeJavaScript 不受页面 CSP 限制（打包后主进程会注入严格 CSP）。
 */
function createSplash() {
  splashStartedAt = Date.now()
  splashWindow = new BrowserWindow({
    width: 560,
    height: 340,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { contextIsolation: true, nodeIntegration: false, spellcheck: false },
  })

  splashWindow.once('ready-to-show', () => splashWindow?.show())
  splashWindow.on('closed', () => {
    splashWindow = null
  })

  // 页脚的版本号在 HTML 里是个占位符，这里填成真实版本
  splashWindow.webContents.once('did-finish-load', () => {
    splashWindow?.webContents
      .executeJavaScript(
        `(() => {
          const el = document.getElementById('foot-right')
          if (el) el.textContent = ${JSON.stringify(`v${app.getVersion()}`)}
          return true
        })()`,
        true,
      )
      .catch(() => {})
  })

  splashWindow.loadFile(path.join(__dirname, 'splash.html')).catch((err) => {
    console.error('[electron] 闪屏加载失败:', err.message)
  })

  return splashWindow
}

/** 往闪屏里追加一行启动日志，并推进进度条。闪屏没了就静默跳过。 */
function pushBootStep(text, progress) {
  if (!splashWindow || splashWindow.isDestroyed()) return
  splashWindow.webContents
    .executeJavaScript(
      `(() => {
        const log = document.getElementById('log')
        if (log) {
          for (const old of log.querySelectorAll('.line.now')) old.classList.remove('now')
          const line = document.createElement('div')
          line.className = 'line now'
          line.textContent = ${JSON.stringify(String(text))}
          log.appendChild(line)
          while (log.children.length > 4) log.removeChild(log.firstChild)
        }
        const bar = document.getElementById('bar')
        if (bar) bar.style.width = ${JSON.stringify(`${progress}%`)}
        return true
      })()`,
      true,
    )
    .catch(() => {
      /* 闪屏还没加载完 / 已被关掉，忽略 */
    })
}

/** 让闪屏淡出后关闭；调用方不 await，免得拖慢主窗口显示 */
async function closeSplash() {
  const win = splashWindow
  if (!win || win.isDestroyed()) return
  splashWindow = null
  try {
    await win.webContents.executeJavaScript(`document.body.classList.add('closing'); true`, true)
  } catch (_) {
    /* 注入失败就直接关 */
  }
  await sleep(320)
  if (!win.isDestroyed()) win.close()
}

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

/**
 * 探测某个地址是否有人在监听。
 * 用于判断 Vite devServer 到底起没起 —— 直接 `electron .` 时它通常没起，
 * 这时候要回退到后端自己托管的构建产物，否则就是一个白屏窗口。
 */
function probe(url, timeout = 1500) {
  return new Promise((resolve) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch (_) {
      return resolve(false)
    }
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    const socket = net.connect({ host: parsed.hostname, port })
    const done = (ok) => {
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

async function resolveTarget() {
  if (!isDev) return `http://127.0.0.1:${serverPort}`
  if (await probe(DEV_URL)) return DEV_URL
  console.warn(`[electron] Vite devServer (${DEV_URL}) 未启动，回退到本地构建产物`)
  console.warn('[electron] 开发模式请用 npm run dev；纯前端调试请先 npm run build:web')
  return `http://127.0.0.1:${serverPort}`
}

function buildMenu() {
  // 界面上所有功能都有对应按钮，菜单栏纯属多余的一条横杠，去掉。
  // 随之移除的还有它带走的快捷键（Ctrl+N 新建任务等）——工具栏已经覆盖这些入口。
  Menu.setApplicationMenu(null)
}

function applyCsp() {
  // 只在打包后收紧 CSP；开发模式放过 Vite 的内联 HMR 脚本
  if (isDev) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
            "img-src 'self' data:; font-src 'self' data:; " +
            "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*",
        ],
      },
    })
  })
}

/**
 * 按当前屏幕的工作区（不含任务栏）算初始窗口尺寸。
 *
 * 取工作区的 92%，但最外层再对工作区取一次 min —— 因为 lower bound（1024/640）只是
 * 「别开得太小」的期望值，遇上 150% 缩放的 1080p（工作区只剩约 1280×648）或更小的屏时，
 * 保证窗口不会反而比屏幕还大。这就是原来写死 1560×940 在 1366×768 笔记本上溢出的原因。
 *
 * screen 只能在 app 就绪后碰；createWindow 是在 whenReady 链里调用的，安全。
 */
function preferredWindowSize() {
  const display = screen.getPrimaryDisplay()
  const { workAreaSize } = display
  const size = {
    width: Math.min(1720, workAreaSize.width, Math.max(1024, Math.round(workAreaSize.width * 0.92))),
    height: Math.min(1080, workAreaSize.height, Math.max(640, Math.round(workAreaSize.height * 0.92))),
  }
  console.log(
    `[electron] 显示器 ${display.size.width}×${display.size.height}（缩放 ${display.scaleFactor}x）` +
      ` 工作区 ${workAreaSize.width}×${workAreaSize.height} → 窗口 ${size.width}×${size.height}`,
  )
  return size
}

/* ------------------------------------------------------------------ *
 * 窗口尺寸 / 位置的跨重启记忆
 * ------------------------------------------------------------------ */

const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json')
const WINDOW_SAVE_DEBOUNCE_MS = 400

let windowSaveTimer = null

/**
 * 校验一份存档的窗口矩形还能不能用，不能用就返回 null（调用方退回默认尺寸）。
 *
 * 两个必须挡住的情况：
 *  1. **拔掉外接屏**。位置会落在所有显示器的工作区之外，窗口看不见也拖不回来。
 *     判据是「与某个工作区的交集至少能看到 120×40」——够抓住标题栏拖回来。
 *  2. **换了更小的屏**（2560 换 1366）。存档里的宽高会超出新屏，夹进工作区。
 *
 * 位置刻意不夹：跨双屏摆一个宽窗口是正常用法，夹进单屏反而会把它挪走。
 */
function sanitizeWindowState(saved) {
  if (!saved || typeof saved !== 'object') return null
  const { x, y, width, height, maximized } = saved
  if (![x, y, width, height].every((v) => Number.isFinite(v))) return null
  // 下限必须与 createWindow 的 minWidth/minHeight 一致。守卫比它松的话，
  // 一份被手工改过（或旧版本遗留）的 width:500 会通过校验，然后
  // `new BrowserWindow({ width: 500, minWidth: 900 })` 真的造出一个 500px 的窗口 ——
  // Electron 的 minWidth 只约束用户拖拽，不约束构造参数。
  if (width < 900 || height < 560) return null

  const MIN_VISIBLE_W = 120
  const MIN_VISIBLE_H = 40

  let best = null
  for (const display of screen.getAllDisplays()) {
    const wa = display.workArea
    const overlapW = Math.min(x + width, wa.x + wa.width) - Math.max(x, wa.x)
    const overlapH = Math.min(y + height, wa.y + wa.height) - Math.max(y, wa.y)
    if (overlapW >= MIN_VISIBLE_W && overlapH >= MIN_VISIBLE_H) {
      if (!best || overlapW * overlapH > best.area) best = { area: overlapW * overlapH, wa }
    }
  }
  if (!best) return null

  return {
    x,
    y,
    width: Math.min(width, best.wa.width),
    height: Math.min(height, best.wa.height),
    maximized: Boolean(maximized),
  }
}

function loadWindowState() {
  // 逃生口：自检脚本要断言「初始尺寸 = 按工作区算出来的那个值」，而一旦有了存档
  // 这个前提就不成立了。用 CHAOS_WINDOW_STATE=off 起应用即可让这一次完全走默认尺寸。
  if (process.env.CHAOS_WINDOW_STATE === 'off') return null
  try {
    const state = sanitizeWindowState(JSON.parse(fs.readFileSync(WINDOW_STATE_FILE, 'utf8')))
    if (state) {
      console.log(
        `[electron] 恢复上次的窗口：${state.width}×${state.height} @ ${state.x},${state.y}` +
          `${state.maximized ? '（最大化）' : ''}`,
      )
    }
    return state
  } catch (_) {
    // 文件不存在（第一次启动）或内容损坏 —— 都当作没有存档
    return null
  }
}

function saveWindowState() {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  // getNormalBounds 而不是 getBounds：最大化时后者返回的是最大化后的尺寸，
  // 记下来下次「还原」就还原不回去了
  const { x, y, width, height } = win.getNormalBounds()
  try {
    fs.writeFileSync(
      WINDOW_STATE_FILE,
      JSON.stringify({ x, y, width, height, maximized: win.isMaximized() }),
    )
  } catch (err) {
    // 写不进去就下次再记，不值得打扰用户
    console.warn('[electron] 窗口状态保存失败:', err.message)
  }
}

/** 拖动/缩放窗口时高频触发，攒一下再写盘 */
function scheduleSaveWindowState() {
  if (windowSaveTimer) clearTimeout(windowSaveTimer)
  windowSaveTimer = setTimeout(saveWindowState, WINDOW_SAVE_DEBOUNCE_MS)
}

async function createWindow() {
  const preferred = preferredWindowSize()
  const saved = loadWindowState()
  mainWindow = new BrowserWindow({
    width: saved?.width ?? preferred.width,
    height: saved?.height ?? preferred.height,
    // 只在真的有存档时才传坐标，否则会把窗口钉在 (0,0) 而不是交给系统居中
    ...(saved ? { x: saved.x, y: saved.y } : {}),
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#0b0e14',
    title: 'AI Agent开发控制台',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  })

  // 上次是最大化退出的，就还它一个最大化。放在 show 之前，避免先闪一下小窗
  if (saved?.maximized) mainWindow.maximize()

  mainWindow.on('resize', scheduleSaveWindowState)
  mainWindow.on('move', scheduleSaveWindowState)

  // 主窗口能显示了才收闪屏。先补足最短停留时间，否则启动快的时候会一闪而过，
  // 看起来像闪屏出错而不是「启动很快」。
  mainWindow.once('ready-to-show', async () => {
    const elapsed = Date.now() - splashStartedAt
    if (elapsed < SPLASH_MIN_MS) await sleep(SPLASH_MIN_MS - elapsed)
    pushBootStep('工作台界面就绪', 100)
    await sleep(280)
    // 隐藏状态下 maximize() 在 Windows 上不一定生效（上面构造完就调过一次了），
    // show 之前再补一次，保证「上次最大化退出的，这次也是最大化」
    if (saved?.maximized && !mainWindow?.isMaximized()) mainWindow?.maximize()
    mainWindow?.show()
    mainWindow?.focus()
    closeSplash()
  })

  // 第一次「关闭」请求先拦下来播退场动画；动画播完后 closeState 不再是 running，
  // 这时 app.quit() 再次关窗就会正常放行。
  mainWindow.on('close', (event) => {
    // 关窗这一刻的状态才是用户想要的，所以不等防抖计时器，直接落盘。
    // 这里即使被下面的 preventDefault 拦下来也没关系：窗口还在，坐标就是有效的。
    saveWindowState()
    if (closeState === 'running') {
      event.preventDefault()
      requestQuit()
    }
  })

  mainWindow.on('closed', () => {
    if (windowSaveTimer) {
      clearTimeout(windowSaveTimer)
      windowSaveTimer = null
    }
    mainWindow = null
  })

  // 站内链接留在应用内，外链交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const target = await resolveTarget()
  console.log(`[electron] 加载界面: ${target}${target === DEV_URL ? '（Vite 开发服务器）' : '（本地构建产物）'}`)

  try {
    await mainWindow.loadURL(target)
  } catch (err) {
    console.error('[electron] 界面加载失败:', err.message)
    dialog.showErrorBox('启动失败', `无法加载界面 ${target}\n${err.message}`)
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  createSplash()
  pushBootStep('初始化运行时环境', 6)

  if (USE_EXTERNAL_SERVER) {
    serverPort = Number(process.env.CHAOS_PORT || 43117)
    console.log(`[electron] 使用外部后端（端口 ${serverPort}），本进程不再启动服务`)
    pushBootStep(`连接外部服务 127.0.0.1:${serverPort}`, 30)
    if (!(await probe(`http://127.0.0.1:${serverPort}`))) {
      dialog.showErrorBox(
        '后端未就绪',
        `CHAOS_EXTERNAL_SERVER=1 表示后端由外部提供，但 127.0.0.1:${serverPort} 上没有服务在监听。\n` +
          '请先启动 npm run dev:server，或去掉该环境变量让 Electron 自己启动后端。',
      )
      quitImmediately()
      return
    }
    pushBootStep('外部服务已响应', 62)
  } else {
    pushBootStep('启动本地服务 (HTTP + WebSocket)', 26)
    try {
      const { port } = await serverModule.start()
      serverPort = port
      ownsServer = true
      console.log(`[electron] 后端已就绪，端口 ${port}`)
      pushBootStep(`本地服务已就绪 · 端口 ${port}`, 58)
      pushBootStep(`载入员工编制 ${storeModule.listAgents().length} 名`, 76)
    } catch (err) {
      console.error('[electron] 后端启动失败:', err)
      dialog.showErrorBox('后端启动失败', String(err?.stack || err))
      quitImmediately()
      return
    }
  }

  serverModule.setUpdateHandler(checkForUpdates)
  serverModule.setDownloadHandler(startDownload)
  serverModule.setInstallHandler(installUpdate)
  serverModule.setUpdateStatusHandler(getUpdateStatus)
  serverModule.setReleasesHandler(listReleases)
  serverModule.setRollbackHandler(downloadReleaseByTag)
  initUpdater()
  scheduleIdleAutoUpdate()
  applyCsp()
  buildMenu()
  pushBootStep('装载工作台界面', 88)
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

/* ------------------------------------------------------------------ *
 * 退出：先播退场动画，再停服务、落盘、退出
 *
 *   running    → 正常服务中
 *   closing    → 界面正在播退场动画，这期间不许真的关窗
 *   finalizing → 动画已播完（或启动期直接失败），正在收尾
 * ------------------------------------------------------------------ */

let closeState = 'running'
let finalized = false
/** 用户已确认安装更新：退出收尾时不走 app.exit(0)，而是拉起安装器 */
let installRequested = false

/** 请求退出：广播退场动画，等它播完再交给 before-quit 收尾 */
function requestQuit() {
  if (closeState !== 'running') return
  closeState = 'closing'

  // 闪屏还盖在上面就先收掉，否则退场动画被它挡住，用户什么也看不见
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.close()

  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('app:quitting')
    } catch (_) {
      /* 界面不可用不影响退出 */
    }
  }

  // 固定等 EXIT_ANIM_MS，而不是等渲染进程回报「动画播完了」：
  // 界面卡死 / 崩溃时也必须退得掉，所以这里不能用握手。
  setTimeout(() => {
    closeState = 'finalizing'
    app.quit()
  }, EXIT_ANIM_MS)
}

/** 启动期致命错误：还没有界面可播动画，直接跳过退场 */
function quitImmediately() {
  closeState = 'finalizing'
  app.quit()
}

app.on('before-quit', (event) => {
  // 兜一次窗口状态。窗口的 close 事件在这条路上**一次都不会触发**：
  // 退出流程最后走的是 app.exit(0)，它不会给窗口发 close。平时靠 resize/move 的
  // 防抖写盘就够了，但用户「拖一下窗口、马上点退出」时那次写盘可能还没落地。
  saveWindowState()

  // 从菜单 / 快捷键退出：退场动画还没播，先补上
  if (closeState === 'running') {
    event.preventDefault()
    requestQuit()
    return
  }
  // 动画还没播完，别在这时候把窗口收掉
  if (closeState === 'closing') {
    event.preventDefault()
    return
  }
  // finalizing：这里才是真正的收尾
  if (finalized) return
  finalized = true
  event.preventDefault()
  ;(async () => {
    // 只关自己启动的后端；外部后端由 npm run dev 的 concurrently 负责收尾
    if (ownsServer) {
      try {
        // stop() 内部已经会掐掉 WS 客户端并强制断开连接；这里再兜一层超时，
        // 保证「退出」这个动作永远不会因为后端没收干净而卡住 —— 这一步一旦
        // 挂住，app.exit(0) 就永远执行不到，窗口关不掉、进程也退不了。
        await Promise.race([serverModule.stop(), sleep(5000)])
      } catch (err) {
        console.error('[electron] 关闭后端出错:', err.message)
      }
    }

    if (installRequested) {
      // 走到这里：退场动画已播完、后端已停、WS 已断。
      try {
        if (pendingInstallerPath) {
          // 版本回退：直接拉起我们自己下好的安装包，不经过 electron-updater
          spawn(pendingInstallerPath, [], { detached: true, stdio: 'ignore' }).unref()
        } else if (updater) {
          // 正常升级：quitAndInstall() 内部会先同步 spawn 安装器（detached + unref），
          // 再 setImmediate(app.quit())。此刻 finalized 已为 true，
          // 上面的 before-quit 分支会直接放行，不会被二次 preventDefault 卡住。
          updater.quitAndInstall(false, true)
        }
      } catch (err) {
        console.error('[updater] 拉起安装器失败:', err.message)
      }
      // 兜底：安装器没能把应用带走（被杀软拦截、提权失败）时也要退得掉
      setTimeout(() => app.exit(0), 1500)
      return
    }

    app.exit(0)
  })()
})

process.on('uncaughtException', (err) => {
  console.error('[electron] 未捕获异常:', err)
})
