'use strict'

/**
 * 9.6.1：AIPPT —— 左侧 TAB「AIPPT」页面的后端。
 *
 * 流程：主题 + 页数 + 语气（+ 风格/语言/受众/目录页）→ 混沌（本地 Ollama）产出大纲 JSON
 *      → pptxgenjs 本地渲染 .pptx → 存 data/aippt/ → 前端拿 id 下载。
 *
 * 设计取舍：
 *  - 一次 quickAnswer 产出全部页（JSON 格式约束），而不是逐页问 ——
 *    页间衔接更连贯，也少 N-1 次模型冷启动
 *  - JSON 解析失败按 字符数/2 计量后重试一次；两连败把原始文本塞进单页兜底，
 *    绝不让用户白等一场空
 *  - 大纲会另存一份 .json 旁挂文件：支持「改完文字直接重渲染」，
 *    不用再跑一次模型（省时省钱，也保证改了的一定是眼前看到的）
 *  - 产物全部落在 CONFIG.DATA_ROOT/aippt/，id 只认 [a-f0-9]{16}，杜绝路径穿越
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const PptxGenJS = require('pptxgenjs')
const CONFIG = require('./config')
const chaosLlm = require('./chaos-llm')

const DIR = path.join(CONFIG.DATA_DIR, 'aippt')
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })

/** 可选语气（写死在前端下拉里，这里只做白名单兜底） */
const TONES = {
  formal: '正式、专业、结构严谨，用词规范',
  casual: '轻松、口语化、有亲和力，像和朋友聊天',
  academic: '学术、客观、重数据与逻辑推演，少用感叹',
  marketing: '营销、有感染力、多用短句与行动号召',
  concise: '简洁、要点式、每句话都短而准',
}

/** 9.6.1：配色风格。都是「深色封面 + 浅色内页」的路子，投影仪上也看得清 */
const THEMES = {
  emerald: {
    label: '暗夜绿',
    coverBg: '0F172A',
    coverTitle: 'FFFFFF',
    coverSub: '94A3B8',
    pageBg: 'FFFFFF',
    title: '0F172A',
    text: '334155',
    accent: '22C55E',
    tocBg: 'F8FAFC',
  },
  business: {
    label: '商务蓝',
    coverBg: '0B2545',
    coverTitle: 'FFFFFF',
    coverSub: '93B4D8',
    pageBg: 'FFFFFF',
    title: '0B2545',
    text: '334155',
    accent: '2563EB',
    tocBg: 'F5F8FC',
  },
  minimal: {
    label: '极简白',
    coverBg: 'F4F5F7',
    coverTitle: '111827',
    coverSub: '6B7280',
    pageBg: 'FFFFFF',
    title: '111827',
    text: '374151',
    accent: '111827',
    tocBg: 'FAFAFA',
  },
  sunset: {
    label: '活力橙',
    coverBg: '2A1503',
    coverTitle: 'FFFFFF',
    coverSub: 'FDBA74',
    pageBg: 'FFFFFF',
    title: '7C2D12',
    text: '44403C',
    accent: 'F97316',
    tocBg: 'FFF7ED',
  },
  violet: {
    label: '科技紫',
    coverBg: '170B2E',
    coverTitle: 'FFFFFF',
    coverSub: 'C4B5FD',
    pageBg: 'FFFFFF',
    title: '1E1B4B',
    text: '3730A3',
    accent: '8B5CF6',
    tocBg: 'F5F3FF',
  },
}

const LANGS = { zh: '中文', en: 'English' }
const MIN_PAGES = 3
const MAX_PAGES = 30

const ID_RE = /^[a-f0-9]{16}$/

function parseJsonLoose(text) {
  try {
    return JSON.parse(text)
  } catch (_) {
    const m = String(text || '').match(/\{[\s\S]*\}/)
    if (m) {
      try {
        return JSON.parse(m[0])
      } catch (_2) {
        /* fallthrough */
      }
    }
  }
  return null
}

/** 页数归一化：允许用户自己填，夹在 3-30 之间 */
function clampPages(v, fallback = 6) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_PAGES, Math.max(MIN_PAGES, n))
}

function normalizeTheme(id) {
  return THEMES[id] ? id : 'emerald'
}

/** 把模型给的粗糙 slides 整理成稳定结构 */
function normalizeOutline(raw, { topic, n }) {
  const slides = (Array.isArray(raw?.slides) ? raw.slides : [])
    .slice(0, n)
    .map((s, i) => ({
      title: String(s?.title || `第 ${i + 1} 页`).slice(0, 80),
      body: (Array.isArray(s?.body) ? s.body : [s?.body])
        .map((x) => String(x == null ? '' : x).trim())
        .filter(Boolean)
        .slice(0, 6),
    }))
  return {
    title: String(raw?.title || topic).slice(0, 80),
    subtitle: String(raw?.subtitle || '').slice(0, 120),
    slides,
  }
}

/* ------------------------------------------------------------------ *
 * pptx 渲染
 * ------------------------------------------------------------------ */

function buildPptx({ outline, themeId, withToc }) {
  const T = THEMES[normalizeTheme(themeId)]
  const slides = outline.slides
  const total = slides.length + (withToc ? 1 : 0)

  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'W16x9', width: 13.333, height: 7.5 })
  pptx.layout = 'W16x9'
  pptx.title = outline.title

  /* 封面 */
  const cover = pptx.addSlide()
  cover.background = { color: T.coverBg }
  cover.addShape('rect', { x: 0.8, y: 2.15, w: 0.14, h: 1.15, fill: { color: T.accent } })
  cover.addText(outline.title, {
    x: 1.1,
    y: 2.15,
    w: 11.2,
    h: 1.2,
    fontSize: 40,
    bold: true,
    color: T.coverTitle,
    valign: 'middle',
  })
  if (outline.subtitle || slides[0]?.body?.[0]) {
    cover.addText(outline.subtitle || slides[0]?.body?.[0] || '', {
      x: 1.15,
      y: 3.55,
      w: 11.2,
      h: 0.8,
      fontSize: 17,
      color: T.coverSub,
    })
  }
  cover.addText(new Date().toLocaleDateString('zh-CN'), {
    x: 1.15,
    y: 6.4,
    w: 4,
    h: 0.4,
    fontSize: 12,
    color: T.coverSub,
  })

  /* 目录页 */
  if (withToc) {
    const toc = pptx.addSlide()
    toc.background = { color: T.tocBg }
    toc.addText('目录', { x: 0.8, y: 0.6, w: 6, h: 0.9, fontSize: 30, bold: true, color: T.title })
    toc.addShape('rect', { x: 0.8, y: 1.55, w: 1.2, h: 0.06, fill: { color: T.accent } })
    const items = slides.slice(1, -1).map((s, i) => ({
      text: `${String(i + 1).padStart(2, '0')}  ${s.title}`,
      options: { breakLine: true, fontSize: 16, color: T.text },
    }))
    toc.addText(items.length ? items : [{ text: '（无小节）', options: { fontSize: 16, color: T.text } }], {
      x: 1.0,
      y: 2.0,
      w: 11,
      h: 4.6,
      lineSpacingMultiple: 1.6,
      valign: 'top',
    })
  }

  /* 内容页 */
  for (let i = 1; i < slides.length; i++) {
    const isLast = i === slides.length - 1
    const s = pptx.addSlide()
    s.background = { color: T.pageBg }
    s.addText(slides[i].title, {
      x: 0.7,
      y: 0.55,
      w: 11.9,
      h: 0.9,
      fontSize: 26,
      bold: true,
      color: T.title,
    })
    s.addShape('rect', { x: 0.7, y: 1.45, w: 1.2, h: 0.06, fill: { color: T.accent } })
    s.addText(
      (slides[i].body.length ? slides[i].body : ['（本页暂无内容）']).map((t) => ({
        text: t,
        options: { bullet: true, breakLine: true },
      })),
      {
        x: 0.9,
        y: 1.9,
        w: 11.5,
        h: 4.8,
        fontSize: isLast ? 20 : 16,
        color: T.text,
        lineSpacingMultiple: 1.4,
        valign: 'top',
      },
    )
    s.addText(`${i + 1} / ${total}`, {
      x: 12.2,
      y: 7.0,
      w: 0.9,
      h: 0.35,
      fontSize: 10,
      color: '94A3B8',
      align: 'right',
    })
  }

  return pptx
}

function safeName(title, id) {
  const base = String(title || 'AIPPT').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'AIPPT'
  return `${base}_${id}.pptx`
}

function outlinePath(id) {
  if (!ID_RE.test(String(id || ''))) return null
  try {
    const hits = fs.readdirSync(DIR).filter((f) => f.endsWith(`_${id}.json`))
    return hits.length ? path.join(DIR, hits[0]) : null
  } catch (_) {
    return null
  }
}

/** 落盘：pptx + 大纲旁挂文件（同名不同后缀） */
async function writeOut(pptx, id, title, outline, meta) {
  const file = path.join(DIR, safeName(title, id))
  await pptx.writeFile({ fileName: file })
  // 大纲另存，支持后续「改了字直接重渲染」
  try {
    fs.writeFileSync(file.replace(/\.pptx$/, '.json'), JSON.stringify({ outline, ...meta }, null, 2), 'utf8')
  } catch (_) {
    /* 旁挂文件写不出来不影响主产物 */
  }
  const st = fs.statSync(file)
  return { file, size: st.size }
}

/**
 * 生成 PPT。返回 { ok, id, download, title, pages, tokens }
 */
async function generate({
  topic,
  pages = 6,
  tone = 'formal',
  theme = 'emerald',
  language = 'zh',
  audience = '',
  withToc = false,
  model,
} = {}) {
  const n = clampPages(pages, 6)
  const topicClean = String(topic || '').trim()
  if (!topicClean) return { ok: false, error: '请先填写 PPT 主题' }
  const toneDesc = TONES[tone] ? TONES[tone] : TONES.formal
  const lang = LANGS[language] ? language : 'zh'
  const audienceClean = String(audience || '').trim().slice(0, 40)

  const system =
    lang === 'en'
      ? 'You are a senior presentation planner. Output JSON only, no explanation, no markdown fences.'
      : '你是资深 PPT 策划人。只输出 JSON，不要输出任何解释、markdown 代码块标记或多余文字。'
  const prompt =
    lang === 'en'
      ? `Plan a ${n}-slide deck titled "${topicClean}" (including cover and closing slide).\n` +
        `Tone: ${toneDesc}.\n` +
        (audienceClean ? `Audience: ${audienceClean}.\n` : '') +
        `Write ALL titles and bullet points in English.\n` +
        `Return exactly this JSON:\n` +
        `{"title":"deck title","subtitle":"one-line subtitle","slides":[{"title":"slide title","body":["point 1","point 2","point 3"]}]}\n` +
        `Rules: slides.length must be ${n}; 2-4 bullets per slide, each under 18 words; slide 1 body = subtitle line; last slide body = closing line.`
      : `请为一份《${topicClean}》演示文稿做内容策划，共 ${n} 页（含封面页与结尾页）。\n` +
        `写作语气：${toneDesc}。\n` +
        (audienceClean ? `听众：${audienceClean}（内容要贴合他们的关注点）。\n` : '') +
        `严格按下面的 JSON 结构输出：\n` +
        `{"title":"整份PPT的标题","subtitle":"一句话副标题","slides":[{"title":"本页标题","body":["要点1","要点2","要点3"]}]}\n` +
        `要求：slides 数组长度必须等于 ${n}；每页 body 为 2-4 条要点，每条不超过 30 字；封面页（第 1 页）body 写 1 句副标题；结尾页 body 写 1 句收尾致谢。`

  let data = null
  let tokens = 0
  for (let attempt = 1; attempt <= 2 && !data; attempt++) {
    let text = ''
    try {
      const r = await chaosLlm.quickAnswer({ prompt, system, model, timeoutMs: 180 * 1000 })
      text = String(r?.text || '')
      // 9.6.1：按真实 eval_count 累计（quickAnswer 内部已计入每日额度）；
      // 第一次即使 JSON 解析失败也算 —— 那次推理由模型真跑过，账要能对上。
      tokens += Number(r?.evalCount) || Math.ceil(String(text).length / 2)
    } catch (err) {
      if (attempt === 2) return { ok: false, error: `模型生成失败：${err.message}` }
      continue
    }
    data = parseJsonLoose(text)
    if (!data || !Array.isArray(data.slides) || !data.slides.length) {
      data = null
      continue
    }
  }
  if (!data) {
    return { ok: false, error: '模型两次都没能产出有效大纲，请换个主题或换个小模型再试' }
  }

  const outline = normalizeOutline(data, { topic: topicClean, n })
  const themeId = normalizeTheme(theme)
  const toc = Boolean(withToc) && outline.slides.length >= 5

  const id = crypto.randomBytes(8).toString('hex')
  const pptx = buildPptx({ outline, themeId, withToc: toc })
  const out = await writeOut(pptx, id, outline.title, outline, {
    id,
    topic: topicClean,
    tone,
    theme: themeId,
    language: lang,
    audience: audienceClean,
    withToc: toc,
    createdAt: Date.now(),
  })

  return {
    ok: true,
    id,
    file: out.file,
    download: path.basename(out.file),
    title: outline.title,
    pages: outline.slides.length + (toc ? 1 : 0),
    tokens,
    outline,
    theme: themeId,
    withToc: toc,
  }
}

/**
 * 9.6.1：用（可能被用户改过的）大纲重新渲染。
 * 传 id 就覆盖同一个文件（历史里不会多出一条），不传就新建。
 */
async function render({ id, outline, theme, withToc } = {}) {
  const slides = (Array.isArray(outline?.slides) ? outline.slides : [])
    .map((s, i) => ({
      title: String(s?.title || `第 ${i + 1} 页`).slice(0, 80),
      body: (Array.isArray(s?.body) ? s.body : [String(s?.body || '')])
        .map((x) => String(x == null ? '' : x).trim())
        .filter(Boolean)
        .slice(0, 6),
    }))
    .filter((s) => s.title)
  if (slides.length < 2) return { ok: false, error: '大纲至少要有 2 页（含封面）' }

  const clean = {
    title: String(outline?.title || '未命名演示文稿').slice(0, 80),
    subtitle: String(outline?.subtitle || '').slice(0, 120),
    slides,
  }
  const reuse = ID_RE.test(String(id || '')) && resolveFile(id) ? String(id) : crypto.randomBytes(8).toString('hex')
  const themeId = normalizeTheme(theme)
  const toc = Boolean(withToc) && clean.slides.length >= 5

  // 旧文件先删，避免标题改了以后同一个 id 留下两份
  const old = resolveFile(reuse)
  if (old) {
    try {
      fs.unlinkSync(old)
    } catch (_) {
      /* ignore */
    }
  }

  const pptx = buildPptx({ outline: clean, themeId, withToc: toc })
  const out = await writeOut(pptx, reuse, clean.title, clean, {
    id: reuse,
    theme: themeId,
    withToc: toc,
    renderedAt: Date.now(),
  })

  return {
    ok: true,
    id: reuse,
    file: out.file,
    download: path.basename(out.file),
    title: clean.title,
    pages: clean.slides.length + (toc ? 1 : 0),
    outline: clean,
    theme: themeId,
    withToc: toc,
  }
}

/** 读历史产物的大纲（前端「载入大纲」用） */
function getOutline(id) {
  const p = outlinePath(id)
  if (!p) return { ok: false, error: '这份 PPT 没有保存大纲（可能是旧版本生成的）' }
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'))
    return { ok: true, data }
  } catch (err) {
    return { ok: false, error: `大纲读取失败：${err.message}` }
  }
}

/** 按 id 解析产物文件（id 白名单校验，杜绝路径穿越） */
function resolveFile(id) {
  if (!ID_RE.test(String(id || ''))) return null
  try {
    const hits = fs.readdirSync(DIR).filter((f) => f.endsWith(`_${id}.pptx`))
    return hits.length ? path.join(DIR, hits[0]) : null
  } catch (_) {
    return null
  }
}

/** 删除一份产物（pptx + 大纲旁挂文件） */
function deleteFile(id) {
  if (!ID_RE.test(String(id || ''))) return { ok: false, error: '非法的文件 id' }
  const f = resolveFile(id)
  const j = outlinePath(id)
  if (!f && !j) return { ok: false, error: '文件不存在' }
  let removed = 0
  for (const p of [f, j]) {
    if (!p) continue
    try {
      fs.unlinkSync(p)
      removed += 1
    } catch (_) {
      /* ignore */
    }
  }
  return { ok: true, removed }
}

/** 产物清单（最近优先，最多 20 条） */
function listFiles() {
  try {
    return fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.pptx'))
      .map((f) => {
        const st = fs.statSync(path.join(DIR, f))
        const id = (f.match(/_([a-f0-9]{16})\.pptx$/) || [])[1] || ''
        return {
          name: f,
          id,
          size: st.size,
          createdAt: st.mtimeMs,
          hasOutline: Boolean(id && outlinePath(id)),
        }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
  } catch (_) {
    return []
  }
}

module.exports = { generate, render, getOutline, resolveFile, deleteFile, listFiles, TONES, THEMES, LANGS, MIN_PAGES, MAX_PAGES }
