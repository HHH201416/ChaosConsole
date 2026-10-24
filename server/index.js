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
const dm = require('./download-mirror')
const runner = require('./runner')
const queue = require('./queue')
const chat = require('./chat')
const mcp = require('./mcp')
const executors = require('./executors')
const pipeline = require('./pipeline')
const mcpScope = require('./mcp-scope')
const runtime = require('./runtime')
const backup = require('./backup')
const workspace = require('./workspace')
const stats = require('./stats')
const diagnostics = require('./diagnostics')
const toolchain = require('./toolchain')
const knowledge = require('./knowledge')
const chaosLlm = require('./chaos-llm')

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
function validateExecutorModel(executor, model, fallbackExecutor = 'chaos') {
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
// 工作区导入 / 知识库导入单独放宽到 50MB；其余接口保持 2MB，避免普通请求被大包拖死
app.use((req, res, next) => {
  if (req.path === '/api/workspace/import' || req.path === '/api/kb/import') return next()
  return express.json({ limit: '2mb' })(req, res, next)
})

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'chaos-console', version: APP_VERSION })
})

app.post('/api/login', (req, res) => {
  // 9.3.8：授权码登录已关闭 —— 任何请求都直接发会话 token（本机单用户应用）。
  // 保留路由形状，前端无需改动；code 参数仅作兼容接收。
  void req
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
      // 下载加速镜像：服务端定（默认启用），界面只显示开没开
      downloadMirror: store.getSetting('downloadMirror', CONFIG.DOWNLOAD_MIRROR),
      downloadMirrorDefault: CONFIG.DOWNLOAD_MIRROR_DEFAULT,
      defaultCwd: CONFIG.DEFAULT_CWD,
      platform: process.platform,
      runningTaskIds: runner.runningTaskIds(),
      isElectron: Boolean(process.versions.electron),
      mcp: mcp.summary(),
      // V3.6.0：换岗与阶段流水线
      pipelineEnabled: store.getSetting('pipelineEnabled', '1') === '1',
      // 0 = 不限次数（默认）。设成 N 就最多自动换岗 N 次
      maxAttempts: Number(store.getSetting('maxAttempts', '0')) || 0,
      pipeline: pipeline.CLAUDE_PIPELINE,
      // 按岗位挂载 MCP
      mcpScopeEnabled: store.getSetting('mcpScopeEnabled', '1') === '1',
      mcpStrict: store.getSetting('mcpStrict', '1') === '1',
      mcpHandoffTool: store.getSetting('mcpHandoffTool', '1') === '1',
      // 8.0.0：派单策略 / 界面语言 / 强调色 / 桌面集成
      dispatchStrategy: queue.dispatchStrategy(),
      uiLanguage: store.getSetting('uiLanguage', 'zh'),
      accent: store.getSetting('accent', 'amber'),
      trayEnabled: store.getSetting('trayEnabled', '1') === '1',
      closeToTray: store.getSetting('closeToTray', '0') === '1',
      notifyOnComplete: store.getSetting('notifyOnComplete', '1') === '1',
      notifyOnNeedsInput: store.getSetting('notifyOnNeedsInput', '1') === '1',
      notifyOnlyWhenUnfocused: store.getSetting('notifyOnlyWhenUnfocused', '1') === '1',
      globalShortcut: store.getSetting('globalShortcut', 'CommandOrControl+Shift+Space'),
      backupEnabled: store.getSetting('backupEnabled', '1') === '1',
      backupIntervalHours: Number(store.getSetting('backupIntervalHours', '24')) || 24,
      backupRetention: Number(store.getSetting('backupRetention', '10')) || 10,
      // 知识库与混沌本地大模型
      kb: knowledge.summary(),
      kbInjectEnabled: store.getSetting('kbInjectEnabled', '1') === '1',
      chaos: chaosLlm.summary(),
      chaosExpert: store.getSetting('chaosExpert', 'default'),
      chaosGuideDone: store.getSetting('chaosGuideDone', '0') === '1',
      // 9.3.8：第三方 API（OpenAI 兼容）配置状态 —— 密钥不回传，只给「配没配」
      api: {
        baseUrl: executors.apiConfig().baseUrl,
        hasKey: Boolean(executors.apiConfig().apiKey),
        model: executors.apiConfig().model,
        ready: executors.apiReady(),
      },
      // 9.3.8：应用自身根目录（自修改模式用它当工作区，混沌直接改自己的源码/页面）
      appRoot: CONFIG.ROOT,
      // 9.3.8：安全 —— 是否已设置锁屏 PIN（不回传 PIN 本身）
      hasPin: Boolean(String(store.getSetting('appPin', '') || '').trim()),
      // 9.5.4：是否允许 Agent 操作电脑（run_command / open_path 工具总闸，默认开）
      agentComputerUse: store.getSetting('agentComputerUse', '1') === '1',
    },
  })
})

app.post('/api/settings', requireAuth, (req, res) => {
  const {
    permissionMode,
    devecoAutoApprove,
    mcpAllowedDirs,
    autoUpdateWhenIdle,
    downloadMirror,
    maxAttempts,
    pipelineEnabled,
    mcpScopeEnabled,
    mcpStrict,
    mcpHandoffTool,
    dispatchStrategy,
    uiLanguage,
    accent,
    trayEnabled,
    closeToTray,
    notifyOnComplete,
    notifyOnNeedsInput,
    notifyOnlyWhenUnfocused,
    globalShortcut,
    backupEnabled,
    backupIntervalHours,
    backupRetention,
    kbInjectEnabled,
    apiBaseUrl,
    apiKey,
    apiModel,
    appPin,
    agentComputerUse,
  } = req.body || {}
  if (permissionMode !== undefined) {
    if (!CONFIG.isValidPermissionMode(permissionMode)) {
      return res.status(400).json({ ok: false, error: '非法的权限模式' })
    }
    store.setSetting('permissionMode', permissionMode)
  }
  // 9.5.4：允许 Agent 操作电脑（run_command / open_path 工具总闸，默认开）
  if (agentComputerUse !== undefined) {
    store.setSetting('agentComputerUse', agentComputerUse ? '1' : '0')
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
  // 下载加速镜像（默认空 = 直连）。写库前规范化：非法值直接拒绝，不要静默当成
  // 「关掉」—— 用户明明填了东西却毫无反应，比报错更难查。
  if (downloadMirror !== undefined) {
    const raw = String(downloadMirror || '').trim()
    const norm = dm.normalizeMirror(raw)
    if (raw && !norm) {
      return res.status(400).json({
        ok: false,
        error: '镜像地址要以 http:// 或 https:// 开头，且带主机名，例如 https://gh-proxy.com',
      })
    }
    store.setSetting('downloadMirror', norm)
  }
  // 自动换岗重试上限：0 = 不限。负数/非数字当非法拒掉，别静默变成 0
  if (maxAttempts !== undefined) {
    const n = Number(maxAttempts)
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ ok: false, error: '重试上限要填 0 或正整数（0 = 不限次数）' })
    }
    store.setSetting('maxAttempts', String(n))
  }
  if (pipelineEnabled !== undefined) {
    store.setSetting('pipelineEnabled', pipelineEnabled ? '1' : '0')
  }
  // 按岗位挂 MCP（总闸 / 严格模式 / 给 agent 的换岗工具）
  if (mcpScopeEnabled !== undefined) store.setSetting('mcpScopeEnabled', mcpScopeEnabled ? '1' : '0')
  if (mcpStrict !== undefined) store.setSetting('mcpStrict', mcpStrict ? '1' : '0')
  if (mcpHandoffTool !== undefined) store.setSetting('mcpHandoffTool', mcpHandoffTool ? '1' : '0')

  // ---- 8.0.0 ----
  if (dispatchStrategy !== undefined) {
    if (!queue.DISPATCH_STRATEGIES.includes(dispatchStrategy)) {
      return res.status(400).json({ ok: false, error: '非法的派单策略' })
    }
    store.setSetting('dispatchStrategy', dispatchStrategy)
  }
  if (uiLanguage !== undefined) {
    if (!['zh', 'en'].includes(uiLanguage)) return res.status(400).json({ ok: false, error: '非法的界面语言' })
    store.setSetting('uiLanguage', uiLanguage)
  }
  if (accent !== undefined) {
    if (!['amber', 'sky', 'violet', 'emerald'].includes(accent)) {
      return res.status(400).json({ ok: false, error: '非法的强调色' })
    }
    store.setSetting('accent', accent)
  }
  if (trayEnabled !== undefined) store.setSetting('trayEnabled', trayEnabled ? '1' : '0')
  if (closeToTray !== undefined) store.setSetting('closeToTray', closeToTray ? '1' : '0')
  if (notifyOnComplete !== undefined) store.setSetting('notifyOnComplete', notifyOnComplete ? '1' : '0')
  if (notifyOnNeedsInput !== undefined) store.setSetting('notifyOnNeedsInput', notifyOnNeedsInput ? '1' : '0')
  if (notifyOnlyWhenUnfocused !== undefined) {
    store.setSetting('notifyOnlyWhenUnfocused', notifyOnlyWhenUnfocused ? '1' : '0')
  }
  if (globalShortcut !== undefined) {
    const allowed = ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+C', 'CommandOrControl+Shift+K', 'off']
    if (!allowed.includes(globalShortcut)) {
      return res.status(400).json({ ok: false, error: '不支持的全局快捷键' })
    }
    store.setSetting('globalShortcut', globalShortcut)
  }
  if (backupEnabled !== undefined) store.setSetting('backupEnabled', backupEnabled ? '1' : '0')
  if (backupIntervalHours !== undefined) {
    const n = Number(backupIntervalHours)
    if (!Number.isFinite(n) || n < 1 || n > 24 * 30) {
      return res.status(400).json({ ok: false, error: '备份间隔要在 1 小时到 30 天之间' })
    }
    store.setSetting('backupIntervalHours', String(Math.round(n)))
  }
  if (backupRetention !== undefined) {
    const n = Number(backupRetention)
    if (!Number.isInteger(n) || n < 1 || n > 200) {
      return res.status(400).json({ ok: false, error: '备份保留数量要在 1 到 200 之间' })
    }
    store.setSetting('backupRetention', String(n))
  }
  // 知识库命中注入提示词（默认开）
  if (kbInjectEnabled !== undefined) store.setSetting('kbInjectEnabled', kbInjectEnabled ? '1' : '0')
  // 9.3.8：第三方 API（OpenAI 兼容）配置 —— 只存本机 settings，不出电脑
  if (apiBaseUrl !== undefined) {
    const url = String(apiBaseUrl).trim().replace(/\/+$/, '')
    if (url && !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ ok: false, error: '接口地址要以 http(s):// 开头' })
    }
    store.setSetting('apiBaseUrl', url)
  }
  if (apiKey !== undefined) store.setSetting('apiKey', String(apiKey).trim().slice(0, 300))
  if (apiModel !== undefined) store.setSetting('apiModel', String(apiModel).trim().slice(0, 120))
  // 9.3.8：本地锁屏 PIN（空 = 不锁）。只存本机；校验走 /api/unlock。
  if (appPin !== undefined) {
    const pin = String(appPin).trim()
    if (pin && !/^\d{4,12}$/.test(pin)) {
      return res.status(400).json({ ok: false, error: 'PIN 要是 4~12 位数字，留空表示不锁' })
    }
    store.setSetting('appPin', pin)
  }
  res.json({ ok: true })
})

/** 9.3.8：锁屏解锁校验（PIN 只存本机 settings，不回传前端） */
app.post('/api/unlock', requireAuth, (req, res) => {
  const pin = String(req.body?.pin || '').trim()
  const saved = String(store.getSetting('appPin', '') || '').trim()
  if (!saved) return res.json({ ok: true })
  if (pin !== saved) return res.status(403).json({ ok: false, error: 'PIN 不正确' })
  res.json({ ok: true })
})

/* ---- 执行器与模型 ---- */

app.get('/api/executors', requireAuth, (_req, res) => {
  res.json({ ok: true, data: executors.describe() })
})

/* ---- 阶段流水线 ---- */

app.get('/api/pipeline', requireAuth, (_req, res) => {
  res.json({
    ok: true,
    data: {
      stages: pipeline.STAGES,
      labels: pipeline.STAGE_LABELS,
      claude: pipeline.CLAUDE_PIPELINE,
      deveco: pipeline.DEVECO_PIPELINE,
      // 岗位清单只给 role 与职能（界面从不显示姓名）
      roles: store.listAgents().map((a) => ({ role: a.role, functionLabel: a.functionLabel })),
    },
  })
})

/* ---- MCP ---- */

/* ---- 内部：Agent 的「换岗」MCP 工具回调 ----
 *
 * 刻意**不走 requireAuth**：调用方是本次运行的 MCP 子进程，它拿不到（也不该拿到）
 * 用户的登录令牌。改用每次运行铸的一次性令牌 —— 令牌只写进那次运行的 MCP 配置，
 * 运行结束即吊销，所以跑完的、或别的任务里的进程都切不动任务。
 * 这两个路由不是给界面用的。 */
app.post('/api/internal/handoff', (req, res) => {
  const { taskId, token, role, stage, reason, summary } = req.body || {}
  if (!runtime.checkHandoffToken(taskId, token)) {
    return res.status(403).json({ ok: false, error: '令牌无效或已过期' })
  }
  if (!store.getTask(taskId)) return res.status(404).json({ ok: false, error: '任务不存在' })
  const r = queue.requestHandoff(taskId, {
    role: role || '',
    stage: stage || '',
    reason: reason || 'Agent 请求交接',
    summary: summary || '',
    source: 'mcp',
  })
  res.status(r.ok === false ? 400 : 200).json(r)
})

app.get('/api/internal/handoff', (req, res) => {
  const { taskId, token } = req.query || {}
  if (!runtime.checkHandoffToken(taskId, token)) {
    return res.status(403).json({ ok: false, error: '令牌无效或已过期' })
  }
  const task = store.getTask(taskId)
  if (!task) return res.status(404).json({ ok: false, error: '任务不存在' })
  const agent = task.agentId ? store.getAgent(task.agentId) : null
  const stages = pipeline.resolve(
    task,
    agent,
    store.getSetting('pipelineEnabled', '1') === '1',
    null,
  )
  res.json({
    ok: true,
    data: {
      title: task.title,
      stage: task.stage,
      pipeline: stages.map((s) => ({
        stage: s.stage,
        label: pipeline.labelOf(s.stage),
        role: s.role,
      })),
      role: agent ? agent.role : '',
      functionLabel: agent ? agent.functionLabel : '',
      attempts: task.attempts || 0,
      roles: store.listAgents().map((a) => ({ role: a.role, functionLabel: a.functionLabel })),
    },
  })
})

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

app.post('/api/chat', requireAuth, async (req, res) => {
  const { conversationId, text, cwd, executor, model, agentId } = req.body || {}
  const bad = validateExecutorModel(executor, model)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  try {
    // 9.3.8：send 是 async —— 新对话可能要等调度员用混沌分派（≤20s，超时走关键词）
    const result = await chat.send({ conversationId, text, cwd, executor, model, agentId })
    if (!result.ok) return res.status(400).json(result)
    res.json(result)
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err?.message || err) })
  }
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
  // 岗位的流水线要校验：阶段名不能重复、role 必须是真实存在的岗位
  if (patch.pipeline !== undefined) {
    const reason = pipeline.validate(patch.pipeline, store.listAgents().map((a) => a.role))
    if (reason) return res.status(400).json({ ok: false, error: reason })
  }
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
  const {
    title,
    description,
    tags,
    cwd,
    agentId,
    executor,
    model,
    pipeline: pipelineOverride,
    parentId,
    dependsOn,
  } = req.body || {}
  if (!title || !String(title).trim()) {
    return res.status(400).json({ ok: false, error: '请填写任务名称' })
  }
  const bad = validateExecutorModel(executor, model)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  if (pipelineOverride !== undefined) {
    const reason = pipeline.validate(pipelineOverride, store.listAgents().map((a) => a.role))
    if (reason) return res.status(400).json({ ok: false, error: reason })
  }
  const relationError = store.validateTaskRelations({ parentId, dependsOn })
  if (relationError) return res.status(400).json({ ok: false, error: relationError })
  res.json({
    ok: true,
    data: store.createTask({
      title,
      description,
      tags,
      cwd,
      agentId,
      executor,
      model,
      pipeline: pipelineOverride,
      parentId: parentId || null,
      dependsOn: Array.isArray(dependsOn) ? dependsOn : [],
    }),
  })
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
      // 8.0.0：父子任务
      parent: task.parentId ? store.getTask(task.parentId) : null,
      subtasks: store.listTasks().filter((t) => t.parentId === task.id),
    },
  })
})

app.patch('/api/tasks/:id', requireAuth, (req, res) => {
  const patch = req.body || {}
  const current = store.getTask(req.params.id)
  if (!current) return res.status(404).json({ ok: false, error: '任务不存在' })
  const bad = validateExecutorModel(patch.executor, patch.model, current.executor)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  if (patch.pipeline !== undefined) {
    const reason = pipeline.validate(patch.pipeline, store.listAgents().map((a) => a.role))
    if (reason) return res.status(400).json({ ok: false, error: reason })
  }
  if (patch.parentId !== undefined || patch.dependsOn !== undefined) {
    const relationError = store.validateTaskRelations({
      id: current.id,
      parentId: patch.parentId !== undefined ? patch.parentId : current.parentId,
      dependsOn: patch.dependsOn !== undefined ? patch.dependsOn : current.dependsOn,
    })
    if (relationError) return res.status(400).json({ ok: false, error: relationError })
  }
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
  // 换岗：运行中会掐掉当前回合并交接（不是取消），未运行则直接改派
  handoff: (id, body) =>
    queue.requestHandoff(id, {
      agentId: body?.agentId || '',
      role: body?.role || '',
      stage: body?.stage || '',
      reason: body?.reason || '老板手动换岗',
      source: 'user',
    }),
  // 停止 / 恢复自动换岗重试
  retry: (id, body) => queue.setAutoRetry(id, body?.enabled !== false),
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

/* ---- 8.0.0：批量操作 ---- */

app.post('/api/tasks/batch', requireAuth, (req, res) => {
  const { action, ids, payload } = req.body || {}
  const allowed = ['start', 'cancel', 'done', 'delete', 'move', 'retry', 'assign']
  if (!allowed.includes(action)) return res.status(400).json({ ok: false, error: '未知的批量操作' })
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ ok: false, error: '请选择任务' })
  if (ids.length > 200) return res.status(400).json({ ok: false, error: '一次最多操作 200 个任务' })

  const results = []
  for (const id of [...new Set(ids.map(String))]) {
    if (!store.getTask(id)) {
      results.push({ id, ok: false, error: '任务不存在' })
      continue
    }
    try {
      let r = { ok: true }
      if (action === 'start') r = queue.startTask(id)
      else if (action === 'cancel') r = queue.cancelTask(id)
      else if (action === 'done') r = queue.markDone(id)
      else if (action === 'delete') {
        queue.forgetTask(id)
        store.deleteTask(id)
      } else if (action === 'move') {
        r = queue.moveTask(id, payload?.status)
      } else if (action === 'retry') {
        r = queue.setAutoRetry(id, payload?.enabled !== false)
      } else if (action === 'assign') {
        const agentId = payload?.agentId || null
        if (agentId && !store.getAgent(agentId)) r = { ok: false, error: '员工不存在' }
        else {
          const before = store.getTask(id)
          store.updateTask(id, { agentId })
          if (before?.agentId && before.agentId !== agentId) store.releaseAgentIfIdle(before.agentId)
        }
      }
      if (r && r.ok === false) results.push({ id, ok: false, error: r.error || '操作失败' })
      else results.push({ id, ok: true })
    } catch (err) {
      results.push({ id, ok: false, error: err.message })
    }
  }
  res.json({ ok: true, results })
})

/* ---- 8.0.0：任务模板 ---- */

function validateTemplate(body, current = {}) {
  const name = body.name !== undefined ? String(body.name).trim() : current.name
  if (!name) return '请填写模板名称'
  const executor = body.executor !== undefined ? body.executor : current.executor
  const model = body.model !== undefined ? body.model : current.model
  const bad = validateExecutorModel(executor, model, current.executor || 'claude')
  if (bad) return bad
  if (body.pipeline !== undefined) {
    const reason = pipeline.validate(body.pipeline, store.listAgents().map((a) => a.role))
    if (reason) return reason
  }
  if (body.agentId && !store.getAgent(body.agentId)) return '指定的岗位不存在'
  return null
}

app.get('/api/templates', requireAuth, (_req, res) => {
  res.json({ ok: true, data: store.listTemplates() })
})

app.post('/api/templates', requireAuth, (req, res) => {
  const body = req.body || {}
  const bad = validateTemplate(body)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  res.json({ ok: true, data: store.createTemplate(body) })
})

/* ---- 9.3.8：右侧预览面板 —— 工作区目录树 / 文本文件预览 ---- */

const TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less',
  'html', 'htm', 'vue', 'py', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bat', 'ps1', 'sql', 'log', 'xml', 'csv',
])
const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.workbuddy', '__pycache__', '.venv'])
const PREVIEW_MAX = 256 * 1024

/** 目录树：只列一层，忽略构建产物与依赖目录 */
app.get('/api/workspace/tree', requireAuth, (req, res) => {
  const root = String(req.query.root || '').trim()
  if (!root) return res.status(400).json({ ok: false, error: '缺少 root 参数' })
  let st
  try {
    st = fs.statSync(root)
  } catch (_) {
    return res.status(400).json({ ok: false, error: '目录不存在或无法访问' })
  }
  if (!st.isDirectory()) return res.status(400).json({ ok: false, error: 'root 不是目录' })

  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true }).filter((e) => !IGNORED_DIRS.has(e.name))
  } catch (err) {
    return res.status(400).json({ ok: false, error: `读取目录失败：${err.message}` })
  }

  const items = []
  // 9.5.0：HTML/图片/PDF 也能在预览面板内嵌渲染（走 /api/workspace/raw）
  const RAW_PREVIEW_EXTS = new Set(['html', 'htm', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'pdf'])
  for (const e of entries.slice(0, 500)) {
    const full = path.join(root, e.name)
    try {
      const s = fs.statSync(full)
      const extName = path.extname(e.name).slice(1).toLowerCase()
      items.push({
        name: e.name,
        path: full,
        dir: e.isDirectory(),
        size: s.size,
        mtime: s.mtimeMs,
        previewable: e.isFile() && (TEXT_EXT.has(extName) || RAW_PREVIEW_EXTS.has(extName)),
      })
    } catch (_) {
      /* 拿不到 stat 的（权限等）跳过 */
    }
  }
  items.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  res.json({ ok: true, data: { root, items } })
})

/** 文本文件预览：必须在 root 之内、扩展名白名单、256KB 截断 */
app.get('/api/workspace/file', requireAuth, (req, res) => {
  const root = path.resolve(String(req.query.root || ''))
  const rel = String(req.query.path || '')
  if (!root || !rel) return res.status(400).json({ ok: false, error: '缺少 root / path 参数' })
  const target = path.resolve(rel)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (target !== root && !target.startsWith(rootWithSep)) {
    return res.status(403).json({ ok: false, error: '只能预览工作区内的文件' })
  }
  const ext = path.extname(target).slice(1).toLowerCase()
  if (!TEXT_EXT.has(ext)) return res.status(400).json({ ok: false, error: '该文件类型暂不支持预览' })
  let st
  try {
    st = fs.statSync(target)
  } catch (_) {
    return res.status(400).json({ ok: false, error: '文件不存在或无法访问' })
  }
  if (!st.isFile() || st.size > 5 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: '文件过大或不是普通文件' })
  }
  try {
    const buf = fs.readFileSync(target)
    const truncated = buf.length > PREVIEW_MAX
    res.json({
      ok: true,
      data: {
        path: target,
        size: st.size,
        truncated,
        content: buf.subarray(0, PREVIEW_MAX).toString('utf8'),
      },
    })
  } catch (err) {
    res.status(400).json({ ok: false, error: `读取失败：${err.message}` })
  }
})

app.patch('/api/templates/:id', requireAuth, (req, res) => {
  const current = store.getTemplate(req.params.id)
  if (!current) return res.status(404).json({ ok: false, error: '模板不存在' })
  const bad = validateTemplate(req.body || {}, current)
  if (bad) return res.status(400).json({ ok: false, error: bad })
  res.json({ ok: true, data: store.updateTemplate(req.params.id, req.body || {}) })
})

app.delete('/api/templates/:id', requireAuth, (req, res) => {
  if (!store.deleteTemplate(req.params.id)) return res.status(404).json({ ok: false, error: '模板不存在' })
  res.json({ ok: true })
})

/* ---- 知识库 ---- */

app.get('/api/kb', requireAuth, (_req, res) => {
  res.json({ ok: true, data: { bases: knowledge.listKbs(), summary: knowledge.summary() } })
})

app.post('/api/kb', requireAuth, (req, res) => {
  const r = knowledge.createKb(req.body || {})
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

app.patch('/api/kb/:id', requireAuth, (req, res) => {
  const r = knowledge.updateKb(req.params.id, req.body || {})
  if (!r.ok) return res.status(404).json(r)
  res.json(r)
})

app.delete('/api/kb/:id', requireAuth, (req, res) => {
  const r = knowledge.deleteKb(req.params.id)
  if (!r.ok) return res.status(404).json(r)
  res.json(r)
})

app.get('/api/kb/:id/docs', requireAuth, (req, res) => {
  const r = knowledge.listDocs(req.params.id)
  if (!r.ok) return res.status(404).json(r)
  res.json(r)
})

app.post('/api/kb/:id/docs', requireAuth, (req, res) => {
  const r = knowledge.addDoc(req.params.id, req.body || {})
  if (!r.ok) return res.status(r.error === '知识库不存在' ? 404 : 400).json(r)
  res.json(r)
})

app.delete('/api/kb/:id/docs/:docId', requireAuth, (req, res) => {
  const r = knowledge.deleteDoc(req.params.id, req.params.docId)
  if (!r.ok) return res.status(404).json(r)
  res.json(r)
})

/** 导出：?format=json|md。走 download() 的 content-disposition 通道 */
app.get('/api/kb/:id/export', requireAuth, (req, res) => {
  const r = knowledge.exportKb(req.params.id, req.query.format === 'md' ? 'md' : 'json')
  if (!r.ok) return res.status(404).json(r)
  const { filename, contentType, body } = r.data
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
  res.send(body)
})

/** 导入：{targetId?, name?, description?, docs:[{title,content,source?}]} */
app.post('/api/kb/import', requireAuth, (req, res) => {
  const body = req.body || {}
  if (body.chaosKnowledgeBase !== 1 && !Array.isArray(body.docs)) {
    return res.status(400).json({ ok: false, error: '不是有效的知识库导出文件' })
  }
  const r = knowledge.importKb({
    targetId: body.targetId,
    name: body.name,
    description: body.description,
    docs: body.docs,
  })
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

/** 检索：{query, limit?}；不指定 kbId 就全库搜 */
app.post('/api/kb/search', requireAuth, (req, res) => {
  const { query, limit, kbId } = req.body || {}
  let hits = knowledge.search(String(query || ''), { limit: Number(limit) || 8 })
  if (kbId) hits = hits.filter((h) => h.kbId === kbId)
  res.json({ ok: true, data: hits })
})

/* ---- 混沌（本地大模型） ---- */

app.get('/api/chaos/status', requireAuth, async (_req, res) => {
  try {
    res.json({ ok: true, data: await chaosLlm.statusAsync() })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/chaos/install', requireAuth, (req, res) => {
  const r = chaosLlm.startInstall({ consent: req.body?.consent === true })
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

app.post('/api/chaos/pull', requireAuth, (req, res) => {
  const r = chaosLlm.startPull(String(req.body?.model || ''))
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

app.post('/api/chaos/cancel', requireAuth, (req, res) => {
  res.json(chaosLlm.cancelJob(req.body?.jobId))
})

app.post('/api/chaos/guide-done', requireAuth, (_req, res) => {
  store.setSetting('chaosGuideDone', '1')
  res.json({ ok: true })
})

/* ---- 8.0.2：混沌轻量能力（速答 / 魔法棒 / 擂台 / 专家 / 记忆 / 自动化） ---- */

app.get('/api/chaos/experts', requireAuth, (_req, res) => {
  res.json({ ok: true, data: chaosLlm.EXPERTS })
})

app.post('/api/chaos/expert', requireAuth, (req, res) => {
  const id = String(req.body?.id || 'default')
  if (!chaosLlm.expertById(id)) return res.status(400).json({ ok: false, error: '未知的专家包' })
  store.setSetting('chaosExpert', id)
  res.json({ ok: true, data: { id } })
})

/** 速答：一问一答，不进任务队列、不留对话记录（全局速答浮层 / 每日一句用） */
app.post('/api/chaos/quick', requireAuth, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim()
  if (!prompt) return res.status(400).json({ ok: false, error: '内容为空' })
  const expert = chaosLlm.expertById(String(store.getSetting('chaosExpert', 'default') || 'default'))
  try {
    const r = await chaosLlm.quickAnswer({
      prompt,
      model: String(req.body?.model || '') || undefined,
      system: expert && expert.prompt ? expert.prompt : '',
    })
    res.json({ ok: true, data: r })
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err?.message || err) })
  }
})

/** 提示词魔法棒：口语草稿 → 结构化提示词（本地改写，失败兜底返回原文） */
app.post('/api/chaos/rewrite', requireAuth, async (req, res) => {
  const r = await chaosLlm.rewritePrompt({ text: req.body?.text })
  if (!r.ok) return res.status(502).json(r)
  res.json(r)
})

/** 多模型擂台：同一个问题发给两个已装混沌模型并排比拼 */
app.post('/api/chaos/arena', requireAuth, async (req, res) => {
  const r = await chaosLlm.arena({ text: req.body?.text, models: req.body?.models })
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

/* ---- 8.0.2：混沌长期记忆 ---- */

app.get('/api/chaos/memory', requireAuth, (_req, res) => {
  res.json({ ok: true, data: chaosLlm.listMemory() })
})

app.put('/api/chaos/memory', requireAuth, (req, res) => {
  res.json({ ok: true, data: chaosLlm.setMemory(req.body?.items) })
})

/* ---- 8.0.2：混沌定时自动化 ---- */

app.get('/api/chaos/automations', requireAuth, (_req, res) => {
  res.json({ ok: true, data: chaosLlm.listAutomations() })
})

app.post('/api/chaos/automations', requireAuth, (req, res) => {
  const r = chaosLlm.upsertAutomation(req.body || {})
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

app.delete('/api/chaos/automations/:id', requireAuth, (req, res) => {
  const r = chaosLlm.deleteAutomation(req.params.id)
  if (!r.ok) return res.status(404).json(r)
  res.json(r)
})

/* ---- 8.0.2：混沌 Token 额度（每日 3000 万免费；9.5.4 起填手机号激活） ---- */

const quota = require('./chaos-quota')

app.get('/api/chaos/quota', requireAuth, (_req, res) => {
  res.json({ ok: true, data: quota.publicUsage() })
})

/* 9.5.4：原「兑换码」接口改为手机号绑定（每个手机号每天 3000 万 token）。
   旧路径保留别名接受 phone，兼容还没更新的调用方。 */
app.post('/api/chaos/phone', requireAuth, (req, res) => {
  const r = quota.bindPhone(req.body?.phone)
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

app.post('/api/chaos/redeem', requireAuth, (req, res) => {
  const r = quota.bindPhone(req.body?.phone || req.body?.code)
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

/* ---- 9.5.4：AIPPT（主题 + 页数 + 语气 → 本地生成 .pptx） ---- */

const aippt = require('./aippt')

app.get('/api/aippt/list', requireAuth, (_req, res) => {
  res.json({ ok: true, data: aippt.listFiles() })
})

app.post('/api/aippt/generate', requireAuth, async (req, res) => {
  try {
    const r = await aippt.generate({
      topic: req.body?.topic,
      pages: req.body?.pages,
      tone: req.body?.tone,
      model: req.body?.model,
    })
    if (!r.ok) return res.status(400).json(r)
    store.bus.emit('chaos:changed', { reason: 'aippt-generated' })
    res.json({ ok: true, data: r })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/aippt/file', requireAuth, (req, res) => {
  const file = aippt.resolveFile(req.query?.id)
  if (!file) return res.status(404).json({ ok: false, error: '文件不存在' })
  res.download(file)
})

/** 9.3.8：全部岗位一键切混沌（混沌面板的按钮走这里，与启动迁移同一实现） */
app.post('/api/agents/migrate-chaos', requireAuth, (_req, res) => {
  const n = store.migrateAgentsToChaos()
  res.json({ ok: true, data: { switched: n } })
})

/** 9.5.0：文件原样输出（iframe 预览用）—— HTML/图片按 content-type 直接回 */
const RAW_EXT_TYPE = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
}

app.get('/api/workspace/raw', requireAuth, (req, res) => {
  const root = path.resolve(String(req.query.root || ''))
  const rel = String(req.query.path || '')
  if (!root || !rel) return res.status(400).json({ ok: false, error: '缺少 root / path 参数' })
  const target = path.resolve(rel)
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep
  if (target !== root && !target.startsWith(rootWithSep)) {
    return res.status(403).json({ ok: false, error: '只能访问工作区内的文件' })
  }
  const ext = path.extname(target).toLowerCase()
  if (!(ext in RAW_EXT_TYPE)) return res.status(400).json({ ok: false, error: '该文件类型不支持预览' })
  let st
  try {
    st = fs.statSync(target)
  } catch (_) {
    return res.status(400).json({ ok: false, error: '文件不存在或无法访问' })
  }
  if (!st.isFile() || st.size > 10 * 1024 * 1024) {
    return res.status(400).json({ ok: false, error: '文件过大或不是普通文件' })
  }
  res.setHeader('Content-Type', RAW_EXT_TYPE[ext])
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.send(fs.readFileSync(target))
})

/* ---- 8.0.2：对话重新生成 / 分支 / 时光机回滚 ---- */

app.post('/api/tasks/:id/regenerate', requireAuth, (req, res) => {
  const r = queue.regenerateTask(req.params.id)
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

app.post('/api/tasks/:id/branch', requireAuth, (req, res) => {
  const r = chat.branchConversation(req.params.id)
  if (!r.ok) return res.status(400).json(r)
  res.json(r)
})

app.post('/api/tasks/:id/rollback', requireAuth, (req, res) => {
  const removed = store.trimMessages(req.params.id, req.body?.keep)
  if (removed < 0) return res.status(404).json({ ok: false, error: '对话不存在' })
  res.json({ ok: true, data: { removed } })
})

/* ---- 8.0.0：全局搜索 ---- */

function escapeLike(text) {
  return String(text).replace(/[\\%_]/g, '\\$&')
}

app.get('/api/search', requireAuth, (req, res) => {
  const raw = String(req.query.q || '').trim().slice(0, 100)
  if (raw.length < 2) {
    return res.json({ ok: true, data: { tasks: [], agents: [], messages: [], events: [] } })
  }
  const like = `%${escapeLike(raw)}%`
  const lower = raw.toLowerCase()

  const tasks = db
    .all(
      `SELECT id FROM tasks
       WHERE title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
       ORDER BY updated_at DESC LIMIT 10`,
      [like, like, like],
    )
    .map((r) => store.getTask(r.id))
    .filter(Boolean)

  const agents = store
    .listAgents()
    .filter((a) => `${a.functionLabel} ${a.role} ${a.name}`.toLowerCase().includes(lower))
    .slice(0, 10)

  const messages = db
    .all(
      `SELECT id, task_id, content, created_at FROM messages
       WHERE content LIKE ? ESCAPE '\\' ORDER BY id DESC LIMIT 10`,
      [like],
    )
    .map((m) => {
      const task = store.getTask(m.task_id)
      return {
        id: m.id,
        taskId: m.task_id,
        taskTitle: task ? task.title : '',
        content: String(m.content || '').slice(0, 160),
        createdAt: m.created_at,
      }
    })
    .filter((m) => m.taskTitle)

  const events = db
    .all(
      `SELECT id, task_id, type, name, content, created_at FROM events
       WHERE name LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\'
       ORDER BY id DESC LIMIT 10`,
      [like, like],
    )
    .map((e) => {
      const task = store.getTask(e.task_id)
      return {
        id: e.id,
        taskId: e.task_id,
        taskTitle: task ? task.title : '',
        type: e.type,
        name: e.name,
        content: String(e.content || '').slice(0, 160),
        createdAt: e.created_at,
      }
    })
    .filter((e) => e.taskTitle)

  res.json({ ok: true, data: { tasks, agents, messages, events } })
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

/* 版本回退：列历史版本、按 tag 下载并安装。都由主进程实现（它才有网络与安装能力） */
let releasesHandler = null
function setReleasesHandler(fn) {
  releasesHandler = fn
}

let rollbackHandler = null
function setRollbackHandler(fn) {
  rollbackHandler = fn
}

/* 8.0.0：桌面能力（下载 / 打开外链 / 安装器）由 Electron 主进程注入。
   纯 Node 模式下为 null，工具链只做检测，不做下载安装。 */
function setDesktopHost(host) {
  toolchain.setDesktopHost(host)
  chaosLlm.setDesktopHost(host)
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

/* 历史版本列表，供设置里的「版本回退」选择 */
app.get('/api/update/releases', requireAuth, async (_req, res) => {
  if (!releasesHandler) {
    return res.json({ ok: true, data: { supported: false, error: '当前环境不支持列出历史版本。', releases: [] } })
  }
  try {
    res.json({ ok: true, data: await releasesHandler() })
  } catch (err) {
    res.json({ ok: false, data: { supported: true, error: err.message, releases: [] } })
  }
})

/* 下载并安装指定版本（含降级） */
app.post('/api/update/rollback', requireAuth, async (req, res) => {
  if (!rollbackHandler) {
    return res.json({ ok: true, data: { supported: false, error: '当前环境不支持版本回退。' } })
  }
  const tag = String((req.body || {}).tag || '').trim()
  if (!tag) return res.status(400).json({ ok: false, error: '缺少 tag' })
  try {
    const data = await rollbackHandler(tag)
    updateState = { ...data }
    res.json({ ok: true, data })
  } catch (err) {
    updateState = { supported: true, status: 'error', message: err.message }
    res.json({ ok: false, data: updateState })
  }
})

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

/* ---- 8.0.0：备份 ---- */

app.get('/api/backups', requireAuth, (_req, res) => {
  res.json({
    ok: true,
    data: {
      dir: backup.DIR,
      enabled: store.getSetting('backupEnabled', '1') === '1',
      intervalHours: Number(store.getSetting('backupIntervalHours', '24')) || 24,
      retention: Number(store.getSetting('backupRetention', '10')) || 10,
      backups: backup.list(),
    },
  })
})

app.post('/api/backups', requireAuth, (_req, res) => {
  try {
    const meta = backup.create('manual')
    res.json({ ok: true, data: meta })
  } catch (err) {
    diagnostics.recordError('backup.create', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/backups/:name/restore', requireAuth, (req, res) => {
  const name = String(req.params.name || '')
  if (!backup.validateName(name)) return res.status(400).json({ ok: false, error: '非法的备份文件名' })
  for (const t of store.listTasks()) queue.forgetTask(t.id)
  try {
    backup.restore(name)
    queue.recoverOnStartup()
    res.json({ ok: true, data: { restored: name } })
  } catch (err) {
    diagnostics.recordError('backup.restore', err)
    res.status(400).json({ ok: false, error: err.message })
  }
})

app.delete('/api/backups/:name', requireAuth, (req, res) => {
  const name = String(req.params.name || '')
  if (!backup.validateName(name)) return res.status(400).json({ ok: false, error: '非法的备份文件名' })
  res.json({ ok: backup.remove(name) })
})

/* ---- 8.0.0：工作区导出 / 导入 ---- */

app.get('/api/workspace/export', requireAuth, (_req, res) => {
  const data = workspace.exportWorkspace()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="chaos-workspace-${stamp}.json"`)
  res.send(JSON.stringify(data, null, 2))
})

app.post('/api/workspace/import', requireAuth, express.json({ limit: '50mb' }), (req, res) => {
  try {
    const result = workspace.importWorkspace(req.body)
    res.json({ ok: true, data: result })
  } catch (err) {
    diagnostics.recordError('workspace.import', err)
    res.status(400).json({ ok: false, error: err.message })
  }
})

/* ---- 8.0.0：工具链检测 / 一键安装 ---- */

app.get('/api/toolchain', requireAuth, async (_req, res) => {
  try {
    const data = await toolchain.detect()
    res.json({ ok: true, data: { ...data, activeJob: toolchain.status().activeJob, history: toolchain.status().history } })
  } catch (err) {
    diagnostics.recordError('toolchain.detect', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/toolchain/refresh', requireAuth, async (_req, res) => {
  toolchain.invalidate()
  try {
    res.json({ ok: true, data: await toolchain.detect(true) })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.post('/api/toolchain/install', requireAuth, (req, res) => {
  const { tool, consent } = req.body || {}
  const result = toolchain.startInstall(tool, { consent })
  if (!result.ok) return res.status(400).json(result)
  res.json(result)
})

app.post('/api/toolchain/cancel', requireAuth, (req, res) => {
  res.json(toolchain.cancel((req.body || {}).jobId))
})

/* ---- 8.0.0：统计 / 诊断 ---- */

app.get('/api/stats', requireAuth, (req, res) => {
  try {
    res.json({ ok: true, data: stats.computeStats(req.query.days || '30') })
  } catch (err) {
    diagnostics.recordError('stats', err)
    res.status(500).json({ ok: false, error: err.message })
  }
})

app.get('/api/diagnostics', requireAuth, (_req, res) => {
  res.json({ ok: true, data: diagnostics.snapshot() })
})

app.get('/api/diagnostics/export', requireAuth, (_req, res) => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.setHeader('Content-Disposition', `attachment; filename="chaos-diagnostics-${stamp}.json"`)
  res.send(diagnostics.exportJson())
})

/* ---- 静态资源（生产环境由 Electron 直接访问本服务） ---- */

const DIST_DIR = path.join(CONFIG.ROOT, 'dist')
if (fs.existsSync(DIST_DIR)) {
  /* 9.5.4：缓存策略修复。express.static 默认 `public, max-age=0`，Electron 的
     HTTP 缓存曾经把旧版 index.html 连同旧 bundle 一起喂给渲染进程 —— 应用
     升级后窗口里跑的还是旧前端（9.5.3 用户机器上 `c.map` 依旧存在的根因）。
     index.html 永不缓存（no-store）；/assets/ 下的文件名带内容哈希，可放心
     长缓存。 */
  app.use(
    express.static(DIST_DIR, {
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-store, must-revalidate')
        } else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
        }
      },
    }),
  )
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, must-revalidate')
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
  'template:updated',
  'template:deleted',
  'workspace:imported',
  'toolchain:job',
  'toolchain:log',
  'toolchain:changed',
  'kb:changed',
  'chaos:job',
  'chaos:log',
  'chaos:changed',
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
  // runner / mcp-scope 要拼「换岗」MCP 工具的地址，端口是运行时定的（可能被占用后 +1）
  runtime.setPort(actualPort)

  // 8.0.0：诊断上下文 + 自动备份
  diagnostics.setContext({
    getWsClients: () => wss.clients.size,
    getPort: () => actualPort,
    getUpdateStatus: () => {
      try {
        return updateStatusHandler ? updateStatusHandler() : updateState
      } catch (_) {
        return updateState
      }
    },
  })
  backup.startScheduler()

  // 后台预热 deveco 模型列表：这个命令要起一个 node 进程，放在请求路径上会拖慢首屏
  executors.warmup()

  // 9.3.8：把所有岗位一次性迁到混沌执行器（claude/deveco 已下线）。
  // 只跑一次，用户手动改过的单个岗位仍可在岗位页自由改回。
  if (store.getSetting('chaosAgentsMigrated', '0') !== '1') {
    try {
      const n = store.migrateAgentsToChaos()
      if (n > 0) console.log(`[migrate] 已把 ${n} 个岗位切换到混沌执行器`)
    } catch (err) {
      console.error('[migrate] 岗位迁移失败（不阻塞启动）:', err.message)
    }
    store.setSetting('chaosAgentsMigrated', '1')
  }
  // 9.3.8：老库补种「任务调度」岗位（新库 seed 里自带）
  try {
    if (store.ensureDispatcherAgent() === 1) console.log('[migrate] 已补种「任务调度」岗位')
  } catch (_) {
    /* 不阻塞启动 */
  }

  // 8.0.2：把启用的混沌定时自动化重新排上（服务重启不丢日程）
  chaosLlm.scheduleAllAutomations()

  queue.recoverOnStartup()

  // 启动后的 MCP 维护（都不阻塞、都不装包）：
  //  1. 清理上次崩溃留下的运行期配置
  //  2. 把本地服务器（deveco-studio / handoff）刷到稳定目录，并修好指向安装目录的坏注册
  //  3. 把「装好了但没启用」的内置服务器默认打开（用户手动关掉的不复活）
  mcpScope.cleanupRunFiles()
  try {
    mcp.syncLocalServers()
  } catch (err) {
    console.error('[mcp] 刷新本地服务器注册失败:', err.message)
  }
  mcp.bootstrapDefaults().catch((err) => console.error('[mcp] 默认启用失败:', err.message))

  console.log('──────────────────────────────────────────────')
  console.log('  AI Agent开发控制台 · ChaosConsole')
  console.log(`  版本        ${APP_VERSION}`)
  console.log(`  服务地址    http://127.0.0.1:${actualPort}`)
  console.log(`  数据文件    ${CONFIG.DB_FILE}`)
  console.log(`  员工数量    ${store.listAgents().length}`)
  console.log(`  claude CLI  ${runner.resolveClaudeBin() || '未检测到（将使用模拟执行）'}`)
  console.log(`  权限模式    ${store.getSetting('permissionMode', CONFIG.PERMISSION_MODE)}`)
  {
    // 镜像默认启用，但环境变量写错时会被规范化成空串（=静默关掉）。启动时就点出来，
    // 否则「以为配了个镜像、实际在直连」会表现为下载十几分钟，很难往这儿想。
    const raw = store.getSetting('downloadMirror', CONFIG.DOWNLOAD_MIRROR)
    const norm = dm.normalizeMirror(raw)
    if (raw && !norm) {
      console.log(`  下载镜像    ${raw}  ← 地址非法（要带 http:// 或 https://），已按直连处理`)
    } else {
      console.log(`  下载镜像    ${norm || '未启用（直连 GitHub）'}`)
    }
  }
  console.log('──────────────────────────────────────────────')

  return { port: actualPort }
}

async function stop() {
  clearInterval(heartbeat)
  backup.stopScheduler()
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

process.on('uncaughtException', (err) => {
  diagnostics.recordError('uncaughtException', err)
})
process.on('unhandledRejection', (err) => {
  diagnostics.recordError('unhandledRejection', err)
})

module.exports = {
  start,
  stop,
  getPort,
  setUpdateHandler,
  setDownloadHandler,
  setInstallHandler,
  setUpdateStatusHandler,
  setReleasesHandler,
  setRollbackHandler,
  setDesktopHost,
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
