'use strict'

/**
 * 8.0.0：数据库备份与恢复。
 *
 * 备份就是 sql.js 导出的完整 .db 镜像，落在 <DATA_DIR>/backups/。
 * 自动备份默认 24 小时一次、保留 10 份；导入/清空/恢复前也会强制留一份。
 * 所有文件名都经过严格白名单校验，杜绝路径穿越。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const CONFIG = require('./config')
const db = require('./db')
const store = require('./store')

const DIR = path.join(CONFIG.DATA_DIR, 'backups')
const REASONS = ['auto', 'manual', 'pre-clear', 'pre-import', 'pre-restore']
const NAME_RE = /^chaos-\d{8}-\d{6}-(auto|manual|pre-clear|pre-import|pre-restore)(-\d+)?\.db$/

let timer = null
let lastAutoCheck = 0
let lastAutoHash = ''

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true })
}

function validateName(name) {
  return typeof name === 'string' && NAME_RE.test(name)
}

function fileOf(name) {
  if (!validateName(name)) throw new Error('非法的备份文件名')
  return path.join(DIR, name)
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

function metaOf(name) {
  const file = path.join(DIR, name)
  let stat = null
  try {
    stat = fs.statSync(file)
  } catch (_) {
    return null
  }
  const m = name.match(/^chaos-(\d{8}-\d{6})-(auto|manual|pre-clear|pre-import|pre-restore)(-\d+)?\.db$/)
  return {
    name,
    reason: m ? m[2] : 'manual',
    size: stat.size,
    createdAt: stat.mtimeMs,
  }
}

/** 新建一份备份；返回元数据（auto 且内容没变时返回 null） */
function create(reason = 'manual') {
  if (!REASONS.includes(reason)) reason = 'manual'
  ensureDir()
  const buf = db.exportBuffer()
  const hash = sha256(buf)

  if (reason === 'auto') {
    const newest = list().find((b) => b.reason === 'auto')
    if (newest) {
      try {
        const oldHash = sha256(fs.readFileSync(path.join(DIR, newest.name)))
        if (oldHash === hash) {
          lastAutoHash = hash
          return null
        }
      } catch (_) {
        /* 读不到旧备份就继续新建 */
      }
    }
  }

  // 同一秒内重复创建时加序号，避免覆盖
  let name = `chaos-${stamp()}-${reason}.db`
  let i = 2
  while (fs.existsSync(path.join(DIR, name))) {
    name = `chaos-${stamp()}-${reason}-${i}.db`
    i++
  }

  const file = path.join(DIR, name)
  fs.writeFileSync(file, buf)
  if (reason === 'auto') lastAutoHash = hash
  prune(reason)
  return metaOf(name)
}

function list() {
  ensureDir()
  return fs
    .readdirSync(DIR)
    .filter((n) => validateName(n))
    .map(metaOf)
    .filter(Boolean)
    .sort((a, b) => b.createdAt - a.createdAt)
}

function remove(name) {
  const file = fileOf(name)
  if (!fs.existsSync(file)) return false
  fs.unlinkSync(file)
  return true
}

/** 保留策略：自动备份只留最近 N 份；手动/操作前备份永远保留 */
function prune(reason) {
  if (reason !== 'auto') return
  const retention = Math.max(1, Number(store.getSetting('backupRetention', '10')) || 10)
  const autos = list().filter((b) => b.reason === 'auto')
  for (const b of autos.slice(retention)) {
    try {
      fs.unlinkSync(path.join(DIR, b.name))
    } catch (_) {
      /* ignore */
    }
  }
}

function restore(name) {
  const file = fileOf(name)
  if (!fs.existsSync(file)) throw new Error('备份不存在')
  // 恢复前先给当前库留一份，恢复坏了大不了再切回来
  create('pre-restore')
  db.restoreFromFile(file)
  store.bootstrap()
  store.bus.emit('workspace:imported', store.snapshot())
  return true
}

/** 定时器：每 10 分钟看一次是否到了自动备份间隔 */
function startScheduler() {
  if (timer) return
  const tick = () => {
    lastAutoCheck = Date.now()
    if (store.getSetting('backupEnabled', '1') !== '1') return
    const hours = Math.max(1, Number(store.getSetting('backupIntervalHours', '24')) || 24)
    const newest = list().find((b) => b.reason === 'auto')
    if (newest && Date.now() - newest.createdAt < hours * 3600 * 1000) return
    try {
      create('auto')
    } catch (err) {
      console.error('[backup] 自动备份失败:', err.message)
    }
  }
  // 启动 30 秒后做第一次检查，别和首屏抢 IO
  setTimeout(tick, 30 * 1000)
  timer = setInterval(tick, 10 * 60 * 1000)
}

function stopScheduler() {
  if (timer) clearInterval(timer)
  timer = null
}

module.exports = {
  DIR,
  create,
  list,
  remove,
  restore,
  validateName,
  startScheduler,
  stopScheduler,
}
