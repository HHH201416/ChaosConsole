'use strict'

/**
 * 用 Chrome DevTools Protocol 驱动真实的 Electron 窗口做端到端检查。
 *
 * 这不是单元测试，而是「应用真的跑起来了吗」的验证：登录页渲染了吗、
 * 看板四列在不在、10 个员工在不在、通过 API 建的任务能不能实时出现在
 * 界面正确的列里。
 *
 * 用法（Electron 需带 --remote-debugging-port=9222 启动）：
 *   node scripts/e2e-check.js
 */

const path = require('path')

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:43117'
const AUTH_CODE = process.env.CHAOS_AUTH_CODE || 'Hyc13579'

const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'))

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const res = await fetch(`${CDP_URL}/json`)
  const targets = await res.json()
  // 启动闪屏（electron/splash.html）也是一个 page target。如果它恰好排在前面，
  // targets.find(type==='page') 会连到闪屏上，所有断言都会莫名其妙地失败。
  // 所以显式排掉闪屏，只在没有主窗口时才退回第一个 page。
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

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  /** 在页面里求值，自动 await Promise，返回结构化结果 */
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

async function main() {
  console.log('\n=== AI Agent开发控制台 · 端到端检查 ===\n')
  const { ws, send, evaluate } = await connect()

  try {
    /* ---------- 0. 清掉可能残留的会话，保证从登录页开始 ---------- */
    await evaluate(`
      localStorage.removeItem('chaos.token')
      return true
    `)
    await send('Page.enable', {})
    await send('Page.reload', { ignoreCache: true })
    await sleep(2500)

    /* ---------- 1. 前端资源是否真的被加载 ---------- */
    const loaded = await evaluate(`
      return {
        url: location.href,
        title: document.title,
        hasRoot: !!document.getElementById('root'),
        rootChildren: document.getElementById('root')?.children.length || 0,
        styleSheets: document.styleSheets.length,
      }
    `)
    check('页面已加载', loaded.hasRoot && loaded.rootChildren > 0, loaded.url)
    check('窗口标题正确', loaded.title === 'AI Agent开发控制台', loaded.title)
    check('Tailwind 样式表已注入', loaded.styleSheets > 0, `${loaded.styleSheets} 个`)

    /* ---------- 1b. 启动闪屏应当在主窗口就绪后自己关掉 ---------- */
    const splashTargets = await (async () => {
      const r = await fetch(`${CDP_URL}/json`)
      const ts = await r.json()
      return ts.filter((t) => t.type === 'page' && /splash\.html/i.test(t.url))
    })()
    check('启动闪屏已自动关闭', splashTargets.length === 0, `残留 ${splashTargets.length} 个闪屏窗口`)

    /* ---------- 2. 登录页 ---------- */
    const loginPage = await evaluate(`
      const txt = document.body.innerText
      return {
        heading: document.querySelector('h1')?.textContent || '',
        hasPassword: !!document.querySelector('input[type=password]'),
        hasSubmit: !!document.querySelector('button[type=submit]'),
        mentionsAuthCode: txt.includes('授权码'),
      }
    `)
    check('登录页显示应用名', loginPage.heading === 'AI Agent开发控制台', loginPage.heading)
    check('登录页有授权码输入框', loginPage.hasPassword)
    check('登录页有提交按钮', loginPage.hasSubmit)

    /* ---------- 3. 错误授权码应被拒绝 ---------- */
    const wrongCode = await evaluate(`
      const r = await fetch('/api/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: 'definitely-wrong' })
      })
      const j = await r.json()
      return { status: r.status, ok: j.ok, error: j.error }
    `)
    check('错误授权码被拒绝', wrongCode.status === 401 && wrongCode.ok === false, `HTTP ${wrongCode.status}`)

    /* ---------- 4. 真实登录流程（填表单 + 点按钮） ---------- */
    await evaluate(`
      const input = document.querySelector('input[type=password]')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(AUTH_CODE)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 120))
      document.querySelector('button[type=submit]').click()
      return true
    `)
    // 轮询等待登录后的首屏渲染完成，别用固定 sleep 赌时间
    await evaluate(`
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const aside = document.querySelector('aside')
        if (aside && aside.innerText.includes('代码实现')) break
        await new Promise(r => setTimeout(r, 300))
      }
      return true
    `)
    await sleep(400)

    const board = await evaluate(`
      const txt = document.body.innerText
      // 界面上应当只出现「是干什么的」，不出现姓名
      const functions = ['代码实现','架构设计','界面设计','测试验证','技术调研','构建发布','数据分析','文档撰写','安全审计','需求拆解','鸿蒙应用开发']
      const names = ['张全栈','李架构','王设计','赵测试','钱研究','孙运维','周数据','吴文档','郑安全','冯项目','何鸿蒙']
      const cols = [...document.querySelectorAll('main > div')].map(c => c.innerText.split('\\n')[0])
      return {
        stillOnLogin: !!document.querySelector('input[type=password]'),
        heading: document.querySelector('h1')?.textContent || '',
        columns: cols,
        functionsFound: functions.filter(n => txt.includes(n)).length,
        functionsMissing: functions.filter(n => !txt.includes(n)),
        namesVisible: names.filter(n => txt.includes(n)).length,
        asideScrollH: document.querySelector('aside')?.scrollHeight ?? -1,
        asideClientH: document.querySelector('aside')?.clientHeight ?? -1,
        taskCount: JSON.parse(JSON.stringify(
          [...document.querySelectorAll('main > div')].map(c => {
            const m = c.innerText.match(/\\n(\\d+)\\s*$/m); return m ? Number(m[1]) : null
          })
        )).filter(n => n !== null).reduce((a,b)=>a+b, 0),
        hasNewAgent: txt.includes('新岗位'),
        hasNewTask: txt.includes('新任务'),
        hasCheckUpdate: txt.includes('检查更新'),
        hasMcp: txt.includes('MCP'),
        hasChatEmpty: txt.includes('自动分配给合适的员工') || txt.includes('系统会按内容自动挑一个员工'),
      }
    `)

    check('登录成功，离开登录页', !board.stillOnLogin)
    check('顶栏标题正确', board.heading === 'AI Agent开发控制台', board.heading)
    check('看板四列齐全', board.columns.length === 4, board.columns.join(' / '))
    check(
      '11 个岗位全部显示（按职能）',
      board.functionsFound === 11,
      `${board.functionsFound}/11  缺失: ${JSON.stringify(board.functionsMissing || [])}  侧边栏 ${board.asideScrollH}/${board.asideClientH}`,
    )
    check('界面上不出现员工姓名', board.namesVisible === 0, `出现 ${board.namesVisible} 处`)
    check('首次启动看板为 0 任务', board.taskCount === 0, `当前 ${board.taskCount} 条`)
    check('顶栏有「新岗位」按钮', board.hasNewAgent)
    check('顶栏有「新任务」按钮', board.hasNewTask)
    check('顶栏有「MCP」按钮', board.hasMcp)
    check('顶栏有「检查更新」按钮', board.hasCheckUpdate)
    check('右侧对话页显示空状态引导', board.hasChatEmpty)

    /* ---------- 5. 实时推送：建任务 → 自动派单 → 卡片落到「进行中」 ---------- */
    const TITLE = `端到端验证任务-${Date.now().toString().slice(-6)}`
    const created = await evaluate(`
      const token = localStorage.getItem('chaos.token')
      const h = { 'Content-Type': 'application/json', 'x-chaos-token': token }
      const c = await (await fetch('/api/tasks', { method:'POST', headers:h, body: JSON.stringify({
        title: ${JSON.stringify(TITLE)}, description: '验证后端自动派单与 WebSocket 实时推送', tags: ['Bash']
      })})).json()
      await fetch('/api/tasks/' + c.data.id + '/start', { method:'POST', headers:h })
      return { id: c.data.id }
    `)
    check('通过 API 创建任务成功', Boolean(created.id), created.id)

    await sleep(4000)

    const live = await evaluate(`
      const cols = [...document.querySelectorAll('main > div')].map(c => c.innerText)
      const t = ${JSON.stringify(TITLE)}
      return {
        inProgress: cols[1]?.includes(t) || false,
        anywhere: cols.some(c => c.includes(t)),
        workingAgents: [...document.querySelectorAll('aside')][0]?.innerText.includes('忙碌') || false,
        topBarRunning: document.body.innerText.includes('任务执行中'),
      }
    `)
    check('新任务实时出现在界面（无需刷新）', live.anywhere, TITLE)
    check('任务落在「进行中」列', live.inProgress)
    check('顶栏显示执行中计数', live.topBarRunning)
    check('员工状态变为忙碌', live.workingAgents)

    /* ---------- 6. 等待执行完成，任务应自动移到「已完成」 ---------- */
    await sleep(12000)
    const finished = await evaluate(`
      const cols = [...document.querySelectorAll('main > div')].map(c => c.innerText)
      const t = ${JSON.stringify(TITLE)}
      return {
        inComplete: cols[3]?.includes(t) || false,
        stillInProgress: cols[1]?.includes(t) || false,
      }
    `)
    check('任务完成后自动移入「已完成」列', finished.inComplete && !finished.stillInProgress)

    /* ---------- 7. 点击卡片 → 对话页渲染这次对话 ---------- */
    const detail = await evaluate(`
      const t = ${JSON.stringify(TITLE)}
      const cards = [...document.querySelectorAll('main > div')].flatMap(c => [...c.querySelectorAll('div[class*="rounded-lg"][class*="cursor-pointer"]')])
      const card = cards.find(c => c.innerText.includes(t))
      if (!card) return { clicked: false }
      card.click()
      await new Promise(r => setTimeout(r, 1500))
      const aside = document.querySelector('aside:last-of-type')
      const txt = document.body.innerText
      return {
        clicked: true,
        hasChatTitle: txt.includes('对话'),
        hasHistoryBtn: txt.includes('历史'),
        hasNewChatBtn: txt.includes('新对话'),
        hasEventsTab: txt.includes('事件'),
        hasInputBox: !!document.querySelector('textarea'),
        hasModelPicker: [...document.querySelectorAll('select')].length >= 2,
        showsFunctionNotName: !['张全栈','李架构','王设计','赵测试','钱研究','孙运维','周数据','吴文档','郑安全','冯项目','何鸿蒙'].some(n => txt.includes(n)),
        detailLen: aside ? aside.innerText.length : 0,
      }
    `)
    check('点击卡片切换到该对话', detail.clicked && detail.detailLen > 50, `${detail.detailLen} 字符`)
    check('对话页有「历史」入口', detail.hasHistoryBtn)
    check('对话页有「+ 新对话」按钮', detail.hasNewChatBtn)
    check('对话页可切换到「事件」视图', detail.hasEventsTab)
    check('对话页底部有输入框', detail.hasInputBox)
    check('对话页有执行器/模型选择器', detail.hasModelPicker)
    check('对话页也只用职能标识，不显示姓名', detail.showsFunctionNotName)

    /* ---------- 7b. 历史对话列表可打开 ---------- */
    const history = await evaluate(`
      const btns = [...document.querySelectorAll('button')]
      const h = btns.find(b => b.innerText.trim().startsWith('历史'))
      if (!h) return { ok: false }
      h.click()
      await new Promise(r => setTimeout(r, 700))
      const txt = document.body.innerText
      return { ok: true, hasPanel: txt.includes('历史对话'), hasCount: /共 \\d+ 条/.test(txt) }
    `)
    check('可以打开历史对话面板', history.ok && history.hasPanel)
    check('历史面板显示对话条数', history.hasCount)

    /* ---------- 7c. MCP 管理面板 ---------- */
    const mcp = await evaluate(`
      const btns = [...document.querySelectorAll('button')]
      const b = btns.find(x => x.innerText.includes('MCP'))
      if (!b) return { ok: false }
      b.click()
      await new Promise(r => setTimeout(r, 2500))
      const txt = document.body.innerText
      return {
        ok: true,
        hasTitle: txt.includes('MCP 服务器'),
        hasInstallTab: txt.includes('即装即用'),
        hasKeyTab: txt.includes('需要密钥'),
        hasFilesystem: txt.includes('文件系统'),
        hasMemory: txt.includes('长期记忆'),
        hasEnabledCount: /已启用/.test(txt),
      }
    `)
    check('MCP 管理面板可打开', mcp.ok && mcp.hasTitle)
    check('MCP 面板有「即装即用」分类', mcp.hasInstallTab)
    check('MCP 面板有「需要密钥」分类', mcp.hasKeyTab)
    check('MCP 目录含文件系统服务器', mcp.hasFilesystem)
    check('MCP 目录含长期记忆服务器', mcp.hasMemory)
    check('MCP 面板显示已启用计数', mcp.hasEnabledCount)

    /* ---------- 7d. 对话页真实发消息 → 自动派单 ---------- */
    // 先关掉 MCP 面板
    await evaluate(`
      const btns = [...document.querySelectorAll('button')]
      const close = btns.find(b => b.innerText.trim() === '关闭')
      if (close) close.click()
      await new Promise(r => setTimeout(r, 500))
      return true
    `)

    const CHAT_TEXT = '写一下鸿蒙 ArkTS 的列表页面示例'
    await evaluate(`
      // 先点「+ 新对话」确保是干净状态
      const btns = [...document.querySelectorAll('button')]
      const nb = btns.find(b => b.innerText.includes('新对话'))
      if (nb) nb.click()
      await new Promise(r => setTimeout(r, 500))

      const ta = document.querySelector('textarea')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
      setter.call(ta, ${JSON.stringify(CHAT_TEXT)})
      ta.dispatchEvent(new Event('input', { bubbles: true }))
      await new Promise(r => setTimeout(r, 200))

      const send = [...document.querySelectorAll('button')].find(b => b.innerText.trim() === '发送')
      send.click()
      return true
    `)
    await sleep(3500)

    const chat = await evaluate(`
      const t = ${JSON.stringify(CHAT_TEXT)}
      const txt = document.body.innerText
      const cols = [...document.querySelectorAll('main > div')].map(c => c.innerText)
      return {
        createdTask: cols.some(c => c.includes(t)),
        inProgress: cols[1]?.includes(t) || false,
        routedToHarmony: txt.includes('鸿蒙应用开发'),
        mentionedAutoAssign: txt.includes('自动分配给'),
        hasUserBubble: txt.includes(t),
        taskCount: (() => {
          const m = [...document.querySelectorAll('main > div')].map(c => {
            const x = c.innerText.match(/\\n(\\d+)\\s*$/m); return x ? Number(x[1]) : 0
          }); return m.reduce((a,b)=>a+b,0)
        })(),
      }
    `)
    check('对话页发消息会自动建任务', chat.createdTask)
    check('新任务进入「进行中」', chat.inProgress)
    check('内容命中鸿蒙 → 路由给「鸿蒙应用开发」', chat.routedToHarmony)
    check('界面提示已自动分配（不显示姓名）', chat.mentionedAutoAssign)
    check('消息以用户气泡形式出现在对话里', chat.hasUserBubble)

    await sleep(11000)
    const chatDone = await evaluate(`
      const t = ${JSON.stringify(CHAT_TEXT)}
      const cols = [...document.querySelectorAll('main > div')].map(c => c.innerText)
      const txt = document.body.innerText
      return {
        inComplete: cols[3]?.includes(t) || false,
        hasAssistantReply: /已接手|改动|完成|分析/.test(txt),
      }
    `)
    check('对话任务执行完成后自动进「已完成」', chatDone.inComplete)

    /* ---------- 8. 会话失效时应被踢回登录页 ---------- */
    const unauth = await evaluate(`
      const r = await fetch('/api/state', { headers: { 'x-chaos-token': 'bogus-token' } })
      return { status: r.status }
    `)
    check('伪造 token 访问 API 被拒绝', unauth.status === 401, `HTTP ${unauth.status}`)
  } finally {
    ws.close()
  }

  const passed = results.filter((r) => r.ok).length
  const failed = results.length - passed
  console.log(`\n=== 结果：${passed}/${results.length} 通过${failed ? `，${failed} 失败` : ''} ===\n`)
  if (failed) {
    console.log('失败的检查项：')
    results.filter((r) => !r.ok).forEach((r) => console.log(`  - ${r.name}`))
  }
  process.exit(failed ? 1 : 0)
}

main().catch((err) => {
  console.error('\n[e2e] 执行失败:', err.message)
  process.exit(1)
})
