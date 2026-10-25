'use strict'

/**
 * 9.8.2：联网找真实照片（配图的第二个来源）
 *
 * 设计取舍：
 *  - 只接 Pexels。它是少数「免费 Key + 明确授权 + 国内可直连」的图库；
 *    Wikimedia / Openverse 在这台机器上 DNS 能解析但连接超时（实测 12 秒无响应），
 *    Unsplash 的 source 接口已停服，LoremFlickr 返回 500。绕不过去就不接。
 *  - 没有 Key 时不报错，直接返回 null 让上层降级到 AI 生成 —— 配图绝不能开天窗。
 *  - 照片统一按 1280x720 取，和 pptx 里的图位比例一致，不用二次裁切。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const CONFIG = require('./config')

const DIR = path.join(CONFIG.DATA_DIR, 'aippt', 'img')
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })

const SETTINGS_FILE = path.join(CONFIG.DATA_DIR, 'settings.json')

/** 读 Pexels Key：环境变量优先，其次 data/settings.json 里的 imageSearchKey */
function apiKey() {
  const env = String(process.env.PEXELS_API_KEY || '').trim()
  if (env) return env
  try {
    const j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    return String(j?.imageSearchKey || j?.pexelsKey || '').trim()
  } catch (_) {
    return ''
  }
}

function hasKey() {
  return Boolean(apiKey())
}

/** 写入/清除 Key（供设置页调用） */
function setKey(key) {
  let j = {}
  try {
    j = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) || {}
  } catch (_) {
    j = {}
  }
  const v = String(key || '').trim()
  if (v) j.imageSearchKey = v
  else delete j.imageSearchKey
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(j, null, 2))
  return Boolean(v)
}

const keyOf = (q, seed) => crypto.createHash('sha1').update(`web:${q}:${seed}`).digest('hex').slice(0, 20)

/** 已下载过就直接复用，重渲染不再打接口 */
function reuse(key) {
  for (const ext of ['jpg', 'png', 'webp']) {
    const f = path.join(DIR, `${key}.${ext}`)
    if (fs.existsSync(f) && fs.statSync(f).size > 2048) return { file: f, ext, name: `${key}.${ext}` }
  }
  return null
}

/**
 * 按关键词搜一张真实照片并落盘。
 * 返回 { ok, file, ext, name, source:'web', credit } 或 { ok:false, error }
 */
async function searchOne({ query, seed = 1, timeoutMs = 12000 } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: '缺少搜索关键词' }

  const key = keyOf(q, seed)
  const hit = reuse(key)
  if (hit) return { ok: true, ...hit, source: 'cache' }

  const k = apiKey()
  if (!k) return { ok: false, error: 'no-key' }

  const url =
    'https://api.pexels.com/v1/search?query=' +
    encodeURIComponent(q).replace(/%20/g, '+') +
    `&per_page=15&orientation=landscape&size=large&page=${1 + (seed % 3)}`

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { Authorization: k, Accept: 'application/json' },
      signal: ctrl.signal,
    })
    if (res.status === 401) return { ok: false, error: 'bad-key' }
    if (res.status === 429) return { ok: false, error: 'rate-limited' }
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const j = await res.json()
    const list = Array.isArray(j?.photos) ? j.photos : []
    if (!list.length) return { ok: false, error: 'no-result' }

    // 同一关键词取不同 seed 时落不同照片，避免一页两图撞成同一张
    const pick = list[seed % list.length]
    const src = pick?.src?.large2x || pick?.src?.large || pick?.src?.original
    if (!src) return { ok: false, error: 'no-src' }

    const img = await fetch(src, { signal: ctrl.signal })
    if (!img.ok) return { ok: false, error: `图片下载失败 HTTP ${img.status}` }
    const buf = Buffer.from(await img.arrayBuffer())
    if (buf.length < 8192) return { ok: false, error: '图片过小' }

    const file = path.join(DIR, `${key}.jpg`)
    fs.writeFileSync(file, buf)
    return {
      ok: true,
      file,
      ext: 'jpg',
      name: `${key}.jpg`,
      source: 'web',
      credit: `${pick.photographer || ''} / Pexels`.trim(),
    }
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? 'timeout' : err.message }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 关键词：把中文页标题变成能搜到照片的英文词
 *
 * Pexels 的索引是英文的，中文查询命中率极低。这里不引入翻译服务，
 * 而是用「领域词表 + 通用修饰」拼一个够用的英文查询：
 * 命中词表就用词表，没命中就退回通用商务词（宁可图泛一点，也不要搜不到）。
 * ------------------------------------------------------------------ */

const GLOSSARY = [
  [['人工智能', 'ai', '智能体', 'agent', '大模型', '算法'], 'artificial intelligence technology'],
  [['数据', '指标', '报表', '分析'], 'data analytics dashboard'],
  [['会议', '沟通', '协作', '团队'], 'business team meeting'],
  [['客户', '服务', '客服', '用户'], 'customer service support'],
  [['金融', '银行', '支付', '保险'], 'finance banking'],
  [['零售', '门店', '电商', '销售'], 'retail store shopping'],
  [['制造', '工厂', '生产', '供应链'], 'factory manufacturing'],
  [['文旅', '旅游', '景区', '文化'], 'travel tourism landscape'],
  [['城市', '县域', '乡村', '地方'], 'city street aerial'],
  [['教育', '学习', '培训', '课程'], 'education learning classroom'],
  [['医疗', '健康', '医院'], 'healthcare medical'],
  [['办公', '流程', '效率', '管理'], 'modern office workplace'],
  [['增长', '市场', '营销', '品牌'], 'marketing growth business'],
  [['年轻', '青年', '潮流', '社交'], 'young people lifestyle'],
]

const GENERIC = ['business presentation', 'modern office light', 'abstract business concept']

/** 把一句中文标题映射成一个英文图片查询词 */
function toQuery(text, seed = 0) {
  const s = String(text || '')
  for (const [words, en] of GLOSSARY) {
    if (words.some((w) => s.toLowerCase().includes(w))) return en
  }
  return GENERIC[seed % GENERIC.length]
}

module.exports = {
  hasKey,
  setKey,
  apiKey,
  searchOne,
  toQuery,
}
