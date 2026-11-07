'use strict'

/**
 * 运行期间拦截系统关机（Windows）。
 *
 * 为什么不能只靠 Electron：
 *   Electron 在 Windows 上只有 `session-end` 事件，那是**系统已经决定结束会话之后**
 *   的通知，没有 preventDefault；`before-quit` / `will-quit` 在关机时根本不触发
 *   （electron.d.ts 里明确写了 "will not be emitted if the app is closed due to a
 *   shutdown/restart of the system"）。所以拦截只能落到 WM_QUERYENDSESSION。
 *
 * 做法：起一个隐藏窗体进程，对 WM_QUERYENDSESSION 返回 FALSE，并调
 * ShutdownBlockReasonCreate 把「ChaosConsole 不允许关机」写进 Windows 的阻止清单。
 * Windows 的关机流程会被这一票挡住，界面显示本应用正在阻止关机；用户点「取消」
 * 或进程有权限时我们调的 AbortSystemShutdown 生效，关机就被撤掉了。
 *
 * 为什么要用 PowerShell 现编：
 *   本项目的安装包不带原生模块（node_modules 里没有任何 .node 编译产物），
 *   多带一个 exe 就要多一条构建链。Windows 10/11 自带 .NET Framework 的
 *   csc（Add-Type 走的就是它），运行时编译一次约 1-2 秒，编完即用。
 *   编译失败就退到 SystemEvents.SessionEnding 这条纯脚本的兜底路上。
 *
 * 三层防护（任意一层生效即可拦住）：
 *   1. 隐藏窗体的 WndProc —— 主路径，同步返回 FALSE，不依赖时序
 *   2. SystemEvents.SessionEnding 的 Cancel —— Add-Type 不可用时的兜底
 *   3. 主进程的 session-end → shutdown /a —— 进程有管理员权限时能直接把关机撤掉
 */

const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const CS_SOURCE = `using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Forms;

/// <summary>
/// ChaosConsole 关机守护：对 WM_QUERYENDSESSION 回 FALSE，把系统关机挡下来。
/// 由 electron/shutdown-guard.js 在运行时编译，不随安装包分发二进制。
/// </summary>
public class ChaosShutdownGuard : Form
{
    private const int WM_QUERYENDSESSION = 0x0011;
    private const int WM_ENDSESSION = 0x0016;

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, string reason);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool AbortSystemShutdown(string machineName);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    private readonly string _flagPath;
    private readonly string _stopPath;
    private readonly string _logPath;
    private readonly bool _selfTest;
    private readonly int _parentPid;
    private readonly Timer _timer;

    public ChaosShutdownGuard(string flagPath, string stopPath, string logPath)
        : this(flagPath, stopPath, logPath, false, 0)
    {
    }

    public ChaosShutdownGuard(string flagPath, string stopPath, string logPath, bool selfTest, int parentPid)
    {
        _flagPath = flagPath;
        _stopPath = stopPath;
        _logPath = logPath;
        _selfTest = selfTest;
        _parentPid = parentPid;

        Text = "ChaosConsole";
        ShowInTaskbar = false;
        ShowIcon = false;
        FormBorderStyle = FormBorderStyle.None;
        WindowState = FormWindowState.Minimized;
        StartPosition = FormStartPosition.Manual;
        Location = new System.Drawing.Point(-4000, -4000);
        Size = new System.Drawing.Size(1, 1);

        _timer = new Timer();
        _timer.Interval = 500;
        _timer.Tick += OnTick;
    }

    private void Log(string msg)
    {
        try
        {
            File.AppendAllText(_logPath, "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + msg + Environment.NewLine);
        }
        catch { }
    }

    private void OnTick(object sender, EventArgs e)
    {
        if (File.Exists(_stopPath))
        {
            _timer.Stop();
            Close();
            return;
        }
        /* 父进程没了（被 taskkill / 崩溃）就自己退 —— 孤儿守护会让用户永远关不掉机 */
        if (_parentPid > 0)
        {
            try
            {
                Process.GetProcessById(_parentPid);
            }
            catch
            {
                Log("parent process gone, exiting");
                _timer.Stop();
                Close();
            }
        }
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);
        /* 这句是 Windows「阻止关机」界面上显示的理由文字 */
        try { ShutdownBlockReasonCreate(Handle, "ChaosConsole 不允许关机"); } catch { }
        _timer.Start();
        Log("guard ready hwnd=" + Handle.ToString());
        if (_selfTest) BeginInvoke(new MethodInvoker(RunSelfTest));
    }

    /// <summary>
    /// 自检：只把 WM_QUERYENDSESSION 发给自己这个窗体，看它是否返回 0。
    /// 不广播、不触发真正的关机，安全 —— 用来验证「拦得住」这条链路。
    /// </summary>
    private void RunSelfTest()
    {
        string result;
        try
        {
            IntPtr r = SendMessage(Handle, WM_QUERYENDSESSION, IntPtr.Zero, IntPtr.Zero);
            bool blocked = r == IntPtr.Zero;
            bool flagged = File.Exists(_flagPath);
            result = blocked && flagged ? "PASS" : "FAIL result=" + r.ToString() + " flag=" + flagged;
        }
        catch (Exception ex)
        {
            result = "FAIL " + ex.Message;
        }
        try
        {
            File.WriteAllText(Path.Combine(Path.GetDirectoryName(_logPath), "selftest.flag"), result);
        }
        catch { }
        Log("selftest: " + result);
        _timer.Stop();
        Close();
    }

    protected override void OnHandleDestroyed(EventArgs e)
    {
        try { ShutdownBlockReasonDestroy(Handle); } catch { }
        base.OnHandleDestroyed(e);
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == WM_QUERYENDSESSION)
        {
            try { File.WriteAllText(_flagPath, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss")); } catch { }
            /* 有管理员权限时直接把这次关机撤掉；普通用户会失败，
             * 失败也没关系 —— 上面的 FALSE 已经把会话结束挡在门外了 */
            try { AbortSystemShutdown(null); } catch { }
            Log("blocked WM_QUERYENDSESSION lParam=" + m.LParam.ToString());
            m.Result = IntPtr.Zero;
            return;
        }
        if (m.Msg == WM_ENDSESSION)
        {
            Log("WM_ENDSESSION wParam=" + m.WParam.ToString());
            base.WndProc(ref m);
            return;
        }
        base.WndProc(ref m);
    }
}
`

const PS_SOURCE = `# ChaosConsole 关机守护（由 electron/shutdown-guard.js 生成，不要手改）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$flag = Join-Path $root 'blocked.flag'
$stop = Join-Path $root 'stop.flag'
$ready = Join-Path $root 'ready.flag'
$log  = Join-Path $root 'guard.log'
$cs   = Join-Path $root 'guard.cs'

function Write-Log([string]$msg) {
  try { Add-Content -Path $log -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $msg) -Encoding UTF8 } catch { }
}

Write-Log "guard process start pid=$PID"

# 主路径：编一个隐藏窗体，在 WndProc 里拒掉 WM_QUERYENDSESSION
# PowerShell 5.1 一旦显式给了 -ReferencedAssemblies，默认引用就不全了 ——
# 先把核心程序集点齐；点不齐的话退到「先加载再编译」那种写法。
$compiled = $false
try {
  Add-Type -Path $cs -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Windows.Forms.dll', 'System.Drawing.dll' -ErrorAction Stop
  $compiled = $true
} catch {
  Write-Log ("compile attempt 1 failed: " + $_.Exception.Message)
}
if (-not $compiled) {
  try {
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction Stop
    Add-Type -AssemblyName System.Drawing -ErrorAction Stop
    Add-Type -Path $cs -ErrorAction Stop
    $compiled = $true
  } catch {
    Write-Log ("compile attempt 2 failed: " + $_.Exception.Message)
  }
}

if ($compiled) {
  New-Item -ItemType File -Path $ready -Force | Out-Null
  $selfTest = ($env:CHAOS_GUARD_SELFTEST -eq '1')
  $parentPid = 0
  if ($env:CHAOS_GUARD_PARENT_PID) { try { $parentPid = [int]$env:CHAOS_GUARD_PARENT_PID } catch { $parentPid = 0 } }
  try {
    $form = New-Object ChaosShutdownGuard -ArgumentList $flag, $stop, $log, $selfTest, $parentPid
    $form.ShowDialog() | Out-Null
    Write-Log "guard form closed, exiting"
  } catch {
    Write-Log ("guard form failed: " + $_.Exception.Message)
  }
  Remove-Item -Path $ready -Force -ErrorAction SilentlyContinue
  exit 0
}

# 兜底：Add-Type 不可用（受限环境 / .NET 缺失）时用 SystemEvents
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue | Out-Null
  $handler = {
    param($s, $e)
    try { Set-Content -Path $flag -Value (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') -Encoding UTF8 } catch { }
    $e.Cancel = $true
    Write-Log "blocked via SystemEvents.SessionEnding"
  }
  [Microsoft.Win32.SystemEvents]::add_SessionEnding($handler)
  Set-Content -Path (Join-Path $root 'fallback.flag') -Value '1' -Encoding UTF8
  Write-Log "fallback SystemEvents handler registered"
  while (-not (Test-Path $stop)) { Start-Sleep -Milliseconds 400 }
  Write-Log "fallback loop exit"
  Remove-Item -Path (Join-Path $root 'fallback.flag') -Force -ErrorAction SilentlyContinue
  exit 0
} catch {
  Write-Log ("fallback failed: " + $_.Exception.Message)
  Set-Content -Path (Join-Path $root 'failed.flag') -Value $_.Exception.Message -Encoding UTF8
  exit 1
}
`

/** Windows 上才有意义；其它平台一律当作「不支持」，由调用方决定怎么提示 */
function supported() {
  return process.platform === 'win32'
}

function guardDir(userDataDir) {
  return path.join(userDataDir, 'shutdown-guard')
}

/** 写文件带 BOM：PowerShell 5.1 读无 BOM 的 UTF-8 会按 ANSI 解，中文全乱码 */
function writeUtf8Bom(file, text) {
  fs.writeFileSync(file, '\uFEFF' + text, 'utf8')
}

class ShutdownGuard {
  constructor({ userDataDir, onBlocked, onStatus } = {}) {
    this.dir = guardDir(userDataDir)
    this.onBlocked = typeof onBlocked === 'function' ? onBlocked : () => {}
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {}
    this.child = null
    this.poll = null
    this.enabled = false
    this.lastStatus = 'idle'
  }

  file(name) {
    return path.join(this.dir, name)
  }

  status() {
    return { enabled: this.enabled, status: this.lastStatus, supported: supported(), dir: this.dir }
  }

  setStatus(s, detail = '') {
    this.lastStatus = s
    try {
      this.onStatus({ status: s, detail, enabled: this.enabled })
    } catch (_) {
      /* 通知失败不能影响守护本身 */
    }
  }

  /** 清掉上一次留下的标记，否则一启动就弹「已阻止关机」 */
  resetFlags() {
    for (const f of ['blocked.flag', 'stop.flag', 'ready.flag', 'failed.flag', 'fallback.flag', 'selftest.flag']) {
      try {
        fs.rmSync(this.file(f), { force: true })
      } catch (_) {
        /* ignore */
      }
    }
  }

  stop() {
    this.enabled = false
    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
    if (!this.child) {
      this.setStatus('off')
      return
    }
    const child = this.child
    this.child = null
    try {
      fs.writeFileSync(this.file('stop.flag'), String(Date.now()), 'utf8')
    } catch (_) {
      /* 写不进标记就直接杀 */
    }
    /* 先给守护进程 1.5 秒自己退（它要在 OnHandleDestroyed 里销毁阻止理由），
     * 还没退就强杀，绝不能留一个挡住用户关机的孤儿进程 */
    setTimeout(() => {
      try {
        if (child && child.exitCode === null) child.kill()
      } catch (_) {
        /* ignore */
      }
    }, 1500)
    this.setStatus('off')
  }

  /** 进程退出前的同步收尾：不留定时器，直接杀 */
  killNow() {
    this.enabled = false
    if (this.poll) {
      clearInterval(this.poll)
      this.poll = null
    }
    try {
      fs.writeFileSync(this.file('stop.flag'), String(Date.now()), 'utf8')
    } catch (_) {
      /* ignore */
    }
    try {
      if (this.child) this.child.kill()
    } catch (_) {
      /* ignore */
    }
    this.child = null
  }

  start({ selfTest = false } = {}) {
    if (!supported()) {
      this.enabled = false
      this.setStatus('unsupported')
      return { ok: false, reason: 'unsupported' }
    }
    if (this.child) {
      this.enabled = true
      this.setStatus('running')
      return { ok: true }
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      this.resetFlags()
      writeUtf8Bom(this.file('guard.cs'), CS_SOURCE)
      writeUtf8Bom(this.file('guard.ps1'), PS_SOURCE)
    } catch (err) {
      this.enabled = false
      this.setStatus('error', err.message)
      return { ok: false, reason: err.message }
    }

    this.child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', this.file('guard.ps1')],
      {
        windowsHide: true,
        stdio: 'ignore',
        detached: false,
        env: {
          ...process.env,
          CHAOS_GUARD_SELFTEST: selfTest ? '1' : '0',
          /* 守护要盯着父进程：应用被 taskkill 时它得自己退，不然用户关不掉机 */
          CHAOS_GUARD_PARENT_PID: String(process.pid),
        },
      },
    )
    this.enabled = true
    this.setStatus('starting')

    this.child.on('error', (err) => {
      this.child = null
      this.enabled = false
      this.setStatus('error', err.message)
    })
    this.child.on('exit', (code) => {
      this.child = null
      if (this.enabled) {
        /* 守护自己退了：不是用户关的开关，就是编不出来/被杀。如实上报，别假装还拦着 */
        let why = ''
        try {
          why = fs.readFileSync(this.file('failed.flag'), 'utf8').trim()
        } catch (_) {
          /* ignore */
        }
        this.enabled = false
        this.setStatus('error', why || `guard exit ${code}`)
      }
    })

    this.watch()
    return { ok: true }
  }

  /** 轮询占用极小（600ms 一次读两个 stat），比 fs.watch 在 Windows 上稳 */
  watch() {
    if (this.poll) clearInterval(this.poll)
    let last = ''
    this.poll = setInterval(() => {
      /* 编译成功 / 降级成功都算「在守着」 */
      if (this.lastStatus === 'starting') {
        if (fs.existsSync(this.file('ready.flag'))) this.setStatus('running')
        else if (fs.existsSync(this.file('fallback.flag'))) this.setStatus('running-fallback')
      }
      let stamp = ''
      try {
        stamp = fs.readFileSync(this.file('blocked.flag'), 'utf8').trim()
      } catch (_) {
        return
      }
      if (stamp && stamp !== last) {
        last = stamp
        try {
          this.onBlocked({ at: stamp })
        } catch (_) {
          /* ignore */
        }
      }
    }, 600)
    if (this.poll.unref) this.poll.unref()
  }

  /** 开关变化时统一入口 */
  sync(enabled) {
    if (enabled && !this.enabled) return this.start()
    if (!enabled && this.enabled) {
      this.stop()
      return { ok: true }
    }
    if (enabled) this.enabled = true
    return { ok: true }
  }
}

/**
 * 自检：起一次守护、向守护自己的窗体发一次 WM_QUERYENDSESSION，看它返回什么。
 *
 * 为什么不广播给所有窗口：广播会让别的应用以为要关机了，可能弹「保存后关闭」，
 * 宁可只测自己这一条链路。真正点关机时 Windows 是广播，但我们的 WndProc 对
 * 单播和广播的处理完全一样，所以这个自检足以证明拦截逻辑是通的。
 */
async function selfTest({ userDataDir, timeoutMs = 30000 } = {}) {
  const g = new ShutdownGuard({ userDataDir })
  const started = g.start({ selfTest: true })
  if (!started.ok) return { ok: false, detail: started.reason || 'unsupported' }
  const deadline = Date.now() + timeoutMs
  let out = { ok: false, detail: 'timeout（守护进程 30 秒内没回结果）' }
  while (Date.now() < deadline) {
    if (fs.existsSync(g.file('selftest.flag'))) {
      const text = fs.readFileSync(g.file('selftest.flag'), 'utf8').trim()
      out = { ok: text.startsWith('PASS'), detail: text }
      break
    }
    if (fs.existsSync(g.file('failed.flag'))) {
      out = { ok: false, detail: 'compile failed: ' + fs.readFileSync(g.file('failed.flag'), 'utf8').trim() }
      break
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  g.killNow()
  return out
}

module.exports = { ShutdownGuard, supported, guardDir, selfTest }
