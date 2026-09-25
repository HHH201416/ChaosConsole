'use strict'

/**
 * 打包入口（npm run dist / npm run release 都走这里）。
 *
 * 存在的唯一理由：这台机器上装了腾讯电脑管家，它的文件过滤驱动会在扫描
 * 新建的 188MB exe 期间持有句柄，导致 electron-builder 内部
 * 「写入 asar 完整性资源」这一步间歇性失败并直接中断构建：
 *
 *     ⨯ UNKNOWN: unknown error, open '...\ChaosConsole.exe'
 *
 * 这是纯粹的环境干扰，不是配置问题 —— 同一个文件过一会儿由同样的代码去写就成功了。
 * 所以这里做有限次重试：失败就等一会儿再整轮重来。没装这类杀软的机器上
 * 第一次就通过，重试逻辑永远不会触发。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawnSync } = require('child_process')

const MAX_ATTEMPTS = 3
const RELEASE_DIR = path.resolve(__dirname, '..', 'release')
const RETRY_DELAY_MS = 20000

const sleep = (ms) => {
  // 同步等待，保持脚本是单线程顺序执行
  const shared = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(shared), 0, 0, ms)
}

const args = process.argv.slice(2)
const publishMode = args.includes('--publish') ? args[args.indexOf('--publish') + 1] : 'never'
const builderArgs = ['electron-builder', '--win', 'nsis', '--publish', publishMode]

/**
 * 修正 latest.yml，让它指向真实的安装包文件名。
 *
 * 为什么需要这一步：
 *   artifactName 用的是中文「AI Agent开发控制台 Setup.${ext}」，文件确实按这个名字生成，
 *   但 electron-builder 在生成更新元数据时会退回默认的 ASCII 命名
 *   （chaos-console-setup-1.0.0.exe）。两者对不上，electron-updater 就会去下载一个
 *   不存在的资源，自动更新直接 404。
 *
 *   这里按磁盘上真实的文件重算 sha512 / size / blockMapSize 并重写 latest.yml。
 *
 * 注：GitHub 对非 ASCII 资源名的支持是可靠的（下载 URL 会做百分号编码），
 *     但如果你在自动更新上遇到问题，把 package.json 的 artifactName 换成
 *     纯 ASCII（如 "ChaosConsole-Setup-${version}.${ext}"）即可根治，详见 README。
 */
function fixLatestYml() {
  const ymlPath = path.join(RELEASE_DIR, 'latest.yml')
  if (!fs.existsSync(ymlPath)) {
    console.warn('[build] 未找到 latest.yml，跳过修正（非 NSIS 目标时属正常）')
    return
  }

  // 安装包 = release 下体积最大的、且带同名 .blockmap 的 exe
  const candidates = fs
    .readdirSync(RELEASE_DIR)
    .filter((f) => f.toLowerCase().endsWith('.exe') && !f.startsWith('__'))
    .filter((f) => fs.existsSync(path.join(RELEASE_DIR, `${f}.blockmap`)))

  if (candidates.length === 0) {
    console.warn('[build] 没找到带 blockmap 的安装包，跳过 latest.yml 修正')
    return
  }

  const name = candidates.sort(
    (a, b) => fs.statSync(path.join(RELEASE_DIR, b)).size - fs.statSync(path.join(RELEASE_DIR, a)).size,
  )[0]

  const exePath = path.join(RELEASE_DIR, name)
  const blockmapPath = `${exePath}.blockmap`
  const size = fs.statSync(exePath).size
  const blockMapSize = fs.statSync(blockmapPath).size
  const sha512 = crypto.createHash('sha512').update(fs.readFileSync(exePath)).digest('base64')

  const pkg = require(path.join(__dirname, '..', 'package.json'))
  const releaseDate = new Date().toISOString()

  // 引号包起来，避免文件名里的空格让 YAML 解析出错
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`

  const content = [
    `version: ${pkg.version}`,
    'files:',
    `  - url: ${q(name)}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `    blockMapSize: ${blockMapSize}`,
    `path: ${q(name)}`,
    `sha512: ${sha512}`,
    `releaseDate: ${q(releaseDate)}`,
    '',
  ].join('\n')

  fs.writeFileSync(ymlPath, content, 'utf8')
  console.log(`[build] ✓ 已修正 latest.yml -> ${name}`)
  console.log(`[build]   version=${pkg.version} size=${size} blockMapSize=${blockMapSize}`)
}

console.log(`[build] 目标: ${builderArgs.join(' ')}`)

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  console.log(`\n[build] ===== 第 ${attempt}/${MAX_ATTEMPTS} 次尝试 =====`)

  const result = spawnSync('npx', builderArgs, {
    stdio: 'inherit',
    shell: true,
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ELECTRON_BUILDER_BINARIES_MIRROR:
        process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
        'https://npmmirror.com/mirrors/electron-builder-binaries/',
    },
  })

  if (result.status === 0) {
    console.log(`\n[build] ✓ 打包成功（第 ${attempt} 次尝试）`)
    try {
      fixLatestYml()
    } catch (err) {
      console.error(`[build] ✗ 修正 latest.yml 失败: ${err.message}`)
      process.exit(1)
    }
    process.exit(0)
  }

  if (attempt < MAX_ATTEMPTS) {
    console.warn(`\n[build] ✗ 第 ${attempt} 次失败（退出码 ${result.status}）`)
    console.warn(`[build] 多半是杀软扫描占用 exe 导致的瞬时失败，${RETRY_DELAY_MS / 1000}s 后重试…`)
    console.warn('[build] 想彻底避免：把项目目录加入杀软白名单（见 README「打包常见问题」）')
    sleep(RETRY_DELAY_MS)
  } else {
    console.error(`\n[build] ✗ ${MAX_ATTEMPTS} 次尝试全部失败`)
    process.exit(result.status || 1)
  }
}
