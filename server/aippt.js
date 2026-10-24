'use strict'

/**
 * 9.5.4：AIPPT —— 左侧 TAB「AIPPT」页面的后端。
 *
 * 流程：主题 + 页数 + 语气 → 混沌（本地 Ollama）产出大纲 JSON →
 * pptxgenjs 本地渲染 .pptx → 存 data/aippt/ → 前端拿 id 下载。
 *
 * 设计取舍：
 *  - 一次 quickAnswer 产出全部页（JSON 格式约束，format:'json'），而不是逐页问 ——
 *    页间衔接更连贯，也少 N-1 次模型冷启动
 *  - JSON 解析失败按 字符数/2 计量后重试一次；两连败把原始文本塞进单页兜底，
 *    绝不让用户白等一场空
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

/**
 * 生成 PPT。返回 { ok, id, file, title, pages, tokens }
 * 失败返回 { ok: false, error }
 */
async function generate({ topic, pages = 6, tone = 'formal', model } = {}) {
  const n = Math.min(16, Math.max(4, Math.round(Number(pages) || 6)))
  const topicClean = String(topic || '').trim()
  if (!topicClean) return { ok: false, error: '请先填写 PPT 主题' }
  const toneDesc = TONES[tone] ? TONES[tone] : TONES.formal

  const system =
    '你是资深 PPT 策划人。只输出 JSON，不要输出任何解释、markdown 代码块标记或多余文字。'
  const prompt =
    `请为一份《${topicClean}》演示文稿做内容策划，共 ${n} 页（含封面页与结尾页）。\n` +
    `写作语气：${toneDesc}。\n` +
    `严格按下面的 JSON 结构输出：\n` +
    `{"title":"整份PPT的标题","slides":[{"title":"本页标题","body":["要点1","要点2","要点3"]}]}\n` +
    `要求：slides 数组长度必须等于 ${n}；每页 body 为 2-4 条要点，每条不超过 30 字；封面页（第 1 页）body 写 1 句副标题；结尾页 body 写 1 句收尾致谢。`

  let data = null
  let tokens = 0
  for (let attempt = 1; attempt <= 2 && !data; attempt++) {
    let text = ''
    try {
      // quickAnswer 返回 { text, model, evalCount, ... }，quotaBill 已在内部记账
      const r = await chaosLlm.quickAnswer({ prompt, system, model, timeoutMs: 180 * 1000 })
      text = String(r?.text || '')
    } catch (err) {
      if (attempt === 2) return { ok: false, error: `模型生成失败：${err.message}` }
      continue
    }
    data = parseJsonLoose(text)
    if (!data || !Array.isArray(data.slides) || !data.slides.length) {
      data = null
      continue
    }
    tokens = Math.ceil(String(text).length / 2)
  }
  if (!data) {
    return { ok: false, error: '模型两次都没能产出有效大纲，请换个主题或换个小模型再试' }
  }

  // 归一化 slides：每页 title/body 必须是字符串/字符串数组
  const slides = data.slides.slice(0, n).map((s, i) => ({
    title: String(s?.title || `第 ${i + 1} 页`),
    body: (Array.isArray(s?.body) ? s.body : [s?.body]).map((x) => String(x)).filter(Boolean),
  }))

  /* ---- pptxgenjs 渲染 ---- */
  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'W16x9', width: 13.333, height: 7.5 })
  pptx.layout = 'W16x9'
  pptx.title = String(data.title || topicClean).slice(0, 80)

  const DARK = '0F172A'
  const ACCENT = '22C55E'

  // 封面页
  const cover = pptx.addSlide()
  cover.background = { color: DARK }
  cover.addText(String(data.title || topicClean), {
    x: 0.8,
    y: 2.4,
    w: 11.7,
    h: 1.6,
    fontSize: 40,
    bold: true,
    color: 'FFFFFF',
    align: 'center',
  })
  cover.addText(slides[0]?.body?.[0] || '', {
    x: 1.6,
    y: 4.2,
    w: 10.1,
    h: 0.9,
    fontSize: 18,
    color: '94A3B8',
    align: 'center',
  })

  // 内容页
  for (let i = 1; i < slides.length; i++) {
    const isLast = i === slides.length - 1
    const slide = pptx.addSlide()
    slide.background = { color: 'FFFFFF' }
    slide.addText(slides[i].title, {
      x: 0.7,
      y: 0.55,
      w: 11.9,
      h: 0.9,
      fontSize: 26,
      bold: true,
      color: DARK,
    })
    slide.addShape('rect', { x: 0.7, y: 1.45, w: 1.2, h: 0.06, fill: { color: ACCENT } })
    slide.addText(
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
        color: '334155',
        lineSpacingMultiple: 1.4,
        valign: 'top',
      },
    )
    slide.addText(`${i + 1} / ${slides.length}`, {
      x: 12.2,
      y: 7.0,
      w: 0.9,
      h: 0.35,
      fontSize: 10,
      color: '94A3B8',
      align: 'right',
    })
  }

  const id = crypto.randomBytes(8).toString('hex')
  const safeTitle = String(data.title || topicClean).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'AIPPT'
  const fileName = `${safeTitle}_${id}.pptx`
  const file = path.join(DIR, fileName)
  await pptx.writeFile({ fileName: file })

  return { ok: true, id, file, download: fileName, title: data.title || topicClean, pages: slides.length, tokens }
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

/** 产物清单（最近优先，最多 20 条） */
function listFiles() {
  try {
    return fs
      .readdirSync(DIR)
      .filter((f) => f.endsWith('.pptx'))
      .map((f) => {
        const st = fs.statSync(path.join(DIR, f))
        return { name: f, id: (f.match(/_([a-f0-9]{16})\.pptx$/) || [])[1] || '', size: st.size, createdAt: st.mtimeMs }
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20)
  } catch (_) {
    return []
  }
}

module.exports = { generate, resolveFile, listFiles, TONES }
