/**
 * 策划思路该不该喂给正文？
 *
 * 现象：单独测（不带 plan）7B 得 100 分，线上跑（带 1.5B 写的 plan）质量明显下滑
 * —— 封面变成一整句长标题，S 页标题串入「数值|指标名」。
 *
 * 怀疑：1.5B 写的策划本身信息量薄，7B 照着它写，反而被拉低到小模型的水平。
 *
 * 用法：node scripts/probe-plan.js [model]
 */
const path = require('path')
const aippt = require(path.join(__dirname, '..', 'server', 'aippt.js'))

const OLLAMA = 'http://127.0.0.1:11434'
const TOPIC = '企业级 AI Agent 落地实践'
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

const FILLER = ['随着', '不断', '意义重大', '至关重要', '众所周知', '提高效率', '赋能', '抓手']
const LEAK = ['咖啡', '门店', '出杯', '动线', '店员', '顾客']
const DESC = ['要点页标题', '数据页标题', '对比页标题', '金句页标题', '结尾页标题', '数值|指标名', '一、']

function score(text) {
  const slides = aippt.normalizeOutline(aippt.parseCompactOutline(text, { topic: TOPIC, n: N }) || {}, { topic: TOPIC, n: N }).slides
  const flat = JSON.stringify(slides)
  const filler = FILLER.filter((w) => flat.includes(w))
  const leak = LEAK.filter((w) => flat.includes(w))
  const desc = DESC.filter((w) => flat.includes(w))
  const bullets = slides.filter((s) => s.kind === 'bullets')
  const minPoints = bullets.length ? Math.min(...bullets.map((s) => (s.body || []).length)) : 0
  const coverLen = (slides[0]?.title || '').length
  const hasStats = slides.some((s) => s.kind === 'stats')
  const hasTwo = slides.some((s) => s.kind === 'twocol')
  const emptyPages = slides.filter((s) => !s.title && !(s.body || []).length).length

  let sc = 0
  if (slides.length >= N) sc += 20
  if (!filler.length) sc += 15
  if (!leak.length) sc += 15
  if (!desc.length) sc += 15
  if (minPoints >= 3) sc += 15
  if (coverLen > 0 && coverLen <= 22) sc += 10
  if (hasStats) sc += 5
  if (hasTwo) sc += 5
  if (!emptyPages) sc += 5
  return { sc, slides, filler, leak, desc, minPoints, coverLen, hasStats, hasTwo, emptyPages }
}

async function main() {
  const model = process.argv[2] || 'qwen2.5:7b'

  // 用 1.5B 写一份真实的 plan（线上就是这么干的）
  const pr = await chat({
    model: 'qwen2.5:1.5b',
    options: { num_ctx: 8192, temperature: 0.7, top_p: 0.9, num_predict: 420 },
    messages: [{ role: 'user', content: aippt.planPrompt({ topic: TOPIC, n: N, toneDesc: '正式、专业', audience: '', lang: 'zh' }) }],
  })
  const plan = pr.text.trim()
  console.log('\n=== 1.5B 写的策划 ===')
  console.log(plan)

  const CASES = [
    ['A 带 plan（线上现状）', plan],
    ['B 不带 plan', ''],
    ['C 带 plan + 弱化提示', plan],
  ]

  console.log(`\n=== 正文模型 ${model} ===\n`)
  const rows = []
  for (const [label, p] of CASES) {
    let prompt = aippt.outlinePrompt({
      topic: TOPIC,
      n: N,
      toneDesc: '正式、专业',
      audience: '',
      lang: 'zh',
      plan: p || '（无）',
    })
    if (label.startsWith('C')) {
      prompt = prompt.replace(
        '你的策划思路：',
        '下面只是一份粗略的方向备忘，仅供你把握重点，不要照搬它的措辞和句式，你要写出更好的：',
      )
    }
    if (label.startsWith('B')) {
      // 完全去掉策划段
      const i = prompt.indexOf('现在写《')
      prompt = prompt.slice(i)
    }
    const r = await chat({
      model,
      options: { num_ctx: 8192, temperature: 0.45, top_p: 0.9, repeat_penalty: 1.15, num_predict: Math.min(1400, 90 * N + 220) },
      messages: [
        { role: 'system', content: '你只按给定格式输出，不加任何解释。' },
        { role: 'user', content: prompt },
      ],
    })
    const s = score(r.text)
    rows.push([label, r, s])
    console.log(`[${label}] ${(r.ms / 1000).toFixed(1)}s / ${r.evalCount} tok / 得分 ${s.sc}/100`)
    console.log(
      `  页数=${s.slides.length} 空话=${JSON.stringify(s.filler)} 抄袭=${JSON.stringify(s.leak)} 描述词=${JSON.stringify(s.desc)}`,
    )
    console.log(`  最少要点=${s.minPoints} 封面标题长度=${s.coverLen} S页=${s.hasStats} C页=${s.hasTwo} 空页=${s.emptyPages}`)
    s.slides.forEach((x, i) => console.log(`    ${i + 1}. [${x.kind}] ${JSON.stringify(x.title)}`))
    console.log('')
  }

  console.log('=== 汇总 ===')
  rows.forEach(([l, r, s]) => console.log(`${(r.ms / 1000).toFixed(1)}s  ${String(s.sc).padStart(3)}/100  ${l}`))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
