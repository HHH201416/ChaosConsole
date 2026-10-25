/**
 * Ollama 纯 CPU 参数调优（一次性排查脚本）
 *
 * 现状：i5-12400（6 核 12 线程）+ 无独显，7B 约 4 tok/s。
 * 影响 CPU 推理速度的三个参数：
 *   num_thread  —— 用几个线程（默认按物理核）
 *   num_ctx     —— 上下文窗口，越大 KV cache 越大、内存带宽压力越高
 *   num_batch   —— 批大小，影响 prefill
 *
 * 用法：node scripts/bench-ollama.js [model]
 */
const OLLAMA = 'http://127.0.0.1:11434'

const PROMPT =
  '你是一位演示文稿策划师。请写 5 行，每行不超过 30 字，说明「企业级 AI Agent 落地」的：' +
  '核心主张、听众关切、叙事主线、关键论据、结尾行动。'

async function once(model, options) {
  // 预热一次，排除模型加载时间
  await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], stream: false, options: { num_predict: 8 } }),
  })
  const t0 = Date.now()
  const res = await fetch(`${OLLAMA}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: PROMPT }],
      stream: false,
      keep_alive: '30m',
      options,
    }),
  })
  const j = await res.json()
  const gen = j.eval_duration / 1e9
  const pre = j.prompt_eval_duration / 1e9
  return {
    ms: Date.now() - t0,
    out: j.eval_count,
    gen,
    pre,
    tps: j.eval_count / gen,
    promptTok: j.prompt_eval_count,
  }
}

async function main() {
  const model = process.argv[2] || 'qwen2.5:7b'
  const cases = [
    ['默认（不传 options）', {}],
    ['num_thread=6', { num_thread: 6 }],
    ['num_thread=8', { num_thread: 8 }],
    ['num_thread=12', { num_thread: 12 }],
    ['num_ctx=2048', { num_ctx: 2048 }],
    ['num_ctx=4096', { num_ctx: 4096 }],
    ['num_ctx=8192', { num_ctx: 8192 }],
    ['num_ctx=4096 + thread=6', { num_ctx: 4096, num_thread: 6 }],
    ['num_ctx=4096 + thread=12', { num_ctx: 4096, num_thread: 12 }],
    ['num_ctx=4096 + batch=512', { num_ctx: 4096, num_batch: 512 }],
  ]

  console.log(`\n=== ${model} 参数调优 ===\n`)
  const rows = []
  for (const [label, options] of cases) {
    try {
      const r = await once(model, options)
      rows.push([label, r])
      console.log(
        `${label.padEnd(28)} 生成 ${r.gen.toFixed(1)}s / ${r.out} tok / ${r.tps.toFixed(2)} tok/s  (prefill ${r.pre.toFixed(1)}s)`,
      )
    } catch (e) {
      console.log(`${label.padEnd(28)} 失败: ${e.message}`)
    }
  }

  rows.sort((a, b) => b[1].tps - a[1].tps)
  console.log('\n--- 按速度排序 ---')
  rows.forEach(([l, r]) => console.log(`  ${r.tps.toFixed(2)} tok/s  ${l}`))
  console.log('')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
