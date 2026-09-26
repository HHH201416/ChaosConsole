'use strict'

/**
 * 后端入口：Express（REST + 静态托管） + ws（实时推送） + SQLite 持久化。
 *
 * 数据流：
 *   REST 改状态 → store 更新 SQLite 并 emit 事件 → 这里广播给所有 WS 客户端
 *   runner 抓 claude 的 stdout → store 落库并 emit → 同样广播
 *
 * 前端因此永远是被动接收方：它只管发指令 + 渲染推送。
 */

const http = require('http')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const express = require('express')
const cors = require('cors')
const { WebSocketServer } = require('ws')

const CONFIG = require('./config')
const db = require('./db')
const store = require('./store')
const runner = require('./runner')
const queue = require('./queue')
const chat = require('./chat')
const mcp = require('./mcp')
const executors = require('./executors')

/* ------------------------------------------------------------------ *
 * 授权
 * ------------------------------------------------------------------ */

const sessions = new Set()

function issueToken() {
  const token = crypto.randomUUID()
  sessions.add(token)
  return token
}

function isValidToken(token) {
  return Boolean(token) && sessions.has(token)
}

function requireAuth(req, res, next) {
  const token = req.get('x-chaos-token') || req.query.token
  if (!isValidToken(token)) {
    return res.status(401).json({ ok: false, error: '未授权，请重新登录' })
  }
  next()
}

/**
 * 校验请求里带的 执行器 / 模型。两者都会被写进任务或员工记录，最终进 CLI 的
 * argv，而 Windows 上那两个 CLI 都是经 cmd.exe 转发的 —— 所以只接受白名单里的
 * 值，别让任意字符串有机会变成命令行的一部分。
 * 返回错误信息；没问题时返回 null。
 */
function validateExecutorModel(executor, model, fallbackExecutor = 'claude') {
  if (executor !== undefined && executor !== '' && !executors.isValidExecutor(executor)) {
    return '非法的执行器'
  }
  if (model !== undefined && model !== '' && !executors.isValidModel(executor || fallbackExecutor, model)) {
    return '该执行器没有这个模型'
  }
  return null
}

/* ------------------------------------------------------------------ *
 * Express
 * ------------------------------------------------------------------ */

const app = express()
app.use(cors())
app.use(express.json({ limit: '2mb' }))

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'chaos-console', version: APP_VERSION })
})

app.post('/api/login', (req, res) => {
  const code = String(req.body?.code ?? '').trim()
  if (code !== CONFIG.AUTH_CODE) {
    return res.status(401).json({ ok: false, error: '授权码不正确' })
  }
  res.json({ ok: true, token: issueToken() })
})

app.get('/api/system', requireAuth, (_req, res) => {
  res.json({
    ok: true,
    data: {
      version: APP_VERSION,
      port: actualPort,
      dataDir: CONFIG.DATA_DIR,
      dbFile: CONFIG.DB_FILE,
      claudeBin: runner.resolveClaudeBin() || null,
      claudeAvailable: runner.claudeAvailable(),
      devecoBin: executors.resolveDevecoBin() || null,
      devecoAvailable: executors.devecoAvailable(),
      // DevEco Studio 的 hvigorw / hdc / ohpm 绝对路径。Studio 不把它们加进 PATH，
      // Agent 要用绝对路径调用，界面上也便于排查「为什么构建跑不起来」。
      devecoTools: executors.resolveDevecoTools(),
      executors: executors.describe(),
      permissionMode: store.getSetting('permissionMode', CONFIG.PERMISSION_MODE),
      validPermissionModes: CONFIG.VALID_PERMISSION_MODES,
      devecoAutoApprove: store.getSetting('devecoAutoApprove', '0') === '1',
      autoUpdateWhenIdle: store.getSetting('autoUpdateWhenIdle', '0') === '1',
      defaultCwd: CONFIG.DEFAULT_CWD,
      platform: process.platform,
      runningTaskIds: runner.runningTaskIds(),
      isElectron: Boolean(process.versions.electron),
      mcp: mcp.summary(),
    },
  })
})

app.post('/api/settings', requireAuth, (req, res) => {
  const { permissionMode, devecoAutoApprove, mcpAllowedDirs, autoUpdateWhenIdle } = req.body || {}
  if (permissionMode !== undefined) {
    if (!CONFIG.isValidPermissionMode(permissionMode)) {
      return res.status(400).json({ ok: false, error: '非法的权限模式' })
    }
    store.setSetting('permissionMode', permissionMode)
  }
  if (devecoAutoApprove !== undefined) {
    store.setSetting('devecoAutoApprove', devecoAutoApprove ? '1' : '0')
  }
  // 空闲时自动检查并下载更新（默认关）。只影响「下不下」，
  // 「装不装」始终要用户确认。
  if (autoUpdateWhenIdle !== undefined) {
    store.setSetting('autoUpdateWhenIdle', autoUpdateWhenIdle ? '1' : '0')
  }
  if (Array.isArray(mcpAllowedDirs)) {
    mcp.setAllowedDirs(mcpAllowedDirs)
  }
  res.json({ ok: true })
})

/* ---- 执行器与模型 ---- */

app.get('/api/executors', requireAuth, (_req, res) => {
  res.json({ ok: true, data: executors.describe() })
})

/* ---- MCP ---- */

app.get('/api/mcp', requireAuth, (_req, res) => {
  res.json({ ok: true, data: { servers: mcp.list(), summary: mcp.summary(), allowedDirs: mcp.allowedDirs() } })
})

app.post('/api/mcp/enable', requireAuth, async (req, res) => {
  const { id, env, arg } = req.body || {}
  try {
    const result = await mcp.enable(id, { env, arg })
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/mcp/disable', requireAuth, async (req, res) => {
  const { id } = req.body || {}
  try {
    const result = await mcp.disable(id)
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

/* ---- 对话 ---- */

app.get('/api/conversations', requireAuth, (_req, res) => {
  res.json({ ok: true, data: chat.listConversations() })
})

app.post('/api/chat', requireAuth, (req, res) => {
  const { conversationId, text, cwd, executor, model, agentId } = req.body || {}
  const bad = validateExecutorModel(executor, model)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  const result = chat.send({ conversationId, text, cwd, executor, model, agentId })
  if (!result.ok) return res.status(400).json(result)
  res.json(result)
})

/** 一键清空所有任务（让看板回到 0 任务） */
app.post('/api/tasks/clear', requireAuth, (_req, res) => {
  // 先掐掉所有在跑的回合再清库：否则进程还在跑，而且 clearAllTasks 会把
  // 这些 Agent 一律置为空闲，于是同一个员工可能被派上第二个任务并发执行。
  for (const t of store.listTasks()) queue.forgetTask(t.id)
  store.clearAllTasks()
  res.json({ ok: true })
})

app.get('/api/state', requireAuth, (_req, res) => {
  res.json({ ok: true, data: store.snapshot() })
})

/* ---- 员工 ---- */

app.get('/api/agents', requireAuth, (_req, res) => {
  res.json({ ok: true, data: store.listAgents() })
})

app.post('/api/agents', requireAuth, (req, res) => {
  // 「新岗位」表单里的职能名 / 执行器 / 模型都要带上：以前这里只透传了
  // name/role/avatar/systemPrompt，于是用户填的职能名被丢掉，落库变成 role
  // 的兜底值，执行器和模型也被强制成 claude —— 而且没有编辑入口可以改回来。
  const { name, role, avatar, systemPrompt, executor, model, functionLabel } = req.body || {}
  if (!name || !String(name).trim()) {
    return res.status(400).json({ ok: false, error: '请填写员工姓名' })
  }
  const bad = validateExecutorModel(executor, model)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  res.json({ ok: true, data: store.createAgent({ name, role, avatar, systemPrompt, executor, model, functionLabel }) })
})

app.patch('/api/agents/:id', requireAuth, (req, res) => {
  const patch = req.body || {}
  const current = store.getAgent(req.params.id)
  if (!current) return res.status(404).json({ ok: false, error: '员工不存在' })
  const bad = validateExecutorModel(patch.executor, patch.model, current.executor)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  res.json({ ok: true, data: store.updateAgent(req.params.id, patch) })
})

app.delete('/api/agents/:id', requireAuth, (req, res) => {
  const ok = store.deleteAgent(req.params.id)
  if (!ok) return res.status(404).json({ ok: false, error: '员工不存在' })
  res.json({ ok: true })
})

/* ---- 任务 ---- */

app.get('/api/tasks', requireAuth, (_req, res) => {
  res.json({ ok: true, data: store.listTasks() })
})

app.post('/api/tasks', requireAuth, (req, res) => {
  const { title, description, tags, cwd, agentId, executor, model } = req.body || {}
  if (!title || !String(title).trim()) {
    return res.status(400).json({ ok: false, error: '请填写任务名称' })
  }
  const bad = validateExecutorModel(executor, model)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  res.json({ ok: true, data: store.createTask({ title, description, tags, cwd, agentId, executor, model }) })
})

app.get('/api/tasks/:id', requireAuth, (req, res) => {
  const task = store.getTask(req.params.id)
  if (!task) return res.status(404).json({ ok: false, error: '任务不存在' })
  res.json({
    ok: true,
    data: {
      task,
      agent: task.agentId ? store.getAgent(task.agentId) : null,
      messages: store.listMessages(task.id),
      events: store.listEvents(task.id),
      isRunning: runner.isRunning(task.id),
    },
  })
})

app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const patch = req.body || {}
  const current = store.getTask(req.params.id)
  if (!current) return res.status(404).json({ ok: false, error: '任务不存在' })
  const bad = validateExecutorModel(patch.executor, patch.model, current.executor)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  res.json({ ok: true, data: store.updateTask(req.params.id, patch) })
})

app.delete('/api/tasks/:id', requireAuth, (req, res) => {
  if (!store.getTask(req.params.id)) return res.status(404).json({ ok: false, error: '任务不存在' })
  // 先停掉还在跑的回合，否则进程会继续跑下去，而且它写回的记录没有归属
  queue.forgetTask(req.params.id)
  store.deleteTask(req.params.id)
  res.json({ ok: true })
})

app.get('/api/tasks/:id/messages', requireAuth, (req, res) => {
  res.json({ ok: true, data: store.listMessages(req.params.id) })
})

app.get('/api/tasks/:id/events', requireAuth, (req, res) => {
  res.json({ ok: true, data: store.listEvents(req.params.id) })
})

app.post('/api/tasks/:id/history/clear', requireAuth, (req, res) => {
  if (!store.getTask(req.params.id)) return res.status(404).json({ ok: false, error: '任务不存在' })
  store.clearTaskHistory(req.params.id)
  res.json({ ok: true })
})

/* ---- 动作 ---- */

const actions = {
  start: (id) => queue.startTask(id),
  cancel: (id) => queue.cancelTask(id),
  done: (id) => queue.markDone(id),
  input: (id, body) => queue.sendInput(id, body?.text),
  move: (id, body) => queue.moveTask(id, body?.status),
  assign: (id, body) => {
    const agentId = body?.agentId || null
    if (agentId && !store.getAgent(agentId)) return { ok: false, error: '员工不存在' }
    const before = store.getTask(id)
    store.updateTask(id, { agentId })
    // 换人之后要把原来那位放回空闲：任务已经不属于它了，settle 时释放的
    // 只会是新 Agent，不补这一步的话旧 Agent 会永远卡在「忙碌」上，
    // 再也接不到新任务（重试几次就把空闲员工耗光）。
    if (before?.agentId && before.agentId !== agentId) store.releaseAgentIfIdle(before.agentId)
    return { ok: true }
  },
}

app.post('/api/tasks/:id/:action', requireAuth, (req, res) => {
  const handler = actions[req.params.action]
  if (!handler) return res.status(404).json({ ok: false, error: '未知操作' })
  if (!store.getTask(req.params.id)) return res.status(404).json({ ok: false, error: '任务不存在' })
  const result = handler(req.params.id, req.body || {})
  if (result && result.ok === false) return res.status(400).json(result)
  res.json(result || { ok: true })
})

/* ---- 更新 ---- */

let updateHandler = null
function setUpdateHandler(fn) {
  updateHandler = fn
}

/* 下载与安装同样由主进程提供实现。autoDownload 关掉之后，下载必须由用户
   在界面上显式点击触发，所以这里是独立于「检查」的一步。 */
let downloadHandler = null
function setDownloadHandler(fn) {
  downloadHandler = fn
}

let installHandler = null
function setInstallHandler(fn) {
  installHandler = fn
}

/* 主进程持有实时的更新状态（含下载进度），进度不经过 updateState，
   所以查询接口优先问它 */
let updateStatusHandler = null
function setUpdateStatusHandler(fn) {
  updateStatusHandler = fn
}

const UPDATER_UNAVAILABLE = {
  supported: false,
  status: 'unsupported',
  message: '当前运行在开发模式（未打包），自动更新不可用。打包安装后才生效。',
}

/** 把「下载」和「安装」的路由收敛成一个，两者形状完全一致 */
function makeUpdateActionRoute(getHandler) {
  return async (_req, res) => {
    const handler = getHandler()
    if (!handler) {
      return res.json({ ok: true, data: { ...UPDATER_UNAVAILABLE } })
    }
    try {
      const data = await handler()
      updateState = { ...data }
      res.json({ ok: true, data })
    } catch (err) {
      updateState = { supported: true, status: 'error', message: err.message }
      res.json({ ok: false, data: updateState })
    }
  }
}

app.post('/api/update/check', requireAuth, async (_req, res) => {
  if (!updateHandler) {
    return res.json({
      ok: true,
      data: {
        supported: false,
        status: 'unsupported',
        message: '当前运行在开发模式（未打包），自动更新不可用。打包安装后才生效。',
      },
    })
  }
  try {
    const data = await updateHandler()
    // 记下最近一次结果，供 /api/update/status 查询 —— 以前那个接口读的是一个
    // 初始化后再也没人写过的 updateState，永远回答 status:'idle'。
    updateState = { ...data }
    res.json({ ok: true, data })
  } catch (err) {
    updateState = { supported: true, status: 'error', message: err.message }
    res.json({ ok: false, data: updateState })
  }
})

/* 开始下载。autoDownload 关掉之后，「发现新版本」不再自动下载，
   必须由用户在界面上显式点这一下。 */
app.post(
  '/api/update/download',
  requireAuth,
  makeUpdateActionRoute(() => downloadHandler),
)

/* 安装。前端会先让用户确认，确认后才调到这里。 */
app.post(
  '/api/update/install',
  requireAuth,
  makeUpdateActionRoute(() => installHandler),
)

app.get('/api/update/status', requireAuth, (_req, res) => {
  // 下载进度只存在于主进程，不经过 updateState，所以优先问它要实时状态；
  // 拿不到（例如外部后端模式）再退回缓存的 updateState。
  if (updateStatusHandler) {
    try {
      return res.json({ ok: true, data: updateStatusHandler() })
    } catch (_) {
      /* 退回缓存 */
    }
  }
  res.json({ ok: true, data: updateState })
})

/* ---- 静态资源（生产环境由 Electron 直接访问本服务） ---- */

const DIST_DIR = path.join(CONFIG.ROOT, 'dist')
if (fs.existsSync(DIST_DIR)) {
  app.use(express.static(DIST_DIR))
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(DIST_DIR, 'index.html'))
  })
} else {
  app.get('/', (_req, res) => {
    res.status(200).send('<h1>AI Agent开发控制台 API</h1><p>前端产物 dist/ 不存在，请先执行 npm run build:web。</p>')
  })
}

/* ------------------------------------------------------------------ *
 * HTTP + WebSocket
 * ------------------------------------------------------------------ */

const server = http.createServer(app)
const wss = new WebSocketServer({ server, path: '/ws' })

/**
 * 兜底错误处理，两个都必须有：
 *
 * 1. http server：Node 对没有监听 error 的 EventEmitter 会直接抛异常。listen()
 *    里的 once('error') 在重试成功后就被摘掉了，运行期再出错就会炸成未捕获异常。
 *
 * 2. WebSocketServer：ws 会把自己的监听器挂到 http server 上，并把落到的 error
 *    **转发**到 WebSocketServer 自己身上。如果没有这个监听器，哪怕是 listen()
 *    已经妥善处理并重试过的 EADDRINUSE，也会在这里被二次抛出、干掉整个进程。
 */
server.on('error', (err) => {
  console.error('[server] HTTP 服务错误:', err.message)
})
wss.on('error', (err) => {
  console.error('[ws] 服务错误:', err.message)
})

let APP_VERSION = require('../package.json').version
let actualPort = CONFIG.PORT
let updateState = { supported: Boolean(process.versions.electron), status: 'idle', message: '尚未检查更新' }

function broadcast(type, payload) {
  const frame = JSON.stringify({ type, payload, ts: Date.now() })
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      try {
        client.send(frame)
      } catch (_) {
        /* ignore */
      }
    }
  }
}

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, 'http://localhost')
  const token = url.searchParams.get('token')

  if (!isValidToken(token)) {
    socket.send(JSON.stringify({ type: 'unauthorized', payload: { error: '未授权' } }))
    socket.close(4001, 'unauthorized')
    return
  }

  socket.isAlive = true
  socket.on('pong', () => {
    socket.isAlive = true
  })

  socket.send(JSON.stringify({ type: 'hello', payload: { version: APP_VERSION }, ts: Date.now() }))
  socket.send(JSON.stringify({ type: 'snapshot', payload: store.snapshot(), ts: Date.now() }))
})

// 心跳：剔除半死连接，否则「检查更新」等推送会静默丢失
const heartbeat = setInterval(() => {
  for (const socket of wss.clients) {
    if (socket.isAlive === false) {
      socket.terminate()
      continue
    }
    socket.isAlive = false
    try {
      socket.ping()
    } catch (_) {
      /* ignore */
    }
  }
}, 30000)

/* ---- store 事件 → WS ---- */

const BRIDGED = [
  'agent:updated',
  'agent:deleted',
  'task:updated',
  'task:deleted',
  'message:added',
  'event:added',
  'task:history-cleared',
  'tasks:cleared',
]
for (const evt of BRIDGED) {
  store.bus.on(evt, (payload) => broadcast(evt, payload))
}

const nudgeDispatch = () => {
  setImmediate(() => {
    try {
      queue.dispatch()
    } catch (err) {
      console.error('[dispatch] 调度失败:', err.message)
    }
  })
}

// 状态落库之后顺手推一次调度，保证「空闲 Agent 自动接单」
store.bus.on('task:updated', nudgeDispatch)

// 有员工空出来时也推一次：因为没有空闲员工而没起来的任务，只有在这里
// 才有机会被重新捡起来；光等「任务状态变化」的话它可能一直躺在「进行中」。
store.bus.on('agent:updated', (agent) => {
  if (agent?.status === 'idle') nudgeDispatch()
})

/* ------------------------------------------------------------------ *
 * 启动 / 停止
 * ------------------------------------------------------------------ */

function listen(port, attempt = 0) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening)
      if (err.code === 'EADDRINUSE' && attempt < 10) {
        console.warn(`[server] 端口 ${port} 被占用，尝试 ${port + 1}`)
        listen(port + 1, attempt + 1).then(resolve, reject)
      } else {
        reject(err)
      }
    }
    const onListening = () => {
      server.removeListener('error', onError)
      resolve(port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

async function start() {
  CONFIG.ensureDirs()
  await db.init()
  store.bootstrap()

  APP_VERSION = require('../package.json').version
  actualPort = await listen(CONFIG.PORT)

  // 后台预热 deveco 模型列表：这个命令要起一个 node 进程，放在请求路径上会拖慢首屏
  executors.warmup()

  queue.recoverOnStartup()

  console.log('──────────────────────────────────────────────')
  console.log('  AI Agent开发控制台 · ChaosConsole')
  console.log(`  版本        ${APP_VERSION}`)
  console.log(`  服务地址    http://127.0.0.1:${actualPort}`)
  console.log(`  数据文件    ${CONFIG.DB_FILE}`)
  console.log(`  员工数量    ${store.listAgents().length}`)
  console.log(`  claude CLI  ${runner.resolveClaudeBin() || '未检测到（将使用模拟执行）'}`)
  console.log(`  权限模式    ${store.getSetting('permissionMode', CONFIG.PERMISSION_MODE)}`)
  console.log('──────────────────────────────────────────────')

  return { port: actualPort }
}

async function stop() {
  clearInterval(heartbeat)
  for (const id of runner.runningTaskIds()) runner.cancel(id)

  // WebSocketServer 是挂在同一个 http server 上的，而且升级过的连接不受
  // server.close() 管辖：只要还留着一个 WS 客户端（界面上就是「已登录」），
  // server.close() 的回调就永远不会触发，退出流程会死等在这里。
  // 所以顺序必须是：先掐掉 WS 客户端 → 关 wss → 再关 http。
  for (const client of wss.clients) {
    try {
      client.terminate()
    } catch (_) {
      /* ignore */
    }
  }

  await Promise.race([
    (async () => {
      await new Promise((resolve) => {
        try {
          wss.close(() => resolve())
        } catch (_) {
          resolve()
        }
      })
      await new Promise((resolve) => {
        try {
          server.close(() => resolve())
        } catch (_) {
          resolve()
          return
        }
        // 界面还开着时会有 keep-alive 的 HTTP 长连接，server.close() 要等它们
        // 自然断开才回调。这里直接全部丢掉，别为了「优雅」多等几十秒。
        if (typeof server.closeAllConnections === 'function') {
          try {
            server.closeAllConnections()
          } catch (_) {
            /* ignore */
          }
        }
      })
    })(),
    // 兜底：无论连接状态多脏，3 秒内都必须放行，不能让退出挂死
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ])

  db.flush()
}

function getPort() {
  return actualPort
}

module.exports = {
  start,
  stop,
  getPort,
  setUpdateHandler,
  setDownloadHandler,
  setInstallHandler,
  setUpdateStatusHandler,
  broadcast,
  app,
  server,
}

/* 直接 `node server/index.js` 时自启动 */
if (require.main === module) {
  start().catch((err) => {
    console.error('[server] 启动失败:', err)
    process.exit(1)
  })

  const shutdown = async () => {
    console.log('\n[server] 正在关闭…')
    try {
      await stop()
    } catch (_) {
      /* ignore */
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.on('exit', () => db.flush())
}
