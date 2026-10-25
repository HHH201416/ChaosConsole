/**
 * AIPPT few-shot 策略对照（一次性排查脚本）
 *
 * 背景：1.5B 拿到带具体数字的 few-shot 后，会把示例里的
 * 「24 小时 / 58% / 3.5 天 / 76%」原样抄进新主题，且内容跟着跑偏。
 * 这里对比三种示例策略，看哪种既不跑题、又能保住格式。
 *
 * 用法：node scripts/probe-fewshot.js [model]
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

const SPEC = `输出格式（一行一条，不要 JSON，不要解释，不要代码块）：

T|整份标题|副标题
01|封面主标题
B|要点页标题
- 一条要点，14-24 字，必须含具体名词、数字或动作
- 一条要点
- 一条要点
S|数据页标题
82%|指标名称
3.5x|指标名称
C|对比页标题
- 左栏观点|- 右栏观点
- 左栏观点|- 右栏观点
- 左栏观点|- 右栏观点
Q|金句页标题
一句 20-38 字的判断，不加横线
E|结尾页标题
- 一句明确的行动号召

页头代号：01 封面、B 要点、S 数据、C 对比、Q 金句、E 结尾。
除 T 行外，每页先写页头行（代号|标题），再写内容行。`

/* 变体 1：无示例 */
const V1 = `${SPEC}

现在写《{topic}》的 {n} 页内容：
第 1 页用 01，最后 1 页用 E，中间至少一次 S 和一次 C。
每条要点必须带具体名词、数字或动作；禁止空话。`

/* 变体 2：抽象占位示例（无可抄内容） */
const V2 = `${SPEC}

示例（只演示格式，方括号是要替换的占位内容，禁止把这些词句写进正文）：
T|[整份标题]|[副标题]
01|[一句有主张的封面句]
B|[要点页标题]
- [一条含具体数字的事实]
- [一条含具体名词的事实]
- [一条含具体动作的事实]
S|[数据页标题]
[数值]|[指标名]
[数值]|[指标名]
C|[对比页标题]
- [旧做法的特征]|- [新做法的特征]
- [旧做法的特征]|- [新做法的特征]
- [旧做法的特征]|- [新做法的特征]
Q|[一句判断]
E|[结尾标题]
- [一句行动号召]

现在按同样格式写《{topic}》的 {n} 页内容：
第 1 页用 01，最后 1 页用 E，中间至少一次 S 和一次 C。
内容必须完全围绕《{topic}》，不得复用示例中的任何词句。禁止空话。`

/* 变体 3：极简 2 页示例 + 强禁止 */
const V3 = `${SPEC}

格式示例（只示范写法，内容属于另一个主题，禁止抄用）：
T|一个小镇如何把垃圾分类率做到 90%|三个月的社区实验
01|第一周，只有 12% 的家庭分对了
S|三个月后的数字
90%|分类准确率
4.2|人均日投放次数

现在按同样格式写《{topic}》的 {n} 页内容：
第 1 页用 01，最后 1 页用 E，中间至少一次 S 和一次 C。
要求：全部内容围绕《{topic}》，每条要点带具体名词、数字或动作；
禁止抄用示例里的任何数字、句子或比喻；禁止「随着」「不断」「意义重大」这类空话。`

const VARIANTS = [
  ['V1 无示例', V1],
  ['V2 占位符示例', V2],
  ['V3 他域示例+强禁止', V3],
]

const FILLER = ['随着', '不断', '意义重大', '至关重要', '众所周知', '总的来说', '综上']
// 示例里的特征词 —— 出现在输出里就说明抄了
const LEAK_WORDS = ['垃圾分类', '小镇', '90%', '4.2', '社区实验', '占位', '[']

function audit(text) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const pages = lines.filter((l) => /^(01|[1-9]|B|S|C|Q|E)\|/.test(l))
  const points = lines.filter((l) => l.startsWith('- '))
  const leaks = LEAK_WORDS.filter((w) => text.includes(w))
  const filler = FILLER.filter((w) => text.includes(w))
  const dupes = points.length - new Set(points).size
  // 关键词覆盖率：主题里的词有没有出现
  const topicHit = /agent|智能体|落地|企业/i.test(text)
  return { pages: pages.length, points: points.length, leaks, filler, dupes, topicHit }
}

async function main() {
  const model = process.argv[2] || 'qwen2.5:1.5b'
  const topic = '企业级 AI Agent 落地实践'
  const n = 6

  console.log(`\n=== 模型 ${model} · 主题《${topic}》· ${n} 页 ===\n`)

  for (const [label, tpl] of VARIANTS) {
    const prompt = tpl.replace(/\{topic\}/g, topic).replace(/\{n\}/g, String(n))
    try {
      const r = await chat({
        model,
        options: { num_ctx: 8192, temperature: 0.4, num_predict: 1100, top_p: 0.9, repeat_penalty: 1.05 },
        messages: [
          { role: 'system', content: '你只按给定格式输出，不加任何解释。' },
          { role: 'user', content: prompt },
        ],
      })
      const a = audit(r.text)
      console.log(`[${label}]  ${(r.ms / 1000).toFixed(1)}s / ${r.evalCount} tok / ${r.tps.toFixed(1)} tok/s`)
      console.log(`  页数=${a.pages} 要点=${a.points} 抄袭=${JSON.stringify(a.leaks)} 空话=${JSON.stringify(a.filler)} 对题=${a.topicHit}`)
      console.log('  ' + r.text.trim().split('\n').join('\n  '))
      console.log('')
    } catch (e) {
      console.log(`[${label}] 失败: ${e.message}\n`)
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
