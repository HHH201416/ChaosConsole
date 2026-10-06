/*
 * 主题引导。**必须**是 <head> 里的同步 <script> —— 它的唯一职责是赶在首帧之前
 * 把 <html data-theme> 设好，否则选了浅色的用户每次启动都会先闪一下深色。
 *
 * 为什么是独立文件而不是内联脚本：打包后主进程会注入严格 CSP，
 * `script-src 'self'` 不含 'unsafe-inline'（见 electron/main.js 的 applyCsp()），
 * 内联脚本会被直接拦掉。同源外部脚本则放行。
 *
 * ⚠️ 下面的解析逻辑与 `src/lib/theme.js` 是**重复实现**（这里是裸 JS，不走打包、
 * import 不到 src/）。改一边就要同步改另一边 —— 那边有同样的提醒。
 *
 * 兜底：这个文件没加载成功时，CSS 会落在 :root 的深色值上，等于退回加主题之前的
 * 行为，界面不会坏。
 */
;(function () {
  var KEY = 'chaos.ui' // 与 src/lib/prefs.js 的 UI_KEY 一致

  function readMode() {
    try {
      var raw = localStorage.getItem(KEY)
      if (!raw) return 'system'
      var parsed = JSON.parse(raw)
      var mode = parsed && parsed.theme
      return mode === 'light' || mode === 'dark' || mode === 'system' ? mode : 'system'
    } catch (_) {
      // 隐私模式下 localStorage 会直接抛；解析失败也走这里
      return 'system'
    }
  }

  function prefersLight() {
    try {
      return window.matchMedia('(prefers-color-scheme: light)').matches
    } catch (_) {
      return false
    }
  }

  function resolve(mode) {
    if (mode === 'light' || mode === 'dark') return mode
    return prefersLight() ? 'light' : 'dark'
  }

  function apply(mode) {
    var resolved = resolve(mode)
    document.documentElement.dataset.theme = resolved
    document.documentElement.dataset.themeMode = mode
  }

  var mode = readMode()
  apply(mode)

  // 「跟随系统」时，系统主题变了要跟着变。显式选了某一档就不挂。
  if (mode === 'system') {
    try {
      var mq = window.matchMedia('(prefers-color-scheme: light)')
      var onChange = function () {
        apply('system')
      }
      if (mq.addEventListener) mq.addEventListener('change', onChange)
      else mq.addListener(onChange)
    } catch (_) {
      /* 监听不上就算了，静态的初始值已经设好了 */
    }
  }
})()
