'use strict'

/**
 * MCP（Model Context Protocol）服务器管理。
 *
 * 设计要点：
 *
 * 1. 包不通过 `npx -y` 每次现拉，而是**预装到一个固定目录**
 *    （%APPDATA%\chaos-console\mcp），注册时写绝对路径。
 *    原因：`npx -y` 在首次使用时才下载，会超过 CLI 的健康检查超时，
 *    表现为「装上了但连不上」；而且每次会话启动都要解析一遍，又慢又不稳。
 *
 * 2. 只有「不需要密钥就能跑起来」的服务器才会被真正注册。
 *    需要密钥的（GitHub / Slack / Postgres…）在目录里列出来，填了密钥才启用 ——
 *    否则它们会在每次 Agent 会话里连接失败，白白占用上下文和启动时间。
 *
 * 3. 同时写给两个 CLI：
 *    - claude：走 `claude mcp add -s user`（~/.claude.json 是 Claude Code 的状态
 *      文件，直接改风险大，交给官方 CLI 写）
 *    - deveco：直接写 ~/.config/deveco/deveco.jsonc 的 mcp 段（opencode 格式）
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

const executors = require('./executors')

const MCP_DIR = path.join(process.env.APPDATA || os.homedir(), 'chaos-console', 'mcp')
const DEVECO_CONFIG = path.join(os.homedir(), '.config', 'deveco', 'deveco.jsonc')

/* ------------------------------------------------------------------ *
 * 目录
 * ------------------------------------------------------------------ */

/**
 * allowedDirs：filesystem 服务器允许访问的目录。
 * category：installable（装完即用） | needs-key（需要密钥）
 */
const CATALOG = [
  {
    id: 'filesystem',
    label: '文件系统',
    desc: '读写本地文件与目录，Agent 操作工程文件的基础能力',
    pkg: '@modelcontextprotocol/server-filesystem',
    entry: 'dist/index.js',
    category: 'installable',
    argsFor: () => allowedDirs(),
  },
  {
    id: 'memory',
    label: '长期记忆',
    desc: '基于知识图谱的跨会话记忆，Agent 可以记住项目上下文',
    pkg: '@modelcontextprotocol/server-memory',
    entry: 'dist/index.js',
    category: 'installable',
    argsFor: () => [],
    env: () => ({ MEMORY_FILE_PATH: path.join(MCP_DIR, 'memory.json') }),
  },
  {
    id: 'sequential-thinking',
    label: '结构化推理',
    desc: '把复杂问题拆成可回溯的推理步骤，提升方案质量',
    pkg: '@modelcontextprotocol/server-sequential-thinking',
    entry: 'dist/index.js',
    category: 'installable',
    argsFor: () => [],
  },
  {
    id: 'context7',
    label: '技术文档检索',
    desc: '实时拉取库和框架的最新官方文档，避免 API 记错版本',
    pkg: '@upstash/context7-mcp',
    entry: 'dist/index.js',
    category: 'installable',
    argsFor: () => [],
    envKeys: ['CONTEXT7_API_KEY'],
  },
  {
    id: 'playwright',
    label: '浏览器自动化',
    desc: '微软官方 Playwright MCP：打开网页、点击、填表、截图',
    pkg: '@playwright/mcp',
    entry: 'cli.js',
    category: 'installable',
    argsFor: () => [],
  },
  {
    id: 'chrome-devtools',
    label: 'Chrome 调试',
    desc: '谷歌官方 Chrome DevTools MCP：性能分析、网络抓包、控制台调试',
    pkg: 'chrome-devtools-mcp',
    entry: 'build/src/bin/chrome-devtools-mcp.js',
    category: 'installable',
    argsFor: () => [],
  },
  {
    id: 'everything',
    label: '官方参考实现',
    desc: 'MCP 官方示例服务器，用于验证客户端连接与工具发现是否正常',
    pkg: '@modelcontextprotocol/server-everything',
    entry: 'dist/index.js',
    category: 'installable',
    argsFor: () => [],
  },

  /* ---- 需要密钥：填了才启用 ---- */
  {
    id: 'github',
    label: 'GitHub',
    desc: '读写仓库、Issue、PR',
    pkg: '@modelcontextprotocol/server-github',
    entry: 'dist/index.js',
    category: 'needs-key',
    argsFor: () => [],
    envKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    keyHint: 'GitHub Personal Access Token（repo 权限）',
  },
  {
    id: 'gitlab',
    label: 'GitLab',
    desc: '读写 GitLab 项目与合并请求',
    pkg: '@modelcontextprotocol/server-gitlab',
    entry: 'dist/index.js',
    category: 'needs-key',
    argsFor: () => [],
    envKeys: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    keyHint: 'GitLab Personal Access Token',
  },
  {
    id: 'slack',
    label: 'Slack',
    desc: '读取频道消息、发送通知',
    pkg: '@modelcontextprotocol/server-slack',
    entry: 'dist/index.js',
    category: 'needs-key',
    argsFor: () => [],
    envKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
    keyHint: 'Slack Bot Token 与 Team ID',
  },
  {
    id: 'brave-search',
    label: 'Brave 搜索',
    desc: '联网搜索，给调研类 Agent 用',
    pkg: '@modelcontextprotocol/server-brave-search',
    entry: 'dist/index.js',
    category: 'needs-key',
    argsFor: () => [],
    envKeys: ['BRAVE_API_KEY'],
    keyHint: 'Brave Search API Key',
  },
  {
    id: 'postgres',
    label: 'PostgreSQL',
    desc: '只读查询 Postgres 数据库',
    pkg: '@modelcontextprotocol/server-postgres',
    entry: 'dist/index.js',
    category: 'needs-key',
    requiresArg: '连接串，例如 postgresql://user:pass@localhost/db',
    argsFor: (opts) => (opts && opts.arg ? [opts.arg] : []),
  },
  {
    id: 'redis',
    label: 'Redis',
    desc: '读写 Redis 键值',
    pkg: '@modelcontextprotocol/server-redis',
    entry: 'dist/index.js',
    category: 'needs-key',
    argsFor: () => [],
    envKeys: ['REDIS_URL'],
    keyHint: 'Redis 连接串，例如 redis://localhost:6379',
  },
  {
    id: 'google-maps',
    label: 'Google 地图',
    desc: '地理编码、路线规划、地点检索',
    pkg: '@modelcontextprotocol/server-google-maps',
    entry: 'dist/index.js',
    category: 'needs-key',
    argsFor: () => [],
    envKeys: ['GOOGLE_MAPS_API_KEY'],
    keyHint: 'Google Maps API Key',
  },
  {
    id: 'firecrawl',
    label: 'Firecrawl 抓取',
    desc: '整站抓取并转成结构化 Markdown',
    pkg: 'firecrawl-mcp',
    entry: 'dist/index.js',
    category: 'needs-key',
    argsFor: () => [],
    envKeys: ['FIRECRAWL_API_KEY'],
    keyHint: 'Firecrawl API Key',
  },
]

const CATALOG_BY_ID = Object.fromEntries(CATALOG.map((c) => [c.id, c]))

/** filesystem 允许访问的目录，可在设置里覆盖（分号分隔） */
let allowedDirsOverride = null
function setAllowedDirs(dirs) {
  allowedDirsOverride = Array.isArray(dirs) && dirs.length ? dirs : null
}
function allowedDirs() {
  if (allowedDirsOverride) return allowedDirsOverride
  const dirs = []
  if (process.platform === 'win32') dirs.push('D:\\')
  dirs.push(os.homedir())
  return dirs
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function ensureDir() {
  fs.mkdirSync(MCP_DIR, { recursive: true })
  const pkgFile = path.join(MCP_DIR, 'package.json')
  if (!fs.existsSync(pkgFile)) {
    fs.writeFileSync(
      pkgFile,
      JSON.stringify(
        { name: 'chaos-console-mcp', private: true, description: 'ChaosConsole MCP 服务器集合', dependencies: {} },
        null,
        2,
      ),
    )
  }
  return MCP_DIR
}

/** 找系统里真实的 node（打包后 process.execPath 是 Electron，不能直接用） */
let cachedNode = null
function resolveNodeBin() {
  if (cachedNode) return cachedNode
  const isWin = process.platform === 'win32'
  const names = isWin ? ['node.exe', 'node'] : ['node']
  const dirs = []
  if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, 'nodejs'))
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'))
  dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin')
  if (process.env.PATH) dirs.push(...process.env.PATH.split(path.delimiter))

  for (const dir of dirs) {
    if (!dir) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          cachedNode = candidate
          return cachedNode
        }
      } catch (_) {
        /* ignore */
      }
    }
  }
  // 兜底：拿 Electron 可执行文件当 node 用。注意它只有在设置了
  // ELECTRON_RUN_AS_NODE=1 时才是 node，否则会再拉起一个应用窗口 ——
  // 该环境变量由 nodeLaunchEnv() 一起写进注册配置。
  cachedNode = process.execPath
  return cachedNode
}

/**
 * 兜底成 process.execPath 时要额外注入的环境变量。
 *
 * 注册出去的是一条 `命令 + 参数`，由 CLI 自己 spawn，不会经过 Electron 主进程，
 * 所以必须由我们显式带上 ELECTRON_RUN_AS_NODE=1，否则那条命令启动的是第二个
 * ChaosConsole 应用（界面看着注册成功，MCP 永远连不上）。
 * 找到了真 node 时返回空对象，行为与以前完全一致。
 */
function nodeLaunchEnv() {
  return resolveNodeBin() === process.execPath ? { ELECTRON_RUN_AS_NODE: '1' } : {}
}

function entryPath(server) {
  return path.join(MCP_DIR, 'node_modules', ...server.pkg.split('/'), ...server.entry.split('/'))
}

function isPackageInstalled(server) {
  return fs.existsSync(entryPath(server))
}

/**
 * 给参数补引号。
 *
 * Windows：runAsync 走 shell:true，参数最终由 cmd.exe 再解析一遍。
 *  - 只在含空格时才补引号是错的：`&`、`|`、`>` 会被 cmd 当成控制符。
 *    postgres 连接串 `...?a=1&b=2` 会被从 `&` 处截断后注册（半截字符串），
 *    `b=2` 还会被当成第二条命令执行 —— 既是静默的参数损坏，也是命令注入。
 *  - 补了引号还要遵守 CreateProcess/MSVCRT 的解析规则：只有紧跟在引号前的
 *    `\` 才有转义含义，所以尾随反斜杠必须翻倍，否则 `D:\`（filesystem 的
 *    allowedDirs 就会传这个）会被解析成 `D:"`。
 *  - `%VAR%` 在引号内**仍然**会被 cmd 展开，而引号内的 `^` 是普通字符、
 *    转义无效，所以只能在 `%` 处把引号断开，用引号外的 `^%` 写出字面 `%`。
 *  - `&|<>()`、`!`、`^` 在引号内本来就是普通字符（`!` 只在 cmd /V:on 下才有
 *    意义，而 node 起的是 /d /s /c），再补一层 `^` 反而会凭空多出一个 `^`
 *    字符，所以只靠引号屏蔽，不做 caret 转义。以上几条都是实测过的：
 *    spawn(shell:true) 起一个只回显 argv 的进程，逐个用例比对原串。
 *
 * 非 Windows：runAsync 是 shell:false，参数直接进 argv，一个字都不能动 ——
 * 补引号会把引号变成路径的一部分（`/home/me/My Projects` 会带上字面引号）。
 */
function quoteArg(arg) {
  const s = String(arg)
  if (process.platform !== 'win32') return s
  // 先按 `%` 切开，每段各自加引号，段间用引号外的 ^% 连接
  return s.split('%').map(quoteWinSegment).join('^%')
}

/** 单个片段：双引号包裹，并按 MSVCRT 规则处理内部引号与前置反斜杠 */
function quoteWinSegment(part) {
  let out = '"'
  let backslashes = 0
  for (const ch of part) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    // 引号前的反斜杠要翻倍（2n+1 个才能既保留 n 个 \ 又得到一个字面 "）
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}

/**
 * 结束整棵进程树。
 *
 * Windows 下 shell:true 时 child 只是包了一层的 cmd.exe，child.kill() 杀掉
 * 的只是 cmd，真正的活儿（npm install / claude mcp add）会变成孤儿继续跑 ——
 * 表现为「已经报超时了，node_modules 还在被写」。做法与 runner.js 的
 * killTree 一致。
 */
function killTree(child) {
  if (!child) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch (err) {
    console.error('[mcp] 结束进程失败:', err.message)
  }
}

/**
 * 异步执行外部命令。
 *
 * 必须异步：`npm install` 和 `claude mcp add` 都要跑好几秒，用 spawnSync 会把
 * 整个 Node 事件循环按住 —— WebSocket 推送、API 响应全部停摆，表现为整个应用卡死。
 */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child
    try {
      // 命令名也要走同一套引号处理：Windows 下 shell:true 时 node 只是把
      // cmd 和 args 用空格拼起来，命令名（例如 claude.cmd 的绝对路径）只要
      // 含空格就会被 cmd 拆坏，表现为静默失败。实测 `"npm"` 这种写法在
      // cmd 下正常，所以加引号是安全的。
      const spawnCmd = process.platform === 'win32' ? quoteArg(cmd) : cmd
      child = spawn(spawnCmd, args, {
        windowsHide: true,
        shell: process.platform === 'win32',
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
      })
    } catch (err) {
      return resolve({ status: -1, stdout: '', stderr: err.message })
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      killTree(child)
      resolve({ status: -1, stdout, stderr: stderr + '\n(执行超时)' })
    }, opts.timeout || 180000)

    child.stdout?.on('data', (c) => {
      stdout += c.toString()
    })
    child.stderr?.on('data', (c) => {
      stderr += c.toString()
    })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: -1, stdout, stderr: err.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status: code, stdout, stderr })
    })
  })
}


/* ------------------------------------------------------------------ *
 * 安装 / 卸载
 * ------------------------------------------------------------------ */

async function installPackages(ids) {
  ensureDir()
  const servers = ids.map((id) => CATALOG_BY_ID[id]).filter(Boolean)
  if (!servers.length) return { ok: false, error: '没有可安装的服务器' }

  const pkgFile = path.join(MCP_DIR, 'package.json')
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
  pkg.dependencies = pkg.dependencies || {}
  for (const s of servers) pkg.dependencies[s.pkg] = 'latest'
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))

  const r = await runAsync('npm', ['install', '--no-fund', '--no-audit'], { cwd: MCP_DIR, timeout: 600000 })
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || r.stdout || 'npm install 失败').slice(-800) }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * 注册到 claude
 * ------------------------------------------------------------------ */

function claudeName(id) {
  return `chaos-${id}`
}

async function claudeAdd(server, opts = {}) {
  const bin = require('./runner').resolveClaudeBin()
  if (!bin) return { ok: false, error: '未检测到 claude CLI' }

  const args = ['mcp', 'add', claudeName(server.id), '-s', 'user']
  const env = { ...nodeLaunchEnv(), ...(server.env ? server.env() : {}) }
  for (const k of server.envKeys || []) {
    if (opts.env && opts.env[k]) env[k] = opts.env[k]
  }
  for (const [k, v] of Object.entries(env)) {
    args.push('-e', `${k}=${v}`)
  }
  args.push('--', resolveNodeBin(), entryPath(server), ...server.argsFor(opts))

  const r = await runAsync(bin, args.map(quoteArg))
  const out = `${r.stdout || ''}${r.stderr || ''}`
  if (r.status !== 0 && !/already exists/i.test(out)) {
    return { ok: false, error: out.slice(-400) || 'claude mcp add 失败' }
  }
  return { ok: true }
}

async function claudeRemove(id) {
  const bin = require('./runner').resolveClaudeBin()
  if (!bin) return { ok: false, error: '未检测到 claude CLI' }
  const r = await runAsync(bin, ['mcp', 'remove', claudeName(id), '-s', 'user'])
  const out = `${r.stdout || ''}${r.stderr || ''}`
  if (r.status !== 0 && !/not found|No MCP server/i.test(out)) {
    return { ok: false, error: out.slice(-400) }
  }
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * 注册到 deveco（opencode 格式的 jsonc）
 * ------------------------------------------------------------------ */

/**
 * 读取 deveco.jsonc。
 *
 * 返回 { exists, cfg, error }，**必须**区分两种情况：
 *  - exists=false：文件还不存在，可以放心新建一份
 *  - error 非空：文件存在但解析不出来（BOM、尾逗号、行内注释…）。
 *    此时 cfg 为 null，调用方绝不能当成「空配置」写回去 —— 写回等于把用户
 *    手写的整份配置（models、providers、其它 MCP server）替换成一个只有 mcp
 *    字段的存根，而界面还会显示启用成功。
 */
function readDevecoConfig() {
  if (!fs.existsSync(DEVECO_CONFIG)) {
    return { exists: false, cfg: { $schema: 'https://opencode.ai/config.json' }, error: null }
  }
  let raw
  try {
    raw = fs.readFileSync(DEVECO_CONFIG, 'utf8')
  } catch (err) {
    console.error('[mcp] 读取 deveco 配置失败:', err.message)
    return { exists: true, cfg: null, error: `读取 deveco.jsonc 失败: ${err.message}` }
  }
  // 配置文件是 .jsonc，可能带注释；先尝试直接解析，失败再剥注释。
  // BOM 必须先剥掉：编辑器爱写它，而 JSON.parse 见到 BOM 直接抛错
  // —— 一个不可见的 BOM 就足以让整份配置被判为「解析失败」。
  const noBom = raw.replace(/^\uFEFF/, '')
  const uncommented = noBom
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  let lastErr
  for (const text of [noBom, uncommented]) {
    try {
      return { exists: true, cfg: JSON.parse(text), error: null }
    } catch (err) {
      lastErr = err
    }
  }
  console.error('[mcp] deveco 配置解析失败:', lastErr.message)
  return {
    exists: true,
    cfg: null,
    error: `deveco.jsonc 解析失败，为避免覆盖你的配置已中止（${lastErr.message}）`,
  }
}

function writeDevecoConfig(cfg) {
  const dir = path.dirname(DEVECO_CONFIG)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(DEVECO_CONFIG, JSON.stringify(cfg, null, 2), 'utf8')
}

function devecoRegister(server, opts = {}) {
  const { cfg, error } = readDevecoConfig()
  // 读不出来就一个字都别写：这里的写回是整体覆盖，拿兜底默认值写回去
  // 等于把用户手写的 models / providers / 其它 MCP server 全部抹掉。
  if (error) return { ok: false, error }
  cfg.mcp = cfg.mcp || {}
  const env = { ...nodeLaunchEnv(), ...(server.env ? server.env() : {}) }
  for (const k of server.envKeys || []) {
    if (opts.env && opts.env[k]) env[k] = opts.env[k]
  }
  cfg.mcp[`chaos-${server.id}`] = {
    type: 'local',
    command: [resolveNodeBin(), entryPath(server), ...server.argsFor(opts)],
    enabled: true,
    ...(Object.keys(env).length ? { environment: env } : {}),
  }
  writeDevecoConfig(cfg)
  return { ok: true }
}

function devecoUnregister(id) {
  const { cfg, error } = readDevecoConfig()
  // 同 devecoRegister：解析失败时写回同样是整体覆盖，宁可不动文件
  if (error) return { ok: false, error }
  if (cfg.mcp && cfg.mcp[`chaos-${id}`]) {
    delete cfg.mcp[`chaos-${id}`]
    writeDevecoConfig(cfg)
  }
  return { ok: true }
}

/** deveco 的 mcp 配置里已启用的服务器 id（去掉 chaos- 前缀） */
function devecoRegisteredIds() {
  const { cfg } = readDevecoConfig()
  // cfg 为 null 表示文件存在但解析失败，此时读不出任何 id（不是「没配置」）
  return Object.keys((cfg && cfg.mcp) || {})
    .filter((k) => k.startsWith('chaos-'))
    .map((k) => k.slice('chaos-'.length))
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

async function enable(id, opts = {}) {
  const server = CATALOG_BY_ID[id]
  if (!server) return { ok: false, error: `未知的 MCP 服务器: ${id}` }

  if (server.category === 'needs-key') {
    const missing = (server.envKeys || []).filter((k) => !(opts.env && opts.env[k]))
    const needsArg = server.requiresArg && !opts.arg
    if (missing.length || needsArg) {
      return { ok: false, error: missing.length ? `缺少必填项: ${missing.join(', ')}` : '缺少必填参数' }
    }
  }

  if (!isPackageInstalled(server)) {
    const inst = await installPackages([id])
    if (!inst.ok) return inst
  }

  const results = {}
  try {
    results.claude = await claudeAdd(server, opts)
  } catch (err) {
    results.claude = { ok: false, error: err.message }
  }
  try {
    results.deveco = devecoRegister(server, opts)
  } catch (err) {
    results.deveco = { ok: false, error: err.message }
  }

  // 两个 CLI 一个都没写成时不能报成功：上层只看 result.ok，会弹绿色成功提示，
  // 但 mcp.list() 里 enabled 仍然是 false —— 用户以为启用了，实际没有。
  if (!Object.values(results).some((r) => r && r.ok)) {
    const detail = Object.entries(results)
      .filter(([, r]) => !r || !r.ok)
      .map(([who, r]) => `${who}: ${(r && r.error) || '未知错误'}`)
      .join('；')
    return { ok: false, error: `注册失败（${detail}）`, results }
  }
  return { ok: true, results }
}

async function disable(id) {
  if (!CATALOG_BY_ID[id]) return { ok: false, error: `未知的 MCP 服务器: ${id}` }
  const results = {}
  try {
    results.claude = await claudeRemove(id)
  } catch (err) {
    results.claude = { ok: false, error: err.message }
  }
  try {
    results.deveco = devecoUnregister(id)
  } catch (err) {
    results.deveco = { ok: false, error: err.message }
  }

  // 与 enable 对称：两边都没成功就不能报成功。
  // 典型场景是 deveco.jsonc 解析失败 —— 那份配置里可能还留着这个 MCP，
  // 报个绿灯等于骗用户「已经停用了」。
  const anyOk = Object.values(results).some((r) => r?.ok)
  if (!anyOk) {
    const detail = Object.entries(results)
      .map(([k, v]) => `${k}: ${v?.error || '失败'}`)
      .join('；')
    return { ok: false, error: `停用失败（${detail}）`, results }
  }
  return { ok: true, results }
}

/**
 * claude 侧的已启用列表。
 *
 * 刻意不去跑 `claude mcp list` —— 那条命令会对**每一个** MCP 服务器做健康检查
 * （真的把它们逐个拉起来），实测要 7.8 秒；而且它是同步调用的话会把整个事件循环
 * 按住，打开 MCP 面板时整个应用都会卡死。
 * `-s user` 作用域的配置就写在 ~/.claude.json 顶层的 mcpServers 里，直接读是常数时间。
 */
function claudeRegisteredIds() {
  try {
    const cfgFile = path.join(os.homedir(), '.claude.json')
    if (!fs.existsSync(cfgFile)) return new Set()
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    const servers = cfg.mcpServers || {}
    return new Set(
      Object.keys(servers)
        .filter((k) => k.startsWith('chaos-'))
        .map((k) => k.slice('chaos-'.length)),
    )
  } catch (err) {
    console.error('[mcp] 读取 ~/.claude.json 失败:', err.message)
    return new Set()
  }
}

function list() {
  const devecoEnabled = new Set(devecoRegisteredIds())
  const claudeEnabled = claudeRegisteredIds()

  return CATALOG.map((s) => ({
    id: s.id,
    label: s.label,
    desc: s.desc,
    pkg: s.pkg,
    category: s.category,
    envKeys: s.envKeys || [],
    keyHint: s.keyHint || '',
    requiresArg: s.requiresArg || '',
    installed: isPackageInstalled(s),
    enabledClaude: claudeEnabled.has(s.id),
    enabledDeveco: devecoEnabled.has(s.id),
    enabled: claudeEnabled.has(s.id) || devecoEnabled.has(s.id),
    entry: isPackageInstalled(s) ? entryPath(s) : null,
  }))
}

function summary() {
  const all = list()
  return {
    dir: MCP_DIR,
    node: resolveNodeBin(),
    total: all.length,
    enabled: all.filter((s) => s.enabled).length,
    claudeAvailable: Boolean(require('./runner').resolveClaudeBin()),
    devecoAvailable: executors.devecoAvailable(),
  }
}

module.exports = {
  MCP_DIR,
  CATALOG,
  CATALOG_BY_ID,
  list,
  summary,
  enable,
  disable,
  installPackages,
  allowedDirs,
  setAllowedDirs,
  resolveNodeBin,
}
