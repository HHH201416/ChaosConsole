/**
 * 界面偏好的本地持久化：面板折叠状态 + 上次选中的会话。
 *
 * 为什么不并进 api.js：那是个 HTTP/token 客户端，把「侧栏收没收起」塞进去语义不清。
 * 这里是仓库里第二个碰 localStorage 的地方，照抄 api.js 那套纪律 ——
 * 一个 key 常量、每次读写都 try/catch 静默吞掉（隐私模式下 localStorage 会直接抛）、
 * 外加一份内存副本兜底。
 *
 * ⚠️ key 名 `chaos.ui` 被两个自检脚本硬编码引用（scripts/e2e-check.js 与
 * scripts/responsive-check.js 都要在开头把它清掉，否则上一次运行的折叠状态
 * 会污染断言前提）。改这里就要同步改那两个脚本。
 */

const UI_KEY = 'chaos.ui'

/** 内存副本。localStorage 读不到时就是它撑着，本次会话内也不会因为写失败而丢状态 */
let cache = null

/* `theme` 是「用户的选择」而不是解析后的结果，取值 'light' | 'dark' | 'system'。
   解析（system -> 具体值）在 src/lib/theme.js。注意这个字段同时被 public/theme-boot.js
   直接读取（那边复刻了 key 名和取值校验），改这里要同步改那边。 */
const DEFAULTS = { sidebarOpen: true, chatOpen: true, selectedTaskId: null, theme: 'system' }

/** 与 src/lib/theme.js 的 THEME_MODES、public/theme-boot.js 的校验保持一致 */
const VALID_THEMES = ['light', 'dark', 'system']

function read() {
  if (cache) return cache
  try {
    const raw = localStorage.getItem(UI_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    // 内容被改坏（手工编辑、旧版本遗留）时退回默认值，不要让界面起不来
    cache = parsed && typeof parsed === 'object' ? { ...DEFAULTS, ...parsed } : { ...DEFAULTS }
  } catch (_) {
    cache = { ...DEFAULTS }
  }
  return cache
}

/** 读偏好。任何异常字段都被夹回默认值，调用方不用自己防。 */
export function loadUiPrefs() {
  const p = read()
  return {
    sidebarOpen: p.sidebarOpen !== false,
    chatOpen: p.chatOpen !== false,
    selectedTaskId: typeof p.selectedTaskId === 'string' && p.selectedTaskId ? p.selectedTaskId : null,
    theme: VALID_THEMES.includes(p.theme) ? p.theme : 'system',
  }
}

/** 合并写。只传要改的字段即可。 */
export function saveUiPrefs(patch) {
  const next = { ...read(), ...patch }
  cache = next
  try {
    localStorage.setItem(UI_KEY, JSON.stringify(next))
  } catch (_) {
    /* 写不进去也不影响本次会话：内存副本已经更新过了 */
  }
}
