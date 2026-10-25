/**
 * AIPPT 速度 / 质量对照实验（一次性排查脚本）
 *
 * 目的：在纯 CPU 环境下，验证「换小模型 + 修 num_ctx + 紧凑输出格式 + few-shot」
 * 能否把生成时间压到可接受范围，同时不牺牲内容质量。
 *
 * 用法：node scripts/probe-aippt.js [topic] [pages]
 */
const OLLAMA = 'http://127.0.0.1:11434'

async function chat({ model, messages, options, stream = false }) {
  const t0 = Date.now()
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream,
      keep_alive: '30m',
      options: options || undefined,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  return {
    text: String(j.message?.content || ''),
    evalCount: j.eval_count || 0,
    promptCount: j.prompt_eval_count || 0,
    ms: Date.now() - t0,
    tps: j.eval_count ? (j.eval_count / (j.eval_duration / 1e9)) : 0,
  }
}

/* ---------- 旧方案：当前线上的提示词（正文精简复刻） ---------- */
function oldPlan(topic, n) {
  return (
    `你是一位顶级演示文稿策划师。这次要做《${topic}》，共 ${n} 页。\n` +
    `语气：正式专业。\n` +
    `先别急着排版，先用中文把策划想清楚，200-320 字，分 5 点：\n` +
    `1）核心主张；2）听众关心什么；3）叙事主线；4）2-3 个具体论据；5）配图方向。\n` +
    `要求：直接给判断，不要客套话。`
  )
}

function oldOutline(topic, n, plan) {
  return (
    `这是你刚为《${topic}》写的策划思路：\n---\n${plan}\n---\n` +
    `现在把它落成 ${n} 页的逐页结构。只输出 JSON，不要任何解释、不要 markdown 代码块。\n` +
    `{"title":"整份PPT标题","subtitle":"一句话副标题","slides":[{"title":"本页标题","kicker":"01","kind":"cover","body":["..."],"extra":[],"stats":[],"note":"演讲备注","image":"配图描述"}]}\n` +
    `规则：\n- slides 长度必须正好是 ${n}；第 1 页 cover；最后 1 页 closing。\n` +
    `- kind 只能取 cover/bullets/twocol/stats/quote/closing。\n` +
    `- bullets：body 3-5 条，每条 14-26 字。\n- stats：stats 2-3 项。\n- note 30 字内。全部用中文。`
  )
}

/* ---------- 新方案：紧凑行式格式 + few-shot ---------- */
const FORMAT_SPEC = `输出格式（每行一条，不要 JSON，不要解释，不要代码块）：

T|整份标题|副标题
01|封面主标题
B|要点页标题
- 要点，14-24 字，含具体名词或数字
- 要点
- 要点
S|数据页标题
82%|效率提升
3.5x|交付速度
C|对比页标题
- 左栏观点|- 右栏观点
- 左栏观点|- 右栏观点
- 左栏观点|- 右栏观点
Q|金句页标题
一句 20-38 字的判断
E|结尾页标题
- 一句行动号召

页型代号：01=封面，B=要点，S=数据，C=对比，Q=金句，E=结尾。
除 T 行外，每页必须先写一行页头（页码|类型|标题），再写内容行。`

const FEWSHOT = `示例（4 页）：
T|让会议少一半，让决策快一倍|一家 SaaS 公司的异步协作改造
01|每周 21 小时，正在被会议吃掉
B|三个数字先说清现状
- 每位工程师每周开会 21 小时，占工时 52%
- 需求平均等待决策 3.2 天，卡在同步对齐上
- 78% 的会议没有书面结论，散会即遗忘
S|异步改造后的 90 天
-46%|会议时长下降
3.2→0.8|决策等待（天）
C|同步会议 vs 书面提案
- 全员到场才能开始|- 一人先写，其他人异步批注
- 结论靠记忆与口头复述|- 结论沉淀成可检索文档
- 时区与日程相互绑架|- 24 小时内闭环，不问时区
Q|会议不是协作，会议是同步成本
E|从下一个议题开始，先写一页纸
- 本周选一个高频会议，改成书面提案 + 24 小时批注`

/* ---------- 质量评估：空话、长度、结构 ---------- */
const FILLER = ['介绍', '概述', '意义重大', '重要组成部分', '众所周知', '随着', '不断', '方面', '进一步', '总的来说', '综上所述', '深入探讨']

function scoreOutline(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const pages = lines.filter((l) => /^(\d{1,2}|B|S|C|Q|E)\|/.test(l))
  const points = lines.filter((l) => l.startsWith('- '))
  const fillerHits = FILLER.filter((w) => text.includes(w))
  const shortPoints = points.filter((p) => p.replace(/^-\s*/, '').length < 12)
  const dupes = points.length - new Set(points).size
  return {
    pages: pages.length,
    points: points.length,
    filler: fillerHits,
    shortPoints: shortPoints.length,
    dupes,
    avgPointLen: points.length ? Math.round(points.reduce((s, p) => s + p.length, 0) / points.length) : 0,
  }
}

async function main() {
  const topic = process.argv[2] || '企业级 AI Agent 落地实践'
  const n = Number(process.argv[3] || 6)

  console.log(`\n=== 主题：${topic} / ${n} 页 ===\n`)

  /* --- A. 旧路径：7B + 默认上下文 + 旧提示词 --- */
  console.log('[A] 旧路径  qwen2.5:7b · num_ctx 默认(2048) · 旧提示词')
  let a1, a2
  try {
    a1 = await chat({
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: oldPlan(topic, n) }],
    })
    console.log(`    策划: ${a1.ms}ms / ${a1.evalCount} tok / ${a1.tps.toFixed(1)} tok/s`)
    a2 = await chat({
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: oldOutline(topic, n, a1.text) }],
    })
    console.log(`    大纲: ${a2.ms}ms / ${a2.evalCount} tok / ${a2.tps.toFixed(1)} tok/s / prompt=${a2.promptCount}`)
    console.log(`    合计: ${((a1.ms + a2.ms) / 1000).toFixed(1)}s`)
    const j = (() => { try { return JSON.parse(a2.text.replace(/```json|```/g, '').trim()) } catch (_) { return null } })()
    console.log(`    JSON 可解析: ${j ? '是' : '否'} / slides=${j?.slides?.length ?? '-'}`)
  } catch (e) {
    console.log('    失败:', e.message)
  }

  /* --- B. 新路径：1.5B + num_ctx 8192 + 紧凑格式 + few-shot --- */
  console.log('\n[B] 新路径  qwen2.5:1.5b · num_ctx 8192 · temp 0.4 · 紧凑格式 + few-shot')
  let b1, b2, bTotal = 0
  try {
    const t1 = Date.now()
    b1 = await chat({
      model: 'qwen2.5:1.5b',
      options: { num_ctx: 8192, temperature: 0.7, num_predict: 400 },
      messages: [
        { role: 'system', content: '你是资深演示策划，回答直接、有判断力，不说空话。' },
        { role: 'user', content: `主题：《${topic}》，共 ${n} 页，正式专业语气。\n先用 5 条短句写策划：核心主张 / 听众关切 / 叙事主线 / 关键论据 / 结论。每条不超过 40 字。` },
      ],
    })
    console.log(`    策划: ${b1.ms}ms / ${b1.evalCount} tok / ${b1.tps.toFixed(1)} tok/s`)
    console.log('    --- 策划内容 ---')
    console.log('    ' + b1.text.trim().split('\n').join('\n    '))

    b2 = await chat({
      model: 'qwen2.5:1.5b',
      options: { num_ctx: 8192, temperature: 0.4, num_predict: 1200, top_p: 0.9, repeat_penalty: 1.08 },
      messages: [
        { role: 'system', content: '你只按给定格式输出，不加任何解释。' },
        {
          role: 'user',
          content: `为《${topic}》写 ${n} 页 PPT 内容。

${FORMAT_SPEC}

${FEWSHOT}

现在按同样格式写《${topic}》，正好 ${n} 页：第 1 页 01（封面），最后 1 页 E（结尾），中间用 B/S/C/Q 组成叙事线，至少出现一次 S 和一次 C。
要求：每条要点必须含具体名词、数字或动作，禁止「介绍/概述/意义重大/随着/不断」这类空话。`,
        },
      ],
    })
    bTotal = b1.ms + b2.ms
    console.log(`    大纲: ${b2.ms}ms / ${b2.evalCount} tok / ${b2.tps.toFixed(1)} tok/s / prompt=${b2.promptCount}`)
    console.log(`    合计: ${(bTotal / 1000).toFixed(1)}s`)
    console.log('    --- 大纲 ---')
    console.log('    ' + b2.text.trim().split('\n').join('\n    '))
    const sc = scoreOutline(b2.text)
    console.log('    --- 评估 ---')
    console.log('    ' + JSON.stringify(sc))
  } catch (e) {
    console.log('    失败:', e.message)
  }

  /* --- 汇总 --- */
  console.log('\n=== 汇总 ===')
  if (a1 && a2) console.log(`A 旧路径 7B  : ${((a1.ms + a2.ms) / 1000).toFixed(1)}s`)
  if (bTotal) console.log(`B 新路径 1.5B: ${(bTotal / 1000).toFixed(1)}s`)
  if (a1 && a2 && bTotal) console.log(`提速: ${((a1.ms + a2.ms) / bTotal).toFixed(1)}x`)
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
