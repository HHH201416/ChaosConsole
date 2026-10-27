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
/* 9.9.7：所有 AI 任务（含 PPT、配图）统一计入任务数量与免费 token 总量 */
const quota = require('./chaos-quota')
const crypto = require('crypto')
const PptxGenJS = require('pptxgenjs')
const CONFIG = require('./config')
const chaosLlm = require('./chaos-llm')
const imageGen = require('./aippt-image')
const webimage = require('./aippt-webimage')
const researchMod = require('./aippt-research')
const quality = require('./aippt-quality')

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
  sky: {
    label: '天空蓝',
    desc: '清爽天蓝，年轻团队与产品介绍',
    coverStyle: 'full',
    coverBg: '082F49',
    coverTitle: 'FFFFFF',
    coverSub: 'BAE6FD',
    pageBg: 'FFFFFF',
    title: '0C4A6E',
    text: '334155',
    accent: '0EA5E9',
    tocBg: 'F0F9FF',
    panel: 'E0F2FE',
  },
  sand: {
    label: '暖沙金',
    desc: '大地暖调，文化与生活类内容',
    coverStyle: 'split',
    coverBg: '292018',
    coverTitle: 'FFFFFF',
    coverSub: 'FDE68A',
    pageBg: 'FFFFFF',
    title: '78350F',
    text: '44403C',
    accent: 'D97706',
    tocBg: 'FFFBEB',
    panel: 'FEF3C7',
  },
}

const LANGS = { zh: '中文', en: 'English' }
const MIN_PAGES = 3
const MAX_PAGES = 30

/** 页型白名单 —— 模型给错的按位置兜底推断 */
/* 10.0.1：版式库从 6 种扩到 11 种。
 * 旧版只有「封面 / 要点 / 双栏 / 数据 / 金句 / 结尾」，模型无论写什么都只能往这
 * 六个模子里塞，结果是每页长得一样 —— 这是「像模板」观感的根因。
 * 补上章节过渡、真图表、时间轴、流程、表格对比之后，同一个内容可以被摆成
 * 完全不同的版式，版面节奏才可能像 WPS 那样有起伏。 */
const KINDS = new Set([
  'cover',
  'bullets',
  'twocol',
  'stats',
  'quote',
  'closing',
  'section', // 章节过渡页：大序号 + 章节名
  'chart', // 真图表页：柱/折线/饼/环形
  'timeline', // 时间轴页
  'process', // 流程步骤页
  'compare', // 真表格对比页
])

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
  /* AIPPT 的正文/大纲必须用大模型 —— 用户点名「AIPPT 重点要弄好」。
   * CPU 分层的小模型只用于策划和速答（见 chaosLlm.preferredDefaultModel），
   * 这里反着来：优先 7B 及以上，实在没有才退而求其次。
   * 注意：snapshot().models 是探测到的已装模型，**没有 installed 字段**
   * （那是 catalogFor 加的）—— 按 installed 过滤永远得空数组，会静默
   * 退化成小模型（2026-10-25 实测翻过两次车）。 */
  try {
    const s = chaosLlm.snapshot()
    const installed = (s?.models || []).map((x) => x.id).filter(Boolean)
    /* CPU 上 14b 比 7b 慢一倍、质量提升有限 —— 优先 7b，其次其他大模型 */
    const big =
      installed.find((id) => /qwen2\.5:7b/i.test(id)) ||
      installed.find((id) => /7b|8b|9b|1[0-9]b|3[2-9]b|70b/i.test(id))
    if (big) return big
  } catch (_) {
    /* 探测失败就走兜底 */
  }
  try {
    const preferred = chaosLlm.preferredDefaultModel()
    if (preferred) return preferred
  } catch (_) {
    /* 探测失败就走兜底 */
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

/* ------------------------------------------------------------------ *
 * 9.8.2：紧凑行式大纲
 *
 * 为什么要换掉 JSON：这台机器是纯 CPU（i5-12400 / 无独显），实测
 * qwen2.5:7b 只有 2.6 tok/s、1.5b 有 9.1 tok/s。一份 6 页 JSON 大纲
 * 光键名（"title"/"kicker"/"kind"/"body"/"extra"/"stats"/"note"/"image"
 * 重复 6 次）就要吃掉三成 token，而 token 在这台机器上等于时间。
 *
 * 行式格式把结构开销压到接近零，且模型不需要维护括号配对 —— 小模型
 * 输出 JSON 最常见的失败（少个逗号、多个尾巴、缺右括号）直接消失。
 * 剩下的事（页型节奏、封面结尾、kicker、空字段兜底）全部由代码保证。
 * ------------------------------------------------------------------ */

const KIND_BY_CODE = {
  '01': 'cover',
  '1': 'cover',
  COVER: 'cover',
  B: 'bullets',
  S: 'stats',
  C: 'twocol',
  Q: 'quote',
  E: 'closing',
  // 10.0.1 新增
  P: 'section',
  SEC: 'section',
  SECTION: 'section',
  CH: 'chart',
  CHART: 'chart',
  TL: 'timeline',
  TIMELINE: 'timeline',
  PS: 'process',
  PROCESS: 'process',
  TB: 'compare',
  TABLE: 'compare',
  COMPARE: 'compare',
}

const COMPACT_SPEC = `格式（一行一条，不要 JSON，不要解释，不要代码块）：
T|整份标题|副标题
01|封面那句主张
P|第一章的章节名
- 这一章讲什么（一句，可省）
B|标题
- 要点
S|标题
数值|指标名
C|标题
- 左栏|- 右栏
TB|标题
左列名|右列名
- 左值|- 右值
CH|bar|标题
类目|数值
TL|标题
时点|发生了什么
PS|标题
- 一个步骤
N|这一页的演讲备注（放哪一页就写在那个页头下面）
Q|金句
E|标题
- 行动号召

代号：01 封面、P 章节过渡、B 要点、S 数据卡、C 双栏对比、TB 表格对比、CH 图表、TL 时间轴、PS 流程步骤、Q 金句、E 结尾。
CH 的第二个位置是图表类型，只能是 bar（柱）、line（折线）、pie（饼）、doughnut（环形）。`

const COMPACT_FEWSHOT = `示例（另一个主题的完整 8 页稿子，只示范写法，不要照抄内容）：
T|出杯 90 秒：一家咖啡连锁的效率重建|32 家门店的三个月实验
01|高峰期，每杯要等 4 分 12 秒
P|第一章 慢在哪里
- 先量清楚等待到底发生在哪一步
B|慢不在咖啡机，在动线
- 一名店员每小时往返取料 37 次，绕行 1.4 公里
- 62% 的等待发生在排队，而不是制作
- 峰值时段订单集中到 3 倍，人手却没变
CH|bar|等待时间被切成了四段
排队等待|168
等待点单|41
制作出杯|38
取餐等待|5
N|这段用秒做单位念，重点落在排队那 168 秒上，别念设备参数。
C|旧动线 vs 新动线
- 取料与制作挤在同一区|- 备料前置，制作区不放原料
- 三台设备塞进 2 米内|- 设备按订单流顺序摆放
- 高峰期靠加人|- 高峰期靠分单与预判
TL|三个月是怎么改的
第 1 周|画出 32 家店的店员走动图，标出最远的三个往返
第 4 周|把备料台移到前场，制作区清空原料
第 9 周|按订单流重排设备，出杯口挪到取餐台旁
PS|下一家门店照这四步做
- 站在店里数一小时的走动往返
- 把最费时的备料挪到视线内
- 按订单到达顺序重排设备
- 用两周数据验证，再决定是否推广
Q|顾客记住的不是咖啡豆，是等了多久
E|从一家门店的动线开始
- 本周画一张店员走动图，标出最远的三个往返`

/** 空话词表：要点里出现且整句偏短就判为注水 */
const FILLER_WORDS = [
  '意义重大',
  '至关重要',
  '众所周知',
  '不言而喻',
  '综上',
  '总的来说',
  '总而言之',
  '随着',
  '不断发展',
  '进一步提升',
  '深入探讨',
  '重要作用',
  '越来越',
  '新纪元',
  '新时代',
  '赋能',
  '抓手',
  '生态闭环',
]

const CHART_TYPES = new Set(['bar', 'line', 'pie', 'doughnut'])

/* 页头代号。多字符代号必须排在单字符前面，否则 P 会先吃掉 PS、S 会先吃掉 SEC */
const HEAD_RE = /^(0?[1-9]|SECTION|SEC|COVER|CHART|CH|TIMELINE|TL|PROCESS|PS|COMPARE|TABLE|TB|B|S|C|Q|E|P)\s*[|｜]\s*(.*)$/i

/**
 * 解析紧凑行式大纲 → 与 normalizeOutline 同构的 raw 结构。
 * 容错优先：认不出的行直接跳过，宁可少一条要点也不整份作废。
 *
 * 10.0.1 新增三种带结构化数据的页型：
 *   CH 图表   数据行「类目|数值」→ cur.chart
 *   TL 时间轴 数据行「时点|描述」→ cur.timeline
 *   TB 表格   第一行「左列名|右列名」当表头，之后每行左右各一格 → cur.head + body/extra
 * 这些数据不能留在 body 里：cleanPointList 会把超过 30 字的要点截断加省略号，
 * 「第 1 周|画出 32 家店的店员走动图」这种时间轴条目会被砍成半句。
 */
function parseCompactOutline(text, { topic, n, pad = true } = {}) {
  const lines = String(text || '')
    .replace(/```[a-z]*/gi, '')
    /* 小模型爱写 markdown 加粗：「**20% 门店销售提升案例**」——
     * 星号不剥掉就会原样渲染上页面，还顺手破坏同名/重复检测 */
    .replace(/\*{2,}/g, '')
    .replace(/^#{1,4}\s+/gm, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)

  let title = topic
  let subtitle = ''
  const slides = []
  let cur = null
  let seenDeck = false

  const newSlide = (kind, headTitle) => ({
    kind,
    title: headTitle,
    body: [],
    extra: [],
    stats: [],
    note: '',
    image: '',
    chart: kind === 'chart' ? { type: 'bar', labels: [], values: [] } : null,
    timeline: kind === 'timeline' ? [] : null,
    head: kind === 'compare' ? [] : null,
  })

  const pushSlide = () => {
    if (!cur) return
    // 金句页最常见的写法是「Q|金句本身」，没有独立内容行 —— 把页头让给金句
    if (cur.kind === 'quote' && !cur.body.length && cur.title) {
      cur.body = [cur.title.slice(0, 60)]
      cur.title = ''
    }
    /* 图表页/时间轴页数据不足就降级成要点页 —— 渲染时没有数据的图表框比
     * 一张普通文字页更难看，宁可退回去也别画空图 */
    if (cur.kind === 'chart' && (!cur.chart?.values || cur.chart.values.length < 2)) {
      cur.kind = 'bullets'
      if (!cur.body.length && cur.chart?.labels?.length) {
        cur.body = cur.chart.labels.map((l, k) => `${l} ${cur.chart.values[k] ?? ''}`.trim()).slice(0, 5)
      }
      cur.chart = null
    }
    if (cur.kind === 'timeline' && (!cur.timeline || cur.timeline.length < 2)) {
      cur.kind = 'bullets'
      if (!cur.body.length && cur.timeline?.length) {
        cur.body = cur.timeline.map((x) => `${x.t} ${x.d}`.trim()).slice(0, 5)
      }
      cur.timeline = null
    }
    if (cur.kind === 'compare' && (cur.body.length < 2 || cur.extra.length < 2)) {
      cur.kind = 'bullets'
      cur.head = null
    }
    slides.push(cur)
  }

  for (const raw of lines) {
    // T|标题|副标题
    const t = raw.match(/^T\s*[|｜]\s*(.+?)(?:\s*[|｜]\s*(.*))?$/i)
    if (t) {
      // 小模型写够了不知道停，会把整份稿子重复好几遍（实测 1.5B 重复 4 次）。
      // 见到第二份 T 行就收工，绝不把重复内容渲染进 PPT。
      if (seenDeck) break
      seenDeck = true
      title = (t[1] || topic).trim()
      subtitle = (t[2] || '').trim()
      continue
    }

    // N|演讲备注 —— 挂在当前这一页上，必须放在页头判定之前
    const noteLine = raw.match(/^N\s*[|｜]\s*(.*)$/i)
    if (noteLine) {
      if (cur) cur.note = String(noteLine[1] || '').trim().slice(0, 400)
      continue
    }

    // 页头：01|标题 / B|标题 / CH|bar|标题 …
    const head = raw.match(HEAD_RE)
    if (head) {
      const code = head[1].toUpperCase()
      // 纯数字页头：01 是封面，其余当内容页（模型有时整份都用数字编号）
      const kind = KIND_BY_CODE[code] || (/^[1-9]$/.test(code.replace(/^0/, '')) ? 'bullets' : '')
      if (kind) {
        if (slides.length >= n) break // 页数已够，后面的重复内容一律不要
        pushSlide()
        let rest = String(head[2] || '')
        let chartType = ''
        /* CH|bar|标题：第二个位置是图表类型 */
        if (kind === 'chart') {
          const seg = rest.split(/[|｜]/)
          const maybe = String(seg[0] || '').trim().toLowerCase()
          if (CHART_TYPES.has(maybe)) {
            chartType = maybe
            rest = seg.slice(1).join('|')
          }
        }
        // 模型偶尔写成「S|标题 数值|指标名」，标题只取竖线前那段
        const headTitle = rest.split(/[|｜]/)[0].trim().slice(0, 60)
        cur = newSlide(kind, headTitle)
        if (cur.chart) cur.chart.type = chartType || 'bar'
        continue
      }
    }

    if (!cur) continue // 页头之前的内容丢掉（多半是模型的寒暄）

    // 只剥离「- 」这种带空格的列表符号。直接写 /^[-·•*]\s*/ 会把数据页的
    // -46%（负数百分比）吃成 46%，那是把结论改反了。
    const body = /^[-·•*]\s+/.test(raw) ? raw.replace(/^[-·•*]\s+/, '').trim() : raw

    /* ---- 图表数据行：类目|数值 ---- */
    if (cur.kind === 'chart') {
      const m = body.match(/^(.+?)\s*[|｜]\s*(-?[\d.]+)\s*%?$/)
      if (m) {
        if (cur.chart.labels.length < 8) {
          cur.chart.labels.push(m[1].trim().slice(0, 14))
          const v = Number(m[2])
          cur.chart.values.push(Number.isFinite(v) ? v : 0)
        }
      } else if (!cur.body.length && body && !/\|/.test(body)) {
        // 没有数值的那一行当结论文字
        cur.body.push(body.slice(0, 40))
      }
      continue
    }

    /* ---- 时间轴数据行：时点|描述 ---- */
    if (cur.kind === 'timeline') {
      const m = body.match(/^(.+?)\s*[|｜]\s*(.+)$/)
      if (m) {
        if (cur.timeline.length < 6) {
          cur.timeline.push({ t: m[1].trim().slice(0, 16), d: m[2].trim().slice(0, 40) })
        }
      } else if (body && cur.timeline.length < 6) {
        cur.timeline.push({ t: '', d: body.slice(0, 40) })
      }
      continue
    }

    /* ---- 表格：第一行左右列名当表头，之后每行左右各一格 ---- */
    if (cur.kind === 'compare') {
      const m = body.match(/^(.+?)\s*[|｜]\s*(.+)$/)
      if (m) {
        const l = m[1].replace(/^[-·•*]\s+/, '').trim()
        const r = m[2].trim()
        if (!cur.head.length && !cur.body.length) {
          cur.head = [l.slice(0, 16), r.slice(0, 16)]
        } else if (cur.body.length < 5) {
          cur.body.push(l.slice(0, 26))
          cur.extra.push(r.slice(0, 26))
        }
      }
      continue
    }

    if (cur.kind === 'stats') {
      // 82%|效率提升
      const m = body.match(/^(.+?)\s*[|｜]\s*(.+)$/)
      if (m && cur.stats.length < 3) {
        cur.stats.push({ v: m[1].trim().slice(0, 12), l: m[2].trim().slice(0, 24) })
      } else if (!cur.body.length && body) {
        cur.body.push(body.slice(0, 40))
      }
      continue
    }

    if (cur.kind === 'twocol') {
      // - 左栏观点|- 右栏观点
      const m = body.match(/^(.+?)\s*[|｜]\s*(.+)$/)
      if (m) {
        if (cur.body.length < 4) cur.body.push(m[1].replace(/^[-·•*]\s+/, '').trim())
        if (cur.extra.length < 4) cur.extra.push(m[2].replace(/^[-·•*]\s+/, '').trim())
      }
      continue
    }

    if (cur.kind === 'quote') {
      if (!cur.body.length && body) cur.body.push(body.slice(0, 60))
      continue
    }

    // section 只留一句导语；process 最多五步；其余按要点收
    const cap = cur.kind === 'section' ? 1 : cur.kind === 'process' ? 5 : 5
    if (/^\s*[-·•*]/.test(raw) || cur.kind !== 'cover') {
      if (cur.body.length < cap && body) cur.body.push(body.slice(0, 40))
    }
  }
  pushSlide()

  // 一页都没认出来 → 返回 null，让上层走 JSON 兜底
  if (!slides.length) return null

  // 页数不够就按需要补空白要点页（末尾的结尾页要留在最后）。
  // pad:false 用于「续写补页」——补齐交给模型继续写，而不是先塞占位页。
  let guard = 0
  while (pad && slides.length < n && guard++ < 20) {
    const last = slides[slides.length - 1]
    const blank = { kind: 'bullets', title: '补充要点', body: [], extra: [], stats: [], note: '', image: '' }
    if (last && last.kind === 'closing') slides.splice(slides.length - 1, 0, blank)
    else slides.push(blank)
  }

  return { title, subtitle, slides: slides.slice(0, n) }
}

/** 一句话判断：这行要点是不是注水（空话 + 太短） */
function isFiller(line) {
  const s = String(line || '').trim()
  if (!s) return true
  // 只有 3 字以内才是真的没内容（「很重要」「待补充」）。之前门槛设成 8 字，
  // 把「传统方式效率低」这种正常短要点也当注水删了，结果双栏页左栏全空。
  if (s.length < 4) return true
  const hit = FILLER_WORDS.filter((w) => s.includes(w))
  if (!hit.length) return false
  // 带数字或英文的长句说明有实指，短句还塞空话就是注水
  const hasConcrete = /\d|[A-Za-z]{3,}/.test(s)
  return !hasConcrete && s.length < 20
}

/**
 * 大纲质量后处理：过滤注水、去重、修剪超长要点。
 *
 * 模型爱写「随着数字化转型不断深入」这种句子，渲染出来就是典型的水词 PPT，
 * 这里直接砍掉。但砍要有底线：双栏页左右各少一条就成半边空栏，比留一句
 * 平庸的话更难看，所以清空或不足两条时回退原样。
 */
function cleanPointList(list, { min = 0 } = {}) {
  const before = list.map((x) => String(x || '').trim()).filter(Boolean)
  const seen = new Set()
  const after = before
    .filter((x) => !isFiller(x))
    .filter((x) => {
      const key = x.replace(/\s/g, '').slice(0, 8)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .map((x) => (x.length > 30 ? x.slice(0, 29) + '…' : x))
  if (after.length >= min) return after
  // 删过头了：宁可保留原句，也不要留下空白栏
  return before.map((x) => (x.length > 30 ? x.slice(0, 29) + '…' : x))
}

/** 副标题也常被模型写成格式词本身（「副标题：副标题」），这种直接丢掉 */
function cleanSubtitle(raw) {
  let t = String(raw || '').trim()
  if (!t) return ''
  if (/^(副标题|主标题|标题|副题|subtitle)$/i.test(t)) return ''
  /* 「3个月沉淀20万企微会员_用户_品牌_流量」——关键词串的下划线尾巴
   * 是模型从检索关键词里抄来的，去掉才像人写的副标题 */
  t = t.replace(/[_｜|]\s*\S{2,4}(_\S{2,4}){1,6}\s*$/, '').trim()
  return t.slice(0, 120)
}

function polishOutline(outline) {
  if (!outline || !Array.isArray(outline.slides)) return outline
  for (const s of outline.slides) {
    const need = s.kind === 'twocol' ? 2 : 0
    if (Array.isArray(s.body)) s.body = dedupePoints(cleanPointList(s.body, { min: need }))
    if (Array.isArray(s.extra)) s.extra = dedupePoints(cleanPointList(s.extra, { min: need }))
  }
  return outline
}

/** 同一页里的近似重复（前 14 个字一样就算重复）：模型爱换个说法再写一遍 */
function dedupePoints(list) {
  const seen = new Set()
  const out = []
  for (const x of list || []) {
    const k = String(x).replace(/\s+/g, '').slice(0, 14)
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

/** 页型对应的兜底标题 —— 模型把「数值」写在页头时用它顶上 */
const KIND_FALLBACK_TITLE = {
  cover: '',
  bullets: '核心要点',
  stats: '关键指标',
  twocol: '两种做法对比',
  quote: '',
  closing: '下一步',
}

/** 模型会把格式词直接当标题用，也会把一整句行动号召塞进页头 */
const TITLE_PREFIX_RE = /^(标题|要点|结论|行动号召|行动|金句|封面|数值|指标名|数据|对比)\s*[:：]\s*/

function cleanTitle(raw, kind, topic) {
  let t = String(raw || '').trim()
  if (!t) return ''
  t = t.replace(TITLE_PREFIX_RE, '').trim()
  // 模型会把代号也带进页头（「封面主张 / S」「标题 | B」），把尾巴削掉
  t = t.replace(/\s*[|｜/]\s*(0?[1-9]|COVER|B|S|C|Q|E)\s*$/i, '').trim()
  // 页头只剩格式词（「数值」「指标名」）时换成该页型的通用标题
  if (/^(数值|指标名|指标|数据|标题|要点|金句|对比|行动号召)$/.test(t)) {
    return KIND_FALLBACK_TITLE[kind] || ''
  }
  // 「封面主张」「要点页标题」这类描述词也不是标题
  if (/^(封面那句主张|封面主张|主标题|副标题|内容页|要点页|数据页|对比页|金句页|结尾页)(标题)?$/.test(t)) {
    return KIND_FALLBACK_TITLE[kind] || ''
  }
  // 页头就是个裸数字（「-25%」「34%」）—— 那是数据行串到标题位了，
  // 拿它当页标题会让人以为这页讲的是这个数字
  if (/^[-+±]?\d+(\.\d+)?\s*(%|％|倍|万|亿|元|天|小时|分钟|秒)?$/.test(t)) {
    return KIND_FALLBACK_TITLE[kind] || ''
  }
  if (!t) return ''
  // 中文按 24 字、英文按 70 字符收口，否则渲染时字号被压到看不清
  const cap = /[\u4e00-\u9fa5]/.test(t) ? 24 : 70
  return t.length > cap ? t.slice(0, cap - 1) + '…' : t
}

/**
 * 把模型给的粗糙 slides 整理成稳定结构。
 * 9.8.0 新增：kind（页型）/ extra（双栏第二栏）/ stats（数据卡）/ note（备注）/ image（配图提示词）
 */

/** 图表数据：只留数字型数值，最多 8 组，标签去空 */
function normalizeChart(raw) {
  const type = CHART_TYPES.has(String(raw?.type || '').toLowerCase()) ? String(raw.type).toLowerCase() : 'bar'
  const labels = (Array.isArray(raw?.labels) ? raw.labels : []).map((x) => String(x || '').trim().slice(0, 14)).filter(Boolean)
  const values = (Array.isArray(raw?.values) ? raw.values : [])
    .map((x) => Number(String(x).replace(/[^0-9.\-]/g, '')))
    .map((x) => (Number.isFinite(x) ? x : 0))
  const k = Math.min(labels.length, values.length, 8)
  return { type, labels: labels.slice(0, k), values: values.slice(0, k) }
}

/** 时间轴：{t,d} 数组，最多 6 个节点 */
function normalizeTimeline(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((x) => ({
      t: String(x?.t ?? x?.time ?? '').trim().slice(0, 16),
      d: String(x?.d ?? x?.desc ?? '').trim().slice(0, 40),
    }))
    .filter((x) => x.t || x.d)
    .slice(0, 6)
}

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
    if (finalKind === 'stats' && stats.length < 2) {
      // 只憋出一个指标时，把它写成一句话留给要点页，别让用户看到「内容待补充」
      if (stats.length === 1 && !body.length) body.push(`${stats[0].v} ${stats[0].l}`.trim())
      finalKind = 'bullets'
    }
    if (finalKind === 'twocol' && (extra.length < 2 || body.length < 2)) {
      finalKind = 'bullets'
    } else if (finalKind === 'twocol') {
      // 左右条数不一致会渲染成一高一低的半边空栏，按少的一边对齐
      const k = Math.min(body.length, extra.length, 4)
      body.length = k
      extra.length = k
    }

    /* 10.0.1：结构化页型的降级 —— 没有可用数据就不画空图表 / 空时间轴 */
    const chart = normalizeChart(s?.chart)
    const timeline = normalizeTimeline(s?.timeline)
    const head = (Array.isArray(s?.head) ? s.head : []).slice(0, 2).map((x) => String(x || '').slice(0, 16))
    if (finalKind === 'chart' && chart.values.length < 2) {
      finalKind = 'bullets'
      if (!body.length && chart.labels.length) {
        body.push(...chart.labels.map((l, k) => `${l} ${chart.values[k] ?? ''}`.trim()).slice(0, 5))
      }
    }
    if (finalKind === 'timeline' && timeline.length < 2) {
      finalKind = 'bullets'
      if (!body.length && timeline.length) {
        body.push(...timeline.map((x) => `${x.t} ${x.d}`.trim()).slice(0, 5))
      }
    }
    if (finalKind === 'compare' && (body.length < 2 || extra.length < 2)) finalKind = 'bullets'
    if (finalKind === 'quote' && !body.length) {
      // 金句写在页头也是有效的：标题让位给金句，避免同句重复两遍
      const head2 = String(s?.title || '').trim()
      if (head2) body.push(head2.slice(0, 60))
      else finalKind = 'bullets'
    }

    const isQuote = finalKind === 'quote'
    const isSection = finalKind === 'section'
    /* section 只有一句导语，不该被塞「内容待补充」占位 */
    const keepEmptyBody = isFirst || finalKind === 'closing' || finalKind === 'stats' || isSection || finalKind === 'chart'
    // 标题清洗：模型常把格式词当标题（「数值」「行动号召：」），也会一句话写太长
    const rawTitle = cleanTitle(s?.title, finalKind, isFirst ? topic : '')
    return {
      title: rawTitle || (isFirst ? String(topic).slice(0, 24) : isQuote || isSection ? '' : `第 ${i + 1} 页`),
      kicker: String(s?.kicker || '').slice(0, 8),
      kind: finalKind,
      body: body.length ? body : keepEmptyBody ? [] : ['（本页内容待补充）'],
      extra,
      stats,
      chart: finalKind === 'chart' ? chart : null,
      timeline: finalKind === 'timeline' ? timeline : null,
      head: finalKind === 'compare' ? head : null,
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
    chart: null,
    timeline: null,
    head: null,
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
    subtitle: cleanSubtitle(raw?.subtitle),
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
        chart: normalizeChart(s?.chart),
        timeline: normalizeTimeline(s?.timeline),
        head: (Array.isArray(s?.head) ? s.head : []).slice(0, 2).map((x) => String(x || '').slice(0, 16)),
        note: String(s?.note || '').slice(0, 400),
        image: String(s?.image || '').slice(0, 300),
        // 重渲染优先复用已经出好的图，缓存命中就不再下载
        imageName: String(s?.imageName || '').slice(0, 60),
      }
    })
    /* quote / section 允许没有标题（金句和章节导语本身就是内容），
     * 只把「标题和正文都空」的页剔掉 */
    .filter((s) => s.title || s.body.length || (s.chart && s.chart.values.length))
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
 * 从主题色推一条同色系色阶，供饼图/折线多系列着色。
 * pptxgenjs 的 chartColors 只吃不带 # 的 6 位十六进制，这里统一产出该格式。
 */
function chartPalette(hex, n = 5) {
  const h = String(hex || '2563EB')
    .replace('#', '')
    .padEnd(6, '0')
    .slice(0, 6)
  const base = [parseInt(h.slice(0, 2), 16) || 0, parseInt(h.slice(2, 4), 16) || 0, parseInt(h.slice(4, 6), 16) || 0]
  const out = []
  for (let i = 0; i < Math.max(3, n); i++) {
    // i=0 原色；之后交替往亮/暗两头拉开，保证相邻扇区色差足够
    const t = i === 0 ? 0 : (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 0.26
    const mix = (v) => Math.max(0, Math.min(255, Math.round(t >= 0 ? v + (255 - v) * t : v * (1 + t))))
    out.push(
      [mix(base[0]), mix(base[1]), mix(base[2])]
        .map((x) => x.toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
    )
  }
  return out
}

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

    /* 10.0.0：几何装饰 —— WPS 级封面的底子。右侧一组半透明同心圆 + 顶部细线，
     * 没有配图时封面不再是一块纯色板；有图时压在图上也有层次 */
    if (!split) {
      s.addShape('ellipse', {
        x: PAGE_W - 3.4,
        y: -1.6,
        w: 5.2,
        h: 5.2,
        fill: { color: T.accent, transparency: 88 },
        line: { color: T.accent, width: 0.5, transparency: 70 },
      })
      s.addShape('ellipse', {
        x: PAGE_W - 2.1,
        y: 4.9,
        w: 3.1,
        h: 3.1,
        fill: { color: T.accent, transparency: 82 },
        line: { color: T.accent, width: 0.5, transparency: 60 },
      })
      s.addShape('ellipse', {
        x: PAGE_W - 1.35,
        y: 0.85,
        w: 1.5,
        h: 1.5,
        fill: { color: T.accent, transparency: 62 },
      })
    }
    /* 顶边强调线：细一条，压住整个版面 */
    s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.07, fill: { color: T.accent } })

    /* 封面眉标：小字注明演示文稿性质，WPS 模板的标配 */
    s.addText(lang === 'en' ? 'PRESENTATION' : '演 示 文 稿', {
      x: 1.22,
      y: 1.52,
      w: 3.5,
      h: 0.32,
      fontSize: 11,
      bold: true,
      color: T.accent,
      charSpacing: 3,
      fontFace: F,
    })

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
    /* 底部信息行：日期 + 主题色小方块，收口 */
    s.addShape('rect', { x: 1.24, y: 6.47, w: 0.26, h: 0.075, fill: { color: T.accent } })
    s.addText(new Date().toLocaleDateString(lang === 'en' ? 'en-US' : 'zh-CN'), {
      x: 1.6,
      y: 6.28,
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
    /* 右上角同心圆装饰，和封面呼应 */
    toc.addShape('ellipse', {
      x: PAGE_W - 1.5,
      y: -0.9,
      w: 2.6,
      h: 2.6,
      fill: { color: T.accent, transparency: 88 },
      line: { color: T.accent, width: 0.5, transparency: 70 },
    })

    const items = slides
      .slice(1, -1)
      .map((s, i) => ({ no: String(i + 1).padStart(2, '0'), text: s.title }))
    /* 10.0.0：目录改成 WPS 式双栏数字卡 —— 单列排超过 6 条就开始密得难读；
     * 两栏 + 数字章，一眼能扫完 */
    if (items.length) {
      const twoCol = items.length > 4
      const colW = twoCol ? 5.55 : 11.2
      const perCol = twoCol ? Math.ceil(items.length / 2) : items.length
      const rowH = Math.min(0.86, (PAGE_H - 2.2 - 0.4) / Math.max(perCol, 1))
      items.forEach((it, k) => {
        const col = twoCol ? Math.floor(k / perCol) : 0
        const row = twoCol ? k % perCol : k
        const x = 0.9 + col * (colW + 0.45)
        const y = 1.95 + row * rowH
        toc.addShape('rect', {
          x,
          y,
          w: 0.52,
          h: 0.52,
          fill: { color: T.accent },
          rectRadius: 0.08,
        })
        toc.addText(it.no, {
          x,
          y,
          w: 0.52,
          h: 0.52,
          fontSize: 15,
          bold: true,
          color: 'FFFFFF',
          align: 'center',
          valign: 'middle',
          fontFace: F,
        })
        toc.addText(it.text, {
          x: x + 0.72,
          y,
          w: colW - 0.8,
          h: 0.52,
          fontSize: 14,
          color: T.text,
          valign: 'middle',
          fontFace: F,
          fit: 'shrink',
        })
      })
    } else {
      toc.addText('—', { x: 1.0, y: 1.95, w: 11, h: 4.6, fontSize: 15, color: T.text, fontFace: F })
    }
  }

  /* ---------------- 内容页 ---------------- */
  let sectionCount = 0 // 章节序号：section 页按出现顺序编号
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
      /* 10.0.0：结尾页同款几何装饰 —— 与封面首尾呼应 */
      if (!pic) {
        s.addShape('ellipse', {
          x: -1.7,
          y: PAGE_H - 3.2,
          w: 5,
          h: 5,
          fill: { color: T.accent, transparency: 88 },
          line: { color: T.accent, width: 0.5, transparency: 70 },
        })
        s.addShape('ellipse', {
          x: PAGE_W - 1.9,
          y: -1.2,
          w: 3.4,
          h: 3.4,
          fill: { color: T.accent, transparency: 84 },
        })
      }
      s.addShape('rect', { x: 0, y: PAGE_H - 0.07, w: PAGE_W, h: 0.07, fill: { color: T.accent } })
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

    /* ---- 版式 5：章节过渡页（10.0.1）----
     * 深色整页 + 超大章序号。作用是把长稿子切成几段，让版面有呼吸；
     * WPS 模板里这一页几乎必现，缺了它整份稿子会显得平。 */
    if (sl.kind === 'section') {
      sectionCount += 1
      s.background = { color: T.coverBg }
      /* 背景：一个大号半透明序号压在右侧，不抢标题 */
      s.addText(String(sectionCount).padStart(2, '0'), {
        x: PAGE_W - 5.4,
        y: 0.9,
        w: 5,
        h: 5.2,
        fontSize: 260,
        bold: true,
        color: T.accent,
        transparency: 82,
        align: 'right',
        valign: 'middle',
        fontFace: F,
      })
      if (pic) {
        s.addImage({ path: pic, x: 0, y: 0, w: PAGE_W, h: PAGE_H })
        s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: PAGE_H, fill: { color: T.coverBg, transparency: 20 } })
      }
      s.addShape('rect', { x: 0, y: 0, w: PAGE_W, h: 0.07, fill: { color: T.accent } })
      /* 章节眉标 */
      s.addText(lang === 'en' ? `CHAPTER ${sectionCount}` : `第 ${sectionCount} 章`, {
        x: 1.25,
        y: 2.05,
        w: 4,
        h: 0.35,
        fontSize: 12,
        bold: true,
        color: T.accent,
        charSpacing: 3,
        fontFace: F,
      })
      s.addShape('rect', { x: 1.28, y: 2.55, w: 0.9, h: 0.055, fill: { color: T.accent } })
      s.addText(sl.title || '—', {
        x: 1.22,
        y: 2.75,
        w: PAGE_W - 3.2,
        h: 1.5,
        fontSize: 44,
        bold: true,
        color: T.coverTitle,
        valign: 'middle',
        fontFace: F,
        fit: 'shrink',
      })
      if (sl.body?.[0]) {
        s.addText(sl.body[0], {
          x: 1.25,
          y: 4.35,
          w: PAGE_W - 4.6,
          h: 0.85,
          fontSize: 15,
          color: T.coverSub,
          fontFace: F,
          fit: 'shrink',
        })
      }
      s.addText(`${pageNo} / ${total}`, {
        x: PAGE_W - 1.5,
        y: PAGE_H - 0.5,
        w: 0.9,
        h: 0.3,
        fontSize: 9.5,
        color: T.coverSub,
        align: 'right',
        fontFace: F,
      })
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

    /* 10.0.0：右上角几何角标 —— 两小一大的主题色圆点，呼应封面装饰，
     * 让内容页不再只是「白纸 + 黑字」 */
    s.addShape('ellipse', { x: PAGE_W - 0.82, y: 0.42, w: 0.3, h: 0.3, fill: { color: T.accent, transparency: 55 } })
    s.addShape('ellipse', { x: PAGE_W - 0.62, y: 0.78, w: 0.16, h: 0.16, fill: { color: T.accent, transparency: 30 } })

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

      /* 10.0.0：少要点 → WPS 式行卡。要点不超过 4 条且没配图时，
       * 每条要点一张浅色圆角卡 + 左侧主题色竖条，比光秃秃的圆点列表高级得多 */
      const rows = sl.body || []
      if (!twoCol && rows.length >= 2 && rows.length <= 4) {
        const gap = 0.22
        const rowH = Math.min(1.15, (bodyH - gap * (rows.length - 1)) / rows.length)
        rows.forEach((t, k) => {
          const y = bodyTop + k * (rowH + gap)
          s.addShape('rect', {
            x: 0.9,
            y,
            w: PAGE_W - 1.8,
            h: rowH,
            fill: { color: T.panel },
            line: { color: T.panel, width: 1 },
            rectRadius: 0.07,
          })
          s.addShape('rect', { x: 0.9, y: y + 0.14, w: 0.07, h: rowH - 0.28, fill: { color: T.accent } })
          s.addText(t, {
            x: 1.24,
            y,
            w: PAGE_W - 2.5,
            h: rowH,
            fontSize: rows.length <= 3 ? 16.5 : 15,
            color: T.text,
            valign: 'middle',
            fontFace: F,
            fit: 'shrink',
          })
        })
      } else {
        const items = (rows.length ? rows : ['（本页暂无内容）']).map((t) => ({
          text: t,
          options: {
            bullet: { code: '25CF' },
            breakLine: true,
            paraSpaceAfter: 10,
            fontSize: rows.length <= 3 ? 18 : rows.length === 4 ? 16.5 : 15,
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
      }
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
        /* 10.0.0：卡片顶部主题色条 —— 数据卡的视觉锚点 */
        s.addShape('rect', { x: x + 0.32, y: bodyTop + 0.15, w: cardW - 0.64, h: 0.06, fill: { color: T.accent } })
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
      /* 10.0.0：巨型引号压底 —— 金句页的辨识度全靠它 */
      s.addText('“', {
        x: 0.72,
        y: bodyTop - 0.35,
        w: 2.2,
        h: 2.2,
        fontSize: 130,
        bold: true,
        color: T.accent,
        transparency: 78,
        fontFace: F,
      })
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

    /* ---- 版式 6：真图表（10.0.1）----
     * 旧版的数据页只会把数字排成卡片，商务汇报一眼就假。这里走 pptxgenjs 的
     * 原生 addChart，导出的 pptx 里图表是**可编辑图表对象**，不是一张图片。 */
    if (sl.kind === 'chart' && sl.chart && sl.chart.values.length >= 2) {
      const C = sl.chart
      const hasText = (sl.body || []).length > 0
      const chartW = hasText ? 7.7 : PAGE_W - 2.0
      const cx = hasText ? 0.8 : (PAGE_W - chartW) / 2
      const chartH = Math.min(bodyH - 0.25, 4.7)
      const typeMap = {
        bar: pptx.ChartType.bar,
        line: pptx.ChartType.line,
        pie: pptx.ChartType.pie,
        doughnut: pptx.ChartType.doughnut,
      }
      const isPie = C.type === 'pie' || C.type === 'doughnut'
      try {
        s.addChart(
          typeMap[C.type] || pptx.ChartType.bar,
          [{ name: (sl.title || '数据').slice(0, 30), labels: C.labels, values: C.values }],
          {
            x: cx,
            y: bodyTop,
            w: chartW,
            h: chartH,
            chartColors: chartPalette(T.accent, Math.max(C.values.length, 3)),
            showLegend: isPie,
            legendPos: 'b',
            legendFontFace: F,
            legendFontSize: 10,
            legendColor: T.text,
            showValue: true,
            dataLabelColor: T.text,
            dataLabelFontFace: F,
            dataLabelFontSize: 10,
            dataLabelPosition: isPie ? 'bestFit' : 'outEnd',
            catAxisLabelColor: T.text,
            catAxisLabelFontFace: F,
            catAxisLabelFontSize: 10.5,
            valAxisHidden: true,
            valGridLine: { style: 'none' },
            catGridLine: { style: 'none' },
            border: { pt: 0, color: 'FFFFFF' },
            barGapWidthPct: 55,
            lineSize: 2.5,
            lineDataSymbolSize: 7,
          },
        )
      } catch (_) {
        /* 图表数据异常时退回把数字排成一行，不能让整页渲染失败 */
        s.addText(
          C.labels.map((l, k) => `${l} ${C.values[k]}`).join('   ·   '),
          { x: cx, y: bodyTop + 1.6, w: chartW, h: 0.8, fontSize: 14, color: T.text, fontFace: F, align: 'center', fit: 'shrink' },
        )
      }
      /* 右栏：这一页要说明的结论 */
      if (hasText) {
        const tx = cx + chartW + 0.45
        const tw = PAGE_W - tx - 0.8
        s.addShape('rect', { x: tx, y: bodyTop + 0.2, w: 0.07, h: 0.42, fill: { color: T.accent } })
        s.addText(lang === 'en' ? 'Takeaway' : '看懂这张图', {
          x: tx + 0.2,
          y: bodyTop + 0.2,
          w: tw - 0.2,
          h: 0.42,
          fontSize: 11,
          bold: true,
          color: T.accent,
          valign: 'middle',
          fontFace: F,
        })
        s.addText(
          sl.body.slice(0, 4).map((t) => ({
            text: t,
            options: { bullet: { code: '25AA' }, breakLine: true, paraSpaceAfter: 10, fontSize: 13.5, color: T.text, fontFace: F },
          })),
          { x: tx, y: bodyTop + 0.85, w: tw, h: chartH - 1.0, lineSpacingMultiple: 1.3, valign: 'top', fit: 'shrink' },
        )
      }
    }

    /* ---- 版式 7：时间轴（10.0.1）---- */
    if (sl.kind === 'timeline' && Array.isArray(sl.timeline) && sl.timeline.length >= 2) {
      const nodes = sl.timeline.slice(0, 6)
      const n = nodes.length
      const left = 1.0
      const usable = PAGE_W - left * 2
      const step = usable / Math.max(n - 1, 1)
      const axisY = bodyTop + 2.05
      /* 主轴 */
      s.addShape('line', { x: left, y: axisY, w: usable, h: 0, line: { color: 'CBD5E1', width: 1.75 } })
      nodes.forEach((nd, k) => {
        const cx0 = left + step * k
        const up = k % 2 === 0
        const dotR = 0.19
        /* 节点圆点：外圈浅色 + 内圈主题色 */
        s.addShape('ellipse', {
          x: cx0 - dotR - 0.055,
          y: axisY - dotR - 0.055,
          w: (dotR + 0.055) * 2,
          h: (dotR + 0.055) * 2,
          fill: { color: T.accent, transparency: 78 },
        })
        s.addShape('ellipse', {
          x: cx0 - dotR,
          y: axisY - dotR,
          w: dotR * 2,
          h: dotR * 2,
          fill: { color: T.accent },
        })
        /* 连接竖线 */
        const linkH = 0.62
        s.addShape('line', {
          x: cx0,
          y: up ? axisY - dotR - linkH : axisY + dotR,
          w: 0,
          h: linkH,
          line: { color: T.accent, width: 1, transparency: 45 },
        })
        const boxW = Math.min(step - 0.22, 3.2)
        const boxX = Math.max(0.45, Math.min(PAGE_W - boxW - 0.45, cx0 - boxW / 2))
        const labelY = up ? axisY - dotR - linkH - 0.42 : axisY + dotR + linkH
        if (nd.t) {
          s.addText(nd.t, {
            x: boxX,
            y: labelY,
            w: boxW,
            h: 0.36,
            fontSize: 13,
            bold: true,
            color: T.accent,
            align: 'center',
            fontFace: F,
            fit: 'shrink',
          })
        }
        s.addText(nd.d, {
          x: boxX,
          y: labelY + 0.38,
          w: boxW,
          h: 0.85,
          fontSize: 11,
          color: T.text,
          align: 'center',
          lineSpacingMultiple: 1.2,
          valign: up ? 'bottom' : 'top',
          fontFace: F,
          fit: 'shrink',
        })
      })
    }

    /* ---- 版式 8：流程步骤（10.0.1）---- */
    if (sl.kind === 'process' && (sl.body || []).length >= 2) {
      const steps = sl.body.slice(0, 5)
      const n = steps.length
      const gap = 0.28
      const cardW = (PAGE_W - 1.7 - gap * (n - 1)) / n
      const cardH = Math.min(bodyH - 0.4, 3.5)
      const y0 = bodyTop + 0.35
      steps.forEach((t, k) => {
        const x = 0.85 + k * (cardW + gap)
        s.addShape('rect', {
          x,
          y: y0,
          w: cardW,
          h: cardH,
          fill: { color: T.panel },
          line: { color: T.panel, width: 1 },
          rectRadius: 0.08,
        })
        /* 顶部主题色进度条：最后一步满格，前面按比例 —— 一眼看出是流程而非并列 */
        s.addShape('rect', { x, y: y0, w: cardW, h: 0.075, fill: { color: T.accent, transparency: k === n - 1 ? 0 : 55 } })
        s.addShape('ellipse', { x: x + 0.28, y: y0 + 0.32, w: 0.52, h: 0.52, fill: { color: T.accent } })
        s.addText(String(k + 1), {
          x: x + 0.28,
          y: y0 + 0.32,
          w: 0.52,
          h: 0.52,
          fontSize: 15,
          bold: true,
          color: 'FFFFFF',
          align: 'center',
          valign: 'middle',
          fontFace: F,
        })
        s.addText(t, {
          x: x + 0.22,
          y: y0 + 1.02,
          w: cardW - 0.44,
          h: cardH - 1.2,
          fontSize: 12.5,
          color: T.text,
          lineSpacingMultiple: 1.25,
          valign: 'top',
          fontFace: F,
          fit: 'shrink',
        })
        /* 步骤之间的箭头 */
        if (k < n - 1) {
          s.addShape('chevron', {
            x: x + cardW + 0.04,
            y: y0 + 0.36,
            w: 0.2,
            h: 0.3,
            fill: { color: T.accent, transparency: 35 },
          })
        }
      })
    }

    /* ---- 版式 9：表格对比（10.0.1）----
     * 对比表用原生 addTable，文字可编辑、行高自动，比两张卡片更像汇报材料。 */
    if (sl.kind === 'compare' && (sl.body || []).length >= 2 && (sl.extra || []).length >= 2) {
      const n = Math.min(sl.body.length, sl.extra.length, 5)
      const head = Array.isArray(sl.head) && sl.head.length === 2 ? sl.head : [lang === 'en' ? 'Before' : '现在', lang === 'en' ? 'After' : '之后']
      const rows = [
        head.map((h, k) => ({
          text: h || (k ? '—' : '—'),
          options: { bold: true, color: 'FFFFFF', fill: { color: T.accent }, align: 'left', valign: 'middle', fontSize: 13.5, fontFace: F },
        })),
      ]
      for (let k = 0; k < n; k++) {
        const bg = k % 2 === 0 ? 'FFFFFF' : T.panel
        rows.push([
          {
            text: sl.body[k],
            options: { color: T.text, fill: { color: bg }, align: 'left', valign: 'middle', fontSize: 12.5, fontFace: F },
          },
          {
            text: sl.extra[k],
            options: { color: T.title, fill: { color: bg }, align: 'left', valign: 'middle', fontSize: 12.5, fontFace: F },
          },
        ])
      }
      const tableW = PAGE_W - 1.7
      const rowH = Math.min(0.92, (bodyH - 0.3) / (n + 1))
      s.addTable(rows, {
        x: 0.85,
        y: bodyTop + 0.1,
        w: tableW,
        colW: [tableW / 2, tableW / 2],
        rowH,
        border: { type: 'solid', pt: 0.75, color: 'E2E8F0' },
        valign: 'middle',
        margin: 0.12,
        autoPage: false,
      })
    }

    /* 10.0.0：页脚 —— 细分隔线 + 左侧稿题 + 右侧页码，WPS 模板的收尾标配 */
    s.addShape('rect', { x: 0.75, y: PAGE_H - 0.5, w: PAGE_W - 1.5, h: 0.012, fill: { color: 'CBD5E1' } })
    s.addText(outline.title || '', {
      x: 0.75,
      y: PAGE_H - 0.45,
      w: 5.5,
      h: 0.3,
      fontSize: 8.5,
      color: '94A3B8',
      fontFace: F,
      fit: 'shrink',
    })
    s.addText(`${pageNo} / ${total}`, {
      x: PAGE_W - 1.5,
      y: PAGE_H - 0.45,
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

/**
 * 阶段一：联网找资料。
 *
 * 9.8.2 的做法是让本地模型「先列 6-8 条硬信息」当素材，再写正文。
 * 问题在于：7B 没有行业数据，它列出来的「降低库存积压 50%」是编的 ——
 * 比空话更糟，因为用户一眼能看出假。
 *
 * 现在改成真的上网查：360 搜索 + 正文抓取，拿到
 *   ① 行业真实在讨论的话题（搜索结果标题）
 *   ② 带数字的真实句子
 * 模型的任务从「创作」退回到「挑选和改写」，这才是 7B 做得好的事。
 *
 * 查不到才退回让模型自己列 —— 有素材总比没有强，但要在 UI 上说清楚。
 */
function fallbackPlanPrompt({ topic, n, toneDesc, audience }) {
  return (
    `主题：《${topic}》，要做一份 ${n} 页的演示，语气${toneDesc}。` +
    (audience ? `听众：${audience}。` : '') +
    `\n先不要设计页面结构。请列出 6-8 条能直接放到页面上的具体信息，一行一条，每条 20-30 字：\n` +
    `优先给数字、案例、前后对比、具体做法。\n` +
    `不要写「重要性」「意义」「趋势」「前景」这类判断，也不要写「首先/其次」。直接列。`
  )
}

/**
 * 阶段二：逐页大纲（紧凑行式）。
 *
 * 9.8.3 的核心改动是「页头必须是判断句」。
 *
 * 之前模型写的页头是名词短语：「精准采购策略的三大优势」「传统方法 vs 数据驱动方案」，
 * 正文就只能是三个「提升了 X%」的并列句 —— 这是 PPT 读起来像说明书的根源。
 * 千问那种能看的效果来自：页头先给一个明确判断，要点再去支撑这个判断。
 *
 * 所以规则里把「页头 = 名词」改掉，直接给句式模板（抽象模板不会像
 * few-shot 那样被小模型原文照抄）。
 */
function outlinePrompt({ topic, n, toneDesc, audience, lang, plan, hasResearch }) {
  /* 页型节奏按总页数缩放：短稿子塞章节页会把内容挤没，长稿子不给章节页又太平 */
  const rich = n >= 8
  if (lang === 'en') {
    return (
      `Source material (pick, rewrite, never copy verbatim):\n${plan}\n\n` +
      `Write a ${n}-slide deck on "${topic}" (tone: ${toneDesc}).` +
      (audience ? ` Audience: ${audience}.` : '') +
      `\n\nOne line per item, no JSON, no commentary, no code fences:\n\n` +
      `T|deck title|subtitle\n` +
      `01|cover headline\n` +
      (rich ? `P|chapter name\n` : '') +
      `B|slide title\n` +
      `- a point, 8-16 words, concrete\n` +
      `S|metric slide title\n82%|efficiency gain\n` +
      `C|comparison slide title\n- left|- right\n` +
      `CH|bar|chart slide title\nlabel|number\nlabel|number\n` +
      `TL|timeline slide title\nWeek 1|what happened\n` +
      `Q|one-line judgment\n` +
      `E|closing title\n- one action\n` +
      `N|speaker note for the slide above\n\n` +
      `Codes: 01 cover, P chapter break, B bullets, S metrics, C comparison, TB table, CH chart, TL timeline, PS steps, Q quote, E closing.\n` +
      `Exactly ${n} pages: page 1 is 01, last is E.\n` +
      `Use at least one CH (chart) and vary the rest — do not make every content slide a B.\n` +
      `Chart data lines must be "label|pure number", no units, no percent sign.\n` +
      `Titles must be claims, not labels: "Waiting time, not the machine, is the bottleneck" — never "The Importance of X".\n` +
      `Add one N| line after each content slide: 30-60 words on how to present it, never restating the visible text.`
    )
  }
  return (
    `素材：\n${plan}\n\n` +
    `现在写《${topic}》的 ${n} 页内容，语气${toneDesc}。` +
    (audience ? `听众：${audience}。` : '') +
    `\n\n${COMPACT_SPEC}\n\n${COMPACT_FEWSHOT}\n\n` +
    `现在写《${topic}》，正好 ${n} 页。要求：\n` +
    `1. 每个页头必须是一句判断，不是名词短语。\n` +
    `   好：「菜单越长，毛利越薄」「慢的不是出餐，是补货」\n` +
    `   差：「选品的重要性」「三大优势」「现状分析」\n` +
    `   可以用这几种句式：A 不是 B，是 C／越 A，越 B／A 让 B 从 x 变成 y。每个页头换一种。\n` +
    `2. B 页写 3 条要点，每条 16-24 字，支撑上面那句判断。三条不能都是「提升了 X%」这种句式，\n` +
    `   至少一条要写「具体怎么做」，至少一条要写「哪里行不通」。\n` +
    `3. S 页写 2-3 行「数值|指标名」，数值在前，只写 1 个数值这页就算没写完。数字优先用素材里的真实数字。\n` +
    `4. C 页每行左右两栏用 | 隔开，写满 3 行，左右要真的对立，不能是同义换词。\n` +
    `5. 素材里没出现的具体数字、公司名、人名都不要编；确实需要就用「某连锁品牌」这样的泛称。\n` +
    `6. 页数写死：01 封面 1 页 + E 结尾 1 页 + 其余内容页，一共正好 ${n} 页。\n` +
    `7. 直接输出第 1 行 T|标题，不要写「好的」「以下是」这类开场白。\n` +
    `8. 页型要有节奏，不要整份都是 B：\n` +
    `   · CH 图表页 1-2 页：标题下面先写「类目|纯数字」，只写数字不要带单位或百分号，至少 3 行；\n` +
    `   · TB 表格页最多 1 页：第一行是「左列名|右列名」表头，之后每行「- 左值|- 右值」；\n` +
    `   · TL 时间轴最多 1 页，只在讲过程、阶段、里程碑时用，每行「时点|发生了什么」；\n` +
    `   · PS 流程页最多 1 页，只在讲做法步骤时用，写 3-4 行「- 一步」；\n` +
    (rich
      ? `   · P 章节过渡页使用 1-2 页，放在内容成段的地方，只写章节名加一句导语；\n`
      : `   · 这份稿子页数少，不要用 P 章节过渡页；\n`) +
    `9. 每一页内容页后面另起一行写「N|演讲备注」，40-80 字，说明这一页怎么讲、\n` +
    `   要强调哪个数字、听众可能会有疑问的地方。备注不要复述页面上已有的文字。` +
    (hasResearch ? `\n10. 上面素材是网上查到的真实资料，内容要贴着它写，不要跑题到别的行业。` : '')
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

/**
 * 场景词：出现这些词的页，配图能真正加分。
 * 「客户 / 门店 / 车间 / 景区」这类词暗示画面感；「提升 25% / 流程优化」这类
 * 抽象指标配一张图反而干扰阅读，所以不给它配额。
 */
const SCENE_WORDS = [
  '客户',
  '用户',
  '员工',
  '团队',
  '门店',
  '工厂',
  '车间',
  '仓库',
  '城市',
  '县域',
  '乡村',
  '景区',
  '现场',
  '会议',
  '培训',
  '课堂',
  '学生',
  '医院',
  '银行',
  '物流',
  '市场',
  '活动',
  '游客',
  '青年',
  '年轻',
  '孩子',
  '老人',
  '驾驶',
  '设备',
  '机器',
  '田间',
  '街',
  '展',
]

/**
 * 9.8.2：按内容决定配几张图，而不是按页数硬算。
 *
 * 打分规则：
 *   封面 +6（最显眼，几乎总要一张）
 *   要点页 +1，标题/要点里每命中一个场景词 +2（最多 +6），要点满 3 条 +1
 * 只有分数达到阈值的页才配图，所以：
 *   全是抽象指标的稿子 → 只配封面（1 张）
 *   讲门店/客户/现场的稿子 → 该配的页都配（封顶 4 张）
 */
function planImageSlots(outline, themeId, { maxImages = 4 } = {}) {
  const T = THEMES[normalizeTheme(themeId)]
  const slides = outline.slides || []
  const cap = Math.min(4, Math.max(1, maxImages))

  const scored = []
  slides.forEach((s, i) => {
    if (!IMAGE_KINDS.has(s.kind)) return
    const text = `${s.title || ''} ${(s.body || []).join(' ')} ${(s.stats || []).map((x) => x.l).join(' ')}`
    let score = 0
    if (i === 0) score += 6
    if (s.kind === 'bullets') {
      score += 1
      const hits = SCENE_WORDS.filter((w) => text.includes(w)).length
      score += Math.min(6, hits * 2)
      if ((s.body || []).length >= 3) score += 1
    }
    if (score >= 2) scored.push({ index: i, score, title: s.title || outline.title || '' })
  })

  // 封面永远保底一张：一张有图的封面，观感提升最明显
  if (!scored.some((x) => x.index === 0) && slides.length) {
    scored.unshift({ index: 0, score: 6, title: slides[0].title || outline.title || '' })
  }

  scored.sort((a, b) => b.score - a.score || a.index - b.index)

  return scored.slice(0, cap).map((w) => ({
    index: w.index,
    title: w.title,
    prompt: `clean minimal editorial illustration about "${w.title}"`,
    seed: 1000 + w.index * 37 + String(outline.title || '').length % 97,
    accent: T.accent,
    deep: T.coverBg,
    themeLabel: T.label,
    score: w.score,
  }))
}

/** 兼容旧调用点（审计里有断言引用这个名字） */
function pickImageJobs(outline, themeId, maxImages) {
  return planImageSlots(outline, themeId, { maxImages })
}

/**
 * 批量取图（并发 3 路），每张都走 fetchImage，所以「联网照片 / AI 生成」在
 * 同一份稿子里可以逐张降级，不会因为一张搜不到就让整页开天窗。
 * 进度回调故意用「已启动序号」而不是「已完成数」：三路同时起跑时完成数都是 0，
 * 前端会连着报「第 1 张」，看起来像卡住了。
 */
async function generateImages(jobs, { source = 'auto', concurrency = 3, onStart, onOne, onNote } = {}) {
  const out = new Array(jobs.length).fill(null)
  const notes = new Set()
  const note = (why) => {
    if (!why || notes.has(why)) return
    notes.add(why)
    if (onNote) onNote(why)
  }
  let cursor = 0
  let done = 0
  let started = 0
  async function worker() {
    while (cursor < jobs.length) {
      const i = cursor++
      const seq = started++
      if (onStart) onStart(i, seq, jobs.length)
      try {
        out[i] = await fetchImage(jobs[i], source, note)
      } catch (err) {
        out[i] = { ok: false, error: err.message }
      }
      done += 1
      if (onOne) onOne(i, out[i], done, jobs.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length || 1) }, worker))
  return out
}

/**
 * 取一张图：按配置选「联网搜真实照片」还是「AI 生成」。
 * 联网通道任何一步失败（没 Key / 限流 / 搜不到 / 下载失败）都降级到 AI 生成，
 * 配图绝不开天窗；实在不行 imageGen 自己还有本地插画兜底。
 */
async function fetchImage(job, source, onNote) {
  const wantWeb = source === 'web' || (source === 'auto' && webimage.hasKey())
  if (wantWeb) {
    if (!webimage.hasKey()) {
      if (onNote) onNote('no-key')
    } else {
      const q = webimage.toQuery(job.title || job.prompt, job.seed || 0)
      const r = await webimage.searchOne({ query: q, seed: job.seed || 0 })
      if (r.ok) return r
      if (onNote) onNote(r.error || 'search-failed')
    }
  }
  return imageGen.generateOne({
    prompt: job.prompt,
    seed: job.seed || 1,
    accent: job.accent,
    deep: job.deep,
    themeLabel: job.themeLabel,
  })
}

/* ------------------------------------------------------------------ *
 * 「一页都不能少」——页数不足就继续写，绝不用占位页收尾
 * ------------------------------------------------------------------ */

/** 补页总预算：超过就停手走素材兜底，别为了两页把整份稿子拖成 6 分钟 */
const COMPLETE_BUDGET_MS = 55000

/** 占位页的特征：标题是「补充要点」这类格式词，且没有真实内容 */
function isPlaceholderPage(s) {
  const title = String(s?.title || '').trim()
  if (/^补充(要点|内容|页)|^第\s*\d+\s*页$/.test(title)) return true
  return false
}

/** 这一页算不算「已完成的真实页」 */
function isRealPage(s) {
  if (!s || isPlaceholderPage(s)) return false
  if (s.kind === 'cover') return Boolean(String(s.title || '').trim())
  /* 10.0.1：图表页和时间轴页的有效内容在结构化字段里，不在 body */
  if (s.kind === 'chart') return (s.chart?.values || []).length >= 2
  if (s.kind === 'timeline') return (s.timeline || []).length >= 2
  if (s.kind === 'section') return Boolean(String(s.title || '').trim())
  const body = (s.body || []).filter((x) => !isFiller(x) && !/待补充/.test(x))
  return body.length > 0 || (s.stats || []).length > 0
}

/** 统计还差几页真实内容 */
function missingPages(slides, n) {
  const real = (slides || []).filter(isRealPage).length
  return Math.max(0, n - real)
}

/** 把续写出来的页塞进去，但结尾页永远留在最后一页（否则 E 页会被挤到中间） */
function appendPages(slides, extra) {
  const list = Array.isArray(slides) ? slides : []
  const tail = list.length > 1 && list[list.length - 1].kind === 'closing' ? list.pop() : null
  for (const s of extra || []) {
    if (tail && s.kind === 'closing') continue // 续写时模型又写了个结尾页，丢掉
    list.push(s)
  }
  if (tail) list.push(tail)
  return list
}

/** 续写提示词：只补缺的页，不重复已写内容 */
function continuePrompt({ topic, n, need, titles, lang }) {
  const done = titles.length ? `已写好的页标题：${titles.join('、')}。` : ''
  if (lang === 'en') {
    return `The deck "${topic}" needs ${n} slides in total. ${done}Write ONLY the remaining ${need} slides, do not repeat any of the titles above and do not write a T line or a cover (01). Use B|title / S|title / C|title / Q|line, and finish with E|title.`
  }
  return (
    `《${topic}》这份演示一共 ${n} 页。${done}\n` +
    `现在只补剩下的 ${need} 页，不要重复上面这些页，也不要再写 T 行和封面（01）。\n` +
    `按同样格式输出 ${need} 页：B|标题 / S|标题 / C|标题 / Q|金句 任选，最后一页用 E|标题。\n` +
    `每条要点 16-24 字，必须含数字或具体名词；S 页写「数值|指标名」；C 页每行「- 左|- 右」。不要写空话。`
  )
}

/**
 * 补齐页数。
 *
 * 顺序是「素材拼页 → 模型续写 → 删掉空页」，理由全是实测：
 *  1. 素材来自策划阶段，本来就要落到页面上，拼页是零成本的；模型续写一轮
 *     实测要 90 秒（1.5B 也不行），把 6 页任务从 20 秒拖到 110 秒。
 *  2. 模型续写的输出经常不带页头，直接串进上一页的正文，把结尾页写成大杂烩。
 *     所以只有在素材不够时才让它写，且只写一轮、有总预算。
 *  3. 占位页永远排最后 —— 先塞占位页会污染结构，模型看见「补充要点」就学会照着写。
 */
async function completeDeck({ data, topic, n, model, fastModel, opts, lang, plan, send }) {
  const started = Date.now()

  // 1) 先用素材补齐（快、真、可控）
  fillFromPlan(data, n, plan)

  // 2) 素材不够才让模型补，且只补一轮
  const work = fastModel || model
  if (missingPages(data.slides, n) > 0 && Date.now() - started < COMPLETE_BUDGET_MS) {
    const need = missingPages(data.slides, n)
    send({
      type: 'delta',
      phase: 'outline',
      text: `\n（还差 ${need} 页，继续补齐…）\n`,
    })
    let text = ''
    try {
      const r = await chaosLlm.chat({
        model: work,
        options: { ...opts, temperature: 0.5, num_predict: Math.min(420, 90 * need + 140) },
        keepAlive: '30m',
        messages: [
          {
            role: 'system',
            content:
              lang === 'en'
                ? 'You output only the requested format. No commentary, no markdown fences.'
                : '你只按给定格式输出，不加任何解释、不用 markdown 代码块。',
          },
          {
            role: 'user',
            content: continuePrompt({
              topic,
              n,
              need,
              titles: (data.slides || []).map((s) => s.title).filter(Boolean),
              lang,
            }),
          },
        ],
        onDelta: (d) => {
          text += d
        },
      })
      text = String(r?.text || text)
      const more = parseCompactOutline(text, { topic, n: need, pad: false })
      if (more?.slides?.length) {
        // 续写常把已有的页又抄一遍，标题重复的直接丢掉
        const seen = new Set((data.slides || []).map((s) => String(s.title || '').trim()).filter(Boolean))
        const fresh = more.slides.filter((s) => {
          const t = String(s.title || '').trim()
          if (!t || seen.has(t)) return false
          seen.add(t)
          return true
        })
        if (fresh.length) appendPages(data.slides, fresh)
      }
    } catch (_) {
      /* 续写失败不该把整份稿子废掉，下面还有素材兜底 */
    }
    // 续写出来的页也补齐条数，别又出现一页一条
    fillFromPlan(data, n, plan)
  }

  // 还有「本页内容待补充」的页，就直接删掉 —— 宁可少一页，
  // 也不能让用户翻到一页空话。删完再让 normalize 按剩余页数收口。
  const slides = data.slides || []
  data.slides = slides.filter(
    (s, i) => isRealPage(s) || s.kind === 'closing' || (i === 0 && s.kind === 'cover'),
  )
  if (!data.slides.length) data.slides = slides

  // 结尾页永远放最后一页：续写塞进来的页可能把 E 页挤到中间，
  // normalize 又只把「最后一页」当结尾，会把一页内容整页改版式
  const arr = data.slides
  const ci = arr.findIndex((s) => s.kind === 'closing')
  if (ci >= 0 && ci !== arr.length - 1) arr.push(arr.splice(ci, 1)[0])

  return data
}

/** 把素材行清洗成可用的要点（去掉序号、符号、太短的） */
function planLines(plan, used) {
  return planRows(plan).filter((l) => !isFiller(l) && !used.has(l.slice(0, 12)))
}

/** 清洗单行素材：去列表符号和序号，滤掉开场白/收尾话 */
function cleanRow(line) {
  let s = String(line || '').trim()
  s = s.replace(/\*{2,}/g, '').replace(/^[-*·•]\s+/, '').replace(/^\d+\s*[.、)）]\s*/, '').trim()
  if (s.length < 8) return ''
  // 「好的，以下是关于…的 8 条具体信息」这类开场白不是内容
  if (/^(好的|以下是|下面是|当然|没问题|可以|以下为)/.test(s) && s.length < 48) return ''
  // 「…用于演示文稿」「…用于 PPT」这类说明尾巴
  if (/(用于(演示文稿|PPT|幻灯片)|以上(就是|是))/.test(s)) return ''
  if (/^(第\s*\d+\s*[页条点]?|页数|页标题)[：:]?$/.test(s)) return ''
  return s
}

/** 素材全文清洗（给提示词和兜底共用同一套规则） */
function cleanPlan(text) {
  return planRows(text).join('\n')
}

function planRows(text) {
  return String(text || '')
    .split('\n')
    .map(cleanRow)
    .filter(Boolean)
}

/** 素材行当要点用时要短：按标点切一刀，别硬截断出「…」 */
function fitLine(line, cap = 32) {
  const s = String(line || '').trim()
  if (s.length <= cap) return s
  const cut = s.slice(0, cap)
  const m = cut.match(/^.*[，,；;。、]/)
  return (m ? m[0] : cut).replace(/[，,；;。、]$/, '')
}

/** 素材兜底：先就地修补空页/太薄的页（保住页序和版式），不够再从后面补页 */
function fillFromPlan(data, n, plan) {
  const slides = data.slides || []
  const used = new Set()
  slides.forEach((s) => (s.body || []).forEach((x) => used.add(String(x).slice(0, 12))))
  const pool = planLines(plan, used)
  if (!pool.length) return data

  for (const s of slides) {
    if (!pool.length) break
    if (s.kind === 'closing' || s.kind === 'cover' || s.kind === 'quote') continue
    const body = s.body || (s.body = [])
    const real = isRealPage(s)
    // 空页要整页重写；已经有 1 条要点但太薄的页只需补一条
    if (real && body.length >= 2) continue
    if (!real) {
      const group = pool.splice(0, 3).map((x) => fitLine(x))
      s.kind = 'bullets'
      s.title = titleFromLine(group[0])
      s.body = group
      s.stats = []
      s.extra = []
      continue
    }
    while (body.length < 2 && pool.length) body.push(fitLine(pool.shift()))
  }

  let guard = 0
  while (missingPages(slides, n) > 0 && pool.length && guard++ < 10) {
    const group = pool.splice(0, 3)
    // 只剩一条素材时别再开新页（一页只有一句话最难看），并进结尾页当行动项
    if (group.length < 2) {
      const tail = slides[slides.length - 1]
      if (tail && (tail.kind === 'closing' || tail.kind === 'bullets')) {
        tail.body = tail.body || []
        if (tail.body.length < 4) tail.body.push(...group.map((x) => fitLine(x)))
      }
      break
    }
    appendPages(slides, [
      {
        kind: 'bullets',
        title: titleFromLine(group[0]),
        body: group.map((x) => fitLine(x)),
        extra: [],
        stats: [],
        note: '',
        image: '',
      },
    ])
  }
  return data
}

/** 从一条素材里抽个像标题的短语：优先取冒号/逗号前那截 */
function titleFromLine(line) {
  const s = String(line || '').trim()
  const cut = s.split(/[：:，,。；;（(]/)[0].trim()
  const t = (cut.length >= 4 ? cut : s).slice(0, 18)
  return t || '要点'
}

/**
 * 一页只有 1 条要点会显得空（实测模型爱写「B|三大要点」下面只给 1 条）。
 * 从素材池里补齐到 2 条 —— 素材是策划阶段攒的真实信息，比空页强。
 */
function thicken(outline, plan) {
  const slides = outline?.slides || []
  if (!slides.length) return outline
  const used = new Set()
  slides.forEach((s) => (s.body || []).forEach((x) => used.add(String(x).slice(0, 10))))
  const pool = planLines(plan, used)
  for (const s of slides) {
    if (s.kind !== 'bullets') continue
    const body = s.body || (s.body = [])
    let guard = 0
    while (body.length < 2 && pool.length && guard++ < 3) {
      body.push(String(pool.shift()).slice(0, 40))
    }
  }
  return outline
}

/**
 * 稳定的小哈希：同一个主题每次拿到同一个 seed，封面图不会每次重出一张。
 */
function hashString(s) {
  let h = 2166136261
  const str = String(s || '')
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = (h * 16777619) >>> 0
  }
  return h >>> 0
}

/**
 * 单页回炉。
 *
 * 只重写闸门判定「修不了」的那几页，一页一次，最多 3 页、总预算 50 秒。
 * 为什么不一整份重写：整份重写要 60 秒起，而且大概率在别的地方又出毛病；
 * 单页重写 8-15 秒，且能带上「这一页具体哪里不合格」——
 * 实测带原因的改写成功率明显高于笼统的「再写好一点」。
 */
async function refineSlides({ deck, original, rewrite, topic, research, model, lang, send, budgetMs = 45000 }) {
  const started = Date.now()
  /* CPU 推理（无 GPU）时单页回炉要 40-90 秒，页数一多总时长必爆。
   * 只回炉最严重的 2 页，其余靠规则修 + 兜底撑住版面。 */
  const jobs = rewrite.slice(0, 2)
  if (!jobs.length) return deck
  const slides = [...(deck.slides || [])]
  const peers = (deck.slides || []).map((x) => String(x?.title || '').trim())

  for (const job of jobs) {
    if (Date.now() - started > budgetMs) break
    const slide = slides[job.index]
    if (!slide) continue
    let text = ''
    try {
      /* CPU 推理单次可能磨到 80 秒，预算检查只在任务间隙生效 ——
       * 必须给单次调用加硬超时，不然一页回炉就能吃掉整个时长预算。 */
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 40000)
      const r = await chaosLlm.chat({
        model,
        signal: ac.signal,
        options: { num_ctx: 4096, temperature: 0.55, top_p: 0.9, repeat_penalty: 1.1, num_predict: 280 },
        keepAlive: '30m',
        messages: [
          {
            role: 'system',
            content:
              lang === 'en'
                ? 'You output only the requested format. No commentary, no markdown fences.'
                : '你只按给定格式输出，不加任何解释、不用 markdown 代码块。',
          },
          {
            role: 'user',
            content: quality.rewritePrompt({
              // 给模型看的是「删除前的原版」：删空之后它就没东西可改了
              slide: original?.[job.index] || slide,
              topic,
              research,
              why: job.why,
              peers,
              lang,
            }),
          },
        ],
        onDelta: (d) => {
          text += d
        },
      })
      clearTimeout(timer)
      text = String(r?.text || text)
    } catch (_) {
      continue // 单页重写失败就保留原样，不能因为它整份失败
    }

    const parsed = parseCompactOutline(text, { topic, n: 1, pad: false })
    const fresh = parsed?.slides?.[0]
    /* 改写拿不出东西就退回原版。
     * 之前这里是 continue —— 于是闸门把内容删干净、回炉又失败，
     * 页面上就留了一张只有标题的空片，比原来的毛病还刺眼。 */
    const giveUp = () => {
      /* 回炉失败时的取舍：规则修过的版本只要还有 ≥2 条内容，就比
       * 带着垃圾素材的原版好——原版是闸门判定过「抄来的/空话」的。
       * 修完真空了才退回原版，反正后面还有空页兜底 + 终检。 */
      const cur = slides[job.index]
      const curHas =
        (cur?.body || []).length + (cur?.extra || []).length + (cur?.stats || []).length
      if (curHas >= 2) return
      if (original?.[job.index]) slides[job.index] = original[job.index]
    }
    if (!fresh) {
      giveUp()
      continue
    }
    // 只接受「同一页型」的改写。模型常把要点页改成金句页，那等于换了内容
    if (fresh.kind !== slide.kind && fresh.kind !== 'bullets') {
      giveUp()
      continue
    }
    const body = (fresh.body || []).filter((x) => String(x).trim().length >= 6)
    if (body.length < 2) {
      giveUp()
      continue
    }
    slides[job.index] = {
      ...slide,
      kind: fresh.kind === 'bullets' && slide.kind === 'twocol' ? 'twocol' : slide.kind,
      title: String(fresh.title || slide.title || '').trim(),
      body: fresh.body,
      extra: fresh.extra?.length ? fresh.extra : slide.extra,
      stats: fresh.stats?.length ? fresh.stats : slide.stats,
    }
    send({ type: 'progress', phase: 'refine', label: `修订第 ${job.index + 1} 页（${job.why}）` })
  }
  return { ...deck, slides }
}


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
    speed = 'auto',
    imageSource = 'auto',
  } = opts

  const send = (ev) => {
    if (!emit) return
    try {
      emit(ev)
    } catch (_) {
      /* 前端断开了也不该拖垮生成 */
    }
  }

  /* 10.0.1：只出大纲（WPS AI 那种「先看大纲再确认」的第一步）。
   * 走到 outline 事件就返回，不配图、不渲染、不落盘 —— 用户改完大纲再走 assemble。 */
  const outlineOnly = Boolean(opts.outlineOnly)

  const t0 = Date.now()
  const n = clampPages(pages, 6)
  /* 9.9.7：页数语义 = 成品 pptx 的页数（用户要几页就拿到几页）。
   * 渲染时满足条件会自动加一页目录（toc = withToc && slides.length >= 5），
   * 所以让模型写的大纲要少一页，否则成品会比用户要的多一页。 */
  const tocPlanned = Boolean(withToc) && n >= 6
  const askN = tocPlanned ? n - 1 : n
  const topicClean = String(topic || '').trim()
  if (!topicClean) return { ok: false, error: '请先填写 PPT 主题' }
  const toneDesc = TONES[tone] ? TONES[tone] : TONES.formal
  const lang = LANGS[language] ? language : 'zh'
  const audienceClean = String(audience || '').trim().slice(0, 40)
  const themeId = normalizeTheme(theme)

  /* ---- 选模型与档位 ----
   * 实测（i5-12400 / 无独显，紧凑格式）：
   *   qwen2.5:7b   66 秒 / 174 token / 格式全对 / 质量 100 分
   *   qwen2.5:1.5b 25 秒 / 但要点偏少、易退化成重复输出
   * 旧 JSON 提示词下 7B 要 224 秒 —— 慢的根源是输出格式，不是模型大小。
   * 所以默认直接上 7B：多等 40 秒换一份能直接用的稿子，比快但空洞划算。
   *   auto / balanced  策划用小模型、正文用 7B（默认）
   *   fast             正文用 1.5B，配图只出封面（约 80 秒，着急时用）
   *   quality          7B + 更低温度
   */
  /* 先确保探测过引擎：resolveModel 要按已装模型选大模型，snapshot 空的话
   * 会退化成小模型 —— 大纲质量立刻崩（2026-10-25 实测翻过车） */
  try {
    const s0 = chaosLlm.snapshot()
    if (!(s0?.models || []).length) await chaosLlm.probe({ force: true })
  } catch (_) {
    /* 探测失败就按兜底走 */
  }
  const mainModel = resolveModel(model)
  const fastModel = chaosLlm.pickFastModel() || mainModel
  const mode = ['fast', 'balanced', 'quality'].includes(speed) ? speed : 'auto'
  const gpu = typeof chaosLlm.hasGpu === 'function' ? chaosLlm.hasGpu() : false
  const effective = mode === 'auto' ? 'balanced' : mode
  const outlineModel = effective === 'fast' ? fastModel : mainModel
  const planModel = fastModel
  const planOpts = { num_ctx: 8192, temperature: 0.7, top_p: 0.9, num_predict: 520 }
  const outlineOpts = {
    num_ctx: 8192,
    temperature: effective === 'quality' ? 0.35 : 0.45,
    top_p: 0.9,
    // 小模型在宽松预算下会把整份稿子重复好几遍（实测 1.5B 重复 4 次），
    // 1.15 的重复惩罚 + 按页数收紧的预算能压住
    repeat_penalty: 1.15,
    num_predict: Math.min(1400, 90 * n + 220),
  }
  send({ type: 'model', planModel, outlineModel, mode: effective, gpu })

  /* ---- 封面图预取 ----
   * 免费出图是每 IP 每 45 秒一张，等它排在文本后面就是干等 45 秒。
   * 封面只需要主题就能画，所以从第一秒就并行启动，文本写完时图基本也好了。
   */
  const coverPrompt = `abstract conceptual cover artwork representing "${topicClean}"`
  const coverSeed = (hashString(topicClean) % 90000) + 1000
  const themeDef = THEMES[themeId]
  let coverJob = null
  if (withImages && !outlineOnly) {
    coverJob = fetchImage(
      {
        prompt: coverPrompt,
        title: topicClean,
        seed: coverSeed,
        accent: themeDef.accent,
        deep: themeDef.coverBg,
        themeLabel: themeDef.label,
      },
      imageSource,
      (why) => send({ type: 'notice', reason: why, field: 'image' }),
    )
      .then((r) => (r && r.ok ? r : null))
      .catch(() => null)
  }

  /* ---- 阶段一：联网找资料 ----
   * 不再是「让模型先想一遍」，而是真的去搜。本地模型编出来的数字
   * 用户一眼能看穿（「降低库存积压 50%」），真实数据才有说服力。
   *
   * 检索和封面图并行：封面从第一秒就在排队出图，检索回来时图也差不多好了。
   */
  send({ type: 'phase', phase: 'plan', label: '联网搜集资料' })
  let plan = ''      // 给模型看的素材
  let planRows = ''  // 素材兜底用的纯行版本
  let planText = ''  // 给前端看的展示文本（两者格式不同）
  let hasResearch = false
  let research = null
  let tokens = 0
  try {
    research = await researchMod.research(topicClean, {
      lang,
      onNote: (why) => send({ type: 'notice', reason: why, field: 'research' }),
    })
  } catch (_) {
    research = null
  }

  if (research && research.ok) {
    hasResearch = true
    // 把检索到的东西流式吐给前端，用户能看见「真的查到了东西」
    const lines = []
    if (research.angles?.length) {
      lines.push(`搜到 ${research.angles.length} 条行业话题：`)
      research.angles.forEach((a) => lines.push(`· ${a}`))
    }
    if (research.facts?.length) {
      lines.push('')
      lines.push(`抓到 ${research.facts.length} 条带数字的资料：`)
      research.facts.forEach((f) => lines.push(`· ${f.text}`))
    }
    if (research.sources?.length) {
      lines.push('')
      lines.push(`来源：${research.sources.slice(0, 4).map((s) => s.title).join('／')}`)
    }
    const text = lines.join('\n')
    planText = text
    // 送给模型的是另一份：只留素材本身，不带「搜到 N 条」这种汇报腔
    plan = researchMod.factsPrompt(research) || text
    // 素材兜底用的纯行版本。只放带数字的事实——锚点标题绝不能进：
    // 兜底拼页是照抄素材行，标题进来页面就会出现「XX案例.docx-原创力文档」
    planRows = (research.facts || []).map((f) => f.text).join('\n')
    // 分成小段推，前端才有「在打字」的观感
    for (let i = 0; i < text.length; i += 60) {
      send({ type: 'delta', phase: 'plan', text: text.slice(i, i + 60) })
      await new Promise((r) => setTimeout(r, 12))
    }
    send({ type: 'research', facts: research.facts?.length || 0, angles: research.angles?.length || 0 })
  } else {
    /* 检索失败（断网 / 全部被拦）：退回让模型自己列素材。
     * 会标明「未联网」，不假装是查到的。 */
    send({ type: 'notice', reason: 'research-failed', field: 'research' })
    try {
      const r = await chaosLlm.chat({
        model: planModel,
        options: planOpts,
        keepAlive: '30m',
        messages: [
          {
            role: 'system',
            content: lang === 'en' ? 'You are a sharp presentation strategist.' : '你是一位思路清晰的演示文稿策划师。',
          },
          { role: 'user', content: fallbackPlanPrompt({ topic: topicClean, n, toneDesc, audience: audienceClean }) },
        ],
        onDelta: (d) => send({ type: 'delta', phase: 'plan', text: d }),
      })
      plan = String(r?.text || '').trim()
      tokens += Number(r?.evalCount) || Math.ceil(plan.length / 2)
      planText = plan
    } catch (err) {
      // 素材阶段失败不该终止整份稿子，正文还能自己写
      plan = ''
    }
    plan = cleanPlan(plan)
  }

  /* ---- 阶段二：逐页大纲（流式，边生成边冒标题） ---- */
  send({ type: 'phase', phase: 'outline', label: '逐页写内容' })
  let data = null
  let rawText = ''
  /* 边写边预览：每写完一页就把「当前这份不完整的大纲」推给前端，
   * 右侧大预览框能一页页长出来，而不是等到最后一次性弹出。
   * 解析是纯内存操作（文本才 1-2KB），但按 token 触发太频繁，限到 450ms 一次。 */
  let lastPreviewAt = 0
  let lastPreviewKey = ''
  const emitPreview = () => {
    const now = Date.now()
    if (now - lastPreviewAt < 450) return
    lastPreviewAt = now
    const parsed = parseCompactOutline(rawText, { topic: topicClean, n, pad: false })
    if (!parsed || !parsed.slides?.length) return
    const tail = parsed.slides[parsed.slides.length - 1]
    const key = `${parsed.slides.length}|${tail.title}|${(tail.body || []).length}|${(tail.stats || []).length}`
    if (key === lastPreviewKey) return
    lastPreviewKey = key
    send({
      type: 'preview',
      outline: { title: parsed.title, subtitle: parsed.subtitle, slides: parsed.slides },
    })
  }
  // 失败重试 3 次而不是 2 次：小模型偶发吐格式垃圾是常事，一次重试往往不够，
  // 但「任务没写完不许停」也不能真的无限循环 —— 服务端 3 次 × 前端整任务重试，
  // 已经是足够大的兜底空间。
  for (let attempt = 1; attempt <= 3 && !data; attempt++) {
    rawText = ''
    lastPreviewKey = ''
    try {
      const r = await chaosLlm.chat({
        model: outlineModel,
        options: { ...outlineOpts, temperature: attempt === 1 ? outlineOpts.temperature : 0.3 },
        keepAlive: '30m',
        messages: [
          {
            role: 'system',
            content:
              lang === 'en'
                ? 'You output only the requested format. No commentary, no markdown fences.'
                : '你只按给定格式输出，不加任何解释、不用 markdown 代码块。',
          },
          {
            role: 'user',
            content: outlinePrompt({ topic: topicClean, n: askN, toneDesc, audience: audienceClean, lang, plan, hasResearch }),
          },
        ],
        onDelta: (d) => {
          rawText += d
          send({ type: 'delta', phase: 'outline', text: d })
          emitPreview()
        },
      })
      rawText = String(r?.text || rawText)
      tokens += Number(r?.evalCount) || Math.ceil(rawText.length / 2)
    } catch (err) {
      if (attempt === 3) {
        const msg = `模型生成失败：${err.message}`
        send({ type: 'error', error: msg, code: err?.code })
        if (coverJob) coverJob.catch(() => null)
        return { ok: false, error: msg, code: err?.code }
      }
      continue
    }

    data = parseCompactOutline(rawText, { topic: topicClean, n, pad: false })
    // 兜底：模型万一还是给了 JSON（换模型、换提示词时可能发生）
    if (!data) data = parseJsonLoose(rawText)
    if (!data || !Array.isArray(data.slides) || !data.slides.length) {
      data = null
      send({ type: 'delta', phase: 'outline', text: '\n（格式没对上，重新写一次…）\n' })
    }
  }
  if (!data) {
    if (coverJob) coverJob.catch(() => null)
    return { ok: false, error: '模型连续三次没能产出有效内容，已自动重试仍未成功，请再点一次生成' }
  }

  // 页数不齐就接着写 —— 「没写完」不算完成，不能让用户拿到半份稿子
  data = await completeDeck({
    data,
    topic: topicClean,
    n: askN,
    model: outlineModel,
    fastModel,
    opts: outlineOpts,
    lang,
    plan: planRows || plan,
    send,
  })

  let outline = thicken(polishOutline(normalizeOutline(data, { topic: topicClean, n })), plan)

  /* ---- 质量闸门 ----
   * 模型出来的稿子必过一遍：规则能修的当场修（抄来的素材、塌掉的双栏、
   * 套话页头），修不了的挑最多 3 页回炉。这是「看起来像模板」和
   * 「真的能拿去讲」之间最后一道关。 */
  /* 回炉只在「有 GPU 或用户点名 quality」时跑。CPU 推理单页 80s 起步，
   * 而且客户端中止后 Ollama 服务端会把幽灵生成跑完，下一个请求在
   * 队列里干等 —— 实测两页回炉拖出 160s。CPU 上规则修 + 兜底已够用。 */
  const canRefine = gpu || effective === 'quality'
  try {
    const gate = quality.auditDeck(outline, { topic: topicClean, research, canRefine })
    outline = gate.deck
    if (gate.rewrite.length && canRefine) {
      send({ type: 'phase', phase: 'refine', label: `修订 ${gate.rewrite.length} 页` })
      outline = await refineSlides({
        deck: outline,
        original: gate.original,
        rewrite: gate.rewrite,
        topic: topicClean,
        research,
        model: fastModel,
        lang,
        send,
      })
      // 回炉后再过一遍，把这次新引入的小毛病（比如页头变重复）压掉
      outline = quality.auditDeck(outline, { topic: topicClean, research }).deck
    } else if (gate.rewrite.length) {
      /* CPU 上跳过回炉时，被规则删空的页交给下面的素材兜底填满 */
      send({ type: 'notice', reason: 'refine-skipped-cpu', field: 'refine' })
    }
    send({
      type: 'quality',
      score: gate.report.score,
      fixed: gate.report.fixed,
      rewritten: gate.rewrite.length,
      issues: gate.report.issues.slice(0, 12).map((x) => `${x.page + 1}:${x.type}`),
    })
    outline = polishOutline(outline)
  } catch (err) {
    // 闸门本身出问题不能连累出片
    send({ type: 'notice', reason: 'quality-skip', field: 'quality' })
  }

  /* 最后一道保险。
   * 闸门删、回炉又没救回来的页，到这里可能是空的 —— 那种页翻过去一片白，
   * 比内容差更伤人。用真实素材把它们填满，实在没素材才丢掉这一页。 */
  /* 结构性页型（金句/章节/图表/时间轴）的「内容」不在 body 里，不能按空页处理 */
  const STRUCT_KINDS = new Set(['quote', 'cover', 'section', 'chart', 'timeline'])
  const isHole = (x) =>
    x && !STRUCT_KINDS.has(x.kind) &&
    !(x.body || []).length && !(x.stats || []).length && !(x.extra || []).length
  if ((outline.slides || []).some(isHole)) {
    const patched = fillFromPlan({ ...data, slides: outline.slides }, n, planRows || plan)
    outline = { ...outline, slides: patched.slides }
    // 素材也填不上的，直接删页；页数少一页总比空一页好
    const kept = outline.slides.filter((x) => !isHole(x))
    if (kept.length >= Math.min(4, n)) outline = { ...outline, slides: kept }
    /* 兜底拼页是照抄素材行，必须再过一遍规则闸门——不然「XX案例.docx-原创力文档」
     * 这种行就绕过了前面所有检查直接上页面（2026-10-25 实测踩坑）。 */
    try {
      outline = quality.auditDeck(outline, { topic: topicClean, research }).deck
    } catch (_) { /* 闸门故障不能连累出片 */ }
    /* 终检删掉垃圾行后页面可能又变空 —— 再清一轮，别把只有标题的空壳交给用户 */
    const kept2 = outline.slides.filter((x) => !isHole(x))
    if (kept2.length >= Math.min(4, n)) outline = { ...outline, slides: kept2 }
  }

  /* ---- 9.9.7：页数硬保证（WPS 式体验：用户要几页就出几页）----
   * 闸门和兜底都可能删页，这里把页数拉回 n：
   *  - 缺页：先用素材补（fillFromPlan 会开新页），补出来的页必须再过闸门；
   *    素材见底就把内容最厚的一页拆成两页 —— 用真实内容凑数，不放空壳。
   *  - 超页：从尾部裁，封面（第 1 页）和结尾页（E）不动。 */
  try {
    /* 缺页先让模型按原大纲口径再续写一轮 —— 模型写的话比拼素材行像话；
     * completeDeck 会先试素材、不够才调模型，只补一轮有预算兜底 */
    if ((outline.slides || []).length < n) {
      try {
        await completeDeck({
          data: { ...data, slides: outline.slides },
          topic: topicClean,
          n: askN,
          model: outlineModel,
          fastModel,
          opts: outlineOpts,
          lang,
          plan: planRows || plan,
          send,
        })
      } catch (_) { /* 续写失败走后面的素材补页/拆页兜底 */ }
    }
    /* 9.9.7：页数硬保证各阶段的观测点（e2e 只显示 notice，用它诊断补页链路） */
    send({ type: 'notice', reason: 'page-count', field: `model-fill=${(outline.slides || []).length}` })
    let guardPg = 0
    while ((outline.slides || []).length < askN && guardPg++ < 3) {
      const before = (outline.slides || []).length
      const patched = fillFromPlan({ ...data, slides: outline.slides }, askN, planRows || plan)
      outline = { ...outline, slides: patched.slides }
      if ((outline.slides || []).length === before) break
    }
    /* 补出来的页是照抄素材行，必须再过一遍规则闸门（老坑：绕过检查） */
    try {
      outline = quality.auditDeck(outline, { topic: topicClean, research }).deck
    } catch (_) { /* 闸门故障不能连累出片 */ }
    const kept3 = outline.slides.filter((x) => !isHole(x))
    if (kept3.length >= Math.min(2, askN)) outline = { ...outline, slides: kept3 }
    send({ type: 'notice', reason: 'page-count', field: `material-fill=${(outline.slides || []).length}` })

    /* 素材见底还缺页：拆最厚的内容页（正文 ≥4 行才值得拆），插到结尾页前面 */
    guardPg = 0
    while ((outline.slides || []).length < askN && guardPg++ < 6) {
      let best = -1
      let bestLen = 0
      outline.slides.forEach((s, i) => {
        if (s.kind === 'cover' || s.kind === 'closing' || s.kind === 'quote') return
        const len = (s.body || []).length + (s.extra || []).length
        if (len > bestLen) {
          bestLen = len
          best = i
        }
      })
      if (best < 0 || bestLen < 4) break // 没有可拆的厚页了，只能认命
      const s = outline.slides[best]
      const lines = [...(s.body || []), ...(s.extra || [])]
      const half = Math.ceil(lines.length / 2)
      outline.slides[best] = { ...s, body: lines.slice(0, half), extra: [] }
      const tailLines = lines.slice(half)
      const newPage = {
        kind: 'bullets',
        title: titleFromLine(tailLines[0] || s.title),
        body: tailLines.slice(0, 3),
        extra: [],
        stats: [],
        note: '',
        image: '',
      }
      const ci = outline.slides.findIndex((x) => x.kind === 'closing')
      outline.slides.splice(ci >= 0 ? ci : outline.slides.length, 0, newPage)
    }

    /* 超页：从尾部裁，结尾页压轴不动 */
    while ((outline.slides || []).length > askN && outline.slides.length > 2) {
      const last = outline.slides.length - 1
      const dropAt = outline.slides[last]?.kind === 'closing' ? last - 1 : last
      if (dropAt <= 0) break
      outline.slides.splice(dropAt, 1)
    }
  } catch (_) { /* 页数校正出问题不能连累出片 */ }

  send({ type: 'notice', reason: 'page-count', field: `final=${(outline.slides || []).length}(askN=${askN})` })

  send({ type: 'outline', outline, elapsed: Date.now() - t0 })

  /* 只要大纲：到这里就收工，把大纲交回去让用户改。
   * 必须补一个 done 事件 —— 前端 streamPost 靠 done 事件取结果，
   * 只发 outline 不发 done 会被判成「生成流意外结束」。 */
  if (outlineOnly) {
    if (coverJob) coverJob.catch(() => null)
    const result = {
      ok: true,
      outline,
      outlineOnly: true,
      title: outline.title,
      subtitle: outline.subtitle,
      pages: outline.slides.length,
      tokens,
      model: outlineModel,
      mode: effective,
      topic: topicClean,
      theme: themeId,
      withToc: Boolean(withToc),
      lang,
    }
    send({ type: 'done', result })
    return result
  }

  /* ---- 阶段三：配图 ---- */
  const images = {}
  let imageOk = 0
  if (withImages) {
    // 配几张不写死，交给 planImageSlots 按内容打分决定（封面必出，其余看有没有
    // 具体场景）。这里只给上限：
    //   联网搜图基本秒回 → 最多 4 张
    //   纯 AI 出图每张要排 45 秒 → 最多 2 张，否则总时长会被配图吃掉
    const canWeb = imageSource === 'web' || (imageSource === 'auto' && webimage.hasKey())
    const cap = effective === 'fast' ? 1 : canWeb ? 4 : 2
    const jobs = pickImageJobs(outline, themeId, cap, lang)

    // 封面用预取那张：prompt / 标题 / seed 全部对齐预取参数，命中缓存而不是重画一张。
    // 标题必须一起对齐 —— 联网搜图是按标题生成查询词的，标题不同就是一次新搜索。
    const cover = coverJob ? await coverJob : null
    if (jobs.length && jobs[0].index === 0) {
      if (cover) {
        jobs[0].prompt = coverPrompt
        jobs[0].title = topicClean
        jobs[0].seed = coverSeed
      }
    }

    send({ type: 'phase', phase: 'image', label: `生成配图（0/${jobs.length}）`, total: jobs.length, done: 0 })

    let doneBefore = 0
    if (cover && jobs.length && jobs[0].index === 0) {
      images[0] = cover.file
      outline.slides[0].imageName = cover.name
      imageOk += 1
      doneBefore = 1
      send({
        type: 'progress',
        phase: 'image',
        label: `生成配图（1/${jobs.length}）`,
        done: 1,
        total: jobs.length,
        index: 0,
        source: cover.source,
        name: cover.name,
      })
      jobs.shift()
    }

    if (jobs.length) {
      // 封面已经算掉一张，总数要用「剩余 + 已完成」，否则会显示成 2/1 这种倒退
      const grand = jobs.length + doneBefore
      await generateImages(jobs, {
        source: imageSource,
        concurrency: 3,
        onStart: (_i, seq) => {
          // 免费出图按 45 秒窗口排队，先给个「在等」的提示，别让人以为卡死了。
          // 联网搜图基本是秒回，这句提示只在等待时才出现，不会造成误导。
          const shown = Math.min(doneBefore + seq + 1, grand)
          send({
            type: 'progress',
            phase: 'image',
            label: `生成配图（第 ${shown}/${grand} 张排队中…）`,
            done: doneBefore + seq,
            total: grand,
            pending: true,
          })
        },
        onOne: (i, r, done) => {
          if (r?.ok) {
            images[jobs[i].index] = r.file
            outline.slides[jobs[i].index].imageName = r.name
            imageOk += 1
          }
          send({
            type: 'progress',
            phase: 'image',
            label: `生成配图（${doneBefore + done}/${grand}）`,
            done: doneBefore + done,
            total: grand,
            index: jobs[i].index,
            source: r?.source || '',
            name: r?.name || '',
          })
        },
        onNote: (why) => {
          // 联网通道不可用时只提示一次，别在进度里刷屏
          send({ type: 'notice', reason: why, field: 'image' })
        },
      })
    }
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
    mode: effective,
    model: outlineModel,
    elapsedMs: Date.now() - t0,
    createdAt: Date.now(),
  })

  /* 9.9.7：一份 PPT = 1 个任务，计进任务数量 */
  quota.bumpTask('ppt')

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
    mode: effective,
    model: outlineModel,
    elapsedMs: Date.now() - t0,
  }
  send({ type: 'done', result })
  return result
}

/**
 * 10.0.1：按「用户已确认（并可能改过）的大纲」出片。
 *
 * 和 generate() 的区别只有一点：内容不再问模型，直接拿传进来的大纲配图 + 渲染。
 * 这是 WPS AI 那条链路的第二步 —— 大纲阶段充分可改，改完才花时间出片，
 * 避免「改一次就要重跑两分钟模型」。
 */
async function assemble({ outline, theme, withToc, withImages = true, imageSource = 'auto' } = {}, emit = null) {
  const send = (ev) => {
    if (!emit) return
    try {
      emit(ev)
    } catch (_) {
      /* 前端断开不该拖垮渲染 */
    }
  }

  const t0 = Date.now()
  const clean = cleanOutlineForRender(outline)
  if (clean.slides.length < 2) return { ok: false, error: '大纲至少要有 2 页（含封面）' }

  const themeId = normalizeTheme(theme)
  const toc = Boolean(withToc) && clean.slides.length >= 5
  const lang = /[\u4e00-\u9fa5]/.test(clean.title) ? 'zh' : 'en'
  send({ type: 'phase', phase: 'image', label: '准备配图', total: 0, done: 0 })

  /* ---- 配图 ----
   * 先复用大纲里已经带回来的 imageName（编辑时没动过的图不重画），
   * 剩下的按内容打分补。 */
  const images = {}
  const reuse = {}
  clean.slides.forEach((s, i) => {
    if (!s.imageName) return
    const hit = imageGen.resolveImage(s.imageName)
    if (hit) {
      images[i] = hit.file
      reuse[i] = true
    } else {
      s.imageName = ''
    }
  })

  let imageOk = Object.keys(images).length
  if (withImages) {
    const canWeb = imageSource === 'web' || (imageSource === 'auto' && webimage.hasKey())
    const cap = canWeb ? 4 : 2
    const jobs = pickImageJobs(clean, themeId, cap, lang).filter((j) => !reuse[j.index])
    if (jobs.length) {
      send({ type: 'phase', phase: 'image', label: `生成配图（0/${jobs.length}）`, total: jobs.length, done: 0 })
      let done = 0
      await generateImages(jobs, {
        source: imageSource,
        concurrency: 3,
        onStart: (_i, seq) =>
          send({
            type: 'progress',
            phase: 'image',
            label: `生成配图（第 ${Math.min(seq + 1, jobs.length)}/${jobs.length} 张排队中…）`,
            done,
            total: jobs.length,
            pending: true,
          }),
        onOne: (i, r) => {
          done += 1
          if (r?.ok) {
            images[jobs[i].index] = r.file
            clean.slides[jobs[i].index].imageName = r.name
            imageOk += 1
          }
          send({
            type: 'progress',
            phase: 'image',
            label: `生成配图（${done}/${jobs.length}）`,
            done,
            total: jobs.length,
            index: jobs[i].index,
            source: r?.source || '',
            name: r?.name || '',
          })
        },
        onNote: (why) => send({ type: 'notice', reason: why, field: 'image' }),
      })
    }
  } else {
    send({ type: 'phase', phase: 'image', label: '跳过配图', skipped: true })
  }

  /* ---- 渲染 ---- */
  send({ type: 'phase', phase: 'render', label: '排版渲染' })
  const id = crypto.randomBytes(8).toString('hex')
  const pptx = buildPptx({ outline: clean, themeId, withToc: toc, images, lang })
  const out = await writeOut(pptx, id, clean.title, clean, {
    id,
    topic: clean.title,
    theme: themeId,
    language: lang,
    withToc: toc,
    images: imageOk,
    elapsedMs: Date.now() - t0,
    createdAt: Date.now(),
    assembledAt: Date.now(),
  })

  quota.bumpTask('ppt')

  const result = {
    ok: true,
    id,
    file: out.file,
    download: path.basename(out.file),
    title: clean.title,
    pages: clean.slides.length + (toc ? 1 : 0),
    images: imageOk,
    outline: clean,
    theme: themeId,
    withToc: toc,
    size: out.size,
    elapsedMs: Date.now() - t0,
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
  assemble,
  render,
  getOutline,
  resolveFile,
  deleteFile,
  listFiles,
  buildPptx,
  normalizeOutline,
  parseCompactOutline,
  polishOutline,
  fallbackPlanPrompt,
  researchMod,
  outlinePrompt,
  sniffProgress,
  pickImageJobs,
  planImageSlots,
  generateImages,
  fetchImage,
  completeDeck,
  isRealPage,
  missingPages,
  thicken,
  IMAGE_KINDS,
  TONES,
  THEMES,
  LANGS,
  KINDS,
  MIN_PAGES,
  MAX_PAGES,
}
