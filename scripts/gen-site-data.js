'use strict'

/**
 * Generate `docs/releases.json` (schema v2) for the static download site.
 *
 * Design goals:
 *   - The page never calls a release API at runtime; it only reads this file.
 *   - GitHub is the global source. Gitee is a separate, real source for China.
 *   - Old releases are merged forward, so the version history does not shrink.
 *   - The script never crashes just because GitHub is unreachable. It prints a
 *     warning and falls back to local files plus the previous releases.json.
 *   - No token is ever written to the output.
 *
 * Inputs, in order of authority:
 *   1. `release/manifest.json` (if the build writes one)
 *   2. `release/latest.yml` / `release/<version>/latest.yml`
 *   3. GitHub Releases API (tag, name, date, asset name/size/digest)
 *   4. Gitee API (only when GITEE_TOKEN is set) or `release/gitee-<tag>.json`
 *   5. The previous `docs/releases.json`
 *
 * Usage:
 *   node scripts/gen-site-data.js
 *   GH_TOKEN=$(gh auth token) node scripts/gen-site-data.js
 *   GITEE_TOKEN=... node scripts/gen-site-data.js
 *   node scripts/gen-site-data.js --offline
 *   node scripts/gen-site-data.js --include-prerelease
 *
 * `SOURCE_DATE_EPOCH` (seconds) makes `generatedAt` deterministic.
 *
 * Note for this machine: GitHub may be reached through an inspecting proxy.
 * If fetch fails with a certificate error, run with:
 *   NODE_EXTRA_CA_CERTS=C:/Users/Andy/.chaos_steamtools_ca.pem node scripts/gen-site-data.js
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const ROOT = path.join(__dirname, '..')
const DOCS_DIR = path.join(ROOT, 'docs')
const OUT_FILE = path.join(DOCS_DIR, 'releases.json')
const RELEASE_DIR = path.join(ROOT, 'release')
const PKG = require(path.join(ROOT, 'package.json'))

const REPOS = {
  github: 'HHH201416/ChaosConsole',
  gitee: 'chaosconsole/ChaosConsole',
}

const ARGS = process.argv.slice(2)
const OFFLINE = ARGS.includes('--offline')
const INCLUDE_PRERELEASE = ARGS.includes('--include-prerelease')
const GH_TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || ''
const GITEE_TOKEN = process.env.GITEE_TOKEN || ''
const FETCH_TIMEOUT_MS = 20000

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch (_) {
    return false
  }
}

function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch (_) {
    return false
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    console.warn(`  ! 读取 ${path.relative(ROOT, file)} 失败：${error.message}`)
    return null
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch (_) {
    return ''
  }
}

function fmtSize(bytes) {
  const value = Number(bytes) || 0
  if (value <= 0) return ''
  const mb = value / 1048576
  return mb >= 10 ? `${mb.toFixed(1)} MB` : `${mb.toFixed(2)} MB`
}

function cleanVersion(value) {
  return String(value == null ? '' : value).trim().replace(/^[vV]/, '')
}

/** Return a semver-ish version string, preserving prerelease suffixes. */
function versionFromTag(value) {
  const raw = cleanVersion(value)
  const match = raw.match(/\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?/)
  if (match) return match[0]
  return raw
}

function versionKey(value) {
  return versionFromTag(value).toLowerCase()
}

function parseVersion(value) {
  const raw = cleanVersion(value)
  const match = raw.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (match) {
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      pre: match[4] || '',
    }
  }
  const numbers = raw.match(/\d+(?:\.\d+)*/)
  const parts = numbers ? numbers[0].split('.').map(Number) : [0]
  return {
    major: parts[0] || 0,
    minor: parts[1] || 0,
    patch: parts[2] || 0,
    pre: raw,
  }
}

/** Ascending semver comparison; a release sorts after its own prereleases. */
function compareSemver(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa.major !== pb.major) return pa.major - pb.major
  if (pa.minor !== pb.minor) return pa.minor - pb.minor
  if (pa.patch !== pb.patch) return pa.patch - pb.patch
  if (!pa.pre && pb.pre) return 1
  if (pa.pre && !pb.pre) return -1
  if (pa.pre === pb.pre) return 0

  const aa = pa.pre.split('.')
  const bb = pb.pre.split('.')
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] === undefined) return -1
    if (bb[i] === undefined) return 1
    const na = /^\d+$/.test(aa[i])
    const nb = /^\d+$/.test(bb[i])
    if (na && nb) {
      const diff = Number(aa[i]) - Number(bb[i])
      if (diff) return diff
    } else if (na) {
      return -1
    } else if (nb) {
      return 1
    } else if (aa[i] < bb[i]) {
      return -1
    } else if (aa[i] > bb[i]) {
      return 1
    }
  }
  return 0
}

function isBetaLike(...values) {
  return values.some((value) => /(?:beta|alpha|(?:^|[.\-_])rc(?:[.\-_]|$))/i.test(String(value || '')))
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value))
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch (_) {
    return false
  }
}

function isGithubAsset(url) {
  if (!isHttpUrl(url)) return false
  try {
    const parsed = new URL(url)
    return /(^|\.)github\.com$/i.test(parsed.hostname) && /\/releases\/download\//.test(parsed.pathname)
  } catch (_) {
    return false
  }
}

function isGiteeAsset(url) {
  if (!isHttpUrl(url)) return false
  try {
    const parsed = new URL(url)
    return /(^|\.)gitee\.com$/i.test(parsed.hostname) && /\/releases\/download\//.test(parsed.pathname)
  } catch (_) {
    return false
  }
}

function tagFromAssetUrl(url) {
  if (!isHttpUrl(url)) return ''
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    const index = parts.indexOf('download')
    return index >= 0 && parts[index + 1] ? decodeURIComponent(parts[index + 1]) : ''
  } catch (_) {
    return ''
  }
}

function assetFromUrl(url) {
  if (!isHttpUrl(url)) return ''
  try {
    const parts = new URL(url).pathname.split('/').filter(Boolean)
    return parts.length ? decodeURIComponent(parts[parts.length - 1]) : ''
  } catch (_) {
    return ''
  }
}

function normalizeSources(sourceObject) {
  const sources = {}
  if (!sourceObject || typeof sourceObject !== 'object') return sources
  if (isGithubAsset(sourceObject.github)) sources.github = String(sourceObject.github).trim()
  if (isGiteeAsset(sourceObject.gitee)) sources.gitee = String(sourceObject.gitee).trim()
  if (sources.github && sources.gitee && sources.github === sources.gitee) delete sources.gitee
  return sources
}

function hasAnySource(entry) {
  const sources = normalizeSources(entry && entry.sources)
  return Boolean(sources.github || sources.gitee)
}

function pickExe(assets) {
  const exes = (assets || []).filter(
    (asset) => asset && /\.exe$/i.test(String(asset.name || '')) && !/\.blockmap$/i.test(String(asset.name || '')),
  )
  return exes.find((asset) => /^ChaosConsole-Setup-/i.test(asset.name)) || exes[0] || null
}

function parseYml(text) {
  const source = String(text || '').replace(/^\uFEFF/, '')
  const version = (source.match(/^version:\s*['"]?([^'"\s]+)/m) || [])[1] || ''
  const topSha512 = (source.match(/^sha512:\s*['"]?([^'"\s]+)/m) || [])[1] || ''
  const releaseDate = (source.match(/^releaseDate:\s*['"]?([^'"\n]+)/m) || [])[1] || ''
  const pathValue = (source.match(/^path:\s*['"]?([^'"\n]+)/m) || [])[1] || ''
  const firstUrl = (source.match(/^\s*-\s*url:\s*['"]?([^'"\n]+)/m) || [])[1] || ''
  const firstSize = (source.match(/^\s+size:\s*(\d+)/m) || [])[1] || ''
  const firstSha512 = (source.match(/^\s+sha512:\s*['"]?([^'"\s]+)/m) || [])[1] || ''
  return {
    version: cleanVersion(version),
    assetName: path.basename((pathValue || firstUrl || '').trim()),
    size: Number(firstSize) || 0,
    sha512: firstSha512 || topSha512,
    sha256: '',
    publishedAt: releaseDate.trim().replace(/^['"]|['"]$/g, ''),
  }
}

async function hashFile(file, algorithm, encoding) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(algorithm)
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest(encoding)))
      .on('error', reject)
  })
}

function resolveExe(version, assetName) {
  const names = [String(assetName || '').trim(), `ChaosConsole-Setup-${version}.exe`]
    .filter(Boolean)
    .map((name) => path.basename(name))
  const dirs = [RELEASE_DIR, path.join(RELEASE_DIR, version)]
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name)
      if (isFile(file)) return file
    }
  }
  return ''
}

/* -------------------------------------------------------------------------- */
/* Network helpers                                                            */
/* -------------------------------------------------------------------------- */

async function fetchWithTimeout(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  if (typeof fetch !== 'function') throw new Error('当前 Node 版本没有 fetch()，请使用 Node 18+')
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null
  try {
    const response = await fetch(url, Object.assign({}, options, controller ? { signal: controller.signal } : {}))
    if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`)
    return response
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function fetchJson(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs)
  return response.json()
}

async function fetchText(url, options = {}, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetchWithTimeout(url, options, timeoutMs)
  return response.text()
}

function githubHeaders() {
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'chaosconsole-gen-site-data',
  }
  if (GH_TOKEN) headers.authorization = `Bearer ${GH_TOKEN}`
  return headers
}

/* -------------------------------------------------------------------------- */
/* Local build metadata                                                       */
/* -------------------------------------------------------------------------- */

async function enrichFromLocalFile(meta, version, isCurrentVersion) {
  const file = resolveExe(version, meta.assetName)
  if (!file) return meta

  try {
    const stat = fs.statSync(file)
    if (!meta.size && stat.size) meta.size = stat.size
    // Hashing an 87 MB installer is not free. Do it for the current package
    // version when a hash is missing, but rely on existing/GitHub data for
    // historical releases.
    if (isCurrentVersion && !meta.sha512) meta.sha512 = await hashFile(file, 'sha512', 'base64')
    if (isCurrentVersion && !meta.sha256) meta.sha256 = await hashFile(file, 'sha256', 'hex')
    if (!meta.assetName) meta.assetName = path.basename(file)
  } catch (error) {
    console.warn(`  ! 无法读取 ${path.relative(ROOT, file)}：${error.message}`)
  }
  return meta
}

function mergeLocalMeta(target, incoming) {
  if (!target) return incoming
  return {
    version: incoming.version || target.version,
    tag: incoming.tag || target.tag,
    assetName: incoming.assetName || target.assetName,
    size: incoming.size || target.size,
    sizeText: fmtSize(incoming.size || target.size),
    sha512: incoming.sha512 || target.sha512,
    sha256: incoming.sha256 || target.sha256,
    publishedAt: incoming.publishedAt || target.publishedAt,
    prerelease: Boolean(incoming.prerelease || target.prerelease),
    source: incoming.source || target.source,
  }
}

function addLocalMeta(map, meta, pkgVersion) {
  if (!meta || !meta.version) return
  if (!INCLUDE_PRERELEASE && isBetaLike(meta.version, meta.tag, meta.assetName)) return
  meta.version = versionFromTag(meta.version)
  meta.tag = meta.tag || `v${meta.version}`
  meta.sizeText = fmtSize(meta.size)
  const key = versionKey(meta.version)
  map.set(key, mergeLocalMeta(map.get(key), meta))
}

async function metaFromManifest(raw, pkgVersion) {
  const candidates = []
  function collect(value) {
    if (!value || typeof value !== 'object') return
    candidates.push(value)
    if (Array.isArray(value.files)) value.files.forEach(collect)
    if (value.artifact) collect(value.artifact)
    if (value.build) collect(value.build)
  }
  collect(raw)

  const pick =
    candidates.find((item) => item.sha512 || item.sha256 || item.assetName || item.fileName || item.path) || raw
  const version = versionFromTag(pick.version || raw.version || pkgVersion)
  if (!version) return null

  let assetName = String(
    pick.assetName || pick.fileName || pick.name || pick.path || pick.url || '',
  ).trim()
  assetName = assetName ? path.basename(assetName) : `ChaosConsole-Setup-${version}.exe`

  const meta = {
    version,
    tag: String(pick.tag || raw.tag || `v${version}`),
    assetName,
    size: Number(pick.size || pick.bytes || raw.size || raw.bytes || 0) || 0,
    sha512: String(pick.sha512 || raw.sha512 || '').trim(),
    sha256: String(pick.sha256 || raw.sha256 || '').trim(),
    publishedAt: String(pick.publishedAt || pick.releaseDate || raw.publishedAt || raw.releaseDate || '').trim(),
    prerelease: Boolean(pick.prerelease || raw.prerelease),
    source: 'manifest',
  }

  return enrichFromLocalFile(meta, version, versionKey(version) === versionKey(pkgVersion))
}

async function metaFromYml(file, pkgVersion) {
  const parsed = parseYml(readText(file))
  let version = parsed.version
  if (!version) {
    const parent = path.basename(path.dirname(file))
    if (/^\d/.test(parent)) version = parent
  }
  if (!version) return null

  const meta = {
    version: versionFromTag(version),
    tag: `v${versionFromTag(version)}`,
    assetName: parsed.assetName || `ChaosConsole-Setup-${versionFromTag(version)}.exe`,
    size: parsed.size,
    sha512: parsed.sha512,
    sha256: parsed.sha256,
    publishedAt: parsed.publishedAt,
    prerelease: false,
    source: 'latest.yml',
  }

  return enrichFromLocalFile(meta, meta.version, versionKey(meta.version) === versionKey(pkgVersion))
}

async function loadLocalMetadata(pkgVersion) {
  const map = new Map()
  if (!isDir(RELEASE_DIR)) return map

  const manifestFile = path.join(RELEASE_DIR, 'manifest.json')
  if (isFile(manifestFile)) {
    const raw = readJson(manifestFile)
    if (raw) {
      const meta = await metaFromManifest(raw, pkgVersion)
      if (meta) addLocalMeta(map, meta, pkgVersion)
    }
  }

  const ymlFiles = new Set()
  const rootYml = path.join(RELEASE_DIR, 'latest.yml')
  if (isFile(rootYml)) ymlFiles.add(rootYml)
  const currentYml = path.join(RELEASE_DIR, pkgVersion, 'latest.yml')
  if (isFile(currentYml)) ymlFiles.add(currentYml)

  try {
    for (const entry of fs.readdirSync(RELEASE_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(RELEASE_DIR, entry.name, 'latest.yml')
      if (isFile(candidate)) ymlFiles.add(candidate)
    }
  } catch (_) {}

  for (const file of ymlFiles) {
    const meta = await metaFromYml(file, pkgVersion)
    if (meta) addLocalMeta(map, meta, pkgVersion)
  }

  return map
}

/* -------------------------------------------------------------------------- */
/* Gitee metadata                                                             */
/* -------------------------------------------------------------------------- */

function normalizeGiteeMeta(raw) {
  if (!raw || typeof raw !== 'object') return null
  const tag = String(raw.tag || raw.tag_name || '').trim()
  const version = versionFromTag(raw.version || tag)
  if (!version) return null

  let assetName = String(raw.assetName || raw.fileName || raw.name || '').trim()
  let url = String(raw.url || raw.assetUrl || raw.browser_download_url || raw.downloadUrl || '').trim()
  if (!assetName && url) assetName = assetFromUrl(url)
  if (!url && tag && assetName) {
    url = `https://gitee.com/${REPOS.gitee}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(assetName)}`
  }
  if (!isGiteeAsset(url)) return null

  return {
    tag: tag || `v${version}`,
    version,
    assetName: assetName || assetFromUrl(url),
    url,
    size: Number(raw.size || 0) || 0,
    sha512: String(raw.sha512 || '').trim(),
    sha256: String(raw.sha256 || '').trim(),
    publishedAt: String(raw.publishedAt || raw.created_at || raw.published_at || '').trim(),
    prerelease: Boolean(raw.prerelease),
  }
}

async function loadGiteeMetadata() {
  const map = new Map()
  let authoritative = false

  // Local metadata written by scripts/publish-gitee.js after an upload.
  if (isDir(RELEASE_DIR)) {
    try {
      for (const name of fs.readdirSync(RELEASE_DIR)) {
        if (!/^gitee-.+\.json$/i.test(name)) continue
        const raw = readJson(path.join(RELEASE_DIR, name))
        const meta = normalizeGiteeMeta(raw)
        if (!meta) continue
        if (!INCLUDE_PRERELEASE && isBetaLike(meta.tag, meta.version, meta.assetName)) continue
        map.set(versionKey(meta.version), meta)
      }
    } catch (_) {}
  }

  if (GITEE_TOKEN && !OFFLINE) {
    try {
      const url = new URL(`https://gitee.com/api/v5/repos/${REPOS.gitee}/releases`)
      url.searchParams.set('per_page', '100')
      url.searchParams.set('access_token', GITEE_TOKEN)
      const list = await fetchJson(url.toString(), {
        headers: { accept: 'application/json', 'user-agent': 'chaosconsole-gen-site-data' },
      })
      if (!Array.isArray(list)) throw new Error('Gitee 返回的不是数组')
      authoritative = true
      for (const release of list) {
        if (!release || !release.tag_name) continue
        const exe = pickExe(release.assets)
        if (!exe) continue
        if (!INCLUDE_PRERELEASE && (release.prerelease || isBetaLike(release.tag_name, release.name))) continue
        const meta = normalizeGiteeMeta({
          tag: release.tag_name,
          name: release.name || release.tag_name,
          assetName: exe.name,
          url: exe.browser_download_url,
          size: exe.size,
          publishedAt: release.created_at || release.published_at || '',
          prerelease: release.prerelease,
        })
        if (meta) map.set(versionKey(meta.version), meta)
      }
      console.log(`  ✓ Gitee：读取到 ${map.size} 个发行版`)
    } catch (error) {
      console.warn(`  ! Gitee 不可用（${error.message}），保留已有 Gitee 链接`)
    }
  } else if (!GITEE_TOKEN) {
    console.log('  · 未设置 GITEE_TOKEN，且只读取本地 release/gitee-*.json')
  }

  return { map, authoritative }
}

/* -------------------------------------------------------------------------- */
/* Existing releases.json (v1 or v2)                                          */
/* -------------------------------------------------------------------------- */

function inferLegacySources(raw) {
  const sources = {}
  if (raw.sources && typeof raw.sources === 'object') {
    Object.assign(sources, normalizeSources(raw.sources))
  }
  if (raw.github) sources.github = raw.github
  if (raw.gitee) sources.gitee = raw.gitee

  // v1 used `direct` / `mirror`. Only accept real platform URLs; proxy
  // prefixes are not an independent source and must not be presented as one.
  for (const value of [raw.direct, raw.mirror]) {
    if (isGithubAsset(value)) sources.github = sources.github || value
    else if (isGiteeAsset(value)) sources.gitee = sources.gitee || value
  }
  return normalizeSources(sources)
}

function normalizeExistingEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const tag = String(raw.tag || raw.tag_name || '').trim()
  const version = versionFromTag(raw.version || tag)
  if (!version) return null
  const sources = inferLegacySources(raw)
  const assetName = String(
    raw.assetName || raw.exeName || raw.fileName || assetFromUrl(sources.github || sources.gitee) || '',
  ).trim()

  return {
    tag: tag || `v${version}`,
    version,
    name: String(raw.name || tag || version),
    publishedAt: String(raw.publishedAt || raw.published_at || '').trim(),
    prerelease: Boolean(raw.prerelease),
    pending: Boolean(raw.pending),
    assetName: assetName || `ChaosConsole-Setup-${version}.exe`,
    size: Number(raw.size || 0) || 0,
    sizeText: String(raw.sizeText || fmtSize(raw.size) || ''),
    sha512: String(raw.sha512 || '').trim(),
    sha256: String(raw.sha256 || '').trim(),
    sources,
  }
}

function loadExisting() {
  if (!isFile(OUT_FILE)) return []
  const raw = readJson(OUT_FILE)
  if (!raw) return []

  const list = []
  if (Array.isArray(raw.releases)) list.push(...raw.releases)
  if (raw.latest) list.push(raw.latest)

  const seen = new Set()
  const out = []
  for (const item of list) {
    const entry = normalizeExistingEntry(item)
    if (!entry) continue
    if (!INCLUDE_PRERELEASE && isBetaLike(entry.tag, entry.version, entry.name, entry.assetName)) continue
    const key = versionKey(entry.version)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(entry)
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* GitHub metadata                                                            */
/* -------------------------------------------------------------------------- */

async function fetchSha512FromYml(asset) {
  if (!asset || !asset.browser_download_url) return ''
  try {
    const text = await fetchText(asset.browser_download_url, {
      headers: { 'user-agent': 'chaosconsole-gen-site-data' },
    }, 15000)
    return parseYml(text).sha512
  } catch (_) {
    return ''
  }
}

async function loadGitHubMetadata(existingByVersion, localMap) {
  if (OFFLINE) {
    console.log('  · 离线模式：跳过 GitHub API')
    return { releases: [], authoritative: false }
  }

  console.log(`  拉取 GitHub Releases${GH_TOKEN ? '（带 token）' : '（匿名）'}…`)
  let list
  try {
    list = await fetchJson(
      `https://api.github.com/repos/${REPOS.github}/releases?per_page=100`,
      { headers: githubHeaders() },
    )
    if (!Array.isArray(list)) throw new Error('GitHub 返回的不是数组')
  } catch (error) {
    console.warn(`  ! GitHub 不可用（${error.message}），改用本地/已有数据`)
    return { releases: [], authoritative: false }
  }

  const releases = []
  for (const release of list) {
    if (!release || release.draft) continue
    const tag = String(release.tag_name || '').trim()
    const version = versionFromTag(tag)
    if (!version) continue

    if (!INCLUDE_PRERELEASE && (release.prerelease || isBetaLike(tag, version, release.name))) {
      console.log(`  - ${tag}：跳过预发布`)
      continue
    }

    const exe = pickExe(release.assets)
    if (!exe) {
      console.log(`  - ${tag}：没有 .exe 资源，跳过`)
      continue
    }

    const key = versionKey(version)
    const local = localMap.get(key)
    const existing = existingByVersion.get(key)
    const ymlAsset = (release.assets || []).find((asset) => asset && asset.name === 'latest.yml')

    let sha512 = (local && local.sha512) || (existing && existing.sha512) || ''
    if (!sha512) sha512 = await fetchSha512FromYml(ymlAsset)

    const sha256 =
      String(exe.digest || '').replace(/^sha256:/i, '') ||
      (local && local.sha256) ||
      (existing && existing.sha256) ||
      ''

    releases.push({
      tag,
      version,
      name: String(release.name || tag),
      publishedAt: String(release.published_at || (local && local.publishedAt) || ''),
      prerelease: Boolean(release.prerelease),
      assetName: exe.name,
      size: Number(exe.size) || (local && local.size) || 0,
      sizeText: fmtSize(Number(exe.size) || (local && local.size) || 0),
      sha512,
      sha256,
      sources: { github: exe.browser_download_url },
    })
    console.log(`  ✓ ${tag}  ${fmtSize(exe.size)}`)
  }

  return { releases, authoritative: true }
}

/* -------------------------------------------------------------------------- */
/* Merge                                                                      */
/* -------------------------------------------------------------------------- */

function entryFromLocal(meta) {
  return {
    tag: meta.tag || `v${meta.version}`,
    version: meta.version,
    name: meta.tag || `v${meta.version}`,
    publishedAt: meta.publishedAt || '',
    prerelease: Boolean(meta.prerelease),
    assetName: meta.assetName || `ChaosConsole-Setup-${meta.version}.exe`,
    size: meta.size || 0,
    sizeText: fmtSize(meta.size),
    sha512: meta.sha512 || '',
    sha256: meta.sha256 || '',
    sources: {},
  }
}

function chooseTag(target, incoming) {
  const sourceUrl = (target && target.sources && (target.sources.github || target.sources.gitee)) ||
    (incoming && incoming.sources && (incoming.sources.github || incoming.sources.gitee)) || ''
  const sourceTag = tagFromAssetUrl(sourceUrl)
  if (sourceTag && versionKey(sourceTag) === versionKey((incoming && incoming.version) || (target && target.version))) {
    return sourceTag
  }
  return (incoming && incoming.tag) || (target && target.tag) || `v${(incoming && incoming.version) || (target && target.version)}`
}

function mergeEntries(target, incoming) {
  if (!target) return Object.assign({}, incoming)
  const sources = normalizeSources(Object.assign({}, target.sources, incoming.sources))
  const version = incoming.version || target.version
  return {
    tag: chooseTag(target, incoming),
    version,
    name: (incoming.name && incoming.name !== incoming.tag ? incoming.name : '') || target.name || incoming.name || version,
    publishedAt: incoming.publishedAt || target.publishedAt || '',
    prerelease: Boolean(incoming.prerelease || target.prerelease),
    pending: Boolean(incoming.pending || target.pending),
    assetName: incoming.assetName || target.assetName || `ChaosConsole-Setup-${version}.exe`,
    size: incoming.size > 0 ? incoming.size : target.size || 0,
    sizeText: fmtSize(incoming.size > 0 ? incoming.size : target.size) || target.sizeText || '',
    sha512: incoming.sha512 && incoming.sha512 !== 'pending' ? incoming.sha512 : target.sha512 || incoming.sha512 || '',
    sha256: incoming.sha256 && incoming.sha256 !== 'pending' ? incoming.sha256 : target.sha256 || incoming.sha256 || '',
    sources,
  }
}

function addEntry(map, entry) {
  if (!entry || !entry.version) return
  const key = versionKey(entry.version)
  map.set(key, mergeEntries(map.get(key), entry))
}

function applyGiteeMeta(entry, giteeMeta) {
  if (!giteeMeta) return entry
  const sources = normalizeSources(Object.assign({}, entry.sources, { gitee: giteeMeta.url }))
  return {
    tag: entry.tag || giteeMeta.tag,
    version: entry.version,
    name: entry.name || giteeMeta.tag,
    publishedAt: entry.publishedAt || giteeMeta.publishedAt || '',
    prerelease: Boolean(entry.prerelease || giteeMeta.prerelease),
    pending: entry.pending,
    assetName: entry.assetName || giteeMeta.assetName,
    size: entry.size || giteeMeta.size || 0,
    sizeText: fmtSize(entry.size || giteeMeta.size) || entry.sizeText || '',
    sha512: entry.sha512 || giteeMeta.sha512 || '',
    sha256: entry.sha256 || giteeMeta.sha256 || '',
    sources,
  }
}

function finalizeEntry(entry, pkgVersion) {
  const version = versionFromTag(entry.version || entry.tag)
  if (!version) return null
  const sources = normalizeSources(entry.sources)
  const pending = !sources.github && !sources.gitee
  const isLatest = versionKey(version) === versionKey(pkgVersion)

  // A release that was never published is only useful as the current pending
  // version. Sourceless historical rows are dropped instead of shown as broken.
  if (pending && !isLatest) return null

  const size = Number(entry.size) || 0
  const finalized = {
    tag: isLatest ? `v${cleanVersion(version)}` : entry.tag || `v${version}`,
    version: cleanVersion(version),
    name: entry.name || entry.tag || `v${version}`,
    publishedAt: pending ? '' : String(entry.publishedAt || '').trim(),
    prerelease: Boolean(entry.prerelease),
    assetName: entry.assetName || `ChaosConsole-Setup-${cleanVersion(version)}.exe`,
    size: pending && !size ? 0 : size,
    sizeText: fmtSize(pending && !size ? 0 : size) || (pending ? '' : entry.sizeText || ''),
    sha512: entry.sha512 && entry.sha512 !== 'pending' ? String(entry.sha512) : (pending ? 'pending' : ''),
    sha256: entry.sha256 && entry.sha256 !== 'pending' ? String(entry.sha256) : (pending ? 'pending' : ''),
    sources,
  }

  if (pending) finalized.pending = true
  if (!Object.keys(finalized.sources).length) delete finalized.sources
  return finalized
}

function generatedAt() {
  const raw = process.env.SOURCE_DATE_EPOCH
  if (raw != null && String(raw).trim() !== '') {
    const seconds = Number(raw)
    if (Number.isFinite(seconds)) return new Date(seconds * 1000).toISOString()
    console.warn('  ! SOURCE_DATE_EPOCH 不是数字，改用当前时间')
  }
  return new Date().toISOString()
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const pkgVersion = cleanVersion(PKG.version)
  if (!pkgVersion) throw new Error('package.json 缺少 version')
  if (!INCLUDE_PRERELEASE && isBetaLike(pkgVersion)) {
    console.warn(`  ! package.json 版本 ${pkgVersion} 看起来是预发布版本；最终数据会被 verify 拒绝`)
  }

  console.log(`ChaosConsole 站点数据生成器`)
  console.log(`  版本（来自 package.json）：${pkgVersion}`)
  if (OFFLINE) console.log('  离线模式：不发起任何网络请求')

  const existing = loadExisting()
  const existingByVersion = new Map()
  for (const entry of existing) existingByVersion.set(versionKey(entry.version), entry)
  console.log(`  已有版本：${existing.length}`)

  const localMap = await loadLocalMetadata(pkgVersion)
  if (localMap.size) console.log(`  本地构建元数据：${[...localMap.keys()].join(', ')}`)

  const gitee = await loadGiteeMetadata()
  const github = await loadGitHubMetadata(existingByVersion, localMap)

  const merged = new Map()

  // Existing data is the floor: it keeps historical rows alive when an API is
  // unavailable or a release has been removed from a platform.
  for (const entry of existing) addEntry(merged, entry)

  // Fresh GitHub metadata wins over stale fields but does not erase sources
  // that exist only on the other platform.
  for (const entry of github.releases) addEntry(merged, entry)

  // Local build metadata supplies hashes/size for the version currently being
  // built, even before it has been published anywhere.
  for (const meta of localMap.values()) {
    addEntry(merged, entryFromLocal(meta))
  }

  // Gitee entries can be the only real source for a tag. They are derived from
  // the API or from release/gitee-<tag>.json, never guessed from a version.
  for (const meta of gitee.map.values()) {
    addEntry(merged, {
      tag: meta.tag,
      version: meta.version,
      name: meta.tag,
      publishedAt: meta.publishedAt,
      prerelease: meta.prerelease,
      assetName: meta.assetName,
      size: meta.size,
      sizeText: fmtSize(meta.size),
      sha512: meta.sha512,
      sha256: meta.sha256,
      sources: { gitee: meta.url },
    })
  }

  // Attach/refresh real Gitee URLs and drop stale ones when the API told us
  // authoritatively that a tag does not exist there.
  for (const [key, entry] of merged.entries()) {
    const giteeMeta = gitee.map.get(key)
    if (giteeMeta) {
      merged.set(key, applyGiteeMeta(entry, giteeMeta))
      continue
    }
    if (gitee.authoritative && entry.sources && entry.sources.gitee) {
      const copy = Object.assign({}, entry, { sources: Object.assign({}, entry.sources) })
      delete copy.sources.gitee
      merged.set(key, copy)
    }
  }

  // The latest version always comes from package.json. If no artifact exists
  // for it yet, create an explicit pending row rather than shipping stale data.
  let latest = merged.get(versionKey(pkgVersion))
  if (!latest) {
    const local = localMap.get(versionKey(pkgVersion))
    latest = local ? entryFromLocal(local) : {
      tag: `v${pkgVersion}`,
      version: pkgVersion,
      name: pkgVersion,
      publishedAt: '',
      prerelease: false,
      assetName: `ChaosConsole-Setup-${pkgVersion}.exe`,
      size: 0,
      sizeText: '',
      sha512: 'pending',
      sha256: 'pending',
      sources: {},
    }
    merged.set(versionKey(pkgVersion), latest)
  }

  latest = Object.assign({}, latest)
  latest.tag = `v${pkgVersion}`
  latest.version = pkgVersion
  latest.name = latest.name || pkgVersion
  latest.assetName = latest.assetName || `ChaosConsole-Setup-${pkgVersion}.exe`
  if (!latest.sha512) latest.sha512 = 'pending'
  if (!latest.sha256) latest.sha256 = 'pending'
  if (!hasAnySource(latest)) {
    latest.pending = true
    latest.publishedAt = ''
  } else {
    delete latest.pending
  }
  merged.set(versionKey(pkgVersion), latest)

  const releases = [...merged.values()]
    .map((entry) => finalizeEntry(entry, pkgVersion))
    .filter(Boolean)
    .sort((a, b) => compareSemver(b.version, a.version))

  const latestIndex = releases.findIndex((entry) => versionKey(entry.version) === versionKey(pkgVersion))
  if (latestIndex < 0) throw new Error('内部错误：latest 没有进入 releases')
  const latestRelease = releases[latestIndex]
  if (latestRelease.pending) {
    latestRelease.publishedAt = ''
    if (!latestRelease.sha512) latestRelease.sha512 = 'pending'
    if (!latestRelease.sha256) latestRelease.sha256 = 'pending'
  }

  const data = {
    schemaVersion: 2,
    generatedAt: generatedAt(),
    repos: REPOS,
    latest: latestRelease,
    releases,
  }

  fs.mkdirSync(DOCS_DIR, { recursive: true })
  fs.writeFileSync(OUT_FILE, JSON.stringify(data, null, 2) + '\n', 'utf8')

  console.log('')
  console.log(`写出 ${path.relative(ROOT, OUT_FILE)}`)
  console.log(`最新版：${data.latest.tag}${data.latest.pending ? '（待发布）' : ''}`)
  console.log(`来源：GitHub ${data.latest.sources && data.latest.sources.github ? '✓' : '—'}  Gitee ${data.latest.sources && data.latest.sources.gitee ? '✓' : '—'}`)
  console.log(`共 ${releases.length} 个版本`)
}

main().catch((error) => {
  console.error(`\n生成失败：${error.message}`)
  console.error('如果是证书错误，可尝试：')
  console.error('  NODE_EXTRA_CA_CERTS=C:/Users/Andy/.chaos_steamtools_ca.pem node scripts/gen-site-data.js')
  process.exit(1)
})
