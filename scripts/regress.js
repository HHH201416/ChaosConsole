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

  /* ---- 9. 老库要能补上后来新增的岗位（鸿蒙从 1 个拆成 10 个） ---- */
  {
    // 摆出「老库」的样子：只留下鸿蒙应用开发那一个 DevEco 岗位。
    // 这里必须绕过 store.deleteAgent 直接删行 —— 走 deleteAgent 会被记成
    // 「用户主动删过」，那正是后面那条断言要否定的行为。
    const HARMONY_KEEP = 'HarmonyOS'
    for (const a of store.listAgents()) {
      if (a.executor === 'deveco' && a.role !== HARMONY_KEEP) {
        dbMod.run('DELETE FROM agents WHERE id = ?', [a.id])
      }
    }
    const before = store.listAgents().length
    store.bootstrap()
    const rows = store.listAgents()
    const deveco = rows.filter((a) => a.executor === 'deveco')
    check(
      '老库启动时补齐缺席的默认岗位（鸿蒙补到 10 个）',
      deveco.length === 10,
      `补前 ${before} 人 / 补后 ${rows.length} 人，DevEco ${deveco.length} 个`,
    )

    // 只补不删不改：改过提示词的岗位不能被覆盖
    const coder = rows.find((a) => a.role === 'Coder')
    store.updateAgent(coder.id, { systemPrompt: '被用户改过的提示词', model: 'opus' })
    store.bootstrap()
    const coderAfter = store.getAgent(coder.id)
    check(
      '补齐不会覆盖用户改过的岗位',
      coderAfter.systemPrompt === '被用户改过的提示词' && coderAfter.model === 'opus',
    )

    // 用户主动删掉的默认岗位不该在下次启动复活
    const designer = rows.find((a) => a.role === 'Designer')
    store.deleteAgent(designer.id)
    store.bootstrap()
    check('用户删掉的默认岗位重启后不复活', !store.listAgents().some((a) => a.role === 'Designer'))
  }

  /* ---- 10. 匹配不上关键词的任务交给「日常对话」兜底 ---- */
  {
    const makeTask = (title, description = '') => ({ title, description, tags: [] })
    // 只留一个候选在岗，验证单独命中时的归属
    const idleOnly = (role) => {
      for (const a of store.listAgents()) {
        store.updateAgent(a.id, { status: a.role === role ? 'idle' : 'working' })
      }
    }

    idleOnly('Chat')
    const smalltalk = queue.pickIdleAgent(makeTask('今天天气不错，随便聊聊'))
    check('闲聊类内容 → 日常对话', smalltalk?.role === 'Chat', `派给 ${smalltalk?.role}`)

    const unmatched = queue.pickIdleAgent(makeTask('嗯'))
    check('没命中任何关键词的任务 → 日常对话兜底', unmatched?.role === 'Chat', `派给 ${unmatched?.role}`)

    idleOnly('Coder')
    const dev = queue.pickIdleAgent(makeTask('修一下这个组件的报错'))
    check('开发类内容仍归代码实现（兜底不抢活）', dev?.role === 'Coder', `派给 ${dev?.role}`)

    idleOnly('HarmonyOS')
    const hm = queue.pickIdleAgent(makeTask('鸿蒙 ArkTS 里怎么做一个列表页面'))
    check('鸿蒙内容仍归鸿蒙应用开发', hm?.role === 'HarmonyOS', `派给 ${hm?.role}`)

    // 兜底只在「一个都没命中」时生效：有命中就走分数
    const chatAgent = store.listAgents().find((a) => a.role === 'Chat')
    const scored = queue.scoreAgent(chatAgent, makeTask('帮我写个鸿蒙界面'))
    check('有关键词命中时日常对话不靠兜底抢单', scored === 0, `得分 ${scored}`)

    for (const a of store.listAgents()) store.updateAgent(a.id, { status: 'idle' })
  }

  /* ---- 11. 下载加速镜像：URL 改写、latest.yml 解析、sha512 校验 ---- */
  {
    const dmod = require('../server/download-mirror.js')
    const ghUrl =
      'https://github.com/HHH201416/ChaosConsole/releases/download/v1.0.1/ChaosConsole-Setup-1.0.1.exe'

    check(
      '镜像前缀规范化：去尾斜杠、非法值一律当没配',
      dmod.normalizeMirror('https://gh-proxy.com/') === 'https://gh-proxy.com' &&
        dmod.normalizeMirror('  https://ghfast.top  ') === 'https://ghfast.top' &&
        dmod.normalizeMirror('gh-proxy.com') === '' &&
        dmod.normalizeMirror('ftp://x.com') === '' &&
        dmod.normalizeMirror('') === '',
    )

    check(
      '只改写 github.com 的地址，其它原样返回',
      dmod.applyMirror(ghUrl, 'https://gh-proxy.com') === `https://gh-proxy.com/${ghUrl}` &&
        dmod.applyMirror('https://api.github.com/x', 'https://gh-proxy.com') ===
          'https://api.github.com/x' &&
        dmod.applyMirror(ghUrl, '') === ghUrl,
    )

    const yml = [
      'version: 3.0.0',
      'files:',
      '  - url: ChaosConsole-Setup-3.0.0.exe',
      '    sha512: AAA=',
      '    size: 91100997',
      '    blockMapSize: 93119',
      "path: 'ChaosConsole-Setup-3.0.0.exe'",
      'sha512: AAA=',
      "releaseDate: '2026-09-27T03:53:23.783Z'",
    ].join('\n')
    const info = dmod.parseLatestYml(yml)
    check(
      '解析 latest.yml（版本 / 文件 / sha512 / size）',
      info.version === '3.0.0' &&
        info.files.length === 1 &&
        info.files[0].url === 'ChaosConsole-Setup-3.0.0.exe' &&
        info.files[0].sha512 === 'AAA=' &&
        info.files[0].size === 91100997 &&
        info.files[0].blockMapSize === 93119 &&
        info.sha512 === 'AAA=',
      `${info.version} / ${info.files.length} 项`,
    )

    check(
      '按文件名取 sha512：命中就取；只有一个文件时退回它；没有基准返回 null',
      dmod.pickFileHash(info, 'ChaosConsole-Setup-3.0.0.exe')?.sha512 === 'AAA=' &&
        dmod.pickFileHash(info, 'ChaosConsole-Setup-9.9.9.exe')?.sha512 === 'AAA=' &&
        dmod.pickFileHash({ files: [], sha512: '' }, 'x.exe') === null,
    )

    const probe = path.join(DATA_DIR, 'sha-probe.bin')
    fs.writeFileSync(probe, 'chaos-mirror-probe')
    const good = dmod.sha512Of(probe)
    check(
      'sha512 校验：对得上通过、对不上拒绝、没基准标记为「跳过」而不是「通过」',
      dmod.verifyFile(probe, good).ok === true &&
        dmod.verifyFile(probe, 'WRONG=').ok === false &&
        dmod.verifyFile(probe, '').ok === true &&
        dmod.verifyFile(probe, '').skipped === true,
    )

    // 语义：没写过 = 用后端默认值（默认启用）；写过空串 = 显式关掉，不再退回默认
    const initial = (await api('GET', '/api/system')).body.data
    check(
      '镜像默认启用（没写过设置时取后端默认值）',
      initial.downloadMirror === 'https://gh-proxy.com',
      `当前「${initial.downloadMirror}」`,
    )

    // 非法值必须在写库前被挡住：不能静默存成空值让用户以为设上了
    const bad = await api('POST', '/api/settings', { downloadMirror: 'gh-proxy.com' })
    const goodSet = await api('POST', '/api/settings', { downloadMirror: 'https://ghfast.top/' })
    const afterSet = (await api('GET', '/api/system')).body.data
    check(
      '非法镜像被拒（400），合法值规范化后入库',
      bad.status === 400 && goodSet.status === 200 && afterSet.downloadMirror === 'https://ghfast.top',
      `非法 HTTP ${bad.status}，存下来的是「${afterSet.downloadMirror}」`,
    )

    await api('POST', '/api/settings', { downloadMirror: '' })
    const off = (await api('GET', '/api/system')).body.data
    check('显式写空 = 关掉（不会又退回默认值）', off.downloadMirror === '', `当前「${off.downloadMirror}」`)
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
