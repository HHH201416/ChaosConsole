'use strict'

/**
 * electron-builder 的 afterPack 钩子：给打包出来的 exe 写入图标与版本信息。
 *
 * 为什么不用 electron-builder 自带的 rcedit？
 *   rcedit 走的是 Win32 的 BeginUpdateResource/EndUpdateResource —— 原地改 PE 资源。
 *   这台机器上装了腾讯电脑管家（已注册为杀毒软件，带文件过滤驱动），它会扫描新建的
 *   可执行文件并在扫描期间持有句柄，导致 rcedit 反复报
 *   "Fatal error: Unable to commit changes" 且重试 4 次全部失败。
 *
 *   resedit 是把整个文件读进内存、改完再整体写回，对这类过滤驱动的干扰抵抗力强得多。
 *   再加一层带退避的重试，构建就稳了。
 *
 * 注意：文件里 path/resedit 都是相对项目根 require 的，不能用 __dirname 拼，
 * 因为打包时钩子脚本仍从项目根解析。
 */

const fs = require('fs')
const path = require('path')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const MAX_ATTEMPTS = 6
const RETRY_DELAY_MS = 4000

/** 应用显示名，写进 exe 的版本信息里 */
const APP_DISPLAY_NAME = 'AI Agent开发控制台'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 带退避的重试，专门对付杀软扫描窗口造成的瞬时占用 */
async function withRetry(label, fn) {
  let lastErr = null
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return fn()
    } catch (err) {
      lastErr = err
      console.warn(`[after-pack] ${label} 第 ${attempt}/${MAX_ATTEMPTS} 次失败: ${err.code || ''} ${err.message}`)
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_DELAY_MS)
    }
  }
  throw lastErr
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const exeName = `${context.packager.appInfo.productFilename}.exe`
  const exePath = path.join(context.appOutDir, exeName)

  if (!fs.existsSync(exePath)) {
    console.warn(`[after-pack] 找不到 ${exePath}，跳过图标注入`)
    return
  }

  const ICON_PATH = path.join(PROJECT_ROOT, 'build', 'icon.ico')
  if (!fs.existsSync(ICON_PATH)) {
    console.warn(`[after-pack] 找不到 ${ICON_PATH}，跳过图标注入（先跑 npm run icon）`)
    return
  }

  const resedit = require(path.join(PROJECT_ROOT, 'node_modules', 'resedit'))
  const { NtExecutable, NtExecutableResource, Resource, Data } = resedit

  const pkg = require(path.join(PROJECT_ROOT, 'package.json'))
  const version = pkg.version || '1.0.0'
  const [maj, min, patch] = version.split('.').map((n) => parseInt(n, 10) || 0)

  const LANG = 1033 // en-US，与 Electron 自带版本信息一致
  const CODEPAGE = 1200 // UTF-16LE，中文才存得进去

  const iconFile = Data.IconFile.from(fs.readFileSync(ICON_PATH))
  const iconDatas = iconFile.icons.map((i) => i.data)

  let appliedIcon = false
  let appliedVersion = false

  await withRetry('注入图标与版本信息', () => {
    const buffer = fs.readFileSync(exePath)
    const exe = NtExecutable.from(buffer)
    const res = NtExecutableResource.from(exe)

    // ---- 图标：替换掉 Electron 默认图标（资源组 ID 1） ----
    if (!appliedIcon) {
      Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, LANG, iconDatas)
      appliedIcon = true
    }

    // ---- 版本信息 ----
    //
    // 必须复用已有的 VS_VERSION_INFO，不能用 VersionInfo.createEmpty() 新建：
    // createEmpty() 会额外塞一个 lang:0 的翻译块，Windows 会优先读那个空的，
    // 结果就是 ProductName / FileDescription 全部显示为空。
    // 而且新建会导致 exe 里出现两个版本资源，Windows 读到哪一个不确定。
    if (!appliedVersion) {
      const existing = Resource.VersionInfo.fromEntries(res.entries)
      if (existing.length === 0) {
        throw new Error('exe 里没有找到 VS_VERSION_INFO 资源')
      }
      const vi = existing[0]

      vi.setFileVersion(maj, min, patch, 0)
      vi.setProductVersion(maj, min, patch, 0)
      vi.setStringValues(
        { lang: LANG, codepage: CODEPAGE },
        {
          ProductName: 'AI Agent开发控制台',
          FileDescription: 'AI Agent开发控制台 (ChaosConsole)',
          CompanyName: 'ChaosConsole',
          LegalCopyright: `Copyright © ${new Date().getFullYear()} ChaosConsole`,
          OriginalFilename: exeName,
          InternalName: 'ChaosConsole',
          FileVersion: version,
          ProductVersion: version,
        },
      )
      vi.outputToResourceEntries(res.entries)
      appliedVersion = true
    }

    // 兜底：万一还是产生了重复的版本资源，只保留第一个
    const VS_VERSION_INFO = 16
    let keptVersion = false
    res.entries = res.entries.filter((entry) => {
      if (entry.type !== VS_VERSION_INFO) return true
      if (keptVersion) return false
      keptVersion = true
      return true
    })

    res.outputResource(exe)

    // 写回前先删掉旧文件：整体重写比原地覆盖更容易过掉过滤驱动
    const tmp = `${exePath}.tmp`
    fs.writeFileSync(tmp, Buffer.from(exe.generate()))
    fs.rmSync(exePath, { force: true })
    fs.renameSync(tmp, exePath)
  })

  // 写完回读校验：只有真的读回来是对的，才算成功
  const verify = NtExecutableResource.from(NtExecutable.from(fs.readFileSync(exePath)))
  const vis = Resource.VersionInfo.fromEntries(verify.entries)
  const names = Resource.IconGroupEntry.fromEntries(verify.entries).map((g) => g.icons.length)

  if (vis.length !== 1) {
    throw new Error(`版本资源数量异常：期望 1，实际 ${vis.length}`)
  }
  const strings = vis[0].getStringValues({ lang: LANG, codepage: CODEPAGE })
  if (strings.ProductName !== APP_DISPLAY_NAME) {
    throw new Error(`ProductName 回读不匹配：${JSON.stringify(strings.ProductName)}`)
  }

  const size = fs.statSync(exePath).size
  console.log(
    `[after-pack] ✓ ${exeName}: 版本资源 1 个, ProductName="${strings.ProductName}", ` +
      `图标 ${names.reduce((a, b) => a + b, 0)} 个尺寸, 体积 ${size} 字节`,
  )
}

// electron-builder 的不同版本对导出的取法不一致，两种都给上
module.exports = exports.default
