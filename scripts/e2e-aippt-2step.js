/**
 * AIPPT 10.0.1 两步流程端到端验证
 *
 * 验证的是**界面上真实走的那条链路**：
 *   ① POST /api/aippt/stream { outlineOnly:true }  → 只出大纲
 *   ② 像编辑器那样改大纲（换页型 / 加页 / 改标题 / 写备注 / 调页序）
 *   ③ POST /api/aippt/assemble { outline }         → 配图 + 渲染
 *   ④ 校验成品 ppxt：页数、图表对象、表格、演讲备注
 *
 * 用法：node scripts/e2e-aippt-2step.js [topic] [pages]
 *   CHAOS_BASE=http://127.0.0.1:43220 node scripts/e2e-aippt-2step.js "智慧校园能源管理" 8
 */
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const BASE = process.env.CHAOS_BASE || 'http://127.0.0.1:43220'
const TOPIC = process.argv[2] || '智慧校园能源管理方案'
const PAGES = Number(process.argv[3] || 8)
const PY = process.env.CHAOS_PY || 'C:/Users/Andy/.workbuddy/binaries/python/versions/3.13.12/python.exe'

const problems = []
const warns = []
const warn = (m) => problems.push(m)

async function j(p, opts = {}) {
  const r = await fetch(BASE + p, opts)
  const t = await r.text()
  try {
    return JSON.parse(t)
  } catch (_) {
    return { raw: t }
  }
}

/** 读 SSE 流，返回 { events, result, error, elapsed } */
async function sse(p, body, headers) {
  const t0 = Date.now()
  const res = await fetch(BASE + p, { method: 'POST', headers, body: JSON.stringify(body) })
  if (!res.ok || !res.body) return { error: `HTTP ${res.status}`, events: [] }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  const events = []
  let result = null
  let error = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    let cut
    while ((cut = buf.indexOf('\n\n')) !== -1) {
      const chunk = buf.slice(0, cut)
      buf = buf.slice(cut + 2)
      for (const line of chunk.split('\n')) {
        if (!line.startsWith('data:')) continue
        const raw = line.slice(5).trim()
        if (!raw) continue
        let ev
        try {
          ev = JSON.parse(raw)
        } catch (_) {
          continue
        }
        events.push(ev)
        if (ev.type === 'done') result = ev.result
        if (ev.type === 'error') error = ev.error || '生成失败'
      }
    }
  }
  return { events, result, error, elapsed: Date.now() - t0 }
}

async function main() {
  const login = await j('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  const TOK = login.token
  if (!TOK) throw new Error('登录失败')
  const H = { 'Content-Type': 'application/json', 'x-chaos-token': TOK }

  const st = await j('/api/chaos/status', { headers: H })
  if (!st.data?.phone) {
    await j('/api/chaos/phone', { method: 'POST', headers: H, body: JSON.stringify({ phone: '13800003333' }) })
  }

  console.log(`\n=== ① 生成大纲：${TOPIC} / ${PAGES} 页 ===`)
  const step1 = await sse(
    '/api/aippt/stream',
    { topic: TOPIC, pages: PAGES, tone: 'formal', theme: 'business', language: 'zh', withToc: true, withImages: false, speed: 'auto', outlineOnly: true },
    H,
  )
  if (step1.error) throw new Error('大纲阶段失败：' + step1.error)
  const outline = step1.result?.outline
  if (!outline || !Array.isArray(outline.slides)) throw new Error('没有拿到大纲')

  const kinds = (o) => o.slides.map((s) => s.kind)
  console.log(`  用时 ${(step1.elapsed / 1000).toFixed(1)}s · ${outline.slides.length} 页 · 模型 ${step1.result.model || '?'}`)
  console.log(`  页型：${kinds(outline).join(' / ')}`)
  const notes = outline.slides.filter((s) => String(s.note || '').trim()).length
  console.log(`  演讲备注：${notes}/${outline.slides.length} 页`)
  if (!step1.result.outlineOnly) warn('大纲阶段没有标记 outlineOnly')
  if (step1.events.some((e) => e.phase === 'image' || e.phase === 'render')) warn('大纲阶段不该跑配图/渲染')

  /* 只出大纲时顺手校验：新页型是否被模型用上（不强制，但要能看见） */
  const usedNew = kinds(outline).filter((k) => ['section', 'chart', 'timeline', 'process', 'compare'].includes(k))
  console.log(`  新页型命中：${usedNew.length ? [...new Set(usedNew)].join(' / ') : '（这份稿子没用到，属正常）'}`)
  /* 备注是提示词要求的，但小模型经常整段忽略 —— 记成告警而不是失败：
   * 链路本身没问题，缺的是模型能力。7B 上应为全量覆盖。 */
  if (notes === 0) {
    warns.push(`演讲备注 0 条（模型 ${step1.result.model || '?'} 忽略了 N| 行，属模型能力问题）`)
  } else if (notes < outline.slides.length) {
    console.log(`  ⚠ 演讲备注只写了 ${notes}/${outline.slides.length} 页`)
  }

  /* ---- ② 模拟用户在编辑器里改大纲 ---- */
  console.log('\n=== ② 编辑大纲（模拟编辑器操作） ===')
  const edited = JSON.parse(JSON.stringify(outline))
  // a) 改标题：验证用户改动真的会落进成品
  const stamp = `改于${Date.now() % 10000}`
  edited.slides[1].title = `${edited.slides[1].title || ''}${stamp}`.slice(0, 60)
  console.log(`  改标题：第 2 页 → ${edited.slides[1].title}`)

  // b) 插一页图表：验证用户自己加的结构化页也能渲染
  const chartSlide = {
    kind: 'chart',
    title: '手工插入的图表页',
    kicker: '',
    body: ['这一页是用户加的'],
    extra: [],
    stats: [],
    chart: { type: 'bar', labels: ['一月', '四月', '七月'], values: [12, 34, 56] },
    timeline: [],
    head: [],
    note: '编辑器插页测试',
    image: '',
    imageName: '',
  }
  edited.slides.splice(edited.slides.length - 1, 0, chartSlide)
  console.log(`  插页：在结尾页前插入 1 页图表（现 ${edited.slides.length} 页）`)

  // c) 调页序：把第 3 页和第 4 页对调
  if (edited.slides.length >= 5) {
    const a = edited.slides[2]
    edited.slides[2] = edited.slides[3]
    edited.slides[3] = a
    console.log('  调页序：第 3、4 页对调')
  }

  // d) 换配色 + 关掉配图，让这一轮跑得快且可预期
  console.log('\n=== ③ 按改后的大纲出片 ===')
  const step2 = await sse(
    '/api/aippt/assemble',
    { outline: edited, theme: 'emerald', withToc: true, withImages: false },
    H,
  )
  if (step2.error) throw new Error('出片阶段失败：' + step2.error)
  const done = step2.result
  if (!done) throw new Error('没有拿到成品')
  console.log(`  用时 ${(step2.elapsed / 1000).toFixed(1)}s · ${done.pages} 页 · ${(done.size / 1024).toFixed(0)}KB`)

  const expectPages = edited.slides.length + (edited.slides.length >= 5 ? 1 : 0)
  console.log(`  页数：成品 ${done.pages} / 期望 ${expectPages}`)
  if (done.pages !== expectPages) warn(`页数不符：成品 ${done.pages}，大纲折算应为 ${expectPages}`)
  if (!step2.events.some((e) => e.type === 'phase' && e.phase === 'render')) warn('出片阶段没有 render 事件')

  /* ---- ④ 校验 pptx 内部 ---- */
  console.log('\n=== ④ 校验成品文件 ===')
  const file = done.file
  if (!file || !fs.existsSync(file)) throw new Error('成品文件不存在：' + file)

  const probe = `
import zipfile, re, json, sys
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
charts = [n for n in names if n.startswith('ppt/charts/chart')]
notes = [n for n in names if 'notesSlide' in n and n.endswith('.xml')]
tbl = sum(1 for n in names if n.startswith('ppt/slides/slide') and b'<a:tbl>' in z.read(n))
chart_types = []
for c in charts:
    x = z.read(c).decode('utf8', 'ignore')
    for t in ['barChart', 'lineChart', 'pieChart', 'doughnutChart']:
        if '<c:' + t + '>' in x:
            chart_types.append(t)
note_txt = ''.join(re.sub('<[^>]+>', '', z.read(n).decode('utf8', 'ignore')) for n in notes)
all_txt = ''.join(re.sub('<[^>]+>', '', z.read(n).decode('utf8', 'ignore')) for n in names if n.startswith('ppt/slides/slide') and n.endswith('.xml'))
print(json.dumps({'charts': len(charts), 'chartTypes': chart_types, 'tables': tbl, 'notes': len(notes), 'noteChars': len(note_txt), 'hasStamp': sys.argv[2] in all_txt, 'slides': len([n for n in names if re.match(r'ppt/slides/slide\\d+\\.xml$', n)])}, ensure_ascii=False))
`
  const tmp = path.join(require('os').tmpdir(), `aippt-probe-${Date.now()}.py`)
  fs.writeFileSync(tmp, probe, 'utf8')
  let info
  try {
    info = JSON.parse(execFileSync(PY, [tmp, file, stamp], { encoding: 'utf8' }).trim())
  } finally {
    try {
      fs.unlinkSync(tmp)
    } catch (_) {
      /* ignore */
    }
  }
  console.log('  ', JSON.stringify(info))
  if (info.charts < 1) warn('成品里没有图表对象（用户插的图表页没渲染出来）')
  if (!info.chartTypes.includes('barChart')) warn('图表类型不是柱状图')
  if (info.hasStamp !== true) warn('用户改过的标题没有落进成品（编辑没生效）')
  if (info.notes < 1) warn('成品里没有演讲备注页')
  if (info.noteChars < 10) warn('演讲备注内容为空')

  /* ---- 汇总 ---- */
  console.log('\n=== 结果 ===')
  if (warns.length) warns.forEach((w) => console.log('  ⚠ ' + w))
  if (problems.length) {
    problems.forEach((p) => console.log('  ✗ ' + p))
    console.log(`\n${problems.length} 项未通过`)
    process.exit(1)
  }
  console.log('  ✓ 大纲 → 编辑 → 出片 全链路通过')
  process.exit(0)
}

main().catch((err) => {
  console.error('\n失败：', err.message)
  process.exit(1)
})
