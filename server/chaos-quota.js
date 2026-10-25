'use strict'

/**
 * 8.0.2：混沌 Token 计量（WorkBuddy 式额度体系的本地免费版）。
 *
 * 规则（用户定的，写死在这）：
 *   - 按模型真实消耗的 token 计量（Ollama 返回 eval_count；拿不到按 字数/2 估算）
 *   - 每日自动赠送 30,000,000 token（当天有效，跨天清零重发）
 *   - 余额用尽 → 混沌不可用（提示等明天或绑手机号）
 *   - 9.5.4：原「兑换码」改为填手机号 —— 每个手机号每天 30,000,000 token
 *
 * 存储全部走 settings 表（单键 JSON），不新开表。
 */

const store = require('./store')

const QUOTA_KEY = 'chaosQuota'

/** 每日免费额度 / 每个手机号每天额度：3000 万 token */
const DAILY_FREE = 30_000_000
const PER_PHONE_DAILY = 30_000_000

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
    permanent: q.permanent === true, // 9.5.3 前用兑换码升过级的存量用户，继续 honoring
    phone: typeof q.activePhone === 'string' && q.activePhone ? q.activePhone : null,
    phoneCount: q.phones && typeof q.phones === 'object' ? Object.keys(q.phones).length : 0,
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

/** 9.7.0：是否已经绑定手机号（未绑定 = 不能用这个应用） */
function hasPhone() {
  return Boolean(usage().phone)
}

/** 打码展示：138****5678 */
function maskedPhone() {
  const p = usage().phone
  return p ? `${p.slice(0, 3)}****${p.slice(7)}` : ''
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
      // 9.5.4：必须展开 q —— phones / activePhone 不能被这次写回弄丢
      ...q,
      permanent: q.permanent === true,
      day,
      usedToday,
      totalUsed: (Number(q.totalUsed) || 0) + n,
    }),
  )
  return n
}

/* ---------------- 手机号绑定（9.5.4：原「兑换码」改为填手机号） ---------------- */

const PHONE_RE = /^1[3-9]\d{9}$/

/** 归一化手机号：去空格/横线，容忍 +86 / 86 前缀 */
function normalizePhone(raw) {
  let p = String(raw || '').replace(/[\s-]/g, '')
  if (p.startsWith('+86')) p = p.slice(3)
  else if (/^86\d{11}$/.test(p)) p = p.slice(2)
  return p
}

/**
 * 绑定手机号。绑定即激活「每个手机号每天 3000 万 token」的额度；
 * 重复绑定幂等成功；换号直接填新号即可（旧的保留在登记里）。
 */
function bindPhone(raw) {
  const clean = normalizePhone(raw)
  if (!clean) return { ok: false, error: '请输入手机号' }
  if (!PHONE_RE.test(clean)) return { ok: false, error: '手机号格式不正确（11 位，1 开头）' }

  const q = rawQuota()
  const phones = q.phones && typeof q.phones === 'object' ? q.phones : {}
  const already = phones[clean] != null
  if (!already) phones[clean] = { boundAt: Date.now() }
  store.setSetting(QUOTA_KEY, JSON.stringify({ ...q, phones, activePhone: clean }))
  store.bus.emit('chaos:changed', { reason: 'phone-bound' })
  return { ok: true, data: { phone: clean, already, dailyFree: PER_PHONE_DAILY } }
}

module.exports = {
  DAILY_FREE,
  PER_PHONE_DAILY,
  usage,
  publicUsage,
  canUse,
  hasPhone,
  maskedPhone,
  consume,
  bindPhone,
  normalizePhone,
}
