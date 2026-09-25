'use strict'

/**
 * 生成应用图标 build/icon.ico（256×256，公文包主题）。
 *
 * 不依赖任何图形库：用 zlib 手写 PNG 编码器，再按 ICO 规范把 PNG 包进去
 * （Vista 之后的 ICO 允许直接内嵌 PNG，比 BMP+掩码省事得多）。
 * 抗锯齿用 4× 超采样后降采样实现。
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const OUT_DIR = path.resolve(__dirname, '..', 'build')

// 所有绘制坐标都基于 256 的「设计尺寸」，SS 是相对它的放大倍数。
// 母版取 768 = LCM(16,24,32,48,64,128,256)，这样每个目标尺寸都能整数倍降采样。
const SIZE = 256
const SS = 3
const W = SIZE * SS

/* ------------------------------------------------------------------ *
 * 画布
 * ------------------------------------------------------------------ */

const canvas = new Float32Array(W * W * 4) // RGBA, 0..255

function mix(a, b, t) {
  return a + (b - a) * t
}

/** 圆角矩形的有向距离：<0 在内部 */
function sdRoundRect(px, py, x, y, w, h, r) {
  const cx = x + w / 2
  const cy = y + h / 2
  const hx = w / 2 - r
  const hy = h / 2 - r
  const dx = Math.abs(px - cx) - hx
  const dy = Math.abs(py - cy) - hy
  const ox = Math.max(dx, 0)
  const oy = Math.max(dy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r
}

function fill(px, py, d, color, alpha = 1) {
  if (d > 0.5) return
  const cov = d <= -0.5 ? 1 : 1 - (d + 0.5)
  const a = Math.min(1, Math.max(0, cov * alpha))
  if (a <= 0) return
  const i = (py * W + px) * 4
  const inv = 1 - a
  canvas[i] = canvas[i] * inv + color[0] * a
  canvas[i + 1] = canvas[i + 1] * inv + color[1] * a
  canvas[i + 2] = canvas[i + 2] * inv + color[2] * a
  canvas[i + 3] = Math.min(255, canvas[i + 3] * inv + 255 * a)
}

/** 用上下渐变色填充一个圆角矩形 */
function fillRoundRectGradient(x, y, w, h, r, topColor, bottomColor) {
  for (let py = Math.max(0, Math.floor(y - 2)); py < Math.min(W, Math.ceil(y + h + 2)); py++) {
    for (let px = Math.max(0, Math.floor(x - 2)); px < Math.min(W, Math.ceil(x + w + 2)); px++) {
      const d = sdRoundRect(px + 0.5, py + 0.5, x, y, w, h, r)
      if (d > 0.5) continue
      const t = (py - y) / h
      const c = [
        mix(topColor[0], bottomColor[0], t),
        mix(topColor[1], bottomColor[1], t),
        mix(topColor[2], bottomColor[2], t),
      ]
      fill(px, py, d, c, 1)
    }
  }
}

/** 用纯色填充一个圆角矩形 */
function fillRoundRect(x, y, w, h, r, color, alpha = 1) {
  for (let py = Math.max(0, Math.floor(y - 2)); py < Math.min(W, Math.ceil(y + h + 2)); py++) {
    for (let px = Math.max(0, Math.floor(x - 2)); px < Math.min(W, Math.ceil(x + w + 2)); px++) {
      const d = sdRoundRect(px + 0.5, py + 0.5, x, y, w, h, r)
      if (d > 0.5) continue
      fill(px, py, d, color, alpha)
    }
  }
}

/** 挖掉一个圆角矩形（把 alpha 拉低） */
function eraseRoundRect(x, y, w, h, r) {
  for (let py = Math.max(0, Math.floor(y - 2)); py < Math.min(W, Math.ceil(y + h + 2)); py++) {
    for (let px = Math.max(0, Math.floor(x - 2)); px < Math.min(W, Math.ceil(x + w + 2)); px++) {
      const d = sdRoundRect(px + 0.5, py + 0.5, x, y, w, h, r)
      if (d > 0.5) continue
      const cov = d <= -0.5 ? 1 : 1 - (d + 0.5)
      const i = (py * W + px) * 4
      canvas[i + 3] *= 1 - Math.min(1, Math.max(0, cov))
    }
  }
}

/* ---- 绘制 ---- */

// 1. 圆角底板（深蓝黑渐变）
fillRoundRectGradient(0, 0, W, W, 52 * SS, [30, 37, 54], [10, 13, 20])

// 2. 内侧描边高光，让图标不那么平
fillRoundRect(3 * SS, 3 * SS, W - 6 * SS, W - 6 * SS, 50 * SS, [58, 70, 98], 0.35)

// 3. 公文包提手（描边环 = 外框 - 内框）
const HANDLE_X = 103 * SS
const HANDLE_Y = 58 * SS
const HANDLE_W = 50 * SS
const HANDLE_H = 42 * SS
fillRoundRect(HANDLE_X, HANDLE_Y, HANDLE_W, HANDLE_H, 15 * SS, [245, 165, 36], 1)
eraseRoundRect(HANDLE_X + 11 * SS, HANDLE_Y + 11 * SS, HANDLE_W - 22 * SS, HANDLE_H - 11 * SS, 7 * SS)

// 4. 公文包主体
fillRoundRectGradient(38 * SS, 90 * SS, 180 * SS, 118 * SS, 22 * SS, [250, 186, 71], [196, 127, 19])

// 5. 中间的横向锁扣凹槽
fillRoundRect(38 * SS, 144 * SS, 180 * SS, 11 * SS, 4 * SS, [15, 19, 28], 0.92)

// 6. 锁扣上的小圆点
fillRoundRect(116 * SS, 132 * SS, 24 * SS, 36 * SS, 9 * SS, [15, 19, 28], 0.92)

// 7. 主体顶部高光
fillRoundRect(38 * SS, 90 * SS, 180 * SS, 10 * SS, 5 * SS, [255, 226, 168], 0.5)

/* ------------------------------------------------------------------ *
 * 降采样：从 1024×1024 母版按面积平均生成各个尺寸
 * ------------------------------------------------------------------ */

/**
 * 把母版降到 target×target（target 必须整除 W）。
 * 用预乘 alpha 的均值再还原，避免边缘出现深色描边。
 */
function downsample(target) {
  const ratio = W / target
  if (!Number.isInteger(ratio)) throw new Error(`尺寸 ${target} 无法整除母版 ${W}`)

  const out = Buffer.alloc(target * target * 4)
  for (let y = 0; y < target; y++) {
    for (let x = 0; x < target; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ratio; sy++) {
        const row = (y * ratio + sy) * W
        for (let sx = 0; sx < ratio; sx++) {
          const i = (row + x * ratio + sx) * 4
          const alpha = canvas[i + 3] / 255
          r += canvas[i] * alpha
          g += canvas[i + 1] * alpha
          b += canvas[i + 2] * alpha
          a += alpha
        }
      }
      const n = ratio * ratio
      const o = (y * target + x) * 4
      if (a > 0) {
        out[o] = Math.round(Math.min(255, r / a))
        out[o + 1] = Math.round(Math.min(255, g / a))
        out[o + 2] = Math.round(Math.min(255, b / a))
      }
      out[o + 3] = Math.round((a / n) * 255)
    }
  }
  return out
}

/** Windows 图标需要多尺寸：任务栏/资源管理器用小的，缩略图用大的 */
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]

/* ------------------------------------------------------------------ *
 * PNG 编码
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
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePng(rgba, width, height) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // no interlace

  // 每行前面加一个 filter 字节（0 = None）
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }

  const idat = zlib.deflateSync(raw, { level: 9 })

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/* ------------------------------------------------------------------ *
 * ICO 封装（多尺寸，每个尺寸内嵌一张 PNG）
 * ------------------------------------------------------------------ */

function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const entries = []
  let offset = 6 + images.length * 16
  for (const img of images) {
    const entry = Buffer.alloc(16)
    // 256 在单字节字段里用 0 表示，这是 ICO 格式的历史约定
    entry[0] = img.size >= 256 ? 0 : img.size
    entry[1] = img.size >= 256 ? 0 : img.size
    entry[2] = 0 // 调色板数量（真彩色为 0）
    entry[3] = 0 // reserved
    entry.writeUInt16LE(1, 4) // color planes
    entry.writeUInt16LE(32, 6) // bits per pixel
    entry.writeUInt32LE(img.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += img.png.length
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const images = ICON_SIZES.map((size) => ({ size, png: encodePng(downsample(size), size, size) }))
  const ico = encodeIco(images)

  // icon.png 留最大的那张，供 README / 其他工具使用
  const largest = images[images.length - 1]
  fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), largest.png)
  fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico)

  console.log(`[icon] 已生成 build/icon.png (${largest.png.length} 字节, ${largest.size}×${largest.size})`)
  console.log(
    `[icon] 已生成 build/icon.ico (${ico.length} 字节, ${images.length} 个尺寸: ${ICON_SIZES.join('/')})`,
  )
}

main()
