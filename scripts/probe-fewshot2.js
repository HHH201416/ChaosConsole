/**
 * AIPPT few-shot 策略 v2：完整真实示例（他域）
 *
 * v1 的结论：
 *  - 无示例 → 格式崩，页码混进标题
 *  - 占位符 [xxx] → 模型直接把方括号照抄进正文
 *  - 他域示例但页标题写成「要点页标题」→ 模型把描述词当标题抄
 *
 * v2 的思路：示例必须是**另一个领域里真实完整的 6 页稿子**，每个页标题
 * 都是真实标题。模型模仿真实标题 → 产出真实标题；模仿描述词 → 产出描述词。
 *
 * 用法：node scripts/probe-fewshot2.js [model]
 */
const OLLAMA = 'http://127.0.0.1:11434'

async function chat({ model, messages, options }) {
  const t0 = Date.now()
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, keep_alive: '30m', options }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const j = await res.json()
  return {
    text: String(j.message?.content || ''),
    evalCount: j.eval_count || 0,
    ms: Date.now() - t0,
    tps: j.eval_count ? j.eval_count / (j.eval_duration / 1e9) : 0,
  }
}

const SPEC = `格式（一行一条；代号：01 封面、B 要点、S 数据、C 对比、Q 金句、E 结尾）：
T|整份标题|副标题
01|封面那句主张
B|标题
- 要点
S|标题
数值|指标名
C|标题
- 左栏|- 右栏
Q|标题
E|标题
- 行动号召`

const EXAMPLE = `T|出杯 90 秒：一家咖啡连锁的效率重建|32 家门店的三个月实验
01|高峰期，每杯要等 4 分 12 秒
B|慢不在咖啡机，在动线
- 一名店员每小时往返取料 37 次，绕行 1.4 公里
- 62% 的等待发生在排队，而不是制作
- 峰值时段订单集中到 3 倍，人手却没变
S|改造三个月后的数字
-55%|高峰期等待时长
90s|平均出杯时间
C|旧动线 vs 新动线
- 取料与制作挤在同一区|- 备料前置，制作区不放原料
- 三台设备塞进 2 米内|- 设备按订单流顺序摆放
- 高峰期靠加人|- 高峰期靠分单与预判
Q|顾客记住的不是咖啡豆，是等了多久
E|从一家门店的动线开始
- 本周画一张店员走动图，标出最远的三个往返`

const RULES = `硬性要求：
1. 内容必须全部围绕《{topic}》，不得出现示例里的任何事物、数字或句子。
2. 每个页头必须是这个主题的真实、具体标题；禁止写「标题」「要点页标题」「对比页标题」这类描述词，禁止「一、」「二、」这类序号。
3. 每条要点带具体名词、数字或动作，14-26 字；禁止「随着…不断」「意义重大」「提高效率」「重要意义」这类空话。
4. 页数按上面要求的 {n} 页写，不要照搬示例的页数。
5. 正好 {n} 页，第 1 页 01，最后 1 页 E，中间至少一次 S 和一次 C。`

function audit(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const heads = lines.filter((l) => /^(01|[1-9]|B|S|C|Q|E)\|/.test(l))
  const points = lines.filter((l) => l.startsWith('- '))
  // 示例领域特征词
  const LEAK = ['咖啡', '门店', '出杯', '动线', '店员', '顾客', '90s', '55%', '4 分 12 秒', '1.4 公里']
  const leaks = LEAK.filter((w) => text.includes(w))
  // 描述词残留
  const PLACEHOLDER = ['要点页标题', '数据页标题', '对比页标题', '金句页标题', '结尾页标题', '标题|', '[', '一、', '二、']
  const placeholders = PLACEHOLDER.filter((w) => text.includes(w))
  const FILLER = ['随着', '不断', '意义重大', '至关重要', '众所周知']
  const filler = FILLER.filter((w) => text.includes(w))
  const dupes = points.length - new Set(points).size
  const topicHit = /agent|智能体|落地/i.test(text)
  return { heads: heads.length, points, leaks, placeholders, filler, dupes, topicHit, text }
}

async function main() {
  const model = process.argv[2] || 'qwen2.5:1.5b'
  const topic = '企业级 AI Agent 落地实践'
  const n = 6

  const prompt = `${SPEC}

示例（另一个主题的完整 6 页稿子，只用于示范写法）：
${EXAMPLE}

${RULES.replace(/\{topic\}/g, topic).replace(/\{n\}/g, String(n))}`

  console.log(`\n=== ${model} ·《${topic}》· ${n} 页 ===\n`)
  const r = await chat({
    model,
    options: { num_ctx: 8192, temperature: 0.45, num_predict: 1600, top_p: 0.9, repeat_penalty: 1.05 },
    messages: [
      { role: 'system', content: '你只按给定格式输出，不加任何解释。' },
      { role: 'user', content: prompt },
    ],
  })
  const a = audit(r.text)
  console.log(`${(r.ms / 1000).toFixed(1)}s / ${r.evalCount} tok / ${r.tps.toFixed(1)} tok/s`)
  console.log(`页头=${a.heads} 要点=${a.points.length} 抄袭=${JSON.stringify(a.leaks)} 描述词残留=${JSON.stringify(a.placeholders)} 空话=${JSON.stringify(a.filler)} 对题=${a.topicHit}`)
  console.log('---')
  console.log(a.text.trim())
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
