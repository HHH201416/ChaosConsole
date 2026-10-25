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

/** 下载文件（导出 JSON / 诊断包）。返回 { blob, filename } */
async function download(path) {
  const headers = {}
  if (TOKEN) headers['x-chaos-token'] = TOKEN
  const res = await fetch(path, { headers })
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`)
  const disposition = res.headers.get('content-disposition') || ''
  const m = disposition.match(/filename=\"?([^\";]+)\"?/i)
  return { blob: await res.blob(), filename: m ? m[1] : 'chaos-export.json' }
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
  deleteKbDoc: (id, docId) => del(`/api/kb/${id}/docs/${docId}`),
  exportKb: (id, format) => download(`/api/kb/${id}/export?format=${format || 'json'}`),
  importKb: (data) => post('/api/kb/import', data),
  kbSearch: (query, opts) => post('/api/kb/search', { query, ...(opts || {}) }),

  // 混沌 · 本地大模型
  chaosStatus: () => get('/api/chaos/status'),
  chaosInstall: () => post('/api/chaos/install', { consent: true }),
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
  // 9.3.8：全部岗位一键切混沌 + 工作区预览（文件 / 知识库侧栏）
  chaosSwitchAllAgents: () => post('/api/agents/migrate-chaos'),
  // 9.5.4：AIPPT（主题 + 页数 + 语气 → 本地 .pptx）
  aipptList: () => get('/api/aippt/list'),
  aipptGenerate: (payload) => post('/api/aippt/generate', payload),
  // 9.6.1：改完大纲直接重渲染 / 读回大纲 / 删除产物
  aipptRender: (payload) => post('/api/aippt/render', payload),
  aipptOutline: (id) => get(`/api/aippt/outline?id=${encodeURIComponent(id)}`),
  aipptDelete: (id) => del(`/api/aippt/file?id=${encodeURIComponent(id)}`),
  workspaceTree: (root) => get(`/api/workspace/tree?root=${encodeURIComponent(root)}`),
  workspaceFile: (root, p) => get(`/api/workspace/file?root=${encodeURIComponent(root)}&path=${encodeURIComponent(p)}`),
  // 9.3.8：安全 —— 本地锁屏解锁校验
  unlock: (pin) => post('/api/unlock', { pin }),
  // 8.0.2：对话重新生成 / 分支 / 时光机
  regenerateTask: (id) => post(`/api/tasks/${id}/regenerate`),
  branchTask: (id) => post(`/api/tasks/${id}/branch`),
  rollbackTask: (id, keep) => post(`/api/tasks/${id}/rollback`, { keep }),
}
