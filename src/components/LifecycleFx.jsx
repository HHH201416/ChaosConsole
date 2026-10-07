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

/* ---------------- 启动屏（正在接管控制台） ---------------- */

/** 启动屏总时长。计时从主窗口**真正显示出来**那一刻开始（见下面 onAppShown 的注释） */
const BOOT_MS = 5000

/**
 * 数据还没就绪时，进度条最多走到这里。
 *
 * 这是这块屏唯一一条诚实的底线：那 5 秒的时间轴是编排出来的（后端本地起，
 * 快到给不出真实进度），所以它能一路走到 92% 假装在忙；但**只要 bootstrap 还没
 * 回来，它就绝不打到 100%**。真话只有一句：「还没好」。
 */
const BOOT_HOLD_PCT = 92

/** 启动步骤。时间轴是固定的，最后一步要等数据真的到了才收尾 */
const BOOT_STEPS = [
  { at: 0, text: '应用启动' },
  { at: 900, text: '读取本地配置' },
  { at: 1800, text: '连接本地服务' },
  { at: 2900, text: '恢复岗位与任务' },
  { at: 3900, text: '校验运行环境' },
]

/* 一次应用启动只播一遍。用 sessionStorage 而不是 localStorage：按 F5 重载
   不是「启动」，而且两道自检脚本会大量 reload 并按固定毫秒数断言 —— 每次重播
   5 秒会把它们全部拖垮。窗口关掉 sessionStorage 自然就没了。 */
const BOOTED_KEY = 'chaos.booted'

/**
 * 这次要不要跳过启动屏。两个出口：
 *   1. 自检脚本带 CHAOS_SKIP_BOOT=1 启动（主进程经 preload 暴露成 skipBoot）；
 *   2. 本次会话已经播过了（页面重载）。
 * 刻意导出给 App 用 —— 在 App 的 useState 初值里就判断掉，跳过时连一帧都不渲染，
 * 不然会闪一下。
 */
export function shouldSkipBoot() {
  if (window.chaos?.skipBoot === true) return true
  try {
    return sessionStorage.getItem(BOOTED_KEY) === '1'
  } catch (_) {
    return false // 隐私模式下 sessionStorage 会直接抛
  }
}

function markBooted() {
  try {
    sessionStorage.setItem(BOOTED_KEY, '1')
  } catch (_) {
    /* 存不进去也不影响本次会话 */
  }
}

/**
 * 接管控制台的过场。等界面「能用了」再交出去。
 *
 * @param ready  数据是否已经就绪（bootstrap 是否回来了）
 * @param onDone 播完之后调一次，由 App 把这块屏摘掉
 */
export function BootScreen({ ready, onDone }) {
  const [startedAt, setStartedAt] = useState(null)
  const [step, setStep] = useState(0)
  const [pct, setPct] = useState(0)
  const [allDone, setAllDone] = useState(false)
  const [closing, setClosing] = useState(false)
  /* 时间轴跑完了、数据却还没到 —— 这时候才解释「为什么卡着」 */
  const [waitingBackend, setWaitingBackend] = useState(false)

  // ready / onDone 每帧都可能是新引用，用 ref 读，免得把计时器反复重建
  const readyRef = useRef(ready)
  const onDoneRef = useRef(onDone)
  readyRef.current = ready
  onDoneRef.current = onDone
  const finishedRef = useRef(false)

  /* 起跑线：主窗口显示出来的那一刻。
     主窗口是 show:false 建的，冷启动闪屏期间它已经在渲染了，只是没人看得见 ——
     从挂载时间开始算的话，5 秒里有大半是播给一个隐藏窗口看的。 */
  useEffect(() => {
    if (startedAt != null) return undefined
    let fired = false
    const start = () => {
      if (fired) return
      fired = true
      markBooted()
      setStartedAt(Date.now())
    }
    const bridge = window.chaos
    let off = null
    let fallback
    if (bridge?.onAppShown) {
      off = bridge.onAppShown(start)
      /* 挂完监听再主动问一次「显示了没」。app:shown 一辈子只发一次，页面重载后
         是收不到的 —— 只挂监听的话时间轴永远不启动，界面就卡在这儿了。
         事件和这次查询谁先到都行，start 里有 fired 守卫。 */
      bridge.isAppShown?.().then((shown) => {
        if (shown) start()
      })
      /* 最后的兜底，给得很宽，只防「IPC 通了但通知就是不来」。
         ⚠️ 别调短 —— 主窗口要等冷启动闪屏那 5 秒才 show，兜底比它短就会抢在
         前面触发，这 5 秒等于白算（第一版写 1.5 秒就是这么翻车的）。 */
      fallback = setTimeout(start, 10000)
    } else {
      // 没有 Electron 桥（在浏览器里单独跑前端）：没有「窗口显示」这回事，立刻开始
      fallback = setTimeout(start, 0)
    }
    return () => {
      off?.()
      clearTimeout(fallback)
    }
  }, [startedAt])

  // 时间轴
  useEffect(() => {
    if (startedAt == null) return undefined
    const tick = () => {
      const elapsed = Date.now() - startedAt
      const t = Math.min(1, elapsed / BOOT_MS)
      let i = 0
      while (i + 1 < BOOT_STEPS.length && elapsed >= BOOT_STEPS[i + 1].at) i++
      setStep(i)

      const done = t >= 1 && readyRef.current
      setAllDone(done)
      setWaitingBackend(t >= 1 && !readyRef.current)
      // 数据没到就顶在 92%，绝不打满
      const cap = readyRef.current ? 1 : BOOT_HOLD_PCT / 100
      setPct(Math.round(Math.min(t, cap) * 100))

      if (done && !finishedRef.current) {
        finishedRef.current = true
        setClosing(true)
        setTimeout(() => onDoneRef.current?.(), 320) // 等淡出播完再摘
      }
    }
    tick()
    const timer = setInterval(tick, 60)
    return () => clearInterval(timer)
  }, [startedAt])

  return (
    <div className={`fx-boot${closing ? ' fx-boot-closing' : ''}`}>
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

        <ul className="fx-boot-log">
          {BOOT_STEPS.map((s, i) => {
            const cls = allDone || i < step ? 'done' : i === step ? 'now' : ''
            return (
              <li key={s.text} className={cls}>
                <span className="fx-boot-mark">
                  {allDone || i < step ? '✓' : i === step ? '▸' : '·'}
                </span>
                {s.text}
                {/* 卡在最后一步时把原因说清楚，别让人对着一个不动的进度条猜 */}
                {i === step && waitingBackend ? '（等待后端响应）' : ''}
              </li>
            )
          })}
        </ul>

        <div className="fx-bootbar">
          <span className="fx-bootbar-fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="fx-boot-pct">{pct}%</div>
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
