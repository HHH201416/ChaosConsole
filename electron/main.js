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
const crypto = require('crypto')
const { spawn } = require('child_process')
const {
  app,
  BrowserWindow,
  Menu,
  Tray,
  Notification,
  nativeImage,
  globalShortcut,
  shell,
  dialog,
  session,
  screen,
  nativeTheme,
  ipcMain,
  net: electronNet,
} = require('electron')

/**
 * 9.7.0：数据目录必须**在 require 业务模块之前**定下来。
 *
 * server/config.js 在模块加载时就把 DATA_DIR 算成常量了（`process.env.CHAOS_DATA_DIR
 * || ROOT/data`）。9.6.1 把这几行放在文件后半段，等于 config 已经按「安装目录」算完
 * 才去改环境变量 —— 结果升级后数据还是写进 resources/app/data，重装就丢。
 * 所以：先定环境变量，再 require server/*。
 */
process.env.CHAOS_DATA_DIR = process.env.CHAOS_DATA_DIR || path.join(app.getPath('userData'), 'data')

const dm = require('../server/download-mirror.js')
const CONFIG = require('../server/config.js')

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'
const DEV_URL = process.env.CHAOS_DEV_URL || 'http://127.0.0.1:5173'

// 9.5.1：系统代理（加速器/VPN）经常不放行 localhost —— 渲染进程的 /api 请求被
// 代理吞掉就会「深色空白进不去」。这里强制 127.0.0.1/localhost 直连，
// 外部请求（检查更新、下载模型）照常走系统代理。
app.commandLine.appendSwitch('proxy-bypass-list', '127.0.0.1;localhost;<local>')

/**
 * 9.6.1：把「装在安装目录里的旧数据」搬到用户目录。
 *
 * 背景：早期版本的 data/ 在 resources/app 下面，也就是**安装目录里**。
 * 覆盖安装 / 卸载会把整块目录换掉，用户的对话、岗位、知识库就这么没了。
 * 现在数据固定住 userData（%APPDATA%\chaos-console\data），升级只动程序不动数据；
 * 这里再做一次单向搬运，让老用户装上新版后数据自动跟过来。
 *
 * 只在新位置没有库、或旧库更新时才搬（幂等，可以每次启动都跑）。
 */
function migrateLegacyData() {
  try {
    const targetDir = process.env.CHAOS_DATA_DIR
    const legacyDir = path.join(__dirname, '..', 'data')
    if (!targetDir || path.resolve(targetDir) === path.resolve(legacyDir)) return
    const legacyDb = path.join(legacyDir, 'chaos.db')
    if (!fs.existsSync(legacyDb)) return

    const targetDb = path.join(targetDir, 'chaos.db')
    const needCopy =
      !fs.existsSync(targetDb) ||
      fs.statSync(legacyDb).mtimeMs > fs.statSync(targetDb).mtimeMs + 1000
    if (!needCopy) return

    fs.mkdirSync(targetDir, { recursive: true })
    // 递归复制，但目标已存在的“更新的”文件不覆盖
    const walk = (from, to) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const src = path.join(from, entry.name)
        const dst = path.join(to, entry.name)
        if (entry.isDirectory()) {
          fs.mkdirSync(dst, { recursive: true })
          walk(src, dst)
          continue
        }
        try {
          if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) continue
          fs.copyFileSync(src, dst)
        } catch (_) {
          /* 单个文件失败不影响其它文件/启动 */
        }
      }
    }
    walk(legacyDir, targetDir)
    console.log('[data] 已把安装目录里的旧数据搬到用户目录:', targetDir)
  } catch (err) {
    console.error('[data] 旧数据搬运失败（不阻塞启动）:', err.message)
  }
}

migrateLegacyData()

const serverModule = require('../server/index.js')
const storeModule = require('../server/store.js')
// 与 server/index.js 同进程，拿到的是同一个单例，用来判断「有没有任务在跑」
const runnerModule = require('../server/runner.js')
// 10.0.2：运行期间拦截系统关机（设置里可开）
const { ShutdownGuard } = require('./shutdown-guard.js')

let mainWindow = null
let serverPort = null
let ownsServer = false
let splashWindow = null
let splashStartedAt = 0
let tray = null
let isQuitting = false
let registeredShortcut = ''
// 8.0.2：全局速答小窗（Ctrl+Alt+Space 随时唤起，问完即走）
let quickWindow = null

try {
  app.setAppUserModelId('com.chaosconsole.boss')
} catch (_) {
  /* 某些平台不支持，不影响主流程 */
}

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

// 9.5.0：端到端测试用 CHAOS_E2E=1 跳过单实例锁 —— 允许在已安装版运行的同时
// 起一个带远程调试的测试实例（配独立 CHAOS_PORT / CHAOS_DATA_DIR，互不干扰）。
// 同时禁硬件加速 + 禁代理：无 GPU 的受控环境里 GPU 进程会崩、系统代理会拦 localhost。
if (process.env.CHAOS_E2E === '1') {
  app.disableHardwareAcceleration()
  app.commandLine.appendSwitch('no-proxy-server')
  app.commandLine.appendSwitch('disable-gpu')
}
const gotLock = process.env.CHAOS_E2E === '1' || app.requestSingleInstanceLock()
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
/** 更新 feed 当前用的是哪套：'github'（app-update.yml）还是 'generic'（走镜像） */
let appliedFeedKind = 'github'

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
 * 按「下载加速镜像」这个设置决定升级走哪个 feed。
 *
 * - 配了镜像 → generic provider，URL 指向
 *   `<镜像>/https://github.com/<owner>/<repo>/releases/latest/download`。
 *   GitHub 的 `releases/latest/download/<文件名>` 是稳定的（自动指向最新 Release），
 *   镜像只要会转发 github.com 就能用。校验不用担心：electron-updater 本来就会按
 *   latest.yml 里的 sha512 校验下载到的安装包。
 * - 没配（或用户清空了）→ 回到 app-update.yml 里的 GitHub provider，行为与以前一致。
 *
 * 只在「开始检查」前调用：feed 变了之后上一次解析出来的 updateInfo 就失效了，
 * 下载前再调会把刚检查到的结果弄丢（downloadUpdate 会报 "Please check update first"）。
 */
function applyUpdateFeed() {
  if (!updater) return
  const { owner, repo } = readFeedConfig()
  if (!owner || !repo) return

  const mirror = getDownloadMirror()
  if (mirror) {
    updater.setFeedURL({
      provider: 'generic',
      url: `${mirror}/https://github.com/${owner}/${repo}/releases/latest/download`,
      // 有些镜像不支持多段 Range 请求，关掉更稳；差量下载会因此退回全量，
      // 但配上镜像之后全量本来就够快，不值得为它冒兼容风险
      useMultipleRangeRequest: false,
    })
    appliedFeedKind = 'generic'
  } else if (appliedFeedKind === 'generic') {
    updater.setFeedURL({ provider: 'github', owner, repo, releaseType: 'release' })
    appliedFeedKind = 'github'
  }
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
        releaseName: info?.releaseName || '',
        releaseDate: info?.releaseDate || '',
        // 9.7.0：把 Release 正文带上去，升级弹窗里显示「这次更了什么」
        notes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : '',
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
    applyUpdateFeed()
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

/**
 * 访问 GitHub 一律走 Electron 的 net.fetch（Chromium 网络栈），**不要**用 Node 的
 * 全局 fetch。
 *
 * 为什么：两者认的证书不是一套。Node 只认内置根证书 + `NODE_EXTRA_CA_CERTS` 指定的
 * 文件；Chromium 认 Windows 证书库，并且沿用系统代理设置。本机装了加速器（Steam++）
 * 做 MITM，它的根证书只装进了 Windows 证书库 —— 于是同一个应用里出现割裂：
 * 检查更新（electron-updater，走 Chromium）一切正常，而这里用 Node fetch 就是
 * `fetch failed / unable to verify the first certificate`，用户看到的是
 * 「列出历史版本失败」。回退包的**下载**也是同一个坑。
 *
 * 换成 net.fetch 之后两条路走同一套网络栈：证书、代理、超时行为都一致。
 */
function ghFetch(url, init) {
  if (electronNet && typeof electronNet.fetch === 'function') return electronNet.fetch(url, init)
  // 极端情况（app 还没 ready）退回 Node 实现，至少不会比原来更差
  return fetch(url, init)
}

/**
 * 当前的下载加速镜像；'' 表示直连。
 *
 * 取值优先级：库里的设置 > 后端的默认值（CONFIG.DOWNLOAD_MIRROR，默认启用，
 * 实测那条路比直连快 50 倍）。**默认启用是服务端定的**，界面只显示开没开。
 * 每次检查/下载时现读，所以改了设置立刻生效、不用重启。
 */
function getDownloadMirror() {
  try {
    return dm.normalizeMirror(storeModule.getSetting('downloadMirror', CONFIG.DOWNLOAD_MIRROR))
  } catch (_) {
    return ''
  }
}

/**
 * 取某个 Release 自己 latest.yml 里声明的 sha512。
 * 刻意走 GitHub API（不经镜像）：校验基准若也来自镜像，就等于用镜像自己的说法
 * 证明镜像可信，这道校验也就白做了。
 */
async function fetchReleaseHash(owner, repo, tag, assetName) {
  try {
    const res = await ghFetch(
      `${GITHUB_API}/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
      { headers: ghHeaders(), signal: AbortSignal.timeout(20000) },
    )
    if (!res.ok) return null
    const rel = await res.json()
    const ymlAsset = (rel.assets || []).find((a) => a.name === 'latest.yml')
    if (!ymlAsset) return null
    const res2 = await ghFetch(ymlAsset.browser_download_url, {
      headers: { 'User-Agent': 'ChaosConsole-Updater' },
      signal: AbortSignal.timeout(20000),
    })
    if (!res2.ok) return null
    return dm.pickFileHash(dm.parseLatestYml(await res2.text()), assetName)
  } catch (_) {
    return null
  }
}

/** 列出仓库的 Release，供设置里的「版本回退」选择。 */
async function listReleases() {
  const { owner, repo } = readFeedConfig()
  if (!owner || !repo) {
    return { supported: false, error: '读不到发布源配置（app-update.yml），无法列出历史版本。', releases: [] }
  }
  try {
    const res = await ghFetch(`${GITHUB_API}/repos/${owner}/${repo}/releases?per_page=50`, {
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
    // 真因都在 err.cause 里（TLS 证书、DNS、代理都是 "fetch failed" + cause）。
    // 只报 message 会退化成「失败了但不知道为什么」，下次还得从头排查一遍。
    const cause = err && err.cause && err.cause.message ? `（${err.cause.message}）` : ''
    return { supported: true, error: `列出历史版本失败：${err.message}${cause}`, releases: [] }
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

  const mirror = getDownloadMirror()
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
    message: mirror ? `正在下载 ${tag}（经加速镜像）…` : `正在下载 ${tag}…`,
  })

  const outPath = path.join(os.tmpdir(), `chaos-rollback-${tag.replace(/[^\w.-]/g, '_')}.exe`)
  // 基准从 GitHub API 取（不经镜像），下载才走镜像 —— 否则等于拿镜像自己的说法
  // 证明镜像可信。取不到基准（老 Release 没带 latest.yml）就跳过校验并如实提示。
  const { owner: feedOwner, repo: feedRepo } = readFeedConfig()
  const expected = await fetchReleaseHash(feedOwner, feedRepo, tag, target.assetName)
  try {
    const res = await ghFetch(dm.applyMirror(target.downloadUrl, mirror), {
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

    // 体积不对就没必要再算 sha512 了（断流、镜像给了个错误文件都会表现成这个）
    if (total && received !== total) {
      try { fs.unlinkSync(outPath) } catch (_) {}
      downloading = false
      return setRuntime({
        status: 'error',
        rollbackTo: '',
        message: `下载不完整（收到 ${received} 字节，应为 ${total} 字节），已丢弃。请重试。`,
      })
    }

    // 完整性：过了镜像就一定对一遍 sha512。校验不过说明镜像给的不是它该给的东西，
    // 直接丢弃 —— 这个文件接下来是要被执行的，宁可不装。
    const check = dm.verifyFile(outPath, expected && expected.sha512)
    if (!check.ok) {
      try { fs.unlinkSync(outPath) } catch (_) {}
      downloading = false
      console.error(`[updater] ${tag} sha512 校验不通过：期望 ${expected.sha512} 实际 ${check.actual}`)
      return setRuntime({
        status: 'error',
        rollbackTo: '',
        message: mirror
          ? `下载的文件校验不通过（sha512 不符），已丢弃 —— 可能是加速镜像返回了被改动过的文件。可在设置里换镜像或关掉它重试。`
          : `下载的文件校验不通过（sha512 不符），已丢弃。请重试。`,
      })
    }

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
      message: check.skipped
        ? `${tag} 已下载（版本回退），但这个版本没有 sha512 基准，未能校验完整性`
        : `${tag} 已下载并通过 sha512 校验${mirror ? '（经加速镜像）' : ''}，点「安装并重启」生效`,
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
/** 9.7.0：每 15 分钟检查一次（用户要求），远低于未认证 API 的 60 次/小时配额 */
const AUTO_MIN_INTERVAL_MS = 15 * 60 * 1000
/** 启动后先让应用喘口气，别和启动期抢资源 */
const AUTO_BOOT_DELAY_MS = 30 * 1000

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
  // 已经在下载 / 下好待装 / 安装中，都别插手
  if (['downloading', 'downloaded', 'installing'].includes(updateRuntime.status)) return
  if (Date.now() - lastAutoCheckAt < AUTO_MIN_INTERVAL_MS) return

  // 9.7.0：**检查**不再要求「空闲」也不再要求开着自动下载 ——
  // 每 15 分钟查一次是用户明确要的；忙的时候查一下也不占什么资源。
  // 但「自动下载」仍然只在用户开了开关且确实空闲时才做，不擅自动网络。
  lastAutoCheckAt = Date.now()
  const res = await checkForUpdates()
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

  // 主题要在**首帧之前**贴上去，否则会先闪一下深色。所以挂的是 dom-ready 而不是
  // did-finish-load：前者在 DOM 解析完就触发，早于 ready-to-show（ready-to-show
  // 意味着「已经渲染出一帧了」，那时再改就来不及了）。
  //
  // 闪屏不经过 Vite 打包、也没有 preload，读不到 localStorage，所以主题只能由主进程
  // 从 theme.json 读出来再贴上去。splash.html 里刻意没有 <script>，见该文件头部注释。
  splashWindow.webContents.once('dom-ready', () => {
    applyThemeToWindow(splashWindow, resolveTheme())
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
 * 主题偏好（渲染进程 → 主进程的单向同步，供冷启动闪屏用）
 * ------------------------------------------------------------------ */

const THEME_FILE = path.join(app.getPath('userData'), 'theme.json')
const THEME_MODES = ['light', 'dark', 'system']

/**
 * 用户选的主题，'light' | 'dark' | 'system'。
 *
 * 为什么主进程要单独存一份：冷启动的闪屏是个**独立窗口**，在渲染进程起来之前就
 * 创建好了，读不到 localStorage 里的偏好（见 createSplash）。界面每次改主题都通过
 * preload 的 setTheme() 同步过来。
 *
 * 读不到 / 写坏了都退回 'system' —— 一个偏好文件不该让启动挂掉。
 */
function readThemePref() {
  try {
    const mode = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8')).theme
    return THEME_MODES.includes(mode) ? mode : 'system'
  } catch (_) {
    return 'system' // 第一次启动、文件损坏、或用户从没选过
  }
}

/**
 * 把偏好解析成具体主题。
 *
 * 刻意**不**设 `nativeTheme.themeSource`：一旦设了，渲染进程里的
 * `matchMedia('(prefers-color-scheme: light)')` 会跟着变，用户选「跟随系统」
 * 就永远跟不到真实的系统色了。这里只读 `shouldUseDarkColors`。
 */
function resolveTheme() {
  const mode = readThemePref()
  if (mode === 'light' || mode === 'dark') return mode
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
}

/* 主窗口是否已经显示过。`app:shown` 只发一次，页面重载后收不到，所以渲染进程
   还可以主动问这个（见 preload 的 isAppShown）。 */
let mainWindowShown = false

/** 持久化用户选的主题。写失败只记一行日志 —— 不影响本次会话，只是下次冷启动
 *  的闪屏会退回按系统偏好猜。 */
function writeThemePref(mode) {
  try {
    fs.writeFileSync(THEME_FILE, JSON.stringify({ theme: mode }))
  } catch (err) {
    console.warn('[electron] 主题偏好写盘失败:', err.message)
  }
}

/**
 * 把主题同步给 Chromium 的原生部件。
 *
 * 不设 `themeSource` 的话会出现割裂：界面上有原生 `<select>`（权限模式、模型选择、
 * 事件过滤），它们的弹出列表跟的是**系统**而不是应用；系统深色 + 应用浅色时，
 * 弹出来一个深色列表压在浅色界面上。原生标题栏、右键菜单同理。
 *
 * 设了也不会让渲染进程的 `matchMedia('(prefers-color-scheme)')` 失真 —— 三档语义
 * 是一一对应的：mode='system' 时 themeSource 也是 'system'，matchMedia 读到的仍是
 * 真实系统值；而 mode 是显式档位时，渲染进程的 resolve() 本来就短路返回该档位、
 * 根本不查 matchMedia。两边永远一致，前提是这里和 prefs 一起改。
 */
function applyNativeTheme() {
  nativeTheme.themeSource = readThemePref()
}

/** 主窗口的底色。窗口显示前那一小段（以及缩放时的空白）露的就是它，所以要跟主题。 */
function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? '#0b0e14' : '#f2efe8'
}

/**
 * 渲染进程改主题时同步过来（preload 的 setTheme）。
 * 取值在这里校验一遍 —— 渲染进程传来的东西一律当不可信输入。
 */
ipcMain.handle('app:is-shown', () => mainWindowShown)

ipcMain.handle('theme:set', (_event, mode) => {
  const safe = THEME_MODES.includes(mode) ? mode : 'system'
  writeThemePref(safe)
  applyNativeTheme()
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setBackgroundColor(windowBackground())
  return safe
})

/**
 * 9.6.1：让用户挑一个文件夹当工作区。
 * 只返回路径，不落盘不存库 —— 存不存、存什么由服务端设置接口决定，
 * 渲染进程拿到的永远只是一个字符串。
 */
ipcMain.handle('dialog:pick-dir', async () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined
  try {
    const r = await dialog.showOpenDialog(win, {
      title: '选择工作区文件夹',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '用这个文件夹',
    })
    if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true }
    return { ok: true, path: r.filePaths[0] }
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) }
  }
})

/**
 * 10.0.2：关机守护的真实状态。
 *
 * 为什么让界面来问、而不是只看设置项：设置在库里只是「用户想开」，实际有没有
 * 拦住是另一回事（.NET 缺失、PowerShell 被组策略禁掉、非 Windows 都不行）。
 * 界面要显示「已生效 / 未生效 + 原因」，不能只显示一个勾。
 */
ipcMain.handle('shutdown-guard:status', () => {
  try {
    return { ...shutdownGuardInstance().status(), wanted: shutdownGuardEnabled() }
  } catch (err) {
    return { enabled: false, status: 'error', detail: String(err && err.message ? err.message : err), wanted: false }
  }
})

/** 把主题贴到某个窗口的 <html data-theme> 上。走 executeJavaScript，不受页面 CSP 限制。 */
function applyThemeToWindow(win, theme) {
  if (!win || win.isDestroyed()) return
  win.webContents
    .executeJavaScript(
      `(() => { document.documentElement.dataset.theme = ${JSON.stringify(theme)}; return true })()`,
      true,
    )
    .catch(() => {
      /* 窗口还没加载完 / 已被关掉，忽略 */
    })
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

/* ------------------------------------------------------------------ *
 * 8.0.0：托盘 / 通知 / 全局快捷键 / 工具链下载桥
 * ------------------------------------------------------------------ */

const DESKTOP_TEXT = {
  zh: {
    show: '显示主窗口',
    hide: '隐藏主窗口',
    newTask: '新建任务',
    checkUpdate: '检查更新',
    quit: '退出',
    completed: '任务已完成',
    needsInput: '任务需要你回复',
    shortcutFailed: '全局快捷键注册失败，可能已被其他应用占用',
  },
  en: {
    show: 'Show window',
    hide: 'Hide window',
    newTask: 'New task',
    checkUpdate: 'Check for updates',
    quit: 'Quit',
    completed: 'Task completed',
    needsInput: 'Task needs your input',
    shortcutFailed: 'Global shortcut could not be registered',
  },
}

function uiLang() {
  try {
    return storeModule.getSetting('uiLanguage', 'zh') === 'en' ? 'en' : 'zh'
  } catch (_) {
    return 'zh'
  }
}

function t(key) {
  return (DESKTOP_TEXT[uiLang()] || DESKTOP_TEXT.zh)[key] || key
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isVisible()) mainWindow.hide()
  else showWindow()
}

function trayIconPath() {
  const png = path.join(__dirname, '..', 'build', 'icon.png')
  if (fs.existsSync(png)) return png
  return path.join(__dirname, '..', 'build', 'icon.ico')
}

function syncTray() {
  let enabled = true
  try {
    enabled = storeModule.getSetting('trayEnabled', '1') === '1'
  } catch (_) {
    enabled = true
  }
  if (!enabled) {
    if (tray) {
      tray.destroy()
      tray = null
    }
    return
  }
  if (tray) {
    // 只更新菜单（语言/状态可能变了）
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('show'), click: showWindow },
        { label: t('hide'), click: () => mainWindow?.hide() },
        { type: 'separator' },
        {
          label: '⚡ 速答 (Ctrl+Alt+Space)',
          click: () => toggleQuickWindow(),
        },
        {
          label: t('newTask'),
          click: () => {
            showWindow()
            mainWindow?.webContents.send('menu:new-task')
          },
        },
        {
          label: t('checkUpdate'),
          click: () => {
            showWindow()
            mainWindow?.webContents.send('menu:check-update')
          },
        },
        { type: 'separator' },
        {
          label: t('quit'),
          click: () => {
            isQuitting = true
            requestQuit()
          },
        },
      ]),
    )
    return
  }

  let image = nativeImage.createFromPath(trayIconPath())
  if (image.isEmpty()) {
    console.warn('[electron] 托盘图标加载失败')
    return
  }
  image = image.resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.setToolTip('ChaosConsole')
  tray.on('click', toggleWindow)
  syncTray() // 复用上面的菜单构建逻辑
}

/* ------------------------------------------------------------------ *
 * 10.0.2：运行期间拦截系统关机
 *
 * 设置项 blockShutdown 打开后，主进程起一个隐藏窗体守护（见 shutdown-guard.js），
 * 对 WM_QUERYENDSESSION 返回 FALSE —— 用户点「关机」时 Windows 会停在本应用上，
 * 并在阻止清单里显示「ChaosConsole 不允许关机」，我们同时弹窗 + 通知界面。
 *
 * 三条设计底线：
 *  1. 默认关：这一点用户可感知（关不掉机挺烦），要用户自己在设置里开。
 *  2. 退出应用必须把守护一起收掉，否则用户退出后还关不掉机，那是事故。
 *  3. 拦不住要如实说（没有 .NET / 被策略禁用 / 非 Windows），不能显示「已开启」却不干活。
 * ------------------------------------------------------------------ */
let shutdownGuard = null

function shutdownGuardInstance() {
  if (shutdownGuard) return shutdownGuard
  shutdownGuard = new ShutdownGuard({
    userDataDir: app.getPath('userData'),
    onBlocked: ({ at }) => {
      console.log('[electron] 已拦截一次系统关机:', at)
      /* 界面还在就先弹应用内提示，再弹一个系统级对话框 —— 关机流程里界面可能已经
       * 来不及画，但对话框属于系统窗口，能出现在「阻止关机」界面之上。 */
      try {
        mainWindow?.webContents.send('desktop:notice', {
          kind: 'warn',
          text: 'ChaosConsole 不允许关机，已取消关机',
        })
      } catch (_) {
        /* ignore */
      }
      try {
        const opts = {
          type: 'warning',
          title: 'ChaosConsole',
          message: 'ChaosConsole 不允许关机',
          detail:
            '已拦截本次关机。如果确实需要关机，请先在「设置 → 桌面集成」里关闭「运行期间禁止关机」，或先退出 ChaosConsole。',
          buttons: ['知道了'],
          noLink: true,
        }
        if (mainWindow && !mainWindow.isDestroyed()) dialog.showMessageBox(mainWindow, opts)
        else dialog.showMessageBox(opts)
      } catch (_) {
        /* ignore */
      }
    },
    onStatus: (s) => {
      try {
        mainWindow?.webContents.send('shutdown-guard:status', s)
      } catch (_) {
        /* ignore */
      }
    },
  })
  return shutdownGuard
}

function shutdownGuardEnabled() {
  try {
    return storeModule.getSetting('blockShutdown', '0') === '1'
  } catch (_) {
    return false
  }
}

function syncShutdownGuard() {
  const on = shutdownGuardEnabled()
  try {
    const g = shutdownGuardInstance()
    g.sync(on)
    if (on) console.log('[electron] 运行期间禁止关机：已开启（守护进程守护中）')
  } catch (err) {
    console.error('[electron] 关机守护启停失败:', err.message)
  }
}

/** 退出前必须收掉守护，不然用户关掉应用后依然关不掉机 */
function stopShutdownGuard() {
  try {
    shutdownGuard?.stop()
  } catch (_) {
    /* ignore */
  }
}

function syncGlobalShortcut() {
  let accel = 'CommandOrControl+Shift+Space'
  try {
    accel = storeModule.getSetting('globalShortcut', accel)
  } catch (_) {
    /* ignore */
  }
  if (registeredShortcut) {
    try {
      globalShortcut.unregister(registeredShortcut)
    } catch (_) {
      /* ignore */
    }
    registeredShortcut = ''
  }
  if (!accel || accel === 'off') return
  try {
    const ok = globalShortcut.register(accel, toggleWindow)
    if (ok) registeredShortcut = accel
    else mainWindow?.webContents.send('desktop:notice', { kind: 'error', text: t('shortcutFailed') })
  } catch (err) {
    console.error('[electron] 全局快捷键注册失败:', err.message)
  }
}

/* ------------------------------------------------------------------ *
 * 8.0.2：全局速答小窗
 *
 * WorkBuddy 式「全局唤起」：任何应用里按 Ctrl+Alt+Space，屏幕上方弹出
 * 一个小窗，一句话问混沌（本地免费推理），问完即走。实现上直接复用
 * 渲染层的界面（?quick=1 走独立速答页），不需要单独的 HTML。
 * ------------------------------------------------------------------ */

const QUICK_SHORTCUT = 'CommandOrControl+Alt+Space'

async function toggleQuickWindow() {
  if (quickWindow && !quickWindow.isDestroyed()) {
    if (quickWindow.isVisible()) {
      quickWindow.hide()
      return
    }
    quickWindow.show()
    quickWindow.focus()
    return
  }
  try {
    const base = await resolveTarget()
    const target = `${base}${base.includes('?') ? '&' : '?'}quick=1`
    quickWindow = new BrowserWindow({
      width: 560,
      height: 430,
      show: false,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      backgroundColor: windowBackground(),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    })
    quickWindow.setAlwaysOnTop(true, 'screen-saver')
    quickWindow.once('ready-to-show', () => {
      quickWindow?.show()
      quickWindow?.focus()
    })
    quickWindow.on('closed', () => {
      quickWindow = null
    })
    // 点别处就收起来（blur），像系统级唤起条一样
    quickWindow.on('blur', () => {
      if (quickWindow && !quickWindow.webContents.isDevToolsOpened()) quickWindow.hide()
    })
    await quickWindow.loadURL(target)
  } catch (err) {
    console.error('[electron] 速答窗口打开失败:', err.message)
    quickWindow = null
  }
}

function setupNotifications() {
  if (!Notification.isSupported()) return
  const lastStatus = new Map()
  storeModule.bus.on('task:updated', (task) => {
    if (!task || !task.id) return
    const prev = lastStatus.get(task.id)
    lastStatus.set(task.id, task.status)
    if (prev === undefined || prev === task.status) return
    if (task.status !== 'complete' && task.status !== 'needs_input') return

    let allowed = true
    try {
      if (task.status === 'complete') allowed = storeModule.getSetting('notifyOnComplete', '1') === '1'
      else allowed = storeModule.getSetting('notifyOnNeedsInput', '1') === '1'
      if (allowed && storeModule.getSetting('notifyOnlyWhenUnfocused', '1') === '1') {
        allowed = !(mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused())
      }
    } catch (_) {
      /* 读设置失败就按默认允许 */
    }
    if (!allowed) return

    try {
      const note = new Notification({
        title: task.status === 'complete' ? t('completed') : t('needsInput'),
        body: task.title || '',
        icon: trayIconPath(),
      })
      note.on('click', () => {
        showWindow()
        mainWindow?.webContents.send('task:focus', task.id)
      })
      note.show()
    } catch (err) {
      console.error('[electron] 通知失败:', err.message)
    }
  })
  storeModule.bus.on('task:deleted', (payload) => lastStatus.delete(payload?.id))
}

/* ---- 工具链：主进程下载（Chromium 网络栈，能过系统代理/加速器证书） ---- */

async function downloadFile({ url, dest, sha256, sha512, maxBytes, signal, onProgress } = {}) {
  if (!/^https:\/\//i.test(String(url || ''))) throw new Error('只允许 HTTPS 下载')
  if (!dest || typeof dest !== 'string') throw new Error('缺少下载目标路径')
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const temp = `${dest}.part`
  const hash256 = crypto.createHash('sha256')
  const hash512 = crypto.createHash('sha512')

  let res
  try {
    res = await ghFetch(url, {
      headers: { 'User-Agent': 'ChaosConsole-Toolchain' },
      redirect: 'follow',
      signal,
    })
  } catch (err) {
    throw new Error(`下载失败：${err.message}`)
  }
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`)

  const total = Number(res.headers.get('content-length')) || 0
  if (maxBytes && total && total > maxBytes) throw new Error('安装包超出大小上限')

  const fd = fs.openSync(temp, 'w')
  let received = 0
  let lastAt = 0
  try {
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      received += buf.length
      if (maxBytes && received > maxBytes) throw new Error('安装包超出大小上限')
      fs.writeSync(fd, buf)
      hash256.update(buf)
      hash512.update(buf)
      const now = Date.now()
      if (now - lastAt >= 500) {
        lastAt = now
        try {
          onProgress?.({ transferred: received, total, percent: total ? (received / total) * 100 : 0 })
        } catch (_) {
          /* ignore */
        }
      }
    }
  } catch (err) {
    fs.closeSync(fd)
    try {
      fs.unlinkSync(temp)
    } catch (_) {
      /* ignore */
    }
    throw err
  }
  fs.closeSync(fd)

  const got256 = hash256.digest('hex')
  const got512 = hash512.digest('base64')
  if (sha256 && got256.toLowerCase() !== String(sha256).toLowerCase()) {
    try {
      fs.unlinkSync(temp)
    } catch (_) {
      /* ignore */
    }
    throw new Error('SHA-256 校验失败，已丢弃下载文件')
  }
  if (sha512 && got512 !== String(sha512)) {
    try {
      fs.unlinkSync(temp)
    } catch (_) {
      /* ignore */
    }
    throw new Error('SHA-512 校验失败，已丢弃下载文件')
  }
  fs.renameSync(temp, dest)
  return { ok: true, path: dest, size: received, sha256: got256, sha512: got512 }
}

function openExternalSafe(url) {
  try {
    const u = new URL(String(url))
    if (u.protocol !== 'https:') return false
    shell.openExternal(u.toString())
    return true
  } catch (_) {
    return false
  }
}

function registerDesktopHost() {
  serverModule.setDesktopHost({
    downloadFile,
    openExternal: openExternalSafe,
    revealPath: (p) => {
      try {
        shell.showItemInFolder(String(p))
      } catch (_) {
        /* ignore */
      }
    },
  })
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
    backgroundColor: windowBackground(),
    title: 'AI Agent开发控制台',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      // 给自检脚本的逃生口：启动屏有 5 秒强制等待，而 e2e-check / responsive-check
      // 都是「reload 之后按固定毫秒数断言」的，多这 5 秒会把它们全部打断。
      // preload 读到这个参数后暴露成 window.chaos.skipBoot。用法见 README 的自检一节。
      additionalArguments: process.env.CHAOS_SKIP_BOOT ? ['--chaos-skip-boot'] : [],
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
    mainWindowShown = true
    // 等闪屏真的淡出关掉，再通知启动屏开始计时。两个原因：
    //   1. 闪屏期间主窗口已经在渲染了，那时计时等于把 5 秒播给一个看不见的窗口；
    //   2. closeSplash() 本身还要 320ms 淡出 + 关闭，show() 之后立刻发的话，
    //      这 300 多毫秒用户看到的还是闪屏，5 秒会缩水成 4 秒多。
    await closeSplash()
    mainWindow?.webContents.send('app:shown')
  })

  // 第一次「关闭」请求先拦下来播退场动画；动画播完后 closeState 不再是 running，
  // 这时 app.quit() 再次关窗就会正常放行。
  mainWindow.on('close', (event) => {
    // 关窗这一刻的状态才是用户想要的，所以不等防抖计时器，直接落盘。
    // 这里即使被下面的 preventDefault 拦下来也没关系：窗口还在，坐标就是有效的。
    saveWindowState()
    if (closeState !== 'running') return

    // 8.0.0：可选的「关闭到托盘」。默认关闭，只有用户显式开启且托盘存在时才拦截。
    let closeToTray = false
    try {
      closeToTray =
        storeModule.getSetting('closeToTray', '0') === '1' &&
        storeModule.getSetting('trayEnabled', '1') === '1'
    } catch (_) {
      closeToTray = false
    }
    if (closeToTray && !isQuitting) {
      event.preventDefault()
      mainWindow.hide()
      return
    }

    event.preventDefault()
    requestQuit()
  })

  mainWindow.on('closed', () => {
    if (windowSaveTimer) {
      clearTimeout(windowSaveTimer)
      windowSaveTimer = null
    }
    mainWindow = null
  })

  /* 10.0.2：关机兜底。
   * Electron 只有在系统已经决定结束会话之后才发 session-end，来不及 preventDefault，
   * 但这时仍可能有权限强的实例把关机撤掉 —— 保守试一次 `shutdown /a`：
   * 普通用户会失败（返回码非 0），失败就当没发生；有权限就真的取消了。
   * 主拦截在 shutdown-guard.js 的窗体里，这条只是最后一层。 */
  mainWindow.on('session-end', () => {
    if (!shutdownGuardEnabled()) return
    try {
      spawn('shutdown', ['/a'], { windowsHide: true, stdio: 'ignore' })
    } catch (_) {
      /* ignore */
    }
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

  // 9.5.1：渲染进程崩溃（GPU 等）自愈 —— 自动重载一次，不再无声黑屏
  let rendererGoneReloaded = false
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[renderer-gone] ${details.reason}`)
    if (!rendererGoneReloaded && details.reason !== 'clean-exit') {
      rendererGoneReloaded = true
      setTimeout(() => mainWindow.webContents.reload(), 800)
    }
  })

  // 9.5.1：E2E 模式把渲染进程的控制台/崩溃转发到主进程 stdout ——
  // 白屏排障用（正式运行不影响）。
  if (process.env.CHAOS_E2E === '1') {
    mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`)
    })
    mainWindow.webContents.on('render-process-gone', (_e, details) => {
      console.error(`[renderer-gone] ${JSON.stringify(details)}`)
    })
  }
}

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

app.whenReady().then(async () => {
  // 9.5.4：启动即清 HTTP 缓存与 V8 代码缓存。升级后渲染进程曾从磁盘缓存里
  // 拿到旧版 index.html（引用旧 bundle），导致「明明装了新版、窗口里跑的还是
  // 旧前端」。本应用所有内容都来自本机服务，缓存毫无收益、只有风险 —— 每次启动清一次。
  try {
    await session.defaultSession.clearCache()
    await session.defaultSession.clearCodeCaches({})
  } catch (_) {
    /* 清不掉也不阻塞启动 */
  }

  // 必须在 createSplash 之前：闪屏窗口也是 Chromium，它的原生部件同样要看 themeSource
  applyNativeTheme()
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
  // 8.0.0：工具链下载能力只注入给「进程内启动」的后端；
  // 外部后端（npm run dev）拿不到 Electron 的网络栈，会如实返回 unsupported。
  if (ownsServer) registerDesktopHost()
  initUpdater()
  scheduleIdleAutoUpdate()
  applyCsp()
  buildMenu()
  pushBootStep('装载工作台界面', 88)
  await createWindow()

  // 8.0.0：托盘 / 全局快捷键 / 原生通知
  syncTray()
  syncGlobalShortcut()
  setupNotifications()
  // 8.0.2：全局速答热键（独立于用户可配置的显隐热键，固定 Ctrl+Alt+Space）
  try {
    globalShortcut.register(QUICK_SHORTCUT, toggleQuickWindow)
  } catch (err) {
    console.error('[electron] 速答热键注册失败:', err.message)
  }
  storeModule.bus.on('settings:updated', ({ key }) => {
    if (key === 'trayEnabled' || key === 'uiLanguage' || key === 'closeToTray') syncTray()
    if (key === 'globalShortcut') syncGlobalShortcut()
    // 10.0.2：设置里开关「运行期间禁止关机」，立刻生效，不用重启应用
    if (key === 'blockShutdown') syncShutdownGuard()
  })

  // 10.0.2：上次是开着的话，这次启动就把守护拉起来
  syncShutdownGuard()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // 托盘存在且不是真正退出时，窗口全关也不退出（正常流程里窗口会被 hide 拦截）
    if (!isQuitting) {
      try {
        if (storeModule.getSetting('trayEnabled', '1') === '1') return
      } catch (_) {
        /* ignore */
      }
    }
    app.quit()
  }
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
  isQuitting = true
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
  isQuitting = true
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
  /* 10.0.2：收尾第一步就把关机守护停掉。这一步不能等到 will-quit ——
   * 下面走的是 app.exit(0)，它不发 will-quit，守护进程会变成孤儿，
   * 用户关掉应用后还关不掉机。 */
  stopShutdownGuard()
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
          // 版本回退：直接拉起我们自己下好的安装包，不经过 electron-updater。
          //
          // 三个参数缺一不可，而且「装完自动把应用拉起来」这件事完全靠它们：
          //   --updated    告诉安装器这是原地升级：它会据此 taskkill 掉还在跑的旧进程
          //                （`_CHECK_APP_RUNNING` 里 isUpdated 分支），并跳过若干页面
          //   /S           静默安装
          //   --force-run  装完启动应用
          // electron-builder 的 assisted 安装器里，自动启动的条件是写死的：
          //     ${if} ${isForceRun} ${andIf} ${Silent} → doStartApp
          // 少了 /S 就只会弹一个「完成」页，等用户点那个默认勾选的复选框 ——
          // 用户点了「安装并重启」，结果还得自己再点一次「完成」，这就是之前的毛病。
          //
          // 不传 /currentuser 或 /allusers：安装器在页面之前就会读注册表，
          // 沿用已有安装的范围（assistedInstaller.nsh 的 if/elseif 链）。主动传反而
          // 危险 —— 传错了会跑到另一个范围又装一份，还可能先把原来那份卸掉。
          spawn(pendingInstallerPath, ['--updated', '/S', '--force-run'], {
            detached: true,
            stdio: 'ignore',
          }).unref()
        } else if (updater) {
          // 正常升级：交给 electron-updater。第二个参数 isForceRunAfter=true 让它带上
          // --force-run，第一个参数 isSilent=true 让它带上 /S —— 同样是为了凑齐
          // 「静默 + 强制启动」这对条件，否则它只会弹安装向导。
          // 它内部会先同步 spawn 安装器，再 setImmediate(app.quit())；此刻
          // finalized 已为 true，上面的 before-quit 分支会直接放行，不会被二次
          // preventDefault 卡住。
          updater.quitAndInstall(true, true)
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

app.on('will-quit', () => {
  try {
    globalShortcut.unregisterAll()
  } catch (_) {
    /* ignore */
  }
  // 10.0.2：守护进程必须随应用一起退，否则用户关掉应用后依然关不掉机
  stopShutdownGuard()
})

process.on('uncaughtException', (err) => {
  console.error('[electron] 未捕获异常:', err)
})

/* 10.0.2：进程以任何方式消失（崩溃 / 被 taskkill / 正常退出）都要把关机守护带走，
 * 否则用户关掉应用后还关不掉机 —— 那是比「不拦」更糟的事故。 */
process.on('exit', () => {
  try {
    shutdownGuard?.killNow()
  } catch (_) {
    /* ignore */
  }
})
