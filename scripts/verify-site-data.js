'use strict'

/**
 * Validate `docs/releases.json` and the site's translation tables.
 *
 * Default checks are offline and deterministic:
 *   - schema v2 shape
 *   - latest.version comes from package.json
 *   - latest.tag is exactly v + version
 *   - every published release has at least one real source
 *   - GitHub and Gitee URLs are distinct, platform-correct, and point at the
 *     release tag and asset named by the entry
 *   - SHA-512 / SHA-256 are present and well formed
 *   - no beta/alpha/rc strings or prerelease entries
 *   - releases are sorted by semver descending
 *   - zh/en dictionaries have identical, non-empty key sets
 *   - every data-i18n key used by index.html exists in both languages
 *
 * `--online` additionally performs HEAD (then ranged GET) checks on every
 * source URL. Exit code is nonzero on any failure.
 *
 * Usage:
 *   node scripts/verify-site-data.js
 *   node scripts/verify-site-data.js --online
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const DATA_FILE = path.join(ROOT, 'docs', 'releases.json')
const HTML_FILE = path.join(ROOT, 'docs', 'index.html')
const SITE_JS_FILE = path.join(ROOT, 'docs', 'assets', 'site.js')
const I18N_FILE = path.join(ROOT, 'docs', 'assets', 'i18n.js')
const PKG_FILE = path.join(ROOT, 'package.json')

const EXPECTED_GITHUB = 'HHH201416/ChaosConsole'
const EXPECTED_GITEE = 'chaosconsole/ChaosConsole'
const ONLINE = process.argv.includes('--online')

const errors = []
const warnings = []

function fail(message) {
  errors.push(message)
  console.error('✗ ' + message)
}

function warn(message) {
  warnings.push(message)
  console.warn('! ' + message)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isIsoDate(value) {
  if (!value || typeof value !== 'string') return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp)
}

function isSha512(value) {
  if (typeof value !== 'string') return false
  if (/^[0-9a-f]{128}$/i.test(value)) return true
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length !== 88) return false
  try {
    return Buffer.from(value, 'base64').length === 64
  } catch (_) {
    return false
  }
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)
}

function isBetaLike(...values) {
  return values.some((value) =>
    /(?:^|[.\-_])(beta|alpha|rc)(?:[.\-_]|$)/i.test(String(value || '')),
  )
}

function parseVersion(value) {
  const raw = String(value == null ? '' : value).trim().replace(/^[vV]/, '')
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

function sourceList(sources) {
  if (!isPlainObject(sources)) return []
  return ['github', 'gitee']
    .filter((key) => Object.prototype.hasOwnProperty.call(sources, key) && sources[key])
    .map((key) => [key, sources[key]])
}

function stableSources(sources) {
  const normalized = {}
  for (const [key, value] of sourceList(sources)) normalized[key] = value
  return JSON.stringify(
    Object.keys(normalized)
      .sort()
      .map((key) => [key, normalized[key]]),
  )
}

function checkSourceUrl(entry, source, url, seenUrls) {
  const label = `${entry.tag} ${source}`
  if (typeof url !== 'string' || !url.trim()) {
    fail(`${label}: source URL is empty`)
    return
  }

  let parsed
  try {
    parsed = new URL(url)
  } catch (_) {
    fail(`${label}: not a valid URL: ${url}`)
    return
  }

  if (parsed.protocol !== 'https:') {
    fail(`${label}: source must use https (${url})`)
    return
  }

  if (source === 'github') {
    if (parsed.hostname !== 'github.com') fail(`${label}: host must be github.com`)
    const prefix = `/${EXPECTED_GITHUB}/releases/download/`
    if (!parsed.pathname.startsWith(prefix)) {
      fail(`${label}: path must start with ${prefix}`)
      return
    }
    const rest = parsed.pathname.slice(prefix.length).split('/')
    const tag = decodeURIComponent(rest[0] || '')
    const asset = decodeURIComponent(rest.slice(1).join('/'))
    if (tag !== entry.tag) fail(`${label}: URL tag "${tag}" != entry tag "${entry.tag}"`)
    if (asset !== entry.assetName) fail(`${label}: URL asset "${asset}" != assetName "${entry.assetName}"`)
  } else {
    if (parsed.hostname !== 'gitee.com') fail(`${label}: host must be gitee.com`)
    const prefix = `/${EXPECTED_GITEE}/releases/download/`
    if (!parsed.pathname.startsWith(prefix)) {
      fail(`${label}: path must start with ${prefix}`)
      return
    }
    const rest = parsed.pathname.slice(prefix.length).split('/')
    const tag = decodeURIComponent(rest[0] || '')
    const asset = decodeURIComponent(rest.slice(1).join('/'))
    if (tag !== entry.tag) fail(`${label}: URL tag "${tag}" != entry tag "${entry.tag}"`)
    if (asset !== entry.assetName) fail(`${label}: URL asset "${asset}" != assetName "${entry.assetName}"`)
  }

  const owner = seenUrls.get(url)
  if (owner && owner !== entry.version) {
    fail(`${entry.tag}: source URL is reused by version ${owner} (${url})`)
  } else {
    seenUrls.set(url, entry.version)
  }
}

function validateEntry(entry, index, pkgVersion, seenUrls, seenVersions) {
  const where = `releases[${index}]`
  if (!isPlainObject(entry)) {
    fail(`${where}: not an object`)
    return
  }

  const version = String(entry.version || '').trim()
  const tag = String(entry.tag || '').trim()
  if (!version) fail(`${where}: missing version`)
  if (!tag) fail(`${where}: missing tag`)

  if (version) {
    if (seenVersions.has(version)) fail(`${where}: duplicate version ${version}`)
    seenVersions.add(version)
  }

  if (tag && version) {
    const tagVersion = tag.replace(/^[vV]/, '')
    if (tagVersion !== version) fail(`${where}: tag "${tag}" does not match version "${version}"`)
  }

  if (entry.prerelease === true) {
    fail(`${where}: prerelease entries must not be published on this page (${tag || version})`)
  }

  if (!entry.name || typeof entry.name !== 'string') fail(`${where}: missing name`)
  if (!entry.assetName || typeof entry.assetName !== 'string') {
    fail(`${where}: missing assetName`)
  } else if (/[\\/]/.test(entry.assetName)) {
    fail(`${where}: assetName must be a file name, not a path (${entry.assetName})`)
  }

  if (isBetaLike(tag, version, entry.name, entry.assetName)) {
    fail(`${where}: beta/alpha/rc string found (${tag || version})`)
  }

  const isLatest = version === pkgVersion
  const pending = entry.pending === true
  const sources = sourceList(entry.sources)

  if (pending && !isLatest) {
    fail(`${where}: only the unreleased latest version may be marked pending`)
  }

  if (pending && isLatest) {
    if (entry.publishedAt && !isIsoDate(entry.publishedAt)) {
      fail(`${where}: pending entry has an invalid publishedAt`)
    }
    if (entry.size != null && (typeof entry.size !== 'number' || entry.size < 0)) {
      fail(`${where}: size must be a non-negative number`)
    }
    if (entry.sha512 !== 'pending' && !isSha512(entry.sha512)) {
      fail(`${where}: pending latest must have "pending" or a valid SHA-512`)
    }
    if (entry.sha256 !== 'pending' && !isSha256(entry.sha256)) {
      fail(`${where}: pending latest must have "pending" or a valid SHA-256`)
    }
    if (sources.length) {
      warn(`${where}: pending entry also has a source; the UI will treat it as downloadable`)
    }
  } else {
    if (!sources.length) fail(`${where}: at least one source is required for a published release`)
    if (!isSha512(entry.sha512)) fail(`${where}: missing or invalid SHA-512`)
    if (!isSha256(entry.sha256)) fail(`${where}: missing or invalid SHA-256`)
    if (typeof entry.size !== 'number' || entry.size <= 0) {
      fail(`${where}: published release must have a positive size`)
    }
    if (!entry.sizeText || typeof entry.sizeText !== 'string') {
      fail(`${where}: published release must have sizeText`)
    }
    if (!isIsoDate(entry.publishedAt)) {
      fail(`${where}: published release must have a valid publishedAt`)
    }
    for (const [source, url] of sources) {
      if (entry.sources[source] === entry.sources[source === 'github' ? 'gitee' : 'github']) {
        fail(`${where}: GitHub and Gitee URLs must be different`)
        break
      }
      checkSourceUrl(entry, source, url, seenUrls)
    }
  }
}

function validateI18n(pkgVersion) {
  let messages
  try {
    messages = require(I18N_FILE)
  } catch (error) {
    fail(`i18n: cannot load docs/assets/i18n.js (${error.message})`)
    return
  }

  if (!isPlainObject(messages) || !isPlainObject(messages.zh) || !isPlainObject(messages.en)) {
    fail('i18n: expected an object with "zh" and "en" dictionaries')
    return
  }

  const zh = messages.zh
  const en = messages.en
  const zhKeys = Object.keys(zh)
  const enKeys = Object.keys(en)
  const all = new Set(zhKeys.concat(enKeys))

  for (const key of all) {
    if (!Object.prototype.hasOwnProperty.call(zh, key)) fail(`i18n: missing zh key "${key}"`)
    else if (typeof zh[key] !== 'string' || !zh[key].trim()) fail(`i18n: empty zh value for "${key}"`)
    if (!Object.prototype.hasOwnProperty.call(en, key)) fail(`i18n: missing en key "${key}"`)
    else if (typeof en[key] !== 'string' || !en[key].trim()) fail(`i18n: empty en value for "${key}"`)
  }

  let html = ''
  try {
    html = fs.readFileSync(HTML_FILE, 'utf8')
  } catch (error) {
    fail(`index.html: cannot read (${error.message})`)
    return
  }

  const htmlKeys = new Set()
  const attrRegex = /data-i18n(?:-html|-aria-label|-title)?="([^"]+)"/g
  let match
  while ((match = attrRegex.exec(html)) !== null) htmlKeys.add(match[1])

  for (const key of htmlKeys) {
    if (!Object.prototype.hasOwnProperty.call(zh, key)) fail(`index.html: missing zh key "${key}"`)
    if (!Object.prototype.hasOwnProperty.call(en, key)) fail(`index.html: missing en key "${key}"`)
  }

  let siteJs = ''
  try {
    siteJs = fs.readFileSync(SITE_JS_FILE, 'utf8')
  } catch (_) {}

  const jsKeyRegex = /\bt\(\s*(['"])([^'"]+)\1/g
  const jsKeys = new Set()
  while ((match = jsKeyRegex.exec(siteJs)) !== null) jsKeys.add(match[2])
  for (const key of jsKeys) {
    if (!Object.prototype.hasOwnProperty.call(zh, key)) fail(`site.js: missing zh key "${key}"`)
    if (!Object.prototype.hasOwnProperty.call(en, key)) fail(`site.js: missing en key "${key}"`)
  }

  console.log(`✓ i18n: ${all.size} keys, zh/en in sync; ${htmlKeys.size} HTML keys checked`)
}

function loadData() {
  let data
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  } catch (error) {
    fail(`releases.json: cannot read or parse (${error.message})`)
    return null
  }
  return data
}

function validateData(data, pkgVersion) {
  if (!isPlainObject(data)) {
    fail('releases.json: root must be an object')
    return
  }
  if (data.schemaVersion !== 2) fail(`schemaVersion must be 2 (got ${data.schemaVersion})`)
  if (!isIsoDate(data.generatedAt)) fail('generatedAt must be an ISO date')
  if (!isPlainObject(data.repos)) {
    fail('repos must be an object')
  } else {
    if (data.repos.github !== EXPECTED_GITHUB) fail(`repos.github must be ${EXPECTED_GITHUB}`)
    if (data.repos.gitee !== EXPECTED_GITEE) fail(`repos.gitee must be ${EXPECTED_GITEE}`)
  }

  if (!isPlainObject(data.latest)) {
    fail('latest must be an object')
    return
  }
  if (data.latest.version !== pkgVersion) {
    fail(`latest.version "${data.latest.version}" must equal package.json version "${pkgVersion}"`)
  }
  if (data.latest.tag !== `v${pkgVersion}`) {
    fail(`latest.tag "${data.latest.tag}" must be "v${pkgVersion}"`)
  }
  if (data.latest.prerelease === true) fail('latest must not be a prerelease')
  if (isBetaLike(data.latest.tag, data.latest.version, data.latest.name, data.latest.assetName)) {
    fail('latest contains a beta/alpha/rc string')
  }

  if (!Array.isArray(data.releases) || !data.releases.length) {
    fail('releases must be a non-empty array')
    return
  }

  const seenUrls = new Map()
  const seenVersions = new Set()
  data.releases.forEach((entry, index) => validateEntry(entry, index, pkgVersion, seenUrls, seenVersions))

  for (let i = 0; i < data.releases.length - 1; i++) {
    const current = data.releases[i]
    const next = data.releases[i + 1]
    if (compareSemver(current.version, next.version) < 0) {
      fail(`releases must be sorted by semver descending (${current.version} before ${next.version})`)
      break
    }
  }

  if (data.releases[0] && data.releases[0].version !== pkgVersion) {
    fail(`releases[0].version must be ${pkgVersion} (latest)`)
  }

  const latestInList = data.releases.find((entry) => entry && entry.version === pkgVersion)
  if (!latestInList) {
    fail(`releases must contain the latest version ${pkgVersion}`)
  } else {
    const fields = ['tag', 'version', 'name', 'publishedAt', 'prerelease', 'pending', 'assetName', 'size', 'sha512', 'sha256']
    for (const field of fields) {
      if (JSON.stringify(latestInList[field]) !== JSON.stringify(data.latest[field])) {
        fail(`latest.${field} does not match the latest entry in releases[]`)
      }
    }
    if (stableSources(latestInList.sources) !== stableSources(data.latest.sources)) {
      fail('latest.sources does not match the latest entry in releases[]')
    }
  }

  // Reject pending hashes anywhere outside the explicit pending latest.
  data.releases.forEach((entry) => {
    if (entry.version === pkgVersion && entry.pending === true) return
    if (entry.sha512 === 'pending' || entry.sha256 === 'pending') {
      fail(`${entry.tag}: placeholder hashes are only allowed on the pending latest entry`)
    }
  })
}

async function fetchStatus(url, method, headers) {
  if (typeof fetch !== 'function') throw new Error('Node 18+ is required for --online')
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), 25000) : null
  try {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      headers: Object.assign({ 'user-agent': 'chaosconsole-verify-site' }, headers || {}),
      signal: controller ? controller.signal : undefined,
    })
    if (response.body && typeof response.body.cancel === 'function') {
      try {
        await response.body.cancel()
      } catch (_) {}
    }
    return response.status
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function checkUrlOnline(url) {
  let headStatus = 0
  try {
    headStatus = await fetchStatus(url, 'HEAD')
    if (headStatus >= 200 && headStatus < 400) return { ok: true, status: headStatus }
  } catch (_) {}

  try {
    const getStatus = await fetchStatus(url, 'GET', { range: 'bytes=0-0' })
    return {
      ok: getStatus >= 200 && getStatus < 400,
      status: getStatus,
    }
  } catch (error) {
    return { ok: false, status: 0, error: error.message, headStatus }
  }
}

async function runOnlineChecks(data) {
  const urls = new Map()
  for (const entry of data.releases || []) {
    for (const [, url] of sourceList(entry.sources)) {
      if (!urls.has(url)) urls.set(url, entry.tag)
    }
  }

  const list = [...urls.keys()]
  if (!list.length) {
    warn('online: no source URLs to check')
    return
  }

  console.log(`\n在线检查 ${list.length} 个下载地址…`)
  let cursor = 0
  let failed = 0

  async function worker() {
    while (cursor < list.length) {
      const index = cursor++
      const url = list[index]
      const result = await checkUrlOnline(url)
      if (result.ok) {
        console.log(`  ✓ ${result.status} ${url}`)
      } else {
        failed++
        const detail = result.error ? ` (${result.error})` : ''
        fail(`online: ${result.status || 'ERR'} ${url}${detail}`)
      }
    }
  }

  const workers = []
  for (let i = 0; i < Math.min(3, list.length); i++) workers.push(worker())
  await Promise.all(workers)

  if (failed) {
    console.error('\n提示：若错误是证书问题，可设置 NODE_EXTRA_CA_CERTS 后再试。')
  }
}

async function main() {
  console.log('ChaosConsole site data verification')
  console.log(`  data: ${path.relative(ROOT, DATA_FILE)}`)

  let pkg
  try {
    pkg = JSON.parse(fs.readFileSync(PKG_FILE, 'utf8'))
  } catch (error) {
    fail(`package.json: cannot read (${error.message})`)
    pkg = {}
  }
  const pkgVersion = String(pkg.version || '').trim()
  if (!pkgVersion) fail('package.json: missing version')

  validateI18n(pkgVersion)

  const data = loadData()
  if (data) validateData(data, pkgVersion)

  if (ONLINE && data && !errors.length) {
    await runOnlineChecks(data)
  } else if (ONLINE && errors.length) {
    console.error('! online checks skipped because offline validation failed')
  }

  console.log('')
  if (errors.length) {
    console.error(`✗ ${errors.length} check(s) failed`)
    if (warnings.length) console.error(`  (${warnings.length} warning(s))`)
    process.exitCode = 1
  } else {
    console.log('✓ releases.json and i18n passed all checks')
    if (warnings.length) console.log(`  (${warnings.length} warning(s))`)
  }
}

main().catch((error) => {
  console.error(`✗ verifier crashed: ${error.stack || error.message}`)
  process.exit(1)
})
