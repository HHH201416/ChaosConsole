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
const pipeline = require('./pipeline')
const mcpScope = require('./mcp-scope')
const runtime = require('./runtime')
const knowledge = require('./knowledge')
const chaosLlm = require('./chaos-llm')
const { quoteArg } = require('./win-quote')
const { DEFAULT_AGENTS } = require('./seed')

const MAX_EVENT_CHARS = 6000
const MAX_STDERR_CHARS = 4000

/** taskId -> child process | mock controller */
const running = new Map()

/**
 * taskId -> 本次结束的**原因**：'cancel' | 'handoff' | 'timeout'
 *
 * 为什么需要这张表：Windows 下我们用 `taskkill /T /F` 结束进程，close 回来的是
 * code=1 / signal=null，于是 `signal === 'SIGTERM'` 永远不成立 —— 「用户点了取消」
 * 实际被判成「进程以退出码 1 失败」，落库落成 needs_input/error 而不是
 * backlog/cancelled。把意图记在**起杀它的地方**，close 只读这张表，就不再依赖
 * 各平台的信号语义。读一次即删，避免污染下一次运行。
 */
const stopIntent = new Map()

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

/**
 * 9.8.0：思考内容**不截断**。
 *
 * 用户明确要求「深度思考中生成的内容都要显示」—— 以前这里按 1500 字裁掉，
 * 思辨模型跑长推理时后半段全丢了。现在原文完整保存，只留一个 20 万字符的
 * 安全上限（正常推理不可能到，纯粹防止异常输出把数据库撑爆）。
 */
const THINK_MAX_CHARS = 200000

function keepThink(text) {
  const s = typeof text === 'string' ? text : text == null ? '' : String(text)
  if (!s) return ''
  return s.length > THINK_MAX_CHARS ? `${s.slice(0, THINK_MAX_CHARS)}\n…（超过 20 万字符上限，已截断）` : s
}

/**
 * 9.8.0：执行看门狗。
 *
 * 用户要求「我让他做一个任务，它要完成后再停止」—— 所以默认**没有总时长上限**：
 * 只要任务还在产出就一直跑，跑到它自己结束为止。
 *
 * 真正保留的兜底是「空闲超时」：连续 IDLE 毫秒连一个字都没有，才判定卡死。
 * 每收到一行输出 / 一段增量就 arm() 一次续期，所以慢任务不会被误杀。
 *
 * hardMs 是可选的总时长上限（只有显式设置 CHAOS_RUN_TIMEOUT 时才生效）。
 */
function createWatchdog(taskId, { hardMs = 0, idleMs = 0 } = {}, onFire) {
  let hardTimer = null
  let idleTimer = null
  let done = false

  const fire = (reasonText) => {
    if (done) return
    done = true
    clearTimeout(hardTimer)
    clearTimeout(idleTimer)
    stopIntent.set(taskId, 'timeout')
    store.addEvent(taskId, { type: 'error', name: '超时', content: reasonText })
    onFire()
  }

  const arm = () => {
    if (done || !idleMs || idleMs <= 0) return
    clearTimeout(idleTimer)
    idleTimer = setTimeout(
      () => fire(`连续 ${Math.round(idleMs / 60000)} 分钟没有任何输出，判定卡住并结束本次执行。`),
      idleMs,
    )
  }

  if (hardMs > 0) {
    hardTimer = setTimeout(() => fire(`执行超过 ${Math.round(hardMs / 60000)} 分钟，已按上限强制结束。`), hardMs)
  }
  arm()

  return {
    arm,
    clear() {
      done = true
      clearTimeout(hardTimer)
      clearTimeout(idleTimer)
    },
    get enabled() {
      return (idleMs > 0 || hardMs > 0) && !done
    },
  }
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
 * 控制指令（阶段推进 / 换岗）
 *
 * agent 用「单独一行」的指令告诉我们该换人或者该推进阶段。两条通道
 * （这里的文本指令、以及 handoff MCP 工具）最终都汇入 queue 的同一个
 * 换岗原语，解析器只负责**识别**，不认识岗位、不做判断。
 * ------------------------------------------------------------------ */

const DIRECTIVE_RE = /^\s*CHAOS_(STAGE|HANDOFF|ASK):\s*(\{.*\}|.+)\s*$/

/**
 * 扫描一段文本里的控制指令。逐行匹配，只认**单行 JSON** ——
 * 跨行的 JSON 不认（提示词里明确要求单独起一行）。
 * 解析失败也会返回结果（带 parseError），让调用方能记一条事件而不是静默吞掉。
 */
function scanDirective(text) {
  const src = String(text || '')
  if (!src) return null
  for (const line of src.split(/\r?\n/)) {
    const m = DIRECTIVE_RE.exec(line)
    if (!m) continue
    // 9.3.8：CHAOS_ASK 后面直接跟问题文本，不用 JSON（对模型最省事）
    if (m[1].toUpperCase() === 'ASK') {
      return { kind: 'ask', payload: { question: m[2].trim() }, raw: line.trim() }
    }
    try {
      return { kind: m[1].toLowerCase(), payload: JSON.parse(m[2]), raw: line.trim() }
    } catch (_) {
      return { kind: m[1].toLowerCase(), parseError: true, raw: line.trim() }
    }
  }
  return null
}

/**
 * 阶段 + 指令语法。**每个非续轮都要注入** —— 不告诉 agent 这套语法，
 * 它就永远不会发出指令，功能看起来就是「没生效」。
 */
function stageSection(stage) {
  if (!stage || !Array.isArray(stage.pipeline) || !stage.pipeline.length) return ''
  const chain = stage.pipeline.map((s) => pipeline.labelOf(s.stage)).join(' → ')
  const here = pipeline.labelOf(stage.current || stage.pipeline[0].stage)
  const idx = Math.max(1, (stage.index || 0) + 1)
  return [
    '\n## 当前阶段',
    `${here}（${idx}/${stage.pipeline.length}）：${chain}`,
    '',
    '需要推进阶段或把任务交给别的岗位时，在回复里**单独起一行**写下面对应的指令（不写就不会触发）：',
    `- 本阶段做完、交给下一阶段：\`CHAOS_STAGE: {"done":"${stage.current || stage.pipeline[0].stage}","next":"下一阶段的阶段名","summary":"这一步做了什么"}\``,
    '- 需要别的岗位接手：`CHAOS_HANDOFF: {"role":"岗位代码","reason":"为什么交给它","summary":"交接说明"}`',
    '- **不确定怎么做、缺关键信息时（优先用这个，别瞎猜）**：单独一行 `CHAOS_ASK: 你要问的问题`——任务会停下来等用户回答，回答后你再继续',
  ].join('\n')
}

/** 可交办的岗位清单（只给 role 与职能，姓名从不出现在提示词里） */
function rosterSection(roster) {
  if (!Array.isArray(roster) || !roster.length) return ''
  const items = roster
    .slice(0, 40)
    .map((a) => `${a.role}(${a.functionLabel || a.role})`)
  return `\n## 可交办的岗位\n${items.join('、')}`
}

/* ------------------------------------------------------------------ *
 * 提示词组装
 * ------------------------------------------------------------------ */

function composePrompt({
  systemPrompt,
  task,
  extraInstruction,
  isResume,
  envNote,
  stage,
  roster,
  handoffBrief,
  kb = '',
}) {
  const parts = []
  const push = (text) => {
    if (text) parts.push(text)
  }

  // 交接必须重新注入人设：新岗位的 system_prompt 只在会话首轮生效，
  // 而交接开的是新会话（见 queue.applyHandoff 的新会话判定）。
  const injectPersona = systemPrompt && (!isResume || Boolean(handoffBrief))
  if (injectPersona) {
    push(systemPrompt.trim())
    // 执行器的本地环境（如 DevEco 工具链绝对路径）。只在首次回合拼，
    // 续跑时上下文里已经有了。
    if (envNote) push(`\n${envNote.trim()}`)
    push('\n---\n')
  }

  if (handoffBrief) {
    // 接手回合：任务背景由交接说明自带，不再重复贴一遍任务原文
    push(handoffBrief.trim())
  } else if (extraInstruction) {
    // 续跑回合：只发补充指令，上下文由会话自己维持
    push(extraInstruction.trim())
    // 知识库命中只在首轮注入 —— 续跑时上下文里已经有了
    if (!isResume && kb) push(`\n${kb}`)
    return parts.join('\n')
  } else {
    push(`# 任务\n${task.title}`)
    if (task.description && task.description.trim()) {
      push(`\n## 详细说明\n${task.description.trim()}`)
    }
    push(`\n## 工作目录\n${task.cwd || CONFIG.workspaceDir()}`)
  }

  if (kb) push(`\n${kb}`)
  push(stageSection(stage))
  push(rosterSection(roster))
  push('\n请开始执行。完成后用一段话总结你做了什么、结果如何、是否还有未解决的问题。')
  return parts.join('\n')
}

/* ------------------------------------------------------------------ *
 * claude 事件解析
 * ------------------------------------------------------------------ */

function createClaudeParser(taskId) {
  const state = { sessionId: null, resultText: '', isError: false, toolNames: new Set(), directive: null }

  function handleAssistant(payload) {
    const content = payload?.message?.content
    if (!Array.isArray(content)) return
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && block.text && block.text.trim()) {
        store.addMessage(taskId, 'assistant', block.text)
        // 正文照常入库（不吞内容），指令另外记一条事件 —— 让「为什么换了人」
        // 在时间线上看得见
        const d = scanDirective(block.text)
        if (d) {
          state.directive = d
          store.addEvent(taskId, {
            type: 'status',
            name: d.kind === 'stage' ? '阶段指令' : '换岗指令',
            content: clip(d.raw, 600),
          })
        }
      } else if (block.type === 'tool_use') {
        state.toolNames.add(block.name)
        store.addEvent(taskId, {
          type: 'tool_use',
          name: block.name,
          content: summarizeToolInput(block.name, block.input),
        })
      } else if (block.type === 'thinking' && block.thinking) {
        store.addEvent(taskId, { type: 'thinking', name: '思考', content: keepThink(block.thinking) })
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
    directive: null,
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
          // 与 claude 侧同一套指令：阶段推进 / 换岗
          const d = scanDirective(part.text)
          if (d) {
            state.directive = d
            store.addEvent(taskId, {
              type: 'status',
              name: d.kind === 'stage' ? '阶段指令' : '换岗指令',
              content: clip(d.raw, 600),
            })
          }
        }
        break

      case 'tool_use':
      case 'tool':
        handleTool(part)
        break

      case 'reasoning':
        if (part.text) store.addEvent(taskId, { type: 'thinking', name: '思考', content: keepThink(part.text) })
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

function buildClaudeArgs({ resumeSessionId, model, mcpConfigPath = '', strictMcp = false }) {
  const args = ['-p', '--output-format', 'stream-json', '--verbose']

  const mode = store.getSetting('permissionMode', CONFIG.PERMISSION_MODE)
  if (CONFIG.isValidPermissionMode(mode)) args.push('--permission-mode', mode)
  // 选了模型就必须真的传给 CLI。之前这里只把模型写进事件日志和界面，
  // claude 一直用它自己的默认模型在跑 —— 用户看到的「claude · haiku」是假的。
  // 只放行白名单内的 id：这个值能被 API 改写，而它会进 argv。
  if (model && executors.isValidModel('claude', model)) args.push('--model', model)
  if (resumeSessionId) args.push('--resume', resumeSessionId)
  // 按岗位挂 MCP。路径在 %APPDATA% 下，用户名带空格就会被 cmd 拆成两个参数
  // （spawn 走 shell:true），所以必须按 win-quote 的规则补引号。
  if (mcpConfigPath) {
    args.push('--mcp-config', quoteArg(mcpConfigPath))
    // 严格模式：只认 --mcp-config 里给的服务器（同时会排除项目/用户级的其它 MCP）
    if (strictMcp) args.push('--strict-mcp-config')
  }
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

/**
 * 模拟执行的「标题标记」：让回归用例在没有真 CLI 的情况下也能覆盖
 * 失败自动换岗、阶段推进、主动换岗这三条规则。
 * 标记都是惰性的 —— 正常标题里不会出现，日常使用完全不受影响。
 */
const mockAttempts = new Map()

function mockMarkers(title) {
  const t = String(title || '')
  const stage = /\[STAGE:([^\]]+)\]/.exec(t)
  const handoff = /\[HANDOFF:([^\]]+)\]/.exec(t)
  return {
    failAlways: /\[FAIL_ALWAYS\]/.test(t),
    failOnce: /\[FAIL_ONCE\]/.test(t),
    stage: stage ? stage[1].trim() : '',
    handoff: handoff ? handoff[1].trim() : '',
  }
}

function runMock({ taskId, task, agent, extraInstruction }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  let cancelled = false
  const controller = { kill: () => { cancelled = true }, mock: true }
  running.set(taskId, controller)

  const who = agent.functionLabel || agent.role
  const marks = mockMarkers(task.title)

  // 第几次跑这个任务（[FAIL_ONCE] 靠它「先失败一次、换人后成功」）
  const attempt = mockAttempts.get(taskId) || 0
  mockAttempts.set(taskId, attempt + 1)
  const failNow = marks.failAlways || (marks.failOnce && attempt === 0)
  const failMsg = marks.failAlways ? '模拟失败（持续失败）' : '模拟失败（首次）'

  const script = [
    { delay: 300, kind: 'event', type: 'system', name: '模拟模式', content: '未检测到可用的 CLI，本次以模拟方式演示执行流程。' },
    { delay: 500, kind: 'event', type: 'tool_use', name: 'Bash', content: 'ls -la' },
    { delay: 700, kind: 'event', type: 'tool_result', name: '', content: 'total 24\ndrwxr-xr-x  5 boss boss 4096 .\n-rw-r--r--  1 boss boss  128 package.json' },
    { delay: 600, kind: 'event', type: 'tool_use', name: 'Read', content: path.join(task.cwd || CONFIG.workspaceDir(), 'package.json') },
    { delay: 600, kind: 'message', text: `「${who}」已接手：**${task.title}**。` },
    { delay: 700, kind: 'message', text: extraInstruction ? `收到补充指令：${extraInstruction}` : '正在分析现有代码结构，确认改动范围。' },
    { delay: 800, kind: 'event', type: 'tool_use', name: 'Edit', content: path.join(task.cwd || CONFIG.workspaceDir(), 'src', 'index.js') },
    { delay: 600, kind: 'event', type: 'tool_result', name: '', content: '已应用 1 处修改' },
    { delay: 700, kind: 'message', text: '改动已完成，正在自检。' },
    { delay: 600, kind: 'event', type: 'tool_use', name: 'Bash', content: 'npm test' },
    { delay: 900, kind: 'event', type: 'tool_result', name: '', content: 'PASS  test/index.test.js\nTests: 4 passed, 4 total' },
    { delay: 500, kind: 'message', text: `任务「${task.title}」已执行完毕。改动 1 个文件，测试全部通过，无遗留问题。` },
    { delay: 300, kind: 'event', type: 'success', name: '运行结束', content: '耗时 9.1s（模拟）' },
  ]

  // 中途中报告指令：插在「正在分析」之后，模拟真实执行里 agent 主动发指令的时机
  let directive = null
  if (marks.stage) {
    const pair = marks.stage.split(/→|->/).map((s) => s.trim()).filter(Boolean)
    const payload = {
      done: pair.length > 1 ? pair[0] : task.stage || '',
      next: pair.length > 1 ? pair[1] : pair[0],
      summary: '模拟阶段推进',
    }
    directive = { kind: 'stage', payload, raw: `CHAOS_STAGE: ${JSON.stringify(payload)}` }
  } else if (marks.handoff) {
    const payload = { role: marks.handoff, reason: '模拟换岗', summary: '模拟交接说明' }
    directive = { kind: 'handoff', payload, raw: `CHAOS_HANDOFF: ${JSON.stringify(payload)}` }
  }
  if (directive) {
    script.splice(6, 0, {
      delay: 400,
      kind: 'directive',
      name: directive.kind === 'stage' ? '阶段指令' : '换岗指令',
      text: directive.raw,
    })
  }

  // 要失败的一轮就别演到「测试全部通过」—— 否则时间线自相矛盾
  const steps = failNow ? script.slice(0, 8) : script

  /** 被中断时的返回值：读一次意图就删，让「换岗」与「取消」在模拟路径上也可区分 */
  const stopPayload = () => {
    const intent = stopIntent.get(taskId)
    stopIntent.delete(taskId)
    if (intent === 'timeout') return { ok: false, timedOut: true, error: '执行超时（模拟）' }
    return { ok: false, cancelled: true, handoff: intent === 'handoff' }
  }

  const promise = (async () => {
    for (const step of steps) {
      if (cancelled) return stopPayload()
      await sleep(step.delay)
      if (cancelled) return stopPayload()
      if (step.kind === 'message') store.addMessage(taskId, 'assistant', step.text)
      else if (step.kind === 'directive') {
        store.addMessage(taskId, 'assistant', step.text)
        store.addEvent(taskId, { type: 'status', name: step.name, content: clip(step.text, 600) })
      } else store.addEvent(taskId, { type: step.type, name: step.name, content: step.content })
    }
    if (failNow) {
      store.addEvent(taskId, { type: 'error', name: '模拟失败', content: failMsg })
      return { ok: false, error: failMsg, sessionId: `mock-${taskId}` }
    }
    return {
      ok: true,
      sessionId: `mock-${taskId}`,
      resultText: `任务「${task.title}」已执行完毕（模拟）。`,
      toolNames: ['Bash', 'Read', 'Edit'],
      directive,
    }
  })()

  promise.finally(() => {
    if (running.get(taskId) === controller) running.delete(taskId)
    stopIntent.delete(taskId)
  })

  return promise
}

/* ------------------------------------------------------------------ *
 * 真实执行（claude / deveco 共用进程管理）
 * ------------------------------------------------------------------ */

function runReal({ taskId, bin, args, prompt, parser, cwd, label, extraEnv = {} }) {
  const child = spawn(bin, args, {
    cwd,
    // extraEnv 目前只用来传 deveco 的按岗位 MCP 覆盖（DEVECO_CONFIG_CONTENT）
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...extraEnv },
    windowsHide: true,
    // Windows 上 .cmd 必须经 shell 转发；argv 全为静态安全参数，无注入面
    shell: process.platform === 'win32',
  })

  running.set(taskId, child)

  let stderr = ''
  let settled = false

  const promise = new Promise((resolve) => {
    // 9.8.0：不再用固定总时长 —— 任务要跑完才停（见 createWatchdog 注释）
    const watchdog = createWatchdog(
      taskId,
      { hardMs: CONFIG.RUN_TIMEOUT, idleMs: CONFIG.RUN_IDLE_TIMEOUT },
      () => killTree(child),
    )

    const finish = (payload) => {
      if (settled) return
      settled = true
      watchdog.clear()
      resolve(payload)
    }

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
    rl.on('line', (line) => {
      watchdog.arm() // 有输出就续期
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
      // 先看「是谁、为什么结束了它」—— 这比信号可靠（见 stopIntent 的注释）
      const intent = stopIntent.get(taskId)
      stopIntent.delete(taskId)
      if (intent === 'cancel' || intent === 'handoff') {
        store.addEvent(taskId, { type: 'error', name: '已中断', content: '进程被主动结束。' })
        finish({
          ok: false,
          cancelled: true,
          // 换岗不是取消：调用方据此走交接而不是落 cancelled
          handoff: intent === 'handoff',
          sessionId: parser.state.sessionId,
        })
        return
      }
      if (intent === 'timeout') {
        // 超时给明确的 timedOut 标记，让调用方按失败处理（自动换岗/转人工），
        // 而不是像以前那样被当成用户取消丢进 backlog
        finish({
          ok: false,
          timedOut: true,
          error: '长时间没有任何输出，判定卡住并结束（任务本身没有时长上限）',
          sessionId: parser.state.sessionId,
          toolNames: [...parser.state.toolNames],
        })
        return
      }

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
    // 兜底：进程自己退出（没走 close 的意图分支）时别把意图留到下一次运行
    stopIntent.delete(taskId)
    cleanupRunScope(taskId)
  })

  return promise
}

/**
 * 一次运行结束后清掉按岗位挂载的临时状态：
 *  - 运行期 MCP 配置（里面带着任务 id 与令牌，留着没意义）
 *  - 交接令牌（跑完的 / 被劫持的 MCP 子进程不能再拿它切任务）
 */
function cleanupRunScope(taskId) {
  mcpScope.removeRunFile(taskId)
  runtime.revokeHandoffToken(taskId)
}

/* ------------------------------------------------------------------ *
 * 混沌（本地大模型）执行路径
 *
 * 与 claude / deveco 不同，混沌不是被 spawn 的 CLI，而是本机推理服务的
 * HTTP 流式调用（见 chaos-llm.js）。它没有工具调用、没有服务端会话：
 *   - 「会话」由我们自己维持 —— 续跑就是把库里的历史消息一起发回去；
 *   - 控制指令（CHAOS_STAGE / CHAOS_HANDOFF）照常从全文里扫；
 *   - 取消 / 超时 / 换岗统一走 AbortController。
 * 换来的好处：完全免费、零配置、数据不出本机。
 * ------------------------------------------------------------------ */

const CHAOS_HISTORY_TURNS = 12
const CHAOS_HISTORY_CLIP = 4000

function chaosPromptUnavailable(message) {
  return (
    `${message}\n` +
    '可以：① 点顶栏的「混沌」按钮按引导一键安装；' +
    '② 或在对话底部把执行器切回 Claude / DevEco。'
  )
}

/* ------------------------------------------------------------------ *
 * 9.3.8：混沌本地工具协议 —— 让混沌真的能操作项目文件（自修改、改代码）。
 * 只暴露三个安全工具：列目录 / 读文本 / 写文本，全部锁死在工作区 cwd 之内。
 * 每次工具调用都写进事件流（对话页全程可见）。环境变量 CHAOS_TOOLS=0 可关。
 * ------------------------------------------------------------------ */

const CHAOS_TOOLS_MAX_ROUNDS = 8
const TOOL_TEXT_EXT = new Set([
  'md', 'markdown', 'txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less',
  'html', 'htm', 'vue', 'py', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cs', 'go', 'rs',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'sh', 'bat', 'ps1', 'sql', 'log', 'xml', 'csv',
])
const TOOL_IGNORED = new Set(['node_modules', '.git', 'dist', 'build', 'out', '__pycache__', '.venv'])

const CHAOS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出工作区某个目录下的文件与子目录（一层）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的目录路径，默认工作区根' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区里一个文本文件的内容（最多 256KB）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '把完整内容写入工作区里的一个文本文件（覆盖或新建）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          content: { type: 'string', description: '要写入的完整文本内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        '精准编辑工作区里的一个文本文件：把 oldText 原样替换成 newText（只改这一处）。改大文件必须用它，不要整文件重写。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区的文件路径' },
          oldText: { type: 'string', description: '要被替换的原文（必须与文件里的内容逐字一致，含缩进）' },
          newText: { type: 'string', description: '替换后的新文本' },
        },
        required: ['path', 'oldText', 'newText'],
      },
    },
  },
]

/* 9.5.4：操作电脑工具（设置开关「允许 Agent 操作电脑」控制，默认开）。
   run_command 用 PowerShell 执行任意命令（60s 超时 + 8KB 输出截断 + 盘级毁灭命令黑名单）；
   open_path 用系统默认方式打开文件 / 文件夹 / 网页。 */
const PC_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在这台电脑上执行一条命令（PowerShell，工作区为当前目录），返回 stdout/stderr。' +
        '适合：查目录、跑脚本、装依赖、查系统信息等。60 秒超时。',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: '要执行的命令，例如 node -v 或 Get-ChildItem D:\\' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_path',
      description: '用系统默认方式打开一个文件、文件夹或网页（http/https 链接）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件/文件夹的完整路径，或 http(s) 网页链接' },
        },
        required: ['path'],
      },
    },
  },
]

/** 「允许 Agent 操作电脑」开关（设置 agentComputerUse，1 开 / 0 关，默认开） */
function computerUseEnabled() {
  return store.getSetting('agentComputerUse', '1') === '1'
}

/** 盘级毁灭命令黑名单（format/diskpart 等）—— 其余命令信任模型 + 事件流全透明 */
const PC_CMD_BLACKLIST = /\b(format|diskpart|cipher\s+\/w|bdehdcfg|cleanmgr\s+\/verylowdisk)\b/i

/** 用 PowerShell 执行命令：60s 超时，输出截到 8KB。返回可直接给模型看的文本。 */
function runPcCommand(command) {
  const cmd = String(command || '').trim()
  if (!cmd) return '错误：命令为空'
  if (PC_CMD_BLACKLIST.test(cmd)) return '错误：该命令属于盘级毁灭性操作，已被安全策略拦截'
  return new Promise((resolve) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', cmd],
      { windowsHide: true },
    )
    let out = ''
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      resolve(`超时：命令执行超过 60 秒被中断。\n已捕获输出：\n${out.slice(0, 8192)}`)
    }, 60 * 1000)
    child.stdout.on('data', (d) => {
      if (out.length < 8192) out += d.toString()
    })
    child.stderr.on('data', (d) => {
      if (out.length < 8192) out += d.toString()
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve(`错误：${err.message}`)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(`退出码 ${code}\n${out.slice(0, 8192) || '（无输出）'}`)
    })
  })
}

/** 用系统默认方式打开文件 / 文件夹 / 网页 */
function openPcPath(target) {
  const t = String(target || '').trim()
  if (!t) return '错误：路径为空'
  if (/^(http|https):\/\//i.test(t)) {
    spawn('cmd', ['/c', 'start', '', t], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()
    return `已在默认浏览器打开 ${t}`
  }
  if (!fs.existsSync(t)) return `错误：路径不存在（${t}）`
  spawn('cmd', ['/c', 'start', '', t], { detached: true, windowsHide: true, stdio: 'ignore' }).unref()
  return `已用系统默认方式打开 ${t}`
}

/** 把工具给的相对路径解析到 cwd 之内；越界返回 null */
function resolveToolPath(cwd, rel) {
  const base = path.resolve(String(cwd || ''))
  const target = path.resolve(base, String(rel || '.'))
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep
  if (target !== base && !target.startsWith(baseWithSep)) return null
  return target
}

/** 执行一个工具调用，返回给模型看的字符串结果（9.5.4 起 run_command/open_path 为异步） */
async function runChaosTool(cwd, call) {
  const name = String(call?.function?.name || '')
  const args = call?.function?.arguments || {}

  /* 操作电脑工具：设置开关控制，不锁工作区（这就是「操作电脑」的本意） */
  if (name === 'run_command') {
    if (!computerUseEnabled()) return '错误：已在设置里关闭「允许 Agent 操作电脑」'
    return runPcCommand(args.command)
  }
  if (name === 'open_path') {
    if (!computerUseEnabled()) return '错误：已在设置里关闭「允许 Agent 操作电脑」'
    return openPcPath(args.path)
  }

  const rel = String(args.path || '.')
  const target = resolveToolPath(cwd, rel)
  if (!target) return `错误：路径越界，只能操作工作区内的文件（${rel}）`

  try {
    if (name === 'list_files') {
      const entries = fs
        .readdirSync(target, { withFileTypes: true })
        .filter((e) => !TOOL_IGNORED.has(e.name))
        .slice(0, 300)
      return entries
        .map((e) => {
          let size = ''
          if (e.isFile()) {
            try {
              size = ` (${fs.statSync(path.join(target, e.name)).size}B)`
            } catch (_) {
              /* ignore */
            }
          }
          return `${e.isDirectory() ? '[dir] ' : '      '}${e.name}${size}`
        })
        .join('\n') || '（空目录）'
    }

    if (name === 'read_file') {
      const ext = path.extname(target).slice(1).toLowerCase()
      if (!TOOL_TEXT_EXT.has(ext)) return `错误：不支持读取 .${ext || '无扩展名'} 类型的文件`
      const st = fs.statSync(target)
      if (!st.isFile()) return '错误：不是普通文件'
      const buf = fs.readFileSync(target)
      return buf.length > 256 * 1024
        ? buf.subarray(0, 256 * 1024).toString('utf8') + '\n…（超过 256KB 被截断）'
        : buf.toString('utf8') || '（空文件）'
    }

    if (name === 'write_file') {
      const ext = path.extname(target).slice(1).toLowerCase()
      if (ext && !TOOL_TEXT_EXT.has(ext)) return `错误：不支持写入 .${ext} 类型的文件`
      const content = String(args.content ?? '')
      if (content.length > 1024 * 1024) return '错误：内容超过 1MB 上限'
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, content, 'utf8')
      return `已写入 ${path.relative(path.resolve(cwd), target)}（${Buffer.byteLength(content, 'utf8')} 字节）`
    }

    /* 9.9.7：精准编辑 —— 自修改的关键。小模型整文件重写大文件必然截断，
     * 「旧串→新串」单点替换才是它能可靠完成的操作。找不到原文 / 命中多处
     * 都不动文件，把原文片段回给模型让它修正后重试。 */
    if (name === 'edit_file') {
      const ext = path.extname(target).slice(1).toLowerCase()
      if (ext && !TOOL_TEXT_EXT.has(ext)) return `错误：不支持编辑 .${ext} 类型的文件`
      if (!fs.existsSync(target)) return '错误：文件不存在，先用 read_file 确认路径'
      const oldText = String(args.oldText ?? '')
      const newText = String(args.newText ?? '')
      if (!oldText) return '错误：oldText 不能为空'
      const src = fs.readFileSync(target, 'utf8')
      const count = src.split(oldText).length - 1
      if (count === 0) {
        return '错误：oldText 在文件里没有逐字命中（注意缩进和换行要完全一致）。从 read_file 的输出里原样复制一段再试'
      }
      if (count > 1) {
        return `错误：oldText 命中了 ${count} 处，为避免改错地方请多带上下文让它只命中一处`
      }
      fs.writeFileSync(target, src.replace(oldText, newText), 'utf8')
      return `已编辑 ${path.relative(path.resolve(cwd), target)}（替换 ${Buffer.byteLength(oldText, 'utf8')} → ${Buffer.byteLength(newText, 'utf8')} 字节）`
    }

    return `错误：未知工具 ${name}`
  } catch (err) {
    return `错误：${err.message}`
  }
}

/**
 * 工具循环：最多 CHAOS_TOOLS_MAX_ROUNDS 轮。
 * 返回 { text: null } 表示模型没走工具路径（或循环后需要再走普通生成），
 * 返回 { text } 表示模型已在工具循环里给出最终回答。
 */
async function runChaosToolLoop({ taskId, cwd, model, messages, signal }) {
  if (process.env.CHAOS_TOOLS === '0' || !cwd) return { text: null }
  const convo = messages.slice()
  let lastEval = 0

  for (let round = 0; round < CHAOS_TOOLS_MAX_ROUNDS; round += 1) {
    let out
    try {
      out = await chaosLlm.chatWithTools({
        model,
        messages: convo,
        tools: computerUseEnabled() ? CHAOS_TOOLS.concat(PC_TOOLS) : CHAOS_TOOLS,
        signal,
      })
    } catch (err) {
      if (round === 0) return { text: null } // 工具通道不可用 → 退回普通对话
      throw err
    }
    lastEval += out.evalCount || 0

    if (!out.toolCalls.length) {
      // 模型直接给了最终回答（或第一轮就没走工具）
      return out.content ? { text: out.content, evalCount: lastEval } : { text: null }
    }

    convo.push({ role: 'assistant', content: out.content || '', tool_calls: out.toolCalls })
    for (const call of out.toolCalls) {
      const fname = String(call?.function?.name || '?')
      const argStr = clip(JSON.stringify(call?.function?.arguments || {}), 160)
      const result = await runChaosTool(cwd, call)
      store.addEvent(taskId, {
        type: 'status',
        name: `工具 · ${fname}`,
        content: `${argStr}\n→ ${clip(result, 300)}`,
      })
      convo.push({ role: 'tool', content: result })
    }
  }

  return { text: null, evalCount: lastEval }
}

async function runChaos({ taskId, task, agent, prompt, extraInstruction, resumeSessionId, model }) {
  const controller = new AbortController()
  const handle = { kill: () => controller.abort(), mock: true, chaos: true }
  running.set(taskId, handle)

  const stopPayload = () => {
    const intent = stopIntent.get(taskId)
    stopIntent.delete(taskId)
    if (intent === 'timeout') return { ok: false, timedOut: true, error: '执行超时，已中断' }
    return { ok: false, cancelled: true, handoff: intent === 'handoff' }
  }

  // 9.8.0：任务跑完才停 —— 固定总时长默认关闭（CONFIG.RUN_TIMEOUT=0），
  // 只在连续无输出时兜底（见 createWatchdog）
  const watchdog = createWatchdog(
    taskId,
    { hardMs: CONFIG.RUN_TIMEOUT, idleMs: CONFIG.RUN_IDLE_TIMEOUT },
    () => controller.abort(),
  )

  try {
    // 9.5.0：岗位挂了混沌就一路用混沌 —— 引擎没起不报错取消，自动拉起再试一次
    let probe = await chaosLlm.probe({ force: true })
    if (!probe.up) {
      store.addEvent(taskId, {
        type: 'status',
        name: '自动拉起引擎',
        content: '混沌推理服务没在运行，正在自动启动 ollama serve…（稍等片刻）',
      })
      try {
        await chaosLlm.ensureUp()
      } catch (err) {
        store.addEvent(taskId, {
          type: 'error',
          name: '引擎启动失败',
          content: clip(String(err?.message || err), 300),
        })
      }
      probe = await chaosLlm.probe({ force: true })
    }
    if (!probe.up) {
      throw new Error(chaosPromptUnavailable('混沌推理服务没有就绪（可能还没安装）。'))
    }
    const installed = probe.models.map((m) => m.id)
    if (installed.length && !installed.includes(model)) {
      store.addEvent(taskId, {
        type: 'status',
        name: '模型未下载',
        content: `「${model}」还没有在本机拉取，已改用已安装的 ${installed[0]}。可在「混沌」面板里下载更多模型。`,
      })
      model = installed[0]
    }

    // 「会话」= 库里的历史消息 + 本轮提示词。续跑（追问/补指令）靠历史维持上下文。
    const history = store
      .listMessages(taskId)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-CHAOS_HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: clip(m.content, CHAOS_HISTORY_CLIP) }))

    // 人设走 system 消息（不走拼进正文的那份，避免首轮重复注入）。
    // 8.0.2：叠上「专家包」人格 + 长期记忆 + 主动检索知识库（都是纯本地）。
    const systemText = String(agent.system_prompt || agent.systemPrompt || '').trim()
    const expert = chaosLlm.expertById(String(store.getSetting('chaosExpert', 'default') || 'default'))
    const memoryText = chaosLlm.memoryPrompt()
    const systemParts = []
    if (systemText) systemParts.push(systemText)
    if (expert && expert.prompt) systemParts.push(`【专家模式：${expert.label}】\n${expert.prompt}`)
    if (memoryText) {
      systemParts.push(
        '【用户长期记忆】（用户明确让你记住的偏好与事实，回答时主动遵循）\n' + memoryText,
      )
    }

    // 8.0.2：混沌主动检索知识库 —— 每个回合都拿「任务 + 本轮输入」去查一次，
    // 命中的文档片段作为参考资料注入，并在事件流里明说命中了几条。
    let kbHits = 0
    try {
      const kbContext = knowledge.contextFor(`${task.title || ''} ${prompt}`.trim().slice(0, 600))
      if (kbContext) {
        systemParts.push(kbContext)
        kbHits = (kbContext.match(/【/g) || []).length
        store.addEvent(taskId, {
          type: 'status',
          name: '知识库命中',
          content: `本轮自动检索到 ${kbHits} 条相关资料，已注入上下文（全本地检索）。`,
        })
      }
    } catch (_) {
      /* 知识库出问题不拦截对话 */
    }

    const messages = []
    if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') })
    messages.push(...history, { role: 'user', content: prompt })

    store.addEvent(taskId, {
      type: 'status',
      name: '混沌思考中',
      content: `本地推理 ${model}（免费 · 数据不出本机）${expert && expert.prompt ? ` · ${expert.emoji} ${expert.label}` : ''}`,
    })

    const started = Date.now()

    // 9.3.8：先走工具循环 —— 模型要读/写文件（自修改、改代码）就在这里发生；
    // 模型不支持工具或没用工具时退回普通流式生成。
    let text = ''
    let evalCount = 0
    let evalDuration = 0
    let doneReason = ''
    /* 9.8.2：逐字流式 —— delta 经 ws 推给前端，回答边生成边出现，
       不是憋到最后一次性砸出来 */
    const emitDelta = (d) => {
      if (d) store.bus.emit('message:delta', { taskId, delta: String(d) })
    }
    const toolFinal = await runChaosToolLoop({ taskId, cwd: task.cwd, model, messages, signal: controller.signal })
    if (toolFinal.text !== null) {
      text = toolFinal.text
      evalCount = toolFinal.evalCount || 0
      doneReason = 'stop'
    } else {
      ;({ text, evalCount, evalDuration, doneReason } = await chaosLlm.chat({
        model,
        messages,
        signal: controller.signal,
        onDelta: (d) => {
          watchdog.arm()
          emitDelta(d)
        },
      }))
    }

    // 8.0.2：长回答被截断（done_reason=length）时自动续写一次，接上而不是烂尾
    if (doneReason === 'length' && !controller.signal.aborted) {
      store.addEvent(taskId, {
        type: 'status',
        name: '自动续写',
        content: '回答在长度上限被截断，混沌正在自动接着写……',
      })
      const contMessages = [...messages, { role: 'assistant', content: String(text || '') }, { role: 'user', content: '继续。从断掉的地方无缝接着写，不要重复已有内容，写完自然收尾。' }]
      try {
        const cont = await chaosLlm.chat({ model, messages: contMessages, signal: controller.signal, onDelta: (d) => { watchdog.arm(); emitDelta(d) } })
        if (cont.text) {
          text = `${String(text || '').trimEnd()}\n${cont.text.trimStart()}`
          evalCount += cont.evalCount
          evalDuration += cont.evalDuration
        }
      } catch (_) {
        /* 续写失败就保留已有部分，不影响主回答 */
      }
    }

    const fullText = String(text || '').trim()
    if (!fullText) {
      store.addEvent(taskId, { type: 'error', name: '空回复', content: '模型没有返回内容，可重试或换个模型。' })
      return { ok: false, error: '混沌返回了空回复', sessionId: resumeSessionId || `chaos-${taskId}` }
    }

    store.addMessage(taskId, 'assistant', fullText)
    const directive = scanDirective(fullText)
    if (directive) {
      store.addEvent(taskId, {
        type: 'status',
        name: directive.kind === 'stage' ? '阶段指令' : '换岗指令',
        content: clip(directive.raw, 600),
      })
    }

    const bits = [model]
    if (evalCount) bits.push(`${evalCount} tokens`)
    if (evalDuration && evalCount) {
      const speed = Math.round((evalCount / evalDuration) * 1000)
      if (speed > 0) bits.push(`${speed} tokens/s`)
    }
    bits.push(`耗时 ${Math.round((Date.now() - started) / 100) / 10}s`)
    bits.push('本地推理 · 免费')
    store.addEvent(taskId, {
      type: 'success',
      name: '运行结束',
      content: bits.join(' · '),
    })

    // 8.0.2：把本回合统计单独记成一条事件 —— 对话页的「统计徽章」从这里读
    store.addEvent(taskId, {
      type: 'status',
      name: 'chaos:stats',
      content: JSON.stringify({
        chars: fullText.length,
        tokens: evalCount || 0,
        speed: evalDuration && evalCount ? Math.round((evalCount / evalDuration) * 1000) : 0,
        ms: Date.now() - started,
        model,
      }),
    })

    return {
      ok: true,
      sessionId: resumeSessionId || `chaos-${taskId}`,
      resultText: fullText,
      toolNames: [],
      directive: directive || null,
    }
  } catch (err) {
    if (controller.signal.aborted) {
      const p = stopPayload()
      if (!p.cancelled && !p.handoff && !p.timedOut) {
        return { ok: false, error: err.message, sessionId: resumeSessionId || `chaos-${taskId}` }
      }
      if (p.cancelled || p.handoff) {
        store.addEvent(taskId, { type: 'error', name: '已中断', content: '本次执行被主动结束。' })
      }
      return { ...p, sessionId: resumeSessionId || `chaos-${taskId}` }
    }
    const msg = String(err?.message || err)
    store.addEvent(taskId, {
      type: 'error',
      name: '混沌执行失败',
      content: clip(msg, 1500),
    })
    // 服务掉了要给用户一条能落地的指引
    if (/fetch failed|ECONNREFUSED|服务/i.test(msg)) {
      store.addMessage(taskId, 'system', `⚠️ ${chaosPromptUnavailable('混沌推理服务连不上了。')}`)
    }
    return { ok: false, error: msg, sessionId: resumeSessionId || `chaos-${taskId}` }
  } finally {
    watchdog.clear()
    if (running.get(taskId) === handle) running.delete(taskId)
    stopIntent.delete(taskId)
  }
}

/* ------------------------------------------------------------------ *
 * 9.3.8：第三方 API 执行器（OpenAI 兼容 /chat/completions）。
 * 用户在设置里填 baseURL / key / model；密钥只存本机 settings。
 * 与混沌同一套会话组装（人设 + 专家 + 记忆 + 知识库注入），只是换传输层。
 * ------------------------------------------------------------------ */

async function runApi({ taskId, task, agent, prompt, extraInstruction, resumeSessionId, model }) {
  const controller = new AbortController()
  const handle = { kill: () => controller.abort(), mock: true, chaos: true }
  running.set(taskId, handle)

  const stopPayload = () => {
    const intent = stopIntent.get(taskId)
    stopIntent.delete(taskId)
    if (intent === 'timeout') return { ok: false, timedOut: true, error: '执行超时，已中断' }
    return { ok: false, cancelled: true, handoff: intent === 'handoff' }
  }

  // 9.8.0：任务跑完才停 —— 固定总时长默认关闭（CONFIG.RUN_TIMEOUT=0），
  // 只在连续无输出时兜底（见 createWatchdog）
  const watchdog = createWatchdog(
    taskId,
    { hardMs: CONFIG.RUN_TIMEOUT, idleMs: CONFIG.RUN_IDLE_TIMEOUT },
    () => controller.abort(),
  )

  try {
    const cfg = executors.apiConfig()
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      throw new Error('第三方 API 还没配置好：到 设置 → 第三方 API，填接口地址、密钥与模型名。')
    }

    const history = store
      .listMessages(taskId)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-CHAOS_HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: clip(m.content, CHAOS_HISTORY_CLIP) }))

    const systemText = String(agent.system_prompt || agent.systemPrompt || '').trim()
    const expert = chaosLlm.expertById(String(store.getSetting('chaosExpert', 'default') || 'default'))
    const memoryText = chaosLlm.memoryPrompt()
    const systemParts = []
    if (systemText) systemParts.push(systemText)
    if (expert && expert.prompt) systemParts.push(`【专家模式：${expert.label}】\n${expert.prompt}`)
    if (memoryText) {
      systemParts.push('【用户长期记忆】（用户明确让你记住的偏好与事实，回答时主动遵循）\n' + memoryText)
    }
    try {
      const kbContext = knowledge.contextFor(`${task.title || ''} ${prompt}`.trim().slice(0, 600))
      if (kbContext) systemParts.push(kbContext)
    } catch (_) {
      /* 知识库出问题不拦截对话 */
    }

    const messages = []
    if (systemParts.length) messages.push({ role: 'system', content: systemParts.join('\n\n') })
    messages.push(...history, { role: 'user', content: prompt })

    const useModel = cfg.model || model
    store.addEvent(taskId, {
      type: 'status',
      name: '第三方 API',
      content: `${useModel} @ ${cfg.baseUrl}（密钥只存在本机）`,
    })

    const started = Date.now()
    const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({ model: useModel, messages }),
      signal: controller.signal,
    })
    if (!res.ok) {
      let detail = ''
      try {
        const b = await res.json()
        detail = String(b?.error?.message || b?.error || '')
      } catch (_) {
        /* ignore */
      }
      throw new Error(`第三方 API 返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`)
    }
    const body = await res.json()
    const fullText = String(body?.choices?.[0]?.message?.content || '').trim()
    if (!fullText) throw new Error('第三方 API 返回了空回复')

    store.addMessage(taskId, 'assistant', fullText)
    const directive = scanDirective(fullText)
    if (directive) {
      store.addEvent(taskId, {
        type: 'status',
        name: directive.kind === 'stage' ? '阶段指令' : '换岗指令',
        content: clip(directive.raw, 600),
      })
    }

    const usage = body?.usage || {}
    const tokens = Number(usage.completion_tokens) || 0
    store.addEvent(taskId, {
      type: 'success',
      name: '运行结束',
      content: `${useModel} · ${tokens || fullText.length + ' 字'} · 耗时 ${Math.round((Date.now() - started) / 100) / 10}s · 第三方 API`,
    })
    store.addEvent(taskId, {
      type: 'status',
      name: 'chaos:stats',
      content: JSON.stringify({
        chars: fullText.length,
        tokens,
        speed: 0,
        ms: Date.now() - started,
        model: useModel,
        via: 'api',
      }),
    })

    return {
      ok: true,
      sessionId: resumeSessionId || `api-${taskId}`,
      resultText: fullText,
      toolNames: [],
      directive: directive || null,
    }
  } catch (err) {
    if (controller.signal.aborted) {
      const p = stopPayload()
      if (!p.cancelled && !p.handoff && !p.timedOut) {
        return { ok: false, error: err.message, sessionId: resumeSessionId || `api-${taskId}` }
      }
      return { ...p, sessionId: resumeSessionId || `api-${taskId}` }
    }
    const msg = String(err?.message || err)
    store.addEvent(taskId, { type: 'error', name: '第三方 API 执行失败', content: clip(msg, 1500) })
    return { ok: false, error: msg, sessionId: resumeSessionId || `api-${taskId}` }
  } finally {
    watchdog.clear()
    if (running.get(taskId) === handle) running.delete(taskId)
    stopIntent.delete(taskId)
  }
}

/* ------------------------------------------------------------------ *
 * 对外入口
 * ------------------------------------------------------------------ */

/** 决定这次跑用哪个执行器、哪个模型：任务覆盖 > Agent 设置 > 执行器默认（9.3.8：默认混沌） */
function resolveRuntime(task, agent) {
  const executor = task.executor || agent.executor || 'chaos'
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
async function execute({ task, agent, extraInstruction = '', resumeSessionId = null, handoffBrief = '' }) {
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

  // 阶段上下文：本任务实际走哪条流水线（任务 > 岗位 > seed 默认 > executor 默认），
  // 以及现在在哪一步。只用来拼提示词与校验指令，不改数据库。
  const stages = pipeline.resolve(
    task,
    agent,
    store.getSetting('pipelineEnabled', '1') === '1',
    DEFAULT_AGENTS.find((a) => a.role === agent.role) || null,
  )
  const currentStage = task.stage || (stages[0] && stages[0].stage) || ''
  const stageInfo = stages.length
    ? {
        pipeline: stages,
        current: currentStage,
        index: Math.max(0, pipeline.stageIndex(stages, currentStage)),
      }
    : null

  // 知识库注入：首轮按任务内容检索全库，命中才拼进提示词（设置可关）。
  // 纯本地 LIKE 评分，不联网、不加延迟（sql.js 在内存里，查询是同步的）。
  const kbEnabled = store.getSetting('kbInjectEnabled', '1') === '1'
  const kbQuery = `${task.title || ''} ${task.description || ''}`.slice(0, 400)
  const kb = kbEnabled && kbQuery.trim() ? knowledge.contextFor(kbQuery) : ''

  const prompt = composePrompt({
    systemPrompt: agent.system_prompt || agent.systemPrompt || '',
    task,
    extraInstruction,
    isResume,
    envNote: executor === 'deveco' ? executors.devecoEnvNote() : '',
    stage: stageInfo,
    roster: store.listAgents(),
    handoffBrief,
    kb,
  })

  // 混沌执行器：HTTP 流式调用本机推理服务，不 spawn CLI。
  // 必须在 bin 探测之前分流 —— executorBinary 认不得它。
  if (executor === 'chaos') {
    store.addEvent(taskId, {
      type: 'status',
      name: '执行器',
      content: `chaos · ${model}${isResume ? ' · 续跑' : ''}`,
    })
    if (CONFIG.FORCE_MOCK) {
      const mock = await runMock({ taskId, task, agent, extraInstruction })
      cleanupRunScope(taskId)
      return { ...mock, executor, directive: mock.directive || null }
    }
    const result = await runChaos({ taskId, task, agent, prompt, extraInstruction, resumeSessionId, model })
    cleanupRunScope(taskId)
    if (!result.ok && !result.cancelled && !result.timedOut) {
      // 本地大模型失败通常等于「没装/没起」：保持任务在「需要输入」，
      // 并把安装引导写进对话，而不是默默换岗重试烧时间。
      store.addMessage(taskId, 'system', `💡 混沌本次没能执行：${result.error || '未知原因'}`)
    }
    return { ...result, executor, directive: result.directive || null }
  }

  // 9.3.8：第三方 API 执行器（OpenAI 兼容）—— 同样走 HTTP，不 spawn CLI
  if (executor === 'api') {
    store.addEvent(taskId, {
      type: 'status',
      name: '执行器',
      content: `api · ${model}${isResume ? ' · 续跑' : ''}`,
    })
    if (CONFIG.FORCE_MOCK) {
      const mock = await runMock({ taskId, task, agent, extraInstruction })
      cleanupRunScope(taskId)
      return { ...mock, executor, directive: mock.directive || null }
    }
    const result = await runApi({ taskId, task, agent, prompt, extraInstruction, resumeSessionId, model })
    cleanupRunScope(taskId)
    if (!result.ok && !result.cancelled && !result.timedOut) {
      store.addMessage(taskId, 'system', `💡 第三方 API 本次没能执行：${result.error || '未知原因'}`)
    }
    return { ...result, executor, directive: result.directive || null }
  }

  const bin = executorBinary(executor)
  const canRunReal = !CONFIG.FORCE_MOCK && Boolean(bin)

  store.addEvent(taskId, {
    type: 'status',
    name: '执行器',
    content: `${executor}${model ? ` · ${model}` : ''}${isResume ? ' · 续跑' : ''}`,
  })

  if (!canRunReal) {
    const mock = await runMock({ taskId, task, agent, extraInstruction })
    // 模拟路径也要清掉按岗位挂载留下的临时文件与令牌
    cleanupRunScope(taskId)
    // 模拟路径的指令由标题标记驱动（见 runMock），照样交给调用方
    return { ...mock, executor, directive: mock.directive || null }
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

  // 按岗位挂 MCP：
  //   claude  → 写一份本次运行的临时配置，用 --mcp-config + --strict-mcp-config 启动
  //   deveco  → 走 DEVECO_CONFIG_CONTENT 内联覆盖（实测按 key 合并，能逐项关掉）
  // 令牌给 agent 的「换岗」MCP 工具用，运行结束即吊销。
  // 任何一步失败都只是「这次不按岗位挂」，不影响运行本身。
  const handoffToken = mcpScope.scopeEnabled() ? runtime.mintHandoffToken(taskId) : ''
  const mcpConfigPath = isClaude
    ? mcpScope.buildClaudeConfig(task, agent, { token: handoffToken, claudeBin: bin })
    : ''
  const extraEnv = isClaude ? {} : mcpScope.buildDevecoEnv(task, agent, { token: handoffToken })

  const args = isClaude
    ? buildClaudeArgs({ resumeSessionId, model, mcpConfigPath, strictMcp: mcpScope.strictMode() })
    : buildDevecoArgs({ resumeSessionId, model, cwd })
  const parser = isClaude ? createClaudeParser(taskId) : createDevecoParser(taskId)
  const label = isClaude ? 'claude' : 'deveco'

  const messagesBefore = store.listMessages(taskId).length
  const result = await runReal({ taskId, bin, args, prompt, parser, cwd, label, extraEnv })

  // CLI 真的不存在/不可执行 → 退回模拟，保证界面仍然可用
  if (result.spawnFailed) {
    store.addEvent(taskId, {
      type: 'system',
      name: '降级为模拟执行',
      content: `无法启动 ${label}（${result.error}），本次改用模拟模式。`,
    })
    const mock = await runMock({ taskId, task, agent, extraInstruction })
    // 模拟路径也要清掉按岗位挂载留下的临时文件与令牌
    cleanupRunScope(taskId)
    // 模拟路径的指令由标题标记驱动（见 runMock），照样交给调用方
    return { ...mock, executor, directive: mock.directive || null }
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

  // directive 交给调用方（queue）判断怎么用：解析器只负责识别，不认识岗位
  return { ...result, executor, directive: result.directive || parser.state.directive || null }
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

/**
 * 结束某个任务的进程。
 *
 * intent 决定这次结束**怎么被解释**（见 stopIntent 的注释）：
 *   'cancel'  用户主动取消 → 调用方落 backlog/cancelled
 *   'handoff' 换岗 → 调用方走交接，不落 cancelled
 * 默认 'cancel'，保持所有既有调用点的语义不变。
 */
function cancel(taskId, intent = 'cancel') {
  const child = running.get(taskId)
  if (!child) return false
  stopIntent.set(taskId, intent === 'handoff' ? 'handoff' : 'cancel')
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

/** 任务被删除时清掉它的模拟计数（否则这张表只增不减） */
function forgetAttempts(taskId) {
  mockAttempts.delete(taskId)
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
  forgetAttempts,
}
