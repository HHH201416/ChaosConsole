'use strict'

/**
 * Agent 执行器：用 child_process.spawn 拉起 CLI，实时解析它的事件流，
 * 把文本增量、工具调用、工具结果分别落成「对话记录」和「事件列表」，
 * 并通过事件总线推给前端。
 *
 * 支持两种执行器，接口与事件格式完全不同：
 *
 *   claude  —— claude -p --output-format stream-json --verbose
 *              事件：{"type":"assistant"|"user"|"system"|"result", ...}
 *              续跑：--resume <session_id>
 *
 *   deveco  —— deveco run --format json
 *              事件：{"type":"step_start"|"text"|"tool_use"|"step_finish",
 *                     "sessionID":"ses_...", "part":{...}}
 *              续跑：-s <sessionID>
 *
 * 三个刻意的工程决定：
 *
 * 1. 提示词一律走 stdin，不走 argv。
 *    Windows 上 claude / deveco 都是 .cmd，必须经 cmd.exe 转发，而 cmd 的引号
 *    和反斜杠转义极易把中文、换行、Windows 路径撕碎。把可变内容全塞进 stdin、
 *    让 argv 只剩静态 ASCII 参数，可以彻底绕开这个问题。
 *    （两者都已实测能从 stdin 读取提示词。）
 *
 * 2. CLI 不存在时自动降级为模拟执行。
 *    没装 CLI 的机器上，看板和对话页仍然是可跑通、可演示的。
 *
 * 3. 事件解析与进程管理分离。
 *    解析器只吐「文本/工具/结果」，进程管理只负责超时、取消、收尾，
 *    加第三个执行器时不用动调度逻辑。
 */

const { spawn } = require('child_process')
const readline = require('readline')
const fs = require('fs')
const path = require('path')
const os = require('os')
const CONFIG = require('./config')
const store = require('./store')
const executors = require('./executors')

const MAX_EVENT_CHARS = 6000
const MAX_STDERR_CHARS = 4000

/** taskId -> child process | mock controller */
const running = new Map()

/* ------------------------------------------------------------------ *
 * 可执行文件探测
 * ------------------------------------------------------------------ */

let cachedClaudeBin = null

function resolveClaudeBin() {
  if (cachedClaudeBin !== null) return cachedClaudeBin

  if (CONFIG.CLAUDE_BIN && fs.existsSync(CONFIG.CLAUDE_BIN)) {
    cachedClaudeBin = CONFIG.CLAUDE_BIN
    return cachedClaudeBin
  }

  const isWin = process.platform === 'win32'
  const names = isWin ? ['claude.cmd', 'claude.exe', 'claude'] : ['claude']

  const dirs = []
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'claude'))
  dirs.push(path.join(os.homedir(), '.local', 'bin'))
  dirs.push(path.join(os.homedir(), '.claude', 'local'))
  dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  if (process.env.PATH) dirs.push(...process.env.PATH.split(path.delimiter))

  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          cachedClaudeBin = candidate
          return cachedClaudeBin
        }
      } catch (_) {
        /* ignore */
      }
    }
  }

  cachedClaudeBin = '' // 空字符串 = 找不到，走模拟
  return cachedClaudeBin
}

function setClaudeBin(bin) {
  cachedClaudeBin = bin || null
}

function claudeAvailable() {
  return Boolean(resolveClaudeBin())
}

/* ------------------------------------------------------------------ *
 * 通用工具
 * ------------------------------------------------------------------ */

function clip(text, max = MAX_EVENT_CHARS) {
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2)
  if (!s) return ''
  return s.length > max ? s.slice(0, max) + `\n…（已截断，共 ${s.length} 字符）` : s
}

/** 把工具调用参数压成一行可读摘要 */
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return ''
  const pick = (...keys) => {
    for (const k of keys) {
      if (input[k] !== undefined && input[k] !== null && String(input[k]).trim() !== '') return String(input[k])
    }
    return ''
  }

  let out = ''
  switch (String(name).toLowerCase()) {
    case 'bash':
    case 'shell':
    case 'bashoutput':
      out = pick('command', 'cmd')
      break
    case 'read':
      out = pick('filePath', 'file_path', 'path')
      break
    case 'write':
      out = pick('filePath', 'file_path', 'path')
      break
    case 'edit':
    case 'multiedit':
    case 'patch':
      out = pick('filePath', 'file_path', 'path')
      break
    case 'glob':
    case 'list':
      out = pick('pattern', 'path')
      break
    case 'grep':
      out = pick('pattern')
      break
    case 'webfetch':
    case 'fetch':
      out = pick('url')
      break
    case 'websearch':
    case 'search':
      out = pick('query')
      break
    case 'task':
    case 'agent':
      out = pick('description', 'prompt')
      break
    case 'todowrite':
    case 'todoread':
      out = '更新任务清单'
      break
    default:
      out = ''
  }
  if (!out) out = JSON.stringify(input)
  return out.length > 800 ? out.slice(0, 800) + '…' : out
}

/** 把内部小写工具名映射成界面上更好认的名字 */
const TOOL_DISPLAY = {
  bash: 'Bash',
  shell: 'Bash',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  multiedit: 'MultiEdit',
  patch: 'Patch',
  glob: 'Glob',
  grep: 'Grep',
  list: 'List',
  webfetch: 'WebFetch',
  fetch: 'Fetch',
  websearch: 'WebSearch',
  task: 'Task',
  todowrite: 'TodoWrite',
  todoread: 'TodoRead',
}

function displayToolName(raw) {
  const key = String(raw || '').toLowerCase()
  return TOOL_DISPLAY[key] || raw || 'Tool'
}

/* ------------------------------------------------------------------ *
 * 提示词组装
 * ------------------------------------------------------------------ */

function composePrompt({ systemPrompt, task, extraInstruction, isResume }) {
  const parts = []
  if (systemPrompt && !isResume) {
    parts.push(systemPrompt.trim())
    parts.push('\n---\n')
  }
  if (extraInstruction) {
    // 续跑回合：只发补充指令，上下文由会话自己维持
    parts.push(extraInstruction.trim())
    return parts.join('\n')
  }
  parts.push(`# 任务\n${task.title}`)
  if (task.description && task.description.trim()) {
    parts.push(`\n## 详细说明\n${task.description.trim()}`)
  }
  parts.push(`\n## 工作目录\n${task.cwd || CONFIG.DEFAULT_CWD}`)
  parts.push('\n请开始执行。完成后用一段话总结你做了什么、结果如何、是否还有未解决的问题。')
  return parts.join('\n')
}

/* ------------------------------------------------------------------ *
 * claude 事件解析
 * ------------------------------------------------------------------ */

function createClaudeParser(taskId) {
  const state = { sessionId: null, resultText: '', isError: false, toolNames: new Set() }

  function handleAssistant(payload) {
    const content = payload?.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && block.text && block.text.trim()) {
        store.addMessage(taskId, 'assistant', block.text)
      } else if (block.type === 'tool_use') {
        state.toolNames.add(block.name)
        store.addEvent(taskId, {
          type: 'tool_use',
          name: block.name,
          content: summarizeToolInput(block.name, block.input),
        })
      } else if (block.type === 'thinking' && block.thinking) {
        store.addEvent(taskId, { type: 'thinking', name: '思考', content: clip(block.thinking, 1500) })
      }
    }
  }

  function handleUser(payload) {
    const content = payload?.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'tool_result') {
        const raw = block.content
        let text = ''
        if (typeof raw === 'string') text = raw
        else if (Array.isArray(raw)) {
          text = raw.map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : '')).filter(Boolean).join('\n')
        }
        store.addEvent(taskId, {
          type: block.is_error ? 'tool_error' : 'tool_result',
          name: '',
          content: clip(text, 2000),
        })
      }
    }
  }

  function handleResult(payload) {
    state.isError = Boolean(payload.is_error) || payload.subtype === 'error'
    if (typeof payload.result === 'string' && payload.result.trim()) state.resultText = payload.result
    if (payload.session_id) state.sessionId = payload.session_id

    const bits = []
    if (payload.duration_ms) bits.push(`耗时 ${(payload.duration_ms / 1000).toFixed(1)}s`)
    if (typeof payload.total_cost_usd === 'number' && payload.total_cost_usd > 0) {
      bits.push(`成本 $${payload.total_cost_usd.toFixed(4)}`)
    }
    if (payload.num_turns) bits.push(`${payload.num_turns} 轮`)
    store.addEvent(taskId, {
      type: state.isError ? 'error' : 'success',
      name: '运行结束',
      content: bits.length ? bits.join(' · ') : `subtype=${payload.subtype || 'unknown'}`,
    })
  }

  function handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let payload
    try {
      payload = JSON.parse(trimmed)
    } catch (_) {
      store.addEvent(taskId, { type: 'raw', name: '', content: clip(trimmed, 1200) })
      return
    }

    switch (payload.type) {
      case 'system':
        if (payload.subtype === 'init') {
          if (payload.session_id) state.sessionId = payload.session_id
          store.addEvent(taskId, {
            type: 'system',
            name: '会话已建立',
            content: clip(
              JSON.stringify(
                { session_id: payload.session_id, cwd: payload.cwd, model: payload.model },
                null,
                2,
              ),
              800,
            ),
          })
        }
        break
      case 'assistant':
        handleAssistant(payload)
        break
      case 'user':
        handleUser(payload)
        break
      case 'result':
        handleResult(payload)
        break
      default:
        break
    }
  }

  return { state, handleLine }
}

/* ------------------------------------------------------------------ *
 * deveco 事件解析
 * ------------------------------------------------------------------ */

function createDevecoParser(taskId) {
  const state = {
    sessionId: null,
    resultText: '',
    isError: false,
    toolNames: new Set(),
    textParts: [],
    permissionBlocked: false,
  }

  /** deveco 在未开启自动放行时，会把工具调用驳回并把这个事实塞在输出里 */
  function looksLikePermissionBlock(text) {
    return /rejected permission|user rejected|permission denied|not permitted|needs? approval|requires approval/i.test(
      String(text || ''),
    )
  }

  function notePermissionBlock(taskId) {
    if (state.permissionBlocked) return
    state.permissionBlocked = true
    store.addEvent(taskId, {
      type: 'error',
      name: '权限被拦截',
      content:
        'DevEco Code 默认会驳回未经批准的敏感操作，所以这一步没执行成功。\n' +
        '如果希望它像 Claude 的 acceptEdits 那样自主干活，请在右上角 ⚙ 设置里\n' +
        '打开「DevEco 自动放行」——注意那等于让它不经确认执行命令。',
    })
    // 同时在对话里留一条，避免用户只看到「已完成」却不知道发生了什么
    store.addMessage(
      taskId,
      'system',
      '⚠️ 本次执行有工具调用被权限拦截，任务可能没有真正完成。可在 ⚙ 设置中开启「DevEco 自动放行」后重试。',
    )
  }

  function handleTool(part) {
    const rawName = part.tool || part.name || 'tool'
    state.toolNames.add(displayToolName(rawName))

    const st = part.state || {}
    const input = st.input || {}
    const status = st.status

    store.addEvent(taskId, {
      type: 'tool_use',
      name: displayToolName(rawName),
      content: summarizeToolInput(rawName, input),
    })

    // deveco 的工具事件里同时带着执行结果，一次事件拆成两条记录更好读
    const outputText = typeof st.output === 'string' ? st.output : st.output ? JSON.stringify(st.output) : ''

    if (status === 'completed' && outputText) {
      if (looksLikePermissionBlock(outputText)) notePermissionBlock(taskId)
      store.addEvent(taskId, { type: 'tool_result', name: '', content: clip(outputText, 2000) })
    } else if (status === 'error' || st.error) {
      const errText = String(st.error || outputText || '工具执行失败')
      if (looksLikePermissionBlock(errText)) notePermissionBlock(taskId)
      store.addEvent(taskId, { type: 'tool_error', name: '', content: clip(errText, 2000) })
    }
  }

  function handleLine(line) {
    const trimmed = line.trim()
    if (!trimmed) return
    let payload
    try {
      payload = JSON.parse(trimmed)
    } catch (_) {
      store.addEvent(taskId, { type: 'raw', name: '', content: clip(trimmed, 1200) })
      return
    }

    if (payload.sessionID) state.sessionId = payload.sessionID
    const part = payload.part || {}

    switch (payload.type) {
      case 'text':
        if (part.text && part.text.trim()) {
          state.textParts.push(part.text)
          store.addMessage(taskId, 'assistant', part.text)
        }
        break

      case 'tool_use':
      case 'tool':
        handleTool(part)
        break

      case 'reasoning':
        if (part.text) store.addEvent(taskId, { type: 'thinking', name: '思考', content: clip(part.text, 1500) })
        break

      case 'step_finish': {
        const bits = []
        if (part.tokens?.total) bits.push(`${part.tokens.total} tokens`)
        if (typeof part.cost === 'number' && part.cost > 0) bits.push(`成本 $${part.cost.toFixed(6)}`)
        if (part.reason) bits.push(`reason=${part.reason}`)
        if (payload.type === 'step_finish' && part.reason === 'stop') {
          store.addEvent(taskId, { type: 'success', name: '运行结束', content: bits.join(' · ') || '完成' })
        } else if (bits.length) {
          store.addEvent(taskId, { type: 'status', name: '步骤结束', content: bits.join(' · ') })
        }
        break
      }

      case 'error': {
        state.isError = true
        const msg = part.message || payload.message || payload.error || JSON.stringify(payload)
        store.addEvent(taskId, { type: 'error', name: '执行错误', content: clip(String(msg), 2000) })
        break
      }

      case 'step_start':
        break

      default:
        break
    }
  }

  return { state, handleLine }
}

/* ------------------------------------------------------------------ *
 * 命令行参数
 * ------------------------------------------------------------------ */

function buildClaudeArgs({ resumeSessionId, model }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']

  const mode = store.getSetting('permissionMode', CONFIG.PERMISSION_MODE)
  if (CONFIG.isValidPermissionMode(mode)) args.push('--permission-mode', mode)
  // 选了模型就必须真的传给 CLI。之前这里只把模型写进事件日志和界面，
  // claude 一直用它自己的默认模型在跑 —— 用户看到的「claude · haiku」是假的。
  // 只放行白名单内的 id：这个值能被 API 改写，而它会进 argv。
  if (model && executors.isValidModel('claude', model)) args.push('--model', model)
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  return args
}

/**
 * 路径能不能安全地放进 argv。
 *
 * Windows 上 CLI 是 .cmd，只能经 cmd.exe（shell: true）转发，而 Node 在 shell
 * 模式下不会替数组参数做转义：带空格的路径会被切成两个参数，带 & | < > 的还会
 * 变成第二条命令。所以这里只放行「不含空白与 shell 元字符」的路径，其余一律
 * 退回默认工作目录（并记一条事件，让用户知道为什么不是他填的路径）。
 */
function isArgvSafePath(p) {
  return Boolean(p) && !/[\s"&|<>^()%!]/.test(p)
}

function buildDevecoArgs({ resumeSessionId, model, cwd }) {
  // 静态 ASCII 或已校验过的值；用户内容一律走 stdin
  const args = ['run', '--format', 'json', '--dir', cwd]
  if (model) args.push('-m', model)
  if (resumeSessionId) args.push('-s', resumeSessionId)

  // deveco 没有 acceptEdits 这种中间档，只有「全自动放行」开关。
  // 因此默认不开（与 claude 侧默认 acceptEdits 的保守取向保持一致），
  // 需要时在设置里显式打开。
  if (store.getSetting('devecoAutoApprove', '0') === '1') args.push('--auto')
  return args
}

/* ------------------------------------------------------------------ *
 * 模拟执行（CLI 不可用时的降级路径）
 * ------------------------------------------------------------------ */

function runMock({ taskId, task, agent, extraInstruction }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let cancelled = false
  const controller = { kill: () => { cancelled = true }, mock: true }
  running.set(taskId, controller)

  const who = agent.functionLabel || agent.role

  const script = [
    { delay: 300, kind: 'event', type: 'system', name: '模拟模式', content: '未检测到可用的 CLI，本次以模拟方式演示执行流程。' },
    { delay: 500, kind: 'event', type: 'tool_use', name: 'Bash', content: 'ls -la' },
    { delay: 700, kind: 'event', type: 'tool_result', name: '', content: 'total 24\ndrwxr-xr-x  5 boss boss 4096 .\n-rw-r--r--  1 boss boss  128 package.json' },
    { delay: 600, kind: 'event', type: 'tool_use', name: 'Read', content: path.join(task.cwd || CONFIG.DEFAULT_CWD, 'package.json') },
    { delay: 600, kind: 'message', text: `「${who}」已接手：**${task.title}**。` },
    { delay: 700, kind: 'message', text: extraInstruction ? `收到补充指令：${extraInstruction}` : '正在分析现有代码结构，确认改动范围。' },
    { delay: 800, kind: 'event', type: 'tool_use', name: 'Edit', content: path.join(task.cwd || CONFIG.DEFAULT_CWD, 'src', 'index.js') },
    { delay: 600, kind: 'event', type: 'tool_result', name: '', content: '已应用 1 处修改' },
    { delay: 700, kind: 'message', text: '改动已完成，正在自检。' },
    { delay: 600, kind: 'event', type: 'tool_use', name: 'Bash', content: 'npm test' },
    { delay: 900, kind: 'event', type: 'tool_result', name: '', content: 'PASS  test/index.test.js\nTests: 4 passed, 4 total' },
    { delay: 500, kind: 'message', text: `任务「${task.title}」已执行完毕。改动 1 个文件，测试全部通过，无遗留问题。` },
    { delay: 300, kind: 'event', type: 'success', name: '运行结束', content: '耗时 9.1s（模拟）' },
  ]

  const promise = (async () => {
    for (const step of script) {
      if (cancelled) return { ok: false, cancelled: true }
      await sleep(step.delay)
      if (cancelled) return { ok: false, cancelled: true }
      if (step.kind === 'message') store.addMessage(taskId, 'assistant', step.text)
      else store.addEvent(taskId, { type: step.type, name: step.name, content: step.content })
    }
    return {
      ok: true,
      sessionId: `mock-${taskId}`,
      resultText: `任务「${task.title}」已执行完毕（模拟）。`,
      toolNames: ['Bash', 'Read', 'Edit'],
    }
  })()

  promise.finally(() => {
    if (running.get(taskId) === controller) running.delete(taskId)
  })

  return promise
}

/* ------------------------------------------------------------------ *
 * 真实执行（claude / deveco 共用进程管理）
 * ------------------------------------------------------------------ */

function runReal({ taskId, bin, args, prompt, parser, cwd, label }) {
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    windowsHide: true,
    // Windows 上 .cmd 必须经 shell 转发；argv 全为静态安全参数，无注入面
    shell: process.platform === 'win32',
  })

  running.set(taskId, child)

  let stderr = ''
  let settled = false

  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      store.addEvent(taskId, {
        type: 'error',
        name: '超时',
        content: `执行超过 ${Math.round(CONFIG.RUN_TIMEOUT / 60000)} 分钟，已强制结束。`,
      })
      killTree(child)
    }, CONFIG.RUN_TIMEOUT)

    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      try {
        parser.handleLine(line)
      } catch (err) {
        console.error(`[runner] ${label} 输出解析失败:`, err.message)
      }
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
      if (stderr.length > MAX_STDERR_CHARS) stderr = stderr.slice(-MAX_STDERR_CHARS)
    })

    child.on('error', (err) => {
      store.addEvent(taskId, { type: 'error', name: '进程启动失败', content: err.message })
      finish({ ok: false, error: err.message, spawnFailed: true, sessionId: parser.state.sessionId })
    })

    child.on('close', (code, signal) => {
      const killed = signal === 'SIGTERM' || signal === 'SIGKILL'
      if (killed) {
        store.addEvent(taskId, { type: 'error', name: '已中断', content: '进程被主动结束。' })
        finish({ ok: false, cancelled: true, sessionId: parser.state.sessionId })
        return
      }
      if (code !== 0) {
        const tail = stderr.trim().split('\n').slice(-6).join('\n')
        store.addEvent(taskId, {
          type: 'error',
          name: `进程退出码 ${code}`,
          content: tail || '(无 stderr 输出)',
        })
        finish({
          ok: false,
          error: tail || `${label} 进程以退出码 ${code} 结束`,
          sessionId: parser.state.sessionId,
          toolNames: [...parser.state.toolNames],
        })
        return
      }
      finish({
        ok: !parser.state.isError,
        error: parser.state.isError ? '执行过程报告了错误' : '',
        sessionId: parser.state.sessionId,
        resultText: parser.state.resultText,
        toolNames: [...parser.state.toolNames],
      })
    })

    child.stdin.on('error', () => {
      /* 进程提前退出时 stdin 会 EPIPE，忽略 */
    })
    child.stdin.end(prompt, 'utf8')
  })

  promise.finally(() => {
    if (running.get(taskId) === child) running.delete(taskId)
  })

  return promise
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/** 决定这次跑用哪个执行器、哪个模型：任务覆盖 > Agent 设置 > 执行器默认 */
function resolveRuntime(task, agent) {
  const executor = task.executor || agent.executor || 'claude'
  let model = task.model || agent.model || ''
  if (!model) model = executors.defaultModel(executor) || ''
  return { executor, model }
}

function executorBinary(executorId) {
  return executorId === 'deveco' ? executors.resolveDevecoBin() : resolveClaudeBin()
}

/**
 * 执行一个任务的一个回合。
 * 返回 { ok, cancelled, error, sessionId, resultText, toolNames, executor }
 */
async function execute({ task, agent, extraInstruction = '', resumeSessionId = null }) {
  const taskId = task.id
  const isResume = Boolean(resumeSessionId)
  const { executor } = resolveRuntime(task, agent)
  let { model } = resolveRuntime(task, agent)

  // deveco 的模型列表是异步拉的，冷启动时可能还没预热好。
  // 这里补一次等待，避免第一次跑 deveco 任务时模型是空的。
  if (executor === 'deveco' && !model) {
    try {
      const models = await executors.refreshDevecoModels()
      if (models.length) model = models[0].id
    } catch (_) {
      /* 拿不到就让 deveco 用它自己的默认模型 */
    }
  }

  // 模型值来自任务 / 员工记录，而这两处都能被 HTTP API 直接 PATCH，值最终会进
  // argv（Windows 上经 cmd.exe）。不在白名单里就退回该执行器的默认模型，
  // 并如实记一条事件 —— 否则界面上会显示一个实际根本没生效的模型。
  if (model && !executors.isValidModel(executor, model)) {
    const fallback = executors.defaultModel(executor)
    store.addEvent(taskId, {
      type: 'status',
      name: '模型不可用',
      content: `「${model}」不在 ${executor} 的可选模型里，本次改用 ${fallback || '执行器默认模型'}。`,
    })
    model = fallback || ''
  }

  const prompt = composePrompt({
    systemPrompt: agent.system_prompt || agent.systemPrompt || '',
    task,
    extraInstruction,
    isResume,
  })

  const bin = executorBinary(executor)
  const canRunReal = !CONFIG.FORCE_MOCK && Boolean(bin)

  store.addEvent(taskId, {
    type: 'status',
    name: '执行器',
    content: `${executor}${model ? ` · ${model}` : ''}${isResume ? ' · 续跑' : ''}`,
  })

  if (!canRunReal) {
    return { ...(await runMock({ taskId, task, agent, extraInstruction })), executor }
  }

  const isClaude = executor === 'claude'

  let cwd = task.cwd && fs.existsSync(task.cwd) ? task.cwd : CONFIG.ROOT
  // deveco 会把工作目录塞进 argv（--dir），而 Windows 上的参数不经过转义：
  // 带空格 / 元字符的路径会把命令行拆坏（"C:\My Projects" 变成两个参数，
  // 带 & 的甚至拆出第二条命令）。claude 的目录是走 spawn 的 cwd 选项，
  // 不经 shell，所以不受这个限制。
  if (!isClaude && !isArgvSafePath(cwd)) {
    store.addEvent(taskId, {
      type: 'status',
      name: '工作目录已替换',
      content: `「${cwd}」含空格或 shell 特殊字符，无法安全地传给 ${executor}，本次改用 ${CONFIG.ROOT}。`,
    })
    cwd = CONFIG.ROOT
  }

  const args = isClaude
    ? buildClaudeArgs({ resumeSessionId, model })
    : buildDevecoArgs({ resumeSessionId, model, cwd })
  const parser = isClaude ? createClaudeParser(taskId) : createDevecoParser(taskId)
  const label = isClaude ? 'claude' : 'deveco'

  const messagesBefore = store.listMessages(taskId).length
  const result = await runReal({ taskId, bin, args, prompt, parser, cwd, label })

  // CLI 真的不存在/不可执行 → 退回模拟，保证界面仍然可用
  if (result.spawnFailed) {
    store.addEvent(taskId, {
      type: 'system',
      name: '降级为模拟执行',
      content: `无法启动 ${label}（${result.error}），本次改用模拟模式。`,
    })
    return { ...(await runMock({ taskId, task, agent, extraInstruction })), executor }
  }

  // 跑完了却一句话都没说：在对话里补一条说明，否则用户只看到「已完成」会很困惑
  if (result.ok) {
    const added = store.listMessages(taskId).length - messagesBefore
    if (added <= 0) {
      store.addMessage(
        taskId,
        'system',
        '本次执行没有产生文字回复（Agent 可能只做了工具调用就结束了）。可以点重试，或在下方补充一句更具体的指令。',
      )
    }
  }

  return { ...result, executor }
}

function killTree(child) {
  if (!child) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch (err) {
    console.error('[runner] 结束进程失败:', err.message)
  }
}

function cancel(taskId) {
  const child = running.get(taskId)
  if (!child) return false
  if (child.mock) child.kill()
  else killTree(child)
  running.delete(taskId)
  return true
}

function isRunning(taskId) {
  return running.has(taskId)
}

function runningTaskIds() {
  return [...running.keys()]
}

module.exports = {
  execute,
  cancel,
  isRunning,
  runningTaskIds,
  resolveClaudeBin,
  setClaudeBin,
  claudeAvailable,
  killTree,
  resolveRuntime,
  executorBinary,
}
