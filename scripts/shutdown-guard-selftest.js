/* eslint-disable no-console */
/**
 * 「运行期间禁止关机」自检（10.0.2）
 *
 * 不真的关机：起一次守护进程，往它自己的窗体发一条 WM_QUERYENDSESSION，
 * 看它是不是回 0（拒绝结束会话）并把拦截标记写出来。
 *
 * 用法：node scripts/shutdown-guard-selftest.js
 * 退出码：0 = 拦得住；1 = 拦不住（会打印原因）
 */
const os = require('os')
const path = require('path')
const fs = require('fs')
const { selfTest, supported, guardDir } = require('../electron/shutdown-guard.js')

async function main() {
  if (!supported()) {
    console.log(`× 当前系统不是 Windows（${process.platform}），这个功能只在 Windows 上生效`)
    return 1
  }
  const dir = path.join(os.tmpdir(), 'chaos-shutdown-guard-selftest')
  fs.mkdirSync(dir, { recursive: true })
  console.log(`守护目录：${guardDir(dir)}`)
  console.log('正在编译并启动守护进程（首次约 1-3 秒）…')
  const r = await selfTest({ userDataDir: dir })
  console.log('')
  if (r.ok) {
    console.log('✓ 自检通过：WM_QUERYENDSESSION 被拒绝，系统关机会被拦下')
    console.log('  真实效果：点「关机」时 Windows 会停在「ChaosConsole 不允许关机」界面')
  } else {
    console.log('× 自检未通过：' + r.detail)
    const log = path.join(guardDir(dir), 'guard.log')
    if (fs.existsSync(log)) {
      console.log('--- guard.log ---')
      console.log(fs.readFileSync(log, 'utf8').trim().split('\n').slice(-12).join('\n'))
    }
  }
  return r.ok ? 0 : 1
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('自检异常：', err && err.message ? err.message : err)
    process.exit(1)
  },
)
