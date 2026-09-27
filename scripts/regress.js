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

/**
 * 轮询等条件成立。自动换岗/退避这些用例的时序是「失败 → 退避 → 重跑」，
 * 总时长随重试次数变，靠固定 sleep 会变成 flaky 测试。
 */
async function waitUntil(fn, timeoutMs = 60000, step = 400) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > deadline) return null
    await sleep(step)
  }
}

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

  /* ---- 12. 「取消」的落地契约：换岗/自动重试这些新路径不许改变它 ----
   *
   * 注意：模拟执行器里取消走的是内存标记，所以这一例在修复前后**都**会通过 ——
   * 它钉的是契约，不是那个 Windows 上的落地 bug。真机上取消走 `taskkill /T /F`，
   * close 回来是 code=1/signal=null，修复前会被判成「退出码 1 的失败」落进
   * needs_input/error；修复后由 runner 的 stopIntent 决定落地，不再依赖信号。 */
  {
    const t = (await api('POST', '/api/tasks', { title: '回归-取消落地', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(500)
    await api('POST', `/api/tasks/${t.id}/cancel`)
    await sleep(MOCK_TURN_MS)
    const after = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
    check(
      '「取消」落成 待处理/已取消（而不是 需要输入/出错）',
      after.status === 'backlog' && after.runState === 'cancelled',
      `实际=${after.status}/${after.runState}`,
    )
  }

  /* ---- 13. 流水线解析（纯函数）＋ agent 发出的阶段指令被识别 ---- */
  {
    const pl = require('../server/pipeline.js')
    const claudeAgent = { role: 'Coder', executor: 'claude', pipeline: [] }
    const devecoAgent = { role: 'HarmonyOS', executor: 'deveco', pipeline: [] }

    const claudePipe = pl.resolve({ pipeline: [] }, claudeAgent, true, null)
    const devecoPipe = pl.resolve({ pipeline: [] }, devecoAgent, true, null)
    check(
      '默认流水线按执行器分：claude 走 方案→编码→构建→测试，deveco 走鸿蒙岗',
      pl.describe(claudePipe) === '方案 → 编码 → 构建 → 测试' &&
        pl.stageRole(claudePipe, 'build') === 'DevOps' &&
        pl.stageRole(devecoPipe, 'build') === 'HarmonyBuild',
      `${pl.describe(claudePipe)} / ${pl.describe(devecoPipe)}`,
    )

    // 任务覆盖 > 岗位；总闸关掉则一律为空
    const overridden = pl.resolve(
      { pipeline: [{ stage: 'x', role: 'Writer' }] },
      { role: 'Coder', executor: 'claude', pipeline: [{ stage: 'y', role: 'Analyst' }] },
      true,
      null,
    )
    check(
      '任务上的流水线覆盖岗位的，关掉总闸一律为空',
      overridden.length === 1 &&
        overridden[0].stage === 'x' &&
        pl.resolve({ pipeline: [] }, claudeAgent, false, null).length === 0,
    )

    check(
      '阶段后继与校验：nextAfter 取顺序后继、末尾返回 null；非法流水线被拒',
      pl.nextAfter(claudePipe, 'code').stage === 'build' &&
        pl.nextAfter(claudePipe, 'test') === null &&
        pl.nextAfter(claudePipe, '').stage === 'plan' &&
        pl.validate([{ stage: 'a', role: '不存在的岗位' }], ['Coder']) !== null &&
        pl.validate([{ stage: 'a', role: 'Coder' }], ['Coder']) === null,
    )

    const t = (await api('POST', '/api/tasks', { title: '[STAGE:code→build] 回归-阶段指令', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(MOCK_TURN_MS)
    const detail = (await api('GET', `/api/tasks/${t.id}`)).body.data
    const stageEvents = detail.events.filter((e) => e.name === '阶段指令')
    check(
      'agent 输出里的 CHAOS_STAGE 指令被识别并记成事件',
      stageEvents.length === 1 && /CHAOS_STAGE/.test(stageEvents[0].content),
      `阶段指令事件 ${stageEvents.length} 条`,
    )

    // 回归：任务级流水线必须挺过 updateTask（曾经被「只留字符串元素」的序列化
    // 静默清成 []，表现为「流水线建完就没了」）
    const tp = (
      await api('POST', '/api/tasks', {
        title: '回归-流水线不被清空',
        description: 'x',
        pipeline: [
          { stage: 'plan', role: 'Architect' },
          { stage: 'code', role: 'Coder' },
        ],
      })
    ).body.data
    await api('POST', `/api/tasks/${tp.id}/start`)
    await sleep(800)
    const tpAfter = (await api('GET', `/api/tasks/${tp.id}`)).body.data.task
    check(
      '任务级流水线在起跑后仍然完整（且阶段定位到第一站）',
      tpAfter.pipeline.length === 2 && tpAfter.pipeline[1].role === 'Coder' && tpAfter.stage === 'plan',
      `pipeline=${tpAfter.pipeline.length} 站，stage=${tpAfter.stage}`,
    )
    await api('DELETE', `/api/tasks/${tp.id}`)

    // 没有显式流水线的任务：起跑时把默认链快照到任务上（卡片徽章/换岗弹窗要用）
    const td = (await api('POST', '/api/tasks', { title: '回归-默认流水线快照', description: 'x' })).body.data
    await api('POST', `/api/tasks/${td.id}/start`)
    await sleep(800)
    const tdAfter = (await api('GET', `/api/tasks/${td.id}`)).body.data.task
    check(
      '没有显式流水线的任务会快照 executor 默认链（claude 四站）',
      tdAfter.pipeline.length === 4 && tdAfter.stage === 'plan',
      `pipeline=${tdAfter.pipeline.length} 站，stage=${tdAfter.stage}`,
    )
    await api('DELETE', `/api/tasks/${td.id}`)
  }

  /* ---- 14. 失败自动换岗（不限次数 + 护栏 1） ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '[FAIL_ONCE] 回归-失败换岗', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(800)
    const firstAgent = (await api('GET', `/api/tasks/${t.id}`)).body.data.task.agentId

    const done = await waitUntil(async () => {
      const task = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
      return task.runState === 'done' || task.runState === 'error' ? task : null
    })

    check(
      '失败一次后自动换岗重试并最终完成（attempts=1、换了人）',
      Boolean(done) && done.attempts === 1 && done.agentId !== firstAgent && done.status === 'complete',
      done
        ? `attempts=${done.attempts} 换人=${done.agentId !== firstAgent} 终态=${done.status}/${done.runState}`
        : '超时没等到终态',
    )
  }

  /* ---- 15. 换岗/重试期间排队的补充指令只投递一次 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '[FAIL_ONCE] 回归-换岗不丢指令', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(1500)
    await api('POST', `/api/tasks/${t.id}/input`, { text: '把接口文档也补上' })

    await waitUntil(async () => {
      const task = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
      return task.runState === 'done' || task.runState === 'error' ? task : null
    })
    const detail = (await api('GET', `/api/tasks/${t.id}`)).body.data
    const delivered = detail.messages.filter((m) => m.content.includes('把接口文档也补上') && m.role !== 'user')
    check(
      '换岗/重试期间排队的指令最终只投递给 Agent 一次',
      delivered.length === 1,
      `投递 ${delivered.length} 次`,
    )
  }

  /* ---- 16. 运行中手动换岗：不是取消、原岗位释放、任务继续 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '回归-运行中手动换岗', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(1500)
    const before = (await api('GET', `/api/tasks/${t.id}`)).body.data.task.agentId

    const r = await api('POST', `/api/tasks/${t.id}/handoff`, { role: 'Writer', reason: '回归用例手动换岗' })
    await sleep(1200)
    const detail = (await api('GET', `/api/tasks/${t.id}`)).body.data
    const oldAgent = store.getAgent(before)

    check(
      '运行中手动换岗：没落回待处理、换了岗位、原岗位被释放、有换岗事件',
      r.status === 200 &&
        detail.task.status === 'in_progress' &&
        detail.task.agentId !== before &&
        detail.task.runState !== 'cancelled' &&
        oldAgent &&
        oldAgent.status === 'idle' &&
        detail.events.some((e) => e.name === '换岗'),
      `终态=${detail.task.status}/${detail.task.runState} 换人=${detail.task.agentId !== before} 原岗位=${
        oldAgent && oldAgent.status
      }`,
    )

    // 让它跑完，别把还在跑的回合留给后面的用例
    await waitUntil(async () => {
      const task = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
      return task.runState === 'done' || task.runState === 'error' ? task : null
    })
  }

  /* ---- 17. 重试上限：到顶就转人工，不无限烧下去 ---- */
  {
    await api('POST', '/api/settings', { maxAttempts: 2 })
    const t = (await api('POST', '/api/tasks', { title: '[FAIL_ALWAYS] 回归-重试上限', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)

    const settled = await waitUntil(async () => {
      const task = (await api('GET', `/api/tasks/${t.id}`)).body.data.task
      return task.runState === 'error' || task.runState === 'done' ? task : null
    })
    const detail = (await api('GET', `/api/tasks/${t.id}`)).body.data
    const handoverEvents = detail.events.filter((e) => e.name === '转人工')

    check(
      '达到重试上限后转人工（attempts=3、停在需要输入）',
      Boolean(settled) &&
        detail.task.status === 'needs_input' &&
        detail.task.runState === 'error' &&
        detail.task.attempts === 3 &&
        handoverEvents.length === 1,
      `attempts=${detail.task.attempts} 转人工事件=${handoverEvents.length} 终态=${detail.task.status}/${detail.task.runState}`,
    )

    await api('POST', '/api/settings', { maxAttempts: 0 })
  }

  /* ---- 18. 停止重试：退避中喊停就不再自动换岗 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '[FAIL_ALWAYS] 回归-停止重试', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)

    // 等它第一次失败并进入退避
    await waitUntil(async () => {
      const events = (await api('GET', `/api/tasks/${t.id}`)).body.data.events
      return events.some((e) => e.name === '自动换岗') ? true : null
    })

    const r = await api('POST', `/api/tasks/${t.id}/retry`, { enabled: false })
    await sleep(600)
    const mid = (await api('GET', `/api/tasks/${t.id}`)).body.data
    const countBefore = mid.events.filter((e) => e.name === '自动换岗').length
    await sleep(5000)
    const after = (await api('GET', `/api/tasks/${t.id}`)).body.data

    check(
      '停止重试后不再自动换岗，任务停在「需要输入」',
      r.status === 200 &&
        after.task.status === 'needs_input' &&
        after.task.runState === 'waiting' &&
        after.events.filter((e) => e.name === '自动换岗').length === countBefore,
      `终态=${after.task.status}/${after.task.runState} 换岗事件 ${countBefore} → ${
        after.events.filter((e) => e.name === '自动换岗').length
      }`,
    )
  }

  /* ---- 19. 护栏 1/2 的机制：候选被排除光就没有下一个 ---- */
  {
    const allIds = new Set(store.listAgents().map((a) => a.id))
    const none = queue.pickAgentForStage({ title: 'x', description: '' }, 'Writer', { exclude: allIds })
    const some = queue.pickAgentForStage({ title: 'x', description: '' }, 'Writer', { exclude: new Set() })
    check(
      '排除掉所有岗位后 pickAgentForStage 返回 null（护栏「试过的不再用」的机制）',
      none === null && some !== null,
      none === null ? '排除后为 null' : '排除后仍有候选',
    )
  }

  /* ---- 20. 按岗位挂载 MCP（离线断言，不真的起 CLI） ---- */
  {
    const scope = require('../server/mcp-scope.js')
    const mcpMod = require('../server/mcp.js')
    const agents = store.listAgents()
    const coder = agents.find((a) => a.role === 'Coder')
    const harmony = agents.find((a) => a.role === 'HarmonyBuild')

    const coderList = scope.resolveRoleMcp(coder)
    const harmonyList = scope.resolveRoleMcp(harmony)
    check(
      '岗位默认挂载：鸿蒙岗拿到 deveco-studio、代码岗拿到 playwright，两边都带换岗工具',
      harmonyList.includes('deveco-studio') &&
        !coderList.includes('deveco-studio') &&
        coderList.includes('playwright') &&
        coderList.includes('handoff') &&
        harmonyList.includes('handoff'),
      `代码岗 ${coderList.length} 项 / 鸿蒙岗 ${harmonyList.length} 项`,
    )

    const task = {
      id: 'task_scope_probe',
      title: 'x',
      description: 'x',
      cwd: DATA_DIR,
      stage: 'code',
      pipeline: [],
    }
    const realBin = require('../server/runner.js').resolveClaudeBin()
    const cfgPath = scope.buildClaudeConfig(task, harmony, { token: 'tok-regress', claudeBin: realBin })
    let cfgOk = false
    if (cfgPath) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      const names = Object.keys(cfg.mcpServers)
      const env = cfg.mcpServers['chaos-handoff']?.env || {}
      cfgOk =
        names.includes('chaos-deveco-studio') &&
        !names.includes('chaos-playwright') &&
        env.CHAOS_TASK_ID === 'task_scope_probe' &&
        env.CHAOS_HANDOFF_TOKEN === 'tok-regress' &&
        Boolean(env.CHAOS_SERVER_URL)
      scope.removeRunFile(task.id)
    }
    check(
      'claude 侧：运行期配置只含本岗的服务器 + 带令牌的换岗工具，跑完即删',
      cfgOk && !fs.existsSync(scope.runFilePath(task.id)),
      cfgPath ? '配置已按岗位裁剪' : '（本机 claude 不支持 --mcp-config，走了降级）',
    )

    const nullCfg = scope.buildClaudeConfig(task, harmony, { token: 't', claudeBin: 'no-such-claude-bin' })
    check('claude 不支持 --mcp-config 时降级为 null，而不是抛错或空跑', nullCfg === null)

    const env = scope.buildDevecoEnv(task, harmony, { token: 'tok-regress' })
    const m = JSON.parse(env.DEVECO_CONFIG_CONTENT || '{}').mcp || {}
    const onIds = Object.entries(m).filter(([, v]) => v.enabled !== false).map(([k]) => k)
    const offIds = Object.entries(m).filter(([, v]) => v.enabled === false).map(([k]) => k)
    check(
      'deveco 侧：角色要的启用、其余显式 enabled:false（否则全局注册会一起生效）',
      onIds.includes('chaos-deveco-studio') && !onIds.includes('chaos-playwright') && offIds.length > 0,
      `启用 ${onIds.length} 个 / 显式关闭 ${offIds.length} 个`,
    )
    check(
      '本地服务器复制到稳定目录（含 deveco-studio 要调的 Python 脚本）',
      mcpMod.entryPath(mcpMod.CATALOG_BY_ID.handoff).startsWith(mcpMod.MCP_DIR) &&
        mcpMod.entryPath(mcpMod.CATALOG_BY_ID['deveco-studio']).startsWith(mcpMod.MCP_DIR) &&
        fs.existsSync(mcpMod.stableLocalEntry('handoff')) &&
        fs.existsSync(path.join(mcpMod.MCP_DIR, 'servers', 'deveco-studio', 'tools', 'deveco-studio.py')),
    )

    // 打包清单必须带上那个 .py —— 不带的话打包版里 deveco-studio 一调用就找不到脚本
    // （开发模式脚本就在仓库里，所以这个坑只在打包版暴露，必须靠清单断言钉住）
    check(
      '打包清单包含 deveco-studio 依赖的 Python 脚本',
      (require('../package.json').build.files || []).includes('scripts/deveco-studio.py'),
    )
  }

  /* ---- 21. 换岗的 MCP 工具通道（内部接口 + 一次性令牌） ---- */
  {
    const runtime = require('../server/runtime.js')
    const t = (await api('POST', '/api/tasks', { title: '回归-MCP 换岗通道', description: 'x' })).body.data
    await api('POST', `/api/tasks/${t.id}/start`)
    await sleep(1200)
    const before = (await api('GET', `/api/tasks/${t.id}`)).body.data.task.agentId

    const bad = await fetch(`${BASE}/api/internal/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: t.id, token: 'not-the-token', role: 'Writer', reason: 'x' }),
    })
    check('内部换岗接口拒绝无效令牌（不依赖登录态，只认一次性令牌）', bad.status === 403, `HTTP ${bad.status}`)

    const token = runtime.mintHandoffToken(t.id)
    const okRes = await fetch(`${BASE}/api/internal/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskId: t.id,
        token,
        role: 'Writer',
        reason: '来自 MCP 工具',
        summary: '做到一半，剩下的交给文档岗',
      }),
    })
    const okBody = await okRes.json()
    await sleep(1500)
    const after = (await api('GET', `/api/tasks/${t.id}`)).body.data
    check(
      '用一次性令牌调内部接口能换岗（Agent 主动交接那条通道）',
      okRes.status === 200 &&
        okBody.ok !== false &&
        after.task.agentId !== before &&
        after.events.some((e) => e.name === '换岗'),
      `HTTP ${okRes.status} 换人=${after.task.agentId !== before}`,
    )
    check(
      '交接说明里带上了 Agent 自己写的 summary',
      (after.task.handoffNote || '').includes('做到一半'),
      `handoffNote=${(after.task.handoffNote || '').slice(0, 24)}…`,
    )

    runtime.revokeHandoffToken(t.id)
    const afterRevoke = await fetch(`${BASE}/api/internal/handoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: t.id, token, role: 'Writer', reason: 'x' }),
    })
    check('令牌吊销后同一条令牌不再可用', afterRevoke.status === 403, `HTTP ${afterRevoke.status}`)

    await api('DELETE', `/api/tasks/${t.id}`)
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
