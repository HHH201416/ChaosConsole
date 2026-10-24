'use strict'

/**
 * 8.0.2：混沌 Token 计量（WorkBuddy 式额度体系的本地免费版）。
 *
 * 规则（用户定的，写死在这）：
 *   - 按模型真实消耗的 token 计量（Ollama 返回 eval_count；拿不到按 字数/2 估算）
 *   - 每日自动赠送 30,000,000 token（当天有效，跨天清零重发）
 *   - 余额用尽 → 混沌不可用（提示等明天或用兑换码）
 *   - 兑换码 → 兑换「永久 token」（永久额度 = 不限量，never 用完）
 *
 * 存储全部走 settings 表（单键 JSON），不新开表；兑换码也存 settings，
 * 由本机生成（这是用户自己的应用，自己给自己发电换个合理）。
 */

const crypto = require('crypto')
const store = require('./store')

const QUOTA_KEY = 'chaosQuota'
const CODES_KEY = 'chaosRedeemCodes'

/** 每日免费额度：3000 万 token */
const DAILY_FREE = 30_000_000

function today() {
  return new Date().toISOString().slice(0, 10)
}

function safeParse(raw, fallback) {
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? v : fallback
  } catch (_) {
    return fallback
  }
}

function rawQuota() {
  return safeParse(store.getSetting(QUOTA_KEY, '{}'), {})
}

function usage() {
  const q = rawQuota()
  const day = today()
  const usedToday = q.day === day ? Number(q.usedToday) || 0 : 0
  return {
    dailyFree: DAILY_FREE,
    permanent: q.permanent === true,
    day,
    usedToday,
    remaining: q.permanent === true ? Infinity : Math.max(0, DAILY_FREE - usedToday),
    totalUsed: Number(q.totalUsed) || 0,
  }
}

/** 客户端友好版（Infinity 序列化不了） */
function publicUsage() {
  const u = usage()
  return { ...u, remaining: u.permanent ? -1 : u.remaining, unlimited: u.permanent }
}

function canUse() {
  const u = usage()
  return u.permanent || u.remaining > 0
}

/** 记一笔消耗。tokens 拿不到时传 undefined，按 字数/2 估。 */
function consume(tokens, fallbackChars = 0) {
  const n = Math.max(1, Math.round(Number(tokens) || Math.ceil(fallbackChars / 2)))
  const q = rawQuota()
  const day = today()
  const usedToday = (q.day === day ? Number(q.usedToday) || 0 : 0) + n
  store.setSetting(
    QUOTA_KEY,
    JSON.stringify({
      permanent: q.permanent === true,
      day,
      usedToday,
      totalUsed: (Number(q.totalUsed) || 0) + n,
    }),
  )
  return n
}

/* ---------------- 兑换码（兑换「永久 token」） ---------------- */

/** 9.3.8：兑换码固定 HY2014，自产码逻辑整体移除 */

/**
 * 9.3.8：兑换码固定为 HY2014（不再支持本机自产码）。
 * 兑换成功 → 立刻升级为「永久 token」；重复兑换幂等成功。
 */
const FIXED_CODE = 'HY2014'

function redeem(code) {
  const clean = String(code || '').trim().toUpperCase()
  if (!clean) return { ok: false, error: '请输入兑换码' }
  if (clean !== FIXED_CODE) return { ok: false, error: '兑换码不正确' }

  const q = rawQuota()
  if (q.permanent) return { ok: true, data: { permanent: true, code: clean, already: true } }
  store.setSetting(
    QUOTA_KEY,
    JSON.stringify({ ...q, permanent: true, redeemedAt: Date.now(), redeemedCode: clean }),
  )
  store.bus.emit('chaos:changed', { reason: 'redeemed' })
  return { ok: true, data: { permanent: true, code: clean } }
}

module.exports = {
  DAILY_FREE,
  usage,
  publicUsage,
  canUse,
  consume,
  redeem,
}
