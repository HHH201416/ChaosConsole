'use strict'

/**
 * 回归脚本：针对这一轮修掉的几个后端缺陷，逐条复现「修之前会错、修之后正确」。
 * 用模拟执行（CHAOS_FORCE_MOCK=1），一回合大约 8 秒。
 * 用法：node scripts/regress.js（或 npm run regress）
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const DATA_DIR = path.join(os.tmpdir(), `chaos-regress-${Date.now()}`)
process.env.CHAOS_DATA_DIR = DATA_DIR
process.env.CHAOS_FORCE_MOCK = '1'
process.env.CHAOS_PORT = '43555'

const server = require('../server/index.js')
const store = require('../server/store.js')
const queue = require('../server/queue.js')
const dbMod = require('../server/db.js')

const PORT = 43555
const BASE = `http://127.0.0.1:${PORT}`
let TOKEN = ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
function check(name, ok, extra = '') {
  results.push({ name, ok })
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra ? `  ${extra}` : ''}`)
}

async function api(method, p, body) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-chaos-token': TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  let j = null
  try {
    j = await r.json()
  } catch (_) {}
  return { status: r.status, body: j }
}

const MOCK_TURN_MS = 9000 // 模拟回合总时长约 7.8s，留点余量

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  await server.start()
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: process.env.CHAOS_AUTH_CODE || 'Hyc13579' }),
  })
  TOKEN = (await login.json()).token

  console.log('\n=== 后端缺陷回归 ===\n')

  /* ---- 1. 用户手动完成的任务，不该被回合结果拽回「待处理」 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '回归-手动完成', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(500)
    await api('POST', `/api/tasks/${t.id}/done`)
    const justAfter = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
    await sleep(MOCK_TURN_MS)
    const after = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
    check(
      '手动「完成」后，回合结束时不再被改回其它列',
      justAfter.status === 'complete' && after.status === 'complete' && after.runState === 'done',
      `立即=${justAfter.status}/${justAfter.runState} 回合后=${after.status}/${after.runState}`,
    )
  }

  /* ---- 2. 拖到需要输入（取消运行中回合）也不该被拽走 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '回归-拖动取消', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(500)
    await api('POST', `/api/tasks/${t.id}/move`, { status: 'needs_input' })
    await sleep(MOCK_TURN_MS)
    const after = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
    check('拖到「需要输入」后保持原位', after.status === 'needs_input', `实际=${after.status}/${after.runState}`)
  }

  /* ---- 3. 中途换人：原来的员工要被放回空闲 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '回归-换人', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(400)
    const firstAgentId = (await api('GET', `/api/tasks/${t.id}`)).body.data.task.agentId
    const idle = store.listAgents().find((a) => a.id !== firstAgentId && a.status === 'idle')
    await api('POST', `/api/tasks/${t.id}/assign`, { agentId: idle.id })
    await sleep(MOCK_TURN_MS)
    const first = store.getAgent(firstAgentId)
    check('换人后原员工被释放为空闲', first.status === 'idle', `${first.functionLabel} 状态=${first.status}`)
  }

  /* ---- 4. 删除运行中的任务：进程要停、不能留下孤儿记录 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '回归-删除运行中', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(600)
    const runningBefore = (await api('GET', `/api/tasks/${t.id}`)).body.data.isRunning
    await api('DELETE', `/api/tasks/${t.id}`)
    await sleep(3000)
    const orphanMsg = dbMod.all('SELECT COUNT(*) AS n FROM messages WHERE task_id = ?', [t.id])[0].n
    const orphanEvt = dbMod.all('SELECT COUNT(*) AS n FROM events WHERE task_id = ?', [t.id])[0].n
    check('删除运行中的任务会先停掉进程', runningBefore === true)
    check('删除后不再写入孤儿记录', orphanMsg === 0 && orphanEvt === 0, `messages=${orphanMsg} events=${orphanEvt}`)
  }

  /* ---- 5. 没有空闲员工时，拖到「进行中」要报错并且退回原列 ---- */
  {
    const all = store.listAgents()
    for (const a of all) store.updateAgent(a.id, { status: 'working' })
    const t = (await api('POST', '/api/tasks', { title: '回归-无人可派', description: 'x' })).body.data
    const moved = await api('POST', `/api/tasks/${t.id}/move`, { status: 'in_progress' })
    const after = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
    check(
      '没有空闲员工时移动失败并退回原列',
      moved.status === 400 && after.status === 'backlog',
      `HTTP ${moved.status} 状态=${after.status}`,
    )
    for (const a of all) store.updateAgent(a.id, { status: 'idle' })
  }

  /* ---- 6. 同一任务不会同时跑两个回合 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '回归-并发回合', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(1200)
    const msgs = dbMod.all('SELECT COUNT(*) AS n FROM messages WHERE task_id = ?', [t.id])[0].n
    const evts = dbMod.all("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND name = '开始执行'", [t.id])[0].n
    check('重复 start 不会跑起两个回合', evts === 1, `「开始执行」事件 ${evts} 次，消息 ${msgs} 条`)
    await api('POST', `/api/tasks/${t.id}/cancel`)
    await sleep(600)

    // 取消之后再起一次：能跑起来就说明「回合进行中」的标记已经释放干净
    // （这个标记包在 try/finally 里，任何提前 return 都必须把它撤掉，
    //   否则任务会被永久锁死、再也起不来）
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(1500)
    const evts2 = dbMod.all("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND name = '开始执行'", [t.id])[0].n
    check('取消后可以重新起跑（回合标记没有残留）', evts2 >= 2, `「开始执行」事件 ${evts2} 次`)
    await api('POST', `/api/tasks/${t.id}/cancel`)
    await sleep(600)
  }

  /* ---- 7. 员工都忙时任务要等，员工空出来后自动接上 ---- */
  {
    const agents = store.listAgents()
    for (const a of agents) store.updateAgent(a.id, { status: 'working' })
    const t = (await api('POST', '/api/tasks', { title: '回归-等待空闲员工', description: 'x' })).body.data
    const first = await api('POST', `/api/tasks/${t.id}/start`)
    const afterFail = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
    check(
      '没有空闲员工时 start 会失败而不是硬跑',
      first.status === 400 && afterFail.runState !== 'running',
      `HTTP ${first.status} runState=${afterFail.runState}`,
    )

    // 摆成「进行中但还没有 Agent」——正是一个等待调度的任务
    store.updateTask(t.id, { status: 'in_progress', runState: 'idle' })
    // 放一个员工出来：应当立刻自动接单
    store.updateAgent(agents[0].id, { status: 'idle' })
    await sleep(2500)
    const picked = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
    check(
      '员工空出来后等待中的任务自动接上',
      picked.runState === 'running' || picked.runState === 'queued',
      `runState=${picked.runState} agent=${picked.agentId}`,
    )

    await api('POST', `/api/tasks/${t.id}/cancel`)
    await sleep(600)
  }

  /* ---- 8. 一个员工不会同时跑两个任务 ---- */
  {
    // 先把员工恢复空闲，再让 t1 占住其中一个，这样才有「别的空闲员工」可改派
    for (const a of store.listAgents()) store.updateAgent(a.id, { status: 'idle' })
    const t1 = (await api('POST', '/api/tasks', { title: '回归-独占A', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t1.id}/start`)
    await sleep(900)
    const busyAgentId = (await api('GET', `/api/tasks/${t1.id}`)).body.data.task.agentId
    const busyStatus = store.getAgent(busyAgentId)?.status

    // 把第二个任务强行绑到同一个正在忙的员工上
    const t2 = (await api('POST', '/api/tasks', { title: '回归-独占B', description: 'x', agentId: busyAgentId })).body.data
    await api('POST', `/api/tasks/${t2.id}/start`)
    await sleep(1200)
    const t2now = (await api('GET', `/api/tasks/${t2.id}`)).body.data.task
    check(
      '忙的员工不会被派上第二个任务',
      t2now.agentId !== busyAgentId && (t2now.runState === 'running' || t2now.runState === 'queued'),
      `原定=${busyAgentId}(${busyStatus}) 改派=${t2now.agentId} runState=${t2now.runState}`,
    )
    await api('POST', `/api/tasks/${t1.id}/cancel`)
    await api('POST', `/api/tasks/${t2.id}/cancel`)
    await sleep(800)
  }

  await server.stop()

  const passed = results.filter((r) => r.ok).length
  console.log(`\n=== ${passed}/${results.length} 通过 ===\n`)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(async (err) => {
  console.error('回归脚本异常:', err)
  try {
    await server.stop()
  } catch (_) {}
  process.exit(1)
})
