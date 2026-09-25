'use strict'

/**
 * 预加载脚本：只暴露只读的应用元信息。
 *
 * 业务数据全部走 HTTP/WebSocket，不需要在这里开任何 IPC 通道，
 * 因此渲染进程拿不到 Node 能力（contextIsolation: true + nodeIntegration: false）。
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
})
