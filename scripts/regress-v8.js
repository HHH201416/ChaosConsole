'use strict'

/**
 * 8.0.0 新功能后端回归。
 *
 * 自起服务（独立端口 / 临时数据目录，模拟执行），覆盖：
 * 数据库迁移、模板、依赖、派单策略、批量、搜索、统计、诊断、备份、
 * 工作区导入导出、工具链白名单。
 *
 * 用法：npm run regress:v8
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const DATA_DIR = path.join(os.tmpdir(), `chaos-regress-v8-${Date.now()}`)
process.env.CHAOS_DATA_DIR = DATA_DIR
process.env.CHAOS_FORCE_MOCK = '1'
process.env.CHAOS_PORT = '43556'

const server = require('../server/index.js')
const store = require('../server/store.js')
const db = require('../server/db.js')
const queue = require('../server/queue.js')
const backup = require('../server/backup.js')
const workspace = require('../server/workspace.js')
const stats = require('../server/stats.js')
const diagnostics = require('../server/diagnostics.js')
const toolchain = require('../server/toolchain.js')

const PORT = 43556
const BASE = `http://127.0.0.1:${PORT}`
let TOKEN = ''

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

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  fs.mkdirSync(DATA_DIR, { recursive: true })
  await server.start()
  const login = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: process.env.CHAOS_AUTH_CODE || 'Hyc13579' }),
  })
  TOKEN = (await login.json()).token

  console.log('\n=== ChaosConsole 8.0.0 · 后端回归 ===\n')

  /* ---- 1. 数据库迁移 ---- */
  {
    const cols = (table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name)
    const taskCols = cols('tasks')
    check(
      '新库包含依赖/父子/完成时间字段',
      taskCols.includes('parent_id') && taskCols.includes('depends_on') && taskCols.includes('completed_at'),
    )
    const tplCols = cols('task_templates')
    check('新库包含 task_templates 表', tplCols.includes('name') && tplCols.includes('pipeline'))
    let rolledBack = false
    try {
      db.transaction(() => {
        db.run("INSERT INTO settings (key, value) VALUES ('tx-test', '1')")
        throw new Error('rollback')
      })
    } catch (_) {
      rolledBack = true
    }
    check('事务抛错会回滚', rolledBack && !db.get("SELECT * FROM settings WHERE key = 'tx-test'"))
  }

  /* ---- 2. 任务模板 ---- */
  {
    const created = await api('POST', '/api/templates', {
      name: '回归模板',
      title: '模板标题',
      tags: ['Bash'],
      pipeline: [{ stage: 'plan', role: 'Architect' }],
    })
    check('模板创建成功', created.status === 200 && created.body.data.name === '回归模板')
    const list = await api('GET', '/api/templates')
    check('模板列表包含新模板', list.body.data.some((t) => t.id === created.body.data.id))
    const bad = await api('POST', '/api/templates', { name: '', title: 'x' })
    check('模板名必填', bad.status === 400)
    const badPipe = await api('POST', '/api/templates', {
      name: '坏流水线',
      pipeline: [{ stage: 'plan', role: '不存在的岗位' }],
    })
    check('模板流水线角色被校验', badPipe.status === 400)
    const del = await api('DELETE', `/api/templates/${created.body.data.id}`)
    check('模板可删除', del.status === 200)
  }

  /* ---- 3. 依赖 / 父子任务 ---- */
  {
    const a = (await api('POST', '/api/tasks', { title: '依赖A' })).body.data
    const b = (await api('POST', '/api/tasks', { title: '依赖B', dependsOn: [a.id] })).body.data
    check('创建依赖任务后 blocked=true', b.blocked === true && b.blockedBy.includes(a.id))
    const blockedStart = await api('POST', `/api/tasks/${b.id}/start`)
    check('依赖未完成时 start 被拒', blockedStart.status === 400 && blockedStart.body.blocked === true)

    const self = await api('POST', '/api/tasks', { title: '自依赖', dependsOn: ['__missing__'] })
    check('未知依赖被拒', self.status === 400)

    const c = (await api('POST', '/api/tasks', { title: '依赖C' })).body.data
    const link = await api('PATCH', `/api/tasks/${a.id}`, { dependsOn: [c.id] })
    check('建立依赖成功（为环测试准备）', link.status === 200)
    const cycle = await api('PATCH', `/api/tasks/${c.id}`, { dependsOn: [a.id] })
    check('依赖环被拒', cycle.status === 400, cycle.body?.error || '')

    const parent = (await api('POST', '/api/tasks', { title: '父任务' })).body.data
    const child = (await api('POST', '/api/tasks', { title: '子任务', parentId: parent.id })).body.data
    check('父子关系落库', child.parentId === parent.id)
    const detail = await api('GET', `/api/tasks/${parent.id}`)
    check('父任务详情包含子任务', detail.body.data.subtasks.some((t) => t.id === child.id))
    const parentCycle = await api('PATCH', `/api/tasks/${parent.id}`, { parentId: child.id })
    check('父子环被拒', parentCycle.status === 400)

    await api('POST', `/api/tasks/${a.id}/done`)
    const aDone = store.getTask(a.id)
    check('完成任务写入 completed_at', Boolean(aDone && aDone.completedAt > 0))
    const after = await api('GET', `/api/tasks/${b.id}`)
    check('前置任务完成后解除阻塞', after.body.data.task.blocked === false)

    const startOk = await api('POST', `/api/tasks/${b.id}/start`)
    check('解除阻塞后可以 start', startOk.status === 200)
    await api('POST', `/api/tasks/${b.id}/cancel`)

    const del = await api('DELETE', `/api/tasks/${a.id}`)
    const bAfterDelete = await api('GET', `/api/tasks/${b.id}`)
    check('删除前置任务后依赖被清理', del.status === 200 && !bAfterDelete.body.data.task.dependsOn.includes(a.id))
  }

  /* ---- 4. 派单策略 ---- */
  {
    const set = await api('POST', '/api/settings', { dispatchStrategy: 'least-busy' })
    check('派单策略可保存 least-busy', set.status === 200 && queue.dispatchStrategy() === 'least-busy')
    const bad = await api('POST', '/api/settings', { dispatchStrategy: 'nope' })
    check('非法派单策略被拒', bad.status === 400)

    const idle = store.listAgents().filter((a) => a.status === 'idle')
    check('有足够的空闲岗位用于派单测试', idle.length >= 2, `${idle.length} 个`)
    await api('POST', '/api/settings', { dispatchStrategy: 'round-robin' })
    const first = queue.pickIdleAgent({ title: '随便', description: '', tags: [] })
    const second = queue.pickIdleAgent({ title: '随便', description: '', tags: [] })
    check('round-robin 连续两次选不同岗位', Boolean(first && second && first.id !== second.id), `${first?.id} → ${second?.id}`)

    await api('POST', '/api/settings', { dispatchStrategy: 'keyword' })
    const keyword = queue.pickIdleAgent({ title: '鸿蒙 arkts 界面', description: '', tags: [] })
    check('keyword 策略能命中鸿蒙岗位', Boolean(keyword && /Harmony/i.test(keyword.role)), keyword?.role || '')
  }

  /* ---- 5. 批量操作 ---- */
  {
    const t1 = (await api('POST', '/api/tasks', { title: '批量1' })).body.data
    const t2 = (await api('POST', '/api/tasks', { title: '批量2' })).body.data
    const done = await api('POST', '/api/tasks/batch', { action: 'done', ids: [t1.id, t2.id] })
    check('批量完成返回逐条结果', done.status === 200 && done.body.results.every((r) => r.ok))
    check('批量完成后状态是 complete', store.getTask(t1.id).status === 'complete' && store.getTask(t2.id).status === 'complete')

    const partial = await api('POST', '/api/tasks/batch', { action: 'done', ids: [t1.id, 'task_missing'] })
    check('批量部分失败不整体报错', partial.status === 200 && partial.body.results.some((r) => !r.ok))
    const empty = await api('POST', '/api/tasks/batch', { action: 'done', ids: [] })
    check('空批量被拒', empty.status === 400)
  }

  /* ---- 6. 搜索 ---- */
  {
    const t = (await api('POST', '/api/tasks', { title: '搜索目标阿尔法', description: '独特描述贝塔' })).body.data
    const s1 = await api('GET', '/api/search?q=' + encodeURIComponent('阿尔法'))
    check('搜索能命中任务标题', s1.status === 200 && s1.body.data.tasks.some((x) => x.id === t.id))
    const s2 = await api('GET', '/api/search?q=' + encodeURIComponent('贝塔'))
    check('搜索能命中任务描述', s2.body.data.tasks.some((x) => x.id === t.id))
    const s3 = await api('GET', '/api/search?q=' + encodeURIComponent('a%_'))
    check('搜索对 LIKE 通配符做了转义', s3.status === 200)
    const short = await api('GET', '/api/search?q=a')
    check('少于 2 字不搜', short.body.data.tasks.length === 0)
  }

  /* ---- 7. 统计 ---- */
  {
    const s = await api('GET', '/api/stats?days=30')
    check('统计返回 totals/perAgent/perDay', Boolean(s.body.data.totals && s.body.data.perAgent && s.body.data.perDay))
    check('统计里已完成数 > 0', s.body.data.totals.completedInRange > 0, String(s.body.data.totals.completedInRange))
    check('统计平均耗时非负', s.body.data.totals.avgDurationMs >= 0)
    const computed = stats.computeStats('all')
    check('统计 all 范围可计算', computed.rangeDays === null && computed.perDay.length === 30)
  }

  /* ---- 8. 诊断脱敏 ---- */
  {
    const d = await api('GET', '/api/diagnostics')
    check('诊断返回 checks', Array.isArray(d.body.data.checks) && d.body.data.checks.length > 0)
    const text = JSON.stringify(d.body.data)
    check('诊断不包含授权码', !text.includes(process.env.CHAOS_AUTH_CODE || 'Hyc13579'))
    const exp = await fetch(`${BASE}/api/diagnostics/export`, {
      headers: { 'x-chaos-token': TOKEN },
    })
    const body = await exp.text()
    check('诊断导出是 JSON 附件', exp.status === 200 && /chaosconsole-diagnostics/.test(body) && !body.includes('Hyc13579'))
    diagnostics.recordError('regress', new Error('测试错误 token=abc'))
    const snap = diagnostics.snapshot()
    check('错误环形缓冲会脱敏 token', !JSON.stringify(snap.recentErrors).includes('token=abc'))
  }

  /* ---- 9. 备份 ---- */
  {
    const created = await api('POST', '/api/backups')
    check('手动备份创建成功', created.status === 200 && /\.db$/.test(created.body.data.name))
    const list = await api('GET', '/api/backups')
    check('备份列表包含新备份', list.body.data.backups.some((b) => b.name === created.body.data.name))
    const bad = await api('POST', '/api/backups/evil.db/restore')
    check('非法备份文件名被拒', bad.status === 400)
    const restored = await api('POST', `/api/backups/${created.body.data.name}/restore`)
    check('备份恢复成功', restored.status === 200)
    const del = await api('DELETE', `/api/backups/${created.body.data.name}`)
    check('备份删除成功', del.status === 200)
    check('备份目录在数据目录下', backup.DIR.startsWith(DATA_DIR))
  }

  /* ---- 10. 工作区导入导出 ---- */
  {
    const before = store.listTasks().length
    const exported = workspace.exportWorkspace()
    check('导出包含 agents/tasks/templates/settings', Boolean(exported.agents && exported.tasks && exported.templates && exported.settings))
    check('导出 schemaVersion = 1', exported.schemaVersion === 1)
    const imported = workspace.importWorkspace(exported)
    check('导入成功并返回计数', imported.ok && imported.counts.tasks === exported.tasks.length, JSON.stringify(imported.counts))
    check('导入后任务数一致', store.listTasks().length === before)
    check('导入后任务都是可重跑状态', store.listTasks().every((t) => t.runState === 'idle'))
    let rejected = false
    try {
      workspace.importWorkspace({ schemaVersion: 999 })
    } catch (_) {
      rejected = true
    }
    check('非法 schemaVersion 被拒', rejected)
    let protoRejected = false
    try {
      workspace.importWorkspace({ schemaVersion: 1, agents: [], tasks: [], __proto__: { polluted: true } })
      protoRejected = !({}).polluted
    } catch (_) {
      protoRejected = true
    }
    check('原型污染键被拒/未生效', protoRejected)
  }

  /* ---- 11. 工具链 ---- */
  {
    const status = await api('GET', '/api/toolchain')
    check('工具链检测返回 4 个工具', status.status === 200 && Object.keys(status.body.data.tools || {}).length === 4)
    const noConsent = await api('POST', '/api/toolchain/install', { tool: 'claude' })
    check('安装必须带 consent', noConsent.status === 400)
    const unknown = await api('POST', '/api/toolchain/install', { tool: 'rm-rf', consent: true })
    check('未知工具被白名单拒绝', unknown.status === 400)
    check('纯 Node 模式下载安装标记 unsupported', toolchain.supported() === false)
  }

  /* ---- 12. 设置校验 ---- */
  {
    const lang = await api('POST', '/api/settings', { uiLanguage: 'en' })
    check('界面语言可切换 en', lang.status === 200)
    const badLang = await api('POST', '/api/settings', { uiLanguage: 'fr' })
    check('非法语言被拒', badLang.status === 400)
    const accent = await api('POST', '/api/settings', { accent: 'violet' })
    check('强调色可切换 violet', accent.status === 200)
    const badAccent = await api('POST', '/api/settings', { accent: 'pink' })
    check('非法强调色被拒', badAccent.status === 400)
    const shortcut = await api('POST', '/api/settings', { globalShortcut: 'CommandOrControl+Shift+K' })
    check('全局快捷键可配置', shortcut.status === 200)
    const badShortcut = await api('POST', '/api/settings', { globalShortcut: 'Alt+F4' })
    check('非法全局快捷键被拒', badShortcut.status === 400)
    await api('POST', '/api/settings', { uiLanguage: 'zh', accent: 'amber' })
  }

  await server.stop()
  fs.rmSync(DATA_DIR, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== ${results.length - failed.length}/${results.length} 通过 ===`)
  if (failed.length) {
    console.log('失败项：')
    for (const f of failed) console.log(`  - ${f.name}`)
    process.exit(1)
  }
}

main().catch(async (err) => {
  console.error('[regress-v8] 失败:', err.stack || err.message)
  try {
    await server.stop()
  } catch (_) {}
  process.exit(1)
})
