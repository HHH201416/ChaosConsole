'use strict'

/**
 * 生成 `build/versions.nsh` —— 编译进安装器的「可安装版本」清单。
 *
 * 为什么在**构建时**生成、而不是让安装器自己联网拉：GitHub 的 releases 接口返回 JSON，
 * 在 NSIS 里解析 JSON 基本是自虐；而且 NSIS 自带的下载插件 NSISdl 不支持 HTTPS，
 * 能走 HTTPS 的 INetC 只负责下载、不负责解析。把「有哪些版本」在构建时定下来，
 * 安装器里就只剩「下一个文件」这一件事。
 *
 * 取不到列表时不会让构建失败，而是退化成只有「本安装包内置的版本」一条 ——
 * 安装器照样能用，只是那一页只有一个选项。断网/配额打满/GitHub 抽风都属于这种。
 *
 * 注意：生成的 .nsh 必须带 UTF-8 BOM，否则 makensis 认不出编码，中文全是乱码。
 */

const fs = require('fs')
const path = require('path')

const OWNER = 'HHH201416'
const REPO = 'ChaosConsole'
const MAX_VERSIONS = 10

const OUT_FILE = path.join(__dirname, '..', 'build', 'versions.nsh')

const fmtMB = (bytes) => (bytes ? `${Math.round(bytes / 1024 / 1024)} MB` : '')

async function fetchReleases() {
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=50`
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'chaosconsole-build' }
  // 有 token 就用：公开仓库不带也能读，但配额只有 60 次/小时
  if (process.env.GH_TOKEN) headers.Authorization = `Bearer ${process.env.GH_TOKEN}`

  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`)
  const list = await res.json()
  if (!Array.isArray(list)) throw new Error('GitHub 返回的不是数组')

  return list
    .filter((r) => !r.draft)
    .map((r) => {
      const asset = (r.assets || []).find((a) => /\.exe$/i.test(a.name))
      return asset
        ? {
            tag: r.tag_name,
            name: r.name || r.tag_name,
            prerelease: Boolean(r.prerelease),
            size: asset.size,
            url: asset.browser_download_url,
          }
        : null
    })
    .filter(Boolean)
    .slice(0, MAX_VERSIONS)
}

/**
 * 把任意文本塞进 NSIS 的双引号字符串里。
 * NSIS 里 `$` 要写成 `$$`、`"` 要写成 `$\"`；反斜杠本身就是字面量，**不能**转义
 * （`$\` 不是合法的转义序列）。
 */
function nsisString(s) {
  return String(s).replace(/[$"]/g, (m) => (m === '"' ? '$\\"' : '$$'))
}

function render(version, releases) {
  const esc = nsisString
  // 内置的那一条排在最前，且不需要下载（url 留空）—— 选它就走正常安装流程
  const bundled = { tag: `v${version}`, url: '', size: 0, prerelease: false }
  const others = releases.filter((r) => r.tag.replace(/^v/i, '') !== version)

  const rows = [bundled, ...others]
  const lines = []

  lines.push('; ==================================================================')
  lines.push(';  本文件由 scripts/nsis-manifest.js 自动生成，请勿手工编辑。')
  lines.push(`;  生成时间基准版本：${version}    条目数：${rows.length}`)
  lines.push(';')
  lines.push(';  所有中文文案都放在这里（而不是 build/installer.nsh 里），是因为 makensis')
  lines.push(';  靠 UTF-8 BOM 判断源文件编码 —— 本文件每次构建都重新生成、BOM 由脚本写入，')
  lines.push(';  而手工维护的那个文件保持纯 ASCII，就永远不会把编码搞坏。')
  lines.push('; ==================================================================')
  lines.push('')
  lines.push(`!define CHAOS_MANIFEST_COUNT ${rows.length}`)
  lines.push('')
  lines.push(`!define CHAOS_STR_PAGE_TITLE "选择版本"`)
  lines.push(`!define CHAOS_STR_PAGE_SUB "选中其它版本会先把它下载下来，再启动它的安装程序。"`)
  lines.push(`!define CHAOS_STR_PROMPT "要安装哪个版本？"`)
  lines.push(`!define CHAOS_STR_HINT "本安装包内置的是 v${version}，选它可以直接安装、不需要联网。"`)
  lines.push(`!define CHAOS_STR_DOWNLOADING "正在下载 "`)
  lines.push(`!define CHAOS_STR_CANCEL "取消"`)
  lines.push(`!define CHAOS_STR_DL_TITLE "正在下载 "`)
  lines.push(`!define CHAOS_STR_DL_FAIL "下载失败，错误码： "`)
  lines.push(`!define CHAOS_STR_DL_HINT "$\\r$\\n$\\r$\\n可以改选内置的 v${version}（不需要联网），或者稍后再试。"`)
  lines.push(`!define CHAOS_STR_LAUNCHING "正在启动它的安装程序…"`)
  lines.push('')

  lines.push('Function ChaosFillVersionList')
  for (const r of rows) {
    const label = [r.tag, fmtMB(r.size), r.prerelease ? '预发布' : '', r.url ? '' : '本安装包内置']
      .filter(Boolean)
      .join('  ·  ')
    lines.push(`  \${NSD_LB_AddString} $ChaosList "${esc(label)}"`)
  }
  lines.push('FunctionEnd')
  lines.push('')

  lines.push('; 入参 $0 = 列表索引，出参 $ChaosUrl（空串表示内置版本，不需要下载）/ $ChaosTag')
  lines.push('Function ChaosPickVersion')
  lines.push('  StrCpy $ChaosUrl ""')
  lines.push('  StrCpy $ChaosTag ""')
  rows.forEach((r, i) => {
    if (i === 0) return // 索引 0 是内置版本，两个变量保持空串即可
    lines.push(`  \${If} $0 == ${i}`)
    lines.push(`    StrCpy $ChaosTag "${esc(r.tag)}"`)
    lines.push(`    StrCpy $ChaosUrl "${esc(r.url)}"`)
    lines.push('  ${EndIf}')
  })
  lines.push('FunctionEnd')
  lines.push('')

  return lines.join('\n')
}

async function generate(version) {
  let releases = []
  try {
    releases = await fetchReleases()
  } catch (err) {
    console.warn(`[nsis] 取版本列表失败（${err.message}），安装器里将只有「本安装包内置的版本」一条`)
  }

  const text = render(version, releases)
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true })
  // 带 BOM 写：makensis 靠它判断 UTF-8
  fs.writeFileSync(OUT_FILE, `﻿${text}`, 'utf8')

  const total = releases.filter((r) => r.tag.replace(/^v/i, '') !== version).length
  console.log(`[nsis] 版本清单已生成：${path.relative(process.cwd(), OUT_FILE)}（内置 1 条 + 可下载 ${total} 条）`)
  return { count: total + 1 }
}

module.exports = { generate, OUT_FILE }

if (require.main === module) {
  generate(require('../package.json').version).catch((err) => {
    console.error('[nsis] 生成失败:', err.message)
    process.exit(1)
  })
}
