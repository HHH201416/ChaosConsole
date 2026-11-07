# 10.0.3 — 卸载器：五类残留逐项勾，能清到只剩 Windows

10.0.2 把卸载器做出来了，但它只有**一个**勾选框：「同时删除用户数据」。这等于把
「全清」和「全留」当成了全部选项。真实情况是中间还有几档：

- 有人想留下对话和岗位，但把 177 MB 的更新包副本清掉；
- 有人要彻底清干净，连 Ollama 那几个 G 的模型一起走；
- 有人机器上还跑着别的程序在用同一个 Ollama，引擎绝对不能碰。

10.0.3 把这一页换成**五项清单**，每一项都写清会删哪条路径、删了有什么后果。

## 卸载向导最后一页长这样

```
卸载完成 · 清理本机残留
程序文件已删除，下面这些还在本机，勾选要一并清除的

程序文件、快捷方式已经删掉了。下面这些不在这条路径上，勾掉不要的再点「完成」。

  [✓] 用户数据：对话、岗位、知识库、设置、AI 生成的文件
      %APPDATA%\chaos-console\data（数据库、生成的文件、备份）
  [✓] 缓存与更新包：网页缓存、下载过的安装包副本
      Cache 等缓存目录 + %LOCALAPPDATA%\chaos-console-updater（百 MB 级）
  [✓] 已下载的 MCP 工具：重装后按需重新下载
      %APPDATA%\chaos-console\mcp（本机实测 129 MB 左右）
  [✓] 早期版本残留：旧目录名、旧数据、证书文件
      %APPDATA%\chaosconsole、安装目录旧 data、家目录 CA 证书
  [ ] 混沌引擎与本地模型（默认保留 —— 可能被其它程序共用）
      %LOCALAPPDATA%\Programs\Ollama 与 %USERPROFILE%\.ollama（数 GB）

勾选的内容会被永久删除，删了无法恢复。
```

前四项默认勾选，第五项默认不勾。理由：前四项都是「本应用自己的东西，删了不心疼，
重装会重新生成或重新下载」；第五项是**本机共享资源**（Ollama 可被任何程序调用，
模型是几个小时下回来的），默认保留是对的选择，要删得自己动手。

## 每一项到底删什么

清单来自对本机 10.0.2 安装态的实际盘点，不是照着代码猜的：

| 项目 | 路径 | 本机实测 | 说明 |
|---|---|---|---|
| 用户数据 | `%APPDATA%\chaos-console\data` + `theme.json` / `window-state.json` + `Local Storage` / `Session Storage` / `blob_storage` / `shutdown-guard` | 3 MB | `chaos.db` 在 data 里，对话/岗位/知识库/生成物/备份全在这 |
| 缓存与更新包 | `Cache`、`Code Cache`、`GPUCache`、`Dawn*Cache`、`Shared Dictionary`、`SharedStorage`、`Dictionaries`、`Network`、`Preferences`、`Local State`、`DevToolsActivePort`；`%LOCALAPPDATA%\chaos-console-updater`；`%LOCALAPPDATA%\ChaosConsole`；`%TEMP%\ChaosConsole-Setup-*.exe` | 184 MB | 更新器下载的安装包副本从来不会自己清 —— 这是上一版漏掉的最大一块 |
| MCP 工具 | `%APPDATA%\chaos-console\mcp` | 129 MB | 1 万多个文件，重装后按需重新下载 |
| 早期残留 | `%APPDATA%\chaosconsole`（8.x 旧名）、`%LOCALAPPDATA%\chaosconsole`、`$INSTDIR\resources\app\data`（早期版本把数据放在安装目录）、`%USERPROFILE%\.chaos_ca_bundle.crt`、`.chaos_steamtools_ca.pem` | 9.5 MB | 旧目录名不清就会留一份「看不见但占地方」的残留 |
| 引擎与模型 | `%LOCALAPPDATA%\Programs\Ollama`、`%APPDATA%\Ollama`、`%USERPROFILE%\.ollama` | 数 GB | 删除顺序：停进程 → 官方卸载器 → 目录兜底 → 清注册表卸载项 |

清完最后会尝试 `RMDir` 掉只剩空壳的容器目录（非递归，里面还有东西就不动）。

## 顺带修掉一个隐藏 bug：按「所有用户」安装时，10.0.2 什么也没删掉

打包核对时发现的：本机 10.0.2 是按 **all users** 装的（`/allusers`，装在
`D:\软件与文档\ChaosConsole`）。这种安装下 electron-builder 的卸载器会
`SetShellVarContext all`，于是 NSIS 把

```
$APPDATA      -> C:\ProgramData     （不是用户的 Roaming）
$LOCALAPPDATA -> C:\ProgramData     （不是用户的 Local）
```

10.0.2 的代码是 `RMDir /r "$APPDATA\chaos-console"` —— 在 all-users 安装上删的是一个
不存在的路径，`RMDir` 静默成功，用户看到「卸载完成」，数据其实一个没动。

10.0.3 改成先 `ReadEnvStr` 读进程环境变量（不受 shell var context 影响）到
`$ChaosUnAppData` / `$ChaosUnLocalApp` / `$ChaosUnTemp` / `$ChaosUnProfile`，
再拼路径。页面上的路径说明也用解析后的值显示，不会再出现
`C:\ProgramData\chaos-console` 这种「根本不存在的位置」。

## 删除失败要说出来

文件被占用（开着资源管理器窗口、杀毒软件正在扫）时 `RMDir /r` 是**静默失败**的。
老实现只对 `%APPDATA%\chaos-console` 一个路径做检查，10.0.3 改成把每一处失败都攒进
一个列表，最后一次性弹出来：

```
以下内容没能删除，多半是被占用了：

· C:\Users\...\AppData\Roaming\chaos-console\mcp
· C:\Users\...\.ollama（有文件被占用）

关掉资源管理器窗口或杀毒软件后，手动删掉即可。
```

比「看起来清完了、其实没清」有用。

## 引擎为什么走官方卸载器

`%LOCALAPPDATA%\Programs\Ollama` 是官方安装器装的，自带 NSIS 卸载器。直接 `RMDir /r`
能把文件删掉，但注册表里的卸载项、开始菜单项会留下，用户在「应用和功能」里能看到
一个点了没反应的僵尸条目。所以顺序是：

1. `taskkill /IM ollama.exe /F /T`、`taskkill /IM "ollama app.exe" /F /T` —— 推理服务是常驻的，不停就删不掉；
2. 有官方卸载器就跑 `/S`（它自己清注册表与快捷方式）；
3. `RMDir /r` 兜底；
4. `DeleteRegKey HKCU ...\Uninstall\Ollama` 清掉可能残留的卸载项；
5. 最后删 `%USERPROFILE%\.ollama`（模型目录）。

## 两个刻意的取舍

**一、静默卸载一项都不删。**
页面只有在交互式卸载时才显示；`/S` 下页面被跳过，五个变量全为空 → 什么都不删。
升级流程里 electron-builder 就是用 `/S` 跑旧卸载器，这条默认值保证了
**升级永远不会碰用户数据**。这比「默认全删」重要得多。

**二、不显示每项的体积。**
`mcp` 目录单是文件就有 10,587 个，NSIS 只能 `FindFirst` / `FileOpen` 逐个量，实测会让
这一页卡住好几秒（带杀毒软件更久）。卸载向导看起来像卡死，比少一个数字糟得多，
所以体积信息写进静态文案（「百 MB 级」「数 GB」「本机实测 129 MB」），不做实时统计。

## 覆盖安装就会更新

卸载器是安装包的一部分，直接跑 `ChaosConsole-Setup-10.0.3.exe` 覆盖安装即可，
新卸载器会换掉安装目录里的旧文件，**不需要先卸载**。

设置 → 桌面集成 → 「卸载应用」的入口不变：确认框 → 应用退出 → 卸载器接管 → 这一页。

## 验证

- NSIS 编译通过，产物 `release/ChaosConsole-Setup-10.0.3.exe`
- 静态审计 **393/393** 通过（从 365 涨到 393，新增 28 条：五项清单与默认值、每条清理路径、
  `ReadEnvStr` 取真实用户目录、官方卸载器调用、失败汇总、静默不删、三处说明同步）
- 回归 **50/50**、**64/64** 通过
- i18n 校验通过（中英词条配对）
- 版式核算：五项 + 底部提示共占 134u，1018 页面上限 140u

## 完全免费

不调用任何付费 API。文稿由本地 Ollama 生成，配图走免费图源，pptx 用 pptxgenjs 本地渲染。
