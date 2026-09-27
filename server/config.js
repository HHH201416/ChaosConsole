'use strict'

const path = require('path')
const fs = require('fs')
const os = require('os')

const ROOT = path.resolve(__dirname, '..')

/**
 * 数据目录：
 *  - 打包运行时由 Electron 主进程通过 CHAOS_DATA_DIR 指定为 userData（可写）
 *  - 开发时落在项目根目录的 data/
 */
const DATA_DIR = process.env.CHAOS_DATA_DIR || path.join(ROOT, 'data')

function ensureDirs() {
  // 顺带把默认工作目录建出来：Agent 第一次干活时如果指向一个不存在的目录，
  // 会浪费一整轮去到处找路径。
  for (const dir of [DATA_DIR, process.env.CHAOS_DEFAULT_CWD || path.join(os.homedir(), 'ChaosWorkspace')]) {
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (_) {
      /* 建不出来也不致命，runReal 会退回项目根目录 */
    }
  }
}

/**
 * 权限模式。默认 'acceptEdits'：允许 Agent 读写文件，但危险操作（如任意
 * shell 命令）仍受 CLI 自身的审批约束，不会被静默放行。
 *
 * 可选值：default | acceptEdits | plan | bypassPermissions
 * bypassPermissions 会关闭全部审批闸门，属于高风险选项，只能由用户通过
 * 环境变量 CHAOS_PERMISSION_MODE 显式开启，或在应用内“设置”中手动切换。
 */
const PERMISSION_MODE = process.env.CHAOS_PERMISSION_MODE || 'acceptEdits'

const VALID_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions']

/**
 * 下载加速镜像。**默认启用**：本机 hosts 被加速器改过，GitHub 的发布包域名被指到
 * 127.0.0.1，不走镜像时实测只有 ~0.1MB/s（87MB 要十几分钟）。默认这个值是实测最快
 * 的一个公共镜像。
 *
 * 由服务端决定，界面只显示当前是否启用（不强求用户理解镜像是什么）。要改的话：
 *   CHAOS_DOWNLOAD_MIRROR=https://ghfast.top     换成别的镜像
 *   CHAOS_DOWNLOAD_MIRROR=off                    关掉，直连 GitHub
 *
 * 默认值只影响「设置里没写过」的情况；写过就以库里的值为准（便于以后加开关）。
 */
const DOWNLOAD_MIRROR_DEFAULT = 'https://gh-proxy.com'
const DOWNLOAD_MIRROR_OFF = ['off', 'none', '0', 'false', '']

function resolveDownloadMirror(raw) {
  if (raw === undefined || raw === null) return DOWNLOAD_MIRROR_DEFAULT
  const s = String(raw).trim()
  if (DOWNLOAD_MIRROR_OFF.includes(s.toLowerCase())) return ''
  return s
}

const DOWNLOAD_MIRROR = resolveDownloadMirror(process.env.CHAOS_DOWNLOAD_MIRROR)

function isValidPermissionMode(mode) {
  return VALID_PERMISSION_MODES.includes(mode)
}

const CONFIG = {
  ROOT,
  DATA_DIR,
  DB_FILE: path.join(DATA_DIR, 'chaos.db'),

  /** HTTP + WebSocket 端口 */
  PORT: Number(process.env.CHAOS_PORT || 43117),

  /** 授权码 */
  AUTH_CODE: process.env.CHAOS_AUTH_CODE || 'Hyc13579',

  /** claude CLI 可执行文件（留空则自动探测） */
  CLAUDE_BIN: process.env.CHAOS_CLAUDE_BIN || '',

  PERMISSION_MODE,
  VALID_PERMISSION_MODES,
  isValidPermissionMode,

  DOWNLOAD_MIRROR,
  DOWNLOAD_MIRROR_DEFAULT,

  /** 单次运行的超时（毫秒），默认 20 分钟 */
  RUN_TIMEOUT: Number(process.env.CHAOS_RUN_TIMEOUT || 20 * 60 * 1000),

  /** 任务默认执行路径 */
  DEFAULT_CWD: process.env.CHAOS_DEFAULT_CWD || path.join(os.homedir(), 'ChaosWorkspace'),

  /** 强制使用模拟执行（不真正调用 claude CLI） */
  FORCE_MOCK: process.env.CHAOS_FORCE_MOCK === '1',

  ensureDirs,
}

module.exports = CONFIG
