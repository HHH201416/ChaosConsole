# AI Agent开发控制台 · ChaosConsole

一个 Windows 桌面端的**多 Agent 协作控制台**。你可以像跟同事说话一样把需求丢进对话页，系统按内容自动挑一个岗位去干；也可以直接在看板上管理任务队列。Agent 的每一步动作都实时推回界面。

- **前端**：React 18 + Vite 5 + Tailwind CSS 3 + Zustand
- **后端**：Node.js + Express + ws（WebSocket）+ SQLite
- **桌面壳**：Electron 33 + electron-builder（NSIS 安装包）+ electron-updater（真实增量更新）
- **Agent 执行**：`child_process.spawn` 拉起 CLI，实时解析它的事件流。支持两种执行器：
  - **Claude Code**（`claude -p --output-format stream-json`）
  - **DevEco Code**（`deveco run --format json`，华为鸿蒙开发 CLI）
- **MCP**：内置 MCP 服务器管理，一键给两个 CLI 装上工具能力

---

## 目录

1. [功能一览](#功能一览)
2. [快速开始（开发）](#快速开始开发)
3. [项目结构](#项目结构)
4. [深色 / 浅色主题](#深色--浅色主题)
5. [启动屏与开机动画](#启动屏与开机动画)
6. [工作原理](#工作原理)
7. [执行器：Claude 与 DevEco](#执行器claude-与-deveco)
8. [MCP 服务器](#mcp-服务器)
9. [打包成 exe](#打包成-exe)
10. [**版本发布完整流程（重点）**](#版本发布完整流程重点)
11. [自动更新是怎么工作的](#自动更新是怎么工作的)
12. [权限模式与安全](#权限模式与安全)
13. [常见问题](#常见问题)

---

## 功能一览

| 区域 | 能力 |
|---|---|
| **登录页** | 启动先输授权码 `Hyc13579`，通过后进入控制台；会话 token 存本地，后端重启会失效并要求重新登录 |
| **顶部栏** | 应用名、版本号、WebSocket 连接状态、执行中任务数；`+ 新岗位`、`+ 新任务`、`MCP`、`检查更新`、设置、退出 |
| **左侧岗位栏** | 21 个默认岗位（含系统提示词），**只显示「是干什么的」，不显示姓名**；显示执行器、状态（空闲/工作中）、名下未完成任务数；点开可看系统提示词、可移除 |
| **中间看板** | 四列：待处理 / 进行中 / 需要输入 / 已完成。卡片含任务名、负责岗位、标签，以及 `Start` / `Cancel` / `Done` 按钮，**支持拖拽换列** |
| **右侧对话页** | 直接说要做什么，**自动挑一个岗位去做**；消息流按「职能 + 执行器」标注；顶部有`历史`入口可翻看所有往期对话；底部可切换执行器与模型、继续追问（同一会话续跑）；可切到`事件`视图看工具调用明细 |
| **自动派单** | 按内容关键词匹配岗位画像挑人（对话页和看板共用同一套关键词）；**一个关键词都没命中时交给「日常对话」兜底**，不再硬塞给「代码实现」 |
| **实时推送** | CLI 的事件流逐行解析后经 WebSocket 推到前端，**界面无需刷新** |
| **续跑** | 后续追问复用同一个会话（claude 用 `--resume`，deveco 用 `-s`），Agent 保留上下文 |
| **自动落位** | 执行成功 → 已完成；Agent 提出疑问 → 需要输入；出错 → 需要输入并附错误；取消 → 退回待处理 |
| **模型可换** | 每个岗位可单独指定执行器与模型；对话页底部也能随时切换当前对话用的模型 |
| **MCP 管理** | 应用内一键启用/停用 MCP 服务器，同时写入 claude 与 deveco 两边的配置；**按岗位挂载**：每个任务只把该岗位用得上的那几个交给 Agent（见 [按岗位挂载 MCP](#按岗位挂载-mcp)） |
| **任务中换岗** | 运行中也能换人：失败/超时自动换岗重试、按阶段自动交接给下一个岗位、Agent 自己请求交接、你随时手动换岗。交接会带上任务背景与最近进展，**不是从头重来**（见 [换岗与阶段流水线](#换岗与阶段流水线)） |
| **真实更新** | 对接 GitHub Releases，`latest.yml` 自动生成并上传 |
| **下载加速镜像** | **默认启用**：升级与版本回退的安装包走第三方镜像前缀（实测 0.1MB/s → 5MB/s），下载后强制 sha512 校验，不符就丢弃不装；设置里只显示状态，改/关用环境变量 |
| **深色 / 浅色主题** | 顶栏一个按钮一键切换（☀ / ☾），也可以在「运行设置 → 外观」里选**浅色 / 深色 / 跟随系统**三态；默认跟随 Windows，选择记在本机。启动闪屏与开机动画一并跟随（见 [深色 / 浅色主题](#深色--浅色主题)） |
| **开机动画** | 冷启动先看 5 秒闪屏（真实进度：端口、员工数），主窗口出来后是 5 秒「正在接管控制台」——五步流程 + 带刻度的进度条，数据没回来就不会打满（见 [启动屏与开机动画](#启动屏与开机动画)） |
| **首次启动 0 任务** | 不预置任何示例任务，看板干净地从零开始 |

---

## 快速开始（开发）

### 前置条件

- Node.js ≥ 18（开发用 24.15 验证通过）
- 可选但强烈建议：`claude` CLI 已在 PATH 中（`npm i -g @anthropic-ai/claude-code`）
  - **没装也能跑**：检测不到 CLI 时会自动降级为「模拟执行」，看板、队列、WebSocket 推送全部照常工作

### 安装与启动

```bash
cd D:\ChaosConsole
npm install

# 一条命令同时起：后端(43117) + Vite(5173) + Electron
npm run dev
```

单独起某一部分：

```bash
npm run dev:server   # 只起后端
npm run dev:web      # 只起前端（浏览器打开 http://127.0.0.1:5173）
npm run build:web    # 构建前端产物到 dist/
npm start            # 以生产模式启动 Electron（加载 dist/，不起 Vite）
```

> `npm run dev` 里 Electron 会等 5173 端口就绪再启动。
> 如果你直接 `electron .` 而 Vite 没起，主进程会探活失败并**自动回退**到加载 `dist/` 里的构建产物（首次需要先 `npm run build:web`）。

### 授权码

默认 `Hyc13579`。改法：

```bash
# 临时改（仅本次运行）
CHAOS_AUTH_CODE=你的新授权码 npm run dev:server
```

或直接改 `server/config.js` 里的 `AUTH_CODE` 默认值。

### 数据存放位置

| 场景 | 位置 |
|---|---|
| 开发（`npm run dev:server`） | `D:\ChaosConsole\data\chaos.db` |
| 打包安装后 | `%APPDATA%\chaos-console\data\chaos.db` |

都是 SQLite 单文件。删掉它 = 恢复出厂（下次启动重新灌入 21 名默认员工；任务本身从不预置）。

老库不会因为这次扩编而重建：**启动时会做花名册增量补齐**——默认花名册里缺席的岗位
（比如鸿蒙那 10 个）自动补进库里，已有的岗位一律不动，用户改过的提示词/执行器/模型
不会被覆盖，用户主动删掉的默认岗位也不会复活（删的时候在 `settings.removedDefaultRoles`
里留了记号）。

---

## 项目结构

```
ChaosConsole/
├── package.json            # 依赖 + electron-builder 打包配置（版本号在这里）
├── vite.config.js          # 前端构建 + /api 与 /ws 的开发代理
├── tailwind.config.js      # 深/浅双主题色板（接 CSS 变量，见「深色 / 浅色主题」）
├── index.html              # 渲染进程入口（含防白闪的主题引导脚本）
│
├── public/
│   └── theme-boot.js       # 首帧前设好 data-theme。必须是同源外部脚本，不能内联（CSP）
│
├── electron/
│   ├── main.js             # 主进程：起后端、开窗口、接 electron-updater
│   ├── splash.html         # 冷启动闪屏（独立窗口，主题由主进程从 theme.json 贴上去）
│   └── preload.js          # contextBridge，只暴露只读元信息 + setTheme
│
├── server/                 # 后端（跑在 Electron 主进程里）
│   ├── index.js            # Express 路由 + WebSocket 广播 + 静态托管
│   ├── config.js           # 端口、授权码、权限模式、路径
│   ├── db.js               # SQLite（sql.js / WASM）+ 防抖落盘 + 轻量迁移
│   ├── store.js            # 数据访问层 + 事件总线
│   ├── queue.js            # 任务队列、自动派单、生命周期落位
│   ├── chat.js             # 对话编排：一句话 → 建任务 → 选岗位 → 派单
│   ├── executors.js        # 执行器注册表（claude / deveco）与模型列表
│   ├── runner.js           # spawn CLI + 两套事件流解析适配器
│   ├── mcp.js              # MCP 服务器安装、注册、启停
│   └── seed.js             # 21 个默认岗位及其系统提示词（不含示例任务）
│
├── src/                    # 前端
│   ├── App.jsx             # 布局与路由（登录页 / 控制台）
│   ├── store.js            # Zustand + WebSocket 客户端
│   ├── index.css           # 两套主题变量（:root 深色 / html[data-theme=light] 浅色）+ .fx-* 特效
│   ├── lib/api.js          # REST 客户端
│   ├── lib/meta.js         # 列定义、颜色、时间格式化
│   ├── lib/theme.js        # 主题三态的解析与应用（system → light/dark）
│   ├── lib/prefs.js        # 界面偏好的本地持久化（含 theme）
│   └── components/         # Login / TopBar / AgentSidebar / Board / TaskCard / ChatPanel / Modals / LifecycleFx
│
├── scripts/
│   ├── make-icon.js        # 零依赖生成多尺寸 build/icon.ico（手写 PNG 编码器 + ICO 封装）
│   ├── build.js            # 打包入口：整轮重试 + 修正 latest.yml
│   ├── after-pack.js       # afterPack 钩子：用 resedit 注入图标与版本信息
│   └── e2e-check.js        # 用 CDP 驱动真实 Electron 窗口做端到端自检
│
├── build/                  # 打包资源（icon.ico 由 npm run icon 生成）
└── release/                # 打包输出（exe、latest.yml、blockmap）
```

---

## 深色 / 浅色主题

7.0.0 起界面有深、浅两套主题。默认**跟随 Windows** 的深色/浅色设置；顶栏 `☀ / ☾` 一键翻转，「运行设置 → 外观」里可选浅色 / 深色 / 跟随系统三态。选择存在 `localStorage` 的 `chaos.ui`（字段 `theme`）。

### 怎么实现的：色板接 CSS 变量，不是到处加 `dark:`

组件里那 300 多处 `bg-ink-900` / `text-slate-400` / `text-sky-300` **一行都没改**。`tailwind.config.js` 把这些色档映射成 `rgb(var(--c-xxx) / <alpha-value>)`，两套取值写在 `src/index.css`：

```
:root                  { --c-ink-900: 11 14 20;  }   ← 深色（= 改造前的 Tailwind 内建值）
html[data-theme=light] { --c-ink-900: 242 239 232; }  ← 浅色（暖白 / 纸感）
```

切换只改 `<html data-theme>` 一个属性，其余全是 CSS 的事。

### 改这块之前必须知道的四件事

1. **`/ <alpha-value>` 不能丢。** 全仓库有 51 处 `bg-sky-500/10`、`border-ink-500/70` 这类透明度用法。写成 `rgb(var(--x))` 会让它们全部失效，肉眼是「淡底胶囊全变成实心色块」。变量存的必须是**空格分隔的三通道**（`226 232 240`），不是 hex。
2. **深色的取值必须与 Tailwind 内建值逐字节相同。** 这些变量接管了内建色板，值写错一点就是全局视觉回归。
3. **同一个色档不要同时当「文字」和「实心背景」** —— 浅色下这两者要往相反方向调。已经踩过两次，都留了注释：
   - `slate-600/700` 既当弱化文字又当事件时间轴的色条，所以浅色取值是照「奶油底上看得见」定的，**不是**照搬 Tailwind 的浅档；
   - 品牌橙拆成三档：`boss`（填充/描边/淡底）、`boss-strong`（**淡底上的文字**，浅色下压深）、`boss-on`（**实心橙底上的文字**，两个主题下都是深色）。混用会让按钮或胶囊在浅色下变成 2:1 对比度。
4. **`text-white` 不能统一覆盖。** `.btn-success` / `.btn-danger` 是彩色实心底上的白字，浅色下也必须保持白；标题和 hover 态的白字则必须变深，那些地方用的是已被主题化的 `text-slate-100`。

### 防白闪：`public/theme-boot.js`

打包后主进程注入的 CSP 是 `script-src 'self'`、**不含 `unsafe-inline`**（见 `electron/main.js` 的 `applyCsp()`），内联脚本会被拦掉。所以首帧前设主题这件事交给 `public/theme-boot.js` —— 一个同源外部脚本，在 `index.html` 的 `<head>` 里**同步**加载（阻塞解析 = 首帧就是对的）。它里面的解析逻辑与 `src/lib/theme.js` 是重复实现（`public/` 下的文件不走打包、import 不到 `src/`），**改一边要同步改另一边**。

### 冷启动闪屏为什么走 `theme.json`

闪屏（`electron/splash.html`）是个独立窗口，在渲染进程起来之前就创建了，读不到 `localStorage`。所以界面每次改主题会通过 preload 的 `setTheme()` 把**用户的选择**同步给主进程，落盘到 `userData/theme.json`；下次冷启动主进程读它决定闪屏配色。主进程还会把同一个值设给 `nativeTheme.themeSource`，让原生 `<select>` 弹层、标题栏这些也跟着走。

**别设 `nativeTheme.themeSource` 之外又让渲染层自己猜** —— 两边必须永远改同一个值，否则 `matchMedia('(prefers-color-scheme)')` 会和界面对不上。

---

## 启动屏与开机动画

一次开机依次经过三段，刻意做成同一台机器的样子：

| 阶段 | 谁 | 什么时候 | 时长 |
|---|---|---|---|
| 冷启动闪屏 | `electron/splash.html`（独立无边框窗口） | 主进程刚起来，后端还没启 | 5 秒 |
| 启动屏「正在接管控制台」 | `src/components/LifecycleFx.jsx` 的 `BootScreen` | 主窗口显示之后，界面在恢复上次会话 | 5 秒 |
| 退出遮罩「正在安全退出」 | 同一文件的 `ShutdownOverlay` | 收到主进程的 `app:quitting` | 1.5 秒 |

启动屏底下列出 5 步（应用启动 / 读取本地配置 / 连接本地服务 / 恢复岗位与任务 /
校验运行环境）+ 一条带刻度的进度条。

### 三条不那么显然的约束，改之前先读

1. **那 5 秒是从「主窗口真正显示出来」开始算的，不是从组件挂载算。**
   主窗口是 `show: false` 创建的，冷启动闪屏期间渲染进程已经在跑、动画也在走，
   只是没人看得见 —— 从挂载开始计时的话，用户实际只看得到一两秒。
   而且**拿不到现成的信号**：实测这时 `document.visibilityState` 仍然是 `visible`
   （Electron 的隐藏窗口不报 hidden），所以只能由主进程在窗口显示之后发一条 `app:shown`。
   ⚠️ `electron/main.js` 的 `ready-to-show` 里那个顺序不能动：必须
   `await closeSplash()` **之后**再发 —— 闪屏还要淡出 300 多毫秒，提前发的话
   这 5 秒会缩水成 4 秒多。
2. **进度条不许骗人。** 那 5 秒的时间轴是编排出来的（后端在本地，快到给不出真实
   进度），所以它可以走到 92% 假装在忙；但**只要 `bootstrap()` 还没回来就绝不打满
   100%**，并且会把当前那步标成「（等待后端响应）」。改进度逻辑时守住这条底线。
3. **`app:shown` 一辈子只发一次**，页面重载之后收不到。所以启动屏挂上监听之后
   还会主动问一次 `isAppShown()`，否则重载后时间轴永远不启动、界面就卡在启动屏上了。
   另外用 `sessionStorage` 记「本次会话已经播过」，普通页面重载不重播
   （这也是两道自检脚本能照常跑过去的原因）。

自检脚本要**彻底**跳过启动屏用 `CHAOS_SKIP_BOOT=1`，见 [端到端自检](#端到端自检)。

---

## 工作原理

```
┌──────────────┐  REST(/api)   ┌─────────────────────────────────────┐
│  React 界面  │ ────────────► │  Express                            │
│  (Zustand)   │               │    ├─ store.js ──► SQLite (sql.js)  │
│              │ ◄──────────── │    └─ queue.js ──► runner.js        │
└──────────────┘  WebSocket    └──────────────┬──────────────────────┘
                  实时推送                     │ child_process.spawn
                                               ▼
                                        claude CLI (-p --output-format
                                        stream-json --verbose)
```

**一次任务的完整生命周期：**

1. 前端 `POST /api/tasks` 建任务 → 状态 `backlog`
2. 点 `Start`（或拖到「进行中」）→ `POST /api/tasks/:id/start`
3. `queue.startTask()` 若任务没绑定 Agent，调用 `pickIdleAgent()` 按关键词匹配角色挑一个空闲员工
4. `runner.execute()` 组装提示词（**系统提示词 + 任务标题 + 详细说明 + 工作目录**），通过 **stdin** 喂给 `claude -p --output-format stream-json --verbose`
5. 逐行解析 stdout：
   - `{"type":"system","subtype":"init"}` → 记录 session_id
   - `{"type":"assistant",...}` → 文本块存「对话记录」，`tool_use` 块存「事件列表」
   - `{"type":"user",...}` → `tool_result` 存「事件列表」
   - `{"type":"result",...}` → 记录耗时/成本，判定成功或失败
6. 每一条落库都 `store.bus.emit()`，`server/index.js` 广播给所有 WebSocket 客户端
7. 回合结束按结果落位（见[功能一览](#功能一览)的「自动落位」）

**两个刻意的工程决定：**

- **提示词走 stdin 而不是 argv。** Windows 上 `claude` 实际是 `claude.cmd`，必须经 `cmd.exe` 转发，而 cmd 的引号和反斜杠转义极易把中文、换行、Windows 路径撕碎。把可变内容全塞进 stdin、让 argv 只剩静态 ASCII 参数，从根上消除这个问题。
- **用 sql.js（WASM）而不是 better-sqlite3。** `better-sqlite3` 是原生模块，需要匹配 Electron 的 ABI 重新编译；在没有 MSVC 构建工具、或国内网络拉不到 GitHub 预编译包的机器上极易失败。sql.js 零原生依赖，打包后必定可用。代价是数据库在内存里操作、需要自己落盘——`db.js` 用「写后防抖 250ms 落盘 + 原子替换 + 退出时强制 flush」处理。

---

## 执行器：Claude 与 DevEco

「执行器」就是最终被拉起来干活的那个 CLI。两者的接口和事件格式完全不同，所以
`server/runner.js` 里有两套适配器，但对上层（队列、看板、对话页）是同一个接口。

| | Claude Code | DevEco Code |
|---|---|---|
| 可执行文件 | `claude` | `deveco`（`@deveco/deveco-code`） |
| 调用方式 | `claude -p --output-format stream-json --verbose` | `deveco run --format json` |
| 事件格式 | `{"type":"assistant"\|"user"\|"system"\|"result"}` | `{"type":"step_start"\|"text"\|"tool_use"\|"step_finish","part":{...}}` |
| 会话续跑 | `--resume <session_id>` | `-s <sessionID>` |
| 模型命名 | 别名 `opus` / `sonnet` / `fable` / `haiku` | `provider/model`，如 `deepseek/deepseek-v4-pro` |
| 模型列表 | 内置别名表 | 实时读 `deveco models` |
| 权限控制 | `--permission-mode`（有 acceptEdits 中间档） | 只有 `--auto`（全自动放行）一档 |

**提示词一律走 stdin。** Windows 上这两个 CLI 都是 `.cmd`，必须经 `cmd.exe` 转发，
而 cmd 的引号和反斜杠转义极易把中文、换行、Windows 路径撕碎。把可变内容全塞进
stdin、让 argv 只剩静态 ASCII 参数，可以从根本上绕开这个问题（两者都已实测支持从
stdin 读提示词）。

**默认分配**：21 个岗位里，11 个用 claude（10 个工程岗位 + 「日常对话」），
10 个用 deveco（鸿蒙各岗位）。在 ⚙ 设置或岗位详情里可以逐个改。

### DevEco 的权限问题（重要）

DevEco Code **没有** `acceptEdits` 这种中间档，只有「全自动放行」。
默认关闭时它会驳回未经批准的敏感操作，表现为**任务跑不动**——事件列表里会出现
「权限被拦截」，对话里也会插一条提示。

要让它像 Claude 的 acceptEdits 那样自主干活，去 ⚙ 设置打开「**DevEco 自动放行**」。
注意那等于让它**不经确认**地在你的机器上执行命令。

---

## MCP 服务器

MCP（Model Context Protocol）是给 Agent 挂工具的标准协议。应用内置了一个 MCP 管理面板
（顶栏 `⛓ MCP`），启用后会**同时**写入 claude 和 deveco 两个 CLI 的配置。

### 已经装好的 7 个（即装即用，无需密钥）

| 服务器 | 能力 |
|---|---|
| `filesystem` | 读写本地文件与目录（默认放行 `D:\` 与用户主目录） |
| `memory` | 基于知识图谱的跨会话记忆 |
| `sequential-thinking` | 结构化推理，复杂问题拆解 |
| `context7` | 实时拉取库/框架的最新官方文档 |
| `playwright` | 微软官方浏览器自动化 |
| `chrome-devtools` | 谷歌官方 Chrome 性能分析与调试 |
| `everything` | MCP 官方参考实现，用于验证连接与工具发现 |

### 需要密钥的（在面板「需要密钥」页填了才启用）

GitHub、GitLab、Slack、Brave 搜索、PostgreSQL、Redis、Google 地图、Firecrawl
—— 这些**没有默认启用**。原因：缺少密钥时它们会在每次 Agent 会话里连接失败，
白白占用上下文和启动时间，属于负收益。填上密钥即可一键启用。

### 几个实现上的选择

- **包预装在固定目录**（`%APPDATA%\chaos-console\mcp`），注册时写**绝对路径**，
  而不是用 `npx -y` 每次现拉。`npx -y` 首次使用才下载，会超过 CLI 的健康检查超时，
  表现为「装上了但连不上」；而且每次会话启动都要重新解析一遍。
- **读状态不跑 `claude mcp list`**。那条命令会对每个服务器做健康检查（真的逐个拉起来），
  实测 7.8 秒；放在请求处理里会阻塞整个事件循环，打开面板时整个应用卡死。
  改成直接读 `~/.claude.json` 的 `mcpServers` 字段后是 **0.007 秒**。
- **每装一个都会注入到 Agent 的每次会话**。装太多会挤占上下文、拖慢每个任务，
  建议只开当前用得上的。

---

## 换岗与阶段流水线

一个任务不必从头到尾由同一个岗位干。换岗**不是取消**：任务一直在「进行中」，
排队的补充指令也不会丢，接手的人会拿到一份交接说明（任务原文 + 当前阶段 +
最近 6 条消息 + 上一位的遗留说明 + 你排队中的指令，总长封顶 4000 字符）。
换了人或换了执行器就**开新会话** —— 因为岗位的 system_prompt 只在会话首轮注入，
沿用旧会话等于新岗位的人设根本没生效。

四种触发方式：

| 触发 | 怎么发生 | 相关设置 |
|---|---|---|
| **失败/超时自动换岗** | 回合失败或超时后，自动交给另一个空闲岗位重试 | 「自动换岗重试上限」（默认 0 = 不限次数） |
| **阶段推进** | Agent 干完一个阶段，报告进入下一阶段，由该阶段的岗位接手 | 流水线（岗位默认 / 任务覆盖） |
| **Agent 主动换岗** | Agent 判断「这活该换人」，发指令或调 MCP 工具 | 「给 Agent『换岗』工具」开关 |
| **你手动换岗** | 卡片或对话页的「换岗」按钮，运行中也能点 | — |

**不限次数重试的四道护栏**（缺一不可，否则就是烧 token 的死循环）：

1. **同一阶段不重复用同一个岗位** —— 这是「不限次数」能终止的证明；
2. **本阶段岗位都试过就转人工** —— 落「需要输入」并写明试过谁；
3. **指数退避** 2 秒起、最多 1 分钟 —— 限制的是速率，不是次数；
4. **次数可见 + 随时可停** —— 卡片上有「重试 ×N」和「停止重试」。

### 阶段与流水线

阶段名默认是 `方案 → 编码 → 构建 → 测试`（claude 侧）与鸿蒙四岗（deveco 侧）。
解析顺序是 **任务 > 岗位 > seed 默认 > 执行器默认**，任何一层为空都往下掉，
而且**绝不回写**：老库里的任务拿到默认链、你改过的岗位不会被覆盖。
任务起跑时会把实际要走的链**快照到任务上**（卡片徽章、换岗弹窗的阶段选择都读它）。

- 改岗位默认链：侧栏点岗位 → 「默认阶段流水线」→ 勾「自定义」→ 保存
- 改单个任务：建任务时带 `pipeline: [{stage, role}]`（`POST /api/tasks`）
- 总闸：设置 → 「阶段流水线」，关掉则所有任务退回「一个人干到底」
- 关掉总闸不会改变**派单**：第一个人始终按任务内容关键词挑（见「自动派单」）

### 指令语法

Agent 在回复里**单独起一行**写下面两种指令（提示词里会自动带上这段语法，
不写就不会触发）：

```
CHAOS_STAGE: {"done":"code","next":"build","summary":"接口已实现，前端待接"}
CHAOS_HANDOFF: {"role":"HarmonyBuild","reason":"这是签名问题，我不熟","summary":"做到哪了"}
```

校验放在后端：目标岗位必须真实存在、阶段必须在本任务的流水线里且**不许回退**。
非法指令只记一条事件就忽略，**绝不打断正在跑的任务**。
另一种通道是 MCP 工具 `switch_role`（只在任务运行期注入，带一次性令牌）；
两条通道最终都汇进同一个换岗原语。

---

## 按岗位挂载 MCP

全局启用 ≠ 每个任务都该拿到。全挂上会挤占上下文、拖慢每次会话，playwright 与
chrome-devtools 还会**各起一个真浏览器**。所以从 3.6.0 起：

- 每个任务开跑时，后端按岗位算出该给它哪几个服务器，**只挂这些**；
- 「哪些服务器可用」以**已经注册在 CLI 配置里的定义**为准（过滤 `chaos-*`），
  你在面板里填的密钥、允许目录会原样带上，不从目录表重新拼；
- 两条执行器各走各的路，都已实测：

| 执行器 | 机制 |
|---|---|
| claude | 每次运行写一份临时配置 `%APPDATA%\chaos-console\mcp\run\<taskId>.json`，启动带 `--mcp-config <file> --strict-mcp-config`；运行结束即删 |
| deveco | 用 `DEVECO_CONFIG_CONTENT` 内联覆盖：角色要的给全量定义 + `enabled:true`，**其余已注册的显式 `{enabled:false}`**（实测它是按 key 合并的，不写 false 等于没按岗位挂） |

**默认挂载**（改在侧栏「点岗位 → 这个岗位能用的 MCP → 保存」）：

| 岗位 | 默认 MCP |
|---|---|
| 代码实现 / 构建发布 | filesystem、sequential-thinking、context7、playwright、chrome-devtools |
| 架构设计 / 需求拆解 | filesystem、sequential-thinking、context7、memory |
| 界面设计 | filesystem、context7、playwright、chrome-devtools |
| 测试验证 | filesystem、sequential-thinking、playwright、chrome-devtools |
| 技术调研 | context7、memory、playwright |
| 数据分析 | filesystem、memory |
| 文档撰写 | filesystem、context7 |
| 安全审计 | filesystem、sequential-thinking、context7 |
| 日常对话 | memory、context7 |
| 鸿蒙 10 个岗位 | filesystem、sequential-thinking、**deveco-studio**、context7、memory |

另外每个岗位都会带上应用内置的**换岗工具**（`chaos-handoff`，只在运行期注入、
带一次性令牌，不做全局注册），可以用设置里的开关关掉。

三个开关（设置面板）：**按岗位挂载 MCP**（总闸）、**严格模式**（关掉后 Agent 还能
看到你在应用外自己加的 MCP，只影响 claude 侧）、**给 Agent「换岗」工具**。

### 两个修掉的坑

- **本地服务器复制到稳定目录**：注册进 CLI 配置的是绝对路径，以前写的是
  `<安装目录>\resources\app\...` —— 应用一升级、一换安装范围（per-user ↔
  per-machine）或回退旧版，那个路径就废了，表现为「面板显示已启用、实际连不上」。
  现在 deveco-studio / handoff 会被复制到 `%APPDATA%\chaos-console\mcp\servers\`，
  启动时还会**校验并修复已经写坏的注册**（本机就修过一次：deveco 侧那条指向
  `D:\软件与文档\ChaosConsole\resources\app\...`）。deveco-studio 要调的 Python
  脚本一起复制过去，路径通过 `CHAOS_DEVECO_SCRIPT` 传给它。
- **`allowedDirs` 落库**：filesystem 允许访问哪些目录以前只存内存，重启即丢、
  界面上也没有入口。现在写进 settings，「改完重启就变回去」不会再有。

装好了但没启用的内置服务器，**启动时会自动启用**（缺包不会替你 `npm install`，
那会让启动变成网络任务）；你手动关掉过的会记一笔，不再自动打开。

---

## 打包成 exe

```bash
# 只打包，不上传
npm run dist
```

产物在 `release/`：

```
release/
├── ChaosConsole-Setup-3.1.1.exe          ← 安装程序，双击即可安装
├── ChaosConsole-Setup-3.1.1.exe.blockmap ← 增量更新用的差分信息
├── latest.yml                        ← 自动更新的版本清单（关键文件）
└── win-unpacked/                     ← 免安装的绿色版目录
```

安装程序的行为（在 `package.json` 的 `build.nsis` 里配置）：

- 允许用户自选安装目录
- **自动创建桌面快捷方式**，名字叫 `AI Agent开发控制台`
- 同时创建开始菜单项
- 装完自动启动
- **多一页「选择版本」**，可以装这个安装包内置的版本，也可以当场下载 GitHub 上
  已发布的其它版本（见下）

### 安装时选版本

装的时候可以挑装哪个版本 —— 在「选择安装位置」之后会多出一页版本列表：

- **选中标记为「本安装包内置」的那一条**（默认选中）→ 走正常安装流程，不需要联网
- **选中其它版本** → 安装器从 GitHub Releases 下载那个版本的安装包，下完把控制权交给它，
  自己退出（不会再装内置的那个版本）

实现上有三件事值得知道，改动时别踩：

1. **版本清单是构建时生成的**：`npm run manifest`（`scripts/nsis-manifest.js`）调 GitHub API 拿到
   所有已发布版本，写进 `build/versions.nsh`，再被 `build/installer.nsh` 编译进安装器。
   在 NSIS 里解析 JSON 太难受，而且要下载就得用 `INetC`（NSIS 自带的 `NSISdl` **不支持 HTTPS**，
   而 GitHub 只有 HTTPS）；`INetC` 只负责下载、不负责解析，所以清单必须在构建时定下来。
   - 取不到列表**不会让构建失败**，只会退化成「只有内置版本」一条
   - 这个文件在 `.gitignore` 里，每次 `dist` / `release` 都会重新生成
2. **中文文案全部放在生成的那个文件里**。`makensis` 靠 **UTF-8 BOM** 判断源文件编码，
   而 `build/installer.nsh` 是手工维护的 —— 它保持纯 ASCII（注释也是英文），
   就永远不会因为编辑器把 BOM 吃掉而变成乱码。要加文案请加到
   `scripts/nsis-manifest.js` 的字符串块里。
3. **下载完是「交给一个脱离的 cmd 延迟两秒再拉起」，既不是 `Exec` 也不是 `ExecWait`**。
   electron-builder 带了「同时只允许一个安装器实例」的互斥锁
   （`allowOnlyOneInstallerInstance.nsh`）：第二个安装器发现锁被占着会**静默 `Abort`**
   —— 用户看到的就是什么都没装、也没有任何提示。而锁要等本进程退出才释放，
   NSIS 又没有「退出之后再执行」的钩子，所以只能让一个脱离的 `cmd` 等两秒再启动它。
   代价是会有个一闪而过的控制台窗口。

### 两个刻意的打包配置

`package.json` 里有两处看起来「不太标准」但**不要随便改回去**的配置，
它们都是为了在本机的杀软环境下拿到确定性构建，详见
[常见问题](#q打包报-unknown-unknown-error-open-chaosconsoleexe-或-rcedit--unable-to-commit-changes)：

- **`"asar": false`** —— 关掉 asar 打包，避开 electron-builder 往 exe 里写
  「asar 完整性资源」这一步（那是一次 188MB 读-改-写，会撞上杀软扫描窗口）
- **`"signAndEditExecutable": false`** + **`afterPack` 钩子** —— 关掉 electron-builder
  自带的 rcedit，改用 `scripts/after-pack.js` 注入图标与版本信息

### 关于安装包文件名（改之前先读这段）

`artifactName` 配的是 **`ChaosConsole-Setup-${version}.${ext}`** —— 纯 ASCII、带版本号、
**不含空格**。这三条都不是审美选择，改坏了自动更新会直接失效：

**① 不能有空格。** 这是最容易踩的坑，而且**不是 GitHub 的限制，是 electron-updater
自己改文件名**。[`GitHubProvider.resolveFiles()`][ghprovider] 拼下载地址时会做

```js
p => this.getBaseDownloadPath(updateInfo.tag, p.replace(/ /g, '-'))
```

于是 `AI Agent开发控制台 Setup.exe` 被请求成 `AI-Agent开发控制台-Setup.exe`，而 GitHub
上的资源名里是空格 —— 名字对不上，404。中文本身没问题（URL 会做百分号编码），
**空格才是致命的**。装完之后的桌面快捷方式名、窗口标题仍然显示「AI Agent开发控制台」，
只有安装包文件名是英文。

**② 要带版本号。** 同名的资源在 `release/` 目录里会互相覆盖，手动从 Releases 下载的
人也分不清哪个是哪个；回退时会同时存在多个版本的安装包，靠文件名才能对上。

**③ 要纯 ASCII。** 除了空格，别的字符（中文、全角标点）在下载 URL、杀软扫描、
别的机器上解压时都可能出意外，而这里没有任何收益。

**为什么还要 `fixLatestYml()`。** electron-builder 生成 `latest.yml` 时会退回它自己的
默认 ASCII 命名（`chaos-console-setup-1.0.0.exe` —— 全小写、没有连字符），和上面这个
名字大小写对不上，于是 `latest.yml` 会指向一个不存在的资源。`fixLatestYml()` 在打包完
之后按磁盘上真实的文件重算 `sha512` / `size` / `blockMapSize` 并重写 `latest.yml`。
期望的文件名是从 `artifactName` 推出来的，所以改配置时不会失配。

[ghprovider]: https://github.com/electron-userland/electron-builder/blob/master/packages/electron-updater/src/providers/GitHubProvider.ts

---

## 版本发布完整流程（重点）

这一节讲清楚：**你以后改了代码，怎么把新版本推给已经装了旧版的人。**

### 一次性配置（只做一次）

**第 1 步：在 GitHub 建仓库**

新建一个仓库，比如 `ChaosConsole`（公开仓库最简单；私有仓库需要给客户端配 token，不推荐）。

**第 2 步：把仓库地址写进 package.json**

打开 `package.json`，找到 `build.publish`：

```json
"publish": [
  {
    "provider": "github",
    "owner": "YOUR_GITHUB_USERNAME",   ← 改成你的 GitHub 用户名
    "repo": "ChaosConsole",             ← 改成你的仓库名
    "releaseType": "release"
  }
]
```

> ⚠️ **这一步很关键**。`owner` / `repo` 会在打包时被写进安装包内的 `app-update.yml`，
> 客户端就是靠它去 GitHub 找更新的。**改完之后必须重新打包并让用户重装一次**，
> 已经装出去的旧包改不了这个地址。
>
> `releaseType` 可选 `release`（直接发布）或 `draft`（先存草稿，你手动点发布）。
> 想稳妥一点可以先设成 `draft`。

**第 3 步：创建 GitHub Token**

到 GitHub → Settings → Developer settings → Personal access tokens：
- 用 **classic token**，勾选 `repo` 权限；或
- 用 **fine-grained token**，仓库权限里给 `Contents: Read and write`

**第 4 步：把 token 设成环境变量**

```bash
# PowerShell（当前窗口有效）
$env:GH_TOKEN="ghp_你的token"

# 或永久写入用户环境变量
setx GH_TOKEN "ghp_你的token"
```

### 每次发版的四步

**① 改版本号**

版本号就是 `package.json` 里的 `version` 字段，electron-builder 会用它命名产物、生成 `latest.yml`、打 Git tag。

```bash
# 方式 A：用 npm 自动改（推荐）
npm version patch --no-git-tag-version   # 1.0.0 → 1.0.1   修 bug
npm version minor --no-git-tag-version   # 1.0.0 → 1.1.0   加功能
npm version major --no-git-tag-version   # 1.0.0 → 2.0.0   破坏性变更

# 方式 B：直接手动编辑 package.json 的 "version": "1.0.1"
```

> 加 `--no-git-tag-version` 是因为打包上传时 electron-builder 会自己打 tag，
> 让 npm 也打一个会冲突。如果你确实想用 git 管理，去掉这个参数也行，
> 但要保证 tag 名和版本号一致（`v1.0.1`）。

**② 提交代码**

```bash
git add .
git commit -m "feat: 你的改动说明"
git push
```

**③ 一条命令打包 + 自动上传到 GitHub Releases**

```bash
# PowerShell
$env:GH_TOKEN="ghp_你的token"; npm run release

# Git Bash
GH_TOKEN=ghp_你的token npm run release
```

`npm run release` 展开后是：

```bash
npm run icon       # 重新生成图标
npm run build:web  # 构建前端
electron-builder --win nsis --publish always
```

它会自动完成：打包 → 在 GitHub 上创建 `v1.0.1` 的 Release → 上传
`ChaosConsole-Setup-<版本号>.exe`、`latest.yml`、`.blockmap`。

**④ 去 GitHub 检查**

打开 `https://github.com/你的用户名/ChaosConsole/releases`，应该能看到新版本，
Assets 里能看到那个 exe 和 **`latest.yml`**。

> `latest.yml` 缺了更新就会失效。别手动删它。

### 如果不想用命令行上传（手动上传方式）

```bash
npm run dist      # 只打包，产物在 release/
```

然后到 GitHub Releases 页面点 `Draft a new release`：

1. **Tag** 填 `v1.0.1`（必须和 package.json 的 version 一致，前面加 `v`）
2. 上传这三个文件（都在 `release/` 目录）：
   - `ChaosConsole-Setup-<版本号>.exe`
   - `ChaosConsole-Setup-<版本号>.exe.blockmap`
   - `latest.yml`
3. 点 `Publish release`

三个文件缺一不可，尤其 `latest.yml`。

### 客户端怎么收到更新

已安装的用户：

1. 打开应用，点右上角 **「检查更新」**
2. 客户端请求 `https://github.com/你的用户名/ChaosConsole/releases/latest/download/latest.yml`
3. 比对里面的 `version` 和本地版本
4. 有新版 → 后台自动下载（带 `.blockmap` 走**增量下载**，只下变化的部分）→ 下载完弹窗提示「立即重启」→ 点一下就装好并重启

> 从旧版本升级时，因为 exe 在安装目录里被占用，NSIS 会先关掉应用再替换文件，用户无感。

---

## 自动更新是怎么工作的

```
[打包时]  package.json 的 publish 配置
             ↓
         app-update.yml（打进安装包） + latest.yml（上传到 Release）
             ↓
[运行时]  点「检查更新」→ GET .../releases/latest/download/latest.yml
             ↓
         version 比对 ── 相同 → "已是最新版本"
             ↓ 更高
         下载 .exe（有 blockmap 则增量）
             ↓
         update-downloaded → 弹窗 → quitAndInstall()
```

相关代码在 `electron/main.js` 的 `initUpdater()` 和 `checkForUpdates()`；
后端把它挂在 `POST /api/update/check`，前端顶栏按钮调这个接口。

**开发模式下这个按钮不会真的检查更新**——`app.isPackaged` 为 `false` 时直接返回
「开发模式不可用」。要验证更新，必须打包安装之后再用。

### 下载太慢怎么办：加速镜像

本机的 hosts 被加速器改过，GitHub 的**发布包域名**（`objects.githubusercontent.com`）
被指到 `127.0.0.1`，于是所有安装包下载都被强制过本机的加速器代理。实测那条链路只有
**~0.1MB/s**——87MB 的安装包要十几分钟，看起来像卡死。

绕过它直连真实 IP 更慢（26KB/s）；实测有效的是给地址套一个公共镜像前缀：

| 路由 | 实测速度 | 87MB 需要 |
|---|---|---|
| 加速器代理（默认） | ~0.1 MB/s | 约 15 分钟 |
| 直连真实 IP | 0.026 MB/s | 约 55 分钟 |
| `ghfast.top` | 0.13 MB/s | 约 11 分钟 |
| **`gh-proxy.com`** | **5.06 MB/s** | **约 17 秒** |

所以**下载加速镜像默认就是启用的**（`server/config.js` 的 `DOWNLOAD_MIRROR_DEFAULT`，
实测最快的一个公共镜像）。开不开由后端定，**设置面板只显示当前状态**——这个技术细节
没道理让用户先理解再自己填。要改的话用环境变量：

```bash
CHAOS_DOWNLOAD_MIRROR=https://ghfast.top   # 换成别的镜像
CHAOS_DOWNLOAD_MIRROR=off                  # 关掉，直连 GitHub
```

启用后两条路都走镜像：

- **升级**：`applyUpdateFeed()` 把 electron-updater 换成 `generic` feed，URL 指向
  `<镜像>/https://github.com/<owner>/<repo>/releases/latest/download`。选这个路径是因为
  GitHub 的 `releases/latest/download/<文件名>` 是稳定的，镜像只要会转发 github.com 就行。
  镜像被关掉时会切回 `app-update.yml` 里的 GitHub provider，行为与以前完全一致。
- **版本回退**：下载地址套同一个前缀。

取值优先级是「库里的设置 > 后端默认值」：`POST /api/settings` 写 `downloadMirror`
可以覆盖（写空串 = 显式关掉，不会再退回默认值），非法值（不是 http(s)、没有主机名）
会被 400 拒绝；启动时也会在日志里打印当前用的是哪个镜像，地址写错时直接点出来。

**安全**：镜像返回的就是接下来会被执行的安装包，等于把下载交给了第三方。所以

- 校验基准**只从 GitHub API 取**（`fetchReleaseHash()`，不经镜像）——否则等于拿镜像
  自己的说法证明镜像可信，那道校验就白做了
- 下载完对 sha512，不符就**删除文件、报错、不装**（实测用一个只会返回垃圾字节的假镜像
  验证过：报「校验不通过，已丢弃」，磁盘上无残留）
- 体积对不上也会先被拦（断流、镜像给错文件都表现成这个）
- 升级那条路由 electron-updater 自己按 `latest.yml` 的 sha512 校验，同样兜得住

拿不到基准的版本（老 Release 没带 `latest.yml`）会跳过校验并**如实提示**
「这个版本没有 sha512 基准，未能校验完整性」——不会伪装成校验通过。

代码在 `server/download-mirror.js`（纯函数，不依赖 electron，`npm run regress` 直接测）
和 `electron/main.js` 的 `applyUpdateFeed()` / `fetchReleaseHash()`。

---

## 权限模式与安全

Agent 是**真的在你机器上执行命令**。`electron/main.js` 拉起 claude 时带
`--permission-mode`，默认值是 **`acceptEdits`**：

| 模式 | 含义 |
|---|---|
| `default` | 所有工具调用都需要授权（非交互模式下基本干不了活） |
| **`acceptEdits`** | **默认值**。允许读写文件；危险操作仍受 CLI 审批约束，不会被静默放行 |
| `plan` | 只做计划，不实际改动 |
| `bypassPermissions` | ⚠️ **关闭全部审批闸门**，Agent 可在你机器上无确认执行任意命令 |

切换方式：

- 界面右上角 **⚙ 设置** → 「Agent 权限模式」下拉框（立即生效，存在数据库里）
- 或启动时用环境变量指定：`CHAOS_PERMISSION_MODE=default npm run dev`

**其他防护：**

- 授权码登录，所有 `/api` 接口校验 token；令牌在内存里，进程重启即失效
- 后端只监听 `127.0.0.1`，不对局域网暴露
- 渲染进程 `contextIsolation: true` + `nodeIntegration: false`，拿不到 Node 能力
- 打包后由主进程注入严格 CSP
- Agent 的执行目录（`执行路径`）由你指定，建议指向专门的工程目录，别指到家目录或系统盘根目录

**相关环境变量：**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `CHAOS_PORT` | `43117` | 后端端口（被占用会自动 +1 重试） |
| `CHAOS_AUTH_CODE` | `Hyc13579` | 授权码 |
| `CHAOS_PERMISSION_MODE` | `acceptEdits` | Agent 权限模式 |
| `CHAOS_CLAUDE_BIN` | 自动探测 | claude 可执行文件路径 |
| `CHAOS_DEVECO_BIN` | 自动探测 | deveco 可执行文件路径 |
| `CHAOS_DEFAULT_CWD` | `%USERPROFILE%\ChaosWorkspace` | 新任务的默认执行路径 |
| `CHAOS_RUN_TIMEOUT` | `1200000` | 单次执行超时（毫秒），默认 20 分钟 |
| `CHAOS_FORCE_MOCK` | 未设置 | 设为 `1` 强制模拟执行（不调用 claude） |
| `CHAOS_DATA_DIR` | 见上表 | 数据目录 |
| `CHAOS_EXTERNAL_SERVER` | 未设置 | 设为 `1` 时 Electron **不再自己启动后端**，只连 `CHAOS_PORT` 上已有的服务。`npm run dev` 用的就是这个模式 |
| `CHAOS_DEV_URL` | `http://127.0.0.1:5173` | 开发模式下要加载的 Vite 地址 |

> **关于 `CHAOS_EXTERNAL_SERVER`**：`npm run dev` 会同时起「独立后端」和 Electron。
> 如果不加这个变量，Electron 会再起一个后端去抢同一个端口，后起的那个因 EADDRINUSE
> 退到 43118，而窗口还指着 43117，直接错乱。所以 `dev:electron` 里固定带上它。
> 单独跑 `electron .`（不带这个变量）时，Electron 会自己启动后端，一切照常。

---

## 常见问题

**Q：界面能开，但任务一直在跑却没反应？**
看右侧详情栏的「事件列表」。如果看到「未检测到 claude CLI」，说明没装 CLI 走了模拟模式；
如果是 `进程退出码 N`，看那条事件里的 stderr 内容。也可以用 ⚙ 设置确认 CLI 路径。

**Q：Agent 说「权限被拒绝」「需要批准」？**
把权限模式调到 `acceptEdits`（默认就是）。如果它要执行 shell 命令被拦，说明
`acceptEdits` 下 Bash 仍需授权——这是刻意保留的安全边界。确实需要就手动切
`bypassPermissions`，但请先读[权限模式与安全](#权限模式与安全)。

**Q：任务卡在「进行中」不动？**
后端在应用启动时会把上次崩溃遗留的 `running` 状态收敛掉（见 `queue.recoverOnStartup`）。
如果仍卡住，点 `Cancel` 退回待处理再重新 `Start`。

**Q：怎么完全重置？**
关掉应用，删掉 `%APPDATA%\chaos-console\data\chaos.db`，重开即恢复出厂状态。

**Q：检查更新按钮点了没反应？**
开发模式（未打包）下它只会提示「不可用」，这是正常的。必须打包安装后才能验证。

**Q：打包时卡在下载 nsis / winCodeSign？**
electron-builder 需要从 GitHub 拉打包工具。国内网络慢的话用镜像：

```bash
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ npm run dist
```

（项目根的 `.npmrc` 已经配了 npm 与 Electron 的国内镜像。）

**Q：打包报 `UNKNOWN: unknown error, open '...\ChaosConsole.exe'` 或 `rcedit ... Unable to commit changes`？**

这是**杀毒软件的文件过滤驱动在扫描刚生成的可执行文件**时持有句柄导致的，不是配置问题。
典型特征是：同一个文件过一会儿由同样的代码去写就成功了，而且失败位置飘忽
（有时卡在「写入 asar 完整性资源」，有时卡在 rcedit 写图标）。

本机实测环境是**腾讯电脑管家**（已注册为杀毒软件，带文件过滤驱动）。实测结论：

- 新建的 188MB exe 在 **1 秒内**就会被杀软抓住扫描并持有句柄
- 写入必须抢在扫描之前 —— 立刻写**成功**，中间等 1 秒反而**失败**
- electron-builder 的流程刚好落在这个窗口里，所以是**掷骰子**：同样的命令
  可能第一次成功，也可能连续 3 次都失败

因此项目做了三层规避：

1. **`"asar": false`** —— 这是关键。asar 打包时 electron-builder 会往 exe 里写
   「asar 完整性资源」，那是一次 188MB 的读-改-写，正好撞上扫描窗口。
   关掉 asar 后这一步整个不执行，构建**确定性成功**。
   代价很小：`resources/app` 变成 704 个松散文件，安装包 87MB，
   功能与启动速度没有可感知差别。

   > electron-builder 会警告「asar usage is disabled — strongly not recommended」，
   > 那是通用建议。在本机这个杀软环境下，确定性构建比这层离线防篡改校验重要得多。
   > 如果你的机器没有这类杀软，想恢复 asar：删掉 `package.json` 里的 `"asar": false`，
   > 并加回 `"asarUnpack": ["node_modules/sql.js/**"]` 即可。

2. **`win.signAndEditExecutable: false` + `afterPack` 钩子** —— 关掉 electron-builder
   自带的 rcedit（它同样会撞窗口），改用 `scripts/after-pack.js` 里的 resedit
   整体重写 exe 来注入图标与版本信息，自带 6 次带退避的重试和写后回读校验。

3. **`scripts/build.js` 整轮重试** —— 万一还有别的步骤撞上，最多重来 3 次。

三层之外，最彻底的办法是把项目目录加入杀软白名单：

> 腾讯电脑管家 → 病毒查杀 → 信任区 → 添加目录 → 选 `D:\ChaosConsole\release`

Windows Defender 的话：设置 → 隐私和安全性 → 病毒和威胁防护 → 排除项 → 添加 `D:\ChaosConsole`。

---

## 端到端自检

`scripts/e2e-check.js` 会用 Chrome DevTools Protocol 连上真实运行的 Electron 窗口，
逐项验证登录、看板四列、21 个岗位、实时推送、自动派单、拖拽列、详情栏渲染等行为。

```bash
# 终端 1：带调试端口启动
CHAOS_FORCE_MOCK=1 npx electron . --remote-debugging-port=9222

# 终端 2：跑自检
node scripts/e2e-check.js
```

只建议在模拟模式下跑（`CHAOS_FORCE_MOCK=1`），否则自检会真的调用 claude。

### 启动屏会让自检变慢，必要时用 `CHAOS_SKIP_BOOT=1` 跳过

开机有一块 5 秒的启动屏「正在接管控制台」（见 [启动屏与开机动画](#启动屏与开机动画)）。
两道自检都是「reload 之后按固定毫秒数断言」的，多这 5 秒会把它们打断 —— 所以启动屏
**一次应用启动只播一遍**，普通页面重载不会重播，自检照常能跑过去。

要**彻底**关掉它（比如写新的自检脚本、需要精确控制首帧），给启动命令加环境变量：

```bash
CHAOS_SKIP_BOOT=1 CHAOS_FORCE_MOCK=1 npx electron . --remote-debugging-port=9222
```

主进程读到这个变量会以 `additionalArguments` 传给 preload，界面直接跳过启动屏
（连一帧都不渲染）。和 `CHAOS_WINDOW_STATE=off` 是同一套「给自检开逃生口」的做法。
