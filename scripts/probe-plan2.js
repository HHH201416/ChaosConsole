/**
 * 把「策划」从「定结构」改成「攒素材」
 *
 * 实测结论：让 1.5B 先写「主张/关切/主线/论据/行动」这 5 点，7B 会把这 5 点
 * 当成页面结构照搬 —— 页标题变成「核心主张」「行动号召」，数据页直接消失。
 *
 * 换法：策划只负责列出「6-8 条可落到页面上的硬信息」（数字、案例、对比），
 * 不碰页面结构。正文模型拿它当素材库，结构仍由格式规则决定。
 *
 * 用法：node scripts/probe-plan2.js
 */
const path = require('path')
const aippt = require(path.join(__dirname, '..', 'server', 'aippt.js'))

const OLLAMA = 'http://127.0.0.1:11434'
const TOPIC = process.argv[2] || '企业级 AI Agent 落地实践'
const N = 6

async function chat({ model, messages, options }) {
  const t0 = Date.now()
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, keep_alive: '30m', options }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  return { text: String(j.message?.content || ''), evalCount: j.eval_count || 0, ms: Date.now() - t0 }
}

function score(text) {
  const parsed = aippt.parseCompactOutline(text, { topic: TOPIC, n: N })
  if (!parsed) return { sc: 0, slides: [], note: '解析失败' }
  const slides = aippt.polishOutline(aippt.normalizeOutline(parsed, { topic: TOPIC, n: N })).slides
  const flat = JSON.stringify(slides)
  const FILLER = ['随着', '不断', '意义重大', '至关重要', '众所周知', '提高效率', '赋能', '抓手', '新纪元']
  const LEAK = ['咖啡', '门店', '出杯', '动线', '店员', '顾客']
  const DESC = ['要点页标题', '数据页标题', '对比页标题', '金句页标题', '结尾页标题', '数值|指标名', '一、', '核心主张', '行动号召']
  const filler = FILLER.filter((w) => flat.includes(w))
  const leak = LEAK.filter((w) => flat.includes(w))
  const desc = DESC.filter((w) => flat.includes(w))
  const bullets = slides.filter((s) => s.kind === 'bullets')
  const minPoints = bullets.length ? Math.min(...bullets.map((s) => (s.body || []).length)) : 0
  const coverLen = (slides[0]?.title || '').length
  const hasStats = slides.some((s) => s.kind === 'stats')
  const hasTwo = slides.some((s) => s.kind === 'twocol')
  const totalPoints = slides.reduce((a, s) => a + (s.body || []).length + (s.stats || []).length, 0)

  let sc = 0
  if (slides.length >= N) sc += 15
  if (!filler.length) sc += 15
  if (!leak.length) sc += 15
  if (!desc.length) sc += 20
  if (minPoints >= 2) sc += 10
  if (coverLen > 0 && coverLen <= 22) sc += 10
  if (hasStats) sc += 5
  if (hasTwo) sc += 5
  if (totalPoints >= N * 2) sc += 5
  return { sc, slides, filler, leak, desc, minPoints, coverLen, hasStats, hasTwo, totalPoints }
}

/* 素材型策划：只管列事实，不碰结构 */
const MATERIAL_PROMPT = `主题：《${TOPIC}》，要做一份 ${N} 页的演示。
先不要设计页面结构。请列出 6-8 条能直接放到页面上的具体信息，每条 20-30 字：
优先给数字、案例、前后对比、具体做法。可以给行业里常见的量级（比如「响应时间从小时级压到分钟级」）。
不要写「重要性」「意义」「趋势」「前景」这类判断，也不要写「首先/其次」。
直接列，一行一条，不要编号以外的解释。`

const MATERIAL_RULES = (plan) =>
  aippt
    .outlinePrompt({ topic: TOPIC, n: N, toneDesc: '正式、专业', audience: '', lang: 'zh', plan: '' })
    .replace('现在写《', `可用素材（挑合适的用，措辞要重写，不要照抄）：\n${plan}\n\n现在写《`)

async function main() {
  console.log(`\n=== ${TOPIC} / ${N} 页 ===\n`)

  const mr = await chat({
    model: 'qwen2.5:1.5b',
    options: { num_ctx: 8192, temperature: 0.7, top_p: 0.9, num_predict: 500 },
    messages: [{ role: 'user', content: MATERIAL_PROMPT }],
  })
  console.log(`[素材采集] ${(mr.ms / 1000).toFixed(1)}s / ${mr.evalCount} tok`)
  console.log(mr.text.trim())
  console.log('')

  const CASES = [
    ['D 素材型策划 + 7B', MATERIAL_RULES(mr.text.trim())],
    ['B 无策划 + 7B', aippt
      .outlinePrompt({ topic: TOPIC, n: N, toneDesc: '正式、专业', audience: '', lang: 'zh', plan: '' })
      .slice(aippt.outlinePrompt({ topic: TOPIC, n: N, toneDesc: '正式、专业', audience: '', lang: 'zh', plan: '' }).indexOf('现在写《'))],
  ]

  const rows = []
  for (const [label, prompt] of CASES) {
    const r = await chat({
      model: 'qwen2.5:7b',
      options: { num_ctx: 8192, temperature: 0.45, top_p: 0.9, repeat_penalty: 1.15, num_predict: Math.min(1400, 90 * N + 220) },
      messages: [
        { role: 'system', content: '你只按给定格式输出，不加任何解释。' },
        { role: 'user', content: prompt },
      ],
    })
    const s = score(r.text)
    const total = (r.ms + (label.startsWith('D') ? mr.ms : 0)) / 1000
    rows.push([label, r, s, total])
    console.log(`\n[${label}] 正文 ${(r.ms / 1000).toFixed(1)}s / ${r.evalCount} tok / 含策划共 ${total.toFixed(1)}s / 得分 ${s.sc}/100`)
    console.log(`  页数=${s.slides.length} 空话=${JSON.stringify(s.filler)} 描述词=${JSON.stringify(s.desc)} 抄袭=${JSON.stringify(s.leak)}`)
    console.log(`  最少要点=${s.minPoints} 总信息条数=${s.totalPoints} 封面长度=${s.coverLen} S页=${s.hasStats} C页=${s.hasTwo}`)
    s.slides.forEach((x, i) =>
      console.log(`    ${i + 1}. [${x.kind}] ${JSON.stringify(x.title)} :: ${JSON.stringify((x.body || []).slice(0, 2))} ${(x.stats || []).length ? JSON.stringify(x.stats) : ''}`),
    )
  }

  console.log('\n=== 汇总 ===')
  rows.forEach(([l, r, s, t]) => console.log(`${t.toFixed(1)}s  ${String(s.sc).padStart(3)}/100  ${l}`))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
