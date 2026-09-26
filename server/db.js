'use strict'

/**
 * SQLite 持久层。
 *
 * 使用 sql.js（纯 WASM 的 SQLite 编译产物）而不是 better-sqlite3，
 * 原因：better-sqlite3 是原生模块，需要匹配 Electron 的 ABI 重新编译，
 * 在没有 MSVC 构建工具 / 国内网络拉不到 GitHub 预编译包的机器上极易失败。
 * sql.js 零原生依赖，打包后必定可用。
 *
 * 代价：sql.js 在内存中操作数据库，需要我们自己把镜像落盘。
 * 策略是「写操作后防抖 250ms 落盘 + 进程退出时强制落盘」。
 */

const fs = require('fs')
const path = require('path')
const initSqlJs = require('sql.js')
const CONFIG = require('./config')

let SQL = null
let db = null
let saveTimer = null
let dirty = false

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  role           TEXT NOT NULL,
  avatar         TEXT NOT NULL DEFAULT '🤖',
  status         TEXT NOT NULL DEFAULT 'idle',
  system_prompt  TEXT NOT NULL DEFAULT '',
  executor       TEXT NOT NULL DEFAULT 'claude',
  model          TEXT NOT NULL DEFAULT '',
  function_label TEXT NOT NULL DEFAULT '',
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'backlog',
  run_state   TEXT NOT NULL DEFAULT 'idle',
  agent_id    TEXT,
  tags        TEXT NOT NULL DEFAULT '[]',
  cwd         TEXT NOT NULL DEFAULT '',
  session_id  TEXT,
  result      TEXT NOT NULL DEFAULT '',
  error       TEXT NOT NULL DEFAULT '',
  executor    TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    TEXT NOT NULL,
  type       TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  content    TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, id);
CREATE INDEX IF NOT EXISTS idx_events_task   ON events(task_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_status  ON tasks(status);
`

function persistNow() {
  if (!db) return
  try {
    CONFIG.ensureDirs()
    const data = Buffer.from(db.export())
    const tmp = CONFIG.DB_FILE + '.tmp'
    fs.writeFileSync(tmp, data)
    fs.renameSync(tmp, CONFIG.DB_FILE) // 原子替换，避免写一半断电导致库损坏
    dirty = false
  } catch (err) {
    console.error('[db] 落盘失败:', err.message)
  }
}

function scheduleSave() {
  dirty = true
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (dirty) persistNow()
  }, 250)
}

async function init() {
  CONFIG.ensureDirs()

  // 直接把 wasm 二进制喂给 sql.js，避免它自己去猜 locateFile 路径
  const wasmPath = path.join(path.dirname(require.resolve('sql.js')), 'sql-wasm.wasm')
  const wasmBinary = fs.readFileSync(wasmPath)
  SQL = await initSqlJs({ wasmBinary })

  let existing = null
  if (fs.existsSync(CONFIG.DB_FILE)) {
    try {
      existing = new Uint8Array(fs.readFileSync(CONFIG.DB_FILE))
    } catch (err) {
      console.error('[db] 读取旧库失败，将重建:', err.message)
      existing = null
    }
  }

  // 读得出来不代表它就是合法的 SQLite 库。而且 sql.js 的构造函数不会校验：
  // 损坏的文件要等到第一次执行语句才报 "file is not a database"。所以必须把
  // 「打开 + 建表」整个放进 try 里，否则这个异常会冒到启动流程，变成
  // 「每次启动都弹后端启动失败」，用户只能自己去数据目录删库才能恢复。
  // 这里的做法是：坏库改名留档，然后重建一个空库，保证应用永远起得来。
  if (existing) {
    try {
      const candidate = new SQL.Database(existing)
      candidate.exec(SCHEMA)
      db = candidate
    } catch (err) {
      const backup = `${CONFIG.DB_FILE}.corrupt-${Date.now()}`
      try {
        fs.renameSync(CONFIG.DB_FILE, backup)
        console.error(`[db] 数据文件已损坏（${err.message}），已备份为 ${backup}，将重建空库`)
      } catch (renameErr) {
        console.error(`[db] 数据文件已损坏（${err.message}），备份也失败（${renameErr.message}），直接重建`)
      }
      db = null
    }
  }

  if (!db) {
    db = new SQL.Database()
    db.exec(SCHEMA)
  }

  migrate()
  persistNow()
  return db
}

/**
 * 轻量迁移：给已存在的旧库补上后来新增的列。
 * SQLite 没有 DROP/ALTER COLUMN 的完整支持，但 ADD COLUMN 足够覆盖
 * 「加字段」这类演进，且不会动到已有数据。
 */
function migrate() {
  const wanted = [
    ['agents', 'executor', "TEXT NOT NULL DEFAULT 'claude'"],
    ['agents', 'model', "TEXT NOT NULL DEFAULT ''"],
    ['agents', 'function_label', "TEXT NOT NULL DEFAULT ''"],
    ['tasks', 'model', "TEXT NOT NULL DEFAULT ''"],
    ['tasks', 'executor', "TEXT NOT NULL DEFAULT ''"],
  ]

  for (const [table, column, decl] of wanted) {
    const cols = all(`PRAGMA table_info(${table})`).map((c) => c.name)
    if (cols.length && !cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`)
      console.log(`[db] 迁移: ${table}.${column} 已添加`)
    }
  }
}

/* ------------------------------------------------------------------ *
 * 查询辅助
 * ------------------------------------------------------------------ */

function all(sql, params = []) {
  const stmt = db.prepare(sql)
  try {
    stmt.bind(params)
    const rows = []
    while (stmt.step()) rows.push(stmt.getAsObject())
    return rows
  } finally {
    stmt.free()
  }
}

function get(sql, params = []) {
  const rows = all(sql, params)
  return rows.length ? rows[0] : null
}

function run(sql, params = []) {
  db.run(sql, params)
  scheduleSave()
}

/** 取刚插入行的 rowid（用于 messages / events 递增主键） */
function insert(sql, params = []) {
  db.run(sql, params)
  scheduleSave()
  const row = get('SELECT last_insert_rowid() AS id')
  return row ? row.id : null
}

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  if (dirty) persistNow()
}

/** 把 db 整个重置（用于「清空数据」调试入口） */
function reset() {
  db.exec('DROP TABLE IF EXISTS agents; DROP TABLE IF EXISTS tasks; DROP TABLE IF EXISTS messages; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS settings;')
  db.exec(SCHEMA)
  persistNow()
}

module.exports = { init, all, get, run, insert, flush, reset, persistNow }
