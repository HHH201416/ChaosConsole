import { useState, useRef, useEffect } from 'react'
import { useStore } from '../store'

export default function Login() {
  const [code, setCode] = useState('')
  const { login, loggingIn, loginError } = useStore()
  const inputRef = useRef(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = (e) => {
    e.preventDefault()
    if (!code.trim() || loggingIn) return
    login(code.trim())
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden bg-ink-900">
      {/* 背景光晕 */}
      <div className="pointer-events-none absolute -left-40 -top-40 h-[28rem] w-[28rem] rounded-full bg-boss/10 blur-[100px]" />
      <div className="pointer-events-none absolute -bottom-52 -right-32 h-[32rem] w-[32rem] rounded-full bg-sky-500/10 blur-[110px]" />
      {/* 网格线颜色在 .login-grid 里（src/index.css），走主题变量 ——
          原来写死成 rgba(255,255,255,…) 的内联 style，浅色主题下什么也看不见 */}
      <div className="login-grid pointer-events-none absolute inset-0 opacity-[0.35]" />

      <form
        onSubmit={submit}
        className="relative z-10 w-[26rem] animate-slideUp rounded-2xl border border-ink-500 bg-ink-800/80 p-8 shadow-2xl backdrop-blur"
      >
        <div className="mb-7 text-center">
          <div className="mb-3 text-5xl">🕴️</div>
          <h1 className="text-2xl font-bold tracking-wide text-slate-100">AI Agent开发控制台</h1>
          <p className="mt-1.5 font-mono text-[11px] uppercase tracking-[0.25em] text-slate-500">
            ChaosConsole
          </p>
        </div>

        <label className="mb-2 block text-xs font-medium text-slate-400">授权码</label>
        <input
          ref={inputRef}
          type="password"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="请输入授权码"
          autoComplete="off"
          className="field mb-3 text-center font-mono tracking-[0.3em]"
        />

        <div className="mb-4 h-5 text-center text-xs text-rose-400">{loginError}</div>

        <button type="submit" disabled={loggingIn || !code.trim()} className="btn-primary w-full py-2.5 text-sm">
          {loggingIn ? '验证中…' : '进入办公室'}
        </button>

        <p className="mt-6 text-center text-[11px] leading-relaxed text-slate-600">
          本机单机应用 · 数据保存在本地 SQLite
          <br />
          Agent 通过 claude CLI 执行任务
        </p>
      </form>
    </div>
  )
}
