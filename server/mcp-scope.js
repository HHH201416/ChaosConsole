'use strict'

/**
 * 按岗位挂载 MCP。
 *
 * 为什么要有这个模块：mcp.js 管的是「这台机器上装了/注册了哪些 MCP」（全局开关板），
 * 而每个岗位该拿哪几个工具是**每次运行**的事 —— 全挂上会挤占上下文、拖慢每个会话
 * （playwright / chrome-devtools 还会各起一个真浏览器）。
 *
 * 两条执行器各走各的路：
 *   claude  ── 每次运行写一份临时配置，启动带 `--mcp-config <file> --strict-mcp-config`
 *   deveco  ── 走 `DEVECO_CONFIG_CONTENT` 内联覆盖（**实测过**：它按 key 合并，
 *              `{"enabled":false}` 能逐项关掉，见 scripts/regress.js 的相关断言）
 *
 * 「哪些服务器可用」一律以**已经注册在 CLI 配置里的定义**为准（过滤 chaos-*），
 * 不从 CATALOG 重新拼 —— 这样用户在面板里填的密钥、允许目录会原样带上。
 *
 * 任何一步出问题都必须**降级成「不按岗位挂」**，绝不能把一次运行搞坏：
 * 最坏情况是 agent 多拿到几个工具，而不是一个都没有。
 */

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const mcp = require('./mcp')
const store = require('./store')
const runtime = require('./runtime')
const { DEFAULT_AGENTS } = require('./seed')

const RUN_DIR = path.join(mcp.MCP_DIR, 'run')
const HANDOFF_ID = 'handoff'

/** 岗位没配也没有 seed 默认时的兜底：读写文件 + 结构化推理，代价都很低 */
const FALLBACK_MCP = ['filesystem', 'sequential-thinking']

function scopeEnabled() {
  return store.getSetting('mcpScopeEnabled', '1') === '1'
}

function strictMode() {
  return store.getSetting('mcpStrict', '1') === '1'
}

function handoffToolEnabled() {
  return store.getSetting('mcpHandoffTool', '1') === '1'
}

/**
 * 岗位 -> 该挂的 catalog id 列表。
 * 顺序：岗位自己配的 > seed 里该 role 的默认 > 兜底。
 * handoff 是应用内部的「换岗」工具，默认总是带上（可以通过设置关掉）。
 */
function resolveRoleMcp(agent) {
  const explicit = Array.isArray(agent && agent.mcp) ? agent.mcp : []
  const seedAgent = DEFAULT_AGENTS.find((a) => a.role === (agent && agent.role))
  const fromSeed = seedAgent && Array.isArray(seedAgent.mcp) ? seedAgent.mcp : []
  const base = explicit.length ? explicit : fromSeed.length ? fromSeed : FALLBACK_MCP
  const list = [...base]
  if (handoffToolEnabled()) list.push(HANDOFF_ID)
  return [...new Set(list)]
}

function runFilePath(taskId) {
  const safe = String(taskId || 'unknown').replace(/[^\w.-]/g, '_')
  return path.join(RUN_DIR, `${safe}.json`)
}

/**
 * claude 的 --mcp-config 能不能用（老版本没有这两个参数）。
 * 按**可执行文件路径**缓存：启动一次 --help 就够慢的了，而按路径缓存能让
 * 「不同 bin 的结论不同」这一点自然成立（回归用例要同时验「支持」和「不支持」两条路）。
 */
const flagSupportCache = new Map()

function claudeSupportsMcpConfig(claudeBin) {
  if (!claudeBin) return false
  if (flagSupportCache.has(claudeBin)) return flagSupportCache.get(claudeBin)
  let supported = false
  try {
    const r = spawnSync(claudeBin, ['--help'], {
      encoding: 'utf8',
      timeout: 15000,
      shell: process.platform === 'win32',
    })
    const text = `${r.stdout || ''}${r.stderr || ''}`
    supported = text.includes('--mcp-config')
  } catch (_) {
    supported = false
  }
  flagSupportCache.set(claudeBin, supported)
  return supported
}

/** 内部「换岗」服务器的 stdio 定义（带本次任务的一次性令牌） */
function handoffServerDef(task, token) {
  return {
    type: 'stdio',
    command: mcp.resolveNodeBin(),
    args: [mcp.stableLocalEntry(HANDOFF_ID)],
    env: {
      ...mcp.nodeLaunchEnv(),
      CHAOS_SERVER_URL: runtime.baseUrl(),
      CHAOS_TASK_ID: task.id,
      CHAOS_HANDOFF_TOKEN: token || '',
    },
  }
}

/**
 * 写本次运行的 claude MCP 配置。返回文件路径；返回 null 表示这次不按岗位挂
 * （老版本 claude / 总闸关掉 / 一个可用定义都没有）。
 */
function buildClaudeConfig(task, agent, { token = '', claudeBin = '' } = {}) {
  if (!scopeEnabled()) return null
  if (!claudeSupportsMcpConfig(claudeBin)) return null

  const registered = mcp.claudeMcpServers() // { 'chaos-filesystem': {type,command,args,env}, ... }
  const servers = {}
  for (const id of resolveRoleMcp(agent)) {
    if (id === HANDOFF_ID) {
      if (token) servers['chaos-handoff'] = handoffServerDef(task, token)
      continue
    }
    const def = registered[`chaos-${id}`]
    if (def) servers[`chaos-${id}`] = def
  }
  if (!Object.keys(servers).length) return null

  try {
    fs.mkdirSync(RUN_DIR, { recursive: true })
    const file = runFilePath(task.id)
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }, null, 2))
    return file
  } catch (err) {
    console.error('[mcp-scope] 写运行期 MCP 配置失败:', err.message)
    return null
  }
}

/**
 * deveco 的内联覆盖：角色要的服务器给全量定义 + enabled:true，
 * **其余已注册的显式 {enabled:false}** —— 不写 false 的话全局注册的那几个
 * 会跟着一起生效，等于没按岗位挂。
 */
function buildDevecoEnv(task, agent, { token = '' } = {}) {
  if (!scopeEnabled()) return {}
  const registered = mcp.devecoMcpMap() // { 'chaos-memory': {type:'local', command:[...], enabled:true}, ... }
  const wanted = new Set(resolveRoleMcp(agent))
  const out = {}
  for (const [name, def] of Object.entries(registered)) {
    const id = name.replace(/^chaos-/, '')
    if (wanted.has(id)) out[name] = { ...def, enabled: true }
    else out[name] = { enabled: false }
  }
  if (wanted.has(HANDOFF_ID) && token) {
    out['chaos-handoff'] = {
      type: 'local',
      command: [mcp.resolveNodeBin(), mcp.stableLocalEntry(HANDOFF_ID)],
      enabled: true,
      environment: {
        ...mcp.nodeLaunchEnv(),
        CHAOS_SERVER_URL: runtime.baseUrl(),
        CHAOS_TASK_ID: task.id,
        CHAOS_HANDOFF_TOKEN: token,
      },
    }
  }
  try {
    return { DEVECO_CONFIG_CONTENT: JSON.stringify({ mcp: out }) }
  } catch (err) {
    console.error('[mcp-scope] 序列化 deveco MCP 覆盖失败:', err.message)
    return {}
  }
}

/** 运行结束后删掉该任务的临时配置（进程被杀 / 崩溃时留下的由 cleanupRunFiles 兜底） */
function removeRunFile(taskId) {
  try {
    const file = runFilePath(taskId)
    if (fs.existsSync(file)) fs.unlinkSync(file)
  } catch (_) {
    /* 删不掉就算了，cleanupRunFiles 会兜底 */
  }
}

/** 启动时清理过期的运行期配置（上次崩溃会留下） */
function cleanupRunFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(RUN_DIR)) return 0
    const now = Date.now()
    let removed = 0
    for (const name of fs.readdirSync(RUN_DIR)) {
      const full = path.join(RUN_DIR, name)
      try {
        if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
          fs.unlinkSync(full)
          removed++
        }
      } catch (_) {
        /* 单个文件删不掉不影响整体 */
      }
    }
    return removed
  } catch (_) {
    return 0
  }
}

module.exports = {
  RUN_DIR,
  HANDOFF_ID,
  FALLBACK_MCP,
  scopeEnabled,
  strictMode,
  handoffToolEnabled,
  resolveRoleMcp,
  buildClaudeConfig,
  buildDevecoEnv,
  removeRunFile,
  cleanupRunFiles,
  claudeSupportsMcpConfig,
  runFilePath,
}
