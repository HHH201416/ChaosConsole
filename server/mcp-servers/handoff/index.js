'use strict'

/**
 * 「岗位交接」MCP 服务器（应用内部用，不发布到 npm）。
 *
 * 作用：让 Agent 在工作过程中**主动**把任务交给更合适的岗位，或者推进阶段。
 * 它是「agent 自己决定换岗」两条通道里的第二条（第一条是输出里的
 * `CHAOS_HANDOFF: {...}` 文本指令）—— 两条最终都汇进后端的同一个换岗原语。
 *
 * 与其它 MCP 服务器的区别：它**不做全局注册**。每次运行由 server/mcp-scope.js
 * 写进临时配置，并注入三个环境变量：
 *   CHAOS_SERVER_URL      后端地址（端口是运行时决定的，不能写死）
 *   CHAOS_TASK_ID         本次运行属于哪个任务
 *   CHAOS_HANDOFF_TOKEN   本次运行的一次性令牌（运行结束即吊销）
 * 令牌的意义：跑完的、或别的任务里的 MCP 子进程，拿旧令牌切不动任何任务。
 *
 * 协议实现与 deveco-studio 那台一致：手写 stdio JSON-RPC，不引 SDK。
 */

const SERVER_URL = process.env.CHAOS_SERVER_URL || 'http://127.0.0.1:43117'
const TASK_ID = process.env.CHAOS_TASK_ID || ''
const TOKEN = process.env.CHAOS_HANDOFF_TOKEN || ''

const TOOLS = [
  {
    name: 'switch_role',
    description:
      '把当前任务交接给另一个岗位，或推进到下一个阶段。适合「这一步不是我的专长」「需要构建/测试岗位接手」这类情况。交接后你会结束当前回合，对方会拿到任务背景继续做。',
    inputSchema: {
      type: 'object',
      properties: {
        role: {
          type: 'string',
          description: '接手岗位的 role 代码（如 HarmonyBuild）。不填则按阶段自动挑',
        },
        stage: { type: 'string', description: '推进到哪个阶段（如 build）。与 role 二选一' },
        reason: { type: 'string', description: '一句话说明为什么交接（会写进交接说明）' },
        summary: { type: 'string', description: '给接手人的交接说明：做到哪了、还剩什么' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'current_task',
    description: '查看当前任务的状态：标题、所在阶段、流水线、可交接的岗位列表。',
    inputSchema: { type: 'object', properties: {} },
  },
]

async function callApi(method, body, query = '') {
  if (!TOKEN || !TASK_ID) {
    return { ok: false, text: '缺少运行期令牌（这个 MCP 只能由 ChaosConsole 在任务运行时注入）' }
  }
  const url = `${SERVER_URL}/api/internal/handoff${query}`
  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: method === 'POST' ? JSON.stringify({ ...body, taskId: TASK_ID, token: TOKEN }) : undefined,
      signal: AbortSignal.timeout(15000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) {
      return { ok: false, text: data.error || `后端返回 HTTP ${res.status}` }
    }
    return { ok: true, text: JSON.stringify(data.data || data, null, 2) }
  } catch (err) {
    return { ok: false, text: `连不上后端（${err.message}）` }
  }
}

async function runSwitch(args) {
  const r = await callApi('POST', {
    role: args.role || '',
    stage: args.stage || '',
    reason: args.reason || 'Agent 请求交接',
    summary: args.summary || '',
  })
  if (!r.ok) {
    return {
      ok: false,
      text: `${r.text}\n（这条通道没成功。你可以改用文本指令：在回复里单独一行写 CHAOS_HANDOFF: {"role":"岗位代码","reason":"原因"}）`,
    }
  }
  return { ok: true, text: `已请求交接，当前回合结束后生效。\n${r.text}` }
}

async function runCurrent() {
  const r = await callApi('GET', null, `?taskId=${encodeURIComponent(TASK_ID)}&token=${encodeURIComponent(TOKEN)}`)
  return r
}

/* ------------------------------------------------------------------ *
 * MCP stdio 协议
 * ------------------------------------------------------------------ */

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg
  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'chaos-handoff', version: '1.0.0' },
      })
    case 'notifications/initialized':
      return
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments || {}
      let r
      if (name === 'switch_role') r = await runSwitch(args)
      else if (name === 'current_task') r = await runCurrent()
      else return replyError(id, -32602, `未知工具：${name}`)
      return reply(id, {
        content: [{ type: 'text', text: r.text || '(无输出)' }],
        isError: r.ok === false,
      })
    }
    case 'ping':
      return reply(id, {})
    default:
      if (id !== undefined) replyError(id, -32601, `不支持的方法：${method}`)
  }
}

let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  let nl
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    let msg
    try {
      msg = JSON.parse(line)
    } catch (_) {
      continue
    }
    handle(msg).catch(() => {})
  }
})
process.stdin.on('end', () => process.exit(0))
