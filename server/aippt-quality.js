/* eslint-disable no-console */
/**
 * AIPPT 质量闸门
 * ------------------------------------------------------------------
 * 本地 7B 出来的稿子有固定的六种毛病，改提示词只能压住一部分，
 * 剩下的必须在「生成完之后」用规则兜住：
 *
 *   1. 页头是兜底词 —— 两页都叫「核心要点」，用户一眼看出是模板
 *   2. 页头是名词短语 —— 「选品的重要性」，正文只能堆并列句
 *   3. 素材被原样搬进页面 —— 出现「连锁餐饮数据选品数据案例」这种搜索标题
 *   4. 双栏缺一侧 —— 版式直接塌，右边一片空白
 *   5. 三条要点句式雷同 —— 全是「提升了 X%」
 *   6. 空话 —— 未来、赋能、新篇章、拥抱变化
 *
 * 处理策略分两级：
 *   能规则修的（1/3/4）就地修，不花时间；
 *   修不了的（2/5/6）标成 rewrite，交给上层用快模型单页回炉。
 * 一页回炉只要 8-15 秒，比整份重写便宜得多，也比留着一页垃圾强。
 */

/** 这些页头等于「没写标题」 */
const FILLER_TITLE = /^(核心要点|关键指标|两种做法对比|下一步|结尾|开头|要点|重点|内容页?|补充内容|正文|主要内容和|相关分析)$/

/** 空话词：出现在标题里且没有具体名词，基本就是套话 */
const FILLER_WORDS = [
  '未来',
  '新篇章',
  '新征程',
  '赋能',
  '抓手',
  '闭环',
  '生态',
  '拥抱',
  '引领',
  '助力',
  '护航',
  '深度融合',
  '高质量发展',
  '全面提升',
  '持续优化',
  '重要意义',
  '价值所在',
  '开启',
  '答案',
]

/** 「提升了 X%」这类句式的判定 —— 三条都用这个就是模板 */
const PERCENT_CLAIM = /(提升|提高|增长|降低|减少|节省|优化|增加|下降|缩短).{0,6}(\d+(\.\d+)?\s*(%|％|倍))/

/** 大写的占位 / 元叙述，不该出现在页面上 */
const META = /(本页|这一页|待补充|以下内容|如上所述|综上所述)/

/** 字符二元组集合，用来算相似度 */
function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]/gu, '')
  const set = new Set()
  for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2))
  return set
}

/** 0-1，越接近 1 越像。素材抄袭判定用 */
function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / Math.min(A.size, B.size)
}

/** 标题里有没有"具体的东西"：数字、英文、或者一个够长的名词 */
function hasConcrete(s) {
  // 只认数字和英文。「掌握未来，从数据分析开始」也有 13 个字，但一个字都不具体，
  // 之前用长度当判据，结果所有套话都从这道门溜过去了。
  return /[\d]|[A-Za-z]{2,}/.test(s)
}

/** 搜索结果的标题腔：要点写成这样就说明是抄来的，不是自己想明白的 */
const HEADLINEISH = /(案例|评测|参考|攻略|揭秘|盘点|深度|必看|干货|一文读懂|体系搭建|优秀案例|实操指南|落地指南|研究报告)/

/** 文档站下载页标题：带文件扩展名或文档站名，说明整行是照抄搜索结果 */
const SOURCE_TITLE =
  /(\.(docx?|pdf|pptx?|xlsx?|txt)\b|原创力文档|道客巴巴|豆丁网?|百度文库|360doc|帮考网|doc88|book118|(^|\s)\d{1,2}\s*[-–—]\s*[A-Za-z]{2,})/i

/** 标题党素材行：「月赚8万」「日入过千」这种只会让整份稿子掉价 */
const CLICKBAIT = /(月赚|日入|稳赚|暴利|轻松月入|躺赚|一手货源|招代理)/

/** 9.9.7：few-shot 示例主题词（咖啡店效率案例）——出现在用户稿子里就是抄示例 */
const FEWSHOT_LEAK = /(咖啡|出杯|动线|取料|备料|店员)/

/** 空话要点：没有数字、没有具体名词，只在讲「更有效 / 很重要」 */
const VAGUE_POINT = /^(数据|技术|方法|方式|手段|理念|策略|模式)?(驱动|导向|赋能)?(.{0,8}?)(更|非常|十分|尤为)?(重要|关键|必要|有效|显著|突出)$/

/** 明显不是人话的行：拼接痕迹、等号、重复词、截断句 */
function isBrokenLine(s) {
  const t = String(s || '')
  if (/[=＝]/.test(t) && !/\d\s*[=＝]\s*\d/.test(t)) return true
  if (/数据选品数据|分析分析|管理管理/.test(t)) return true
  /* 「数值|销售增长率 | - 提升10%」——模型把大纲格式标记当内容写了出来 */
  if (/^[A-Z]{1,2}\s*[|｜]/.test(t) || /^数值\s*[|｜]/.test(t)) return true
  if (/[|｜]\s*[-—－]\s*(提升|增长|降低|减少|达到?)/.test(t)) return true
  /* 提示词头部被当内容抄进来：「真实数据（可以改写措辞后使用）：」 */
  if (/^(真实数据|可(以)?改写|Field context|Real facts)/.test(t) && /[：:]$/.test(t)) return true
  /* 悬空的标签行（「分析要点：」后面没内容） */
  if (/[：:]$/.test(t) && t.length <= 24) return true
  /* 「分析了…及未来发展趋势，现将…」「某品牌在使用虾果智能跳」——
   * 截断句 / 通告腔，上页面就是病句 */
  if (/[…]{1,2}$/.test(t)) return true
  if (/[了示出及和与将在的之把被后着过]$/.test(t) && t.length >= 8) return true
  if (/现将|通知如下|以下是有关/.test(t)) return true
  return false
}

function isFillerTitle(t) {
  const s = String(t || '').trim()
  if (!s) return true
  if (FILLER_TITLE.test(s)) return true
  // 空话词打头 + 没有具体名词
  const hit = FILLER_WORDS.some((w) => s.includes(w))
  return hit && !hasConcrete(s)
}

/**
 * 从一页的内容里提炼一个能当页头的短语。
 *
 * 之前门槛是 8 字，结果「数据收集」这种 4-6 字的短要点被整页跳过，
 * 标题提炼失败 → 保留「核心要点」兜底词 → 用户看到两页同名。
 * 降到 5 字，并且最后兜一层「拿第一条硬切」。
 */
function titleFromBody(slide, topic) {
  const all = (slide.body || []).map((x) => String(x).trim()).filter(Boolean)
  const lines = all.filter((x) => x.length >= 5)
  const pick =
    lines.find((x) => !/^(数据|通过|利用|随着|在.{0,6}方面|例如|比如|某[^国确定])/.test(x)) ||
    lines[0] ||
    all[0] ||
    ''
  // 正文提炼不出来时，stat 标签就是现成的主题词（「企微会员沉淀量」）
  if (!pick) {
    const stat = (slide.stats || []).find((s) => String(s.l || '').length >= 4)
    return stat ? String(stat.l).slice(0, 18) : ''
  }
  let t = pick.split(/[，,。；;：:（(]/)[0].trim()
  if (t.length < 5) t = pick.slice(0, 18)
  if (t.length > 22) t = t.slice(0, 21) + '…'
  return t
}

/* ------------------------------------------------------------------ *
 * 单页检查
 * ------------------------------------------------------------------ */

/**
 * 查一页。返回问题列表，每条 { type, level, detail }
 *   level: 'fix' 能规则修，'rewrite' 要回炉
 */
function checkSlide(slide, ctx, index) {
  const { topic, research, prevTitles } = ctx
  const issues = []
  if (!slide) return issues
  const kind = slide.kind
  const title = String(slide.title || '').trim()
  const body = (slide.body || []).map((x) => String(x).trim()).filter(Boolean)
  const extra = (slide.extra || []).map((x) => String(x).trim()).filter(Boolean)
  const stats = slide.stats || []

  // 1) 页头是兜底词 / 空话 / 重复
  if (kind !== 'quote' && kind !== 'cover') {
    if (isFillerTitle(title)) issues.push({ type: 'filler-title', level: 'fix', detail: title })
    else if (prevTitles.includes(title)) issues.push({ type: 'dup-title', level: 'fix', detail: title })
  }
  if (kind === 'cover' && isFillerTitle(title)) {
    issues.push({ type: 'filler-title', level: 'rewrite', detail: title })
  }

  // 2) 页头是名词短语（没有判断结构）
  if (kind === 'bullets' || kind === 'twocol') {
    const looksLikeClaim =
      /[，,？?]/.test(title) ||
      /(不是|而是|越|才|就|都|让|把|取决|来自|说明|意味着|才是|未必|反而)/.test(title)
    if (title && !looksLikeClaim && !isFillerTitle(title)) {
      issues.push({ type: 'label-title', level: 'rewrite', detail: title })
    }
  }

  // 3) 要点层面的垃圾：照抄素材 / 搜索标题腔 / 拼接畸形的行 / 纯空话
  const pool = research
    ? [...(research.angles || []), ...(research.facts || []).map((f) => f.text)].filter(Boolean)
    : []
  for (const line of body) {
    if (SOURCE_TITLE.test(line) || CLICKBAIT.test(line)) {
      issues.push({ type: 'copied-material', level: 'fix', detail: line })
      continue
    }
    /* 9.9.7：「动线」「出杯」这些词只存在于 few-shot 示例（咖啡主题）里，
     * 用户主题是餐饮时出现就是照抄示例 —— 实测 1.5b 会整句搬。
     * 主题本身含这个词时不判（人家真的在讲咖啡）。 */
    const leakHit = FEWSHOT_LEAK.exec(line)
    if (leakHit && !topic.includes(leakHit[1])) {
      issues.push({ type: 'copied-material', level: 'fix', detail: line })
      continue
    }
    /* 「某连锁餐饮品牌在使用虾果智能跳转方案后」——营销软文的开头半句，
     * 没有数字就是没讲完的广告腔 */
    if (
      !/\d/.test(line) &&
      /^(某|一家|某个|某家).{0,12}(品牌|公司|企业|门店).{0,24}(在用|使用|采用|上线|部署|接入)/.test(line)
    ) {
      issues.push({ type: 'copied-material', level: 'fix', detail: line })
      continue
    }
    if (pool.length && pool.some((x) => similarity(line, x) > 0.72)) {
      issues.push({ type: 'copied-material', level: 'fix', detail: line })
      continue
    }
    if (isBrokenLine(line)) {
      issues.push({ type: 'broken-line', level: 'fix', detail: line })
      continue
    }
    // 「某连锁餐饮 SOP 优秀案例分享」——这是抄了搜索结果标题的骨架，
    // 放到页面上用户会觉得眼熟，因为它就是标题
    if (HEADLINEISH.test(line) && line.length >= 10 && !/\d/.test(line)) {
      issues.push({ type: 'headline-ish', level: 'fix', detail: line })
      continue
    }
    // 「餐饮创业如何用数据来选择品类？」——无数字的问句是搜索标题，
    // 不是要点。要点该是能站得住的陈述
    if (!/\d/.test(line) && /[?？]\s*$/.test(line) && line.length >= 10) {
      issues.push({ type: 'headline-ish', level: 'fix', detail: line })
      continue
    }
    // 「数据驱动而非直觉决策更有效」——一个数字都没有的判断等于没说
    if (!/\d/.test(line) && VAGUE_POINT.test(line)) {
      issues.push({ type: 'vague-point', level: 'fix', detail: line })
      continue
    }
    // 「非常之处在于细节打磨」——程度词打头、没有数字的短句是纯装饰，
    // 用户读到只会觉得模型在凑字数
    if (
      !/\d/.test(line) &&
      !/[A-Za-z]{2,}/.test(line) &&
      line.length <= 16 &&
      /^(非常|更加|更为|越来越|十分|特别|格外|尤为)/.test(line)
    ) {
      issues.push({ type: 'vague-point', level: 'fix', detail: line })
    }
  }

  // 4) 双栏缺一侧
  if (kind === 'twocol' && (body.length < 2 || extra.length < 2)) {
    issues.push({ type: 'twocol-gap', level: 'fix', detail: `${body.length}/${extra.length}` })
  }

  // 5) 三条要点句式雷同
  if (kind === 'bullets' && body.length >= 2) {
    const pct = body.filter((x) => PERCENT_CLAIM.test(x)).length
    if (pct >= 2 && pct === body.length) {
      issues.push({ type: 'same-shape', level: 'rewrite', detail: `${pct}/${body.length}` })
    }
    const heads = body.map((x) => x.slice(0, 3))
    if (heads.length >= 2 && new Set(heads).size === 1) {
      issues.push({ type: 'same-head', level: 'rewrite', detail: heads[0] })
    }
  }

  // 6) 元叙述混进正文
  if ([...body, ...extra].some((x) => META.test(x))) {
    issues.push({ type: 'meta-talk', level: 'fix', detail: '' })
  }

  // 7) 数据页只有一行（渲染会空）
  if (kind === 'stats' && stats.length < 2) {
    issues.push({ type: 'few-stats', level: 'rewrite', detail: String(stats.length) })
  }

  // 8) 结尾空话
  if (kind === 'closing') {
    const all = [...body, ...extra].join(' ')
    if (!all || all.length < 10 || FILLER_WORDS.some((w) => all.includes(w))) {
      issues.push({ type: 'empty-close', level: 'rewrite', detail: title })
    }
  }

  return issues.map((x) => ({ ...x, page: index }))
}

/* ------------------------------------------------------------------ *
 * 规则修复
 * ------------------------------------------------------------------ */

/** 模型会把提示词里的标签直接写进要点：「具体怎么做：xxx」 */
const LABEL_PREFIX =
  /^(具体怎么做|怎么做|做法|行动|结论|要点|原因|方法|建议|注意|风险|关键|左栏|右栏|左侧|右侧)[：:]\s*|^(例如|比如|譬如)[，,]\s*/

function stripLabel(line) {
  return String(line || '').replace(LABEL_PREFIX, '').trim()
}

function repairSlide(slide, issues) {
  const types = new Set(issues.map((x) => x.type))
  const demd = (s) => String(s || '').replace(/\*{2,}/g, '').trim()
  const out = {
    ...slide,
    // 「左栏: 数据驱动选品流程」——解析痕迹不能出现在页头或正文里
    title: stripLabel(demd(slide.title)),
    body: (slide.body || []).map((x) => stripLabel(demd(x))),
    extra: (slide.extra || []).map((x) => stripLabel(demd(x))),
  }

  /* 抄来的素材整条删掉 —— 它比空话更糟，用户能认出那是搜索标题。
   * 标题腔、拼接畸形、纯空话一并处理：这些都不是「改一个字」能救的，
   * 留着不如删掉，删到不够两条时上层会安排回炉。 */
  const dropTypes = new Set(['copied-material', 'headline-ish', 'broken-line', 'vague-point', 'dup-line'])
  const drop = new Set(issues.filter((x) => dropTypes.has(x.type)).map((x) => x.detail))
  if (drop.size) {
    out.body = out.body.filter((line) => !drop.has(line))
    /* 右栏也得一起清。只清正文时，双栏塌成要点页以后留下的那一条右栏会孤零零
     * 挂在 extra 里：bullets 只渲染 body，这一页成品就是「只有标题」的白页
     * （2026-10-29 e2e 实测：第 6 页 body 空、extra 只有「45,000」）。 */
    out.extra = out.extra.filter((line) => !drop.has(line))
  }

  // 元叙述删掉
  if (types.has('meta-talk')) {
    out.body = out.body.filter((x) => !META.test(x))
    out.extra = out.extra.filter((x) => !META.test(x))
  }

  /* 修完只剩右栏内容的要点页：右栏搬进正文，别让它在成品里变成白页。
   * 双栏/表格页的 extra 是真正的右列，不能搬。 */
  if (out.body.length === 0 && out.extra.length && !['twocol', 'compare'].includes(out.kind)) {
    out.body = out.extra.slice(0, 4)
    out.extra = []
  }

  // 双栏塌了：把两侧合成一页要点，版式至少是完整的
  if (types.has('twocol-gap')) {
    const merged = [...out.body, ...out.extra].filter(Boolean)
    if (merged.length >= 2) {
      out.kind = 'bullets'
      out.body = merged.slice(0, 3)
      out.extra = []
    }
  }

  // 金句页正文被清空时，页头本身就是那句金句 —— 让位给正文，别留白页
  if (out.kind === 'quote' && !out.body.length && out.title) {
    out.body = [out.title.slice(0, 60)]
    out.title = ''
  }

  return out
}

/**
 * 主入口。
 *
 * 返回 { deck, rewrite, report }
 *   deck    —— 修完的稿子
 *   rewrite —— 需要回炉的页 [{ index, why }]，上层决定要不要调模型
 *   report  —— 给日志和 e2e 用的问题清单
 */
function auditDeck(outline, { topic = '', research = null, canRefine = true } = {}) {
  const slides = Array.isArray(outline?.slides) ? outline.slides : []
  const report = { issues: [], fixed: 0, needRewrite: 0, score: 100 }
  const rewrite = []
  const prevTitles = []
  const prevLines = new Set()
  const next = []

  slides.forEach((slide, i) => {
    let issues = checkSlide(slide, { topic, research, prevTitles }, i)
    /* CPU 档跳过回炉时，名词短语页头（label-title）没有模型帮它重写，
       降级成「规则修」：直接从正文提炼一个像话的页头 */
    if (!canRefine) {
      issues = issues.map((x) => (x.type === 'label-title' ? { ...x, level: 'fix' } : x))
    }
    /* 跨页重复：「数据分析驱动的选品策略」在第 3 页讲完第 6 页又讲，
     * 小模型换个页头就敢把同一条要点再用一遍。这里标记给 repairSlide 删。 */
    for (const line of [...(slide.body || []), ...(slide.extra || [])]) {
      const k = String(line || '').replace(/[\s*＊]/g, '').slice(0, 14)
      if (k.length >= 6 && prevLines.has(k)) {
        issues.push({ type: 'dup-line', level: 'fix', detail: String(line).trim() })
      } else if (k.length >= 6) {
        prevLines.add(k)
      }
    }
    if (!issues.length) {
      if (slide?.title) prevTitles.push(String(slide.title).trim())
      next.push(slide)
      return
    }
    report.issues.push(...issues)

    // 先规则修
    let fixed = repairSlide(slide, issues)

    // 页头兜底词 / 重复 / CPU 档的名词短语头：用本页内容提炼一个
    const titleIssues = issues.filter(
      (x) => x.type === 'filler-title' || x.type === 'dup-title' || (x.type === 'label-title' && !canRefine),
    )
    let titleSalvaged = !titleIssues.length
    if (titleIssues.length) {
      const t = titleFromBody(fixed, topic)
      // 从垃圾内容里提炼出来的标题多半也是垃圾，这种情况宁可回炉
      if (t && !isFillerTitle(t) && !isBrokenLine(t) && !HEADLINEISH.test(t)) {
        fixed.title = t
        titleSalvaged = true
      }
    }

    const left = issues.filter((x) => x.level === 'rewrite')
    if (!titleSalvaged) left.push({ type: 'filler-title' })
    // 修完还不成样子（内容太少）也算回炉。
    // 10.0.1：章节过渡 / 图表 / 时间轴的「内容」在结构化字段里，不按 body 条数判空
    const STRUCT = new Set(['cover', 'closing', 'quote', 'section', 'chart', 'timeline', 'stats'])
    const thin = !STRUCT.has(fixed.kind) && (fixed.body || []).length < 2
    if (left.length || thin) {
      rewrite.push({
        index: i,
        why: [...new Set(left.map((x) => x.type).concat(thin ? ['thin'] : []))].join(','),
      })
      report.needRewrite += 1
    } else if (issues.length) {
      report.fixed += 1
    }

    if (fixed.title) prevTitles.push(String(fixed.title).trim())
    next.push(fixed)
  })

  // 打分：每类问题扣分，方便 e2e 和日志横向比较
  const penalty = {
    'filler-title': 8,
    'dup-title': 6,
    'label-title': 7,
    'copied-material': 8,
    'headline-ish': 7,
    'broken-line': 8,
    'vague-point': 5,
    'twocol-gap': 6,
    'same-shape': 5,
    'same-head': 5,
    'meta-talk': 3,
    'few-stats': 6,
    'empty-close': 5,
    thin: 6,
  }
  for (const it of report.issues) report.score -= penalty[it.type] || 3
  report.score = Math.max(0, Math.min(100, report.score))

  return { deck: { ...outline, slides: next }, rewrite, report, original: slides }
}

/**
 * 回炉提示词：只重写一页。
 *
 * 关键是把「为什么不合格」直接告诉模型 —— 实测同一页重写时，
 * 带上具体原因（「三条要点都是提升 X%」）比只说「写得更好」有效得多。
 */
function rewritePrompt({ slide, topic, research, why, peers = [], lang = 'zh' }) {
  const facts = (research?.facts || []).map((f) => f.text).slice(0, 6)
  const reasons = why.split(',').filter(Boolean)
  const hint = {
    'label-title': '页头现在是个名词短语，改成一句判断（例如「A 不是 B，是 C」）',
    'same-shape': '三条要点全是「提升了 X%」的句式，换成一条讲做法、一条讲哪里行不通',
    'same-head': '三条要点开头一样，换个说法',
    'filler-title': '页头现在是套话，换成这页真正在讲的事',
    'few-stats': '数据页只给了一个指标，至少给两个',
    'empty-close': '结尾太空，写成一件下周就能做的具体事',
    thin: '内容太少，至少写满两条要点',
  }
  const tips = reasons.map((r) => `· ${hint[r] || '内容不够具体'}`).join('\n')

  /* 10.0.1：结构化页型（图表 / 时间轴 / 表格 / 章节）不参与回炉重写 ——
   * 重写只能返回一行行文本，把图表数据写回成正文会直接丢结构。
   * 这些页的问题留给规则修或在编辑器里人工调整。 */
  const kindCode = {
    cover: '01',
    bullets: 'B',
    stats: 'S',
    twocol: 'C',
    quote: 'Q',
    closing: 'E',
    section: 'P',
    process: 'PS',
  }
  const code = kindCode[slide.kind] || 'B'
  const bodyLines = (slide.body || []).map((x) => `- ${x}`).join('\n')
  const extraLines = (slide.extra || []).map((x) => `- ${x}`).join('\n')

  if (lang === 'en') {
    return (
      `Rewrite one slide about "${topic}".\nProblems to fix:\n${tips}\n\n` +
      `Current version:\n${code}|${slide.title}\n${bodyLines}\n${extraLines}\n\n` +
      `Output only the replacement, same ${code}|... format, one line per item, no commentary.`
    )
  }
  /* 把同份稿子其他页的标题给它 —— 模型知道「前后在讲什么」才写得出不重复的内容。
   * 没有这个上下文时，它经常把这一页写成「数据分析很重要」这种和别页无关的话。 */
  const peerLines = peers.filter(Boolean).length ? `同一份 PPT 的其他页：${peers.filter(Boolean).join(' / ')}\n\n` : ''
  return (
    `重写《${topic}》里的一页。\n` +
    `这一页不合格，问题：\n${tips}\n\n` +
    peerLines +
    (facts.length ? `可以用这些真实数据：\n${facts.map((x) => `· ${x}`).join('\n')}\n\n` : '') +
    `现在的版本：\n${code}|${slide.title}\n${bodyLines}\n${extraLines}\n\n` +
    `只输出改写后的这一页，格式和现在一样（第一行 ${code}|页标题），不要解释。`
  )
}

module.exports = { auditDeck, checkSlide, repairSlide, rewritePrompt, similarity, titleFromBody, isFillerTitle }
