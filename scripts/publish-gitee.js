'use strict'

/**
 * 把安装包发布到 Gitee 发行版，并同步更新 docs/releases.json。
 *
 * 为什么要有这个脚本：下载页从 GitHub Pages 迁到国内 —— 页面在腾讯云 EdgeOne Pages，
 * 安装包在 Gitee 发行版。Gitee 的发行版附件走 foruda.gitee.com 的国内 CDN，
 * **未登录也能直接下**（实测 HTTP 200），免费，单文件上限 100 MB。
 *
 * 为什么不复用 gen-site-data.js：那个脚本从 api.github.com 反查，本机连不上 GitHub
 * 就只能回退读本地 latest.yml。这里干脆反过来 —— 我们自己上传，上传完返回什么地址、
 * 本地算出来的校验值是什么，就直接写进 releases.json，不依赖任何接口的返回字段。
 *
 * 用法：
 *   node scripts/publish-gitee.js --tag v3.6.0 --token <GITEE_TOKEN>
 *   node scripts/publish-gitee.js --tag v3.6.0 --token xxx --file release/ChaosConsole-Setup-3.6.0.exe
 *   node scripts/publish-gitee.js --tag v3.6.0 --token xxx --dry-run     # 只算校验值，不上传
 *
 * 令牌：https://gitee.com/profile/personal_access_tokens 生成，勾 projects 就够。
 *
 * 前置条件：仓库里得先有代码（有分支可打 tag）。没有就先把本仓库 push 到 Gitee：
 *   git remote add gitee https://gitee.com/<你的用户名>/ChaosConsole.git
 *   git push gitee main --tags
 * ────────────────────────────────────────────────────────────────────
 * 关于「应用内自动更新」第二步（现在没做，故意留着）
 *
 * 应用现在靠 electron/main.js 的 applyUpdateFeed() 走镜像：
 *     <镜像>/https://github.com/<owner>/<repo>/releases/latest/download
 * 这条能成立是因为 GitHub 的 releases/latest/download 是稳定地址。
 * **Gitee 没有这个地址**（实测 404），所以不能直接换域名了事。
 *
 * 已经探好的迁移路线（等下载页上线、有了固定域名再做，改动很小）：
 *   1. 本脚本顺便把 latest.yml 一起传上 Gitee（已经这么做了）；
 *   2. 再把一份 latest.yml 放到下载页根目录（不到 1 KB，EdgeOne 放得下），
 *      里面的 url 字段改写成 Gitee 附件的绝对地址；
 *   3. 应用侧把 generic feed 的 url 从镜像前缀换成
 *      https://<你的域名>/latest —— electron-updater 的 generic provider
 *      会用 new URL(url, base) 解析，绝对地址原样保留，所以能直接下 Gitee 的包。
 *   4. 「版本回退」列表改读同域的 releases.json（本脚本已经在维护它），
 *      不再打 api.github.com。
 *
 * 之所以现在不动：动 updater 有把老用户更新搞挂的风险，而这一步必须先有
 * 固定域名才能验证。等下载页上线后单独做，是纯增量、可回滚的一次改动。
 * ────────────────────────────────────────────────────────────────────
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const API = 'https://gitee.com/api/v5'
const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, 'docs', 'releases.json')
const MB = 1048576

/* ---------- 参数 ---------- */
const argv = process.argv.slice(2)
function arg(name, def) {
  const i = argv.indexOf('--' + name)
  if (i === -1) return def
  const v = argv[i + 1]
  return v === undefined || v.startsWith('--') ? true : v
}

const TOKEN = String(arg('token', process.env.GITEE_TOKEN || '') || '')
const OWNER = String(arg('owner', 'chaosconsole'))
const REPO = String(arg('repo', 'ChaosConsole'))
const TAG = String(arg('tag', '') || '')
const DRY = argv.includes('--dry-run')
const MAX_ATTACH = 100 * MB

if (!TAG) {
  console.error('缺少 --tag，例如：node scripts/publish-gitee.js --tag v3.6.0 --token xxx')
  process.exit(1)
}
if (!TOKEN && !DRY) {
  console.error('缺少令牌。用 --token xxx，或先设环境变量 GITEE_TOKEN。')
  console.error('生成地址：https://gitee.com/profile/personal_access_tokens')
  process.exit(1)
}

/* ---------- 小工具 ---------- */
function toVersion(tag) {
  const m = String(tag || '').match(/\d+(?:\.\d+)*/)
  return m ? m[0] : String(tag || '').replace(/^v/i, '')
}
function cmpVersion(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0)
    if (d) return d
  }
  return 0
}
function fmtSize(bytes) {
  const mb = bytes / MB
  return mb >= 10 ? mb.toFixed(1) + ' MB' : mb.toFixed(2) + ' MB'
}
/** electron-updater 认的 sha512 是 base64，sha256 用 hex 展示 */
function hashFile(file, algo, enc) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash(algo)
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest(enc)))
      .on('error', reject)
  })
}
function shaFromYml(txt) {
  const m = String(txt || '').match(/^sha512:\s*(.+)$/m)
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : ''
}

/* ---------- API ---------- */
async function api(pathname, { method = 'GET', query = {}, body = null } = {}) {
  const url = new URL(API + pathname)
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  }
  if (TOKEN) url.searchParams.set('access_token', TOKEN)
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json;charset=UTF-8' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) { data = text }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text || res.statusText
    const err = new Error(method + ' ' + pathname + ' -> ' + res.status + ' ' + msg)
    err.status = res.status
    err.data = data
    throw err
  }
  return data
}

async function uploadAsset(releaseId, file) {
  const buf = fs.readFileSync(file)
  if (buf.length > MAX_ATTACH) {
    throw new Error(path.basename(file) + ' 有 ' + fmtSize(buf.length) + '，超过 Gitee 单附件 100 MB 上限')
  }
  const fd = new FormData()
  fd.append('access_token', TOKEN)
  fd.append('file', new Blob([buf]), path.basename(file))
  const res = await fetch(API + '/repos/' + OWNER + '/' + REPO + '/releases/' + releaseId + '/attach_files', {
    method: 'POST',
    body: fd,
  })
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch (_) { data = text }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text
    throw new Error('上传 ' + path.basename(file) + ' 失败：' + res.status + ' ' + msg)
  }
  return data
}

/* ---------- 找本地安装包 ---------- */
function findExe(version) {
  const explicit = arg('file', '')
  if (explicit && typeof explicit === 'string') {
    const p = path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit)
    if (!fs.existsSync(p)) throw new Error('找不到文件：' + p)
    return p
  }
  const name = 'ChaosConsole-Setup-' + version + '.exe'
  const cands = [
    path.join(ROOT, 'release', name),
    path.join(ROOT, 'release', version, name),
  ]
  const hit = cands.find((p) => fs.existsSync(p))
  if (hit) return hit
  // 兜底：release/ 下所有 .exe 里挑版本号对得上的
  const dir = path.join(ROOT, 'release')
  if (fs.existsSync(dir)) {
    const f = fs.readdirSync(dir).find((n) => n.endsWith('.exe') && n.includes(version))
    if (f) return path.join(dir, f)
  }
  throw new Error('找不到版本 ' + version + ' 的 .exe，用 --file 指定路径')
}

function findYml(version) {
  for (const p of [
    path.join(ROOT, 'release', version, 'latest.yml'),
    path.join(ROOT, 'release', 'latest.yml'),
  ]) {
    if (!fs.existsSync(p)) continue
    const txt = fs.readFileSync(p, 'utf8')
    const m = txt.match(/version:\s*['"]?([\d.]+)/)
    if (m && m[1] === version) return p
  }
  return ''
}

/* ---------- 写 releases.json ---------- */
function upsertRelease(entry) {
  let data = { repo: OWNER + '/' + REPO, mirror: '', releases: [] }
  if (fs.existsSync(OUT)) {
    try { data = JSON.parse(fs.readFileSync(OUT, 'utf8')) } catch (_) {}
  }
  data.repo = OWNER + '/' + REPO
  data.mirror = ''
  const rest = (data.releases || []).filter((r) => r.version !== entry.version)
  const out = [entry, ...rest].sort((a, b) => cmpVersion(a.version, b.version))
  data.releases = out
  data.latest = out[0] || null
  data.generatedAt = new Date().toISOString()
  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2) + '\n', 'utf8')
  return data
}

/* ---------- 主流程 ---------- */
async function main() {
  const version = toVersion(TAG)
  const exe = findExe(version)
  const size = fs.statSync(exe).size
  const yml = findYml(version)

  console.log('版本：v' + version)
  console.log('安装包：' + exe)
  console.log('体积：' + fmtSize(size) + '（' + size + ' 字节）')
  if (size > MAX_ATTACH) throw new Error('超过 Gitee 单附件 100 MB 上限')

  // 校验值：优先用 electron-builder 留下的 latest.yml（和上传的是同一个文件），
  // 没有就本地现算 —— 本机算出来的才是可信的，别人的都不算数。
  const sha512 = (yml && shaFromYml(fs.readFileSync(yml, 'utf8'))) || (await hashFile(exe, 'sha512', 'base64'))
  const sha256 = await hashFile(exe, 'sha256', 'hex')
  console.log('sha512：' + sha512)
  console.log('sha256：' + sha256)
  if (yml) console.log('（sha512 取自 ' + path.relative(ROOT, yml) + '）')

  const url = 'https://gitee.com/' + OWNER + '/' + REPO + '/releases/download/' + TAG + '/' + path.basename(exe)
  const entry = {
    tag: TAG,
    version,
    name: version,
    publishedAt: new Date().toISOString(),
    size,
    sizeText: fmtSize(size),
    exeName: path.basename(exe),
    direct: url,
    mirror: url,
    sha512,
    sha256,
    prerelease: false,
    notes: '',
  }

  if (DRY) {
    console.log('\n--dry-run：不上传，只写本地 releases.json')
    upsertRelease(entry)
    console.log('已更新 ' + path.relative(ROOT, OUT))
    console.log('下载地址将是：' + url)
    return
  }

  const me = await api('/user')
  console.log('\n已登录 Gitee：' + (me.login || me.name))

  // 仓库在不在
  let repoInfo = null
  try {
    repoInfo = await api('/repos/' + OWNER + '/' + REPO)
  } catch (e) {
    if (e.status !== 404) throw e
    console.log('仓库不存在，创建 ' + OWNER + '/' + REPO + ' …')
    repoInfo = await api('/user/repos', {
      method: 'POST',
      body: { name: REPO, description: 'ChaosConsole 下载与发行版', private: false, has_issues: true, auto_init: false },
    })
    console.log('仓库已建。第一次需要先把代码推上去：')
    console.log('  git remote add gitee https://gitee.com/' + OWNER + '/' + REPO + '.git')
    console.log('  git push gitee main --tags')
    console.log('推完再跑一次本脚本。')
    return
  }

  // 有没有分支可以打 tag
  const branches = await api('/repos/' + OWNER + '/' + REPO + '/branches')
  if (!Array.isArray(branches) || !branches.length) {
    throw new Error('仓库还是空的，先把代码 push 上去再发布：\n  git remote add gitee https://gitee.com/' + OWNER + '/' + REPO + '.git\n  git push gitee main --tags')
  }
  const defaultBranch = repoInfo.default_branch || branches[0].name
  console.log('默认分支：' + defaultBranch)

  // tag
  try {
    await api('/repos/' + OWNER + '/' + REPO + '/tags', {
      method: 'POST',
      body: { tag_name: TAG, refs: defaultBranch, tag_message: 'ChaosConsole ' + TAG },
    })
    console.log('已创建标签 ' + TAG)
  } catch (e) {
    console.log('标签 ' + TAG + ' 已存在或无需创建（' + (e.status || '') + '）')
  }

  // release
  let releases = await api('/repos/' + OWNER + '/' + REPO + '/releases', { query: { per_page: 100 } })
  let rel = (releases || []).find((r) => r.tag_name === TAG)
  if (!rel) {
    rel = await api('/repos/' + OWNER + '/' + REPO + '/releases', {
      method: 'POST',
      body: { tag_name: TAG, name: TAG, body: 'ChaosConsole ' + version, target_commitish: defaultBranch, prerelease: false },
    })
    console.log('已创建发行版 ' + TAG)
  } else {
    console.log('发行版 ' + TAG + ' 已存在，往里补附件')
  }

  // 附件：安装包 + latest.yml（应用内自动更新要用）
  const files = [exe]
  if (yml) files.push(yml)
  const have = new Set(((rel.assets || []).map((a) => a.name)))
  for (const f of files) {
    if (have.has(path.basename(f))) {
      console.log('跳过（已存在）：' + path.basename(f))
      continue
    }
    const t0 = Date.now()
    await uploadAsset(rel.id, f)
    console.log('已上传 ' + path.basename(f) + '（' + ((Date.now() - t0) / 1000).toFixed(1) + ' 秒）')
  }

  upsertRelease(entry)
  console.log('\n完成。')
  console.log('下载地址：' + url)
  console.log('已更新：' + path.relative(ROOT, OUT))
  console.log('\n下一步：把 docs/ 重新上传到 EdgeOne Pages（控制台「新建部署」，文件夹拖进去）。')
}

main().catch((e) => {
  console.error('\n发布失败：' + (e.message || e))
  process.exit(1)
})
