'use strict'

/**
 * 生成下载页的版本数据 `docs/releases.json`。
 *
 * 为什么要有这个脚本：下载页要显示「最新版是哪个、多大、下载地址是什么」，这些
 * 全在 GitHub Releases 上。让页面自己去调 api.github.com 有两个问题：一是国内
 * 访问 api.github.com 时通时不通，二是未登录的接口每小时只给 60 次，页面一被
 * 转发就可能被限流打不开。所以改成**发版后跑一次这个脚本**，把结果固化成静态
 * JSON 一起提交 —— 页面只读同目录的一个文件，永远秒开、永远不受限。
 *
 * 页面里还内嵌了一份兜底数据，所以就算 releases.json 丢了也只是显示旧版本号，
 * 不会白屏。
 *
 * 用法：
 *   node scripts/gen-site-data.js
 *   GH_TOKEN=$(gh auth token) node scripts/gen-site-data.js   # 走 token，额度 5000/时
 *
 * 本机跑不通多半是加速器 MITM 那个老问题，前面加 NODE_EXTRA_CA_CERTS 即可：
 *   NODE_EXTRA_CA_CERTS=C:/Users/Andy/.chaos_steamtools_ca.pem node scripts/gen-site-data.js
 */

const fs = require('fs')
const path = require('path')

const REPO = 'HHH201416/ChaosConsole'
const OUT = path.join(__dirname, '..', 'docs', 'releases.json')

/** 下载加速镜像前缀。跟 server/config.js 的 DOWNLOAD_MIRROR 默认值保持一致 */
const MIRROR = 'https://gh-proxy.com'

const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''

async function gh(url) {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'chaosconsole-gen-site-data',
  }
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} <- ${url}`)
  return res
}

/** 从 tag / 资源名里抠出纯版本号：v3.6.0 / V1.0.0 -> 3.6.0 */
function toVersion(tag) {
  const m = String(tag || '').match(/\d+(?:\.\d+)*/)
  return m ? m[0] : String(tag || '').replace(/^v/i, '')
}

/** semver 数值比较，用来排序（字符串排序会把 3.10.0 排到 3.9.0 前面） */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d) return d
  }
  return 0
}

/**
 * 挑出这个 Release 的 Windows 安装包。
 * 不能用「文件名以版本号结尾」来认 —— V1.0.0 那个资源叫 `AI.Agent.Setup.exe`，
 * 里面根本没有版本号。所以只按「.exe 且不是 .blockmap」来挑。
 */
function pickExe(assets) {
  return (assets || []).find(
    (a) => /\.exe$/i.test(a.name) && !/\.blockmap$/i.test(a.name)
  )
}

/** 从 latest.yml 文本里抠 sha512 */
function shaFromYml(txt) {
  const m = String(txt || '').match(/^sha512:\s*(.+)$/m)
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''
}

/**
 * 取该 Release 的 sha512 —— 页面上把校验值亮出来，用户下完可以自己核。
 * 这也是应用内自动更新认的那个值，两边对得上说明包没被换过。
 *
 * 只从 api.github.com 那条链路上取（TLS 保证是 GitHub 本人），**不走镜像** ——
 * 镜像正是我们防的那个对象，从它手里拿校验值等于没校验。
 *
 * 取不到就回退读本地 `release/` 里 electron-builder 打包时留下的那份 latest.yml：
 * 它和上传上去的是同一个文件，而且本机加速器把资源域名指到了 127.0.0.1，
 * 走网络这条路在本机基本必然失败。回退时只认版本号对得上的那份。
 * 都没有就留空，页面上不显示校验值，不算失败。
 */
async function fetchSha(assets, tag, version) {
  const yml = (assets || []).find((a) => a.name === 'latest.yml')
  if (yml) {
    try {
      return shaFromYml(await (await gh(yml.browser_download_url)).text())
    } catch (e) {
      console.warn(`  ! ${tag} 的 latest.yml 走网络读不到（${e.message}），改用本地`)
    }
  }
  for (const p of [
    path.join(__dirname, '..', 'release', version, 'latest.yml'),
    path.join(__dirname, '..', 'release', 'latest.yml'),
  ]) {
    try {
      const txt = fs.readFileSync(p, 'utf8')
      // 根目录那份是「当前构建」的，版本号对不上就不是这个 Release 的，别串用
      if (shaFromYml(txt) && /version:\s*['"]?([\d.]+)/.test(txt)) {
        const v = txt.match(/version:\s*['"]?([\d.]+)/)[1]
        if (v === version) return shaFromYml(txt)
      }
    } catch (_) {}
  }
  return ''
}

/** 人类可读的体积。跟资源管理器一样按 1024 进制，86.9 MB 就是 86.9 MB */
function fmtSize(bytes) {
  if (!bytes) return ''
  const mb = bytes / 1048576
  return mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`
}

async function main() {
  console.log(`拉取 ${REPO} 的 Releases${TOKEN ? '（带 token）' : '（匿名，每小时 60 次）'}…`)
  const releases = await (await gh(
    `https://api.github.com/repos/${REPO}/releases?per_page=100`
  )).json()

  const out = []
  for (const r of releases) {
    const exe = pickExe(r.assets)
    // 没有 exe 的 Release（比如只发源码）对下载页没意义，跳过
    if (!exe) {
      console.log(`  - ${r.tag_name}：没有 .exe 资源，跳过`)
      continue
    }
    const version = toVersion(r.tag_name)
    const direct = exe.browser_download_url || ''
    out.push({
      tag: r.tag_name,
      version,
      name: r.name || r.tag_name,
      publishedAt: r.published_at || '',
      // 体积按 GitHub 给的字节数为准，不用 latest.yml 里的（两者偶有出入）
      size: exe.size,
      sizeText: fmtSize(exe.size),
      exeName: exe.name,
      direct,
      mirror: direct ? `${MIRROR}/${direct}` : '',
      sha512: await fetchSha(r.assets, r.tag_name, version),
      // GitHub 自己算的 sha256，跟 latest.yml 里的 sha512 互为佐证
      sha256: String(exe.digest || '').replace(/^sha256:/, ''),
      prerelease: !!r.prerelease,
      notes: (r.body || '').trim().slice(0, 500),
    })
    console.log(`  ✓ ${r.tag_name}  ${fmtSize(exe.size)}`)
  }

  out.sort((a, b) => cmpVersion(a.version, b.version))

  const data = {
    repo: REPO,
    mirror: MIRROR,
    generatedAt: new Date().toISOString(),
    latest: out[0] || null,
    releases: out,
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8')
  console.log(`\n写出 ${OUT}`)
  console.log(`最新版：${data.latest ? `v${data.latest.version}（${data.latest.sizeText}）` : '无'}`)
  console.log(`共 ${out.length} 个版本`)
}

main().catch((e) => {
  console.error(`\n生成失败：${e.message}`)
  console.error('本机多半是加速器 MITM，试试前面加：NODE_EXTRA_CA_CERTS=C:/Users/Andy/.chaos_steamtools_ca.pem')
  process.exit(1)
})
