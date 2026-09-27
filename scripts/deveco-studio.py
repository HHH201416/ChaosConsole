#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DevEco Studio 桌面操作。

为什么需要它：Agent 跑在命令行里，对 DevEco Studio 只能做「启动 / 打开工程」这种
粗粒度动作，进不去 IDE 里面点菜单、跑构建、看结果。这个脚本把 IDE 的图形界面变成
一组可脚本化的命令，供 MCP 服务器和 Agent 的 Bash 共同调用。

为什么用 Python 而不是 PowerShell：
    Windows 默认的执行策略是 Restricted，.ps1 文件在此策略下**根本无法加载**
    （"在此系统上禁止运行脚本"），而放宽策略属于改动用户安全设置，不该由工具来做。
    Python 脚本不受该策略约束，且本脚本只用 ctypes 调 Win32，零第三方依赖。

设计取舍 —— 菜单操作用键盘而不是 UI 点击：
    DevEco Studio 是 IntelliJ 内核（Java），菜单由 IDE 自己绘制，不是 Win32 原生菜单。
    UIAutomation 能否看到取决于 Java Access Bridge 是否开启，很不可靠。而 IntelliJ 有
    一条稳得多也更强大的路：Ctrl+Shift+A 打开「Find Action」，输入动作名回车即可执行
    几乎所有功能（构建、同步、运行、打开设置……）。所以 action 走 Find Action，
    menu 走 Alt 助记键，只有截图和 UI 树用 Win32 接口。

用法：
    python scripts/deveco-studio.py launch [工程目录]
    python scripts/deveco-studio.py focus
    python scripts/deveco-studio.py action "Build Hap(s)/APP(s)"
    python scripts/deveco-studio.py menu "File/New/Project"
    python scripts/deveco-studio.py hotkey "^+a"
    python scripts/deveco-studio.py type "要输入的文字"
    python scripts/deveco-studio.py tree [深度]
    python scripts/deveco-studio.py shot [输出路径]
    python scripts/deveco-studio.py status

退出码：0 成功，1 失败（错误信息走 stderr）。
"""

import ctypes
import ctypes.wintypes as wt
import json
import os
import struct
import subprocess
import sys
import time
import zlib

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

PROCESS_NAME = os.environ.get("CHAOS_DEVECO_PROC", "devecostudio64")

STUDIO_CANDIDATES = [
    os.environ.get("CHAOS_DEVECO_STUDIO"),
    r"D:\DevEco Studio",
    r"C:\Program Files\Huawei\DevEco Studio",
    os.path.expanduser(r"~\DevEco Studio"),
]


def die(msg):
    sys.stderr.write("[deveco-studio] %s\n" % msg)
    sys.exit(1)


def ok(msg=""):
    if msg:
        sys.stdout.write("%s\n" % msg)
        sys.stdout.flush()


# ------------------------------------------------------------------ 窗口定位

EnumWindowsProc = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

user32.GetWindowThreadProcessId.argtypes = [wt.HWND, ctypes.POINTER(wt.DWORD)]
user32.IsWindowVisible.argtypes = [wt.HWND]
user32.GetWindowTextLengthW.argtypes = [wt.HWND]
user32.GetWindowTextW.argtypes = [wt.HWND, wt.LPWSTR, ctypes.c_int]
user32.SetForegroundWindow.argtypes = [wt.HWND]
user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
user32.IsIconic.argtypes = [wt.HWND]
user32.GetForegroundWindow.restype = wt.HWND
user32.AttachThreadInput.argtypes = [wt.DWORD, wt.DWORD, wt.BOOL]
user32.BringWindowToTop.argtypes = [wt.HWND]
user32.SetFocus.argtypes = [wt.HWND]
user32.SetFocus.restype = wt.HWND
user32.VkKeyScanW.argtypes = [ctypes.c_wchar]
user32.VkKeyScanW.restype = ctypes.c_short
kernel32.GetCurrentThreadId.restype = wt.DWORD

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
kernel32.OpenProcess.argtypes = [wt.DWORD, wt.BOOL, wt.DWORD]
kernel32.OpenProcess.restype = wt.HANDLE
kernel32.QueryFullProcessImageNameW.argtypes = [wt.HANDLE, wt.DWORD, wt.LPWSTR, ctypes.POINTER(wt.DWORD)]
kernel32.CloseHandle.argtypes = [wt.HANDLE]


def _exe_basename(pid):
    h = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return ""
    try:
        buf = ctypes.create_unicode_buffer(1024)
        size = wt.DWORD(1024)
        if kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
            return os.path.basename(buf.value)
        return ""
    finally:
        kernel32.CloseHandle(h)


def _window_title(hwnd):
    n = user32.GetWindowTextLengthW(hwnd)
    if n <= 0:
        return ""
    buf = ctypes.create_unicode_buffer(n + 1)
    user32.GetWindowTextW(hwnd, buf, n + 1)
    return buf.value


def _same_proc(exe_basename, proc_name):
    """
    比较进程名时要忽略 .exe —— 调用方习惯写 'devecostudio64'，而
    QueryFullProcessImageNameW 返回的是 'devecostudio64.exe'，
    精确比较永远不相等（这个坑踩过一次）。
    """
    def norm(name):
        n = (name or "").lower()
        # 只砍末尾的 '.exe'，不用 os.path.splitext：后者在**最后一个点**处切分，
        # 而名字里带版本号时最后那个点是版本的一部分 ——
        # splitext('ChaosConsole-Setup-1.0.2') 得到 'ChaosConsole-Setup-1.0'，
        # 于是它和 'ChaosConsole-Setup-1.0.2.exe' 永远比不相等。
        return n[:-4] if n.endswith(".exe") else n

    a, b = norm(exe_basename), norm(proc_name)
    return bool(a) and a == b


def find_window(proc_name=PROCESS_NAME, title_filter=None):
    """
    按进程可执行文件名找主窗口。返回 (hwnd, title, pid) 或 None。

    DevEco Studio 可以同时开好几个工程窗口（每个是一组同名的 devecostudio64
    进程），直接取「第一个」会随机命中其中一个 —— 结果就是对着 A 工程截图、
    却往 B 工程按快捷键。所以这里按确定性顺序挑：
      1. 有 title_filter 时只认标题匹配的
      2. 优先当前前台的那个（最符合「我正在看哪个」的直觉）
      3. 否则取面积最大的（主窗口通常比弹窗/工具窗大）
    """
    found = []
    fg = user32.GetForegroundWindow()

    def cb(hwnd, _):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wt.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value and _same_proc(_exe_basename(pid.value), proc_name):
            title = _window_title(hwnd)
            if not title:
                return True
            if title_filter and title_filter.lower() not in title.lower():
                return True
            rect = wt.RECT()
            area = 0
            if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                area = max(0, rect.right - rect.left) * max(0, rect.bottom - rect.top)
            found.append((hwnd, title, pid.value, area, hwnd == fg))
        return True

    user32.EnumWindows(EnumWindowsProc(cb), 0)
    if not found:
        return None
    foreground = [f for f in found if f[4]]
    pool = foreground or found
    best = max(pool, key=lambda f: f[3])
    return (best[0], best[1], best[2])


def require_window():
    w = find_window()
    if not w:
        die("没找到 DevEco Studio 窗口（进程名 %s）。先执行 launch 打开它。" % PROCESS_NAME)
    return w


def focus_window(hwnd):
    """
    把窗口切到前台。

    Windows 有「前台锁」：只有当前前台进程才能调用 SetForegroundWindow 抢焦点，
    否则调用会被静默忽略（返回成功但没生效）。标准解法是把自己附加到前台线程的
    输入队列上（AttachThreadInput），这样系统就认为你是前台进程的一部分。
    """
    if user32.IsIconic(hwnd):
        user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(0.3)

    # 注意：不能因为「已经是前台」就提前返回。前台 ≠ 有键盘焦点，
    # 而 SetFocus 需要先 attach 到目标线程，所以下面这段每次都要走。
    fg = user32.GetForegroundWindow()
    fg_tid = user32.GetWindowThreadProcessId(fg, None) if fg else 0
    my_tid = kernel32.GetCurrentThreadId()

    attached = False
    if fg_tid and fg_tid != my_tid:
        if user32.AttachThreadInput(fg_tid, my_tid, True):
            attached = True
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
        user32.ShowWindow(hwnd, 5)  # SW_SHOW
        # 关键的一步：SetForegroundWindow 只是「激活」，不等于「拿到键盘焦点」。
        # 只激活不设焦点的话，SendInput 的按键会被系统投递到别处 —— 表现为
        # 事件发送成功、IDE 却毫无反应（实测：同样的按键打进记事本完全正常）。
        # SetFocus 只能作用于本线程的窗口，所以必须在 AttachThreadInput 期间调用。
        user32.SetFocus(hwnd)
    finally:
        if attached:
            user32.AttachThreadInput(fg_tid, my_tid, False)

    for _ in range(6):
        if user32.GetForegroundWindow() == hwnd:
            return True
        time.sleep(0.2)

    # 最后一招：单独敲一下 Alt，系统会解除当前的前台锁，之后再抢一次
    _send(_key(0x12), _key(0x12, up=True))
    time.sleep(0.2)
    user32.SetForegroundWindow(hwnd)
    time.sleep(0.35)
    return user32.GetForegroundWindow() == hwnd


# ------------------------------------------------------------------ 键盘输入

INPUT_KEYBOARD = 1
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_UNICODE = 0x0004
KEYEVENTF_EXTENDEDKEY = 0x0001

VK = {
    "enter": 0x0D, "return": 0x0D, "esc": 0x1B, "escape": 0x1B,
    "tab": 0x09, "space": 0x20, "backspace": 0x08, "delete": 0x2E,
    "up": 0x26, "down": 0x28, "left": 0x25, "right": 0x27,
    "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22,
    "f1": 0x70, "f2": 0x71, "f3": 0x72, "f4": 0x73, "f5": 0x74, "f6": 0x75,
    "f7": 0x76, "f8": 0x77, "f9": 0x78, "f10": 0x79, "f11": 0x7A, "f12": 0x7B,
}
MODS = {"^": 0x11, "+": 0x10, "%": 0x12}  # Ctrl / Shift / Alt


class KEYBDINPUT(ctypes.Structure):
    _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                ("time", wt.DWORD), ("dwExtraInfo", ctypes.POINTER(wt.ULONG))]


class INPUT(ctypes.Structure):
    """
    x64 上这个联合体是 40 字节：type(4) + 对齐(4) + 联合体(32)。
    联合体里最大的是 MOUSEINPUT（32 字节），只按 KEYBDINPUT 的 24 字节留空间
    会让 sizeof(INPUT) 变成 32，SendInput 收到错误的 cbSize 后**静默失败**
    （返回 0，不报错）——这个坑踩过一次，所以下面必须校验返回值。
    """
    class _U(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("padding", ctypes.c_byte * 32)]
    _anonymous_ = ("u",)
    _fields_ = [("type", wt.DWORD), ("u", _U)]


def _send(*inputs):
    """
    逐个事件调用 SendInput。

    实测：一次传入多个 INPUT（哪怕只有 2 个）时 SendInput 恒定返回 0、一个都不插；
    拆成每次 1 个就全部成功。原因未查明（不是 UIPI，两边进程都未提升），
    但既然是稳定复现且逐事件发送同样正确，就走这条路。事件之间留一点间隔，
    否则 IDE 可能来不及处理修饰键的状态切换。
    """
    for i, ev in enumerate(inputs):
        arr = (INPUT * 1)(ev)
        sent = user32.SendInput(1, ctypes.byref(arr), ctypes.sizeof(INPUT))
        if sent != 1:
            die("SendInput 失败（第 %d 个事件被拒，GetLastError=%d）" % (i + 1, ctypes.get_last_error()))
        time.sleep(0.03)


def _key(vk, up=False):
    return INPUT(type=INPUT_KEYBOARD,
                 ki=KEYBDINPUT(wVk=vk, wScan=0,
                               dwFlags=(KEYEVENTF_KEYUP if up else 0),
                               time=0, dwExtraInfo=None))


def _unicode_char(ch):
    """用 KEYEVENTF_UNICODE 直接送字符，绕开键盘布局 —— 中文也能输入。"""
    scan = ord(ch)
    return (INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(wVk=0, wScan=scan, dwFlags=KEYEVENTF_UNICODE, time=0, dwExtraInfo=None)),
            INPUT(type=INPUT_KEYBOARD, ki=KEYBDINPUT(wVk=0, wScan=scan, dwFlags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time=0, dwExtraInfo=None)))


def _char_to_vk(ch):
    """
    把单个字符映射成虚拟键码。

    组合键必须走虚拟键码：KEYEVENTF_UNICODE 是直接注入字符的，它绕过键盘布局，
    也不与 Ctrl/Shift 这类修饰键组合 —— 用 Unicode 方式发 '^+a' 会得到「Shift+A」
    甚至什么都没有，修饰键被白白丢掉。
    """
    if "a" <= ch <= "z":
        return 0x41 + (ord(ch) - ord("a"))
    if "A" <= ch <= "Z":
        return 0x41 + (ord(ch) - ord("A"))
    if "0" <= ch <= "9":
        return 0x30 + (ord(ch) - ord("0"))
    v = user32.VkKeyScanW(ord(ch))
    return (v & 0xFF) if v not in (-1, 0xFFFF) else 0


def send_hotkey(spec):
    """spec 形如 '^+a'（^=Ctrl +=Shift %=Alt）或 'enter' / '^s'。"""
    mods = []
    i = 0
    while i < len(spec) and spec[i] in MODS:
        mods.append(MODS[spec[i]])
        i += 1
    key_part = spec[i:]
    if not key_part:
        die("快捷键缺少主键：%r" % spec)

    low = key_part.lower()
    if low in VK:
        vk = VK[low]
    elif len(key_part) == 1:
        vk = _char_to_vk(key_part)
        if not vk:
            die("无法识别的按键：%r" % key_part)
    else:
        die("无法识别的按键：%r" % key_part)

    seq = [_key(m) for m in mods] + [_key(vk), _key(vk, up=True)] + [_key(m, up=True) for m in reversed(mods)]
    _send(*seq)
    time.sleep(0.08)


def send_text(text):
    for ch in text:
        pair = _unicode_char(ch)
        _send(*pair)
        time.sleep(0.012)


def find_action(name):
    """IntelliJ 的 Find Action：Ctrl+Shift+A → 输动作名 → 回车。"""
    send_hotkey("^+a")
    time.sleep(0.9)
    send_text(name)
    time.sleep(1.2)
    send_hotkey("enter")
    time.sleep(0.4)


# ------------------------------------------------------------------ 截图

def find_studio_paths():
    out = {}
    for root in STUDIO_CANDIDATES:
        if not root:
            continue
        exe = os.path.join(root, "bin", "devecostudio64.exe")
        if os.path.isfile(exe):
            out["studioDir"] = root
            out["studioExe"] = exe
            for key, rel in (
                ("hvigorw", os.path.join("tools", "hvigor", "bin", "hvigorw.bat")),
                ("ohpm", os.path.join("tools", "ohpm", "bin", "ohpm.bat")),
                ("hdc", os.path.join("sdk", "default", "openharmony", "toolchains", "hdc.exe")),
            ):
                cand = os.path.join(root, rel)
                if os.path.isfile(cand):
                    out[key] = cand
            break
    return out


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", wt.DWORD), ("biWidth", wt.LONG), ("biHeight", wt.LONG),
                ("biPlanes", wt.WORD), ("biBitCount", wt.WORD), ("biCompression", wt.DWORD),
                ("biSizeImage", wt.DWORD), ("biXPelsPerMeter", wt.LONG),
                ("biYPelsPerMeter", wt.LONG), ("biClrUsed", wt.DWORD), ("biClrImportant", wt.DWORD)]


class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wt.DWORD * 3)]


def _write_png(path, width, height, bgra_rows):
    """把 BGRA 行写成 PNG。只用 zlib，不引入 Pillow。"""
    raw = b"".join(b"\x00" + bytes(row) for row in bgra_rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    # 每行前补 filter byte，再把 BGRA 转成 RGBA
    rows = []
    for row in bgra_rows:
        px = bytearray()
        for i in range(0, len(row), 4):
            b, g, r, a = row[i], row[i + 1], row[i + 2], row[i + 3]
            px += bytes((r, g, b, 255))
        rows.append(b"\x00" + bytes(px))
    raw = b"".join(rows)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 6))
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)


def capture_window(hwnd, path):
    rect = wt.RECT()
    if not user32.GetWindowRect(hwnd, ctypes.byref(rect)):
        die("拿不到窗口尺寸")
    w = rect.right - rect.left
    h = rect.bottom - rect.top
    if w <= 0 or h <= 0:
        die("窗口尺寸异常：%dx%d" % (w, h))

    hdc = user32.GetWindowDC(hwnd)
    if not hdc:
        die("GetWindowDC 失败")
    mem = None
    bmp = None
    try:
        mem = gdi32.CreateCompatibleDC(hdc)
        bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
        gdi32.SelectObject(mem, bmp)

        # PW_RENDERFULLCONTENT(3)：抓得到 DirectComposition 渲染的内容
        PW_RENDERFULLCONTENT = 3
        if not user32.PrintWindow(hwnd, mem, PW_RENDERFULLCONTENT):
            gdi32.BitBlt(mem, 0, 0, w, h, hdc, 0, 0, 0x00CC0020)  # SRCCOPY 兜底

        info = BITMAPINFO()
        info.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
        info.bmiHeader.biWidth = w
        info.bmiHeader.biHeight = -h  # 负数 = 自上而下
        info.bmiHeader.biPlanes = 1
        info.bmiHeader.biBitCount = 32
        info.bmiHeader.biCompression = 0

        buf = ctypes.create_string_buffer(w * h * 4)
        got = gdi32.GetDIBits(mem, bmp, 0, h, buf, ctypes.byref(info), 0)
        if not got:
            die("GetDIBits 失败")
        data = buf.raw
        rows = [data[y * w * 4:(y + 1) * w * 4] for y in range(h)]
        _write_png(path, w, h, rows)
    finally:
        if bmp:
            gdi32.DeleteObject(bmp)
        if mem:
            gdi32.DeleteDC(mem)
        user32.ReleaseDC(hwnd, hdc)
    return w, h


# ------------------------------------------------------------------ UI 树

def dump_tree(hwnd, max_depth=4):
    """
    用 UIAutomation 走一遍控件树。

    IntelliJ 内核的控件是否可见取决于 Java Access Bridge，看不到是常态而不是错误 ——
    真正操作 IDE 请用 action / menu / hotkey，那几项走键盘，不依赖这里。
    """
    try:
        import comtypes.client  # noqa: F401
        have = True
    except Exception:
        have = False

    if not have:
        return None

    try:
        import comtypes.client as cc
        cc.GetModule("UIAutomationCore.dll")
        import comtypes.gen.UIAutomationClient as UIA
        uia = cc.CreateObject(UIA.CUIAutomation, interface=UIA.IUIAutomation)
        root = uia.ElementFromHandle(hwnd)
        lines = []

        def walk(el, depth):
            if depth > max_depth:
                return
            try:
                name = el.CurrentName
                ctype = uia.GetControlTypeName(el.CurrentControlType) if hasattr(uia, "GetControlTypeName") else ""
            except Exception:
                return
            if name or ctype:
                lines.append("%s%s\t%s" % ("  " * depth, ctype, name))
            try:
                walker = uia.RawViewWalker
                child = walker.GetFirstChildElement(el)
                while child:
                    walk(child, depth + 1)
                    child = walker.GetNextSiblingElement(child)
            except Exception:
                pass

        walk(root, 0)
        return "\n".join(lines)
    except Exception as e:
        return None if "not found" in str(e).lower() else ("(UIAutomation 出错: %s)" % e)


# ------------------------------------------------------------------ 子命令

def cmd_launch(arg):
    paths = find_studio_paths()
    exe = paths.get("studioExe")
    if not exe:
        die("找不到 devecostudio64.exe。请设置环境变量 CHAOS_DEVECO_STUDIO 指向安装目录。")
    if arg and not os.path.isdir(arg):
        die("工程目录不存在：%s" % arg)

    existing = find_window()
    if existing and not arg:
        focus_window(existing[0])
        ok("DevEco Studio 已在运行（PID %d），已切到前台" % existing[2])
        return

    if arg:
        subprocess.Popen([exe, arg], close_fds=True)
    else:
        subprocess.Popen([exe], close_fds=True)
    ok("已启动 DevEco Studio%s" % ("，工程：%s" % arg if arg else ""))
    ok("提示：IntelliJ 内核首次打开工程要建索引，需要等一会儿再操作。")


def cmd_focus(_arg):
    hwnd, title, pid = require_window()
    if focus_window(hwnd):
        ok("已切到前台（PID %d）" % pid)
    else:
        die("无法把 DevEco Studio 切到前台（可能被系统权限拦截）")


def cmd_action(arg):
    if not arg:
        die('用法：action "动作名"，例如 action "Build Hap(s)/APP(s)"')
    hwnd, _, _ = require_window()
    if not focus_window(hwnd):
        die("无法把 DevEco Studio 切到前台")
    time.sleep(0.25)
    find_action(arg)
    ok("已触发动作：%s" % arg)


def cmd_menu(arg):
    if not arg:
        die('用法：menu "File/New/Project"（用 / 分隔层级）')
    parts = [p.strip() for p in arg.replace(">", "/").split("/") if p.strip()]
    if not parts:
        die("菜单路径为空")

    hwnd, _, _ = require_window()
    if not focus_window(hwnd):
        die("无法把 DevEco Studio 切到前台")
    time.sleep(0.25)

    # IntelliJ 顶级菜单都有 Alt 助记键（File/Edit/View/Navigate...）
    send_hotkey("%" + parts[0][0].lower())
    time.sleep(0.7)
    for i in range(1, len(parts)):
        ch = parts[i][0].lower()
        if i == len(parts) - 1:
            send_hotkey(ch)
            time.sleep(0.35)
            send_hotkey("enter")
        else:
            send_hotkey(ch)
            time.sleep(0.5)
    ok("已触发菜单：%s" % " / ".join(parts))


def cmd_hotkey(arg):
    if not arg:
        die('用法：hotkey "^+a"（^=Ctrl +=Shift %=Alt）')
    hwnd, _, _ = require_window()
    if not focus_window(hwnd):
        die("无法把 DevEco Studio 切到前台")
    time.sleep(0.2)
    send_hotkey(arg)
    ok("已发送快捷键：%s" % arg)


def cmd_type(arg):
    if not arg:
        die('用法：type "要输入的文字"')
    hwnd, _, _ = require_window()
    if not focus_window(hwnd):
        die("无法把 DevEco Studio 切到前台")
    time.sleep(0.2)
    send_text(arg)
    ok("已输入文本（%d 字符）" % len(arg))


def cmd_tree(arg):
    depth = 4
    if arg:
        try:
            depth = int(arg)
        except ValueError:
            pass
    hwnd, _, _ = require_window()
    text = dump_tree(hwnd, depth)
    if text is None:
        ok("（无法读取 UI 树）缺少 comtypes，或 DevEco Studio 未开启 Java Access Bridge。")
        ok("这不影响 action / menu / hotkey —— 那几项走键盘，不依赖 UI 树。")
        return
    if not text.strip():
        ok("（UI 树为空）DevEco Studio 是 IntelliJ 内核，未开启 Java Access Bridge 时")
        ok("UIAutomation 看不到内部控件。请改用 action / menu / hotkey。")
        return
    ok(text)


def cmd_shot(arg):
    out = arg or os.path.join(os.environ.get("TEMP", "."), "deveco-studio.png")
    hwnd, _, _ = require_window()
    if not focus_window(hwnd):
        die("无法把 DevEco Studio 切到前台")
    time.sleep(0.5)
    w, h = capture_window(hwnd, out)
    ok(out)
    ok("尺寸 %dx%d" % (w, h))


def cmd_status(_arg):
    info = find_studio_paths()
    w = find_window()
    info["running"] = bool(w)
    if w:
        info["pid"] = w[2]
        info["windowTitle"] = w[1]
    ok(json.dumps(info, ensure_ascii=False, indent=2))


COMMANDS = {
    "launch": cmd_launch, "focus": cmd_focus, "action": cmd_action,
    "menu": cmd_menu, "hotkey": cmd_hotkey, "type": cmd_type,
    "tree": cmd_tree, "shot": cmd_shot, "status": cmd_status,
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        die("用法：deveco-studio.py <%s> [参数]" % "|".join(COMMANDS))
    COMMANDS[sys.argv[1]](sys.argv[2] if len(sys.argv) > 2 else "")


if __name__ == "__main__":
    main()
