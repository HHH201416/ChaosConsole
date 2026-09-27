#!/usr/bin/env node
'use strict'

/**
 * DevEco Studio 桌面控制 MCP 服务器。
 *
 * 把 scripts/deveco-studio.py 的能力包成 MCP 工具，让 Agent 在会话里直接调用：
 * 打开工程、截图看界面、跑 hvigor 构建、用 hdc 装到设备上。
 *
 * 不依赖 @modelcontextprotocol/sdk —— 本仓库的 MCP 服务器是「即装即用」地装进
 * 用户目录再注册给 claude 的，多一个依赖就多一次安装失败的机会。stdio 传输的
 * 协议本身很薄（换行分隔的 JSON-RPC），自己实现反而更可控。
 *
 * 实现说明：所有实际操作都委托给 Python 脚本，因为 Windows 的执行策略默认禁止
 * 运行 .ps1，而 Python 不受该策略约束。见 scripts/deveco-studio.py 顶部注释。
 */

const path = require('path')
const { spawn } = require('child_process')

/**
 * Python 脚本的位置。
 *
 * 优先用 CHAOS_DEVECO_SCRIPT —— 这个服务器会被复制到 %APPDATA% 下的稳定目录再注册
 * （见 server/mcp.js 的 materializeLocalServer），复制过去的副本旁边没有 scripts/，
 * 相对路径就找不到脚本了。注册时由 mcp.js 把这个环境变量一起写进配置。
 * 开发时直接跑仓库里的文件，走下面的相对路径兜底。
 */
const SCRIPT =
  process.env.CHAOS_DEVECO_SCRIPT ||
  path.resolve(__dirname, '..', '..', '..', 'scripts', 'deveco-studio.py')

/** 找一个可用的 python：优先环境变量，其次 py / python3 / python */
function resolvePython() {
  if (process.env.CHAOS_PYTHON) return process.env.CHAOS_PYTHON
  return process.platform === 'win32' ? 'python' : 'python3'
}

let nextId = 1

function runScript(args, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const py = resolvePython()
    const child = spawn(py, [SCRIPT, ...args], { windowsHide: true })
    let out = ''
    let err = ''
    let done = false
    const finish = (obj) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        child.kill()
      } catch (_) {
        /* ignore */
      }
      resolve(obj)
    }
    const timer = setTimeout(() => finish({ ok: false, error: `执行超时（${timeoutMs}ms）` }), timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('error', (e) =>
      finish({ ok: false, error: `无法启动 Python（${py}）：${e.message}。请安装 Python，或用 CHAOS_PYTHON 指定解释器路径。` }),
    )
    child.on('close', (code) => {
      const text = (out + (err ? `\n${err}` : '')).trim()
      finish({ ok: code === 0, text, code })
    })
  })
}

const TOOLS = [
  {
    name: 'studio_status',
    description: '查看 DevEco Studio 是否在运行、窗口标题、以及本机 hvigorw / hdc / ohpm 的绝对路径。',
    inputSchema: { type: 'object', properties: {} },
    run: () => runScript(['status']),
  },
  {
    name: 'studio_launch',
    description: '启动 DevEco Studio，可选地直接打开某个工程目录。已在运行时只切到前台，不会重复启动。',
    inputSchema: {
      type: 'object',
      properties: { projectPath: { type: 'string', description: '要打开的工程目录，留空则只启动 IDE' } },
    },
    run: (a) => runScript(['launch', a.projectPath || ''], 60000),
  },
  {
    name: 'studio_focus',
    description: '把 DevEco Studio 窗口切到前台并设置键盘焦点。',
    inputSchema: { type: 'object', properties: {} },
    run: () => runScript(['focus']),
  },
  {
    name: 'studio_screenshot',
    description:
      '截取 DevEco Studio 窗口的截图并返回文件路径。这是「看」IDE 当前状态的主要手段：' +
      '构建是否成功、报错在哪一行、界面停在哪个对话框，都靠它。',
    inputSchema: {
      type: 'object',
      properties: { outputPath: { type: 'string', description: '保存路径，留空则存到临时目录' } },
    },
    run: (a) => runScript(['shot', a.outputPath || '']),
  },
  {
    name: 'studio_action',
    description:
      '通过 IntelliJ 的「Find Action」执行 IDE 动作，等价于在 IDE 里按 Ctrl+Shift+A 再输入动作名。' +
      '例如 "Build Hap(s)/APP(s)"、"Sync And Refresh Project"、"Open Settings"。',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '动作名（IDE 英文界面下的写法）' } },
      required: ['name'],
    },
    run: (a) => runScript(['action', a.name]),
  },
  {
    name: 'studio_hotkey',
    description: '向 DevEco Studio 发送快捷键，如 "^+a"（^=Ctrl +=Shift %=Alt）。',
    inputSchema: {
      type: 'object',
      properties: { keys: { type: 'string' } },
      required: ['keys'],
    },
    run: (a) => runScript(['hotkey', a.keys]),
  },
  {
    name: 'studio_build_hap',
    description:
      '在指定工程目录下用 hvigorw 构建 hap。这是最可靠、最常用的构建方式 —— ' +
      '不依赖 IDE 界面，直接出产物，结果在 stdout 里。',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: { type: 'string', description: '鸿蒙工程根目录（含 hvigorw 与 build-profile.json5 的那一层）' },
        module: { type: 'string', description: '模块名，默认 entry' },
        product: { type: 'string', description: 'product 名，默认 default' },
      },
      required: ['projectPath'],
    },
    run: (a) => runHvigor(a),
  },
  {
    name: 'studio_hdc',
    description: '调用 hdc 与设备/模拟器交互：列出设备、安装 hap、查看日志。',
    inputSchema: {
      type: 'object',
      properties: {
        subcommand: { type: 'string', description: '例如 "list targets"、"install <hap路径>"、"hilog"' },
      },
      required: ['subcommand'],
    },
    run: (a) => runHdc(a.subcommand),
  },
]

/** hvigorw / hdc 的路径由 python 脚本的 status 给出，这里解析一下 */
async function toolPaths() {
  const r = await runScript(['status'], 30000)
  try {
    return JSON.parse(r.text)
  } catch (_) {
    return {}
  }
}

async function runHvigor(a) {
  const t = await toolPaths()
  if (!t.hvigorw) return { ok: false, text: '没找到 hvigorw，请确认已安装 DevEco Studio' }
  const args = ['assembleHap', '--mode', 'module', '-p', `product=${a.product || 'default'}`]
  if (a.module) args.push('-p', `module=${a.module}`)
  return runShell(t.hvigorw, args, a.projectPath)
}

async function runHdc(sub) {
  const t = await toolPaths()
  if (!t.hdc) return { ok: false, text: '没找到 hdc，请确认已安装 DevEco Studio' }
  const parts = String(sub || '').split(/\s+/).filter(Boolean)
  return runShell(t.hdc, parts, undefined)
}

function runShell(bin, args, cwd) {
  return new Promise((resolve) => {
    // .bat 在 Windows 上必须经 cmd.exe 转发
    const isWin = process.platform === 'win32'
    const cmd = isWin ? `"${bin}" ${args.map((x) => `"${x}"`).join(' ')}` : bin
    const child = spawn(cmd, isWin ? [] : args, { cwd, shell: isWin, windowsHide: true })
    let out = ''
    let err = ''
    let done = false
    const finish = (obj) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(obj)
    }
    const timer = setTimeout(() => finish({ ok: false, text: `执行超时\n${out}${err}` }), 600000)
    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('error', (e) => finish({ ok: false, text: `启动失败：${e.message}` }))
    child.on('close', (code) => finish({ ok: code === 0, text: (out + err).trim().slice(-8000), code }))
  })
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
        serverInfo: { name: 'chaos-deveco-studio', version: '1.0.0' },
      })
    case 'notifications/initialized':
      return
    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      })
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return replyError(id, -32602, `未知工具：${params?.name}`)
      try {
        const r = await tool.run(params.arguments || {})
        return reply(id, {
          content: [{ type: 'text', text: r.ok === false ? `失败：${r.text || r.error}` : r.text || '(无输出)' }],
          isError: r.ok === false,
        })
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: `执行异常：${e.message}` }], isError: true })
      }
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
