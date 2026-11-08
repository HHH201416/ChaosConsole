'use strict'

/**
 * 验证「定时关机 / 脚本关机」这条路径真的会被撤销（10.0.5 的 400ms 轮询）。
 *
 * 判定方式不靠应用自己回报，而是外部证据：守护撤掉后，`shutdown /a` 会返回
 * 1116（没有正在进行的关机）。如果守护没干活，它就返回 0 —— 这一下顺手替用户
 * 把机器救回来，所以脚本怎么跑都不会真关机（定时器给的是 30 分钟）。
 */

const { spawn, spawnSync } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')
const { ShutdownGuard } = require('../electron/shutdown-guard.js')

const DIR = path.join(os.tmpdir(), 'chaos-shutdown-guard-poll')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function cancelPending() {
  for (let i = 0; i < 3; i++) {
    const r = spawnSync('shutdown.exe', ['/a'], { windowsHide: true, timeout: 5000 })
    if (r.status !== null) return r.status
    /* 返回码为空说明进程被守护的嗅探掐了，重试一次 */
  }
  return null
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true })
  const seen = []
  const guard = new ShutdownGuard({
    userDataDir: DIR,
    onBlocked: (info) => seen.push(info),
  })

  guard.start()
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    const s = guard.status().status
    if (s === 'running' || s === 'running-fallback') break
  }
  const st = guard.status()
  console.log(`守护状态: ${st.status}，权限: ${st.privileged}`)
  if (st.status !== 'running') {
    console.log('✗ 守护没起来（其余断言由自检覆盖）')
    guard.stop()
    return 1
  }

  console.log('下发定时关机：/s /t 1800（30 分钟）…')
  spawn('shutdown.exe', ['/s', '/t', '1800', '/c', 'chaos poll test'], {
    stdio: 'ignore',
    windowsHide: true,
  })
  await sleep(3000)

  const code = cancelPending()
  console.log(`撤销探测 exit=${code}（1116=已经没有待执行关机 → 守护撤掉了；0=还排着队 → 守护没撤）`)

  const logPath = path.join(DIR, 'shutdown-guard', 'guard.log')
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : ''
  const aborted = /blocked via (abort|host|kill)/.test(log)
  console.log('守护日志里记录到的拦截: ' + (aborted ? '有' : '无'))

  guard.stop()
  await sleep(1500)
  return code === 1116 ? 0 : 2
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error(err)
    cancelPending()
    process.exit(1)
  })
