import { create } from 'zustand'
import { api, setToken, loadToken } from './lib/api'
import { loadUiPrefs, saveUiPrefs } from './lib/prefs'
import { applyTheme, resolveTheme, watchSystemTheme } from './lib/theme'

/* ------------------------------------------------------------------ *
 * WebSocket：单例连接 + 断线重连
 * ------------------------------------------------------------------ */

let socket = null
let reconnectTimer = null
let reconnectDelay = 800
let manualClose = false

function wsUrl(token) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`
}

function closeSocket() {
  manualClose = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  if (socket) {
    try {
      socket.close()
    } catch (_) {
      /* ignore */
    }
    socket = null
  }
}

/* 界面偏好在模块加载时读一次，当作三个字段的初值。放在这里而不是 bootstrap() 里：
   zustand 的 create 只求值一次，而 bootstrap 每次登录/重连都会跑；偏好是「这台机器
   上次的样子」，不该被登录动作重置。登录页也碰不到这几个字段（TopBar/ChatPanel 都在
   登录后才渲染），所以早读没有副作用。 */
const initialPrefs = loadUiPrefs()

/* 系统主题监听的退订函数。放在模块作用域而不是 zustand state 里 —— 它是个副作用
   句柄，不是界面状态，塞进 state 会让 devtools 里多出一个不可序列化的字段。 */
let unwatchTheme = () => {}

/** 按当前选择重建系统主题监听：'system' 时跟着系统变，显式档位时摘掉。 */
function rewatchTheme() {
  unwatchTheme()
  unwatchTheme = watchSystemTheme(useStore.getState().theme, (resolved) => {
    useStore.setState({ resolvedTheme: resolved })
  })
}

export const useStore = create((set, get) => ({
  /* ---------------- 状态 ---------------- */
  token: null,
  authed: false,
  loginError: '',
  loggingIn: false,

  conn: 'closed', // connecting | open | closed
  agents: [],
  tasks: [],
  conversations: [],
  system: null,

  /* 刻意**不**在模块加载时水合：只有 id 没有 detail 是个不自洽的状态（对话页会
     以为「已选中但没内容」）。它只作为候选值，由 bootstrap 校验通过后再走 selectTask
     真正恢复。 */
  selectedTaskId: null,
  detail: null, // { task, agent, messages, events, isRunning }
  detailLoading: false,

  mcpServers: [],
  mcpSummary: null,
  mcpLoading: false,

  /* 正在为哪个任务挑接手岗位（换岗弹窗）。放在 store 里是为了让看板卡片
     和聊天页都能直接开它，不必把回调从 App 一层层传下去。 */
  handoffFor: null,

  /* 更新状态。权威来源是 Electron 主进程，这里只是经 update:status 推送来的投影 */
  update: { status: 'idle', message: '', percent: 0 },

  toasts: [],

  /* 侧栏 / 对话面板的折叠开关。跨重启保留（见 lib/prefs.js）。
     注意：它一旦持久化，就会改变 scripts/e2e-check.js 与 scripts/responsive-check.js
     的运行前提 —— 两个脚本都必须在开头把 chaos.ui 清掉，否则上次折叠过侧栏的话
     下次 `aside` 里就读不到那 20 个职能名了。 */
  sidebarOpen: initialPrefs.sidebarOpen,
  chatOpen: initialPrefs.chatOpen,

  /* 主题。存的是**用户的选择**（可能是 'system'），不是解析后的结果 ——
     要跟主进程同步的是「选择」，因为下次冷启动的 splash 窗口也要按它渲染。
     DOM 上的 data-theme 在首帧前就由 public/theme-boot.js 设好了，这里只是
     在 React 侧保持同一个状态、并在「跟随系统」时跟着系统变。 */
  theme: initialPrefs.theme,
  /* 当前**生效**的主题（light | dark）。切换按钮的图标要按它画。 */
  resolvedTheme: resolveTheme(initialPrefs.theme),

  /* ---------------- 提示条 ---------------- */
  toast(text, kind = 'info') {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200)
  },

  /* ---------------- 面板折叠 ---------------- */
  toggleSidebar() {
    const next = !get().sidebarOpen
    set({ sidebarOpen: next })
    saveUiPrefs({ sidebarOpen: next })
  },
  toggleChat() {
    const next = !get().chatOpen
    set({ chatOpen: next })
    saveUiPrefs({ chatOpen: next })
  },

  /* ---------------- 主题 ---------------- */

  setTheme(mode) {
    const resolved = applyTheme(mode)
    set({ theme: mode, resolvedTheme: resolved })
    saveUiPrefs({ theme: mode })
    // 告诉主进程，供下次冷启动的 splash 窗口使用（它读不到 localStorage）。
    // 失败不影响界面 —— splash 会退回按系统偏好猜。
    window.chaos?.setTheme?.(mode).catch(() => {})
    rewatchTheme()
  },

  /** 顶栏那个按钮：在深/浅之间直接翻。system 模式下从「当前生效的那个」翻面。 */
  toggleTheme() {
    get().setTheme(get().resolvedTheme === 'light' ? 'dark' : 'light')
  },

  /* ---------------- 登录 ---------------- */
  async login(code) {
    set({ loggingIn: true, loginError: '' })
    try {
      const res = await api.login(code)
      setToken(res.token)
      set({ token: res.token, authed: true, loggingIn: false })
      await get().bootstrap()
      return true
    } catch (err) {
      set({ loginError: err.message || '登录失败', loggingIn: false, authed: false })
      return false
    }
  },

  logout() {
    closeSocket()
    setToken(null)
    saveUiPrefs({ selectedTaskId: null })
    set({
      token: null,
      authed: false,
      agents: [],
      tasks: [],
      detail: null,
      selectedTaskId: null,
      conn: 'closed',
    })
  },

  /* ---------------- 启动：拉快照 + 建连接 ---------------- */
  async bootstrap() {
    const token = get().token || loadToken()
    if (!token) return
    setToken(token)
    set({ token, authed: true })

    try {
      const [stateRes, sysRes, convRes, updRes] = await Promise.all([
        api.state(),
        api.system(),
        api.conversations().catch(() => ({ data: [] })),
        // 刷新页面或 WS 重连后补一次更新状态，否则正在下载的进度会凭空消失
        api.updateStatus().catch(() => ({ data: null })),
      ])
      set({
        agents: stateRes.data.agents,
        tasks: stateRes.data.tasks,
        system: sysRes.data,
        conversations: convRes.data || [],
        ...(updRes?.data ? { update: updRes.data } : {}),
      })

      // 恢复上次退出时正在看的对话。放在这里是因为这是登录与自动登录两条路唯一
      // 都经过的点（login() 内部也调 bootstrap），而且上面 401 分支会提前 return，
      // 不会出现「token 已失效、却在登录页背后悄悄恢复了选中态」。
      // 必须先校验任务还在：直接调 selectTask 会在任务被删时白弹一条「任务不存在」。
      const saved = loadUiPrefs().selectedTaskId
      if (saved && !get().selectedTaskId && stateRes.data.tasks.some((t) => t.id === saved)) {
        get().selectTask(saved)
      }
    } catch (err) {
      if (err.status === 401) {
        // token 过期（比如后端重启过）→ 回到登录页
        setToken(null)
        set({ authed: false, token: null, loginError: '会话已失效，请重新输入授权码' })
        return
      }
      get().toast(err.message, 'error')
    }

    connectSocket()
  },

  async refreshSystem() {
    try {
      const res = await api.system()
      set({ system: res.data })
    } catch (_) {
      /* ignore */
    }
  },

  /* ---------------- 任务详情 ---------------- */
  async selectTask(taskId) {
    if (!taskId) {
      // detailLoading 也要一起关掉：光靠下面那个慢响应守卫不够，它只在「真的有请求
      // 在飞」时才收尾，没有在途请求时（比如启动恢复后立刻开新对话）会永远停在
      // 「加载中…」，空状态引导再也出不来。
      saveUiPrefs({ selectedTaskId: null })
      set({ selectedTaskId: null, detail: null, detailLoading: false })
      return
    }
    saveUiPrefs({ selectedTaskId: taskId })
    set({ selectedTaskId: taskId, detailLoading: true })
    try {
      const res = await api.getTask(taskId)
      // 防止慢响应覆盖掉更新的选择
      if (get().selectedTaskId !== taskId) {
        // 这次的响应已经过期。如果期间用户是「取消选择」（新对话 / 删除任务 /
        // 清空看板都会把 selectedTaskId 置空），就不会再有别的请求来收尾了，
        // 必须自己把加载态关掉 —— 否则 detailLoading 会一直停在 true，
        // 对话页永远显示「加载中…」。只是切到另一个任务的话，
        // 那个请求会负责收尾，这里不要抢。
        if (get().selectedTaskId === null) set({ detailLoading: false })
        return
      }
      set({ detail: res.data, detailLoading: false })
    } catch (err) {
      set({ detailLoading: false })
      get().toast(err.message, 'error')
    }
  },

  /* ---------------- 任务动作 ---------------- */
  async createTask(payload) {
    try {
      const res = await api.createTask(payload)
      get().toast(`已创建任务「${res.data.title}」`, 'success')
      await get().selectTask(res.data.id)
      return res.data
    } catch (err) {
      get().toast(err.message, 'error')
      return null
    }
  },

  async createAgent(payload) {
    try {
      const res = await api.createAgent(payload)
      get().toast(`新员工「${res.data.name}」已入职`, 'success')
      return res.data
    } catch (err) {
      get().toast(err.message, 'error')
      return null
    }
  },

  async deleteAgent(id) {
    try {
      await api.deleteAgent(id)
      get().toast('员工已离职', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async startTask(id) {
    try {
      await api.start(id)
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async cancelTask(id) {
    try {
      await api.cancel(id)
      get().toast('已取消执行，任务退回「待处理」')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async doneTask(id) {
    try {
      await api.done(id)
      get().toast('任务已完成', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async moveTask(id, status) {
    try {
      await api.move(id, status)
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async deleteTask(id) {
    try {
      await api.deleteTask(id)
      if (get().selectedTaskId === id) {
        saveUiPrefs({ selectedTaskId: null })
        set({ selectedTaskId: null, detail: null })
      }
      get().toast('任务已删除')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async assignAgent(taskId, agentId) {
    try {
      await api.assign(taskId, agentId)
      await get().selectTask(taskId)
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 保存岗位的 MCP 挂载 / 流水线（PATCH /api/agents/:id） */
  async saveAgentConfig(id, patch) {
    try {
      await api.updateAgent(id, patch)
      get().toast('已保存岗位配置', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---- 换岗 ---- */

  openHandoff(taskId) {
    set({ handoffFor: taskId })
  },

  closeHandoff() {
    set({ handoffFor: null })
  },

  /** 换岗：运行中会交接（不是取消），未运行则直接改派 */
  async handoffTask(taskId, body) {
    try {
      const res = await api.handoff(taskId, body)
      set({ handoffFor: null })
      get().toast(res && res.pending ? '正在换岗，当前回合结束后交接' : '已换岗', 'info')
      await get().selectTask(taskId)
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 停止自动换岗重试（退避中直接停，任务落到「需要输入」） */
  async stopRetry(id) {
    try {
      await api.setRetry(id, false)
      get().toast('已停止自动重试')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async sendInput(taskId, text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    try {
      const res = await api.input(taskId, trimmed)
      if (res && res.queued) get().toast('指令已排队，将在当前回合结束后发送')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async clearHistory(taskId) {
    try {
      await api.clearHistory(taskId)
      await get().selectTask(taskId)
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async setPermissionMode(mode) {
    try {
      await api.setPermissionMode(mode)
      await get().refreshSystem()
      get().toast(`权限模式已切换为 ${mode}`, 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---------------- 对话 ---------------- */

  async refreshConversations() {
    try {
      const res = await api.conversations()
      set({ conversations: res.data || [] })
    } catch (_) {
      /* 静默失败：对话列表不是关键路径 */
    }
  },

  /** 开一个新对话（清空当前选择，下一条消息会新建任务并自动派单） */
  newConversation() {
    saveUiPrefs({ selectedTaskId: null })
    set({ selectedTaskId: null, detail: null, detailLoading: false })
  },

  /**
   * 在对话页发一条消息。
   * 没有 selectedTaskId 时后端会自动挑一个 Agent 建任务并执行。
   */
  async sendChat({ text, model, executor, agentId }) {
    const content = String(text || '').trim()
    if (!content) return

    const conversationId = get().selectedTaskId
    try {
      const res = await api.chat({
        conversationId: conversationId || undefined,
        text: content,
        model: model !== undefined ? model : undefined,
        executor: executor !== undefined ? executor : undefined,
        agentId: agentId || undefined,
      })
      // 新对话：后端会把自动派单的结果带回来，立刻选中它
      if (!conversationId && res.taskId) {
        await get().selectTask(res.taskId)
        if (res.agent) {
          get().toast(`已自动分配给「${res.agent.functionLabel}」`, 'success')
        }
      }
      get().refreshConversations()
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 改当前对话（或指定 Agent）使用的模型 */
  async setConversationModel(taskId, { model, executor }) {
    const id = taskId || get().selectedTaskId
    if (!id) return
    try {
      await api.updateTask(id, {
        ...(model !== undefined ? { model } : {}),
        ...(executor !== undefined ? { executor } : {}),
      })
      await get().selectTask(id)
      get().toast('已切换模型', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---------------- 任务批量 ---------------- */

  async clearAllTasks() {
    try {
      await api.clearAllTasks()
      saveUiPrefs({ selectedTaskId: null })
      set({ selectedTaskId: null, detail: null, tasks: [], conversations: [] })
      get().toast('已清空所有任务', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---------------- MCP ---------------- */

  async loadMcp() {
    set({ mcpLoading: true })
    try {
      const res = await api.mcp()
      set({ mcpServers: res.data.servers || [], mcpSummary: res.data.summary || null, mcpLoading: false })
    } catch (err) {
      set({ mcpLoading: false })
      get().toast(err.message, 'error')
    }
  },

  async enableMcp(id, opts = {}) {
    set({ mcpLoading: true })
    try {
      await api.mcpEnable(id, opts)
      await get().loadMcp()
      get().toast(`已启用 MCP：${id}`, 'success')
    } catch (err) {
      set({ mcpLoading: false })
      get().toast(err.message, 'error')
    }
  },

  async disableMcp(id) {
    set({ mcpLoading: true })
    try {
      await api.mcpDisable(id)
      await get().loadMcp()
      get().toast(`已停用 MCP：${id}`)
    } catch (err) {
      set({ mcpLoading: false })
      get().toast(err.message, 'error')
    }
  },

  async setDevecoAutoApprove(enabled) {
    try {
      await api.setSettings({ devecoAutoApprove: enabled })
      await get().refreshSystem()
      get().toast(enabled ? 'DevEco 自动放行已开启' : 'DevEco 自动放行已关闭', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---------------- 更新 ---------------- */

  async checkUpdate() {
    get().toast('正在检查更新…')
    try {
      const res = await api.checkUpdate()
      const d = res.data || {}
      set({ update: { ...get().update, ...d } })
      const kind = d.status === 'error' ? 'error' : d.status === 'available' ? 'success' : 'info'
      get().toast(d.message || '检查完成', kind)
      return d
    } catch (err) {
      get().toast(err.message, 'error')
      return null
    }
  },

  /** 用户点「下载」才会走到这里 —— autoDownload 已经关掉了 */
  async downloadUpdate() {
    try {
      const res = await api.downloadUpdate()
      const d = res.data || {}
      set({ update: { ...get().update, ...d } })
      if (d.status === 'error') get().toast(d.message || '下载失败', 'error')
      return d
    } catch (err) {
      get().toast(err.message, 'error')
      return null
    }
  },

  /** 用户点「安装并重启」并确认后调用 */
  async installUpdate() {
    try {
      const res = await api.installUpdate()
      const d = res.data || {}
      set({ update: { ...get().update, ...d } })
      return d
    } catch (err) {
      get().toast(err.message, 'error')
      return null
    }
  },

  /** 拉取历史版本列表（设置里的「版本回退」用） */
  async loadReleases() {
    try {
      const res = await api.releases()
      return res.data || { supported: false, releases: [] }
    } catch (err) {
      get().toast(err.message, 'error')
      return { supported: false, releases: [], error: err.message }
    }
  },

  /** 回退到指定版本：下载该版本的安装包，下好后仍要用户点「安装并重启」 */
  async rollbackTo(tag) {
    try {
      const res = await api.rollback(tag)
      const d = res.data || {}
      set({ update: { ...get().update, ...d } })
      if (d.status === 'error') get().toast(d.message || '回退失败', 'error')
      else get().toast(`正在下载 ${tag}，下载完点顶栏「安装并重启」生效`, 'info')
      return d
    } catch (err) {
      get().toast(err.message, 'error')
      return null
    }
  },

  /** 自动换岗重试上限。0 = 不限次数（默认） */
  async setMaxAttempts(n) {
    try {
      await api.setSettings({ maxAttempts: Number(n) })
      await get().refreshSystem()
      get().toast(Number(n) > 0 ? `已限制：最多自动换岗重试 ${n} 次` : '已设为不限次数', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 按岗位挂载 MCP 的三个开关（总闸 / 严格模式 / 给 agent 的换岗工具） */
  async setMcpOption(key, value) {
    try {
      await api.setSettings({ [key]: value })
      await get().refreshSystem()
      get().toast('已更新 MCP 设置', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 阶段流水线总闸。关掉后所有任务都退回「一个人干到底」的老行为 */
  async setPipelineEnabled(enabled) {
    try {
      await api.setSettings({ pipelineEnabled: enabled })
      await get().refreshSystem()
      get().toast(enabled ? '已开启阶段流水线' : '已关闭阶段流水线（任务不再按阶段推进）', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async setAutoUpdateWhenIdle(enabled) {
    try {
      await api.setSettings({ autoUpdateWhenIdle: enabled })
      await get().refreshSystem()
      get().toast(
        enabled ? '已开启：空闲时自动检查并下载更新（安装仍需你确认）' : '已关闭空闲时自动更新',
        'success',
      )
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },
}))

/* ------------------------------------------------------------------ *
 * WebSocket 接线
 * ------------------------------------------------------------------ */

function connectSocket() {
  const token = useStore.getState().token
  if (!token) return

  manualClose = false
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return

  useStore.setState({ conn: 'connecting' })

  let ws
  try {
    ws = new WebSocket(wsUrl(token))
  } catch (err) {
    scheduleReconnect()
    return
  }
  socket = ws

  ws.onopen = () => {
    reconnectDelay = 800
    useStore.setState({ conn: 'open' })
  }

  ws.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch (_) {
      return
    }
    handleServerMessage(msg)
  }

  ws.onclose = (event) => {
    useStore.setState({ conn: 'closed' })
    if (event.code === 4001) {
      // 服务端拒绝了 token
      setToken(null)
      useStore.setState({ authed: false, token: null, loginError: '会话已失效，请重新输入授权码' })
      return
    }
    scheduleReconnect()
  }

  ws.onerror = () => {
    /* onclose 会接着触发，统一在那里处理重连 */
  }
}

function scheduleReconnect() {
  if (manualClose) return
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    reconnectDelay = Math.min(reconnectDelay * 1.6, 8000)
    connectSocket()
  }, reconnectDelay)
}

function handleServerMessage(msg) {
  const { type, payload } = msg
  const state = useStore.getState()

  switch (type) {
    case 'hello':
      break

    case 'snapshot':
      useStore.setState({ agents: payload.agents, tasks: payload.tasks })
      break

    case 'agent:updated':
      useStore.setState({
        agents: state.agents.some((a) => a.id === payload.id)
          ? state.agents.map((a) => (a.id === payload.id ? payload : a))
          : [...state.agents, payload],
        // 对话页顶部的岗位徽标 / 执行器 / 模型也是从 detail.agent 取的，
        // 不同步的话员工信息改了、对话页还显示旧的。
        detail:
          state.detail && state.detail.agent?.id === payload.id
            ? { ...state.detail, agent: payload }
            : state.detail,
      })
      break

    case 'agent:deleted':
      useStore.setState({
        agents: state.agents.filter((a) => a.id !== payload.id),
        // 员工被解雇后，对话页不能继续挂着一个已经不存在的人
        detail:
          state.detail && state.detail.agent?.id === payload.id
            ? { ...state.detail, agent: null }
            : state.detail,
      })
      break

    case 'task:updated': {
      const prevTask = state.tasks.find((t) => t.id === payload.id)
      useStore.setState({
        tasks: state.tasks.some((t) => t.id === payload.id)
          ? state.tasks.map((t) => (t.id === payload.id ? payload : t))
          : [payload, ...state.tasks],
      })
      // 换岗提示：靠 handoffAt 的跃迁判断（**不新增 WS 事件类型** —— 前端
      // handleServerMessage 的 switch 没有 default 报错，漏一个 case 就是静默
      // 失效，所以新状态一律挂在既有 task 字段上）
      if (prevTask && payload.handoffAt && payload.handoffAt !== prevTask.handoffAt) {
        const st = useStore.getState()
        const to = (st.agents.find((a) => a.id === payload.agentId) || {}).functionLabel || '新岗位'
        st.toast(`已换岗：交给「${to}」`, 'info')
      }
      if (state.detail && state.detail.task.id === payload.id) {
        useStore.setState({ detail: { ...state.detail, task: payload } })
      }
      // 历史对话列表同步更新：它以前只在「发消息」时刷新，任务跑完了还挂着
      // 呼吸点、排序也停在旧位置。running 用 runState 反推，和服务端
      // runner.isRunning() 的口径一致。
      if (state.conversations.some((c) => c.id === payload.id)) {
        useStore.setState({
          conversations: state.conversations
            .map((c) =>
              c.id === payload.id
                ? {
                    ...c,
                    status: payload.status,
                    runState: payload.runState,
                    updatedAt: payload.updatedAt,
                    running: payload.runState === 'running' || payload.runState === 'queued',
                  }
                : c,
            )
            .sort((a, b) => b.updatedAt - a.updatedAt),
        })
      }
      break
    }

    case 'task:deleted':
      // 删掉的正好是选中的那个 → 本地偏好里的 id 也必须一起清，
      // 否则下次启动会拿着一个已经不存在的 id 去恢复
      if (state.selectedTaskId === payload.id) saveUiPrefs({ selectedTaskId: null })
      useStore.setState({
        tasks: state.tasks.filter((t) => t.id !== payload.id),
        conversations: state.conversations.filter((c) => c.id !== payload.id),
        selectedTaskId: state.selectedTaskId === payload.id ? null : state.selectedTaskId,
        detail: state.detail && state.detail.task.id === payload.id ? null : state.detail,
      })
      break

    case 'message:added':
      if (state.detail && state.detail.task.id === payload.taskId) {
        if (!state.detail.messages.some((m) => m.id === payload.id)) {
          useStore.setState({ detail: { ...state.detail, messages: [...state.detail.messages, payload] } })
        }
      }
      break

    case 'event:added':
      if (state.detail && state.detail.task.id === payload.taskId) {
        if (!state.detail.events.some((e) => e.id === payload.id)) {
          useStore.setState({ detail: { ...state.detail, events: [...state.detail.events, payload] } })
        }
      }
      break

    case 'task:history-cleared':
      if (state.detail && state.detail.task.id === payload.taskId) {
        useStore.setState({ detail: { ...state.detail, messages: [], events: [] } })
      }
      break

    case 'tasks:cleared':
      saveUiPrefs({ selectedTaskId: null })
      useStore.setState({ tasks: [], conversations: [], selectedTaskId: null, detail: null })
      break

    case 'unauthorized':
      useStore.setState({ conn: 'closed' })
      break

    /* 更新状态（含下载进度）。这一路以前没人在听，广播过来直接掉进 default 被丢掉，
       所以「检查更新」的结果从来没在界面上体现过。 */
    case 'update:status': {
      if (!payload || typeof payload !== 'object') break
      // 刻意不用 switch 前那个 state 快照：进度帧是高频的，快照会丢帧，
      // toast 去重也必须读实时值
      const prev = useStore.getState().update
      const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)
      useStore.setState({
        update: {
          ...prev,
          ...payload,
          percent: num(payload.percent),
          transferred: num(payload.transferred),
          total: num(payload.total),
          bytesPerSecond: num(payload.bytesPerSecond),
        },
      })
      const next = useStore.getState().update
      // 只在「刚下好」这一跃迁上提示一次，别每帧都弹
      if (next.status === 'downloaded' && prev.status !== 'downloaded') {
        useStore
          .getState()
          .toast(`新版本 v${next.version} 已下载完成，点右上角「安装并重启」生效`, 'success')
      }
      break
    }

    default:
      break
  }
}

/* 模块加载时就挂上系统主题监听 —— 「跟随系统」是默认值，而且用户可能在应用运行
   期间改 Windows 的深浅色。DOM 上那份由 public/theme-boot.js 设过初值了，
   这里只让 React 侧的 resolvedTheme 跟上。 */
rewatchTheme()

export { connectSocket, closeSocket }
