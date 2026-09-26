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
const patch = (p, b) => request('PATCH', p, b ?? {})
const del = (p) => request('DELETE', p)

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

  setPermissionMode: (permissionMode) => post('/api/settings', { permissionMode }),
  setSettings: (patch) => post('/api/settings', patch),
  checkUpdate: () => post('/api/update/check'),
  downloadUpdate: () => post('/api/update/download'),
  installUpdate: () => post('/api/update/install'),
  updateStatus: () => get('/api/update/status'),

  // 执行器与模型
  executors: () => get('/api/executors'),

  // 对话（一个对话 = 一个任务）
  conversations: () => get('/api/conversations'),
  chat: (payload) => post('/api/chat', payload),

  // 任务批量
  clearAllTasks: () => post('/api/tasks/clear'),

  // MCP
  mcp: () => get('/api/mcp'),
  mcpEnable: (id, opts) => post('/api/mcp/enable', { id, ...(opts || {}) }),
  mcpDisable: (id) => post('/api/mcp/disable', { id }),
}
