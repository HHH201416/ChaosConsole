/**
 * REST 客户端。
 *
 * 路径一律用相对地址：开发时由 Vite 把 /api 代理到 43117，打包后页面本身
 * 就是由 43117 托管的，两种环境同一套代码。
 */

let TOKEN = null
const STORAGE_KEY = 'chaos.token'

export function setToken(token) {
  TOKEN = token
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token)
    else localStorage.removeItem(STORAGE_KEY)
  } catch (_) {
    /* 隐私模式下 localStorage 会抛，忽略即可 */
  }
}

export function loadToken() {
  try {
    TOKEN = localStorage.getItem(STORAGE_KEY)
  } catch (_) {
    TOKEN = null
  }
  return TOKEN
}

export function getToken() {
  return TOKEN
}

/* 9.8.2：混沌速答流式（SSE）—— 逐字回调，返回最终完整结果 */
export async function chaosQuickStream(prompt, { model = '', onDelta = null, signal } = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (TOKEN) headers['x-chaos-token'] = TOKEN
  let res
  try {
    res = await fetch('/api/chaos/quick-stream', {
      method: 'POST',
      headers,
      body: JSON.stringify({ prompt, model }),
      signal,
    })
  } catch (_) {
    throw new Error('无法连接后端服务')
  }
  if (!res.ok || !res.body) {
    let msg = `请求失败（HTTP ${res.status}）`
    try {
      const j = await res.json()
      msg = j?.error || msg
    } catch (_) {
      /* ignore */
    }
    throw new Error(msg)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let final = null
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      const line = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!line) continue
      let ev
      try {
        ev = JSON.parse(line.slice(6))
      } catch (_) {
        continue
      }
      if (ev.type === 'delta' && onDelta) onDelta(ev.delta)
      else if (ev.type === 'done') final = ev.data
      else if (ev.type === 'error') throw new Error(ev.error)
    }
  }
  if (!final) throw new Error('混沌返回了空回复')
  return final
}

async function request(method, path, body) {
  const headers = {}
  if (TOKEN) headers['x-chaos-token'] = TOKEN
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  let res
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (err) {
    throw new Error(`无法连接后端服务：${err.message}`)
  }

  let json = null
  try {
    json = await res.json()
  } catch (_) {
    throw new Error(`服务端返回了非 JSON 响应（HTTP ${res.status}）`)
  }

  if (!res.ok) {
    const err = new Error(json?.error || `请求失败（HTTP ${res.status}）`)
    err.status = res.status
    throw err
  }
  return json
}

const get = (p) => request('GET', p)
const post = (p, b) => request('POST', p, b ?? {})
const put = (p, b) => request('PUT', p, b ?? {})
const patch = (p, b) => request('PATCH', p, b ?? {})
const del = (p) => request('DELETE', p)

/** 下载文件（导出 JSON / 诊断包）。返回 { blob, filename } */async function download(path) {
  const headers = {}
  if (TOKEN) headers['x-chaos-token'] = TOKEN
  const res = await fetch(path, { headers })
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
  const disposition = res.headers.get('content-disposition') || ''
  const m = disposition.match(/filename=\"?([^\";]+)\"?/i)
  return { blob: await res.blob(), filename: m ? m[1] : 'chaos-export.json' }
}

/**
 * 9.8.0：SSE 流式请求（AIPPT 用）。
 * onEvent(ev) 逐条回调；signal 用来中途取消。
 * 返回 { ok, error } —— 出错不抛，交给调用方决定怎么提示。
 */
export async function streamPost(path, body, onEvent, signal) {
  const headers = { 'Content-Type': 'application/json' }
  if (TOKEN) headers['x-chaos-token'] = TOKEN

  let res
  try {
    res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body ?? {}), signal })
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, aborted: true }
    return { ok: false, error: `无法连接后端服务：${err.message}` }
  }

  if (!res.ok || !res.body) {
    let detail = ''
    try {
      const j = await res.json()
      detail = String(j?.error || '')
    } catch (_) {
      /* ignore */
    }
    return { ok: false, error: detail || `请求失败（HTTP ${res.status}）` }
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result = null
  let failure = ''

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let cut
      while ((cut = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, cut)
        buf = buf.slice(cut + 2)
        for (const line of chunk.split('\n')) {
          if (!line.startsWith('data:')) continue
          const raw = line.slice(5).trim()
          if (!raw) continue
          let ev = null
          try {
            ev = JSON.parse(raw)
          } catch (_) {
            continue
          }
          if (ev.type === 'done') result = ev.result
          if (ev.type === 'error') failure = ev.error || '生成失败'
          try {
            onEvent(ev)
          } catch (_) {
            /* 渲染回调异常不该打断流 */
          }
        }
      }
    }
  } catch (err) {
    if (err?.name === 'AbortError') return { ok: false, aborted: true }
    return { ok: false, error: `读取生成流失败：${err.message}` }
  }

  if (failure) return { ok: false, error: failure }
  if (!result) return { ok: false, error: '生成流意外结束，没有拿到成品' }
  return { ok: true, result }
}

export const api = {
  login: (code) => post('/api/login', { code }),
  system: () => get('/api/system'),
  state: () => get('/api/state'),

  createAgent: (data) => post('/api/agents', data),
  updateAgent: (id, data) => patch(`/api/agents/${id}`, data),
  deleteAgent: (id) => del(`/api/agents/${id}`),

  createTask: (data) => post('/api/tasks', data),
  updateTask: (id, data) => patch(`/api/tasks/${id}`, data),
  deleteTask: (id) => del(`/api/tasks/${id}`),
  getTask: (id) => get(`/api/tasks/${id}`),

  start: (id) => post(`/api/tasks/${id}/start`),
  cancel: (id) => post(`/api/tasks/${id}/cancel`),
  done: (id) => post(`/api/tasks/${id}/done`),
  input: (id, text) => post(`/api/tasks/${id}/input`, { text }),
  move: (id, status) => post(`/api/tasks/${id}/move`, { status }),
  assign: (id, agentId) => post(`/api/tasks/${id}/assign`, { agentId }),
  clearHistory: (id) => post(`/api/tasks/${id}/history/clear`),
  // 换岗（运行中会交接，不是取消）；停止/恢复自动换岗重试
  handoff: (id, body) => post(`/api/tasks/${id}/handoff`, body),
  setRetry: (id, enabled) => post(`/api/tasks/${id}/retry`, { enabled }),
  pipeline: () => get('/api/pipeline'),

  setPermissionMode: (permissionMode) => post('/api/settings', { permissionMode }),
  setSettings: (patch) => post('/api/settings', patch),
  checkUpdate: () => post('/api/update/check'),
  downloadUpdate: () => post('/api/update/download'),
  installUpdate: () => post('/api/update/install'),
  updateStatus: () => get('/api/update/status'),
  releases: () => get('/api/update/releases'),
  rollback: (tag) => post('/api/update/rollback', { tag }),

  // 执行器与模型
  executors: () => get('/api/executors'),

  // 对话（一个对话 = 一个任务）
  conversations: () => get('/api/conversations'),
  chat: (payload) => post('/api/chat', payload),

  // 任务批量
  clearAllTasks: () => post('/api/tasks/clear'),
  batch: (action, ids, payload) => post('/api/tasks/batch', { action, ids, payload }),
  search: (q) => get(`/api/search?q=${encodeURIComponent(q)}`),

  // 8.0.0：任务模板
  templates: () => get('/api/templates'),
  createTemplate: (data) => post('/api/templates', data),
  updateTemplate: (id, data) => patch(`/api/templates/${id}`, data),
  deleteTemplate: (id) => del(`/api/templates/${id}`),

  // 8.0.0：备份 / 工作区 / 统计 / 诊断 / 工具链
  backups: () => get('/api/backups'),
  createBackup: () => post('/api/backups'),
  restoreBackup: (name) => post(`/api/backups/${encodeURIComponent(name)}/restore`),
  deleteBackup: (name) => del(`/api/backups/${encodeURIComponent(name)}`),
  exportWorkspace: () => download('/api/workspace/export'),
  importWorkspace: (data) => post('/api/workspace/import', data),
  stats: (days) => get(`/api/stats?days=${encodeURIComponent(days || '30')}`),
  diagnostics: () => get('/api/diagnostics'),
  exportDiagnostics: () => download('/api/diagnostics/export'),
  toolchain: () => get('/api/toolchain'),
  installTool: (tool) => post('/api/toolchain/install', { tool, consent: true }),
  cancelToolInstall: (jobId) => post('/api/toolchain/cancel', { jobId }),
  refreshToolchain: () => post('/api/toolchain/refresh'),

  // MCP
  mcp: () => get('/api/mcp'),
  mcpEnable: (id, opts) => post('/api/mcp/enable', { id, ...(opts || {}) }),
  mcpDisable: (id) => post('/api/mcp/disable', { id }),

  // 知识库
  kb: () => get('/api/kb'),
  createKb: (data) => post('/api/kb', data),
  updateKb: (id, data) => patch(`/api/kb/${id}`, data),
  deleteKb: (id) => del(`/api/kb/${id}`),
  kbDocs: (id) => get(`/api/kb/${id}/docs`),
  addKbDoc: (id, data) => post(`/api/kb/${id}/docs`, data),
  // 9.8.0：应用内编辑文档
  updateKbDoc: (id, docId, data) => patch(`/api/kb/${id}/docs/${docId}`, data),
  deleteKbDoc: (id, docId) => del(`/api/kb/${id}/docs/${docId}`),
  exportKb: (id, format) => download(`/api/kb/${id}/export?format=${format || 'json'}`),
  importKb: (data) => post('/api/kb/import', data),
  kbSearch: (query, opts) => post('/api/kb/search', { query, ...(opts || {}) }),

  // 混沌 · 本地大模型
  chaosStatus: () => get('/api/chaos/status'),
  chaosInstall: () => post('/api/chaos/install', { consent: true }),
  chaosUninstall: (deleteModels) => post('/api/chaos/uninstall', { consent: true, deleteModels: !!deleteModels }),
  chaosSetDefaultModel: (model) => post('/api/chaos/default-model', { model }),
  chaosPull: (model) => post('/api/chaos/pull', { model }),
  chaosCancel: (jobId) => post('/api/chaos/cancel', { jobId }),
  chaosGuideDone: () => post('/api/chaos/guide-done'),
  // 8.0.2：混沌轻量能力
  chaosQuick: (prompt, model) => post('/api/chaos/quick', { prompt, model }),
  chaosRewrite: (text) => post('/api/chaos/rewrite', { text }),
  chaosArena: (text, models) => post('/api/chaos/arena', { text, models }),
  chaosExpert: (id) => post('/api/chaos/expert', { id }),
  chaosMemory: () => get('/api/chaos/memory'),
  chaosMemorySet: (items) => put('/api/chaos/memory', { items }),
  chaosAutomations: () => get('/api/chaos/automations'),
  chaosAutomationUpsert: (a) => post('/api/chaos/automations', a),
  chaosAutomationDelete: (id) => del(`/api/chaos/automations/${id}`),
  // 8.0.2：Token 额度（每日 3000 万免费；9.5.4 起填手机号绑定激活）
  chaosQuota: () => get('/api/chaos/quota'),
  chaosBindPhone: (phone) => post('/api/chaos/phone', { phone }),
  // 9.8.0：兑换码（手机号下方那一格，可选）
  chaosRedeem: (code) => post('/api/chaos/redeem', { code }),
  // 9.3.8：全部岗位一键切混沌 + 工作区预览（文件 / 知识库侧栏）
  chaosSwitchAllAgents: () => post('/api/agents/migrate-chaos'),
  // 9.5.4：AIPPT（主题 + 页数 + 语气 → 本地 .pptx）
  aipptList: () => get('/api/aippt/list'),
  aipptGenerate: (payload) => post('/api/aippt/generate', payload),
  // 9.8.0：流式生成走 streamPost（导出函数），不走 api 对象
  aipptImageUrl: (name) => `/api/aippt/image?name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken() || '')}`,
  // 9.6.1：改完大纲直接重渲染 / 读回大纲 / 删除产物
  aipptRender: (payload) => post('/api/aippt/render', payload),
  aipptOutline: (id) => get(`/api/aippt/outline?id=${encodeURIComponent(id)}`),
  aipptDelete: (id) => del(`/api/aippt/file?id=${encodeURIComponent(id)}`),
  // 9.8.2：配图来源（联网找真实照片需要 Pexels Key）
  aipptImageSource: () => get('/api/aippt/image-source'),
  aipptSetImageKey: (key) => post('/api/aippt/image-source', { key }),
  // 9.8.2：独立绘图（高质量单图）
  imageGenerate: (payload) => post('/api/image/generate', payload),
  imageList: () => get('/api/image/list'),
  imageUrl: (name) => `/api/image/file?name=${encodeURIComponent(name)}&token=${encodeURIComponent(getToken() || '')}`,
  workspaceTree: (root) => get(`/api/workspace/tree?root=${encodeURIComponent(root)}`),
  workspaceFile: (root, p) => get(`/api/workspace/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`),
  // 9.3.8：安全 —— 本地锁屏解锁校验
  unlock: (pin) => post('/api/unlock', { pin }),
  // 8.0.2：对话重新生成 / 分支 / 时光机
  regenerateTask: (id) => post(`/api/tasks/${id}/regenerate`),
  branchTask: (id) => post(`/api/tasks/${id}/branch`),
  rollbackTask: (id, keep) => post(`/api/tasks/${id}/rollback`, { keep }),
}
