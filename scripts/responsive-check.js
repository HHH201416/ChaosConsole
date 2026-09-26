'use strict'

/**
 * 屏幕尺寸适配检查：把视口调成各种尺寸，逐一量布局，并各存一张截图。
 *
 * 与 e2e-check.js 的分工：那个管「功能对不对」，这个只管「换尺寸会不会破版」。
 *
 * 两段检查：
 *   A. 布局矩阵 —— 用 CDP 的 Emulation.setDeviceMetricsOverride 精确设定视口宽度，
 *      逐档核对面板宽度、看板列宽地板、顶栏不溢出。可控、可重复。
 *   B. 真实窗口 —— 量 BrowserWindow 的实际尺寸，核对「按工作区算初始尺寸」这条逻辑
 *      和 minWidth 钳制。这一段**必须在应用刚启动、没手动拖过窗口时跑**才有意义。
 *
 * 为什么不用 window.resizeTo 来做 A：它在这里不可靠 —— 只有从大往小缩的那几次生效，
 * 窗口一旦停在最小尺寸就再也缩不动（加 userGesture 也没用）。
 *
 * 用法（Electron 需带 --remote-debugging-port=9222 启动）：
 *   node scripts/responsive-check.js
 * 截图落在 scripts/out/（已在 .gitignore 里）。
 */

const fs = require('fs')
const path = require('path')

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const AUTH_CODE = process.env.CHAOS_AUTH_CODE || 'Hyc13579'
const OUT_DIR = path.join(__dirname, 'out')

const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'))

/* 要检查的视口宽度。断言全部基于这些**精确**宽度（Emulation 直接设定，不含边框），
   所以档位边界附近的点也有意义，但依然刻意避开了边界本身。 */
const WIDTHS = [
  { w: 1900, h: 1000, note: '大屏 / 高 DPI 屏' },
  { w: 1700, h: 950, note: 'desk 档上沿' },
  { w: 1440, h: 900, note: '常见笔记本' },
  { w: 1280, h: 800, note: '1280 笔记本（看板临界）' },
  { w: 1100, h: 720, note: '中间档下沿' },
  { w: 1000, h: 700, note: '窄屏档' },
  { w: 900, h: 600, note: '最小窗口内宽' },
]

/* 档位期望值，必须与组件里的类名一致：
   AgentSidebar  w-48 / lg:w-52 / desk:w-64         → 192 / 208 / 256
   ChatPanel     w-[18rem] / lg:w-[20rem] / desk:w-[30rem] → 288 / 320 / 480
   断点：lg=1024、desk=1560（见 tailwind.config.js） */
const expectSidebar = (w) => (w >= 1560 ? 256 : w >= 1024 ? 208 : 192)
const expectChat = (w) => (w >= 1560 ? 480 : w >= 1024 ? 320 : 288)

const COLUMN_FLOOR = 168 // Board.jsx 的 min-w-[10.5rem]
const MIN_WINDOW_WIDTH = 900 // electron/main.js 的 minWidth
const MAX_WINDOW_WIDTH = 1720 // electron/main.js 里初始尺寸的上限

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const res = await fetch(`${CDP_URL}/json`)
  const targets = await res.json()
  // 启动闪屏也是一个 page target，且它没有主窗口的界面，连错了所有断言都会莫名其妙地失败
  const pages = targets.filter((t) => t.type === 'page')
  const page = pages.find((t) => !/splash\.html/i.test(t.url)) || pages[0]
  if (!page) throw new Error('找不到 page target，Electron 是否带 --remote-debugging-port 启动？')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let nextId = 0
  const pending = new Map()
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw)
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  })

  // 每条命令都带超时。CDP 有的调用会永久不返回 —— 典型是窗口被最小化时的
  // Page.captureScreenshot（渲染器拿不到帧，就一直在那儿等），没有超时的话
  // 整个脚本会静默挂死，看起来像卡在别的地方。
  const send = (method, params, timeoutMs = 10000) =>
    new Promise((resolve) => {
      const id = ++nextId
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({ __timeout: true, method })
      }, timeoutMs)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        resolve(msg)
      })
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || '页面内求值异常')
    }
    return r.result?.result?.value
  }

  return { ws, send, evaluate }
}

/**
 * 登录 + 清掉跨运行存活的界面状态。
 *
 * 后者是必须的：这个脚本硬断言面板宽度等于档位期望值，而上一次运行（或用户手动）
 * 要是把侧栏折叠了、把对话面板收起来了，这次就会误报「布局坏了」。
 * 必须在 reload 之前清，因为 store 只在启动时读一次 localStorage。
 */
async function resetAndLogin(evaluate) {
  const r = await evaluate(`
    if (!localStorage.getItem('chaos.token')) {
      const lr = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: ${JSON.stringify(AUTH_CODE)} }),
      })
      const lj = await lr.json()
      if (!lj.ok) return { ok: false, error: lj.error || ('HTTP ' + lr.status) }
      localStorage.setItem('chaos.token', lj.token)
    }
    // 清掉上次遗留的面板折叠 / 选中会话
    localStorage.removeItem('chaos.ui')
    return { ok: true }
  `)
  if (!r.ok) throw new Error(`自动登录失败：${r.error}`)
}

/** 量一次当前布局。返回原始数据，期望值的判断留在外面做，失败信息里才看得到差多少。 */
const measure = (evaluate) =>
  evaluate(`
    const main = document.querySelector('main')
    const cols = [...main.querySelectorAll(':scope > div')]
    const asides = [...document.querySelectorAll('aside')]
    const header = document.querySelector('header')
    const chat = document.querySelector('aside:last-of-type')

    return {
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      colCount: cols.length,
      colWidths: cols.map((c) => Math.round(c.getBoundingClientRect().width)),
      colMinWidths: cols.map((c) => getComputedStyle(c).minWidth),
      headHeights: cols.map((c) => Math.round(c.querySelector(':scope > div').getBoundingClientRect().height)),
      asideCount: asides.length,
      sidebarW: asides[0] ? Math.round(asides[0].getBoundingClientRect().width) : -1,
      chatW: chat ? Math.round(chat.getBoundingClientRect().width) : -1,
      headerOverflow: header ? header.scrollWidth - header.clientWidth : -1,
      docOverflow: document.documentElement.scrollWidth - window.innerWidth,
      hasTextarea: !!document.querySelector('textarea'),
      selectCount: document.querySelectorAll('select').length,
      // 输入区那一行（执行器/模型选择器 + 右侧提示语）在窄面板里最容易挤到折行
      hintH: (() => {
        const el = [...chat.querySelectorAll('span')].find((s) =>
          /自动派单|续跑同一会话|执行中/.test(s.textContent),
        )
        return el ? Math.round(el.getBoundingClientRect().height) : -1
      })(),
    }
  `)

/** 截图是尽力而为的补充材料，失败了不能拖垮断言。 */
async function shoot(send, file) {
  const r = await send('Page.captureScreenshot', { format: 'png' }, 15000)
  const data = r.result?.data
  if (!data) return r.__timeout ? 'timeout' : 'failed'
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  return 'ok'
}

/* ------------------------------------------------------------------ *
 * A. 布局矩阵
 * ------------------------------------------------------------------ */

async function checkLayout(send, evaluate) {
  console.log('— A. 布局矩阵（Emulation 精确设定视口）\n')

  for (const size of WIDTHS) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: size.w,
      height: size.h,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await sleep(320)

    const m = await measure(evaluate)
    const tag = `[${size.w}]`
    if (m.innerW !== size.w) {
      check(`${tag} 视口宽度被正确设定`, false, `期望 ${size.w}，实际 ${m.innerW}`)
      continue
    }

    // 1. 布局结构不能变（e2e 依赖 main > div 是 4 个、aside 是 2 个且顺序固定）
    check(`${tag} 看板仍为 4 列且直接是 main 的子元素`, m.colCount === 4, `实际 ${m.colCount}`)
    check(`${tag} aside 仍为 2 个（员工列表 + 对话面板）`, m.asideCount === 2, `实际 ${m.asideCount}`)

    // 2. 列有地板宽度：放不下时应该横向滚动，而不是把列压扁
    const minCol = Math.min(...m.colWidths)
    check(
      `${tag} 每列都不窄于地板宽度 ${COLUMN_FLOOR}px`,
      minCol >= COLUMN_FLOOR - 1,
      `最窄 ${minCol}px  各列 ${JSON.stringify(m.colWidths)}`,
    )
    check(
      `${tag} 列头没有被挤到折行（说明留了足够宽度）`,
      Math.max(...m.headHeights) <= 44,
      `各列头高 ${JSON.stringify(m.headHeights)}`,
    )

    // 3. 顶栏不溢出。这是全应用唯一「裁掉就点不到」的地方，且 body 是 overflow:hidden
    check(`${tag} 顶栏没有横向溢出`, m.headerOverflow <= 1, `溢出 ${m.headerOverflow}px`)

    // 4. 面板宽度落在该档位的期望值上
    check(
      `${tag} 员工侧栏 = ${expectSidebar(m.innerW)}px`,
      Math.abs(m.sidebarW - expectSidebar(m.innerW)) <= 1,
      `实际 ${m.sidebarW}px`,
    )
    check(
      `${tag} 对话面板 = ${expectChat(m.innerW)}px`,
      Math.abs(m.chatW - expectChat(m.innerW)) <= 1,
      `实际 ${m.chatW}px`,
    )

    // 5. 面板常驻：窄屏下对话面板也必须还在（否则等于功能没了）
    check(
      `${tag} 对话面板仍常驻（输入框 / 选择器都在）`,
      m.chatW > 0 && m.hasTextarea && m.selectCount >= 2,
      `宽 ${m.chatW}px  textarea=${m.hasTextarea}  select=${m.selectCount}`,
    )

    // 6. 输入区那行的提示语保持单行（窄面板下只差 1px 就会被折成两行）
    check(
      `${tag} 输入区提示语没有折行`,
      m.hintH === -1 || m.hintH <= 16,
      `高 ${m.hintH}px`,
    )

    check(`${tag} 页面本身没有横向溢出`, m.docOverflow <= 1, `溢出 ${m.docOverflow}px`)

    const shot = await shoot(send, path.join(OUT_DIR, `responsive-${size.w}x${size.h}.png`))
    console.log(
      `    · ${size.note}｜` +
        (shot === 'ok'
          ? '截图已存'
          : shot === 'timeout'
            ? '截图超时（窗口被最小化时 Chromium 拿不到帧，属正常；把窗口恢复出来即可）'
            : '截图失败'),
    )
  }

  await send('Emulation.clearDeviceMetricsOverride', {})
}

/* ------------------------------------------------------------------ *
 * B. 真实窗口（必须在刚启动、未手动拖过窗口时跑）
 * ------------------------------------------------------------------ */

async function checkRealWindow(evaluate) {
  console.log('\n— B. 真实窗口（初始尺寸与 minWidth 钳制）\n')

  const real = await evaluate(`
    return {
      outerW: window.outerWidth,
      outerH: window.outerHeight,
      innerW: window.innerWidth,
      availW: screen.availWidth,
      availH: screen.availHeight,
      dpr: window.devicePixelRatio,
    }
  `)

  console.log(
    `  工作区 ${real.availW}×${real.availH}（DPR ${real.dpr}）` +
      ` → 窗口外框 ${real.outerW}×${real.outerH}，内宽 ${real.innerW}`,
  )

  // 与 electron/main.js 的 preferredWindowSize() 同一条公式
  const expectedW = Math.min(MAX_WINDOW_WIDTH, real.availW, Math.max(1024, Math.round(real.availW * 0.92)))
  const expectedH = Math.min(1080, real.availH, Math.max(640, Math.round(real.availH * 0.92)))

  check(
    `窗口初始宽度按工作区算出 ${expectedW}（不是写死的 1560）`,
    real.outerW === expectedW,
    `实际 ${real.outerW}${real.outerW !== expectedW ? '（若手动拖过窗口，这一条不适用）' : ''}`,
  )
  check(
    `窗口初始高度 = ${expectedH}`,
    real.outerH === expectedH,
    `实际 ${real.outerH}${real.outerH !== expectedH ? '（若手动拖过窗口，这一条不适用）' : ''}`,
  )
  check(
    `窗口不会超出工作区`,
    real.outerW <= real.availW && real.outerH <= real.availH,
    `${real.outerW}×${real.outerH} vs ${real.availW}×${real.availH}`,
  )
  check(
    `窗口宽度不低于 minWidth=${MIN_WINDOW_WIDTH}`,
    real.outerW >= MIN_WINDOW_WIDTH,
    `实际 ${real.outerW}`,
  )
}

async function main() {
  console.log('\n=== AI Agent开发控制台 · 屏幕尺寸适配检查 ===\n')
  const { ws, send, evaluate } = await connect()

  try {
    await send('Page.enable', {})
    await resetAndLogin(evaluate)
    await send('Page.reload', { ignoreCache: false })
    await sleep(3000)

    const boot = await evaluate(`return { authed: !!document.querySelector('main') }`)
    if (!boot.authed) throw new Error('登录后没看到看板，先确认应用已经起来并且授权码正确')
    console.log(`截图输出目录：${OUT_DIR}\n`)

    await checkLayout(send, evaluate)
    await checkRealWindow(evaluate)
  } finally {
    ws.close()
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\n=== 结果：${passed}/${results.length} 通过${failed ? `，${failed} 失败` : ''} ===`)
  if (failed) {
    console.log('失败的检查项：')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}${r.extra ? `  ${r.extra}` : ''}`))
  }
  console.log(`\n截图：${OUT_DIR}\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\n[responsive] 执行失败:', err.message)
  process.exit(1)
})
