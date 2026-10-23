'use strict'

/**
 * 8.0.0 新功能端到端检查。
 *
 * 前置：Electron 以 CHAOS_FORCE_MOCK=1 CHAOS_SKIP_BOOT=1 启动，并带
 * --remote-debugging-port=9222；应用已构建（dist/ 存在）。
 *
 * 用法：
 *   node scripts/e2e-v8.js
 */

const path = require('path')
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'))

const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222'
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:43117'
const AUTH_CODE = process.env.CHAOS_AUTH_CODE || 'Hyc13579'

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok, extra })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  const targets = await (await fetch(`${CDP_URL}/json`)).json()
  const pages = targets.filter((t) => t.type === 'page')
  const page = pages.find((t) => !/splash\.html/i.test(t.url)) || pages[0]
  if (!page) throw new Error('找不到 page target')

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

async function waitFor(evaluate, expression, timeout = 10000) {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    if (await evaluate(`return Boolean(${expression})`)) return true
    await sleep(250)
  }
  return false
}

async function main() {
  console.log('\n=== ChaosConsole 8.0.0 · 新功能端到端检查 ===\n')
  const { ws, send, evaluate } = await connect()

  try {
    /* ---------- 准备数据 ---------- */
    const loginRes = await fetch(`${APP_URL}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: AUTH_CODE }),
    })
    const token = (await loginRes.json()).token
    const H = { 'Content-Type': 'application/json', 'x-chaos-token': token }
    await fetch(`${APP_URL}/api/tasks/clear`, { method: 'POST', headers: H })
    // 上一次运行可能把界面语言/强调色留在别的档位；本脚本的断言以中文为准
    await fetch(`${APP_URL}/api/settings`, {
      method: 'POST',
      headers: H,
      body: JSON.stringify({ uiLanguage: 'zh', accent: 'amber' }),
    })

    const mk = async (body) =>
      (await (await fetch(`${APP_URL}/api/tasks`, { method: 'POST', headers: H, body: JSON.stringify(body) })).json()).data

    const depA = await mk({ title: '依赖A' })
    const depB = await mk({ title: '依赖B', dependsOn: [depA.id] })
    const plain = await mk({ title: '普通C' })

    await evaluate(`
      localStorage.removeItem('chaos.ui')
      localStorage.setItem('chaos.token', ${JSON.stringify(token)})
      return true
    `)
    await send('Page.enable', {})
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    })
    await send('Page.reload', { ignoreCache: true })
    await sleep(2500)

    const ready = await waitFor(evaluate, `document.querySelectorAll('[data-testid="task-card"]').length >= 3`)
    check('看板加载出 3 张任务卡', ready)
    check('顶栏显示 8.0.0', await evaluate(`return document.body.innerText.toUpperCase().includes('V8.0.0')`))

    /* ---------- 依赖 ---------- */
    const blocked = await evaluate(`
      const card = document.querySelector('[data-task-id="${depB.id}"]')
      if (!card) return null
      const start = [...card.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Start')
      return {
        text: card.innerText,
        disabled: Boolean(start && start.disabled),
      }
    `)
    check('依赖未完成的卡片显示「等待依赖」', Boolean(blocked && blocked.text.includes('等待依赖 1')), blocked?.text?.slice(0, 80) || '')
    check('依赖未完成时 Start 被禁用', Boolean(blocked && blocked.disabled))

    /* ---------- 命令面板 ---------- */
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true`)
    const paletteOpen = await waitFor(evaluate, `document.querySelector('[role="dialog"] input')`, 5000)
    check('Ctrl+K 打开命令面板', paletteOpen)
    await evaluate(`
      const el = document.querySelector('[role="dialog"] input')
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(el, '统计')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    `)
    await sleep(500)
    check('命令面板能搜到「统计」命令', await evaluate(`return document.querySelector('[role="dialog"]')?.innerText.includes('统计')`))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    await sleep(250)
    check('Escape 关闭命令面板', await evaluate(`return !document.querySelector('[role="dialog"]')`))

    /* ---------- 快捷键帮助 ---------- */
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', ctrlKey: true, bubbles: true })); return true`)
    await sleep(250)
    check('Ctrl+/ 打开快捷键帮助', await evaluate(`return document.querySelector('[role="dialog"]')?.innerText.includes('快捷键')`))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    await sleep(200)

    /* ---------- 设置：语言 / 强调色 / 新面板入口 ---------- */
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); return true`)
    await sleep(400)
    const settingsText = await evaluate(`return document.body.innerText`)
    check('设置打开', settingsText.includes('运行设置'))
    check('设置包含派单策略', settingsText.includes('自动派单策略'))
    check('设置包含桌面集成', settingsText.includes('桌面集成'))

    const clickedEnglish = await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'English')
      if (!btn) return false
      btn.click()
      return true
    `)
    await sleep(500)
    check('切换到 English', clickedEnglish && (await evaluate(`return document.body.innerText.includes('Settings') || document.body.innerText.includes('Backlog')`)))
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '中文')
      if (btn) btn.click()
      return true
    `)
    await sleep(400)

    const accentOk = await evaluate(`
      const btn = document.querySelector('button[title="sky"]')
      if (!btn) return null
      btn.click()
      return document.documentElement.dataset.accent
    `)
    check('强调色切换到 sky', accentOk === 'sky', String(accentOk))
    await evaluate(`
      const btn = document.querySelector('button[title="amber"]')
      if (btn) btn.click()
      return true
    `)
    await sleep(300)

    /* ---------- 工具链 ---------- */
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('工具链'))
      if (btn) btn.click()
      return true
    `)
    await sleep(1200)
    const toolText = await evaluate(`return document.querySelector('[role="dialog"]')?.innerText || ''`)
    check('工具链面板打开', toolText.includes('运行环境 / 工具链'))
    check('工具链检测到 Claude Code', toolText.includes('Claude Code CLI') && toolText.includes('已安装'))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    await sleep(300)

    /* ---------- 统计 / 诊断 / 备份 ---------- */
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); return true`)
    await sleep(300)
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('统计'))
      if (btn) btn.click()
      return true
    `)
    await sleep(700)
    check('统计面板打开', await evaluate(`return document.body.innerText.includes('任务总数')`))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    await sleep(300)

    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); return true`)
    await sleep(300)
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('健康诊断'))
      if (btn) btn.click()
      return true
    `)
    await sleep(900)
    check('诊断面板打开', await evaluate(`return document.body.innerText.includes('检查项')`))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    await sleep(300)

    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: ',', ctrlKey: true, bubbles: true })); return true`)
    await sleep(300)
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('备份') && b.textContent.includes('🗄'))
      if (btn) btn.click()
      return true
    `)
    await sleep(700)
    const backupText1 = await evaluate(`return document.body.innerText`)
    check('备份面板打开', backupText1.includes('立即备份'))
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '立即备份')
      if (btn) btn.click()
      return true
    `)
    await sleep(900)
    const backupText2 = await evaluate(`return document.body.innerText`)
    check('手动备份创建成功', backupText2.includes('手动') && backupText2.includes('.db'))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    await sleep(300)

    /* ---------- 新建任务：模板 / 依赖 / 流水线 ---------- */
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true })); return true`)
    await sleep(500)
    const newTaskText = await evaluate(`return document.body.innerText`)
    check('新建任务包含模板选择', newTaskText.includes('任务模板'))
    check('新建任务包含高级依赖入口', newTaskText.includes('高级：流水线'))
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('高级：流水线'))
      if (btn) btn.click()
      return true
    `)
    await sleep(300)
    const advancedText = await evaluate(`return document.body.innerText`)
    check('高级区包含父任务与前置任务', advancedText.includes('父任务') && advancedText.includes('前置任务'))
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
    await sleep(300)

    /* ---------- 批量选择 ---------- */
    const bulk = await evaluate(`
      const card = document.querySelector('[data-task-id="${plain.id}"]')
      const box = card?.querySelector('input[type=checkbox]')
      if (!box) return null
      box.click()
      return true
    `)
    await sleep(400)
    check('勾选任务后出现批量操作条', Boolean(bulk) && (await evaluate(`return document.body.innerText.includes('已选 1 个任务')`)))
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '取消选择')
      if (btn) btn.click()
      return true
    `)
    await sleep(300)
    check('批量操作条可关闭', await evaluate(`return !document.body.innerText.includes('已选 1 个任务')`))

    /* ---------- Watt Toolkit 提示 ---------- */
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })); return true`)
    await sleep(300)
    await evaluate(`
      const el = document.querySelector('[role="dialog"] input')
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(el, 'Watt')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    `)
    await sleep(500)
    await evaluate(`
      const btn = [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.includes('Watt Toolkit 提示'))
      if (btn) btn.click()
      return true
    `)
    await sleep(400)
    check('Watt Toolkit 提示可打开', await evaluate(`return document.body.innerText.includes('建议安装 Watt Toolkit')`))
    await evaluate(`
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '稍后')
      if (btn) btn.click()
      return true
    `)
    await sleep(300)
    check('Watt Toolkit 提示可稍后关闭', await evaluate(`return !document.body.innerText.includes('建议安装 Watt Toolkit')`))

    /* ---------- 主题 / 语言持久化 ---------- */
    const persisted = await evaluate(`
      const raw = JSON.parse(localStorage.getItem('chaos.ui') || '{}')
      return { accent: raw.accent, language: raw.language, wattSnoozedUntil: raw.wattSnoozedUntil }
    `)
    check('强调色与语言已持久化', persisted.accent === 'amber' && persisted.language === 'zh', JSON.stringify(persisted))
  } finally {
    ws.close()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length) {
    console.log('失败的检查项：')
    for (const f of failed) console.log(`  - ${f.name}${f.extra ? `  ${f.extra}` : ''}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('[e2e-v8] 失败:', err.stack || err.message)
  process.exit(1)
})
