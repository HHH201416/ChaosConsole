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
