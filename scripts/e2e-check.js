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
    /* ---------- 0. 重置：清任务、关掉首启向导、清界面偏好、固定视口 ---------- */
    // 服务端那两件事走 Node 侧 fetch，完全不碰页面 —— 这样不会在页面里留下 token，
    // 下面「未登录应停在登录页」那几条断言的前提不受影响。
    const loginRes = await fetch(`${APP_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: AUTH_CODE }),
    })
    const H = { 'Content-Type': 'application/json', 'x-chaos-token': (await loginRes.json()).token }
    // 清库：本脚本自己会建两条任务且从不清理，不清的话「看板 0 任务」与
    // 「对话页空状态」跑第二遍必红
    const cleared = await (await fetch(`${APP_URL}/api/tasks/clear`, { method: 'POST', headers: H })).json()
    check('重置：清空库里上一次跑剩下的任务', cleared.ok === true)

    await evaluate(`
      // chaos.ui 是跨运行存活的（面板折叠状态 / 上次选中的会话）。上次折叠过侧栏的话，
      // 这次 aside 里就读不到那 21 个职能名；上次选中过对话的话，对话页就不是空状态。
      // 和 token 一样必须在 reload 之前清 —— store 只在启动时读一次 localStorage。
      localStorage.removeItem('chaos.token')
      localStorage.removeItem('chaos.ui')
      return true
    `)
    await send('Page.enable', {})
    // 固定视口：有几条断言依赖窗口够宽（面板展开宽度、顶栏「N 个任务执行中」在
    // <1024 时是 display:none）。窗口尺寸现在会被跨重启记住，不固定就得看运气。
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
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
      const functions = [
        // 10 个 Claude 工程岗位
        '代码实现','架构设计','界面设计','测试验证','技术调研','构建发布','数据分析','文档撰写','安全审计','需求拆解',
        // 1 个闲聊兜底岗位
        '日常对话',
        // 10 个 DevEco（鸿蒙）岗位
        '鸿蒙应用开发','鸿蒙界面开发','元服务与卡片','鸿蒙工程架构','鸿蒙测试验证',
        '鸿蒙构建发布','分布式能力','鸿蒙数据管理','鸿蒙性能调优','权限与隐私合规',
      ]
      const names = [
        '张全栈','李架构','王设计','赵测试','钱研究','孙运维','周数据','吴文档','郑安全','冯项目',
        '白小助',
        '何鸿蒙','刘界面','陈卡片','孙架构','周测试','吴构建','郑分布','冯数据','钱性能','赵安全',
      ]
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
      '21 个岗位全部显示（按职能）',
      board.functionsFound === 21,
      `${board.functionsFound}/21  缺失: ${JSON.stringify(board.functionsMissing || [])}  侧边栏 ${board.asideScrollH}/${board.asideClientH}`,
    )
    check('界面上不出现员工姓名', board.namesVisible === 0, `出现 ${board.namesVisible} 处`)
    check('首次启动看板为 0 任务', board.taskCount === 0, `当前 ${board.taskCount} 条`)
    check('顶栏有「新岗位」按钮', board.hasNewAgent)
    check('顶栏有「新任务」按钮', board.hasNewTask)
    check('顶栏有「MCP」按钮', board.hasMcp)
    check('顶栏有「检查更新」按钮', board.hasCheckUpdate)
    check('右侧对话页显示空状态引导', board.hasChatEmpty)

    /* ---------- 4b. 两个面板必须真的是「展开」的 ----------
       上面的岗位/忙碌/空状态断言全靠 innerText 与 querySelectorAll，而折叠态
       （侧栏换成 AgentRailRow、对话面板只改 w-0 overflow-hidden）下这些内容
       要么不在 DOM 里、要么仍在 DOM 里 —— 后者会让断言照常通过却其实看不见。
       所以这里补一条几何断言，堵住那种「假绿」。 */
    const panels = await evaluate(`
      const asides = [...document.querySelectorAll('aside')]
      return {
        sidebarW: asides[0] ? Math.round(asides[0].getBoundingClientRect().width) : -1,
        chatW: asides[1] ? Math.round(asides[1].getBoundingClientRect().width) : -1,
      }
    `)
    check('员工侧栏确实是展开的', panels.sidebarW > 150, `宽 ${panels.sidebarW}px`)
    check('对话面板确实是展开的', panels.chatW > 200, `宽 ${panels.chatW}px`)

    /* ---------- 4c. 面板折叠状态跨重启保留 ---------- */
    await evaluate(`
      localStorage.setItem('chaos.ui', JSON.stringify({ sidebarOpen: false, chatOpen: true, selectedTaskId: null }))
      return true
    `)
    await send('Page.reload', { ignoreCache: false })
    await sleep(2800)
    const collapsed = await evaluate(`
      const a = [...document.querySelectorAll('aside')][0]
      return {
        w: a ? Math.round(a.getBoundingClientRect().width) : -1,
        hasNames: a ? a.innerText.includes('代码实现') : false,
      }
    `)
    check('折叠状态跨重启保留（reload 后侧栏仍是窄条）', collapsed.w > 0 && collapsed.w <= 60, `宽 ${collapsed.w}px`)
    check('窄条里确实换成了图标版（不再渲染职能名）', collapsed.hasNames === false)

    await evaluate(`
      localStorage.setItem('chaos.ui', JSON.stringify({ sidebarOpen: true, chatOpen: true, selectedTaskId: null }))
      return true
    `)
    await send('Page.reload', { ignoreCache: false })
    await sleep(2800)
    const reExpanded = await evaluate(`
      const a = [...document.querySelectorAll('aside')][0]
      return { w: a ? Math.round(a.getBoundingClientRect().width) : -1, hasNames: a ? a.innerText.includes('代码实现') : false }
    `)
    check('展开状态同样能恢复（不是只会记住折叠）', reExpanded.w > 150 && reExpanded.hasNames, `宽 ${reExpanded.w}px`)

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
        hasByRoleTab: txt.includes('按岗位'),
      }
    `)
    check('MCP 管理面板可打开', mcp.ok && mcp.hasTitle)
    check('MCP 面板有「即装即用」分类', mcp.hasInstallTab)
    check('MCP 面板有「需要密钥」分类', mcp.hasKeyTab)
    check('MCP 目录含文件系统服务器', mcp.hasFilesystem)
    check('MCP 目录含长期记忆服务器', mcp.hasMemory)
    check('MCP 面板显示已启用计数', mcp.hasEnabledCount)
    check('MCP 面板有「按岗位」视图', mcp.hasByRoleTab)

    /* ---------- 7d. 换岗入口 / 阶段徽章 / 自动重试设置 ---------- */
    // 先关掉 MCP 面板
    await evaluate(`
      const btns = [...document.querySelectorAll('button')]
      const close = btns.find(b => b.innerText.trim() === '关闭')
      if (close) close.click()
      await new Promise(r => setTimeout(r, 500))
      return true
    `)

    // 建一个带流水线的任务并跑起来（模拟模式，约 8 秒一回合）
    const hoRes = await (
      await fetch(`${APP_URL}/api/tasks`, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          title: 'E2E 换岗入口',
          description: '验证换岗入口与阶段徽章',
          pipeline: [
            { stage: 'plan', role: 'Architect' },
            { stage: 'code', role: 'Coder' },
          ],
        }),
      })
    ).json()
    await fetch(`${APP_URL}/api/tasks/${hoRes.data.id}/start`, { method: 'POST', headers: H })
    await sleep(1500)

    const handoffUi = await evaluate(`
      await new Promise(r => setTimeout(r, 800))
      const txt = document.body.innerText
      const btns = [...document.querySelectorAll('button')].filter(b => b.innerText.trim() === '换岗')
      return { hasButton: btns.length > 0, hasStageChip: txt.includes('方案'), hasRetryChipHost: txt.includes('E2E 换岗入口') }
    `)
    check('看板卡片上有「换岗」入口', handoffUi.hasButton)
    check('任务卡片显示阶段徽章', handoffUi.hasStageChip)

    const handoffModal = await evaluate(`
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '换岗')
      if (!b) return { ok: false }
      b.click()
      await new Promise(r => setTimeout(r, 700))
      const txt = document.body.innerText
      const names = ['张全栈','李架构','王设计','赵测试','钱研究','孙运维','周数据','吴文档','郑安全','冯项目','白小助','何鸿蒙','刘界面','陈卡片','孙架构','周测试','吴构建','郑分布','冯数据','钱性能','赵安全']
      return {
        ok: true,
        hasPicker: txt.includes('指定接手岗位'),
        hasReason: txt.includes('交接原因'),
        namesVisible: names.filter(n => txt.includes(n)).length,
      }
    `)
    check('换岗弹窗能打开，有目标选择器与交接原因', handoffModal.ok && handoffModal.hasPicker && handoffModal.hasReason)
    check('换岗弹窗里只有职能、没有姓名', handoffModal.ok && handoffModal.namesVisible === 0, `出现 ${handoffModal.namesVisible ?? '-'} 处`)

    await evaluate(`
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '取消')
      if (b) b.click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)

    const settingsCheck = await evaluate(`
      const b = [...document.querySelectorAll('button')].find(x => x.title === '运行设置')
      if (!b) return { ok: false }
      b.click()
      await new Promise(r => setTimeout(r, 900))
      const txt = document.body.innerText
      return {
        ok: true,
        hasRetryLimit: txt.includes('自动换岗重试上限'),
        hasPipeline: txt.includes('阶段流水线'),
        hasMcpScope: txt.includes('按岗位挂载 MCP'),
      }
    `)
    check('设置里有「自动换岗重试上限」', settingsCheck.ok && settingsCheck.hasRetryLimit)
    check('设置里有「阶段流水线」开关', settingsCheck.ok && settingsCheck.hasPipeline)
    check('设置里有「按岗位挂载 MCP」开关', settingsCheck.ok && settingsCheck.hasMcpScope)

    // 岗位详情：MCP 挂载清单 + 默认流水线编辑
    const agentDetail = await evaluate(`
      const aside = document.querySelector('aside')
      const row = aside && [...aside.querySelectorAll('button')].find(b => (b.title || '').includes('点击查看系统提示词'))
      if (!row) return { ok: false }
      row.click()
      await new Promise(r => setTimeout(r, 900))
      const txt = document.body.innerText
      const names = ['张全栈','李架构','王设计','赵测试','钱研究','孙运维','周数据','吴文档','郑安全','冯项目','白小助','何鸿蒙','刘界面','陈卡片','孙架构','周测试','吴构建','郑分布','冯数据','钱性能','赵安全']
      return {
        ok: true,
        hasMcp: txt.includes('这个岗位能用的 MCP'),
        hasPipeline: txt.includes('默认阶段流水线'),
        hasSave: [...document.querySelectorAll('button')].some(b => b.innerText.trim() === '保存'),
        namesVisible: names.filter(n => txt.includes(n)).length,
      }
    `)
    check(
      '岗位详情能编辑 MCP 挂载与默认流水线',
      agentDetail.ok && agentDetail.hasMcp && agentDetail.hasPipeline && agentDetail.hasSave,
    )
    check(
      '岗位详情里也只有职能、没有姓名',
      agentDetail.ok && agentDetail.namesVisible === 0,
      `出现 ${agentDetail.namesVisible ?? '-'} 处`,
    )

    await evaluate(`
      const b = [...document.querySelectorAll('button')].find(x => x.innerText.trim() === '关闭')
      if (b) b.click()
      await new Promise(r => setTimeout(r, 400))
      return true
    `)
    await fetch(`${APP_URL}/api/tasks/${hoRes.data.id}`, { method: 'DELETE', headers: H })

    /* ---------- 7e. 对话页真实发消息 → 自动派单 ---------- */

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

    /* ---------- 7e. 上次选中的会话跨重启恢复 ----------
       放在这里是因为此刻对话页正好选中了刚建的那个 ArkTS 任务。 */
    const ARK = 'ArkTS'
    const EMPTY_RE = /自动分配给合适的员工|系统会按内容自动挑一个员工/
    const beforeReload = await evaluate(`
      const t = document.querySelector('aside:last-of-type')?.innerText || ''
      return {
        hasTask: t.includes(${JSON.stringify(ARK)}),
        isEmpty: ${EMPTY_RE}.test(t),
        stored: localStorage.getItem('chaos.ui') || '',
      }
    `)
    check(
      '选中会话已写进本地偏好',
      beforeReload.stored.includes('selectedTaskId'),
      beforeReload.stored.slice(0, 80),
    )

    await send('Page.reload', { ignoreCache: false })
    await sleep(3200)
    const afterReload = await evaluate(`
      const t = document.querySelector('aside:last-of-type')?.innerText || ''
      const a = [...document.querySelectorAll('aside')][0]
      return {
        hasTask: t.includes(${JSON.stringify(ARK)}),
        isEmpty: ${EMPTY_RE}.test(t),
        sidebarW: a ? Math.round(a.getBoundingClientRect().width) : -1,
      }
    `)
    check('刷新后自动回到上次那个对话（而不是空状态）', afterReload.hasTask && !afterReload.isEmpty)
    check('恢复的同时布局偏好也还在（侧栏仍展开）', afterReload.sidebarW > 150, `宽 ${afterReload.sidebarW}px`)

    // 收尾：把偏好清回默认，免得给下一次运行留状态
    await evaluate(`
      localStorage.removeItem('chaos.ui')
      return true
    `)

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

    // 撤掉开场设的视口模拟，别把状态留给下一个连上来的脚本
    await send('Emulation.clearDeviceMetricsOverride', {})
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
