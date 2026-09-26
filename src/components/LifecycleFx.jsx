import { useEffect, useRef, useState } from 'react'

/**
 * 启动 / 退出的界面特效。
 *
 * 两端各一个：
 *  - BootScreen：界面在等后端时就绪（恢复会话）时顶上去，替代原来那行光秃秃的
 *    「正在启动…」。真正的冷启动更早的一段由 Electron 的闪屏窗口接管
 *    （见 electron/splash.html）。
 *  - ShutdownOverlay：收到主进程的 app:quitting 后播放退场序列，主进程等它播完
 *    再真正退出（时长和 electron/main.js 里的 EXIT_ANIM_MS 对齐）。
 *
 * 两个组件都刻意不用 <h1>/<h2>：端到端自检里 `document.querySelector('h1')`
 * 是用来断言登录页/顶栏标题的，特效层里再塞一个 h1 会把它顶掉。
 */

/** 退场序列总时长，必须 >= electron/main.js 的 EXIT_ANIM_MS 才不会播到一半被切掉 */
const EXIT_ANIM_MS = 1500

const SHUTDOWN_STEPS = [
  { at: 0, text: '断开实时通道' },
  { at: 260, text: '保存任务与对话数据' },
  { at: 620, text: '停止执行器进程' },
  { at: 980, text: '关闭 HTTP / WebSocket 服务' },
]

export function BootScreen() {
  return (
    <div className="fx-boot">
      <div className="fx-boot-grid" />
      <div className="fx-boot-scan" />
      <div className="fx-boot-core">
        <div className="fx-ring fx-ring-sm">
          <span className="fx-ring-hex fx-ring-hex-a" />
          <span className="fx-ring-hex fx-ring-hex-b" />
          <span className="fx-ring-dot" />
        </div>
        <div className="fx-boot-title">正在接管控制台</div>
        <div className="fx-boot-sub">INITIALIZING RUNTIME</div>
        <div className="fx-bootbar">
          <span />
        </div>
      </div>
    </div>
  )
}

export function ShutdownOverlay() {
  const [quitting, setQuitting] = useState(false)
  const [step, setStep] = useState(-1)
  const [closing, setClosing] = useState(false)
  const timers = useRef([])

  useEffect(() => {
    const bridge = window.chaos
    if (!bridge?.onAppQuit) return undefined

    const off = bridge.onAppQuit(() => setQuitting(true))
    return () => {
      off?.()
      timers.current.forEach(clearTimeout)
    }
  }, [])

  // 退场时间线：逐步点亮日志 → 进度跑满 → 收束成一条线熄灭
  useEffect(() => {
    if (!quitting) return undefined
    const push = (fn, ms) => timers.current.push(setTimeout(fn, ms))

    SHUTDOWN_STEPS.forEach((s, i) => push(() => setStep(i), s.at))
    push(() => setClosing(true), EXIT_ANIM_MS - 320)

    return () => {
      timers.current.forEach(clearTimeout)
      timers.current = []
    }
  }, [quitting])

  if (!quitting) return null

  const progress = Math.round(((step + 1) / SHUTDOWN_STEPS.length) * 100)

  return (
    <div className={`fx-exit ${closing ? 'fx-exit-closing' : ''}`}>
      <div className="fx-exit-crt" />
      <div className="fx-exit-panel">
        <div className="fx-exit-head">
          <span className="fx-exit-led" />
          <span className="fx-exit-title">正在安全退出</span>
          <span className="fx-exit-code">SHUTDOWN</span>
        </div>

        <ul className="fx-exit-log">
          {SHUTDOWN_STEPS.map((s, i) => (
            <li
              key={s.text}
              className={i < step ? 'done' : i === step ? 'now' : ''}
              style={{ opacity: i <= step ? 1 : 0.22 }}
            >
              <span className="fx-exit-mark">{i < step ? '✓' : i === step ? '▸' : '·'}</span>
              {s.text}
            </li>
          ))}
        </ul>

        <div className="fx-exit-bar">
          <span style={{ width: `${progress}%` }} />
        </div>

        <div className="fx-exit-foot">
          <span>CHAOS CONSOLE</span>
          <span>{(EXIT_ANIM_MS / 1000).toFixed(1)}s · 数据已落盘</span>
        </div>
      </div>
    </div>
  )
}
