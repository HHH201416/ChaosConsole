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
  /**
   * 主进程准备退出：渲染进程收到后播放退场动画。
   * 主进程只等固定时长（EXIT_ANIM_MS）就继续退出，不依赖渲染进程回报，
   * 所以即使界面卡死也不会导致退不掉。
   */
  onAppQuit: (cb) => {
    const handler = () => cb()
    ipcRenderer.on('app:quitting', handler)
    return () => ipcRenderer.removeListener('app:quitting', handler)
  },
})
