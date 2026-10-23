'use strict'

/**
 * 8.0.0：外部命令公共工具（从 mcp.js 抽出，工具链安装也复用）。
 *
 * 这里所有命令都必须是**代码里写死的命令 + 参数数组**。不要把用户输入
 * 拼进 cmd/args —— Windows 下 shell:true 会经 cmd.exe 再解析一遍。
 */

const { spawn } = require('child_process')
const { quoteArg } = require('./win-quote')

/** 结束整棵进程树（Windows 下 child 只是 cmd.exe 的外壳） */
function killTree(child) {
  if (!child) return
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true })
    } else {
      child.kill('SIGKILL')
    }
  } catch (err) {
    console.error('[exec] 结束进程失败:', err.message)
  }
}

/**
 * 异步执行外部命令。
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {object} opts
 *   - cwd / env / timeout
 *   - signal: AbortSignal（取消时杀进程树并返回 cancelled:true）
 *   - onStdout / onStderr: (chunk: string) => void
 *   - maxOutputBytes: 保留的输出上限（默认 2MB，超出丢最旧的）
 * @returns {Promise<{status:number, stdout:string, stderr:string, cancelled?:boolean}>}
 */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    if (opts.signal?.aborted) {
      return resolve({ status: -1, stdout: '', stderr: '已取消', cancelled: true })
    }

    let child
    try {
      const spawnCmd = process.platform === 'win32' ? quoteArg(cmd) : cmd
      child = spawn(spawnCmd, args, {
        windowsHide: true,
        shell: process.platform === 'win32',
        cwd: opts.cwd,
        env: { ...process.env, ...(opts.env || {}) },
      })
    } catch (err) {
      return resolve({ status: -1, stdout: '', stderr: err.message })
    }

    const max = Number(opts.maxOutputBytes) || 2 * 1024 * 1024
    let stdout = ''
    let stderr = ''
    let settled = false

    const trim = (text) => (text.length > max ? text.slice(text.length - max) : text)
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener?.('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => {
      killTree(child)
      finish({ status: -1, stdout, stderr: stderr + '\n(已取消)', cancelled: true })
    }

    const timer = setTimeout(() => {
      killTree(child)
      finish({ status: -1, stdout, stderr: stderr + '\n(执行超时)' })
    }, opts.timeout || 180000)

    opts.signal?.addEventListener?.('abort', onAbort, { once: true })

    child.stdout?.on('data', (c) => {
      const text = c.toString()
      stdout = trim(stdout + text)
      try {
        opts.onStdout?.(text)
      } catch (_) {
        /* 回调异常不影响进程 */
      }
    })
    child.stderr?.on('data', (c) => {
      const text = c.toString()
      stderr = trim(stderr + text)
      try {
        opts.onStderr?.(text)
      } catch (_) {
        /* ignore */
      }
    })
    child.on('error', (err) => finish({ status: -1, stdout, stderr: err.message }))
    child.on('close', (code) => finish({ status: code, stdout, stderr }))
  })
}

module.exports = { runAsync, killTree, quoteArg }
