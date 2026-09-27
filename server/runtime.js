'use strict'

/**
 * 运行期的两个小事实，单独放一个模块是为了避开 require 环：
 * runner / mcp-scope 都需要知道「后端实际监听哪个端口」和「本次运行的交接令牌」，
 * 而端口是 index.js 在 listen() 之后才知道的 —— 让 runner 去 require index.js
 * 会形成 runner → index → runner 的环。
 */

const crypto = require('crypto')

/** 后端实际监听的端口（端口被占用时 index.js 会 +1 重试，所以必须由它告诉我们） */
let port = 0

/** taskId -> 本次运行的交接令牌。运行结束即吊销 */
const handoffTokens = new Map()

function setPort(p) {
  port = Number(p) || 0
}

function getPort() {
  return port
}

function baseUrl() {
  return `http://127.0.0.1:${port}`
}

/**
 * 给一次运行铸一个一次性令牌，写进该次运行的 MCP 配置里。
 * 用途：让 agent 通过 MCP 工具请求换岗时能证明「我确实是这个任务的执行者」。
 * 运行结束（runner 的 finally）必须吊销 —— 否则跑完的、或被劫持的 MCP 子进程
 * 还能拿旧令牌去动别的任务。
 */
function mintHandoffToken(taskId) {
  const token = crypto.randomUUID().replace(/-/g, '')
  handoffTokens.set(taskId, token)
  return token
}

function checkHandoffToken(taskId, token) {
  const current = handoffTokens.get(taskId)
  return Boolean(current && token && current === token)
}

function revokeHandoffToken(taskId) {
  handoffTokens.delete(taskId)
}

module.exports = {
  setPort,
  getPort,
  baseUrl,
  mintHandoffToken,
  checkHandoffToken,
  revokeHandoffToken,
}
