'use strict'

/**
 * 验证「系统关机时，广播的 WM_QUERYENDSESSION 能不能到达守护的窗体」。
 *
 * 真实关机时 Windows 是把 WM_QUERYENDSESSION 广播给所有顶层窗口；自检只把
 * 消息单发给守护自己，证明不了广播这一段。这里用 SendMessageTimeout 对
 * HWND_BROADCAST 发一次查询 —— 只发「问一句」，不发 WM_ENDSESSION，
 * 所以不会真的关机，别的应用最多回一个 TRUE。
 *
 * 判据：guard.log 里出现新的「veto WM_QUERYENDSESSION」行 = 广播能到达。
 */

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ShutdownGuard } = require('../electron/shutdown-guard.js')

const DIR = path.join(os.tmpdir(), 'chaos-shutdown-guard-broadcast')
const PS1 = path.join(DIR, 'broadcast.ps1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function logLines() {
  const p = path.join(DIR, 'shutdown-guard', 'guard.log')
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter(Boolean) : []
}

function broadcast(lparam) {
  const src = [
    '$src = @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class ChaosBcast {',
    '  [DllImport("user32.dll", SetLastError = true)]',
    '  public static extern bool SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out IntPtr result);',
    '}',
    '"@',
    "Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.dll'",
    '$r = [IntPtr]::Zero',
    '$ok = [ChaosBcast]::SendMessageTimeout([IntPtr]0xFFFF, 0x11, [IntPtr]::Zero, [IntPtr]' + lparam + ', 2, 5000, [ref]$r)',
    'Write-Output ("broadcast ok=" + $ok.ToString() + " result=" + $r.ToString())',
  ].join('\n')
  fs.writeFileSync(PS1, src, 'utf8')
  const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  })
  return String((out.stdout || '') + (out.stderr || '')).trim()
}

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })

  const guard = new ShutdownGuard({ userDataDir: DIR })
  guard.start()
  for (let i = 0; i < 40; i++) {
    await sleep(250)
    if (guard.status().status === 'running' || guard.status().status === 'running-fallback') break
  }
  const st = guard.status()
  console.log(`守护状态: ${st.status}，权限: ${st.privileged}`)
  if (st.status !== 'running') {
    console.log('✗ 守护没起来，测不了广播')
    guard.stop()
    return 1
  }
  await sleep(800)
  const before = logLines().length
  console.log(`广播前日志行数: ${before}`)

  console.log('\n向所有顶层窗口广播 WM_QUERYENDSESSION（lParam=0）…')
  console.log('  ' + broadcast(0))
  await sleep(1200)
  const after0 = logLines()
  const got0 = after0.slice(before).filter((l) => l.includes('veto WM_QUERYENDSESSION')).length
  console.log(`  守护收到: ${got0 > 0 ? '是' : '否'}`)

  const before1 = after0.length
  console.log('\n再广播一次（lParam=1，ENDSESSION_CLOSEAPP，Windows 更新路径用的旗标）…')
  console.log('  ' + broadcast(1))
  await sleep(1200)
  const after1 = logLines()
  const got1 = after1.slice(before1).filter((l) => l.includes('veto WM_QUERYENDSESSION')).length
  console.log(`  守护收到: ${got1 > 0 ? '是' : '否'}`)

  console.log('\n=== 守护日志（尾部） ===')
  for (const l of logLines().slice(-8)) console.log('  ' + l)

  guard.stop()
  await sleep(1500)

  const ok = got0 > 0 && got1 > 0
  console.log(`\n结论：${ok ? '广播能到达守护窗体，否决链路是通的' : '广播没有到达守护窗体 —— 这就是按关机拦不住的根因'}`)
  return ok ? 0 : 2
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
