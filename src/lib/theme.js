/**
 * 主题的解析与应用。
 *
 * 三态：`light` / `dark` / `system`。存的是**用户的选择**（可能是 system），
 * 落到 DOM 上的是**解析后的具体值**（只会是 light 或 dark）—— 这样 CSS 只需要
 * 写 `:root`（深色）和 `[data-theme='light']` 两块，不用再为「跟随系统」复制
 * 一遍 `@media (prefers-color-scheme: light)`。
 *
 * ⚠️ 这里的解析逻辑在 `public/theme-boot.js` 里有一份**重复实现**。那份必须在
 * <head> 里同步执行、赶在首帧之前设好 data-theme，否则浅色用户每次启动都会先闪
 * 一下深色；而 `public/` 下的文件不走打包、import 不到 src/。**改这里就要同步改
 * 那边**，反之亦然。
 */

export const THEME_MODES = ['light', 'dark', 'system']

/** 系统的深色/浅色偏好。非浏览器环境（理论上到不了）当作深色。 */
export function systemPrefersLight() {
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches
  } catch (_) {
    return false
  }
}

/** 把用户的选择解析成具体主题。未知值一律当 system。 */
export function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode
  return systemPrefersLight() ? 'light' : 'dark'
}

/** 把解析结果写到 <html data-theme> 上 —— 整个主题切换就靠这一个属性。 */
export function applyTheme(mode) {
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  if (root.dataset.theme !== resolved) root.dataset.theme = resolved
  // 给 CSS 之外的地方（比如需要读当前生效色的脚本）留个出口
  root.dataset.themeMode = mode
  return resolved
}

/**
 * 仅在 system 模式下监听系统主题变化。
 * 返回退订函数。显式选了 light/dark 时不动系统、直接返回空退订。
 */
export function watchSystemTheme(mode, onChange) {
  if (mode !== 'system') return () => {}
  let mq
  try {
    mq = window.matchMedia('(prefers-color-scheme: light)')
  } catch (_) {
    return () => {}
  }
  const handler = () => onChange(applyTheme(mode))
  // addEventListener 在 Electron 33 的 Chromium 上一定有；留着旧接口兜底
  if (mq.addEventListener) mq.addEventListener('change', handler)
  else mq.addListener(handler)
  return () => {
    if (mq.removeEventListener) mq.removeEventListener('change', handler)
    else mq.removeListener(handler)
  }
}
