# 10.0.5 — 关机守护做到完全阻止关机，安装界面能自己挑版本

## 一、关机守护：从「能拦」变成「拦得住」

10.0.1 加的关机守护有一个前提没说透：它只是**被问一句时回一句「不许」**。这次把
整条链路补齐，才叫完全阻止。四个真问题，第一个最要命：

### 0. 撤销接口从来就没生效过

按微软文档，`AbortSystemShutdown` 声明在 `user32.dll`。但在这台机器
（Windows 11 26200）上，`user32.dll` 只导出 `ExitWindowsEx`，真正的位置是
**`advapi32.dll` 的 `AbortSystemShutdownW`**：

```
user32.dll    : ExitWindowsEx
advapi32.dll  : AbortSystemShutdownA  AbortSystemShutdownW  InitiateSystemShutdownExW
```

静态 P/Invoke 于是每次都抛 `EntryPointNotFoundException`，而它被
`try { … } catch { }` 吞掉了 —— 表现出来就是「撤销永远返回失败，日志里只有一句
莫名其妙的 `err=2`」。也就是说，**之前几版所谓「自动取消关机」一次都没成功过**，
用户看到的「取消」其实只是 `WM_QUERYENDSESSION` 回了 `FALSE` 让系统停下来，
定时关机、更新重启这类根本拦不住。

现在改成运行时解析：`advapi32` → `user32`，按 `W` / `A` / 裸名逐个
`GetProcAddress`，解不到就在日志和设置页里明说「只能拦截，撤不掉定时关机」，
不再假装成功。本机实测解到 `advapi32.dll!AbortSystemShutdownW`。

### 1. 在关机请求的处理函数里同步撤销，会反噬

原来的写法是在 `WM_QUERYENDSESSION` 里先 `AbortSystemShutdown` 再返回 `FALSE`：

```
Windows: 我要关机了，行吗？（SendMessageTimeout，最多等 5 秒）
本应用:  等一下，我先调系统接口把这次关机撤掉…
         ↑ 系统正等回话，这一步一旦卡住 → 判定「未响应」
         → Windows 直接把「仍要关机」按钮递到用户手里
```

也就是说，**越是努力撤销，越容易被系统当成卡死而放过**。

现在处理函数只做两件极快的事：写一个标记文件、把撤销动作 `BeginInvoke` 出去，
然后立刻返回 `FALSE`。撤销在消息循环回到我们手里之后才执行。

### 2. 撤销一直缺权限，之前能撤掉全靠运气

`SeShutdownPrivilege` 默认躺在用户令牌里，但**是禁用状态**。不显式
`AdjustTokenPrivileges` 打开它，`AbortSystemShutdown` 会恒定返回
`ERROR_ACCESS_DENIED`（5），看起来像「系统不让撤」。守护进程现在开机就启用这个
权限，并按 `ERROR_NOT_ALL_ASSIGNED` 判断是否真的拿到；被组策略收走时，设置页会
如实写「只能拦截，撤不掉定时关机」，不假装已完全生效。

### 3. 很多关机根本不走交互界面

`shutdown /s /t 60`、Windows 更新后的 `UsoClient` 重启、别的程序调
`InitiateSystemShutdownEx`，这些可能直接进入倒计时，不给应用回应的机会。现在守护
进程每 **400ms** 检查一次是否存在待执行的关机，有就撤掉 —— 用户连「正在关机」都
看不到。区分「没有待执行关机」（`ERROR_NO_SHUTDOWN_IN_PROGRESS`，正常静默）和
真失败，不刷日志。

另外把 `shutdown.exe` / `PsShutdown` / `UsoClient` 这三类工具直接终止，脚本化关机
也绕不过去；终止不到还有上面两条兜着。

### 还有一处隐患顺手修了

守护进程如果被任务管理器结束、或自己崩了，之前设置里仍显示「已生效」—— 这是谎。
现在会自动重新拉起（最多 3 次），并如实反馈状态；父进程（应用）消失时守护自己退出，
不留孤儿进程把机器锁死。

### 边界，说清楚

**长按电源键断电、以及内核/硬件层的强制断电，任何用户态软件都拦不住。** 除此之外
的常规路径都覆盖了：开始菜单关机/重启/注销、Alt+F4 电源菜单、`shutdown` 命令、
定时关机、脚本关机、Windows 更新重启、其它程序调接口发起的关机。

## 二、安装 / 更新界面新增「其他版本」

以前想装回旧版，只能去 GitHub Releases 手动下载。「设置 → 关于」里那一小块也不直观。
现在**更新弹窗里直接有「其他版本」**：

- 点「选择其他版本」拉取发布列表（可刷新），逐条显示版本号、发布时间、大小、是否当前版本；
- 点「下载」即下发该版安装包，进度和正常升级同一条显示；
- 下完仍要点「安装并重启」，与正常升级共用确认流程 —— 不会出现「点一下就把程序换掉」。

被 GitHub 限流时（未登录 API 每小时 60 次 / IP），提示改成能照着做的说法，并给出
Releases 网页地址兜底，不是干巴巴一个 `HTTP 403`。

## 验证

- **关机守护自检**：真编译 C#、真发 `WM_QUERYENDSESSION`、真撤销，全程不关机；
- **定时关机实测**（新增 `scripts/probe-shutdown-poll.js`）：守护跑着 → 下发
  `shutdown /s /t 1800` → 3 秒后外部用 `shutdown /a` 探测，返回 **1116**
  （已经没有待执行关机），而守护日志同时记下
  `abort entry in use: advapi32.dll!AbortSystemShutdownW` 和 `blocked via abort total=1`
  —— 内外两条证据对上，说明确实是被守护撤掉的；脚本里定时器给的是 30 分钟、
  且无论结果如何都会自己撤销一次，跑这个脚本不会真关机；
- 静态审计 **440/440** 通过（新增 34 条：撤销入口不得静态声明在 user32、运行时按
  advapi32 → user32 解析、禁止在查询处理里同步撤销、`BeginInvoke` 排后、回 `FALSE`、
  `SeShutdownPrivilege` 启用与权限判定、400ms 轮询、三类关机工具、自动重启、
  限流提示、版本选择三处接线、三处说明同步）
- regress 50/50、regress:v8 64/64、i18n 359/359 无回归
- 安装包 `ChaosConsole-Setup-10.0.5.exe`（NSIS 编译通过，卸载器沿用 10.0.3 的五项清单）。

## 升级方式

覆盖安装 10.0.5 即可。已经开着「运行期间禁止关机」的用户，装上后守护进程会换成新的
实现，不需要重新勾选；设置页会显示当前状态与权限情况。
