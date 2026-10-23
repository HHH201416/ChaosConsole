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
must('package.json', /"version": "8\.0\.0"/, '版本为 8.0.0')
must('package.json', /"releaseType": "release"/, '发布通道是 release')
mustNot('package.json', /prerelease/, '没有 prerelease 通道')
must('electron/main.js', /app\.setAppUserModelId\('com\.chaosconsole\.boss'\)/, '桌面通知 AppUserModelID 已设置')

console.log(`\n=== 结果：${pass}/${pass + fail} 通过 ===`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log(`  - ${f}`)
  process.exit(1)
}
