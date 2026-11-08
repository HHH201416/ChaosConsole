'use strict'

/**
 * 运行期间完全阻止系统关机（Windows）。
 *
 * 为什么不能只靠 Electron：
 *   Electron 在 Windows 上只有 `session-end` 事件，那是**系统已经决定结束会话之后**
 *   的通知，没有 preventDefault；`before-quit` / `will-quit` 在关机时根本不触发
 *   （electron.d.ts 里明确写了 "will not be emitted if the app is closed due to a
 *   shutdown/restart of the system"）。所以拦截只能落到 WM_QUERYENDSESSION。
 *
 * 主拦截：起一个隐藏窗体进程，对 WM_QUERYENDSESSION 返回 FALSE，并调
 * ShutdownBlockReasonCreate 把「ChaosConsole 不允许关机」写进 Windows 的阻止清单。
 * 这一票是同步返回的，不依赖时序，Windows 必须把它算进结果。
 *
 * 10.0.5 为什么要重写拦截链（原来「能拦」但不算「拦住」）：
 *   1. 原来在 WndProc 里**同步**调 AbortSystemShutdown。系统正 SendMessageTimeout
 *      等着我们回话，processor 里再进一次关机流程管理的系统调用，一旦卡住就超过
 *      5 秒阈值 → Windows 判定本应用「未响应」→ 直接把「仍要关机」递到用户手里。
 *      现在 WndProc 只做两件极快的事：写一个标记文件、把撤销动作 BeginInvoke 出去，
 *      立刻返回 FALSE。撤销在消息循环回到我们手里之后再执行。
 *   2. 原来只有「回应查询」一条路。定时关机（shutdown /s /t 60）、Windows 更新
 *      重启（UsoClient）、别的程序调 InitiateSystemShutdownEx，这些不一定走
 *      交互式关机界面。现在加 400ms 撤销轮询：只要有待执行的关机就 AbortSystemShutdown
 *      撤掉，用户连「正在关机」都看不到。
 *   3. 撤销要权限。SeShutdownPrivilege 默认在用户令牌里但**未启用**，必须
 *      AdjustTokenPrivileges 打开，否则 AbortSystemShutdown 恒定 ERROR_ACCESS_DENIED。
 *      这是之前「有权限就撤得掉」全靠运气的真正原因。
 *   4. 撤销入口的库名也不能照文档写。微软文档标 user32.dll，但本机（Windows 11
 *      26200）user32 只导出 ExitWindowsEx，AbortSystemShutdownW 在 advapi32 ——
 *      静态 P/Invoke 会抛 EntryPointNotFoundException，被 catch 吞掉后表现为
 *      「撤销永远失败，日志里只有一句 err=2」。现在运行时按 advapi32 → user32、
 *      按 W/A/裸名逐个 GetProcAddress，找不到就明说「只能拦截，撤不掉定时关机」。
 *   5. shutdown.exe 这类工具直接掐掉，掐不到还有上面几条兜。
 *
 * 边界（写在这里，也写在发布说明里）：长按电源键断电、以及系统级「强制执行」
 * 属于内核/硬件层，任何用户态程序都无法阻止。常规关机、重启、注销、定时关机、
 * 脚本关机、更新重启全部覆盖。
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
 *   3. 主进程 session-end → abort.flag → 守护立刻撤销
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
/// ChaosConsole 关机守护：对 WM_QUERYENDSESSION 回 FALSE，并持续撤销待执行的关机。
/// 由 electron/shutdown-guard.js 在运行时编译，不随安装包分发二进制。
/// </summary>
public class ChaosShutdownGuard : Form
{
    private const int WM_QUERYENDSESSION = 0x0011;
    private const int WM_ENDSESSION = 0x0016;

    private const int ERROR_NO_SHUTDOWN_IN_PROGRESS = 1116;
    private const int ERROR_NOT_ALL_ASSIGNED = 1300;

    private const uint TOKEN_ADJUST_PRIVILEGES = 0x0020;
    private const uint TOKEN_QUERY = 0x0008;
    private const uint SE_PRIVILEGE_ENABLED = 0x0002;
    private const string SE_SHUTDOWN_NAME = "SeShutdownPrivilege";

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID { public uint LowPart; public int HighPart; }

    [StructLayout(LayoutKind.Sequential)]
    private struct LUID_AND_ATTRIBUTES { public LUID Luid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    private struct TOKEN_PRIVILEGES { public uint PrivilegeCount; public LUID_AND_ATTRIBUTES Privilege; }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ShutdownBlockReasonCreate(IntPtr hWnd, string reason);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool ShutdownBlockReasonDestroy(IntPtr hWnd);

    /* 撤销关机的入口不能写死库名。
     * 微软文档写的是 user32.dll，但本机（Windows 11 26200）user32 只导出
     * ExitWindowsEx，AbortSystemShutdownW 实际在 advapi32 里 —— 按文档静态声明
     * 会抛 EntryPointNotFoundException，被 catch 吞掉后表现为「撤销永远失败，
     * 而且日志里只有一句莫名其妙的 err=2」。这里运行时逐个库、逐个名字找。 */
    [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode, SetLastError = true)]
    private delegate bool AbortShutdownFn(string machineName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadLibrary(string fileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Ansi, SetLastError = true)]
    private static extern IntPtr GetProcAddress(IntPtr module, string procName);

    private static AbortShutdownFn _abortFn;
    private static string _abortEntry = "";

    private static AbortShutdownFn ResolveAbort()
    {
        if (_abortFn != null) return _abortFn;

        string[] dlls = new string[] { "advapi32.dll", "user32.dll" };
        string[] names = new string[] { "AbortSystemShutdownW", "AbortSystemShutdownA", "AbortSystemShutdown" };
        foreach (string dll in dlls)
        {
            IntPtr h;
            try { h = LoadLibrary(dll); }
            catch { continue; }
            if (h == IntPtr.Zero) continue;

            foreach (string name in names)
            {
                IntPtr p;
                try { p = GetProcAddress(h, name); }
                catch { continue; }
                if (p == IntPtr.Zero) continue;

                _abortFn = (AbortShutdownFn)Marshal.GetDelegateForFunctionPointer(p, typeof(AbortShutdownFn));
                _abortEntry = dll + "!" + name;
                return _abortFn;
            }
        }
        return null;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(string system, string name, out LUID luid);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll,
        ref TOKEN_PRIVILEGES state, uint len, IntPtr prev, IntPtr retLen);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr h);

    private readonly string _flagPath;
    private readonly string _stopPath;
    private readonly string _abortPath;
    private readonly string _readyPath;
    private readonly string _logPath;
    private readonly bool _selfTest;
    private readonly int _parentPid;
    private readonly Timer _timer;

    private int _ticks;
    private int _blockedCount;
    private int _killedCount;
    private int _lastAbortError;
    private bool _privilege;
    private bool _loggedKill;
    private bool _loggedNoEntry;
    private bool _loggedEntry;

    public ChaosShutdownGuard(string flagPath, string stopPath, string abortPath,
        string readyPath, string logPath)
        : this(flagPath, stopPath, abortPath, readyPath, logPath, false, 0)
    {
    }

    public ChaosShutdownGuard(string flagPath, string stopPath, string abortPath,
        string readyPath, string logPath, bool selfTest, int parentPid)
    {
        _flagPath = flagPath;
        _stopPath = stopPath;
        _abortPath = abortPath;
        _readyPath = readyPath;
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
        _timer.Interval = 400;
        _timer.Tick += OnTick;
    }

    private void Log(string msg)
    {
        try
        {
            File.AppendAllText(_logPath,
                "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + msg + Environment.NewLine);
        }
        catch { }
    }

    /// <summary>
    /// SeShutdownPrivilege 默认在令牌里但未启用，不启用则 AbortSystemShutdown 恒返回
    /// ERROR_ACCESS_DENIED（5）。这一步是「能不能撤掉定时关机」的关键。
    /// </summary>
    private void EnsurePrivilege()
    {
        IntPtr token;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, out token))
        {
            Log("OpenProcessToken failed err=" + Marshal.GetLastWin32Error().ToString());
            return;
        }
        try
        {
            LUID luid;
            if (!LookupPrivilegeValue(null, SE_SHUTDOWN_NAME, out luid))
            {
                Log("LookupPrivilegeValue failed err=" + Marshal.GetLastWin32Error().ToString());
                return;
            }
            TOKEN_PRIVILEGES tp = new TOKEN_PRIVILEGES();
            tp.PrivilegeCount = 1;
            tp.Privilege.Luid = luid;
            tp.Privilege.Attributes = SE_PRIVILEGE_ENABLED;
            bool ok = AdjustTokenPrivileges(token, false, ref tp, 0, IntPtr.Zero, IntPtr.Zero);
            int err = Marshal.GetLastWin32Error();
            /* AdjustTokenPrivileges 即使在「部分权限未赋予」时也返回 TRUE，
             * 真正要给的要靠 ERROR_NOT_ALL_ASSIGNED 判断 */
            _privilege = ok && err != ERROR_NOT_ALL_ASSIGNED;
            Log("shutdown privilege " + (_privilege ? "enabled" : ("unavailable err=" + err.ToString())));
        }
        finally
        {
            CloseHandle(token);
        }
    }

    private void OnTick(object sender, EventArgs e)
    {
        _ticks++;

        if (File.Exists(_stopPath))
        {
            _timer.Stop();
            Close();
            return;
        }

        /* 父进程没了（被 taskkill / 崩溃）就自己退 —— 孤儿守护会让用户永远关不掉机 */
        if (_parentPid > 0 && _ticks % 2 == 0)
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
                return;
            }
        }

        /* 主进程发现会话结束请求时写这个标记，要求立刻撤销 */
        if (File.Exists(_abortPath))
        {
            try { File.Delete(_abortPath); } catch { }
            AbortNow("host");
        }

        /* 常规路径：任何待执行的关机（定时关机 / 更新重启 / 其它程序发起）都撤掉。
         * 没有待执行关机时返回 ERROR_NO_SHUTDOWN_IN_PROGRESS，不算错误，不打日志。 */
        AbortNow(null);

        /* shutdown.exe 这类工具直接掐掉；掐不到还有上面的轮询兜着 */
        if (_ticks % 2 == 0) KillShutdownTools();
    }

    /// <summary>
    /// 撤销待执行的关机。via 非空表示是「因为收到了某个请求」，要记到拦截标记里
    /// 让界面能提示；单纯轮询为空，只在真的撤掉了关机时才记录。
    /// </summary>
    private void AbortNow(string via)
    {
        AbortShutdownFn fn = ResolveAbort();
        if (fn == null)
        {
            if (!_loggedNoEntry)
            {
                _loggedNoEntry = true;
                Log("abort entry not found in advapi32/user32（只能拦截，撤不掉定时关机）");
            }
            return;
        }

        bool ok = false;
        try { ok = fn(null); }
        catch (Exception ex)
        {
            if (!_loggedNoEntry)
            {
                _loggedNoEntry = true;
                Log("abort call threw: " + ex.GetType().Name + " — " + ex.Message);
            }
            return;
        }

        if (ok)
        {
            if (_abortEntry != "" && !_loggedEntry)
            {
                _loggedEntry = true;
                Log("abort entry in use: " + _abortEntry);
            }
            MarkBlocked(via == null ? "abort" : via);
            return;
        }

        int err = Marshal.GetLastWin32Error();
        /* 1116 = 没有待执行的关机（常态）；183 是这台机器在空转时也给回来的值。
         * 这两个不算错误，其余（尤其 5 = 权限被策略收走）记一次就够。 */
        bool idle = err == ERROR_NO_SHUTDOWN_IN_PROGRESS || err == 183;
        if (!idle && err != _lastAbortError)
        {
            _lastAbortError = err;
            Log("AbortSystemShutdown failed err=" + err.ToString()
                + (err == 5 ? "（SeShutdownPrivilege 被策略禁用，只能拦截不能撤销）" : ""));
        }
    }

    private void KillShutdownTools()
    {
        string[] names = new string[] { "shutdown", "PsShutdown", "UsoClient" };
        foreach (string name in names)
        {
            Process[] list;
            try { list = Process.GetProcessesByName(name); }
            catch { continue; }

            foreach (Process p in list)
            {
                try
                {
                    int pid = p.Id;
                    p.Kill();
                    _killedCount++;
                    Log("killed " + name + " pid=" + pid.ToString());
                    if (!_loggedKill)
                    {
                        _loggedKill = true;
                        MarkBlocked("kill");
                    }
                }
                catch { }
                finally
                {
                    try { p.Dispose(); } catch { }
                }
            }
        }
    }

    private void MarkBlocked(string via)
    {
        _blockedCount++;
        try
        {
            string line = DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "|" + via + "|"
                + _blockedCount.ToString();
            File.WriteAllText(_flagPath, line);
        }
        catch { }
        Log("blocked via " + via + " total=" + _blockedCount.ToString());
    }

    protected override void OnHandleCreated(EventArgs e)
    {
        base.OnHandleCreated(e);

        /* 这句是 Windows「阻止关机」界面上显示的理由文字 */
        try { ShutdownBlockReasonCreate(Handle, "ChaosConsole 不允许关机"); } catch { }

        EnsurePrivilege();

        /* 把「撤销入口到底解到哪个库」记下来 —— 解不到就等于只会拦、不会撤，
         * 这种能力差异必须在日志里能看到，否则排查时又是一句谜语 err=2 */
        try
        {
            ResolveAbort();
            Log("abort entry: " + (_abortEntry == "" ? "(not found — 只能拦截)" : _abortEntry));
        }
        catch (Exception ex)
        {
            Log("abort entry resolve failed: " + ex.Message);
        }

        /* ready.flag 里带上权限状态，界面据此如实说明「只拦得住」还是「还能撤销定时关机」 */
        try
        {
            File.WriteAllText(_readyPath, "ok|privileged=" + (_privilege ? "1" : "0"));
        }
        catch { }

        _timer.Start();
        Log("guard ready hwnd=" + Handle.ToString() + " privilege=" + _privilege.ToString());

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
            result = blocked && flagged
                ? "PASS privilege=" + (_privilege ? "1" : "0")
                : "FAIL result=" + r.ToString() + " flag=" + flagged.ToString();
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
            /* 这里只做两件极快的事：落标记、把撤销动作排到消息循环之后。
             * 绝不能在这里调 AbortSystemShutdown —— 系统正等我们回话，
             * 卡住超过 5 秒就会被判「未响应」，反而把强制关机入口递给用户。 */
            MarkBlocked("query");
            try { BeginInvoke(new MethodInvoker(delegate { AbortNow("query"); })); } catch { }
            Log("veto WM_QUERYENDSESSION lParam=" + m.LParam.ToString());
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
$flag  = Join-Path $root 'blocked.flag'
$stop  = Join-Path $root 'stop.flag'
$abort = Join-Path $root 'abort.flag'
$ready = Join-Path $root 'ready.flag'
$log   = Join-Path $root 'guard.log'
$cs    = Join-Path $root 'guard.cs'

function Write-Log([string]$msg) {
  try { Add-Content -Path $log -Value ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $msg) -Encoding UTF8 } catch { }
}

Write-Log "guard process start pid=$PID"

# 主路径：编一个隐藏窗体，在 WndProc 里拒掉 WM_QUERYENDSESSION，并定时撤销待执行关机
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
  $selfTest = ($env:CHAOS_GUARD_SELFTEST -eq '1')
  $parentPid = 0
  if ($env:CHAOS_GUARD_PARENT_PID) { try { $parentPid = [int]$env:CHAOS_GUARD_PARENT_PID } catch { $parentPid = 0 } }
  try {
    $form = New-Object ChaosShutdownGuard -ArgumentList $flag, $stop, $abort, $ready, $log, $selfTest, $parentPid
    $form.ShowDialog() | Out-Null
    Write-Log "guard form closed, exiting"
  } catch {
    Write-Log ("guard form failed: " + $_.Exception.Message)
    Set-Content -Path (Join-Path $root 'failed.flag') -Value $_.Exception.Message -Encoding UTF8
  }
  Remove-Item -Path $ready -Force -ErrorAction SilentlyContinue
  exit 0
}

# 兜底：Add-Type 不可用（受限环境 / .NET 缺失）时用 SystemEvents
try {
  Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue | Out-Null
  $handler = {
    param($s, $e)
    try { Set-Content -Path $flag -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '|fallback|1') -Encoding UTF8 } catch { }
    $e.Cancel = $true
    Write-Log "blocked via SystemEvents.SessionEnding"
  }
  [Microsoft.Win32.SystemEvents]::add_SessionEnding($handler)
  Set-Content -Path (Join-Path $root 'fallback.flag') -Value '1' -Encoding UTF8
  Write-Log "fallback SystemEvents handler registered"
  while (-not (Test-Path $stop)) {
    if (Test-Path $abort) {
      Remove-Item -Path $abort -Force -ErrorAction SilentlyContinue
      & shutdown.exe /a 2>$null | Out-Null
    }
    Start-Sleep -Milliseconds 400
  }
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

/** 守护被杀后自动重启的次数上限；编译不出来这种硬失败不值得反复试 */
const MAX_RESTARTS = 3

class ShutdownGuard {
  constructor({ userDataDir, onBlocked, onStatus } = {}) {
    this.dir = guardDir(userDataDir)
    this.onBlocked = typeof onBlocked === 'function' ? onBlocked : () => {}
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {}
    this.child = null
    this.poll = null
    this.wanted = false
    this.enabled = false
    this.restarts = 0
    this.restartTimer = null
    this.privileged = null
    this.lastStatus = 'idle'
  }

  file(name) {
    return path.join(this.dir, name)
  }

  status() {
    return {
      enabled: this.enabled,
      status: this.lastStatus,
      supported: supported(),
      privileged: this.privileged,
      dir: this.dir,
    }
  }

  setStatus(s, detail = '') {
    this.lastStatus = s
    try {
      this.onStatus({ status: s, detail, enabled: this.enabled, privileged: this.privileged })
    } catch (_) {
      /* 通知失败不能影响守护本身 */
    }
  }

  /** 清掉上一次留下的标记，否则一启动就弹「已阻止关机」 */
  resetFlags() {
    for (const f of [
      'blocked.flag',
      'stop.flag',
      'ready.flag',
      'abort.flag',
      'failed.flag',
      'fallback.flag',
      'selftest.flag',
    ]) {
      try {
        fs.rmSync(this.file(f), { force: true })
      } catch (_) {
        /* ignore */
      }
    }
  }

  /**
   * 主进程收到会话结束请求（系统已经决定要关机）时调用。
   * 不 spawn `shutdown /a`：命令行工具会被守护自己的 shutdown.exe 嗅探误杀，
   * 写标记让守护用 AbortSystemShutdown 撤，权限已在守护里启用过。
   */
  abortNow() {
    try {
      fs.writeFileSync(this.file('abort.flag'), String(Date.now()), 'utf8')
      return true
    } catch (_) {
      return false
    }
  }

  stop() {
    this.wanted = false
    this.enabled = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
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
    this.wanted = false
    this.enabled = false
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
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
      this.wanted = true
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

    this.wanted = true
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
      if (!this.wanted) return
      /* 守护被杀了 / 自己崩了：只要用户还开着这个开关，就得把它拉起来，
       * 否则「已开启」是个谎。编译不出来这种硬失败不无限重试。 */
      let why = ''
      try {
        why = fs.readFileSync(this.file('failed.flag'), 'utf8').trim()
      } catch (_) {
        /* ignore */
      }
      if (why) {
        this.enabled = false
        this.wanted = false
        this.setStatus('error', why)
        return
      }
      if (this.restarts >= MAX_RESTARTS) {
        this.enabled = false
        this.setStatus('error', `guard exit ${code}（重启 ${this.restarts} 次仍未成功）`)
        return
      }
      this.restarts += 1
      this.setStatus('restarting', `guard exit ${code}`)
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null
        if (this.wanted) this.start()
      }, 800)
      if (this.restartTimer.unref) this.restartTimer.unref()
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
      if (this.lastStatus === 'starting' || this.lastStatus === 'restarting') {
        if (fs.existsSync(this.file('ready.flag'))) {
          this.restarts = 0
          try {
            const text = fs.readFileSync(this.file('ready.flag'), 'utf8')
            this.privileged = /privileged=1/.test(text)
          } catch (_) {
            this.privileged = null
          }
          this.setStatus('running')
        } else if (fs.existsSync(this.file('fallback.flag'))) {
          this.privileged = false
          this.setStatus('running-fallback')
        }
      }
      let stamp = ''
      try {
        stamp = fs.readFileSync(this.file('blocked.flag'), 'utf8').trim()
      } catch (_) {
        return
      }
      if (stamp && stamp !== last) {
        last = stamp
        const [at, via, count] = stamp.split('|')
        try {
          this.onBlocked({ at, via, count: Number(count) || 0 })
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
    if (!enabled && (this.enabled || this.wanted)) {
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
      out = { ok: text.startsWith('PASS'), detail: text, privileged: /privilege=1/.test(text) }
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
