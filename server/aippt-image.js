'use strict'

/**
 * 9.8.0：AIPPT 配图。
 *
 * 用户要对齐「千问做 PPT 能自己配图」的体验。本机跑的是 Ollama 文本模型，
 * 没有文生图权重（SD 动辄几个 G，不该塞进安装包），所以走两条腿：
 *
 *   1. 在线文生图（image.pollinations.ai，无需 API Key、按 URL 出图）
 *      —— 有网就优先用它，出来的是真正的插图
 *   2. 本地程序化插画（纯 Node 标准库手写 PNG 编码器）
 *      —— 断网 / 超时 / 服务挂了时的兜底：主题色渐变 + 光斑 + 细网格，
 *         现代感够用，绝不会出现「配图开天窗」
 *
 * 两个通道的产物都落到 DATA_DIR/aippt/img/，文件名是内容 sha1，
 * 同一句提示词重复生成只算一次（省流量也省等待）。
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const crypto = require('crypto')
const CONFIG = require('./config')

const IMG_DIR = path.join(CONFIG.DATA_DIR, 'aippt', 'img')
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR, { recursive: true })

/** 出图尺寸：16:9，压到 1024 宽就够投屏看，文件也小 */
const W = 1024
const H = 576

const MAGIC = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

/* ------------------------------------------------------------------ *
 * 本地插画：手写 PNG 编码（zlib + CRC32），零依赖
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** RGB 像素缓冲 → PNG Buffer */
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    const src = y * w * 3
    const dst = y * (w * 3 + 1)
    raw[dst] = 0 // filter: none
    rgb.copy(raw, dst + 1, src, src + w * 3)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolor
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function hexToRgb(hex) {
  const h = String(hex || '').replace('#', '')
  return [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** 确定性伪随机（同一句提示词出同一张图，重渲染不会变样） */
function prng(seed) {
  let s = 0
  for (let i = 0; i < seed.length; i++) s = (s * 31 + seed.charCodeAt(i)) >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/**
 * 抽象科技插画：对角渐变底 + 两团柔光 + 环形弧线 + 细网格 + 斜向高光带。
 * 参数都从 seed 推出来，所以每页各不相同但风格统一。
 */
function localIllustration({ seed, accent = '22C55E', deep = '0F172A' }) {
  const rnd = prng(seed)
  const A = hexToRgb(accent)
  const D = hexToRgb(deep)
  // 底色两端：主题深色 → 深色偏冷/偏亮，制造纵深
  const c1 = mix(D, [8, 10, 20], 0.35)
  const c2 = mix(mix(D, A, 0.45), [0, 0, 0], 0.15)

  const glow = [
    { x: 0.18 + rnd() * 0.5, y: 0.15 + rnd() * 0.4, r: 0.42 + rnd() * 0.2, c: A, s: 0.55 },
    { x: 0.55 + rnd() * 0.4, y: 0.55 + rnd() * 0.4, r: 0.3 + rnd() * 0.2, c: mix(A, [255, 255, 255], 0.5), s: 0.32 },
  ]
  const ring = { cx: 0.62 + rnd() * 0.25, cy: 0.34 + rnd() * 0.3, r: 0.2 + rnd() * 0.12 }
  const bandAngle = -0.4 - rnd() * 0.5

  const rgb = Buffer.alloc(W * H * 3)
  const ca = Math.cos(bandAngle)
  const sa = Math.sin(bandAngle)

  for (let y = 0; y < H; y++) {
    const ny = y / H
    for (let x = 0; x < W; x++) {
      const nx = x / W
      // 1) 对角渐变
      let col = mix(c1, c2, Math.min(1, (nx * 0.55 + ny * 0.45) * 1.25))

      // 2) 柔光（径向衰减，平方让边缘更自然）
      for (const g of glow) {
        const dx = (nx - g.x) * (W / H)
        const dy = ny - g.y
        const d = Math.sqrt(dx * dx + dy * dy) / g.r
        if (d < 1.6) {
          const k = Math.pow(Math.max(0, 1 - d / 1.6), 2.2) * g.s
          col = mix(col, g.c, k)
        }
      }

      // 3) 环形弧线（细，半透明）—— 画面里唯一「有形状」的元素
      const rdx = (nx - ring.cx) * (W / H)
      const rdy = ny - ring.cy
      const rd = Math.sqrt(rdx * rdx + rdy * rdy)
      const ringK = Math.exp(-Math.pow((rd - ring.r) / 0.004, 2))
      if (ringK > 0.02) col = mix(col, [255, 255, 255], ringK * 0.3)
      const ringK2 = Math.exp(-Math.pow((rd - ring.r * 1.34) / 0.003, 2))
      if (ringK2 > 0.02) col = mix(col, A, ringK2 * 0.45)

      // 4) 斜向高光带
      const band = (nx * ca + ny * sa) * 6
      const bandK = Math.max(0, Math.sin(band * Math.PI) - 0.82) * 0.7
      if (bandK > 0) col = mix(col, [255, 255, 255], bandK * 0.12)

      // 5) 细网格（极淡，给科技感）
      if (x % 64 === 0 || y % 64 === 0) col = mix(col, [255, 255, 255], 0.035)

      // 6) 暗角
      const vx = nx - 0.5
      const vy = ny - 0.5
      const vig = 1 - Math.min(0.42, (vx * vx + vy * vy) * 0.9)
      const i = (y * W + x) * 3
      rgb[i] = Math.max(0, Math.min(255, col[0] * vig))
      rgb[i + 1] = Math.max(0, Math.min(255, col[1] * vig))
      rgb[i + 2] = Math.max(0, Math.min(255, col[2] * vig))
    }
  }
  return encodePng(rgb, W, H)
}

/* ------------------------------------------------------------------ *
 * 在线文生图
 * ------------------------------------------------------------------ */

/** 给提示词加统一风格约束，别让每页长得像两个设计做的 */
function stylePrompt(prompt, { themeLabel = '', lang = 'zh' } = {}) {
  const base = String(prompt || '').trim()
  const style =
    'flat modern vector illustration, soft gradient background, subtle geometric shapes, ' +
    'clean minimal corporate style, no text, no letters, no watermark, 16:9 composition'
  return `${base}${themeLabel ? `, ${themeLabel} color palette` : ''}, ${style}`
}

/**
 * pollinations 免费额度的真实规则是「每 IP 每 45 秒 1 张」。
 * 9.8.0 第一版并发 3 路抢同一 IP，结果是 2 张直接 402 FREE_LIMIT 掉到本地插画 ——
 * 用户看到「生成 3 张配图」但成品里只有 1 张真图。
 * 这里统一排队：在线请求串行 + 主动按 46 秒的窗口错开，撞到限流再按 Retry-After 补等。
 * 代价是每张真图约 45 秒，但换来的是「说有几张就有几张」。
 */
const ONLINE_WINDOW_MS = 46000
const ONLINE_WAIT_CAP_MS = 60000
let onlineQueue = Promise.resolve()
let nextOnlineAt = 0

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

class RateLimited extends Error {
  constructor(ms) {
    super('rate-limited')
    this.retryAfterMs = ms
  }
}

/** 把在线出图排进全局队列，保证同一时刻只有一路、且满足最小间隔 */
function enqueueOnline(task) {
  const run = onlineQueue.then(async () => {
    const wait = nextOnlineAt - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      return await task()
    } finally {
      // 成功也要占位：把下一张推到一个窗口之后，别去撞 402
      nextOnlineAt = Date.now() + ONLINE_WINDOW_MS
    }
  })
  onlineQueue = run.then(
    () => {},
    () => {},
  )
  return run
}

async function fetchOnline(prompt, { seed = 1, timeoutMs = 45000 } = {}) {
  const url =
    'https://image.pollinations.ai/prompt/' +
    encodeURIComponent(prompt).replace(/%20/g, '%20') +
    `?width=${W}&height=${H}&nologo=true&model=flux&seed=${seed}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: controller.signal })
    if (!res.ok) {
      // 402/429 会带 "Retry after 33s" —— 按服务端说的等，别瞎重试
      let waitMs = 0
      try {
        const text = await res.text()
        const m = /retry after\s+(\d+)\s*s/i.exec(text)
        if (m) waitMs = Number(m[1]) * 1000 + 1000
        else if (res.status === 429 || res.status === 402) waitMs = 46000
      } catch (_) {
        /* 读不出 body 就按默认间隔 */
      }
      if (waitMs) throw new RateLimited(Math.min(waitMs, ONLINE_WAIT_CAP_MS))
      throw new Error(`HTTP ${res.status}`)
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 4096) throw new Error('返回内容过小，可能不是图片')
    return buf
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 对外接口
 * ------------------------------------------------------------------ */

function keyOf(prompt, seed) {
  return crypto.createHash('sha1').update(`${prompt}|${seed}|${W}x${H}`).digest('hex').slice(0, 20)
}

function findExisting(key) {
  for (const ext of ['jpg', 'png', 'webp']) {
    const p = path.join(IMG_DIR, `${key}.${ext}`)
    if (fs.existsSync(p)) return { file: p, ext, name: `${key}.${ext}` }
  }
  return null
}

/**
 * 生成一张配图。
 * 返回 { ok, name, ext, source } —— source: 'cache' | 'ai' | 'local'
 */
async function generateOne({ prompt, seed = 1, accent = '22C55E', deep = '0F172A', themeLabel = '', allowOnline = true } = {}) {
  const text = String(prompt || '').trim()
  if (!text) return { ok: false, error: '缺少图片描述' }

  const key = keyOf(text, seed)
  const hit = findExisting(key)
  if (hit) return { ok: true, ...hit, source: 'cache' }

  if (allowOnline) {
    const styled = stylePrompt(text, { themeLabel })
    // 免费额度是每 45 秒 1 张，一张图经常要等一到两轮才轮上 —— 最多试 3 次，
    // 但单张图总等待不超过 150s，避免极端限流把整份 PPT 拖死。
    const deadline = Date.now() + 150000
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= deadline) break
      try {
        const buf = await enqueueOnline(() => fetchOnline(styled, { seed, timeoutMs: 45000 }))
        const file = path.join(IMG_DIR, `${key}.jpg`)
        fs.writeFileSync(file, buf)
        return { ok: true, file, ext: 'jpg', name: `${key}.jpg`, source: 'ai' }
      } catch (err) {
        if (err instanceof RateLimited) {
          // 让排在后面的请求也老实等，避免连环 402
          nextOnlineAt = Math.max(nextOnlineAt, Date.now() + err.retryAfterMs)
          continue
        }
        break /* 非限流类错误（网络/超时），不必再来一次 */
      }
    }
  }

  const buf = localIllustration({ seed: `${text}#${seed}`, accent, deep })
  const file = path.join(IMG_DIR, `${key}.png`)
  fs.writeFileSync(file, buf)
  return { ok: true, file, ext: 'png', name: `${key}.png`, source: 'local' }
}

/**
 * 批量出图（并发 3 路）。onOne(index, result) 用于实时推进度。
 * 任何一张失败都不影响其它张 —— 失败的页在渲染时按「无图版式」处理。
 */
async function generateMany(items, { concurrency = 3, onOne, onStart } = {}) {
  const out = new Array(items.length).fill(null)
  let cursor = 0
  let done = 0
  let started = 0
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++
      // 免费额度下每张在线图要排队 45 秒，前端得知道「在等」而不是「卡住」。
      // 用启动序号而不是完成数 —— 并发 3 路同时起跑时完成数都是 0，会连着报「第 1 张」。
      started += 1
      if (onStart) {
        try {
          onStart(i, started - 1, items.length)
        } catch (_) {
          /* 回调异常不影响出图 */
        }
      }
      try {
        out[i] = await generateOne(items[i])
      } catch (err) {
        out[i] = { ok: false, error: err.message }
      }
      done++
      if (onOne) {
        try {
          onOne(i, out[i], done, items.length)
        } catch (_) {
          /* 回调异常不影响出图 */
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, worker))
  return out
}

/** 找图（前端预览 / 静态服务用）：只认 img 目录下 sha1 命名的文件 */
const NAME_RE = /^[a-f0-9]{20}\.(jpg|png|webp)$/

function resolveImage(name) {
  const n = String(name || '')
  if (!NAME_RE.test(n)) return null
  const file = path.join(IMG_DIR, n)
  if (!fs.existsSync(file)) return null
  const ext = n.split('.').pop()
  return { file, type: MAGIC[ext] || 'application/octet-stream' }
}

function clearCache() {
  let n = 0
  try {
    for (const f of fs.readdirSync(IMG_DIR)) {
      if (!NAME_RE.test(f)) continue
      try {
        fs.unlinkSync(path.join(IMG_DIR, f))
        n++
      } catch (_) {
        /* 单个删不掉就跳过 */
      }
    }
  } catch (_) {
    /* 目录不存在 */
  }
  return n
}

module.exports = {
  W,
  H,
  generateOne,
  generateMany,
  resolveImage,
  clearCache,
  localIllustration,
  stylePrompt,
}
