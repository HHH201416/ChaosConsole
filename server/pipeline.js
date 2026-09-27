'use strict'

/**
 * 阶段流水线：把「一个任务要经过哪几个阶段、每阶段归谁做」变成数据。
 *
 * 设计取舍（改之前先看这段）：
 *
 * 1. **解析顺序：任务 > 岗位 > seed 里该 role 的默认 > executor 默认。**
 *    任何一层为空都往下掉，且**绝不回写数据库** —— 存量行 pipeline='[]'
 *    也能用上新默认，同时用户改过的值不会被启动流程覆盖（与 syncRoster
 *    「只补不删不改」同一哲学，regress 例 9 在守这条）。
 *
 * 2. **入场的第一个人仍由「按任务内容打分」决定（queue.pickIdleAgent），
 *    不由流水线决定。** 流水线只决定**阶段之间的交接目标**。
 *    理由：关键词路由是既有行为、有回归用例在守（regress 例 10），也是用户
 *    对「派单」的既有预期；如果让流水线接管入场选人，等于所有任务的选人逻辑
 *    被换掉，风险远大于收益。阶段推进本身已经满足「按阶段自动推进」。
 *
 * 3. **单阶段也是合法流水线**（比如日常对话只有 chat 一个阶段），
 *    「没有下一个阶段」= 正常收官，不需要特殊分支。
 *
 * 纯函数模块：不 require store / queue，避免 require 环。需要开关时由调用方传进来。
 */

/** 与前端展示顺序一致；自由阶段名也允许（validate 只拦结构，不拦名字） */
const STAGES = ['plan', 'code', 'build', 'test']

const STAGE_LABELS = { plan: '方案', code: '编码', build: '构建', test: '测试' }

/** claude 侧的默认流水线 */
const CLAUDE_PIPELINE = [
  { stage: 'plan', role: 'Architect' },
  { stage: 'code', role: 'Coder' },
  { stage: 'build', role: 'DevOps' },
  { stage: 'test', role: 'Tester' },
]

/** DevEco 侧的默认流水线（鸿蒙岗位） */
const DEVECO_PIPELINE = [
  { stage: 'plan', role: 'HarmonyArchitect' },
  { stage: 'code', role: 'HarmonyOS' },
  { stage: 'build', role: 'HarmonyBuild' },
  { stage: 'test', role: 'HarmonyTester' },
]

function labelOf(stage) {
  return STAGE_LABELS[stage] || String(stage || '')
}

/** 安全的数组解析：坏数据当空处理，绝不让流水线把任务卡死 */
function parseList(v) {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x === 'object')
  if (typeof v === 'string' && v.trim()) {
    try {
      const j = JSON.parse(v)
      return Array.isArray(j) ? j.filter((x) => x && typeof x === 'object') : []
    } catch (_) {
      return []
    }
  }
  return []
}

function defaultFor(agent) {
  return (agent && agent.executor) === 'deveco' ? DEVECO_PIPELINE : CLAUDE_PIPELINE
}

/**
 * 解析一个任务实际走的流水线。
 * @param task  任务对象（可为 null：只有岗位时也能算出默认）
 * @param agent 岗位对象
 * @param enabled 全局开关（settings.pipelineEnabled），false 一律返回 []
 * @param seedAgent seed 里该 role 的默认定义（可选，用来支持「岗位默认流水线」）
 */
function resolve(task, agent, enabled = true, seedAgent = null) {
  if (!enabled) return []
  const fromTask = parseList(task && task.pipeline)
  if (fromTask.length) return fromTask
  const fromAgent = parseList(agent && agent.pipeline)
  if (fromAgent.length) return fromAgent
  const fromSeed = parseList(seedAgent && seedAgent.pipeline)
  if (fromSeed.length) return fromSeed
  return defaultFor(agent)
}

function stageIndex(pipeline, stage) {
  return parseList(pipeline).findIndex((s) => s.stage === stage)
}

/** 该阶段的负责岗位 role；找不到返回 '' */
function stageRole(pipeline, stage) {
  const list = parseList(pipeline)
  const hit = list.find((s) => s.stage === stage)
  return hit ? hit.role : ''
}

/**
 * stage 之后的那一项（不是「下一个索引」，而是**顺序上的后继**）。
 * 传空 stage 时返回第一项 —— 让「任务还没开始」也能算出该谁上。
 */
function nextAfter(pipeline, stage) {
  const list = parseList(pipeline)
  if (!list.length) return null
  if (!stage) return list[0]
  const i = list.findIndex((s) => s.stage === stage)
  if (i < 0 || i >= list.length - 1) return null
  return list[i + 1]
}

/** 结构校验：给 API 用。返回错误文案，合法返回 null */
function validate(list, roles = []) {
  const arr = parseList(list)
  if (!arr.length) return null // 空 = 用默认，合法
  const known = new Set(roles)
  for (const item of arr) {
    if (!item.stage || typeof item.stage !== 'string') return '流水线每一项都需要 stage'
    if (!item.role || typeof item.role !== 'string') return `阶段「${item.stage}」缺少 role`
    if (known.size && !known.has(item.role)) return `阶段「${item.stage}」的岗位「${item.role}」不存在`
  }
  const seen = new Set()
  for (const item of arr) {
    if (seen.has(item.stage)) return `阶段「${item.stage}」重复了`
    seen.add(item.stage)
  }
  return null
}

/** 给前端：把流水线渲染成「方案 → 编码 → 构建 → 测试」 */
function describe(pipeline) {
  return parseList(pipeline)
    .map((s) => labelOf(s.stage))
    .join(' → ')
}

module.exports = {
  STAGES,
  STAGE_LABELS,
  CLAUDE_PIPELINE,
  DEVECO_PIPELINE,
  labelOf,
  parseList,
  defaultFor,
  resolve,
  stageIndex,
  stageRole,
  nextAfter,
  validate,
  describe,
}
