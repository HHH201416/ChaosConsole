/**
 * AIPPT 端到端验证脚本
 *
 * 跑一次真实生成（SSE 流式），输出分阶段耗时、解析结果、页型分布、
 * 配图来源与成品 pptx 校验。用来量化「快不快、有没有质量」。
 *
 * 用法：node scripts/e2e-aippt.js [topic] [pages] [speed] [withImages]
 *   例：node scripts/e2e-aippt.js "企业级 AI Agent 落地实践" 6 auto true
 */
const fs = require('fs')
const path = require('path')

const BASE = process.env.CHAOS_BASE || 'http://127.0.0.1:43210'
const TOPIC = process.argv[2] || '企业级 AI Agent 落地实践'
const PAGES = Number(process.argv[3] || 6)
const SPEED = process.argv[4] || 'auto'
const WITH_IMAGES = (process.argv[5] ?? 'true') !== 'false'
const IMAGE_SOURCE = process.argv[6] || 'auto'

async function api(p, opts = {}) {
  const res = await fetch(BASE + p, opts)
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch (_) {
    return { raw: text }
  }
}

async function main() {
  /* ---- 登录 + 确保绑了手机号（额度闸门） ---- */
  const login = await api('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  const TOK = login.token
  if (!TOK) throw new Error('登录失败：' + JSON.stringify(login).slice(0, 200))
  const H = { 'Content-Type': 'application/json', 'x-chaos-token': TOK }

  const before = await api('/api/chaos/status', { headers: H })
  if (!before.data?.phone) {
    const bind = await api('/api/chaos/phone', {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ phone: '13800002222' }),
    })
    console.log('绑定手机号:', bind.ok ? '成功' : '失败 ' + JSON.stringify(bind).slice(0, 120))
  }

  console.log(`\n=== 生成：${TOPIC} / ${PAGES} 页 / speed=${SPEED} / 配图=${WITH_IMAGES} ===\n`)

  /* ---- 跑流式生成 ---- */
  const t0 = Date.now()
  const res = await fetch(BASE + '/api/aippt/stream', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      topic: TOPIC,
      pages: PAGES,
      theme: 'emerald',
      language: 'zh',
      withToc: true,
      withImages: WITH_IMAGES,
      speed: SPEED,
      imageSource: IMAGE_SOURCE,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)

  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const events = []
  const phaseAt = {}
  let done = null
  let err = null

  while (true) {
    const { done: end, value } = await reader.read()
    if (end) break
    buf += dec.decode(value, { stream: true })
    let i
    while ((i = buf.indexOf('\n\n')) !== -1) {
      const frame = buf.slice(0, i)
      buf = buf.slice(i + 2)
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue
        let ev
        try {
          ev = JSON.parse(line.slice(5).trim())
        } catch (_) {
          continue
        }
        events.push(ev)
        if (ev.type === 'phase') {
          phaseAt[ev.phase] = Date.now() - t0
          console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 阶段 ${ev.phase}：${ev.label || ''}`)
        }
        if (ev.type === 'model') {
          console.log(`        档位=${ev.mode} 策划=${ev.planModel} 正文=${ev.outlineModel} GPU=${ev.gpu}`)
        }
        if (ev.type === 'progress' && !ev.pending) {
          console.log(`        配图 ${ev.done}/${ev.total} ${ev.source || ''} ${ev.name || ''}`)
        }
        if (ev.type === 'notice') {
          console.log(`        提示：${ev.field || ''} ${ev.reason || ''}`)
        }
        if (ev.type === 'done') done = ev.result
        if (ev.type === 'error') err = ev.error
      }
    }
  }

  const totalMs = Date.now() - t0
  console.log(`\n总耗时: ${(totalMs / 1000).toFixed(1)}s`)

  if (err) {
    console.log('生成失败:', err)
    process.exit(1)
  }
  if (!done) {
    console.log('没有收到 done 事件')
    process.exit(1)
  }

  /* ---- 分阶段耗时 ---- */
  const marks = Object.entries(phaseAt).sort((a, b) => a[1] - b[1])
  console.log('\n--- 分阶段 ---')
  let prev = 0
  for (const [ph, at] of marks) {
    console.log(`  ${ph.padEnd(8)} ${((at - prev) / 1000).toFixed(1)}s  (累计 ${(at / 1000).toFixed(1)}s)`)
    prev = at
  }
  console.log(`  ${'渲染后'.padEnd(9)} ${((totalMs - prev) / 1000).toFixed(1)}s`)

  /* ---- 配图分布 ---- */
  const imgEv = events.filter((e) => e.type === 'progress' && !e.pending && e.name)
  const deckSlides = (done.outline || {}).slides || []
  const withImg = deckSlides.map((s, i) => ({ i, name: s.imageName })).filter((x) => x.name)
  console.log('\n--- 配图 ---')
  console.log(`  实际配图: ${done.images} 张 / 页数 ${done.pages}`)
  withImg.forEach((x) => console.log(`  第 ${x.i + 1} 页  ${x.name}`))
  const srcKinds = {}
  imgEv.forEach((e) => {
    srcKinds[e.source || '?'] = (srcKinds[e.source || '?'] || 0) + 1
  })
  console.log(`  来源: ${JSON.stringify(srcKinds)}`)

  /* ---- 大纲质量检查 ---- */
  const o = done.outline || {}
  const slides = o.slides || []
  console.log('\n--- 大纲 ---')
  console.log(`标题：${o.title}`)
  console.log(`副标题：${o.subtitle || '(无)'}`)
  const kinds = {}
  slides.forEach((s, i) => {
    kinds[s.kind] = (kinds[s.kind] || 0) + 1
    const body = (s.body || []).join(' / ')
    const stats = (s.stats || []).map((x) => `${x.v}=${x.l}`).join(' , ')
    const extra = (s.extra || []).length ? ` | 右栏 ${s.extra.length} 条` : ''
    console.log(`  ${i + 1}. [${s.kind}] ${s.title || '(无标题)'}`)
    if (body) console.log(`      ${body}`)
    if (stats) console.log(`      数据：${stats}`)
    if (extra) console.log(`      ${extra}`)
  })
  console.log(`页型分布: ${JSON.stringify(kinds)}`)

  /* ---- 质量硬指标 ---- */
  const FILLER = ['随着', '不断', '意义重大', '至关重要', '众所周知', '提高效率', '重要意义']
  // 「顾客」「门店」这类词任何行业都会用，只留真正只属于咖啡示例的说法
  /* 9.9.0：「备料」「店员」对餐饮主题是正常用词，删掉避免误报；
     留下的是示例稿里更专属的表达 */
  const LEAK = ['咖啡', '出杯', '动线', '取料']
  const DESC = ['要点页标题', '数据页标题', '对比页标题', '金句页标题', '结尾页标题', '一、', '二、']
  // 占位页 / 模型开场白混进正文：都是「看着有字、其实没内容」
  const STUB = ['本页内容待补充', '这一页可以补充', '补充要点', '好的，以下是', '以下是关于']
  const flat = JSON.stringify(slides)
  const filler = FILLER.filter((w) => flat.includes(w))
  const leak = LEAK.filter((w) => flat.includes(w))
  const desc = DESC.filter((w) => flat.includes(w))
  const stub = STUB.filter((w) => flat.includes(w))
  const pointCounts = slides.filter((s) => s.kind === 'bullets').map((s) => (s.body || []).length)
  const emptyPages = slides.filter((s) => !s.title && !(s.body || []).length).length
  const dupPoints = (() => {
    const all = slides.flatMap((s) => s.body || [])
    return all.length - new Set(all).size
  })()

  console.log('\n--- 质量指标 ---')
  console.log(`  空话词: ${filler.length ? JSON.stringify(filler) : '无'}`)
  console.log(`  示例抄袭: ${leak.length ? JSON.stringify(leak) : '无'}`)
  console.log(`  描述词残留: ${desc.length ? JSON.stringify(desc) : '无'}`)
  console.log(`  占位/开场白: ${stub.length ? JSON.stringify(stub) : '无'}`)
  console.log(`  要点页条数: ${JSON.stringify(pointCounts)}`)
  console.log(`  重复要点: ${dupPoints}`)
  console.log(`  空页: ${emptyPages}`)
  console.log(`  超长要点(>30字): ${slides.flatMap((s) => s.body || []).filter((x) => x.length > 30).length}`)

  /* ---- 成品文件 ---- */
  console.log('\n--- 成品 ---')
  console.log(`  文件: ${done.file}`)
  console.log(`  页数: ${done.pages} / 配图: ${done.images} / tokens: ${done.tokens} / 档位: ${done.mode} (${done.model})`)
  if (done.file && fs.existsSync(done.file)) {
    const st = fs.statSync(done.file)
    console.log(`  大小: ${(st.size / 1024).toFixed(0)} KB`)
    console.log('  注：pptx 内嵌资源需要解压核对，见单独脚本')
  }

  /* ---- 最终判定 ---- */
  const problems = []
  /* 9.9.0：时长阈值按页数与配图放宽 —— CPU 推理 8 页 + 双图本来就要 3 分钟多，
     硬卡 180s 会把「慢但完整」误判成失败 */
  const timeLimit = PAGES >= 8 ? 300000 : 180000
  if (totalMs > timeLimit) problems.push(`总耗时 ${(totalMs / 1000).toFixed(0)}s 超过 ${timeLimit / 1000}s`)
  /* 9.9.0：允许到 75% 页数 —— 空页兜底宁可删页也不注水，删掉占位页是
     有意设计；75% 以下才说明补页真的失败了 */
  if (slides.length < Math.ceil(PAGES * 0.75))
    problems.push(`页数不足（${slides.length}/${PAGES}）`)
  if (filler.length) problems.push('出现空话词')
  if (leak.length) problems.push('抄了示例内容')
  if (desc.length) problems.push('页头是描述词')
  if (stub.length) problems.push('出现占位页或模型开场白')
  if (emptyPages) problems.push('存在空页')
  if (pointCounts.some((c) => c > 0 && c < 2)) problems.push('要点页不足 2 条')

  console.log('\n=== 判定 ===')
  if (problems.length) {
    problems.forEach((p) => console.log('  ✗ ' + p))
    process.exitCode = 2
  } else {
    console.log('  ✓ 全部通过')
  }
  console.log('')
}

main().catch((e) => {
  console.error('ERROR', e)
  process.exit(1)
})
