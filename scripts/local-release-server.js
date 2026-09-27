'use strict'

/**
 * 本机「Release 服务器」—— 把 release/ 里已有的安装包按 GitHub 的目录布局提供出去，
 * 用于在没有可用 GitHub 带宽的机器上验证整条安装/升级链。
 *
 * 为什么需要它：这台机器到 GitHub 只有 4~8 kB/s（同一时刻到 npm 镜像是 11 MB/s），
 * 而安装器版本页要下 86 MB、应用内升级要下 89 MB。等网络的话一次要几小时，
 * 「下载 → 交接 → 安装 → 应用内升级」这条链就永远测不完。把地址换成本机，
 * 这几步都是秒级，于是可以真的跑通并截图。
 *
 * 两套路径，分别对应两条链：
 *   /rel/<tag>/<文件名>   安装器版本页（nsis-manifest.js 生成的地址）
 *   /feed/latest.yml      应用内升级（electron-updater 的 generic provider）
 *   /feed/<文件名>
 *
 * 用法：
 *   node scripts/local-release-server.js [端口]
 *
 * 测试断点续传：
 *   CHAOS_DROP_AFTER=1258291 node scripts/local-release-server.js
 *   —— 第一次响应在 1.2 MB 处把连接掐断（模拟「网络不稳/代理拖慢」），
 *     之后的请求正常服务。于是第一次点「安装」必然失败并留下半成品，
 *     再点一次就会走 /resume 从断点续上。这是版本页那段代码唯一的验证手段。
 *
 * 只服务本机（绑 127.0.0.1）。不要拿它当正经的发布服务器。
 */

const fs = require('fs')
const http = require('http')
const path = require('path')

const PORT = Number(process.argv[2] || process.env.PORT || 43120)
const RELEASE_DIR = path.resolve(__dirname, '..', 'release')

/** 历史版本的资源名和本地文件名对不上的，在这里显式对上 */
const ALIASES = {
  'ai.agent.setup.exe': path.join(RELEASE_DIR, '1.0.0', 'ChaosConsole-Setup-1.0.0.exe'),
}

/**
 * 额外的别名，逗号分隔的 `请求名=本地路径`。用来把「某一个版本」指向别的安装包，
 * 例如让测试安装器的 v1.0.1 槽位返回一个测试身份的包（免得去动真机上已装的那份）：
 *   CHAOS_ALIAS="ChaosConsole-Setup-1.0.1.exe=D:\...\release-test\ChaosConsole-Setup-1.0.2.exe"
 */
for (const pair of String(process.env.CHAOS_ALIAS || '').split(',')) {
  const eq = pair.indexOf('=')
  if (eq > 0) ALIASES[pair.slice(0, eq).trim().toLowerCase()] = pair.slice(eq + 1).trim()
}

/** 已掐断过一次就不再掐，好让「重试续传」能真的完成 */
let droppedOnce = false
const DROP_AFTER = Number(process.env.CHAOS_DROP_AFTER || 0)

/** 在 release/ 里按文件名找安装包；顺便容忍大小写与历史命名差异 */
function resolveAsset(name) {
  const alias = ALIASES[name.toLowerCase()]
  if (alias) return alias

  const candidates = [
    path.join(RELEASE_DIR, name),
    path.join(RELEASE_DIR, path.basename(name)),
  ]
  // release/<版本号>/ 子目录里也找一遍（历史版本是按这个约定留的）
  for (const sub of fs.existsSync(RELEASE_DIR) ? fs.readdirSync(RELEASE_DIR) : []) {
    candidates.push(path.join(RELEASE_DIR, sub, path.basename(name)))
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) return c
  }
  return null
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers })
  res.end(body)
}

/** 带 Range 的文件响应 —— 断点续传与 electron-updater 的差量下载都依赖它 */
function sendFile(req, res, file) {
  const size = fs.statSync(file).size
  const range = req.headers.range
  const type = file.toLowerCase().endsWith('.yml') ? 'text/yaml; charset=utf-8' : 'application/octet-stream'

  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (m) {
      const start = m[1] ? Number(m[1]) : 0
      const end = m[2] ? Number(m[2]) : size - 1
      if (start >= size || end >= size) {
        return send(res, 416, 'range not satisfiable', { 'Content-Range': `bytes */${size}` })
      }
      const len = end - start + 1
      console.log(`      ↳ Range ${start}-${end}（${len} 字节）`)
      res.writeHead(206, {
        'Content-Type': type,
        'Content-Length': String(len),
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
      })
      return pipe(req, res, fs.createReadStream(file, { start, end }), len)
    }
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(size),
    'Accept-Ranges': 'bytes',
  })
  return pipe(req, res, fs.createReadStream(file), size)
}

/** 按需把响应掐断在 DROP_AFTER 字节处，模拟传输中断 */
function pipe(req, res, stream, total) {
  let sent = 0
  let dropped = false
  stream.on('data', (chunk) => {
    sent += chunk.length
    if (DROP_AFTER && !droppedOnce && sent >= DROP_AFTER) {
      dropped = true
      droppedOnce = true
      const keep = Math.max(0, chunk.length - (sent - DROP_AFTER))
      if (keep > 0) res.write(chunk.subarray(0, keep))
      console.log(`      ✂ 按 CHAOS_DROP_AFTER=${DROP_AFTER} 在 ${DROP_AFTER} 字节处掐断连接`)
      stream.destroy()
      // 不 end()：直接销毁 socket，让客户端看到连接被中断而不是正常结束
      res.destroy()
      return
    }
    if (!res.write(chunk)) stream.pause()
  })
  res.on('drain', () => stream.resume())
  stream.on('end', () => {
    if (!dropped) res.end()
  })
  stream.on('error', () => res.destroy())
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  console.log(`${req.method} ${url}${req.headers.range ? `  [${req.headers.range}]` : ''}`)

  // /rel/<tag>/<文件名> 与 /feed/<文件名> 都归到同一套查找
  const parts = url.split('/').filter(Boolean)
  const name = parts[parts.length - 1]
  if (!name) return send(res, 404, 'not found')

  const file = resolveAsset(name)
  if (!file) {
    console.log(`      ✗ 本地没有 ${name}，去 release/ 里找找（或用 scripts/build.js 先构建）`)
    return send(res, 404, `local release server: no such asset: ${name}`)
  }
  console.log(`      → ${path.relative(process.cwd(), file)}`)
  sendFile(req, res, file)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[local-release] http://127.0.0.1:${PORT}  服务目录 ${RELEASE_DIR}`)
  console.log(`[local-release] 安装器源：/rel/<tag>/<文件名>`)
  console.log(`[local-release] 应用内升级源：/feed/latest.yml + /feed/<文件名>`)
  if (DROP_AFTER) console.log(`[local-release] ⚠ 第一次下载会在 ${DROP_AFTER} 字节处被掐断（测续传）`)
})
