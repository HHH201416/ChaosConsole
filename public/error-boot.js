/**
 * 9.5.1：白屏自诊断 —— 任何未捕获的 JS 错误直接画到页面上，不再无声黑屏。
 * 必须是外部文件：打包后 CSP 是 script-src 'self'，内联会被拦。
 * 只在「真的出错」时才出现，正常使用零存在感。
 */
;(function () {
  var shown = false
  function show(msg) {
    /* 10.0.0：界面脚本出错 = 严重错误 —— 广播给氛围灯变红（闩锁常亮）。
       放在 shown 判断之前：重复出错也要重新点亮红灯。 */
    try {
      window.dispatchEvent(new CustomEvent('chaos:ui-error', { detail: String(msg) }))
    } catch (_) {
      /* 事件发不出去就算了，浮层照常显示 */
    }
    if (shown) return
    shown = true
    var paint = function () {
      var el = document.createElement('div')
      el.style.cssText =
        'position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;' +
        'background:#3b0d0d;border:1px solid #f87171;color:#fecaca;' +
        'font:12px/1.6 Consolas,monospace;padding:10px 12px;border-radius:8px;' +
        'max-height:45vh;overflow:auto;white-space:pre-wrap'
      el.textContent = '⚠️ 界面脚本出错（截图发给开发者即可）：\n' + msg
      document.body.appendChild(el)
    }
    if (document.body) paint()
    else document.addEventListener('DOMContentLoaded', paint)
  }
  window.addEventListener('error', function (e) {
    var stack = e.error && e.error.stack ? '\n' + String(e.error.stack).slice(0, 900) : ''
    show(
      (e.message || '未知错误') +
        '\n' + (e.filename || '') + ':' + (e.lineno || '') + ':' + (e.colno || '') +
        stack,
    )
  })
  window.addEventListener('unhandledrejection', function (e) {
    var r = e.reason
    show('Promise 拒绝: ' + ((r && (r.stack || r.message)) || String(r)))
  })
  // 兜底：6 秒后 root 还是空的 → 主动提示（脚本没执行 / 资源没加载）
  window.setTimeout(function () {
    var root = document.getElementById('root')
    if (root && root.childElementCount === 0) {
      show('界面 6 秒内没有挂载（脚本可能没有执行或资源加载失败）。\n请完全退出应用后重新打开；若仍复现，请截图反馈。')
    }
  }, 6000)
})()
