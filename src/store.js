import { create } from 'zustand'
import { api, setToken, loadToken } from './lib/api'
import { loadUiPrefs, saveUiPrefs } from './lib/prefs'
import { applyTheme, applyAccent, resolveTheme, watchSystemTheme } from './lib/theme'
import { translate } from './lib/i18n'

/* 9.5.3：数组防御。用户机器上出现过 `c.map is not a function` 白屏（bundle 里
   templates/agents/tasks/conversations 的 .map 调用点），根因是某条路径把非数组
   写进了这几个全局键（WS snapshot / HTTP 响应异常 / 旧数据残留都有嫌疑）。
   治标 + 治本双保险：各 set 点显式归一化（asArr），zustand setState 再包一层
   兜底（见文件末尾 installArrayGuards），保证这四个键永远是真数组。 */
const asArr = (v) => (Array.isArray(v) ? v : [])

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

/* 8.0.0：强调色也必须在首帧前生效（theme-boot.js 已设 dataset，这里兜底内存态） */
applyAccent(initialPrefs.accent)

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

  /* 8.0.0：岗位详情弹窗（侧栏和命令面板共用） */
  agentDetailId: null,

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

  /* 8.0.0：语言 / 强调色 / 桌面集成 */
  language: initialPrefs.language,
  accent: initialPrefs.accent,

  /* 8.0.2：纸质阅读模式 / 禅模式 / 新对话默认执行器与模型（混沌优先） */
  paperMode: initialPrefs.paperMode,
  zenMode: initialPrefs.zenMode,
  draftExecutor: initialPrefs.draftExecutor,
  draftModel: initialPrefs.draftModel,

  /* 8.0.0：批量选择 */
  selectedTaskIds: [],

  /* 8.0.0：命令面板 / 快捷键帮助 */
  paletteOpen: false,
  paletteQuery: '',
  paletteResults: { tasks: [], agents: [], messages: [], events: [] },
  helpOpen: false,

  /* 8.0.0：任务模板 */
  templates: [],

  /* 8.0.0：工具链 */
  toolchain: null,
  toolchainJob: null,
  toolchainLogs: [],

  /* 8.0.2：混沌增强（专家/记忆/自动化/速答/擂台/老板键…） */
  bossMode: false, // 老板键遮罩，不持久化（重启后不该还是伪装状态）
  quickOpen: false, // 应用内速答浮层
  chaosMemory: [],
  chaosAutomations: [],
  dailyQuote: null, // { text, at }

  /* 混沌 · 本地大模型 */
  chaosStatus: null,
  chaosJob: null,
  chaosLogs: [],

  /* 8.0.0：备份 / 统计 / 诊断 */
  backups: [],
  backupsMeta: null,
  stats: null,
  statsLoading: false,
  diagnostics: null,
  diagnosticsLoading: false,

  /* 8.0.0：全局弹窗（设置/统计/诊断/备份/工具链等），任何组件都能打开 */
  uiModal: null,

  /* 9.0.0：主工作区当前页面 —— WorkBuddy 式左侧导航栏切换。
     chat = 对话工作台（岗位栏+看板+聊天），其余为独立功能页 */
  // 9.6.1：每次打开应用默认落在工作台（而不是上次的对话页）
  mainView: 'home',

  /* 9.3.8：右侧预览面板（文件 / 知识库），对话页里可开关 */
  previewOpen: initialPrefs.previewOpen,

  /* 9.3.8：安全锁屏（设置了 PIN 后，点 🔒 或快捷键锁住整个界面） */
  locked: false,

  /* 8.0.0：Watt Toolkit 提示 */
  wattPromptOpen: false,

  /* ---------------- 提示条 ---------------- */
  /* 9.7.0：报错停留 10 秒（够看清），其余 4.2 秒。以前一律 4.2 秒，
     错误信息还没读完就消失了，用户报过好几次「报错看不清」。 */
  toast(text, kind = 'info') {
    const id = Math.random().toString(36).slice(2)
    const ms = kind === 'error' ? 10000 : 4200
    set((s) => ({ toasts: [...s.toasts, { id, text, kind, ms }] }))
    setTimeout(() => get().dismissToast(id), ms)
  },

  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
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

  /* 8.0.2：纸质阅读模式 / 禅模式（持久化）；新对话默认执行器/模型 */
  togglePaperMode() {
    const next = !get().paperMode
    set({ paperMode: next })
    saveUiPrefs({ paperMode: next })
  },
  toggleZenMode() {
    const next = !get().zenMode
    set({ zenMode: next })
    saveUiPrefs({ zenMode: next })
  },
  setDraftExecutor(executor, model = '') {
    set({ draftExecutor: executor, draftModel: model })
    saveUiPrefs({ draftExecutor: executor, draftModel: model })
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
      const sys = sysRes.data || {}
      const language = ['zh', 'en'].includes(sys.uiLanguage) ? sys.uiLanguage : get().language
      const accent = ['amber', 'sky', 'violet', 'emerald'].includes(sys.accent) ? sys.accent : get().accent
      applyAccent(accent)
      document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN'
      saveUiPrefs({ language, accent })
      set({
        agents: asArr(stateRes.data?.agents),
        tasks: asArr(stateRes.data?.tasks),
        system: sys,
        conversations: asArr(convRes.data),
        language,
        accent,
        ...(updRes?.data ? { update: updRes.data } : {}),
      })

      // 9.6.1：混沌就绪时对话默认就用混沌模型（但**不**自动改岗位执行器 ——
      // 岗位挂什么由用户自己决定）。只在用户还没选过时补默认值，不覆盖已有偏好。
      const chaosExec = asArr(sys.executors).find((e) => e.id === 'chaos')
      const chaosModels = asArr(chaosExec?.models)
      const preferModel =
        chaosModels.find((m) => m.installed && m.recommended)?.id ||
        chaosModels.find((m) => m.installed)?.id ||
        chaosModels[0]?.id ||
        ''
      const patchDraft = {}
      if (!get().draftExecutor) patchDraft.draftExecutor = 'chaos'
      if (!get().draftModel && preferModel) patchDraft.draftModel = preferModel
      if (Object.keys(patchDraft).length) {
        set(patchDraft)
        saveUiPrefs(patchDraft)
      }

      // 恢复上次退出时正在看的对话。放在这里是因为这是登录与自动登录两条路唯一
      // 都经过的点（login() 内部也调 bootstrap），而且上面 401 分支会提前 return，
      // 不会出现「token 已失效、却在登录页背后悄悄恢复了选中态」。
      // 必须先校验任务还在：直接调 selectTask 会在任务被删时白弹一条「任务不存在」。
      const saved = loadUiPrefs().selectedTaskId
      if (saved && !get().selectedTaskId && asArr(stateRes.data?.tasks).some((t) => t.id === saved)) {
        get().selectTask(saved)
        // 9.6.1：恢复上次的会话但不把用户带到对话页 —— 每次打开都从工作台开始
        set({ mainView: 'home' })
      }
    } catch (err) {
      if (err.status === 401) {
        // 9.3.8：授权码登录已关闭 —— token 过期就静默补一张新票再试一次，
        // 不再把用户踢回登录页
        try {
          const r = await api.login('')
          setToken(r.token)
          set({ token: r.token, authed: true })
          return get().bootstrap()
        } catch (_) {
          set({ authed: false, token: null, loginError: '' })
          return
        }
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
    // 9.0.0：选对话 = 回到对话页（工作台/专家页点对话条目时自动跳转）
    if (get().mainView !== 'chat') set({ mainView: 'chat' })
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
      // 9.5.3：detail 里的 messages / events / tags 同样归一化，防止异常响应
      // 把非数组带进渲染路径（ChatPanel 551 行的 [...messages.map(...)]）
      const d = res.data && typeof res.data === 'object' ? res.data : {}
      set({
        detail: {
          ...d,
          messages: asArr(d.messages),
          events: asArr(d.events),
        },
        detailLoading: false,
      })
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

  openModal(name) {
    set({ uiModal: name || null })
  },

  /** 9.0.0：切换主工作区页面（WorkBuddy 式导航栏） */
  setMainView(view) {
    set({ mainView: view || 'chat' })
  },

  /** 9.3.8：右侧预览面板开关（文件 / 知识库） */
  togglePreview(open) {
    const next = open === undefined ? !get().previewOpen : Boolean(open)
    set({ previewOpen: next })
    saveUiPrefs({ previewOpen: next })
  },

  /** 9.3.8：锁屏 / 解锁（PIN 校验走后端，PIN 只存本机） */
  lockApp() {
    if (!get().system?.hasPin) {
      get().toast('先到 设置 → 安全 里设置一个 PIN，才能锁屏', 'info')
      return
    }
    set({ locked: true })
  },

  async unlockApp(pin) {
    try {
      const res = await api.unlock(pin)
      if (!res.ok) throw new Error(res.error || 'PIN 不正确')
      set({ locked: false })
      return true
    } catch (err) {
      return false
    }
  },

  /** 9.0.0：技能页选中的指令模板，ChatPanel 消费后清空 */
  skillDraft: null,
  setSkillDraft(text) {
    set({ skillDraft: text || null })
  },

  closeModal() {
    set({ uiModal: null })
  },

  openAgentDetail(id) {
    set({ agentDetailId: id })
  },

  closeAgentDetail() {
    set({ agentDetailId: null })
  },

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
      set({ conversations: asArr(res.data) })
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
    // 8.0.2：新对话还没有任务时，用选择器里选好的默认执行器/模型（混沌优先）
    const draftExecutor = get().draftExecutor
    const draftModel = get().draftModel
    try {
      const res = await api.chat({
        conversationId: conversationId || undefined,
        text: content,
        model: model !== undefined ? model : conversationId ? undefined : draftModel || undefined,
        executor: executor !== undefined ? executor : conversationId ? undefined : draftExecutor || undefined,
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

  /* ================================================================ *
   * 8.0.0
   * ================================================================ */

  t(key, vars) {
    return translate(get().language, key, vars)
  },

  async setLanguage(lang) {
    if (!['zh', 'en'].includes(lang)) return
    set({ language: lang })
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
    saveUiPrefs({ language: lang })
    try {
      await api.setSettings({ uiLanguage: lang })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async setAccent(accent) {
    const next = applyAccent(accent)
    set({ accent: next })
    saveUiPrefs({ accent: next })
    try {
      await api.setSettings({ accent: next })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 桌面/行为类开关的统一入口 */
  async setDesktopSetting(key, value) {
    try {
      await api.setSettings({ [key]: value })
      await get().refreshSystem()
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---- 任务模板 ---- */
  async loadTemplates() {
    try {
      const res = await api.templates()
      set({ templates: asArr(res.data) })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async createTemplate(payload) {
    try {
      const res = await api.createTemplate(payload)
      set({ templates: [res.data, ...get().templates] })
      get().toast(`模板「${res.data.name}」已保存`, 'success')
      return res.data
    } catch (err) {
      get().toast(err.message, 'error')
      return null
    }
  },

  async updateTemplate(id, patch) {
    try {
      const res = await api.updateTemplate(id, patch)
      set({ templates: get().templates.map((t) => (t.id === id ? res.data : t)) })
      return res.data
    } catch (err) {
      get().toast(err.message, 'error')
      return null
    }
  },

  async deleteTemplate(id) {
    try {
      await api.deleteTemplate(id)
      set({ templates: get().templates.filter((t) => t.id !== id) })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---- 命令面板 / 全局搜索 ---- */
  openPalette() {
    set({
      paletteOpen: true,
      paletteQuery: '',
      paletteResults: { tasks: [], agents: [], messages: [], events: [] },
    })
  },

  closePalette() {
    set({ paletteOpen: false })
  },

  async searchGlobal(query) {
    set({ paletteQuery: query })
    if (String(query).trim().length < 2) {
      set({ paletteResults: { tasks: [], agents: [], messages: [], events: [] } })
      return
    }
    try {
      const res = await api.search(query)
      if (get().paletteQuery === query) set({ paletteResults: res.data })
    } catch (_) {
      /* 搜索失败不打断输入 */
    }
  },

  toggleHelp(open) {
    set({ helpOpen: open === undefined ? !get().helpOpen : Boolean(open) })
  },

  /* ---- 批量选择 ---- */
  toggleTaskSelection(id) {
    const cur = get().selectedTaskIds
    set({ selectedTaskIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] })
  },

  clearTaskSelection() {
    set({ selectedTaskIds: [] })
  },

  selectAllTasks() {
    set({ selectedTaskIds: get().tasks.map((t) => t.id) })
  },

  async batchTasks(action, payload) {
    const ids = get().selectedTaskIds
    if (!ids.length) return
    try {
      const res = await api.batch(action, ids, payload)
      const results = res.results || []
      const failed = results.filter((r) => !r.ok)
      if (failed.length) {
        get().toast(
          `${results.length - failed.length} 个成功，${failed.length} 个失败：${failed[0].error || ''}`,
          'error',
        )
      } else {
        get().toast(`已批量操作 ${results.length} 个任务`, 'success')
      }
      if (['delete', 'move', 'done', 'start', 'cancel'].includes(action)) set({ selectedTaskIds: [] })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---- 备份 ---- */
  async loadBackups() {
    try {
      const res = await api.backups()
      set({ backups: res.data.backups || [], backupsMeta: res.data })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async createBackup() {
    try {
      await api.createBackup()
      await get().loadBackups()
      get().toast('备份已创建', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async restoreBackup(name) {
    try {
      await api.restoreBackup(name)
      await get().bootstrap()
      get().toast('备份已恢复', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async deleteBackup(name) {
    try {
      await api.deleteBackup(name)
      await get().loadBackups()
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---- 工作区导出 / 导入 ---- */
  async exportWorkspace() {
    try {
      const { blob, filename } = await api.exportWorkspace()
      downloadBlob(blob, filename)
      get().toast('工作区已导出', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async importWorkspace(data) {
    try {
      const res = await api.importWorkspace(data)
      const c = res.data?.counts || {}
      saveUiPrefs({ selectedTaskId: null })
      set({ selectedTaskId: null, detail: null })
      await get().bootstrap()
      get().toast(
        `已导入 ${c.agents || 0} 个岗位 / ${c.tasks || 0} 个任务 / ${c.messages || 0} 条消息`,
        'success',
      )
      return true
    } catch (err) {
      get().toast(err.message, 'error')
      return false
    }
  },

  /* ---- 统计 / 诊断 ---- */
  async loadStats(days = '30') {
    set({ statsLoading: true })
    try {
      const res = await api.stats(days)
      set({ stats: res.data, statsLoading: false })
    } catch (err) {
      set({ statsLoading: false })
      get().toast(err.message, 'error')
    }
  },

  async loadDiagnostics() {
    set({ diagnosticsLoading: true })
    try {
      const res = await api.diagnostics()
      set({ diagnostics: res.data, diagnosticsLoading: false })
    } catch (err) {
      set({ diagnosticsLoading: false })
      get().toast(err.message, 'error')
    }
  },

  async exportDiagnostics() {
    try {
      const { blob, filename } = await api.exportDiagnostics()
      downloadBlob(blob, filename)
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---- 工具链 ---- */
  async loadToolchain() {
    try {
      const res = await api.toolchain()
      set({ toolchain: res.data, toolchainJob: res.data.activeJob || null })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async installTool(tool) {
    try {
      const res = await api.installTool(tool)
      set({ toolchainJob: res.data, toolchainLogs: [] })
      get().toast(`开始安装：${tool}`, 'info')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async cancelToolInstall() {
    const job = get().toolchainJob
    if (!job) return
    try {
      await api.cancelToolInstall(job.id)
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async refreshToolchain() {
    try {
      const res = await api.refreshToolchain()
      set({ toolchain: res.data })
      await get().refreshSystem()
      get().toast('已重新检测运行环境', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---- 8.0.2：混沌增强 ---- */

  toggleBossMode() {
    set({ bossMode: !get().bossMode })
  },

  toggleQuick(v) {
    set({ quickOpen: v === undefined ? !get().quickOpen : Boolean(v) })
  },

  async loadChaosMemory() {
    try {
      const res = await api.chaosMemory()
      set({ chaosMemory: Array.isArray(res.data) ? res.data : [] })
    } catch (_) {
      /* 静默：记忆不是关键路径 */
    }
  },

  async saveChaosMemory(items) {
    try {
      const list = await api.chaosMemorySet(items)
      set({ chaosMemory: asArr(list.data) })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  addChaosMemory(text) {
    const clean = String(text || '').replace(/^记住[:：]?\s*/, '').trim()
    if (!clean) return
    const items = [{ text: clean }, ...get().chaosMemory].slice(0, 100)
    get().saveChaosMemory(items)
    get().toast('混沌已记住（本地保存，可在 🧠 面板管理）', 'success')
  },

  async setChaosExpert(id) {
    try {
      await api.chaosExpert(id)
      await get().refreshSystem()
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async loadChaosAutomations() {
    try {
      const res = await api.chaosAutomations()
      set({ chaosAutomations: Array.isArray(res.data) ? res.data : [] })
    } catch (_) {
      /* 静默 */
    }
  },

  async upsertChaosAutomation(a) {
    try {
      const res = await api.chaosAutomationUpsert(a)
      if (!res.ok) throw new Error(res.error || '保存失败')
      await get().loadChaosAutomations()
      get().toast('自动化已保存（到点自动用混沌执行）', 'success')
      return true
    } catch (err) {
      get().toast(err.message, 'error')
      return false
    }
  },

  async deleteChaosAutomation(id) {
    try {
      await api.chaosAutomationDelete(id)
      await get().loadChaosAutomations()
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 速答（不进任务队列、不留记录）。返回文本或抛错。 */
  async chaosQuick(prompt) {
    const res = await api.chaosQuick(prompt)
    if (!res.ok) throw new Error(res.error || '速答失败')
    return res.data
  },

  async chaosRewrite(text) {
    const res = await api.chaosRewrite(text)
    if (!res.ok) throw new Error(res.error || '魔法棒失败')
    return res.data
  },

  async chaosArena(text, models) {
    const res = await api.chaosArena(text, models)
    if (!res.ok) throw new Error(res.error || '擂台失败')
    return res.data
  },

  /** 重新生成最后一条回答 */
  async regenerateTask(taskId) {
    const id = taskId || get().selectedTaskId
    if (!id) return
    try {
      const res = await api.regenerateTask(id)
      if (!res.ok) throw new Error(res.error || '无法重新生成')
      await get().selectTask(id)
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 对话分支：岔出一条新对话并选中 */
  async branchTask(taskId) {
    const id = taskId || get().selectedTaskId
    if (!id) return
    try {
      const res = await api.branchTask(id)
      if (!res.ok) throw new Error(res.error || '分支失败')
      await get().refreshConversations()
      await get().selectTask(res.taskId)
      get().toast('已岔出新分支，原对话不受影响', 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 时光机回滚：把对话裁剪回只剩 keep 条消息 */
  async rollbackTask(taskId, keep) {
    const id = taskId || get().selectedTaskId
    if (!id) return
    try {
      const res = await api.rollbackTask(id, keep)
      if (!res.ok) throw new Error(res.error || '回滚失败')
      await get().selectTask(id)
      get().toast(`已回滚（移除 ${res.data?.removed ?? '?'} 条消息）`, 'success')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /** 每日一句：本地混沌生成，一天只取一次 */
  async fetchDailyQuote() {    const today = new Date().toISOString().slice(0, 10)
    try {
      const raw = localStorage.getItem('chaos.dailyQuote')
      const saved = raw ? JSON.parse(raw) : null
      if (saved && saved.day === today) {
        set({ dailyQuote: saved.quote })
        return
      }
    } catch (_) {
      /* ignore */
    }
    const system = get().system
    const chaos = system?.chaos
    if (!chaos || !chaos.serverUp) return
    try {
      const res = await api.chaosQuick(
        '用一两句温暖有力的话，给正在工作的人一句今日建议。要求：不超过 40 个字，不要标题、不要引号、不要解释。',
      )
      if (res.ok && res.data?.text) {
        const quote = { text: res.data.text.trim().slice(0, 120), at: Date.now() }
        set({ dailyQuote: quote })
        try {
          localStorage.setItem('chaos.dailyQuote', JSON.stringify({ day: today, quote }))
        } catch (_) {
          /* ignore */
        }
      }
    } catch (_) {
      /* 混沌没就绪就安静跳过，绝不打断启动 */
    }
  },

  /* ---- 8.0.2：Token 额度（每日 3000 万免费；9.5.4 起填手机号绑定激活） ---- */

  async bindChaosPhone(phone) {
    try {
      const res = await api.chaosBindPhone(phone)
      if (!res.ok) throw new Error(res.error || '绑定失败')
      get().toast(res.data?.already ? '该手机号已绑定过，每天 3000 万 token 继续有效' : '绑定成功！每个手机号每天 3000 万 token', 'success')
      await get().loadChaosStatus()
      await get().refreshSystem()
      return true
    } catch (err) {
      get().toast(err.message, 'error')
      return false
    }
  },

  /* ---- 9.8.0：兑换码（手机号下方那一格，可选） ---- */
  async redeemChaosCode(code) {
    const c = String(code || '').trim()
    if (!c) {
      get().toast('请输入兑换码', 'error')
      return false
    }
    try {
      const res = await api.chaosRedeem(c)
      if (!res.ok) throw new Error(res.error || '兑换失败')
      const d = res.data || {}
      get().toast(
        d.repeat ? `兑换码 ${d.code} 已经用过了，额度继续不限量` : `兑换成功：${d.label || d.code} · ${d.note || '额度已升级'}`,
        'success',
      )
      await get().loadChaosStatus()
      await get().refreshSystem()
      return true
    } catch (err) {
      get().toast(err.message, 'error')
      return false
    }
  },

  /* ---- 混沌 · 本地大模型 ---- */
  async loadChaosStatus() {
    try {
      const res = await api.chaosStatus()
      set({ chaosStatus: res.data, chaosJob: res.data.activeJob || null })
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async installChaos() {
    try {
      const res = await api.chaosInstall()
      set({ chaosJob: res.data, chaosLogs: [] })
      get().toast('开始安装混沌引擎…', 'info')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async pullChaosModel(model) {
    try {
      const res = await api.chaosPull(model)
      set({ chaosJob: res.data, chaosLogs: [] })
      get().toast(`开始下载模型 ${model}…`, 'info')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  async cancelChaosJob() {
    const job = get().chaosJob
    if (!job) return
    try {
      await api.chaosCancel(job.id)
      get().toast('已请求取消', 'info')
    } catch (err) {
      get().toast(err.message, 'error')
    }
  },

  /* ---- Watt Toolkit 提示 ---- */
  openWattPrompt() {
    set({ wattPromptOpen: true })
  },

  closeWattPrompt() {
    set({ wattPromptOpen: false })
  },

  snoozeWattPrompt() {
    saveUiPrefs({ wattSnoozedUntil: Date.now() + 6 * 3600 * 1000 })
    set({ wattPromptOpen: false })
  },

  dismissWattPrompt() {
    saveUiPrefs({ wattDismissed: true, wattSnoozedUntil: 0 })
    set({ wattPromptOpen: false })
  },

  maybeShowWattPrompt() {
    const prefs = loadUiPrefs()
    if (prefs.wattDismissed) return
    if (prefs.wattSnoozedUntil && prefs.wattSnoozedUntil > Date.now()) return
    set({ wattPromptOpen: true })
  },

  resetWattPrompt() {
    saveUiPrefs({ wattDismissed: false, wattSnoozedUntil: 0 })
    get().toast('已重置 Watt Toolkit 提醒', 'success')
  },
}))

/** 浏览器里触发文件下载（导出的 JSON / 诊断包） */
function downloadBlob(blob, filename) {
  try {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename || 'chaos-export.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 2000)
  } catch (err) {
    console.error('[download] 失败:', err.message)
  }
}

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
      // 9.3.8：授权码已关 —— token 被拒就静默补一张新票重连，不踢回登录页
      ;(async () => {
        try {
          const r = await api.login('')
          setToken(r.token)
          useStore.setState({ token: r.token, authed: true })
          scheduleReconnect()
        } catch (_) {
          setToken(null)
          useStore.setState({ authed: false, token: null, loginError: '' })
        }
      })()
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

/* 9.5.3：原始处理器。外面包了一层 try/catch（见 handleServerMessage），
   一条坏消息最多丢一条事件，绝不许把整个应用炸成白屏。 */
function handleServerMessageRaw(msg) {
  const { type, payload } = msg
  const state = useStore.getState()

  switch (type) {
    case 'hello':
      break

    case 'snapshot':
      // 9.5.3：快照异常（payload 非对象 / 字段缺失或非数组）时保留现有数组，
      // 绝不让 undefined/对象混进 agents/tasks —— 否则下一步的 .map 直接白屏
      useStore.setState({
        agents: Array.isArray(payload?.agents) ? payload.agents : state.agents,
        tasks: Array.isArray(payload?.tasks) ? payload.tasks : state.tasks,
      })
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
        if (Array.isArray(state.detail.messages) && !state.detail.messages.some((m) => m.id === payload.id)) {
          useStore.setState({ detail: { ...state.detail, messages: [...state.detail.messages, payload] } })
        }
      }
      break

    case 'event:added':
      if (state.detail && state.detail.task.id === payload.taskId) {
        if (Array.isArray(state.detail.events) && !state.detail.events.some((e) => e.id === payload.id)) {
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

    /* ---- 8.0.0 ---- */
    case 'template:updated': {
      const list = state.templates.some((t) => t.id === payload.id)
        ? state.templates.map((t) => (t.id === payload.id ? payload : t))
        : [payload, ...state.templates]
      useStore.setState({ templates: list })
      break
    }

    case 'template:deleted':
      useStore.setState({ templates: state.templates.filter((t) => t.id !== payload.id) })
      break

    case 'workspace:imported':
      useStore.setState({
        agents: asArr(payload?.agents),
        tasks: asArr(payload?.tasks),
        selectedTaskIds: [],
        selectedTaskId: null,
        detail: null,
      })
      break

    case 'toolchain:job': {
      useStore.setState({ toolchainJob: payload })
      if (payload?.status === 'done' || payload?.status === 'error' || payload?.status === 'cancelled') {
        useStore.getState().loadToolchain()
        useStore.getState().refreshSystem()
      }
      break
    }

    case 'toolchain:log': {
      if (!payload) break
      const logs = [...state.toolchainLogs, payload]
      if (logs.length > 500) logs.splice(0, logs.length - 500)
      useStore.setState({ toolchainLogs: logs })
      break
    }

    case 'toolchain:changed':
      useStore.getState().loadToolchain()
      useStore.getState().refreshSystem()
      break

    /* ---- 混沌 · 本地大模型 ---- */
    case 'chaos:job': {
      useStore.setState({ chaosJob: payload })
      if (payload?.status === 'done' || payload?.status === 'error' || payload?.status === 'cancelled') {
        useStore.getState().loadChaosStatus()
        useStore.getState().refreshSystem()
        if (payload.status === 'done') {
          useStore.getState().toast(payload.message || '混沌已就绪', 'success')
        } else if (payload.status === 'error') {
          useStore.getState().toast(payload.error || '混沌安装失败', 'error')
        }
      }
      break
    }

    case 'chaos:log': {
      if (!payload) break
      const logs = [...state.chaosLogs, payload]
      if (logs.length > 500) logs.splice(0, logs.length - 500)
      useStore.setState({ chaosLogs: logs })
      break
    }

    case 'chaos:changed':
      // 8.0.2：记忆/自动化被别处（比如自动化自己开跑了新对话）改动时保持同步
      useStore.getState().loadChaosMemory()
      useStore.getState().loadChaosAutomations()
      // 9.8.0：开机自动就绪 / 兑换码 / 绑定手机号都会推这个事件，顺手刷引擎状态
      useStore.getState().loadChaosStatus()
      if (payload?.reason === 'automation-fired') {
        useStore.getState().refreshConversations()
        useStore.getState().toast(`定时自动化「${payload.name || ''}」已自动开跑`, 'info')
      }
      break

    case 'kb:changed':
      // 知识库数据由 KnowledgeModal 自行拉取，这里只刷新系统摘要里的计数
      useStore.getState().refreshSystem()
      break

    default:
      // 新事件忘了接会静默丢失，开发时至少留个痕迹
      if (typeof console !== 'undefined') console.debug('[ws] 未处理事件:', type)
      break
  }
}

/* 9.5.3：数组兜底层。无论哪条路径（HTTP 响应 / WS 消息 / 未来新代码）往
   agents / tasks / conversations / templates / selectedTaskIds 写入非数组，
   都在这里被夹回数组 —— 这是 `c.map is not a function` 白屏的最后一道闸。
   函数式 updater 也会被拦截处理。注意 snapshot 分支在写入前就保留了旧数组，
   这层只兜「漏网之鱼」，把它夹成 [] 而不是让它崩掉渲染。 */
const ARRAY_STATE_KEYS = ['agents', 'tasks', 'conversations', 'templates', 'selectedTaskIds']
const __rawSetState = useStore.setState
useStore.setState = function guardedSetState(partial, replace) {
  try {
    if (typeof partial === 'function') {
      return __rawSetState((state) => {
        const next = partial(state)
        for (const k of ARRAY_STATE_KEYS) {
          if (next && k in next && !Array.isArray(next[k])) next[k] = asArr(next[k])
        }
        return next
      }, replace)
    }
    if (partial && typeof partial === 'object') {
      const patched = { ...partial }
      for (const k of ARRAY_STATE_KEYS) {
        if (k in patched && !Array.isArray(patched[k])) patched[k] = asArr(patched[k])
      }
      return __rawSetState(patched, replace)
    }
  } catch (_) {
    /* 归一化自身出错时不吞掉真正的 setState：退回原始实现 */
  }
  return __rawSetState(partial, replace)
}

/* 9.5.3：WS 消息处理防炸层 —— 任何一条消息处理抛错都只记日志，不冒泡成
   未捕获异常（onmessage 里的异常不会显示在错误浮层里，但会中断后续消息，
   并可能在渲染中途留下被写坏的 state 导致白屏）。 */
function handleServerMessage(msg) {
  try {
    handleServerMessageRaw(msg)
  } catch (err) {
    if (typeof console !== 'undefined') console.error('[ws] 消息处理失败（已忽略）:', err)
  }
}

/* 模块加载时就挂上系统主题监听 —— 「跟随系统」是默认值，而且用户可能在应用运行
   期间改 Windows 的深浅色。DOM 上那份由 public/theme-boot.js 设过初值了，
   这里只让 React 侧的 resolvedTheme 跟上。 */
rewatchTheme()

export { connectSocket, closeSocket }
