import { create } from 'zustand'
import { api, setToken, loadToken } from './lib/api'

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

  selectedTaskId: null,
  detail: null, // { task, agent, messages, events, isRunning }
  detailLoading: false,

  mcpServers: [],
  mcpSummary: null,
  mcpLoading: false,

  /* 更新状态。权威来源是 Electron 主进程，这里只是经 update:status 推送来的投影 */
  update: { status: 'idle', message: '', percent: 0 },

  toasts: [],

  /* ---------------- 提示条 ---------------- */
  toast(text, kind = 'info') {
    const id = Math.random().toString(36).slice(2)
    set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200)
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
      set({ selectedTaskId: null, detail: null })
      return
    }
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
      if (get().selectedTaskId === id) set({ selectedTaskId: null, detail: null })
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
    set({ selectedTaskId: null, detail: null })
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

    case 'task:updated':
      useStore.setState({
        tasks: state.tasks.some((t) => t.id === payload.id)
          ? state.tasks.map((t) => (t.id === payload.id ? payload : t))
          : [payload, ...state.tasks],
      })
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

    case 'task:deleted':
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

export { connectSocket, closeSocket }
