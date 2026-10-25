/**
 * AIPPT few-shot 策略 v3：加强 S/C/E 的格式约束 + 双模型对比
 *
 * v2 已经解决「抄袭」和「描述词残留」，但 1.5B 仍然写错两类页型：
 *  - S 页写成「- 预测准确率从 70% 到 95%」，而不是「95%|准确率」
 *  - C 页只写左栏，缺 | 分隔
 * v3 用「正例 + 反例」直接点名这两种错误，然后对比 1.5B / 7B 的上限。
 *
 * 用法：node scripts/probe-fewshot3.js
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
1. 内容全部围绕《{topic}》，不得出现示例里的任何事物、数字或句子。
2. 每个页头必须是这个主题的真实具体标题；禁止「标题」「要点页标题」这类描述词，禁止「一、」「二、」序号。
3. B 页至少 3 条要点；每条 14-26 字，带具体名词、数字或动作；禁止「随着…不断」「意义重大」「提高效率」这类空话。
4. S 页【最容易写错】：只写「数值|指标名」，数值在前、竖线分隔、不要 - 开头。正确：-46%|等待时长。错误：- 等待时长从 120 秒降到 65 秒。
5. C 页【最容易写错】：每一行必须左右两栏用 | 隔开，共 3 行。正确：- 旧做法|- 新做法。错误：只写左栏。
6. E 页必须写 1 条具体行动号召。
7. 正好 {n} 页，第 1 页 01，最后 1 页 E，中间至少一次 S 和一次 C。`

function audit(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const heads = lines.filter((l) => /^(01|[1-9]|B|S|C|Q|E)\|/.test(l))
  const points = lines.filter((l) => l.startsWith('- '))
  const LEAK = ['咖啡', '门店', '出杯', '动线', '店员', '顾客', '90s', '55%', '4 分 12 秒']
  const leaks = LEAK.filter((w) => text.includes(w))
  const PLACEHOLDER = ['要点页标题', '数据页标题', '对比页标题', '金句页标题', '结尾页标题', '[', '一、', '二、']
  const placeholders = PLACEHOLDER.filter((w) => text.includes(w))
  const FILLER = ['随着', '不断', '意义重大', '至关重要', '众所周知', '提高效率']
  const filler = FILLER.filter((w) => text.includes(w))

  // 页型格式检查
  let sOk = false
  let cOk = false
  let bCount = 0
  let eCall = false
  let cur = ''
  for (const l of lines) {
    const h = l.match(/^(01|[1-9]|B|S|C|Q|E)\|/)
    if (h) {
      cur = h[1]
      continue
    }
    if (cur === 'S' && /^[^|]+\|[^|]+$/.test(l) && /\d/.test(l)) sOk = true
    if (cur === 'C' && /\|/.test(l)) cOk = true
    if (cur === 'B' && l.startsWith('- ')) bCount++
    if (cur === 'E' && l.startsWith('- ')) eCall = true
  }
  return { heads: heads.length, sOk, cOk, bCount, eCall, leaks, placeholders, filler, text }
}

function score(a) {
  let s = 0
  if (a.heads >= 6) s += 25
  if (a.sOk) s += 20
  if (a.cOk) s += 20
  if (a.bCount >= 3) s += 15
  if (a.eCall) s += 10
  if (!a.leaks.length) s += 5
  if (!a.placeholders.length) s += 5
  return s
}

async function run(model) {
  const topic = '企业级 AI Agent 落地实践'
  const n = 6
  const prompt = `${SPEC}

示例（另一个主题的完整 6 页稿子，只用于示范写法）：
${EXAMPLE}

${RULES.replace(/\{topic\}/g, topic).replace(/\{n\}/g, String(n))}`

  const r = await chat({
    model,
    options: { num_ctx: 8192, temperature: 0.45, num_predict: 1600, top_p: 0.9, repeat_penalty: 1.05 },
    messages: [
      { role: 'system', content: '你只按给定格式输出，不加任何解释。' },
      { role: 'user', content: prompt },
    ],
  })
  const a = audit(r.text)
  console.log(`\n########## ${model}  ${(r.ms / 1000).toFixed(1)}s / ${r.evalCount} tok / ${r.tps.toFixed(1)} tok/s  得分 ${score(a)}/100`)
  console.log(`页头=${a.heads} S对=${a.sOk} C对=${a.cOk} B条数=${a.bCount} E号召=${a.eCall}`)
  console.log(`抄袭=${JSON.stringify(a.leaks)} 描述词=${JSON.stringify(a.placeholders)} 空话=${JSON.stringify(a.filler)}`)
  console.log('---')
  console.log(a.text.trim())
  return { ms: r.ms, score: score(a) }
}

async function main() {
  const models = process.argv[2] ? [process.argv[2]] : ['qwen2.5:1.5b', 'qwen2.5:7b']
  const out = []
  for (const m of models) {
    try {
      out.push([m, await run(m)])
    } catch (e) {
      console.log(`\n########## ${m} 失败: ${e.message}`)
    }
  }
  console.log('\n=== 汇总 ===')
  out.forEach(([m, r]) => console.log(`${m.padEnd(16)} ${(r.ms / 1000).toFixed(1)}s  得分 ${r.score}/100`))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
