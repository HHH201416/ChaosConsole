/* eslint-disable no-console */
/**
 * AIPPT 联网资料
 * ------------------------------------------------------------------
 * 为什么需要这个模块：
 *
 * 9.8.2 之前，AIPPT 的全部内容都来自本地 7B 模型自己的「常识」。结果是：
 *   · 封面写「掌握未来，从数据分析开始」——正确但空
 *   · 数据页写「降低库存积压 50%」——数字是编的，用户一眼能看出虚
 *   · 三条要点是一个意思换三种说法
 *
 * 这不是提示词能修好的问题。7B 没有行业数据，让它写具体案例只能靠编；
 * 编出来的数字比空话更危险（看着可信、其实不存在）。
 *
 * 所以改成：**先去网上找真实的、带数字的资料，模型只做挑选和改写**。
 * 模型的任务从「创作」退回到「编排」——这恰好是 7B 做得动的事。
 *
 * 网络现实（本机实测，2026-10）：
 *   ✅ cn.bing.com 搜索可用，一次返回 10 条带摘要的结果
 *   ✅ 163 / 搜狐 / 36氪 / 餐饮界 等正文页可直连抓取
 *   ❌ baike.baidu.com 403（反爬）
 *   ❌ duckduckgo / wikipedia / brave API 连接超时
 * 所以只走 Bing + 通用正文抓取，不依赖任何需要 Key 的服务。
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/* 搜索结果的编码：bing 中文站是 utf-8，但实体很多，统一解一遍 */
const ENTITIES = {
  '&ensp;': ' ',
  '&emsp;': ' ',
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&ldquo;': '“',
  '&rdquo;': '”',
}

function decodeEntities(s) {
  let out = String(s || '')
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v)
  // bing 的摘要里会有 &#0183; 这类数字实体
  out = out.replace(/&#(\d{2,5});/g, (_, d) => {
    const n = Number(d)
    return n > 31 && n < 65536 ? String.fromCharCode(n) : ' '
  })
  return out
}

function stripTags(html) {
  let s = String(html || '')
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ')
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ')
  s = s.replace(/<!--[\s\S]*?-->/g, ' ')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  s = s.replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
  s = s.replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s.replace(/[ \t\u00a0]+/g, ' ')
  s = s.replace(/\n{2,}/g, '\n')
  return s.trim()
}

/* 搜索引擎对免费抓取的容忍度很低：本机实测连续请求 10 次左右，
 * 360 和搜狗都会返回 302 拦截页，然后整段时间都搜不了。
 * 与其「搜得快然后全失败」，不如慢一点但每次都能拿到结果。 */
const SEARCH_GAP_MS = 2500
let lastSearchAt = 0

/* 被拦一次就冷却一段时间。
 * 没有这个机制时，被封期间每次生成都要白等 3 × 12 秒超时，
 * 用户看到的是「一直在搜集资料」，然后拿到一份没联网的稿子。
 * 冷却是为了让失败来得快一点。 */
const COOLDOWN_MS = 10 * 60 * 1000
const cooldown = { so: 0, sogou: 0, bing: 0 }
const failStreak = { so: 0, sogou: 0, bing: 0 }
const cooling = (k) => Date.now() < (cooldown[k] || 0)
const setCool = (k) => {
  cooldown[k] = Date.now() + COOLDOWN_MS
}

async function searchThrottle() {
  const wait = SEARCH_GAP_MS - (Date.now() - lastSearchAt)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastSearchAt = Date.now()
}

async function httpGet(url, { timeoutMs = 12000, referer = '' } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': UA,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
        Accept: 'text/html,application/xhtml+xml',
        ...(referer ? { Referer: referer } : {}),
      },
    })
    const text = await res.text()
    return { ok: res.ok, status: res.status, text, url: res.url }
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err?.name === 'AbortError' ? 'timeout' : String(err?.message || err) }
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * 搜索
 * ------------------------------------------------------------------ */

/** 从主题里提炼检索用的核心词：「连锁餐饮如何用数据选品」→「连锁餐饮 数据选品」 */
function keywordsOf(topic) {
  let t = String(topic || '').trim()
  // 疑问句的壳对搜索引擎没用，反而拉低命中
  t = t.replace(/(如何|怎么|怎样|为什么|哪些|什么|浅谈|关于|浅析|探讨|研究|的分析|的思考)/g, ' ')
  // 单字虚词贴在词中间会把词切碎（「用数据选品」→「数据选品」）
  t = t.replace(/[用把对从在和与的之]+/g, ' ')
  t = t.replace(/[，。！？、；：""''（）()《》【】\[\]?!,.;:]/g, ' ')
  const parts = t
    .split(/\s+/)
    .map((x) => x.trim())
    .filter((x) => x.length >= 2)
  if (!parts.length) return [String(topic || '').slice(0, 20)]
  return parts
}

/**
 * 搜狗：中文长查询唯一能用的通道。
 *
 * 实测对比（2026-10，本机）：
 *   查询「连锁餐饮 数据选品 案例」
 *     搜狗 → 「从亏损到盈利：餐饮店用大数据选品月赚 8 万」
 *            「选品定生死！揭秘多家连锁餐企的选品攻略」   ← 完全对题
 *     Bing → 「连锁破坏 (FTB Ultimine) - MC百科」        ← 只按第一个词匹配
 *   Bing 对中文多词查询会退化成单关键词检索，同一个「餐饮」前缀的五个不同
 *   查询返回的是同一批结果，等于没有检索。所以主通道设成搜狗。
 */
/**
 * 360 搜索：主通道。
 *
 * 为什么是它（2026-10 实测，同一查询「连锁餐饮 数据选品 案例」）：
 *   360  → 「连锁餐饮数据选品案例」「烤鱼店、中餐连锁的后厨都开始换鱼了？
 *            餐饮选品逻辑一次说清」「地方连锁客户案例_零售餐饮数字化」  ← 全部对题
 *   搜狗 → 同样对题，但连续请求 3-4 次就返回 302 拦截页（IP 级限流）
 *   Bing → 「连锁破坏 (FTB Ultimine) - MC百科」，只按第一个词匹配
 * 所以 360 打头，搜狗接第二棒，Bing 只做最后兜底。
 */
async function searchSo(q, { limit = 10, timeoutMs = 12000 } = {}) {
  if (cooling('so')) return { ok: false, error: 'cooling', items: [] }
  await searchThrottle()
  const url = 'https://www.so.com/s?q=' + encodeURIComponent(q)
  const r = await httpGet(url, { timeoutMs })
  if (!r.ok) return { ok: false, error: r.error || `http-${r.status}`, items: [] }

  const items = []
  for (const raw of r.text.split(/<li class="res-list/).slice(1)) {
    const chunk = raw.slice(0, 8000)
    const h3 = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
    if (!h3) continue
    const title = stripTags(h3[1]).replace(/\s+/g, ' ').trim()
    if (!title || title.length < 6) continue
    // 「其他人还搜了」这类联想块不是搜索结果
    if (/^(其他人还搜了|相关搜索|大家都在搜)/.test(title)) continue
    const hrefRaw = (h3[1].match(/href="([^"]+)"/i) || [])[1] || ''
    const href = hrefRaw.startsWith('/') ? 'https://www.so.com' + hrefRaw : hrefRaw
    const p =
      chunk.match(/<p[^>]*class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i) ||
      chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    let snippet = p ? stripTags(p[1]).replace(/\s+/g, ' ').trim() : ''
    // 360 有时把摘要放在 div.summary
    if (!snippet) {
      const d = chunk.match(/<div[^>]*class="[^"]*(?:summary|res-comm-con)[^"]*"[^>]*>([\s\S]*?)<\/div>/i)
      if (d) snippet = stripTags(d[1]).replace(/\s+/g, ' ').trim()
    }
    items.push({ title, snippet: snippet.slice(0, 340), url: href })
    if (items.length >= limit) break
  }
  if (!items.length && ++failStreak.so >= 2) setCool('so')
  else if (items.length) failStreak.so = 0
  return { ok: items.length > 0, items, error: items.length ? '' : 'no-result' }
}

/** 搜狗：第二通道。质量好但会限流，所以放在 360 后面 */
async function searchSogou(q, { limit = 10, timeoutMs = 12000 } = {}) {
  if (cooling('sogou')) return { ok: false, error: 'cooling', items: [] }
  await searchThrottle()
  const url = 'https://www.sogou.com/web?query=' + encodeURIComponent(q)
  const r = await httpGet(url, { timeoutMs })
  if (!r.ok) return { ok: false, error: r.error || `http-${r.status}`, items: [] }

  const items = []
  for (const raw of r.text.split('<div class="vrwrap"').slice(1)) {
    const chunk = raw.slice(0, 9000)
    const h3 = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)
    if (!h3) continue
    const title = stripTags(h3[1])
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!title || title.length < 6) continue
    const hrefRaw = (h3[1].match(/href="([^"]+)"/i) || [])[1] || ''
    const href = hrefRaw.startsWith('/') ? 'https://www.sogou.com' + hrefRaw : hrefRaw
    // 摘要：h3 之后的纯文本就是，不依赖具体 class（搜狗改版频繁）
    const afterH3 = chunk.slice(chunk.indexOf('</h3>') + 5)
    let snippet = stripTags(afterH3).replace(/\s+/g, ' ').trim()
    // 砍掉尾部「来源 / 时间」这类噪音，只留前面一两百字
    snippet = snippet.slice(0, 320)
    items.push({ title, snippet, url: href })
    if (items.length >= limit) break
  }
  if (!items.length && ++failStreak.sogou >= 2) setCool('sogou')
  else if (items.length) failStreak.sogou = 0
  return { ok: items.length > 0, items, error: items.length ? '' : 'no-result' }
}

/** Bing：备用通道。只解析 <li class="b_algo">，广告位天然被排除 */
async function searchBing(q, { limit = 10, timeoutMs = 12000 } = {}) {
  if (cooling('bing')) return { ok: false, error: 'cooling', items: [] }
  await searchThrottle()
  const url = 'https://cn.bing.com/search?q=' + encodeURIComponent(q) + '&count=20&setlang=zh-CN'
  const r = await httpGet(url, { timeoutMs })
  if (!r.ok) return { ok: false, error: r.error || `http-${r.status}`, items: [] }
  const items = []
  for (const raw of r.text.split('<li class="b_algo"').slice(1)) {
    const chunk = raw.slice(0, 4000)
    const h2 = chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i)
    if (!h2) continue
    const title = stripTags(h2[1]).replace(/\s+/g, ' ').trim()
    if (!title) continue
    const href =
      (chunk.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"/i) || [])[1] ||
      (chunk.match(/<a[^>]+href="(https?:\/\/[^"]+)"/i) || [])[1] ||
      ''
    let snippet = ''
    const p = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
    if (p) snippet = stripTags(p[1])
    if (!snippet) {
      const cap = chunk.match(/class="b_caption"[^>]*>([\s\S]*?)<\/div>/i)
      if (cap) snippet = stripTags(cap[1])
    }
    snippet = snippet.replace(/\s+/g, ' ').trim()
    items.push({ title, snippet, url: href })
    if (items.length >= limit) break
  }
  if (!items.length && ++failStreak.bing >= 2) setCool('bing')
  else if (items.length) failStreak.bing = 0
  return { ok: items.length > 0, items, error: items.length ? '' : 'no-result' }
}

/**
 * 搜索退化的识别。
 *
 * Bing 对中文多词查询会退化成「只按第一个词搜」：搜「连锁餐饮 数据选品」
 * 会返回「连锁破坏 (FTB Ultimine) - MC百科」「连锁（汉语词语）_百度百科」。
 * 这些结果都含「连锁」，用关键词判断会全部放行 —— 一旦喂给模型，
 * 页面上就会出现「连锁餐饮数据选品数据案例」这种搜索标题。
 *
 * 判据：结果里命中「最后一个关键词」的比例太低，说明检索根本没生效。
 */
function isDegraded(items, topic) {
  const keys = keywordsOf(topic)
  if (keys.length < 2 || !items.length) return false
  const k = keys[keys.length - 1]
  const frags = []
  for (let i = 0; i + 2 <= k.length; i++) frags.push(k.slice(i, i + 2))
  const hit = items.filter((it) => {
    const blob = `${it.title} ${it.snippet}`
    return frags.some((f) => blob.includes(f))
  }).length
  return hit / items.length < 0.34
}

/** 一眼就知道和主题无关的结果 */
const JUNK_RESULT = /(FTB|Minecraft|MC百科|汉语词语|词典|_百度百科|百度知道|维基百科|小说|游戏攻略|破解版|招聘|代购|优惠券)/

/**
 * 相关性过滤：搜狗偶尔会掺进来不相关的结果（词典释义、维基条目）。
 * 一条结果至少要命中一个主题词，否则它对做 PPT 没有价值。
 */
function relevant(items, topic) {
  const keys = keywordsOf(topic)
    .flatMap((k) => (k.length > 4 ? [k, k.slice(0, 2), k.slice(-2)] : [k]))
    .filter((k) => k.length >= 2)
  if (!keys.length) return items
  const keep = items.filter((it) => {
    const blob = `${it.title} ${it.snippet}`
    if (JUNK_RESULT.test(it.title)) return false
    return keys.some((k) => blob.includes(k))
  })
  // 过滤太狠就退回原样 —— 宁可给几条不相关的，也别让整个流程没素材
  return keep.length >= 3 ? keep : items
}

/** 搜一次：360 为主，搜狗接力，Bing 兜底。逐级降级，保证总能拿到点东西 */
async function search(q, { limit = 10, timeoutMs = 12000, topic = '' } = {}) {
  let items = []
  const so = await searchSo(q, { limit, timeoutMs })
  if (so.items.length) items = so.items

  if (items.length < 4) {
    const sg = await searchSogou(q, { limit, timeoutMs })
    if (sg.items.length) items = items.concat(sg.items)
  }
  if (items.length < 2) {
    const bg = await searchBing(q, { limit, timeoutMs })
    if (bg.items.length) items = items.concat(bg.items)
  }

  // 跨通道去重（标题前 16 字）
  const seen = new Set()
  items = items.filter((it) => {
    const k = it.title.replace(/\s+/g, '').slice(0, 16)
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })

  if (topic) {
    items = relevant(items, topic)
    // 退化的检索结果比没有结果更糟：模型会把垃圾标题当素材抄进页面
    if (isDegraded(items, topic)) return { ok: false, items: [], error: 'degraded' }
  }
  return { ok: items.length > 0, items, error: items.length ? '' : 'no-result' }
}

/* ------------------------------------------------------------------ *
 * 正文抓取
 * ------------------------------------------------------------------ */

/* 噪音句子。第二组是实测量出来的：抓 B 站页面时，「视频播放量 4888、弹幕量 0、
 * 点赞数 51」这种元数据会被当成「含数字的行业事实」混进来，比没有素材更糟 ——
 * 模型会把它写成「某品牌视频播放量达 4888」，一眼就是机器拼的。 */
const NOISE =
  /(登录|注册|下载APP|扫一扫|责任编辑|免责声明|版权|广告|举报|上一篇|下一篇|相关阅读|热门推荐|网友评论|分享到|关注我们|播放量|弹幕量|点赞数|投硬币|收藏人数|转发人数|阅读量|浏览量|粉丝数|评论数|月赚|轻松月入|暴利|日入|稳赚|(在用|使用|采用|部署|接入)\s*.{0,16}(方案|系统|平台|服务)[后，]?)/

/**
 * 抓一篇正文，返回纯文本（截断到 8000 字，够提取事实了）。
 *
 * 搜索引擎的链接几乎都是自己的跳转壳：
 *   · 360  → 返回 284 字节的 <script>window.location.replace("真实URL")</script>
 *   · 搜狗 → /link?url=... 也是类似的 JS 或 meta refresh 跳转
 * 所以要先认出「跳转壳」，把里面的真实地址掏出来再抓一次，否则拿到的是
 * 一个几百字节的空壳，正文提取永远失败。最多跟两跳，避免被绕进死循环。
 */
async function readPage(url, { timeoutMs = 12000, hop = 0 } = {}) {
  if (!/^https?:\/\//i.test(url || '')) return { ok: false, error: 'bad-url' }
  const r = await httpGet(url, { timeoutMs })
  if (!r.ok) return { ok: false, error: r.error || `http-${r.status}` }

  // 跳转壳：内容很短，且注明了目标地址
  if (r.text.length < 3000 && hop < 2) {
    const m =
      r.text.match(/location\.replace\(\s*["']([^"']+)["']/) ||
      r.text.match(/http-equiv="refresh"[^>]*content="\d+;\s*URL='?([^"'>]+)'?/i)
    if (m && m[1] && !m[1].startsWith(url)) {
      return readPage(m[1], { timeoutMs, hop: hop + 1 })
    }
  }

  const text = stripTags(r.text)
  if (text.length < 200) return { ok: false, error: 'too-short' }
  return { ok: true, text: text.slice(0, 8000), url: r.url || url }
}

/* ------------------------------------------------------------------ *
 * 从文本里挑「能上页面的事实」
 * ------------------------------------------------------------------ */

/**
 * 数字是一份 PPT 可信度的骨架。这里只认真正有信息量的句子：
 *   有百分数 / 倍数 / 金额 / 时间跨度，并且长度在 12-70 字之间
 * 太短的（「增长了 30%」）没主语，太长的（整段）塞不进页面。
 */
const NUM_RE = /(\d+(?:\.\d+)?\s*(?:%|％|倍|万|亿|千|百|元|美元|天|周|个月|年|小时|分钟|秒|人次|家|款|个))|(\d{3,})/

/**
 * 切句。
 *
 * 两级切分：先按句末标点切，剩下还太长的再按逗号切。
 * 为什么不能直接按逗号切：中文摘要里「通过 A，B，C」这种并列会被切成碎片，
 * 每片都缺主语；但完全不切又会得到一整段 120 字的「句子」，什么也提取不了。
 *
 * 半角句点要绕开小数点（3.5% 不能被切开），用前后都不是数字来判定。
 */
function splitSentences(text) {
  const punc = /[。！？；!?;\n]|(?<!\d)\.(?!\d)/
  const out = []
  for (const raw of String(text || '').split(punc)) {
    const s = raw.replace(/^[\s\-–—*·•\d.、)）]+/, '').trim()
    if (!s) continue
    if (s.length <= 72) {
      out.push(s)
      continue
    }
    // 太长：按逗号拆，两段拼一次，控制在 40-70 字
    const bits = s.split(/[，,]/).map((x) => x.trim()).filter(Boolean)
    let buf = ''
    for (const b of bits) {
      if (buf.length + b.length > 70 && buf) {
        out.push(buf)
        buf = b
      } else {
        buf = buf ? `${buf}，${b}` : b
      }
    }
    if (buf) out.push(buf)
  }
  return out
}

/** 章节标题、报告导语、广告文案 —— 看着有字，放到页面上就是废话 */
const HEADINGISH =
  /^(第?[一二三四五六七八九十\d]+[、.）)]|第[一二三四五六七八九十]+[章节部分])|^(核心|关键|要点|总结|目录|前言|结语|附录)[一二三四五六七八九十\d]*[：:]|^(本报告|本文|本文将|接下来|下面|综上)|(颠覆认知|一文读懂|深度好文|建议收藏|必看|干货)/


/**
 * 和主题沾不沾边，打个分。
 *
 * 不能用「包含任一 2 字片段」这种宽松判断 —— 「数据选品」拆出「数据」之后，
 * 一句「数据显示 2025 年……」就会被当成相关素材混进来，最后落成
 * 「用数据说话很重要」这种空话。
 *
 * 也不能要求完整命中 —— 那句话本身讲的就是「餐饮选品逻辑」，
 * 只因为没连着写出「连锁餐饮」四个字就被丢掉，会漏掉最有用的素材。
 *
 * 所以按 2 字片段计分，满 2 分算相关。实测这条线刚好能把
 * 「餐饮+选品」放进来、把「数据+年份」挡在外面。
 */
function topicScore(s, keys) {
  let score = 0
  for (const k of keys) {
    if (s.includes(k)) {
      score += 3
      continue
    }
    // 2 字滑窗，每个命中 +1
    for (let i = 0; i + 2 <= k.length; i++) {
      if (s.includes(k.slice(i, i + 2))) score += 1
    }
  }
  return score
}

function factsFromText(text, { topic = '', max = 8 } = {}) {
  const keys = keywordsOf(topic).filter((k) => k.length >= 2)
  const seen = new Set()
  const out = []
  for (const s of splitSentences(text)) {
    if (s.length < 14 || s.length > 72) continue
    if (NOISE.test(s)) continue
    if (HEADINGISH.test(s)) continue
    if (!NUM_RE.test(s)) continue
    /* 通告腔 / 截断句：「现将有关事项通知如下」「分析了…及未来发展趋势，现将…」
     * —— 这是页面的过渡句或被截断的摘要，不是能上 PPT 的事实 */
    if (/现将|如下|以下是|为此|（[一二三四五]）|[一二三四五]、/.test(s)) continue
    if (/[…]{1,2}$/.test(s)) continue
    // 尾字是虚词/截断动词的句子（「…在使用虾果智能跳转方案后」切在半截）
    if (/[了示出及和与将在的之把被后着过]$/.test(s)) continue
    // 至少有半个主题词，否则可能是页面上的无关数字（浏览量、发布时间）
    if (keys.length && topicScore(s, keys) < 2) continue
    // 纯日期、纯浏览量这类噪音
    if (/^\d{4}年\d{1,2}月\d{1,2}日/.test(s)) continue
    // 「10 个关键数据」这种：数字修饰的是篇幅，不是事实
    if (/^\d+\s*(个|条|种|大)(关键|核心|重要)?(数据|方法|技巧|要点|误区)/.test(s)) continue
    // 去重前先抹掉空白：Bing 的高亮会把「实际应用数据」断成「实际应用 数据」，
    // 同一个句子因此被当成两条不同的素材收进来
    const fp = s.replace(/[\d.%％\s]/g, '').slice(0, 14)
    if (seen.has(fp)) continue
    seen.add(fp)
    out.push(s)
    if (out.length >= max) break
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 编排：一次研究 = 多角度检索 + 摘要提取 + 正文补充
 * ------------------------------------------------------------------ */

/** 同一天同一主题不重复搜（一次生成里被调用两次的概率不高，但重试时会） */
const cache = new Map()
const CACHE_TTL = 6 * 60 * 60 * 1000

/**
 * 按主题做一轮资料检索。
 *
 * 返回 { ok, facts: [{ text, from }], sources: [{ title, url }], note }
 * facts 里每条都是「带数字的、和主题相关的」原句 —— 模型拿到它之后
 * 只需要改写措辞，不需要再编数字。
 */
async function research(topic, { lang = 'zh', onNote = null, timeoutMs = 14000 } = {}) {
  const clean = String(topic || '').trim()
  if (!clean) return { ok: false, facts: [], sources: [], note: 'empty-topic' }
  if (lang === 'en') return { ok: false, facts: [], sources: [], note: 'en-skip' }

  const ck = clean.toLowerCase()
  const hit = cache.get(ck)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data

  const kw = keywordsOf(clean)
  const base = kw.join(' ')
  /* 三个角度分开搜：量化现状 / 具体做法 / 直接问原题。
   * 经验：把角度并进一个长查询会让搜狗 overweight 第一个短语，
   * 分开发、再合并去重，拿到的数字密度明显更高。 */
  const queries = [`${base} 数据 案例`, `${base} 怎么做 方法`, clean]

  /* 串行而不是并行。
   * 并行只要 1.5 秒，但三发齐出会立刻触发限流，后面整段都搜不到东西；
   * 串行有节流，单次 8 秒左右，拿到 8 条就提前收手。
   * 生成全程要 90 秒，这 8 秒不算贵，搜不到才是真的贵。 */
  const allItems = []
  for (const q of queries) {
    /* 凑够 8 条就收手：请求越少，被搜索引擎反爬盯上的概率越低 ——
     * 实测连续抓 3 轮就会吃 antispider 拦截页，整轮检索报废。 */
    if (allItems.length >= 8) break
    const r = await search(q, { limit: 8, timeoutMs, topic: clean }).catch(() => ({ ok: false, items: [] }))
    if (r.ok) allItems.push(...r.items)
  }

  const seenTitle = new Set()
  const items = allItems.filter((it) => {
    const k = it.title.slice(0, 18)
    if (seenTitle.has(k)) return false
    seenTitle.add(k)
    return true
  })

  if (!items.length) {
    if (onNote) onNote('search-empty')
    return { ok: false, facts: [], angles: [], sources: [], note: 'search-empty' }
  }

  /* 话题锚点：搜索结果标题就是「这个行业真实在关心什么」的免费样本。
   * 模型光看这些标题，就不会把「县域文旅」写成「拥抱数字化未来」——
   * 因为标题里写的是「从亏损到盈利」「选品定生死」「后厨开始换鱼」。
   * 这比数字更管用：数字决定可信度，锚点决定「说的是不是这一行的事」。 */
  /* 文档站后缀：搜索结果里混着大量「XX案例分析.docx-原创力文档」这种
   * 文档站下载页标题，直接当锚点给模型，它就会原样抄到页面上。 */
  const DOC_SITE =
    /(原创力文档|道客巴巴|豆丁网?|百度文库|360doc|帮考网|doc88|book118|爱问|文库|文档之家|word版|ppt版|\.(docx?|pdf|pptx?|xlsx?|txt)\b)/i
  /* 标题党：搜索热词里的「月赚8万」这种，当方向锚点会把整份稿子带偏 */
  const CLICKBAIT = /(月赚|日入|稳赚|暴利|轻松月入|躺赚|一手货源|招代理|加盟费)/
  const angles = []
  const seenAngle = new Set()
  for (const it of items) {
    let t = String(it.title || '')
      .replace(/\s*[-_|—]\s*(今日头条|网易订阅|搜狐|知乎|新浪财经|百家号|360文库|腾讯新闻).*$/, '')
      .replace(/[_|].*$/, '')
      .replace(/\.(docx?|pdf|pptx?|xlsx?|txt)\b/gi, '')
      .replace(/\s*[-—]\s*(原创力文档|道客巴巴|豆丁网?|百度文库|360doc|帮考网|文档|资料下载?).*/i, '')
      .replace(/^\d+\s*[-–]\s*/, '')
      .replace(/\s+/g, '')
      .trim()
    if (t.length < 8 || t.length > 34) continue
    if (/^(其他人还搜了|相关搜索|大家都在搜|360文库)/.test(t)) continue
    if (/文库|模板|下载|招聘|官网$/.test(t)) continue
    if (DOC_SITE.test(t)) continue
    if (CLICKBAIT.test(t)) continue
    const k = t.slice(0, 10)
    if (seenAngle.has(k)) continue
    seenAngle.add(k)
    angles.push(t)
    if (angles.length >= 8) break
  }

  // 摘要里就有大量数字，先吃这一层（快、稳）
  const facts = []
  const sources = []
  const fromSnippet = new Set()
  for (const it of items) {
    sources.push({ title: it.title, url: it.url })
    for (const f of factsFromText(it.snippet, { topic: clean, max: 3 })) {
      const fp = f.replace(/[\d.%％\s]/g, '').slice(0, 14)
      if (fromSnippet.has(fp)) continue
      fromSnippet.add(fp)
      facts.push({ text: f, from: it.title })
    }
  }

  /* 摘要层通常只有定性描述（「某咖啡连锁品牌在门店安装客流统计设备」）——
   * 中文搜索的摘要几乎不带数字，光靠它抽不出可用素材。
   * 所以正文一定要抓，而且并行抓：4 篇串行最坏 48 秒，并行只等最慢那篇。 */
  /* 正文抓取要挑站点 —— 实测（2026-10）：
   *   ✅ 163 / 新浪 / 凤凰 / 界面 / 钛媒体 / 创业邦 / 餐饮界 → 直出正文
   *   ❌ 今日头条 / 知乎 / 百度百科 → 验证页或 JS 空壳，抓了也是白抓
   * 先抓能抓的，抓不满再补其它，别把时间浪费在注定失败的地方。 */
  const GOOD_HOST =
    /(163\.com|sohu\.com|sina\.com|ifeng\.com|jiemian\.com|tmtpost\.com|cyzone\.cn|canyin88\.com|thepaper\.cn|guancha\.cn|xinhuanet\.com|people\.com\.cn|ce\.cn|stcn\.com|yicai\.com|21jingji\.com|huxiu\.com)/i
  const BAD_HOST = /(toutiao\.com|zhihu\.com|baike\.baidu|zhidao\.baidu|weibo\.com|douyin|xiaohongshu|bilibili|docin|doc88|wenku|360doc)/i

  const cands = items
    .filter((it) => /^https?:\/\//i.test(it.url))
    .filter((it) => !BAD_HOST.test(it.url))
    .map((it) => ({ it, score: GOOD_HOST.test(it.url) ? 2 : 1 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.it)

  const pages = await Promise.all(
    cands.map((it) => readPage(it.url, { timeoutMs }).catch(() => ({ ok: false }))),
  )

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i]
    if (!page || !page.ok) continue
    for (const f of factsFromText(page.text, { topic: clean, max: 5 })) {
      const fp = f.replace(/[\d.%％\s]/g, '').slice(0, 14)
      if (fromSnippet.has(fp)) continue
      fromSnippet.add(fp)
      facts.push({ text: f, from: cands[i].title })
    }
  }

  /* 锚点只在有真实数字支撑时才一起给。
   * 实测：没有数字、只有一堆搜索标题时，7B 会把标题当素材照抄，
   * 页面上直接出现「连锁餐饮数据选品数据案例」。没有数字就说明这轮检索
   * 没拿到干货，锚点也就不可信，宁可只当背景不给模型。 */
  const data = {
    ok: facts.length > 0,
    facts: facts.slice(0, 14),
    angles: facts.length >= 2 ? angles : [],
    sources: sources.slice(0, 8),
    note: facts.length ? '' : 'no-number',
  }
  cache.set(ck, { at: Date.now(), data })
  if (onNote && !data.ok) onNote('no-number')
  return data
}

/**
 * 拼成给模型的「事实清单」。
 *
 * 这里刻意加了「数字必须来自清单」的强约束 —— 本地小模型很容易
 * 把清单里的数字挪到别的指标上（把「人力成本降 12%」写成「库存降 12%」），
 * 提示词里点名禁止，后面 qualityGate 还会再查一遍。
 */
/**
 * 拼成给模型的素材。
 *
 * 两个刻意的设计（都是踩坑换来的）：
 *  1. 话题锚点压成一行、每条截到 14 字。之前按列表给，7B 会整条照抄，
 *     页面上出现「连锁餐饮数据选品数据案例」这种搜索标题。
 *     压成一行 + 明确写「只是方向」，它才会当背景知识用。
 *  2. 数字事实才用列表，并标注「可以改写」。
 */
function factsPrompt(res, { lang = 'zh' } = {}) {
  if (!res || !res.facts?.length) return ''
  /* 锚点标题（angles）刻意不给模型 —— 三轮实测它都会被整句抄上页面，
   * 「不要抄」的叮嘱管不住 7B。方向感由主题本身提供，素材只留数字事实。 */
  if (lang === 'en') {
    return `Real facts:\n- ${res.facts.map((f) => f.text).join('\n- ')}`
  }
  const parts = []
  parts.push(
    `真实数据（可以改写措辞后使用）：\n` + res.facts.map((f, i) => `${i + 1}. ${f.text}`).join('\n'),
  )
  parts.push('清单之外的数字一律不要写，也不要编造公司名和人名。不要照抄任何来源标题。')
  return parts.join('\n\n')
}

function clearCache() {
  cache.clear()
}

module.exports = {
  research,
  factsPrompt,
  search,
  searchSo,
  searchSogou,
  searchBing,
  readPage,
  factsFromText,
  keywordsOf,
  relevant,
  isDegraded,
  clearCache,
}
