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
const { DEFAULT_AGENTS } = require('./seed')

const MCP_DIR = path.join(process.env.APPDATA || os.homedir(), 'chaos-console', 'mcp')
const DEVECO_CONFIG = path.join(os.homedir(), '.config', 'deveco', 'deveco.jsonc')

/**
 * 反查索引：catalog id -> 默认挂它的岗位（列表用 functionLabel，界面从不显示姓名）。
 * 由 seed.js 的岗位默认值算出来，是「按岗位挂载」的默认答案；
 * 用户改过的以岗位记录里的 mcp 字段为准（见 mcp-scope.resolveRoleMcp）。
 */
const DEFAULT_AGENT_MCP_ROLES = (() => {
  const map = {}
  for (const a of DEFAULT_AGENTS) {
    for (const id of a.mcp || []) {
      if (!map[id]) map[id] = []
      map[id].push(a.functionLabel || a.role)
    }
  }
  return map
})()

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
    // 本地服务器：随应用发布，不经过 npm。用 localEntry 而不是 pkg/entry。
    id: 'deveco-studio',
    label: 'DevEco Studio 控制',
    desc: '操作鸿蒙 IDE：启动/打开工程、截图看界面、跑 hvigorw 构建、用 hdc 装到设备或模拟器',
    localEntry: path.join(__dirname, 'mcp-servers', 'deveco-studio', 'index.js'),
    // 这个服务器要调仓库里的 Python 脚本。复制到稳定目录时必须一起带过去，
    // 否则注册过去的是一个引用不到脚本的入口（表现为工具一调就报错）。
    localExtra: [['scripts/deveco-studio.py', path.join('tools', 'deveco-studio.py')]],
    // 脚本路径通过环境变量告诉服务器，不再依赖 __dirname 的相对位置。
    // **只有复制成功才指过去**：万一 .py 没进包（files 清单漏了），指向一个不存在的
    // 文件会让工具调用直接失败，还不如让服务器退回 __dirname 的相对路径（开发时就是那样）。
    localEnv: () => {
      const stable = path.join(MCP_DIR, 'servers', 'deveco-studio', 'tools', 'deveco-studio.py')
      return fs.existsSync(stable) ? { CHAOS_DEVECO_SCRIPT: stable } : {}
    },
    category: 'installable',
    argsFor: () => [],
  },
  {
    // 应用内部的「换岗」工具：Agent 判断这活该换人时，直接请求交接。
    // 它需要每次运行的一次性令牌，所以**不做全局注册**，由 mcp-scope 按需注入
    // （internal: true 表示不在面板的全局开关里出现）。
    id: 'handoff',
    label: '岗位交接',
    desc: '让 Agent 主动把任务交给更合适的岗位，并带上交接说明',
    localEntry: path.join(__dirname, 'mcp-servers', 'handoff', 'index.js'),
    category: 'installable',
    internal: true,
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

/**
 * filesystem 允许访问的目录，可在设置里覆盖。
 *
 * 落库（settings 表）而不是只存内存：这个值决定 filesystem 服务器能碰哪些路径，
 * 以前只存内存 + 重启即丢，用户改完重启就「莫名其妙变回去了」，
 * 而且没有任何界面入口能改回来。取值优先级：库里的值 > 平台默认。
 */
let allowedDirsOverride = null

function setAllowedDirs(dirs) {
  const list = Array.isArray(dirs) && dirs.length ? dirs.filter((d) => typeof d === 'string' && d.trim()) : null
  allowedDirsOverride = list
  try {
    require('./store').setSetting('mcpAllowedDirs', JSON.stringify(list || []))
  } catch (err) {
    console.error('[mcp] 保存 allowedDirs 失败:', err.message)
  }
  // filesystem 的参数是在注册时烘进配置的，改了要重新注册才生效
  const fsServer = CATALOG_BY_ID.filesystem
  if (fsServer && claudeRegisteredIds().has('filesystem')) {
    claudeRemove('filesystem')
      .then(() => claudeAdd(fsServer))
      .catch((err) => console.error('[mcp] 重注册 filesystem 失败:', err.message))
  }
  if (fsServer && devecoRegisteredIds().includes('filesystem')) {
    devecoRegister(fsServer)
  }
}

function allowedDirs() {
  if (allowedDirsOverride) return allowedDirsOverride
  // 从库里读一次（进程内缓存），读不到再退回平台默认
  try {
    const raw = require('./store').getSetting('mcpAllowedDirs', '')
    const parsed = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed) && parsed.length) {
      allowedDirsOverride = parsed
      return allowedDirsOverride
    }
  } catch (_) {
    /* 读不出来就用默认 */
  }
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

/**
 * 本地服务器复制到稳定目录后的入口。
 * 注册进 CLI 配置的必须是**不随应用移动**的路径（见 materializeLocalServer）。
 */
function stableLocalEntry(id) {
  return path.join(MCP_DIR, 'servers', id, 'index.js')
}

/**
 * 把随应用发布的本地服务器（deveco-studio / handoff）复制到 %APPDATA% 下的稳定目录。
 *
 * 为什么必须复制：注册进 CLI 配置的是**绝对路径**。以前写的是
 * `<安装目录>\resources\app\server\mcp-servers\...` —— 应用一升级、一换安装范围
 * （per-user ↔ per-machine），或者回退到旧版本，这个路径就废了，而 CLI 配置里
 * 还留着旧路径，表现为「MCP 明明装了却连不上」。本机就踩过：deveco 侧那条
 * 指向 `D:\软件与文档\ChaosConsole\resources\app\...`。
 *
 * 内容一致时不重写（避免每次启动都动文件）。
 * 返回是否发生了写入。
 */
function materializeLocalServer(server) {
  if (!server.localEntry) return false
  const srcDir = path.dirname(server.localEntry)
  const dstDir = path.join(MCP_DIR, 'servers', server.id)
  let changed = false
  try {
    fs.mkdirSync(dstDir, { recursive: true })
    const copyIfChanged = (src, dst) => {
      if (!fs.existsSync(src)) return
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      const same = fs.existsSync(dst) && fs.readFileSync(src).equals(fs.readFileSync(dst))
      if (!same) {
        fs.copyFileSync(src, dst)
        changed = true
      }
    }
    for (const name of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, name)
      if (!fs.statSync(src).isFile()) continue
      copyIfChanged(src, path.join(dstDir, name))
    }
    // 附加文件（带运行时依赖的本地服务器，例如要调 Python 脚本的那个）
    for (const [rel, target] of server.localExtra || []) {
      copyIfChanged(path.join(__dirname, '..', rel), path.join(dstDir, target))
    }
    if (!fs.existsSync(stableLocalEntry(server.id))) changed = true
  } catch (err) {
    console.error(`[mcp] 复制本地服务器 ${server.id} 失败:`, err.message)
  }
  return changed
}

function entryPath(server) {
  // localEntry：随应用一起发布、存在于仓库里的服务器，不需要 npm install。
  // 例如 DevEco Studio 控制，它是为本项目写的一次性集成，不可能发到 npm 上。
  // 一律走稳定目录的副本 —— 注册出去的是这个路径，不能是仓库/打包目录里的原件。
  if (server.localEntry) {
    materializeLocalServer(server)
    return stableLocalEntry(server.id)
  }
  return path.join(MCP_DIR, 'node_modules', ...server.pkg.split('/'), ...server.entry.split('/'))
}

function isPackageInstalled(server) {
  // 本地入口没有「安装」这一步，文件在就等于就绪
  if (server.localEntry) return true
  return fs.existsSync(entryPath(server))
}

/* 参数引号规则抽到了 win-quote.js（runner 也要用同一套，见那里的长注释） */
const { quoteArg } = require('./win-quote')

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
  // 本地入口的服务器没有 npm 包，不用装
  const fromNpm = servers.filter((s) => !s.localEntry && s.pkg)
  for (const s of fromNpm) pkg.dependencies[s.pkg] = 'latest'
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2))

  if (!fromNpm.length) return { ok: true }

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
  const env = {
    ...nodeLaunchEnv(),
    ...(server.localEnv ? server.localEnv() : {}),
    ...(server.env ? server.env() : {}),
  }
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
  const env = {
    ...nodeLaunchEnv(),
    ...(server.localEnv ? server.localEnv() : {}),
    ...(server.env ? server.env() : {}),
  }
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
  // 用户显式启用过 → 从「不要自动打开」的名单里移除
  if (!server.internal) rememberDisabledByUser(id, false)
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
  // 记一笔「用户主动关掉」：开机自动启用（bootstrapDefaults）不会再把它打开，
  // 否则用户关一次、重启就复活，跟花名册里那个「删了默认岗位又复活」是同一类坑。
  rememberDisabledByUser(id, true)
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

/**
 * ~/.claude.json 里已注册的服务器**完整定义**（{type,command,args,env}）。
 * 按岗位挂载时直接用这里的现成定义 —— 用户在面板里填的密钥、允许目录
 * 都会原样带上，不需要从 CATALOG 重新拼一遍（少一处会漂移的逻辑）。
 */
function claudeMcpServers() {
  try {
    const cfgFile = path.join(os.homedir(), '.claude.json')
    if (!fs.existsSync(cfgFile)) return {}
    const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
    return cfg.mcpServers || {}
  } catch (err) {
    console.error('[mcp] 读取 ~/.claude.json 的 mcpServers 失败:', err.message)
    return {}
  }
}

/** deveco.jsonc 里的 mcp 段（opencode 格式） */
function devecoMcpMap() {
  const { cfg, error } = readDevecoConfig()
  if (error) return {}
  return (cfg && cfg.mcp) || {}
}

/**
 * 把本地服务器（deveco-studio / handoff）刷新到稳定目录，并**修好已经写坏的注册**。
 *
 * 要修的具体毛病：注册命令行里的路径指向了安装目录（`resources\app\...`），
 * 应用升级 / 换安装范围 / 回退旧版之后那个路径就不存在了，而配置里还留着，
 * 表现为「面板显示已启用、实际连不上」。
 * 做法：命令行里的可执行入口如果不在稳定目录下（或文件已不存在），就重注册一次。
 * 只动我们自己的 chaos-* 条目，不碰用户手写的其它配置。
 */
function syncLocalServers() {
  const fixed = []
  for (const server of CATALOG) {
    if (!server.localEntry) continue
    const want = entryPath(server) // 内部会 materialize
    const names = [`chaos-${server.id}`]
    const claudeDefs = claudeMcpServers()
    const claudeEntry = claudeDefs[names[0]]
    const claudeOk =
      !claudeEntry ||
      (Array.isArray(claudeEntry.args) && claudeEntry.args.some((a) => String(a) === want))
    if (!claudeOk) {
      claudeRemove(server.id)
        .then(() => claudeAdd(server))
        .then((r) => {
          if (r.ok) console.log(`[mcp] 已修正 ${server.id} 的注册路径（原路径已失效）`)
          else console.error(`[mcp] 修正 ${server.id} 失败:`, r.error)
        })
        .catch((err) => console.error('[mcp] 修正注册失败:', err.message))
      fixed.push(server.id)
    }
    const devecoMap = devecoMcpMap()
    const devecoDef = devecoMap[names[0]]
    if (devecoDef) {
      const cmd = Array.isArray(devecoDef.command) ? devecoDef.command : []
      if (!cmd.some((c) => String(c) === want)) {
        devecoRegister(server)
        fixed.push(`deveco:${server.id}`)
      }
    }
  }
  if (fixed.length) console.log(`[mcp] 本地服务器注册已刷新：${fixed.join(', ')}`)
  return fixed
}

/**
 * 应用内置的 MCP 默认全部启用（用户手动关掉的不复活）。
 *
 * 两条硬约束：
 *  1. **绝不 npm install** —— 否则启动就变成一个网络任务（冷机器上可能几分钟），
 *     e2e 自检会因为启动超时而红。缺包就留给用户显式去装。
 *  2. 跑在 listen() 之后、不阻塞启动。
 */
async function bootstrapDefaults() {
  const done = require('./store').getSetting('mcpBootstrapDone', '0') === '1'
  if (done) return { skipped: true }
  const disabledByUser = new Set(
    JSON.parse(require('./store').getSetting('mcpDisabledByUser', '[]') || '[]'),
  )
  const results = []
  for (const server of CATALOG) {
    if (server.category !== 'installable') continue
    if (server.internal) continue // 内部服务器由运行期按需注入，不做全局注册
    if (disabledByUser.has(server.id)) continue
    if (!isPackageInstalled(server)) continue // 不替用户装包
    const claudeOn = claudeRegisteredIds().has(server.id)
    const devecoOn = devecoRegisteredIds().includes(server.id)
    if (claudeOn && devecoOn) continue
    const r = await enable(server.id, {})
    results.push({ id: server.id, ok: r.ok !== false })
  }
  require('./store').setSetting('mcpBootstrapDone', '1')
  if (results.length) console.log(`[mcp] 默认启用：${results.map((r) => r.id).join(', ') || '(无)'}`)
  return { enabled: results }
}

/** 用户主动关掉某个 server 时记一笔，bootstrapDefaults 之后就不会再自动打开它 */
function rememberDisabledByUser(id, disabled) {
  const store = require('./store')
  let list = []
  try {
    list = JSON.parse(store.getSetting('mcpDisabledByUser', '[]') || '[]')
  } catch (_) {
    list = []
  }
  const set = new Set(list)
  if (disabled) set.add(id)
  else set.delete(id)
  store.setSetting('mcpDisabledByUser', JSON.stringify([...set]))
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
    // internal：由运行期按需注入，不在面板的全局开关里出现
    internal: Boolean(s.internal),
    envKeys: s.envKeys || [],
    keyHint: s.keyHint || '',
    requiresArg: s.requiresArg || '',
    installed: isPackageInstalled(s),
    enabledClaude: claudeEnabled.has(s.id),
    enabledDeveco: devecoEnabled.has(s.id),
    enabled: claudeEnabled.has(s.id) || devecoEnabled.has(s.id),
    entry: isPackageInstalled(s) ? entryPath(s) : null,
    // 哪些岗位默认挂它（给「按岗位」矩阵用；用户改过的以岗位记录为准）
    roles: DEFAULT_AGENT_MCP_ROLES[s.id] || [],
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
  // V3.6.0：按岗位挂载需要的原料与两个新动作
  nodeLaunchEnv,
  entryPath,
  stableLocalEntry,
  materializeLocalServer,
  claudeMcpServers,
  devecoMcpMap,
  syncLocalServers,
  bootstrapDefaults,
  rememberDisabledByUser,
}
