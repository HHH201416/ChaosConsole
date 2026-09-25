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
const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron')

const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production'
const DEV_URL = process.env.CHAOS_DEV_URL || 'http://127.0.0.1:5173'

// 打包后数据落在用户目录，Program Files 是只读的
process.env.CHAOS_DATA_DIR = process.env.CHAOS_DATA_DIR || path.join(app.getPath('userData'), 'data')

const serverModule = require('../server/index.js')

let mainWindow = null
let serverPort = null
let ownsServer = false

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

function initUpdater() {
  try {
    // electron-updater 只在打包后可 require（它依赖 app-update.yml）
    updater = require('electron-updater').autoUpdater
  } catch (err) {
    updaterError = err.message
    return null
  }

  updater.autoDownload = true

  updater.on('update-downloaded', async (info) => {
    if (ownsServer) {
      serverModule.broadcast('update:status', { status: 'downloaded', message: `新版本 ${info.version} 已下载` })
    }
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
      title: '更新已就绪',
      message: `新版本 ${info.version} 已下载完成`,
      detail: '重启应用即可完成安装。',
    })
    if (response === 0) {
      setImmediate(() => updater.quitAndInstall())
    }
  })

  updater.on('error', (err) => {
    console.error('[updater] 出错:', err.message)
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
      resolve(data)
    }

    const onAvailable = (info) =>
      finish({
        supported: true,
        status: 'available',
        version: info?.version,
        message: `发现新版本 ${info?.version}，正在后台下载…`,
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

    Promise.resolve(updater.checkForUpdates()).catch(onError)
    setTimeout(() => finish({ supported: true, status: 'timeout', message: '检查更新超时，请稍后重试。' }), 30000)
  })
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
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建任务',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new-task'),
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开数据目录',
          click: () => shell.openPath(process.env.CHAOS_DATA_DIR),
        },
        {
          label: '检查更新',
          click: () => mainWindow?.webContents.send('menu:check-update'),
        },
        { type: 'separator' },
        {
          label: `关于 AI Agent开发控制台 v${app.getVersion()}`,
          click: () =>
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于',
              message: 'AI Agent开发控制台 (ChaosConsole)',
              detail:
                `版本 v${app.getVersion()}\n` +
                `Electron ${process.versions.electron}\n` +
                `Node ${process.versions.node}\n\n` +
                `数据目录：${process.env.CHAOS_DATA_DIR}`,
              buttons: ['好'],
            }),
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 1100,
    minHeight: 640,
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

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
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
  if (USE_EXTERNAL_SERVER) {
    serverPort = Number(process.env.CHAOS_PORT || 43117)
    console.log(`[electron] 使用外部后端（端口 ${serverPort}），本进程不再启动服务`)
    if (!(await probe(`http://127.0.0.1:${serverPort}`))) {
      dialog.showErrorBox(
        '后端未就绪',
        `CHAOS_EXTERNAL_SERVER=1 表示后端由外部提供，但 127.0.0.1:${serverPort} 上没有服务在监听。\n` +
          '请先启动 npm run dev:server，或去掉该环境变量让 Electron 自己启动后端。',
      )
      app.quit()
      return
    }
  } else {
    try {
      const { port } = await serverModule.start()
      serverPort = port
      ownsServer = true
      console.log(`[electron] 后端已就绪，端口 ${port}`)
    } catch (err) {
      console.error('[electron] 后端启动失败:', err)
      dialog.showErrorBox('后端启动失败', String(err?.stack || err))
      app.quit()
      return
    }
  }

  serverModule.setUpdateHandler(checkForUpdates)
  initUpdater()
  applyCsp()
  buildMenu()
  await createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

let shuttingDown = false
app.on('before-quit', async (event) => {
  if (shuttingDown) return
  shuttingDown = true
  event.preventDefault()
  // 只关自己启动的后端；外部后端由 npm run dev 的 concurrently 负责收尾
  if (ownsServer) {
    try {
      await serverModule.stop()
    } catch (err) {
      console.error('[electron] 关闭后端出错:', err.message)
    }
  }
  app.exit(0)
})

process.on('uncaughtException', (err) => {
  console.error('[electron] 未捕获异常:', err)
})
