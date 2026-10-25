'use strict'

/**
 * 9.8.0：AIPPT —— 「AIPPT」页面的后端。
 *
 * 流程（对齐千问的体验）：
 *   ① 策划推理（流式）—— 混沌先想清楚受众、主张、叙事主线，边想边推给前端
 *   ② 逐页大纲（流式）—— 基于上面的推理产出结构化 JSON，标题边生成边冒出来
 *   ③ 配图（并发）—— 有网走在线文生图，断网用本地程序化插画兜底
 *   ④ 渲染 —— pptxgenjs 按所选模板 + 页型（要点/双栏/数据/金句）排版落地
 *
 * 设计取舍：
 *  - 两阶段而不是一次问完：7B 级模型直接产出高质量 JSON 很容易「想到哪写到哪」，
 *    先让它用自然语言把逻辑理顺，再据理成文，成稿质量明显更稳（用户明确要质量）
 *  - 大纲旁挂 .json：改完字直接重渲染，不用再跑一次模型，也不会改一处问一遍
 *  - 产物全部落在 DATA_DIR/aippt/，id 只认 [a-f0-9]{16}，杜绝路径穿越
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const PptxGenJS = require('pptxgenjs')
const CONFIG = require('./config')
const chaosLlm = require('./chaos-llm')
const imageGen = require('./aippt-image')

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

/**
 * 9.8.0：模板。每套 = 一套配色 + 一种封面版式。
 * coverStyle：full 整幅大图 / split 左文右图 / band 浅色大标题
 */
const THEMES = {
  emerald: {
    label: '暗夜绿',
    desc: '深色封面 + 亮绿强调，稳妥耐看',
    coverStyle: 'full',
    coverBg: '0F172A',
    coverTitle: 'FFFFFF',
    coverSub: 'A7F3D0',
    pageBg: 'FFFFFF',
    title: '0F172A',
    text: '334155',
    accent: '22C55E',
    tocBg: 'F8FAFC',
    panel: 'F1F5F9',
  },
  business: {
    label: '商务蓝',
    desc: '藏青配亮蓝，汇报场景通用',
    coverStyle: 'split',
    coverBg: '0B2545',
    coverTitle: 'FFFFFF',
    coverSub: '93B4D8',
    pageBg: 'FFFFFF',
    title: '0B2545',
    text: '334155',
    accent: '2563EB',
    tocBg: 'F5F8FC',
    panel: 'EEF4FC',
  },
  minimal: {
    label: '极简白',
    desc: '白底大字，学术与评审最爱',
    coverStyle: 'band',
    coverBg: 'F4F5F7',
    coverTitle: '111827',
    coverSub: '6B7280',
    pageBg: 'FFFFFF',
    title: '111827',
    text: '374151',
    accent: '111827',
    tocBg: 'FAFAFA',
    panel: 'F3F4F6',
  },
  sunset: {
    label: '活力橙',
    desc: '暖色调，营销与路演有冲劲',
    coverStyle: 'band',
    coverBg: '2A1503',
    coverTitle: 'FFFFFF',
    coverSub: 'FDBA74',
    pageBg: 'FFFFFF',
    title: '7C2D12',
    text: '44403C',
    accent: 'F97316',
    tocBg: 'FFF7ED',
    panel: 'FFF1E5',
  },
  violet: {
    label: '科技紫',
    desc: '深紫配亮紫，技术发布会适用',
    coverStyle: 'full',
    coverBg: '170B2E',
    coverTitle: 'FFFFFF',
    coverSub: 'C4B5FD',
    pageBg: 'FFFFFF',
    title: '1E1B4B',
    text: '3730A3',
    accent: '8B5CF6',
    tocBg: 'F5F3FF',
    panel: 'F1ECFE',
  },
  ocean: {
    label: '深海青',
    desc: '青蓝冷静，数据与分析类首选',
    coverStyle: 'split',
    coverBg: '042F2E',
    coverTitle: 'FFFFFF',
    coverSub: '99F6E4',
    pageBg: 'FFFFFF',
    title: '134E4A',
    text: '334155',
    accent: '0D9488',
    tocBg: 'F0FDFA',
    panel: 'E7F8F4',
  },
  crimson: {
    label: '玫瑰红',
    desc: '沉稳酒红，品牌与年度汇报',
    coverStyle: 'full',
    coverBg: '2B0A14',
    coverTitle: 'FFFFFF',
    coverSub: 'FDA4AF',
    pageBg: 'FFFFFF',
    title: '4C0519',
    text: '3F3F46',
    accent: 'E11D48',
    tocBg: 'FFF1F2',
    panel: 'FFE4E6',
  },
  graphite: {
    label: '石墨灰',
    desc: '黑白灰，最保险的商务通用',
    coverStyle: 'band',
    coverBg: 'E4E4E7',
    coverTitle: '18181B',
    coverSub: '52525B',
    pageBg: 'FFFFFF',
    title: '18181B',
    text: '3F3F46',
    accent: '18181B',
    tocBg: 'FAFAFA',
    panel: 'F4F4F5',
  },
}

const LANGS = { zh: '中文', en: 'English' }
const MIN_PAGES = 3
const MAX_PAGES = 30

/** 页型白名单 —— 模型给错的按位置兜底推断 */
const KINDS = new Set(['cover', 'bullets', 'twocol', 'stats', 'quote', 'closing'])

const ID_RE = /^[a-f0-9]{16}$/

/** 中文字体优先雅黑（Windows 全都有）；英文用 Segoe UI */
const FONT_ZH = 'Microsoft YaHei'
const FONT_EN = 'Segoe UI'

function fontFor(lang) {
  return lang === 'en' ? FONT_EN : FONT_ZH
}

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

/** 流式阶段抢跑用的「半成品大纲」探测：模型每吐一段就试着抽出已完成页的标题 */
function sniffProgress(text) {
  const raw = String(text || '')
  const titles = []
  const re = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let m
  while ((m = re.exec(raw))) {
    const t = m[1].replace(/\\"/g, '"').trim()
    if (t && t !== titles[titles.length - 1]) titles.push(t)
  }
  return { titles: titles.slice(0, 40), chars: raw.length }
}

/* ------------------------------------------------------------------ *
 * 归一化
 * ------------------------------------------------------------------ */

function clampPages(v, fallback = 6) {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(MAX_PAGES, Math.max(MIN_PAGES, n))
}

function normalizeTheme(id) {
  return THEMES[id] ? id : 'emerald'
}

/**
 * 解析要用的模型。
 * 不传模型时必须是**真实存在的**模型名 —— 把 undefined 塞进 /api/chat 的 body，
 * JSON.stringify 会把这个键整个丢掉，Ollama 直接回 400（9.8.0 调试时踩过）。
 */
function resolveModel(model) {
  const m = String(model || '').trim()
  if (m) return m
  try {
    const s = chaosLlm.snapshot()
    const first = (s?.models || []).find((x) => x.installed) || (s?.models || [])[0]
    if (first?.id) return first.id
  } catch (_) {
    /* 探测失败就用兜底 */
  }
  return 'qwen2.5:7b'
}

function strList(v, limit = 6, maxLen = 120) {
  return (Array.isArray(v) ? v : v == null ? [] : [v])
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean)
    .slice(0, limit)
    .map((x) => x.slice(0, maxLen))
}

/**
 * 把模型给的粗糙 slides 整理成稳定结构。
 * 9.8.0 新增：kind（页型）/ extra（双栏第二栏）/ stats（数据卡）/ note（备注）/ image（配图提示词）
 */
function normalizeOutline(raw, { topic, n }) {
  const list = (Array.isArray(raw?.slides) ? raw.slides : []).slice(0, n)
  const slides = list.map((s, i) => {
    const isFirst = i === 0
    const isLast = i === list.length - 1 && list.length > 1
    let kind = String(s?.kind || '')
      .toLowerCase()
      .trim()
    if (!KINDS.has(kind)) kind = isFirst ? 'cover' : isLast ? 'closing' : 'bullets'
    // 首尾页的页型强制矫正，模型爱乱填
    if (isFirst) kind = 'cover'
    else if (isLast && kind !== 'quote' && kind !== 'stats') kind = 'closing'

    const body = strList(s?.body, 6)
    const extra = strList(s?.extra, 6)
    const stats = (Array.isArray(s?.stats) ? s.stats : [])
      .slice(0, 3)
      .map((x) => ({
        v: String(x?.v ?? x?.value ?? '')
          .trim()
          .slice(0, 12),
        l: String(x?.l ?? x?.label ?? '')
          .trim()
          .slice(0, 24),
      }))
      .filter((x) => x.v || x.l)

    // 数据卡但没数据 / 双栏但缺一边 → 退回普通要点页，别渲染出空框
    let finalKind = kind
    if (finalKind === 'stats' && stats.length < 2) finalKind = 'bullets'
    if (finalKind === 'twocol' && (extra.length < 2 || body.length < 2)) finalKind = 'bullets'
    if (finalKind === 'quote' && !body.length) finalKind = 'bullets'

    return {
      title: String(s?.title || (isFirst ? topic : `第 ${i + 1} 页`)).slice(0, 80),
      kicker: String(s?.kicker || '').slice(0, 8),
      kind: finalKind,
      body: body.length ? body : isFirst || finalKind === 'closing' ? [] : ['（本页内容待补充）'],
      extra,
      stats,
      note: String(s?.note || '').slice(0, 400),
      image: String(s?.image || '').slice(0, 300),
      imageName: '',
    }
  })

  // 页数不足就补内容页，绝不让用户拿到只有 2 页的东西
  const blank = () => ({
    title: '补充内容',
    kicker: '',
    kind: 'bullets',
    body: ['这一页可以补充你想强调的其他要点'],
    extra: [],
    stats: [],
    note: '',
    image: '',
    imageName: '',
  })
  let guard = 0
  while (slides.length < n && slides.length >= 2 && guard++ < 60) {
    slides.splice(slides.length - 1, 0, blank())
  }

  return {
    title: String(raw?.title || topic).slice(0, 80),
    subtitle: String(raw?.subtitle || '').slice(0, 120),
    slides,
  }
}

/** 用户改过的大纲（render 用）：只洗格式，不补页、不推断页型 */
function cleanOutlineForRender(outline) {
  const slides = (Array.isArray(outline?.slides) ? outline.slides : [])
    .map((s, i) => {
      const kindRaw = String(s?.kind || '')
      return {
        title: String(s?.title || `第 ${i + 1} 页`).slice(0, 80),
        kicker: String(s?.kicker || '').slice(0, 8),
        kind: KINDS.has(kindRaw) ? kindRaw : i === 0 ? 'cover' : 'bullets',
        body: strList(s?.body, 8),
        extra: strList(s?.extra, 8),
        stats: (Array.isArray(s?.stats) ? s.stats : [])
          .slice(0, 3)
          .map((x) => ({
            v: String(x?.v ?? '').slice(0, 12),
            l: String(x?.l ?? '').slice(0, 24),
          })),
        note: String(s?.note || '').slice(0, 400),
        image: String(s?.image || '').slice(0, 300),
        // 重渲染优先复用已经出好的图，缓存命中就不再下载
        imageName: String(s?.imageName || '').slice(0, 60),
      }
    })
    .filter((s) => s.title)
  return {
    title: String(outline?.title || '未命名演示文稿').slice(0, 80),
    subtitle: String(outline?.subtitle || '').slice(0, 120),
    slides,
  }
}

/* ------------------------------------------------------------------ *
 * pptx 渲染
 * ------------------------------------------------------------------ */

const PAGE_W = 13.333
const PAGE_H = 7.5

/**
 * 渲染一份 PPTX。
 * images：{ [slideIndex]: 绝对路径 }，缺图时该页自动走无图版式。
 */
function buildPptx({ outline, themeId, withToc, images = {}, lang = 'zh' }) {
  const T = THEMES[normalizeTheme(themeId)]
  const F = fontFor(lang)
  const slides = outline.slides
  const total = slides.length + (withToc ? 1 : 0)

  const pptx = new PptxGenJS()
  pptx.defineLayout({ name: 'W16x9', width: PAGE_W, height: PAGE_H })
  pptx.layout = 'W16x9'
  pptx.title = outline.title
  pptx.author = 'ChaosConsole'
  pptx.company = 'ChaosConsole'

  const img = (i) => (images[i] && fs.existsSync(images[i]) ? images[i] : null)

  /* ---------------- 封面 ---------------- */
  {
    const s = pptx.addSlide()
    const cover = slides[0] || { title: outline.title, body: [] }
    const pic = img(0)
    const sub = outline.subtitle || cover.body?.[0] || ''
    const split = Boolean(pic) && T.coverStyle === 'split'

    s.background = { color: T.coverBg }

    if (pic && T.coverStyle === 'full') {
      // 整幅大图 + 压暗，保证标题任何底色下都读得清
      s.addImage({ path: pic, x: 0, y: 0, w: PAGE_W, h: PAGE_H })
      s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: PAGE_H, fill: { color: '000000', transparency: 42 } })
      s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: PAGE_H, fill: { color: T.coverBg, transparency: 32 } })
    } else if (split) {
      s.addImage({ path: pic, x: 7.1, y: 0, w: PAGE_W - 7.1, h: PAGE_H })
      s.addShape('rect', { x: 7.08, y: 0, w: 0.07, h: PAGE_H, fill: { color: T.accent } })
    }

    s.addShape('rect', { x: 0.85, y: 2.1, w: 0.16, h: 1.25, fill: { color: T.accent } })
    s.addText(outline.title || cover.title || '未命名演示文稿', {
      x: 1.2,
      y: 2.05,
      w: split ? 5.6 : 10.9,
      h: 1.35,
      fontSize: 40,
      bold: true,
      color: T.coverTitle,
      fontFace: F,
      valign: 'middle',
      fit: 'shrink',
    })
    if (sub) {
      s.addText(sub, {
        x: 1.24,
        y: 3.5,
        w: split ? 5.5 : 9.7,
        h: 0.85,
        fontSize: 16,
        color: T.coverSub,
        fontFace: F,
        fit: 'shrink',
      })
    }
    s.addText(new Date().toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN'), {
      x: 1.24,
      y: 6.35,
      w: 4,
      h: 0.4,
      fontSize: 11,
      color: T.coverSub,
      fontFace: F,
    })
  }

  /* ---------------- 目录 ---------------- */
  if (withToc) {
    const toc = pptx.addSlide()
    toc.background = { color: T.tocBg }
    toc.addText(lang === 'en' ? 'Contents' : '目录', {
      x: 0.8,
      y: 0.55,
      w: 6,
      h: 0.9,
      fontSize: 28,
      bold: true,
      color: T.title,
      fontFace: F,
    })
    toc.addShape('rect', { x: 0.8, y: 1.5, w: 1.2, h: 0.06, fill: { color: T.accent } })
    const items = slides
      .slice(1, -1)
      .map((s, i) => ({
        text: `${String(i + 1).padStart(2, '0')}   ${s.title}`,
        options: { breakLine: true, fontSize: 15, color: T.text, fontFace: F },
      }))
    toc.addText(items.length ? items : [{ text: '—', options: { fontSize: 15, color: T.text } }], {
      x: 1.0,
      y: 1.95,
      w: 11,
      h: 4.6,
      lineSpacingMultiple: 1.75,
      valign: 'top',
      fit: 'shrink',
    })
  }

  /* ---------------- 内容页 ---------------- */
  for (let i = 1; i < slides.length; i++) {
    const sl = slides[i]
    const s = pptx.addSlide()
    const pic = img(i)
    const pageNo = i + 1

    /* 结尾页：深色 + 一句话，收得干净 */
    if (sl.kind === 'closing') {
      s.background = { color: T.coverBg }
      if (pic) {
        s.addImage({ path: pic, x: 0, y: 0, w: PAGE_W, h: PAGE_H })
        s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: PAGE_H, fill: { color: '000000', transparency: 55 } })
      }
      s.addShape('rect', { x: PAGE_W / 2 - 0.6, y: 2.35, w: 1.2, h: 0.06, fill: { color: T.accent } })
      s.addText(sl.title, {
        x: 1.2,
        y: 2.6,
        w: PAGE_W - 2.4,
        h: 1.1,
        fontSize: 34,
        bold: true,
        color: T.coverTitle,
        align: 'center',
        fontFace: F,
        fit: 'shrink',
      })
      if (sl.body?.[0]) {
        s.addText(sl.body[0], {
          x: 1.8,
          y: 3.85,
          w: PAGE_W - 3.6,
          h: 0.9,
          fontSize: 15,
          color: T.coverSub,
          align: 'center',
          fontFace: F,
          fit: 'shrink',
        })
      }
      if (sl.note) {
        try {
          s.addNotes(sl.note)
        } catch (_) {
          /* ignore */
        }
      }
      continue
    }

    s.background = { color: T.pageBg }

    /* 页眉：kicker + 标题 + 强调线 */
    if (sl.kicker) {
      s.addText(sl.kicker, {
        x: 0.75,
        y: 0.42,
        w: 1.2,
        h: 0.3,
        fontSize: 11,
        bold: true,
        color: T.accent,
        charSpacing: 2,
        fontFace: F,
      })
    }
    s.addText(sl.title, {
      x: 0.72,
      y: sl.kicker ? 0.68 : 0.55,
      w: pic && sl.kind === 'bullets' ? 6.3 : PAGE_W - 1.5,
      h: 0.85,
      fontSize: 25,
      bold: true,
      color: T.title,
      fontFace: F,
      valign: 'middle',
      fit: 'shrink',
    })
    s.addShape('rect', {
      x: 0.75,
      y: sl.kicker ? 1.55 : 1.42,
      w: 1.1,
      h: 0.055,
      fill: { color: T.accent },
    })

    const bodyTop = sl.kicker ? 1.95 : 1.82
    const bodyH = PAGE_H - bodyTop - 0.55

    /* ---- 版式 1：要点（有图则左文右图） ---- */
    if (sl.kind === 'bullets' || sl.kind === 'cover') {
      const twoCol = Boolean(pic)
      const textW = twoCol ? 6.0 : PAGE_W - 1.9
      const items = (sl.body?.length ? sl.body : ['（本页暂无内容）']).map((t) => ({
        text: t,
        options: {
          bullet: { code: '25CF' },
          breakLine: true,
          paraSpaceAfter: 10,
          fontSize: sl.body.length <= 3 ? 18 : sl.body.length === 4 ? 16.5 : 15,
          color: T.text,
          fontFace: F,
        },
      }))
      s.addText(items, {
        x: 0.95,
        y: bodyTop,
        w: textW,
        h: bodyH,
        lineSpacingMultiple: 1.28,
        valign: 'top',
        fit: 'shrink',
      })
      if (twoCol) {
        s.addImage({ path: pic, x: 7.35, y: bodyTop + 0.25, w: 5.25, h: 2.95 })
        s.addShape('rect', { x: 7.35, y: bodyTop + 3.35, w: 0.9, h: 0.045, fill: { color: T.accent } })
      }
    }

    /* ---- 版式 2：双栏对比 ---- */
    if (sl.kind === 'twocol') {
      const colW = 5.35
      const gap = 0.55
      const x1 = 0.9
      const x2 = x1 + colW + gap
      const blockH = Math.min(bodyH - 0.1, 4.4)
      for (const [idx, list] of [
        [0, sl.body],
        [1, sl.extra],
      ]) {
        const x = idx === 0 ? x1 : x2
        s.addShape('rect', {
          x,
          y: bodyTop,
          w: colW,
          h: blockH,
          fill: { color: T.panel },
          line: { color: T.panel, width: 1 },
          rectRadius: 0.06,
        })
        s.addShape('rect', { x, y: bodyTop, w: colW, h: 0.06, fill: { color: idx === 0 ? T.accent : T.text } })
        s.addText(
          (list?.length ? list : ['—']).map((t) => ({
            text: t,
            options: {
              bullet: { code: '25CF' },
              breakLine: true,
              paraSpaceAfter: 8,
              fontSize: 14.5,
              color: T.text,
              fontFace: F,
            },
          })),
          {
            x: x + 0.22,
            y: bodyTop + 0.24,
            w: colW - 0.44,
            h: blockH - 0.4,
            lineSpacingMultiple: 1.24,
            valign: 'top',
            fit: 'shrink',
          },
        )
      }
    }

    /* ---- 版式 3：数据卡 ---- */
    if (sl.kind === 'stats') {
      const n = sl.stats.length
      const cardW = Math.min(3.6, (PAGE_W - 1.8 - (n - 1) * 0.35) / n)
      const totalW = n * cardW + (n - 1) * 0.35
      const x0 = (PAGE_W - totalW) / 2
      const cardH = 2.15
      sl.stats.forEach((st, k) => {
        const x = x0 + k * (cardW + 0.35)
        s.addShape('rect', {
          x,
          y: bodyTop + 0.15,
          w: cardW,
          h: cardH,
          fill: { color: T.panel },
          line: { color: T.panel, width: 1 },
          rectRadius: 0.08,
        })
        s.addText(st.v, {
          x,
          y: bodyTop + 0.42,
          w: cardW,
          h: 1.0,
          fontSize: 40,
          bold: true,
          color: T.accent,
          align: 'center',
          fontFace: F,
          fit: 'shrink',
        })
        s.addText(st.l, {
          x: x + 0.15,
          y: bodyTop + 1.45,
          w: cardW - 0.3,
          h: 0.7,
          fontSize: 12.5,
          color: T.text,
          align: 'center',
          fontFace: F,
          fit: 'shrink',
        })
      })
      if (sl.body?.[0]) {
        s.addText(sl.body[0], {
          x: 1.2,
          y: bodyTop + cardH + 0.55,
          w: PAGE_W - 2.4,
          h: 0.9,
          fontSize: 14,
          color: T.text,
          align: 'center',
          fontFace: F,
          fit: 'shrink',
        })
      }
    }

    /* ---- 版式 4：金句 ---- */
    if (sl.kind === 'quote') {
      s.addShape('rect', { x: 0.9, y: bodyTop + 0.1, w: 0.14, h: 2.6, fill: { color: T.accent } })
      s.addText(sl.body?.[0] || sl.title, {
        x: 1.35,
        y: bodyTop + 0.3,
        w: PAGE_W - 2.9,
        h: 2.2,
        fontSize: 27,
        color: T.title,
        lineSpacingMultiple: 1.35,
        valign: 'middle',
        fontFace: F,
        fit: 'shrink',
      })
      if (sl.body?.[1]) {
        s.addText(`— ${sl.body[1]}`, {
          x: 1.4,
          y: bodyTop + 2.6,
          w: PAGE_W - 3,
          h: 0.5,
          fontSize: 13,
          color: T.text,
          fontFace: F,
        })
      }
    }

    /* 页码 */
    s.addText(`${pageNo} / ${total}`, {
      x: PAGE_W - 1.5,
      y: PAGE_H - 0.55,
      w: 0.9,
      h: 0.3,
      fontSize: 9.5,
      color: '94A3B8',
      align: 'right',
      fontFace: F,
    })

    /* 演讲备注（在 PowerPoint 备注栏里，放映时不显示） */
    if (sl.note) {
      try {
        s.addNotes(sl.note)
      } catch (_) {
        /* 备注写不进去不影响正片 */
      }
    }
  }

  return pptx
}

/* ------------------------------------------------------------------ *
 * 文件落盘 / 读取
 * ------------------------------------------------------------------ */

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
  try {
    fs.writeFileSync(file.replace(/\.pptx$/, '.json'), JSON.stringify({ outline, ...meta }, null, 2), 'utf8')
  } catch (_) {
    /* 旁挂文件写不出来不影响主产物 */
  }
  const st = fs.statSync(file)
  return { file, size: st.size }
}

/* ------------------------------------------------------------------ *
 * 阶段一 / 二：提示词
 * ------------------------------------------------------------------ */

function planPrompt({ topic, n, toneDesc, audience, lang }) {
  if (lang === 'en') {
    return (
      `You are a top-tier presentation strategist. Deck topic: "${topic}". Total ${n} slides.\n` +
      `Tone: ${toneDesc}.\n` +
      (audience ? `Audience: ${audience}.\n` : '') +
      `Think it through before writing anything, in English, 200-320 words, as numbered points:\n` +
      `1) The single core argument this deck must land.\n` +
      `2) What this audience cares about most, and what they will push back on.\n` +
      `3) The narrative spine: which 3-5 parts, what each part is for, how many slides each gets.\n` +
      `4) The 2-3 strongest concrete evidence points (numbers, cases, comparisons) worth showing.\n` +
      `5) Visual direction: which slides deserve an illustration and what the picture should show.\n` +
      `Be specific and opinionated. No pleasantries, no meta commentary.`
    )
  }
  return (
    `你是一位顶级演示文稿策划师。这次要做《${topic}》，共 ${n} 页。\n` +
    `语气：${toneDesc}。\n` +
    (audience ? `听众：${audience}。\n` : '') +
    `先别急着排版，先用中文把策划想清楚，200-320 字，分 5 点：\n` +
    `1）这份演示必须让听众记住的那一个核心主张是什么。\n` +
    `2）听众最关心什么、最可能在哪一点上反对或质疑。\n` +
    `3）叙事主线：分成哪 3-5 个部分，每部分承担什么作用，各占几页。\n` +
    `4）全篇最有说服力的 2-3 个具体论据（数字、案例、前后对比），要能落在页面上。\n` +
    `5）配图方向：哪几页值得配图，画什么画面。\n` +
    `要求：直接给判断，不要客套话，不要说「接下来我将」。`
  )
}

function outlinePrompt({ topic, n, toneDesc, audience, lang, plan }) {
  if (lang === 'en') {
    return (
      `Your own planning notes for this deck:\n---\n${plan}\n---\n` +
      `Now turn it into ${n} slides. Output ONLY the JSON object, no prose, no markdown fences.\n` +
      `{"title":"deck title","subtitle":"one-line subtitle","slides":[{"title":"slide title","kicker":"01","kind":"cover","body":["..."],"extra":[],"stats":[],"note":"speaker note","image":"english image prompt or empty"}]}\n` +
      `Rules:\n` +
      `- slides.length must be exactly ${n}; slide 1 kind="cover"; last slide kind="closing".\n` +
      `- kind is one of cover/bullets/twocol/stats/quote/closing.\n` +
      `- bullets: 3-5 points, each 8-16 words, each containing a concrete noun, number or action. No filler like "introduction" or "overview".\n` +
      `- twocol: body (3 points) vs extra (3 points), used for comparison.\n` +
      `- stats: stats array of 2-3 objects {"v":"82%","l":"efficiency gain"} plus one body line.\n` +
      `- quote: one 15-30 word line in body.\n` +
      `- kicker: section number like "01", empty on cover/closing.\n` +
      `- image: English prompt describing a concrete scene for that slide (no text/letters); empty string if the slide needs no picture. At most 4 slides should have images.\n` +
      `- title max 10 words. Write everything in English.`
    )
  }
  return (
    `这是你刚为《${topic}》写的策划思路：\n---\n${plan}\n---\n` +
    `现在把它落成 ${n} 页的逐页结构。只输出 JSON，不要任何解释、不要 markdown 代码块。\n` +
    `{"title":"整份PPT标题","subtitle":"一句话副标题","slides":[{"title":"本页标题","kicker":"01","kind":"cover","body":["..."],"extra":[],"stats":[],"note":"演讲备注","image":"配图的英文画面描述，不需要就留空"}]}\n` +
    `规则：\n` +
    `- slides 长度必须正好是 ${n}；第 1 页 kind 必须是 "cover"；最后 1 页 kind 必须是 "closing"。\n` +
    `- kind 只能取：cover / bullets / twocol / stats / quote / closing。\n` +
    `- bullets：body 3-5 条，每条 14-26 字，必须含具体名词、数字或动作；禁止「介绍」「概述」「意义重大」这类空话。\n` +
    `- twocol：body 3 条 + extra 3 条，用于左右对比。\n` +
    `- stats：stats 数组 2-3 项 {"v":"82%","l":"效率提升"}，body 再写 1 句结论。\n` +
    `- quote：body 只写 1 条，20-40 字金句。\n` +
    `- kicker：章节号如 "01"，封面页和结尾页留空。\n` +
    `- note：给讲者的一句提示，30 字内。\n` +
    `- image：只有 cover / bullets 页可以配图（这两类版式有图位），写英文画面描述（描述具体场景与主体，不要出现文字）；twocol / stats / quote 一律留空字符串。全篇最多 4 页配图。\n` +
    `- 标题不超过 18 字。全部用中文写作。`
  )
}

/* ------------------------------------------------------------------ *
 * 配图
 * ------------------------------------------------------------------ */

/**
 * 只有这些版式真的给图片留了位置（见 renderSlide 里的 addImage 调用点）。
 * 9.8.0 第一版没做这个过滤：模型给 twocol 页也写了 image，于是白生成一张图，
 * 渲染时无处可放，用户看到的配图数比进度条上的少一张。
 */
const IMAGE_KINDS = new Set(['cover', 'bullets'])

/** 从大纲里挑出需要配图的页（最多 maxImages 张，封面优先） */
function pickImageJobs(outline, themeId, maxImages, lang) {
  const T = THEMES[normalizeTheme(themeId)]
  const slides = outline.slides
  const cap = Math.max(1, maxImages)
  const wants = []
  for (let i = 0; i < slides.length; i++) {
    if (!IMAGE_KINDS.has(slides[i].kind)) continue
    const prompt = String(slides[i].image || '').trim()
    if (prompt) wants.push({ index: i, prompt })
  }
  // 封面没给提示词也补一张 —— 有图的封面观感提升最明显
  if (!wants.some((w) => w.index === 0)) {
    wants.unshift({ index: 0, prompt: `abstract conceptual cover artwork representing "${outline.title}"` })
  }
  // 名额没用完就挑还没配图的要点页补位，别把预算浪费在放不下图的页型上
  for (let i = 1; i < slides.length && wants.length < cap; i++) {
    if (!IMAGE_KINDS.has(slides[i].kind)) continue
    if (wants.some((w) => w.index === i)) continue
    if (!(slides[i].body || []).length) continue
    wants.push({ index: i, prompt: `clean minimal editorial illustration about "${slides[i].title}"` })
  }
  void lang
  return wants.slice(0, Math.max(1, maxImages)).map((w) => ({
    index: w.index,
    prompt: w.prompt,
    seed: 1000 + w.index * 37 + (outline.title.length % 97),
    accent: T.accent,
    deep: T.coverBg,
    themeLabel: T.label,
  }))
}

/* ------------------------------------------------------------------ *
 * 主流程（可选流式）
 * ------------------------------------------------------------------ */

/**
 * 生成一份 PPT。
 * emit(event) 可选：{ type:'phase'|'delta'|'progress'|'outline'|'done'|'error', ... }
 */
async function generate(opts = {}, emit = null) {
  const {
    topic,
    pages = 6,
    tone = 'formal',
    theme = 'emerald',
    language = 'zh',
    audience = '',
    withToc = false,
    withImages = true,
    model,
  } = opts

  const send = (ev) => {
    if (!emit) return
    try {
      emit(ev)
    } catch (_) {
      /* 前端断开了也不该拖垮生成 */
    }
  }

  const n = clampPages(pages, 6)
  const topicClean = String(topic || '').trim()
  if (!topicClean) return { ok: false, error: '请先填写 PPT 主题' }
  const toneDesc = TONES[tone] ? TONES[tone] : TONES.formal
  const lang = LANGS[language] ? language : 'zh'
  const audienceClean = String(audience || '').trim().slice(0, 40)
  const themeId = normalizeTheme(theme)
  const useModel = resolveModel(model)

  /* ---- 阶段一：策划推理（流式显示） ---- */
  send({ type: 'phase', phase: 'plan', label: '策划叙事结构' })
  let plan = ''
  let tokens = 0
  try {
    const r = await chaosLlm.chat({
      model: useModel,
      messages: [
        {
          role: 'system',
          content: lang === 'en' ? 'You are a sharp presentation strategist.' : '你是一位思路清晰的演示文稿策划师。',
        },
        { role: 'user', content: planPrompt({ topic: topicClean, n, toneDesc, audience: audienceClean, lang }) },
      ],
      onDelta: (d) => send({ type: 'delta', phase: 'plan', text: d }),
    })
    plan = String(r?.text || '').trim()
    tokens += Number(r?.evalCount) || Math.ceil(plan.length / 2)
  } catch (err) {
    const msg = String(err?.message || '模型推理失败')
    send({ type: 'error', error: msg, code: err?.code })
    return { ok: false, error: msg, code: err?.code }
  }

  if (!plan) plan = `主题：${topicClean}`

  /* ---- 阶段二：大纲（流式，边生成边冒标题） ---- */
  send({ type: 'phase', phase: 'outline', label: '逐页排大纲' })
  let data = null
  let rawText = ''
  for (let attempt = 1; attempt <= 2 && !data; attempt++) {
    rawText = ''
    try {
      const r = await chaosLlm.chat({
        model: useModel,
        messages: [
          {
            role: 'system',
            content:
              lang === 'en'
                ? 'You output JSON only. No explanation, no markdown fences.'
                : '你只输出 JSON，不输出任何解释或 markdown 代码块标记。',
          },
          {
            role: 'user',
            content: outlinePrompt({ topic: topicClean, n, toneDesc, audience: audienceClean, lang, plan }),
          },
        ],
        onDelta: (d) => {
          rawText += d
          send({ type: 'delta', phase: 'outline', text: d })
        },
      })
      rawText = String(r?.text || rawText)
      tokens += Number(r?.evalCount) || Math.ceil(rawText.length / 2)
    } catch (err) {
      if (attempt === 2) {
        const msg = `模型生成失败：${err.message}`
        send({ type: 'error', error: msg, code: err?.code })
        return { ok: false, error: msg, code: err?.code }
      }
      continue
    }
    data = parseJsonLoose(rawText)
    if (!data || !Array.isArray(data.slides) || !data.slides.length) {
      data = null
      send({ type: 'delta', phase: 'outline', text: '\n（格式没对上，重新整理一次…）\n' })
    }
  }
  if (!data) return { ok: false, error: '模型两次都没能产出有效大纲，请换个主题或换个小模型再试' }

  const outline = normalizeOutline(data, { topic: topicClean, n })
  send({ type: 'outline', outline })

  /* ---- 阶段三：配图 ---- */
  const images = {}
  let imageOk = 0
  if (withImages) {
    const jobs = pickImageJobs(outline, themeId, Math.min(4, Math.max(1, Math.round(n / 2))), lang)
    send({ type: 'phase', phase: 'image', label: `生成配图（0/${jobs.length}）`, total: jobs.length, done: 0 })
    await imageGen.generateMany(jobs, {
      concurrency: 3,
      onStart: (_i, seq, totalCount) => {
        // 免费出图按 45 秒窗口排队，先给个「在等」的提示，别让人以为卡死了
        send({
          type: 'progress',
          phase: 'image',
          label: `生成配图（第 ${Math.min(seq + 1, totalCount)}/${totalCount} 张排队中…）`,
          done: seq,
          total: totalCount,
          pending: true,
        })
      },
      onOne: (i, r, done, totalCount) => {
        if (r?.ok) {
          images[jobs[i].index] = r.file
          outline.slides[jobs[i].index].imageName = r.name
          imageOk += 1
        }
        send({
          type: 'progress',
          phase: 'image',
          label: `生成配图（${done}/${totalCount}）`,
          done,
          total: totalCount,
          index: jobs[i].index,
          source: r?.source || '',
          name: r?.name || '',
        })
      },
    })
  } else {
    send({ type: 'phase', phase: 'image', label: '跳过配图', skipped: true })
  }

  /* ---- 阶段四：渲染 ---- */
  send({ type: 'phase', phase: 'render', label: '排版渲染' })
  const toc = Boolean(withToc) && outline.slides.length >= 5
  const id = crypto.randomBytes(8).toString('hex')
  const pptx = buildPptx({ outline, themeId, withToc: toc, images, lang })
  const out = await writeOut(pptx, id, outline.title, outline, {
    id,
    topic: topicClean,
    tone,
    theme: themeId,
    language: lang,
    audience: audienceClean,
    withToc: toc,
    tokens,
    images: imageOk,
    plan,
    createdAt: Date.now(),
  })

  const result = {
    ok: true,
    id,
    file: out.file,
    download: path.basename(out.file),
    title: outline.title,
    pages: outline.slides.length + (toc ? 1 : 0),
    tokens,
    images: imageOk,
    outline,
    plan,
    theme: themeId,
    withToc: toc,
    size: out.size,
  }
  send({ type: 'done', result })
  return result
}

/**
 * 用（可能被用户改过的）大纲重新渲染。
 * 传 id 就覆盖同一个文件（历史里不会多出一条），不传就新建。
 * 图片：先按大纲里的 imageName 复用缓存，缺的重新出（命中缓存则秒回）。
 */
async function render({ id, outline, theme, withToc } = {}) {
  const clean = cleanOutlineForRender(outline)
  if (clean.slides.length < 2) return { ok: false, error: '大纲至少要有 2 页（含封面）' }

  const reuse = ID_RE.test(String(id || '')) && resolveFile(id) ? String(id) : crypto.randomBytes(8).toString('hex')
  const themeId = normalizeTheme(theme)
  const toc = Boolean(withToc) && clean.slides.length >= 5
  const lang = /[\u4e00-\u9fa5]/.test(clean.title) ? 'zh' : 'en'

  /* 图片：先认 imageName，再按 image 描述补生成 */
  const images = {}
  const need = []
  clean.slides.forEach((s, i) => {
    if (!s.imageName) return
    const hit = imageGen.resolveImage(s.imageName)
    if (hit) images[i] = hit.file
    else if (s.image) need.push(i)
  })
  if (need.length) {
    const T = THEMES[themeId]
    const jobs = need.map((i) => ({
      index: i,
      prompt: clean.slides[i].image,
      seed: 1000 + i * 37 + (clean.title.length % 97),
      accent: T.accent,
      deep: T.coverBg,
      themeLabel: T.label,
    }))
    const results = await imageGen.generateMany(jobs, { concurrency: 3 })
    results.forEach((r, k) => {
      if (r?.ok) {
        images[jobs[k].index] = r.file
        clean.slides[jobs[k].index].imageName = r.name
      }
    })
  }

  const old = resolveFile(reuse)
  if (old) {
    try {
      fs.unlinkSync(old)
    } catch (_) {
      /* ignore */
    }
  }

  const pptx = buildPptx({ outline: clean, themeId, withToc: toc, images, lang })
  const out = await writeOut(pptx, reuse, clean.title, clean, {
    id: reuse,
    theme: themeId,
    withToc: toc,
    images: Object.keys(images).length,
    renderedAt: Date.now(),
  })

  return {
    ok: true,
    id: reuse,
    file: out.file,
    download: path.basename(out.file),
    title: clean.title,
    pages: clean.slides.length + (toc ? 1 : 0),
    images: Object.keys(images).length,
    outline: clean,
    theme: themeId,
    withToc: toc,
    size: out.size,
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

module.exports = {
  generate,
  render,
  getOutline,
  resolveFile,
  deleteFile,
  listFiles,
  buildPptx,
  normalizeOutline,
  sniffProgress,
  pickImageJobs,
  IMAGE_KINDS,
  TONES,
  THEMES,
  LANGS,
  KINDS,
  MIN_PAGES,
  MAX_PAGES,
}
