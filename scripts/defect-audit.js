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
must('package.json', /"version": "9\.7\.0"/, '版本为 9.7.0')
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
mustNot('server/chaos-quota.js', /HY2014|FIXED_CODE/, '兑换码逻辑已移除')
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
must('src/lib/changelog.js', /version: '9\.7\.0'/, '当前版本有简介条目')
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

console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ===`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
