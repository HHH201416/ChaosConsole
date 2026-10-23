'use strict'

/**
 * 8.0.0：统计。全部在 JS 里算，避免 sql.js 对日期函数的可移植性问题。
 */

const store = require('./store')

const RANGES = { '7': 7, '30': 30, '90': 90, all: null }

function dayKey(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function startOfDay(ts) {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function computeStats(range = '30') {
  const days = Object.prototype.hasOwnProperty.call(RANGES, String(range)) ? RANGES[String(range)] : 30
  const now = Date.now()
  const cutoff = days ? now - days * 24 * 3600 * 1000 : 0

  const allTasks = store.listTasks()
  const agents = store.listAgents()
  const inRange = allTasks.filter((t) => !cutoff || (t.createdAt || 0) >= cutoff)

  const completedTasks = allTasks.filter((t) => t.status === 'complete')
  const completedInRange = completedTasks.filter(
    (t) => !cutoff || (t.completedAt || t.updatedAt || 0) >= cutoff,
  )
  const failed = inRange.filter((t) => t.status === 'needs_input' && t.runState === 'error')
  const finished = completedInRange.length + failed.length

  const durations = completedInRange
    .map((t) => (t.completedAt || t.updatedAt || 0) - (t.createdAt || 0))
    .filter((n) => Number.isFinite(n) && n > 0)

  const statusDistribution = {}
  for (const t of allTasks) statusDistribution[t.status] = (statusDistribution[t.status] || 0) + 1

  const perAgent = agents.map((a) => {
    const mine = inRange.filter((t) => t.agentId === a.id)
    const done = mine.filter((t) => t.status === 'complete').length
    const err = mine.filter((t) => t.status === 'needs_input' && t.runState === 'error').length
    const ds = mine
      .filter((t) => t.status === 'complete')
      .map((t) => (t.completedAt || t.updatedAt || 0) - (t.createdAt || 0))
      .filter((n) => Number.isFinite(n) && n > 0)
    return {
      id: a.id,
      functionLabel: a.functionLabel,
      role: a.role,
      executor: a.executor,
      status: a.status,
      total: mine.length,
      completed: done,
      failed: err,
      successRate: done + err ? done / (done + err) : null,
      avgDurationMs: ds.length ? ds.reduce((s, n) => s + n, 0) / ds.length : 0,
    }
  })

  // 按天序列：默认看最近 30 天；all 也按最近 30 天展示
  const seriesDays = days || 30
  const perDay = []
  for (let i = seriesDays - 1; i >= 0; i--) {
    const dayStart = startOfDay(now - i * 24 * 3600 * 1000)
    const dayEnd = dayStart + 24 * 3600 * 1000
    perDay.push({
      date: dayKey(dayStart),
      created: allTasks.filter((t) => (t.createdAt || 0) >= dayStart && (t.createdAt || 0) < dayEnd).length,
      completed: completedTasks.filter((t) => {
        const at = t.completedAt || t.updatedAt || 0
        return at >= dayStart && at < dayEnd
      }).length,
    })
  }

  return {
    rangeDays: days,
    generatedAt: now,
    totals: {
      tasks: allTasks.length,
      createdInRange: inRange.length,
      completedInRange: completedInRange.length,
      failedInRange: failed.length,
      successRate: finished ? completedInRange.length / finished : null,
      avgDurationMs: durations.length ? durations.reduce((s, n) => s + n, 0) / durations.length : 0,
      avgAttempts: inRange.length
        ? inRange.reduce((s, t) => s + (t.attempts || 0), 0) / inRange.length
        : 0,
      running: allTasks.filter((t) => t.runState === 'running' || t.runState === 'queued').length,
      blocked: allTasks.filter((t) => t.blocked).length,
    },
    statusDistribution,
    perAgent,
    perDay,
  }
}

module.exports = { computeStats, RANGES }
