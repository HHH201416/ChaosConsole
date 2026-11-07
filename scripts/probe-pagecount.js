/* eslint-disable no-console */
/**
 * 页数硬保证离线复现（10.0.1）
 *
 * 复现 2026-10-27 e2e 的那条退化：7B 只写出 5 页，闸门删完占位页后
 * 8 页任务只剩 5 页。这里把模型当成「一个字都不肯多写」（chat 必失败），
 * 只看 enforcePageCount 能否靠真实内容把页数补满。
 *
 * 用法：node scripts/probe-pagecount.js
 */
const aippt = require('../server/aippt')

const MODEL_TEXT = `T|智慧校园能源管理方案|先把账算清楚
01|电费涨了 37%|某高校 2025 年电费同比涨 37%，预算缺口 420 万
P|第一章 先把账算清楚
S|三笔账先摆出来
37%|电费同比涨幅
420 万|预算缺口
B|慢不在设备，在计量|
-|全校 126 栋楼只有 9 块总表，分项计量覆盖率 7%
-|空调和照明共用一个回路，谁都说不清谁费电
B|先把计量补齐，再谈改造|
-|分项计量改造单栋成本 1.8 万，回收期 2.3 年
-|按分项数据调优运行策略，实测节能 11%
-|计量不是花钱的活，是省钱的第一步
E|下一步做什么|
-|先做 3 栋试点，跑满一个制冷季再铺开
-|把分项数据接进后勤例会，每月对一次账`

function run(label, askN, opts = {}) {
  const parsed = aippt.parseCompactOutline(MODEL_TEXT, { topic: '智慧校园能源管理方案', n: askN, pad: false })
  if (!parsed) throw new Error('解析失败')
  const before = parsed.slides.length
  const norm = aippt.normalizeOutline(parsed, { topic: '智慧校园能源管理方案', n: askN })
  const { enforcePageCount } = aippt
  const res = enforcePageCount({
    outline: norm,
    n: askN,
    plan: opts.plan || '',
    topic: '智慧校园能源管理方案',
    send: (e) => console.log('   ·', e.type, e.field || e.reason || ''),
  })
  const kinds = res.outline.slides.map((s) => s.kind)
  const titles = res.outline.slides.map((s) => String(s.title || '(金句)').slice(0, 18))
  console.log(`\n[${label}] 解析 ${before} 页 / normalize ${norm.slides.length} 页 → 补页后 ${res.outline.slides.length} 页（目标 ${askN}，差 ${res.short}）`)
  console.log('  页型：' + kinds.join(' / '))
  console.log('  标题：' + titles.join(' | '))
  const holes = res.outline.slides.filter(aippt.isHolePage).length
  if (holes) console.log(`  ✗ 还有 ${holes} 页空白`)
  if (res.outline.slides.length !== askN) console.log(`  ✗ 页数不符：${res.outline.slides.length} != ${askN}`)
  // 结尾页必须在最后
  const last = res.outline.slides[res.outline.slides.length - 1]
  if (last.kind !== 'closing') console.log(`  ✗ 结尾页不在最后（最后一页是 ${last.kind}）`)
  /* 补出来的页不能是「凑数痕迹」：连着两页分隔、两页同名章节，都比少一页更糟 */
  for (let i = 1; i < kinds.length; i += 1) {
    if (kinds[i] === 'section' && kinds[i - 1] === 'section') console.log(`  ✗ 第 ${i} 页连着两页分隔`)
  }
  const secTitles = res.outline.slides.filter((s) => s.kind === 'section').map((s) => String(s.title || ''))
  if (new Set(secTitles).size !== secTitles.length) console.log('  ✗ 有重复的章节名：' + secTitles.join(' / '))
  return res
}

console.log('=== 模型一个字都不肯多写（chat 失败）时，靠真实内容补页 ===')
run('要 8 页', 7)
run('要 10 页', 9)
run('要 6 页', 5)
console.log('\n完成')
