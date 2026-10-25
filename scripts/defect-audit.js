'use strict'

/**
 * 8.0.0：已知缺陷审计。
 *
 * 7.6.8-beta / 7.6.9-beta 在两轮实验里注入了 66 个缺陷。这个脚本把其中
 * 可静态判断的部分固化成断言，防止后续改代码时又悄悄把它们带回来。
 * 需要真实运行才能验证的项（布局、随机故障）仍由 regress / e2e / responsive 覆盖。
 *
 * 用法：npm run audit:defects
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
let pass = 0
let fail = 0
const failures = []

function read(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8')
}

function must(file, pattern, label) {
  const text = read(file)
  if (pattern.test(text)) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}  (${file} 未匹配 ${pattern})`)
  }
}

function mustNot(file, pattern, label) {
  const text = read(file)
  if (!pattern.test(text)) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    failures.push(label)
    console.log(`  ✗ ${label}  (${file} 仍包含 ${pattern})`)
  }
}

console.log('\n=== ChaosConsole 8.0.0 · 已知缺陷审计 ===\n')

/* ---------- 启动 / 登录 ---------- */
console.log('— 启动 / 登录')
must('electron/main.js', /const SPLASH_MIN_MS = 5000/, '闪屏最短停留 5 秒')
must('electron/main.js', /const EXIT_ANIM_MS = 1650/, '主进程退场动画 1.65 秒')
mustNot('electron/main.js', /allowPrerelease\s*=\s*true/, '没有强制 beta 更新通道')
must('electron/splash.html', /\.bar\s*\{[^}]*height:\s*2px/s, '闪屏进度条高度 2px')
mustNot('electron/splash.html', /\.bar\s*\{[^}]*height:\s*0px/s, '闪屏进度条没有被压成 0')
must('src/components/LifecycleFx.jsx', /const BOOT_MS = 5000/, '应用内启动屏 5 秒')
must('src/components/LifecycleFx.jsx', /sessionStorage\.setItem\(BOOTED_KEY, '1'\)/, 'booted 标记写 1')
must('src/components/Login.jsx', /type="password"/, '授权码输入框是密码框')
must('src/components/Login.jsx', /onSubmit=\{submit\}/, '登录表单可以回车提交')
mustNot('src/components/Login.jsx', /rotate-2|translate-x-6/, '登录卡片没有明显错位/旋转')

/* ---------- UI ---------- */
console.log('— UI 语义与布局')
must('src/components/TopBar.jsx', /runState === 'running'\)\.length/, '顶栏“执行中”只统计 running')
must('src/components/TopBar.jsx', /open: \{ cls: 'bg-emerald-500'/, '连接正常是绿色')
must('src/components/TopBar.jsx', /closed: \{ cls: 'bg-rose-500'/, '断开是红色')
must('src/components/TopBar.jsx', /width: `\$\{percent\}%`/, '下载进度条按真实百分比渲染')
mustNot('src/components/TopBar.jsx', /percent \/ 2/, '下载进度条没有减半')
mustNot('src/components/TopBar.jsx', /max-w-\[420px\]|flex-wrap/, '顶栏操作区没有被限宽/强制换行')
must('src/components/AgentSidebar.jsx', /status === 'working'/, '侧栏“忙碌”统计 working')
must('src/components/AgentSidebar.jsx', /task\.status !== 'complete'/, '岗位任务数排除已完成')
mustNot('src/components/AgentSidebar.jsx', /open \? 'w-20'/, '展开侧栏没有被压到 80px')
must('src/components/Board.jsx', /\{tasks\.length\}/, '列头计数就是任务数')
must('src/components/Board.jsx', /contains\(e\.relatedTarget\)/, '拖拽高亮有子元素守卫')
mustNot('src/components/Board.jsx', /-space-y-2/, '任务卡没有使用负间距')
mustNot('src/components/Board.jsx', /min-w-\[22rem\]/, '列宽没有撑到 22rem')
must('src/lib/meta.js', /key: 'backlog'[\s\S]*?bg-emerald-500/, '待处理是绿色')
must('src/lib/meta.js', /key: 'complete'[\s\S]*?bg-slate-500/, '已完成是灰色')
must('src/components/ChatPanel.jsx', /e\.ctrlKey \|\| e\.metaKey/, 'Ctrl+Enter 发送')
mustNot('src/components/ChatPanel.jsx', /setShowEvents\(false\)\s*\},\s*\[selectedTaskId\]/, '切换对话不会强行清事件视图')
must('src/components/ChatPanel.jsx', /disabled=\{!draft\.trim\(\)\}/, '发送按钮只按草稿是否为空禁用')
must('src/components/TaskCard.jsx', /stop\(e, \(\) => openHandoff/, '换岗按钮阻止卡片冒泡')
must('src/components/TaskCard.jsx', /text-\[13px\]/, '任务标题字号 13px')
mustNot('src/components/TaskCard.jsx', /text-\[19px\]/, '任务标题没有被放大到 19px')
must('src/components/Modals.jsx', /max-h-\[88vh\]/, '弹窗高度 88vh')
mustNot('src/components/Modals.jsx', /max-h-\[55vh\]/, '弹窗高度没有被压到 55vh')
must('src/components/Modals.jsx', /const active = theme === o\.key/, '外观选中态按用户选择判断')
must('src/components/Login.jsx', /type="password"/, '登录页无明文授权码')

/* ---------- 功能 / 随机故障 ---------- */
console.log('— 功能与稳定性')
must('src/store.js', /toasts\.filter\(\(t\) => t\.id !== id\)/, 'Toast 会被正确移除')
must('src/store.js', /api\.setSettings\(\{ maxAttempts: Number\(n\) \}\)/, '重试上限不会被偷偷 +1')
must('src/store.js', /logout\(\) \{[\s\S]*?setToken\(null\)/, '退出登录会清 token')
mustNot('src/store.js', /Math\.random\(\)\s*<\s*0\.\d+/, '没有随机失败/随机断线')
mustNot('src/lib/api.js', /Math\.random\(\)\s*<\s*0\.\d+|setTimeout\([^)]*Math\.random/, 'API 没有随机延迟')
mustNot('server/queue.js', /Math\.random\(\)\s*<\s*0\.\d+/, '队列没有随机失败')
mustNot('server/chat.js', /Math\.random\(\)\s*<\s*0\.\d+/, '对话没有随机失败')
mustNot('server/index.js', /Math\.random\(\)\s*<\s*0\.\d+/, 'WS 推送没有随机丢弃')
must('server/queue.js', /t\.runState === 'running' \|\| t\.runState === 'queued'/, '忙碌判定包含 running/queued')
must('server/queue.js', /if \(s > bestScore\)/, '自动派单取匹配度最高')
mustNot('server/queue.js', /if \(s < bestScore\)/, '自动派单没有取最低分')
must('server/pipeline.js', /const fromTask = parseList\(task && task\.pipeline\)[\s\S]*?if \(fromTask\.length\) return fromTask/, '流水线任务级覆盖优先')
must('server/store.js', /FROM tasks WHERE agent_id = \? AND run_state IN \('running', 'queued'\)/, '释放岗位只认 running/queued')

/* ---------- 注入的视觉故障 ---------- */
console.log('— 注入的视觉故障')
mustNot('src/index.css', /chaos-glitch|chaos-tear|@keyframes chaos-shake/, '没有注入的扫描线/撕裂线')
mustNot('src/index.css', /\.field\s*\{[^}]*transform:\s*translateX\(6px\)/s, '输入框没有被整体右移')
mustNot('src/index.css', /\.btn\s*\{[^}]*letter-spacing:\s*0\.12em/s, '按钮字距没有被全局拉大')
mustNot('src/index.css', /width:\s*520px/, '启动进度条没有溢出容器')
mustNot('src/index.css', /gap:\s*46px/, '启动屏元素间距没有被拉到 46px')
must('src/index.css', /min-w-\[10\.5rem\]|\.fx-exit|@tailwind base/, '样式表结构完整')
mustNot('src/components/ChatPanel.jsx', /whitespace-pre[^"']*overflow/, '聊天气泡没有被取消换行')

/* ---------- 版本 / 通道 ---------- */
console.log('— 版本与发布通道')
must('package.json', /"version": "10\.0\.0"/, '版本为 10.0.0')
must('package.json', /"releaseType": "release"/, '发布通道是 release')
mustNot('package.json', /prerelease/, '没有 prerelease 通道')
must('electron/main.js', /app\.setAppUserModelId\('com\.chaosconsole\.boss'\)/, '桌面通知 AppUserModelID 已设置')

/* ---------- 9.5.3：c.map 白屏崩溃防御 ---------- */
console.log('— 9.5.3 数组防御（修复 c.map is not a function 白屏）')
must('src/store.js', /const asArr = \(v\) => \(Array\.isArray\(v\) \? v : \[\]\)/, 'store 有 asArr 归一化辅助')
must('src/store.js', /agents: asArr\(stateRes\.data\?\.agents\)/, 'bootstrap 归一化 agents')
must('src/store.js', /tasks: asArr\(stateRes\.data\?\.tasks\)/, 'bootstrap 归一化 tasks')
must('src/store.js', /const ARRAY_STATE_KEYS = \['agents', 'tasks', 'conversations', 'templates', 'selectedTaskIds'\]/, 'setState 数组兜底层存在')
must('src/store.js', /Array\.isArray\(payload\?\.agents\) \? payload\.agents : state\.agents/, 'WS snapshot 异常时保留旧 agents')
must('src/store.js', /Array\.isArray\(payload\?\.tasks\) \? payload\.tasks : state\.tasks/, 'WS snapshot 异常时保留旧 tasks')
must('src/store.js', /function handleServerMessage\(msg\) \{\s*try \{\s*handleServerMessageRaw\(msg\)/s, 'WS 消息处理有 try/catch 防炸层')
must('server/store.js', /agents: Array\.isArray\(a\) \? a : \[\]/, '服务端 snapshot 归一化 agents')
must('server/store.js', /tasks: Array\.isArray\(t\) \? t : \[\]/, '服务端 snapshot 归一化 tasks')
must('src/components/ChatPanel.jsx', /const messages = Array\.isArray\(detail\?\.messages\)/, 'ChatPanel messages 数组防御')
must('src/components/ChatPanel.jsx', /const events = Array\.isArray\(detail\?\.events\)/, 'ChatPanel events 数组防御')
must('src/components/ChatPanel.jsx', /Array\.isArray\(system\?\.executors\)/, 'ChatPanel executors 数组防御')
must('src/components/Modals.jsx', /Array\.isArray\(system\.executors\)/, '设置页 executors 数组防御')

/* ---------- 9.5.4：手机号绑定 + 缓存加固 + 氛围灯 ---------- */
console.log('— 9.5.4 手机号绑定 / 缓存加固 / 氛围灯')
must('server/chaos-quota.js', /const PHONE_RE = \/\^1\[3-9\]\\d\{9\}\$\//, '手机号格式校验（11 位 1 开头）')
must('server/chaos-quota.js', /function bindPhone\(raw\)/, '手机号绑定函数存在')
must('server/chaos-quota.js', /HY2014/, '兑换码 HY2014 在服务端码表里')
must('server/index.js', /app\.post\('\/api\/chaos\/phone'/, '手机号绑定接口存在')
must('server/chaos-quota.js', /\.\.\.q,\s*permanent: q\.permanent === true,/s, 'consume 写回保留 phones 字段')
must('server/index.js', /no-store, must-revalidate/, 'index.html 永不缓存（no-store）')
must('server/index.js', /max-age=31536000, immutable/, '带哈希资产长缓存（immutable）')
must('electron/main.js', /clearCache\(\)/, 'Electron 启动清 HTTP 缓存')
must('electron/main.js', /clearCodeCaches\(\{\}\)/, 'Electron 启动清 V8 代码缓存')
must('src/components/ChaosModal.jsx', /输入手机号/, 'TokenCard 输入框为手机号')
must('src/components/ChaosModal.jsx', /每个手机号每天 3000 万 token/, 'TokenCard 文案为按号计额')
must('src/store.js', /bindChaosPhone/, 'store 有手机号绑定动作')
must('src/index.css', /breathe-glow 3s/, '氛围灯为 3s 呼吸')
must('src/index.css', /inset 0 0 46px -4px/, '氛围灯光晕已加强')
mustNot('src/index.css', /inset 0 0 0 1\.5px/, '氛围灯没有硬边框线')
must('src/components/AgentSidebar.jsx', /flex min-h-0 flex-1 flex-col border-r border-ink-600/, '岗位列表有界高度（可滚动）')
mustNot('src/components/AgentSidebar.jsx', /flex shrink-0 flex-col border-r border-ink-600/, '岗位列表不再无界撑高')
mustNot('src/components/ChatPanel.jsx', /查看事件列表/, '右上角「事件」切换按钮已移除')
must('server/aippt.js', /pptxgenjs/, 'AIPPT 用 pptxgenjs 本地渲染')
must('server/aippt.js', /ID_RE = \/\^\[a-f0-9\]\{16\}\$\//, 'AIPPT 文件 id 白名单（防路径穿越）')
must('server/index.js', /app\.post\('\/api\/aippt\/generate'/, 'AIPPT 生成接口存在')
must('src/components/NavRail.jsx', /id: 'aippt'/, 'AIPPT 在左侧导航栏')
must('src/components/AipptPage.jsx', /type="number"/, 'AIPPT 页数可自己输入')
must('src/components/AipptPage.jsx', /TONE_OPTIONS/, 'AIPPT 语气可选')
must('server/runner.js', /name: 'run_command'/, '操作电脑：run_command 工具')
must('server/runner.js', /name: 'open_path'/, '操作电脑：open_path 工具')
must('server/runner.js', /PC_CMD_BLACKLIST/, '操作电脑：毁灭性命令黑名单')
must('server/runner.js', /function computerUseEnabled\(\)/, '操作电脑：设置开关')
must('server/index.js', /agentComputerUse/, '设置接口与系统摘要支持 agentComputerUse')

/* ---------- 9.6.0：白屏根治（包装对象当数组用 + 渲染兜底） ---------- */
console.log('— 9.6.0 白屏根治')
must('src/lib/meta.js', /export function asArr/, 'meta.js 提供 asArr 归一化助手')
must('src/lib/meta.js', /bases/, 'asArr 能拆 { bases } 包装对象')
mustNot('src/components/PreviewPanel.jsx', /const list = res\.data \|\| \[\]/, '知识库预览不再把包装对象当数组')
must('src/components/PreviewPanel.jsx', /asArr\(res\.data\)/, '知识库列表走 asArr 归一化')
must('src/components/PreviewPanel.jsx', /kbList = asArr\(kbs\)/, '知识库渲染前再夹一次数组')
must('src/components/PreviewPanel.jsx', /docList = asArr\(docs\)/, '文档列表渲染前再夹一次数组')
must('src/components/ErrorBoundary.jsx', /getDerivedStateFromError/, '渲染错误兜底边界已实现')
must('src/components/ErrorBoundary.jsx', /componentStack/, '兜底边界展示组件栈')
must('src/main.jsx', /ErrorBoundary/, '应用最外层有兜底')
must('src/App.jsx', /<ErrorBoundary label="主界面">/, '主界面有兜底')
must('src/components/ChatWorkspace.jsx', /<ErrorBoundary compact label="预览面板">/, '预览面板单独兜底')
mustNot('src/store.js', /chaosMemory: list\.data \|\| \[\]/, '混沌记忆写入也做数组归一化')

/* ---------- 9.6.1：工作区 / AIPPT 增强 / 混沌默认 ---------- */
console.log('— 9.6.1 工作区与 AIPPT 增强')
must('server/config.js', /workspaceDir\(\)/, '工作区目录可配置（config.workspaceDir）')
must('server/index.js', /workspaceDir !== undefined/, '设置接口支持保存工作区')
must('server/index.js', /workspaceDirCustom/, '系统摘要暴露是否自定义工作区')
must('electron/main.js', /dialog:pick-dir/, '主进程提供选目录对话框')
must('electron/preload.js', /pickDirectory/, 'preload 暴露 pickDirectory')
must('src/components/Modals.jsx', /function WorkspaceField/, '设置页有工作区设置区')
mustNot('server/index.js', /store\.migrateAgentsToChaos\(\)\n\s*if \(n > 0\)/, '启动不再自动迁移岗位到混沌')
must('src/store.js', /patchDraft\.draftExecutor = 'chaos'/, '对话默认执行器为混沌')
must('src/store.js', /patchDraft\.draftModel = preferModel/, '对话默认模型为混沌模型')
must('server/aippt.js', /const THEMES =/, 'AIPPT 提供多套配色风格')
must('server/aippt.js', /function clampPages/, 'AIPPT 页数支持自定义并夹在范围内')
must('server/aippt.js', /async function render/, 'AIPPT 支持按修改后大纲重渲染')
must('server/aippt.js', /function deleteFile/, 'AIPPT 支持删除产物')
must('server/index.js', /app\.post\('\/api\/aippt\/render'/, 'AIPPT 重渲染接口存在')
must('server/index.js', /app\.delete\('\/api\/aippt\/file'/, 'AIPPT 删除接口存在')
must('src/components/AipptPage.jsx', /function SlidePreview/, 'AIPPT 有成品幻灯片预览')
must('src/components/AipptPage.jsx', /function ProgressSteps/, 'AIPPT 有制作进度')
must('src/components/AipptPage.jsx', /大纲速览/, 'AIPPT 侧栏有大纲速览')
mustNot('src/components/TopBar.jsx', /onClick=\{onSettings\}/, '顶栏设置入口已移除（只留底栏）')
must('src/lib/skills.js', /\/会议纪要/, '技能库已扩到会议纪要')
must('src/lib/skills.js', /\/报错诊断/, '技能库含报错诊断')
must('src/lib/skills.js', /\/PPT大纲/, '技能库含 PPT 大纲')
must('src/components/ChatPanel.jsx', /text-slate-500">\s*\{text\.trim\(\)\}/, '思考文字用灰色')
must('src/store.js', /mainView: 'home'/, '打开应用默认工作台页')
must('electron/main.js', /AUTO_MIN_INTERVAL_MS = 15 \* 60 \* 1000/, '每 15 分钟自动检查更新')
must('src/lib/changelog.js', /export const CHANGELOG/, '有版本简介清单')
must('src/lib/changelog.js', /version: '9\.8\.0'/, '当前版本有简介条目')
must('src/components/Modals.jsx', /本次更新了哪些/, '升级弹窗显示更新内容')
must('electron/main.js', /notes: typeof info\?\.releaseNotes/, '线上更新说明透传到界面')
mustNot('src/components/ChaosPages.jsx', /window\\.prompt\(/, 'Electron 不支持的 window.prompt 调用已移除')
must('src/components/ChaosPages.jsx', /function SelfModifyDialog/, '自修改改成应用内弹窗')
must('electron/main.js', /migrateLegacyData/, '升级时把旧数据搬到用户目录')
must('server/aippt.js', /tokens \+= Number\(r\?\.evalCount\)/, 'AIPPT token 计入总额度')
must('src/App.jsx', /<PhoneGate \/>/, '手机号必填闸门已挂进界面')
must('src/App.jsx', /system && !system\.phoneBound/, '未绑定手机号时拦住界面')
must('server/chaos-llm.js', /CHAOS_PHONE_REQUIRED/, '后端拒绝无手机号的调用')
must('src/store.js', /kind === 'error' \? 10000 : 4200/, '报错提示 10 秒后自动关闭')
must('src/App.jsx', /dismissToast|dismiss\(t\.id\)/, '提示条可手动关闭')
mustNot('src/components/ChaosModal.jsx', /永久 Token/, '额度区不再出现「永久 Token」旧文案')
mustNot('src/components/ChaosDock.jsx', /兑换码/, '额度区不再出现兑换码文案')
mustNot('src/App.jsx', /ink-950/, '不用未定义的 ink-950 色阶（会变成透明）')
mustNot('src/components/PhoneGate.jsx', /bg-ink-950/, '手机号闸门遮罩色阶有效')
/* ---------- 9.8.0：兑换码 / AIPPT 配图 / 流式 / 模板 ---------- */
console.log('— 9.8.0 兑换码 · AIPPT 配图 · 流式生成 · 模板')
must('server/chaos-quota.js', /const REDEEM_CODES = \{[\s\S]*?HY2014:/, '兑换码表含 HY2014')
must('server/chaos-quota.js', /function redeem\(raw\) \{[\s\S]*?hasPhone\(\)[\s\S]*?CHAOS_PHONE_REQUIRED/, '兑换前强制校验手机号')
must('server/index.js', /app\.post\('\/api\/chaos\/redeem'[\s\S]*?quota\.redeem\(req\.body\?\.code\)/, '兑换接口只认 code，不绑手机号')
must('src/store.js', /async redeemChaosCode\(code\)/, 'store 有兑换动作')
must('src/components/PhoneGate.jsx', /兑换码（可选）/, '手机号下方有兑换码输入框')
must('src/components/PhoneGate.jsx', /兑换码选填/, '闸门说明写清「号必填、码选填」')
must('src/components/ChaosModal.jsx', /placeholder="兑换码（可选）"/, '额度卡片有兑换码入口')
/* 9.8.2：AIPPT 速度与质量 —— 这几条都是实测踩出来的，回退任意一条都会重新变慢或变水 */
must('server/chaos-llm.js', /num_ctx/, 'AIPPT 的推理参数能透传（否则上下文被截在 2048）')
must('server/chaos-llm.js', /if \(options && typeof options === 'object'\) body\.options = options/, 'chat() 真的把 options 塞进请求体')
must('server/chaos-llm.js', /pickFastModel/, '能挑出快模型给短任务用')
must('server/aippt.js', /num_ctx: 8192/, '大纲上下文给到 8192')
must('server/aippt.js', /parseCompactOutline/, '行式大纲解析器存在')
must('server/aippt.js', /seenDeck/, '重复输出会被截断（小模型会把稿子重复好几遍）')
must('server/aippt.js', /polishOutline/, '大纲有过注水/去重后处理')
must('server/aippt.js', /isFiller/, '空话词表过滤')
must('server/aippt.js', /repeat_penalty: 1\.15/, '重复惩罚已调高')
must('server/aippt.js', /speed = 'auto'/, '支持速度档位')
must('server/aippt.js', /coverPrompt/, '封面图预取（与文本并行）')
mustNot('server/aippt.js', /输出 ONLY the JSON object/, '不再逼模型输出 JSON')
must('src/components/AipptPage.jsx', /setSpeed/, '界面上有速度档位')
must('src/lib/changelog.js', /AIPPT 快了 3 倍/, '9.8.2 简介写明提速')
/* 9.8.2：配图按内容定数量 + 双来源（AI 生成 / 联网照片） */
must('server/aippt.js', /function planImageSlots/, '配图数量按内容打分决定，不是写死张数')
must('server/aippt.js', /SCENE_WORDS/, '配图打分认场景词（讲客户/门店的页才配图）')
must('server/aippt.js', /async function fetchImage/, '取图走双来源通道')
must('server/aippt.js', /webimage\.searchOne/, '联网通道真的会被调用')
must('server/aippt-webimage.js', /api\.pexels\.com/, '接的是 Pexels 图库')
must('server/aippt-webimage.js', /function hasKey/, '没有 Key 时能判断并降级')
must('server/index.js', /\/api\/aippt\/image-source/, '有配图来源状态/设置接口')
must('src/components/AipptPage.jsx', /imageSource/, '界面上能选配图来源')
must('src/components/AipptPage.jsx', /aipptSetImageKey/, '界面上能存图库 Key')
/* 9.8.2：任务没完成不许停 —— 少页要继续写，断流要自动重来 */
must('server/aippt.js', /async function completeDeck/, '页数不齐会继续补页')
must('server/aippt.js', /function missingPages/, '能算出还差几页真实内容')
must('server/aippt.js', /pad: false/, '续写补页时不先塞占位页（占位页会污染结构）')
must('server/aippt.js', /还差 \$\{need\} 页/, '补页对用户可见，不是偷偷进行')
must('server/aippt.js', /COMPLETE_BUDGET_MS/, '补页有总预算，不会把整份稿子拖死')
must('server/aippt.js', /function cleanPlan/, '模型开场白（「好的，以下是」）进不了页面')
must('server/aippt.js', /function cleanSubtitle/, '「副标题」不会变成副标题内容')
must('server/aippt.js', /function dedupePoints/, '同页近似重复要点会被去掉')
must('server/aippt.js', /function fillFromPlan/, '素材能兜底成真实页面')
must('src/components/ImagePage.jsx', /generateHQ|imageGenerate/, 'AI 绘图页存在并接到出图接口')
must('server/aippt-image.js', /async function generateHQ/, '高质量单图生成函数存在')
must('server/aippt-image.js', /ART_STYLES/, '绘图有风格预设')
must('server/index.js', /\/api\/image\/generate/, '绘图接口已挂上')
must('src/components/NavRail.jsx', /AI 绘图/, '导航里有 AI 绘图入口')
must('src/components/AipptPage.jsx', /filmstrip/, '大预览有页码胶条')
must('src/components/AipptPage.jsx', /ev.type === 'preview'/, '大纲边写边进预览框')
must('src/components/AipptPage.jsx', /第 \$\{attempt\} 次自动重试/, '断流后前端会自动重试')
must('src/components/AipptPage.jsx', /attempt <= 3/, '整任务重试 3 轮')
mustNot('server/aippt.js', /模型两次都没能产出有效内容/, '老的「两次就放弃」文案已去掉')

/* 9.8.1：兑换码是凭证，前端任何位置（文案 / 占位符 / 注释 / changelog）都不许出现明文码值 */
mustNot('src/components/ChaosModal.jsx', /HY2014/i, '额度卡片不暴露兑换码明文')
mustNot('src/components/PhoneGate.jsx', /HY2014/i, '闸门不暴露兑换码明文')
mustNot('src/lib/changelog.js', /HY2014/i, '版本日志不暴露兑换码明文')
mustNot('server/chaos-quota.js', /redeemCode: typeof q\.redeemCode/, 'usage() 不再回传兑换码明文')
mustNot('server/chaos-quota.js', /^\s+code,$/m, '兑换响应不再回传 code 字段')
must('src/components/ChaosModal.jsx', /已解锁不限量/, '已兑换只显示「已解锁不限量」')

must('server/aippt-image.js', /function encodePng\(rgb, w, h\)/, '有零依赖 PNG 编码器（本地兜底插画）')
must('server/aippt-image.js', /function crc32\(buf\)/, 'PNG CRC32 自带实现')
must('server/aippt-image.js', /image\.pollinations\.ai/, '在线文生图通道存在')
must('server/aippt-image.js', /async function generateMany\(items, \{ concurrency = 3/, '配图并发生成（3 路）')
must('server/aippt-image.js', /function resolveImage\(name\)/, '配图按名字安全解析（防路径穿越）')
must('server/aippt.js', /const imageGen = require\('\.\/aippt-image'\)/, 'AIPPT 接入配图模块')
must('server/aippt.js', /const THEMES = \{[\s\S]*?graphite:/, '模板扩到 8 套（含石墨灰）')
must('server/aippt.js', /coverStyle: 'full'/, '模板带封面版式（整幅大图）')
must('server/aippt.js', /const KINDS = new Set\(\['cover', 'bullets', 'twocol', 'stats', 'quote', 'closing'\]\)/, '6 种页型白名单')
// 9.8.2 起策划阶段改为「联网检索优先」：检索成功直接拼素材清单（无提示词），
// 检索失败才退回 fallbackPlanPrompt 让模型自己列素材
must('server/aippt.js', /function fallbackPlanPrompt\(/, '第一阶段：策划推理提示词（检索失败兜底）')
must('server/aippt.js', /function outlinePrompt\(/, '第二阶段：逐页大纲提示词')
must('server/aippt.js', /addImage\(\{ path: pic/, 'pptx 里真的嵌图片')
must('server/aippt.js', /const IMAGE_KINDS = new Set\(\['cover', 'bullets'\]\)/, '只给有图位的版式生成配图')
must('server/aippt.js', /if \(!IMAGE_KINDS\.has\(s\.kind\)\) return/, '配图挑页会跳过放不下图的页型')
must('server/aippt-image.js', /const ONLINE_WINDOW_MS = 46000/, '在线出图按 45 秒窗口错开（免费额度）')
must('server/aippt-image.js', /function enqueueOnline\(task\)/, '在线出图统一排队，避免并发全撞限流')
must('server/aippt-image.js', /class RateLimited extends Error/, '识别 402/429 限流并读 Retry-After')
must('server/aippt.js', /addNotes\(sl\.note\)/, '每页写演讲备注')
must('server/aippt.js', /fit: 'shrink'/, '文本框自适应（放不下自动缩字号）')
must('server/index.js', /app\.post\('\/api\/aippt\/stream'/, '流式生成接口存在')
must('server/index.js', /text\/event-stream/, 'SSE 响应头正确')
must('server/index.js', /app\.get\('\/api\/aippt\/image'/, '配图读取接口存在')
must('src/lib/api.js', /export async function streamPost\(/, '前端有 SSE 客户端')
must('src/components/AipptPage.jsx', /streamPost\(\s*'\/api\/aippt\/stream'/, 'AIPPT 页走流式生成')
must('src/components/AipptPage.jsx', /function sniffTitles\(/, '边生成边嗅探大纲标题')
must('src/components/AipptPage.jsx', /实时思路/, '右侧有实时思路面板')
must('src/components/AipptPage.jsx', /素材与论据（模型先搜集可落到页面上的硬信息）/, '实时面板显示推理过程')
must('src/components/AipptPage.jsx', /THEMES\.map\(\(th\) => \(/, '模板选择器按模板渲染')
must('src/components/AipptPage.jsx', /kind === 'stats'/, '预览按页型渲染（数据卡）')
must('src/components/AipptPage.jsx', /自动配图（按内容决定张数）/, '有配图开关')
must('src/lib/changelog.js', /AIPPT 自动配图/, '9.8.0 版本简介写了配图能力')
must('src/lib/changelog.js', /export const CHANGELOG = \[\s*\{\s*version: '10\.0\.0'/, '更新日志首条是 10.0.0')
must('src/components/ImagePage.jsx', /imageDelete/, '生成的图片可以删除')
must('src/components/ImagePage.jsx', /imageClear/, '生成的图片可以清空')
must('src/components/ImagePage.jsx', /画质增强/, '绘图有画质增强开关（Sora 式扩写提示词）')
must('server/index.js', /app\.post\('\/api\/image\/delete'/, '服务端有图片删除接口')
must('server/aippt-image.js', /function deleteArt\(name\)/, '删除图片按白名单名字校验')
must('server/aippt-image.js', /async function enhancePrompt/, '有 Sora 式提示词扩写')
must('server/aippt.js', /sky:/, '模板扩到 10 套（含天空蓝）')
must('src/components/ErrorBoundary.jsx', /triggerErrorFlash\(\{ severe: true \}\)/, '界面脚本出错触发红色闩锁')
must('public/error-boot.js', /chaos:ui-error/, '全局脚本错误广播给氛围灯')
must('server/aippt.js', /WPS 式行卡|行卡|数字章|页脚/, 'AIPPT 版式升级（行卡 / 目录卡 / 页脚）')


/* 9.8.0：思考全文显示 / 混沌自动就绪 / 知识库应用内编辑 */
must('server/runner.js', /function keepThink\(text\)/, '思考内容有专门的不截断通道')
mustNot('server/runner.js', /content: clip\([^)]*thinking[^)]*\)/, '思考内容不再走 clip 截断')
must('server/runner.js', /content: keepThink\(block\.thinking\)/, '思考块完整入库')
must('src/components/ChatPanel.jsx', /const \[open, setOpen\] = useState\(true\)/, '思考块默认展开')
mustNot('src/components/ChatPanel.jsx', /max-h-56[^"]*overflow-y-auto[^"]*思考/, '思考块不再限高')
must('server/chaos-llm.js', /async function warmUp\(\{ keepAlive = '2h'/, '有开机预热实现（keep_alive 2h）')
must('server/chaos-llm.js', /  warmUp,/, 'warmUp 已导出')
must('server/index.js', /chaosLlm\s*\.warmUp\(\)/, '服务启动时自动让混沌就绪')
must('src/store.js', /case 'chaos:changed':[\s\S]{0,400}loadChaosStatus\(\)/, '就绪事件会刷新引擎状态')
must('server/knowledge.js', /function updateDoc\(kbId, docId/, '知识库文档可改')
must('server/index.js', /app\.patch\('\/api\/kb\/:id\/docs\/:docId'/, '文档编辑接口存在')
must('src/lib/api.js', /updateKbDoc: \(id, docId, data\)/, '前端有改文档的调用')
must('src/components/KnowledgeModal.jsx', /function|const saveEditing = async/, '知识库有保存动作')
must('src/components/KnowledgeModal.jsx', /✏️ 编辑文档/, '知识库有应用内编辑器')
must('src/components/KnowledgeModal.jsx', /Ctrl\+S 保存/, '编辑器支持 Ctrl+S 保存')
must('src/components/AipptPage.jsx', /thinkRef/, '思路面板会跟随滚动')

{
  // 9.7.0 的坑：server/config.js 在加载时就把 DATA_DIR 算成常量，
  // 所以 CHAOS_DATA_DIR 必须在那之前赋值，否则数据还会写在安装目录里
  const src = read('electron/main.js')
  const envAt = src.indexOf('process.env.CHAOS_DATA_DIR =')
  const reqAt = src.indexOf("require('../server/config.js')")
  const ok = envAt > -1 && reqAt > -1 && envAt < reqAt
  if (ok) {
    pass++
    console.log('  ✓ CHAOS_DATA_DIR 在 require 配置之前赋值（数据落 userData）')
  } else {
    fail++
    failures.push('CHAOS_DATA_DIR 赋值晚于 require(config)')
    console.log(`  ✗ CHAOS_DATA_DIR 赋值晚于 require(config)  (env=${envAt} req=${reqAt})`)
  }
}

console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ===`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
