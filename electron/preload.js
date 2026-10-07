'use strict'

/**
 * 预加载脚本：只暴露只读的应用元信息与生命周期通知。
 *
 * 业务数据全部走 HTTP/WebSocket；这里开的 IPC 通道都是「主进程 → 渲染进程」的
 * 单向通知（菜单项、退出前奏），渲染进程依旧拿不到 Node 能力
 * （contextIsolation: true + nodeIntegration: false）。
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('chaos', {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
    chrome: process.versions.chrome,
  },
  /** 主进程菜单触发的「新建任务」 */
  onMenuNewTask: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('menu:new-task', handler)
    return () => ipcRenderer.removeListener('menu:new-task', handler)
  },
  /** 主进程菜单触发的「检查更新」 */
  onMenuCheckUpdate: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('menu:check-update', handler)
    return () => ipcRenderer.removeListener('menu:check-update', handler)
  },
  onAppQuit: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('app:quitting', handler)
    return () => ipcRenderer.removeListener('app:quitting', handler)
  },
  /**
   * 主窗口**真正显示出来**的那一刻（冷启动闪屏淡出之后）。启动屏用它对齐
   * 那 5 秒的起始点。
   *
   * 为什么不能自己判断：主窗口是 `show: false` 创建的，闪屏期间渲染进程已经在跑、
   * 动画也在走，只是没人看得见。实测这时 `document.visibilityState` **仍然是
   * 'visible'**（Electron 的隐藏窗口不报 hidden），所以 visibilitychange 这条路
   * 走不通，只能由主进程在 show() 之后主动通知。
   */
  onAppShown: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('app:shown', handler)
    return () => ipcRenderer.removeListener('app:shown', handler)
  },
  /**
   * 主窗口现在是不是已经显示过了。
   *
   * `app:shown` 一辈子只发一次（主窗口只 show 一次），所以页面重载之后是收不到的 ——
   * 光靠监听会一直等下去。挂监听之后**再**问一次这个，两种情况就都覆盖了：
   * 还没显示 → 等事件；已经显示过 → 立刻开始。
   */
  isAppShown: () => ipcRenderer.invoke('app:is-shown'),
  /**
   * 自检脚本带 CHAOS_SKIP_BOOT=1 启动时置位，界面直接跳过启动屏。
   * 与 electron/main.js 的 CHAOS_WINDOW_STATE=off 是同一套「给自检开逃生口」的做法。
   */
  skipBoot: process.argv.includes('--chaos-skip-boot'),
  /**
   * 把用户选的主题告诉主进程（'light' | 'dark' | 'system'）。
   *
   * 这是**唯一**一条渲染进程 → 主进程的通道，存在的理由很具体：冷启动的闪屏是个
   * 独立窗口，在渲染进程起来之前就创建了，读不到 localStorage 里的偏好，只能由
   * 主进程落盘后再读（见 main.js 的 theme.json / resolveTheme）。
   *
   * 只写一个偏好，不传任何业务数据；主进程侧会校验取值。
   */
  setTheme: (mode) => ipcRenderer.invoke('theme:set', mode),
})
