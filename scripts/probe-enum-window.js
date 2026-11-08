'use strict'

/**
 * 终极判定（v2）：跨进程直接给守护 hwnd 发 WM_QUERYENDSESSION。
 * 自检是同进程内发消息（直接函数调用），真关机是跨进程 SendMessage ——
 * 两者走的是不同路径，必须分开验证。
 */

const { spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { ShutdownGuard } = require('../electron/shutdown-guard.js')

const DIR = path.join(os.tmpdir(), 'chaos-shutdown-guard-enum2')
const PS1 = path.join(DIR, 'enum-test2.ps1')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function guardLog() {
  const p = path.join(DIR, 'shutdown-guard', 'guard.log')
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
}

function runProbe(guardHwnd) {
  const ps = [
    '$src = @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public class ChaosProbe2 {',
    '  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);',
    '  [DllImport("user32.dll", SetLastError = true)] public static extern bool SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  public static bool Found; public static bool Visible; public static IntPtr Target;',
    '  private static bool Cb(IntPtr h, IntPtr lp) {',
    '    if (h == Target) { Found = true; Visible = IsWindowVisible(h); }',
    '    return true;',
    '  }',
    '  public static string EnumCheck(IntPtr target) {',
    '    Target = target; Found = false; Visible = false;',
    '    EnumWindows(new EnumProc(Cb), IntPtr.Zero);',
    '    return "enum-found=" + Found + " visible=" + Visible;',
    '  }',
    '  public static string DirectSend(IntPtr target) {',
    '    IntPtr r;',
    '    bool ok = SendMessageTimeout(target, 0x11, IntPtr.Zero, IntPtr.Zero, 0, 8000, out r);',
    '    return "direct-send ok=" + ok + " result=" + r + "  (result=0 => 回了 FALSE，即否决)";',
    '  }',
    '  public static string BroadcastNormal() {',
    '    IntPtr r;',
    '    bool ok = SendMessageTimeout((IntPtr)0xFFFF, 0x11, IntPtr.Zero, IntPtr.Zero, 0, 8000, out r);',
    '    int err = Marshal.GetLastWin32Error();',
    '    return "broadcast ok=" + ok + " result=" + r + " err=" + err + "  (False 只说明有别家窗口超时，不代表没送达)";',
    '  }',
    '}',
    '"@',
    "Add-Type -TypeDefinition $src -ReferencedAssemblies 'System.dll'",
    '$t = [IntPtr]' + guardHwnd,
    'Write-Output ([ChaosProbe2]::EnumCheck($t))',
    'Write-Output ([ChaosProbe2]::DirectSend($t))',
    'Write-Output ([ChaosProbe2]::BroadcastNormal())',
  ].join('\n')
  fs.writeFileSync(PS1, ps, 'utf8')
  const out = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90000,
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
    guard.stop()
    return 1
  }
  await sleep(800)

  const m = guardLog().match(/guard ready hwnd=(\d+)/)
  if (!m) {
    console.log('✗ 日志里找不到 hwnd')
    guard.stop()
    return 1
  }
  console.log(`守护 hwnd = ${m[1]}\n=== 外部探测 ===`)
  console.log(runProbe(m[1]))

  await sleep(1500)
  console.log('\n=== 探测后守护日志（尾部 6 行） ===')
  for (const l of guardLog().split('\n').filter(Boolean).slice(-6)) console.log('  ' + l)

  guard.stop()
  await sleep(1500)
  return 0
}

main()
  .then((c) => process.exit(c))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
