import { Component } from 'react'
import { useStore } from '../store'

/**
 * 9.5.5：渲染错误兜底（Error Boundary）。
 *
 * 之前只要任何一个组件在 render 里抛错（例如把接口返回的包装对象当数组 map），
 * React 会把**整棵树**卸掉 —— 用户看到的就是一片漆黑的空白窗口，连错误都看不到。
 * 这里把崩溃圈在最小范围内：面板坏了对话照用，主界面坏了也还有一张能复制报错的卡片。
 *
 * 注意：Error Boundary 只能接住 render / 生命周期里的同步错误，
 * 事件回调和 Promise 里的错误由 public/error-boot.js 的全局兜底负责，两者互补。
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, stack: '' }
    this.reset = this.reset.bind(this)
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    const stack = String(info?.componentStack || '').trim()
    this.setState({ stack })
    // 保留到控制台，方便排查；error-boot 的浮层同样会显示
    console.error('[ChaosConsole] 界面组件渲染失败：', error, '\n组件栈：', stack)
    // 10.0.0：界面脚本出错 = 严重错误，氛围灯红色闩锁常亮直到修复
    try {
      useStore.getState().triggerErrorFlash({ severe: true })
    } catch (_) {
      /* 氛围灯失败不影响错误处理 */
    }
    if (typeof this.props.onError === 'function') {
      try {
        this.props.onError(error, stack)
      } catch (_) {
        /* 兜底回调自身出错就算了，不能再往上抛 */
      }
    }
  }

  reset() {
    this.setState({ error: null, stack: '' })
  }

  render() {
    const { error, stack } = this.state
    if (!error) return this.props.children

    const compact = this.props.compact
    const label = this.props.label || '这个区域'
    const message = String(error?.message || error || '未知错误')

    if (compact) {
      return (
        <aside className="flex w-[24rem] shrink-0 flex-col border-l border-ink-600 bg-ink-800 p-3">
          <p className="text-[11.5px] font-medium text-amber-300">⚠️ {label}加载失败</p>
          <p className="mt-1 break-words font-mono text-[10px] leading-relaxed text-slate-500">{message}</p>
          <button className="btn-ghost mt-2 self-start px-2 py-1 text-[11px]" onClick={this.reset}>
            重试
          </button>
        </aside>
      )
    }

    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 p-6">
        <p className="text-[13px] font-semibold text-amber-300">⚠️ {label}渲染出错了</p>
        <p className="max-w-[42rem] break-words text-center font-mono text-[11px] leading-relaxed text-slate-400">
          {message}
        </p>
        {stack && (
          <pre className="max-h-40 w-full max-w-[42rem] overflow-auto rounded-lg border border-ink-600 bg-ink-900 p-2.5 font-mono text-[9.5px] leading-relaxed text-slate-600">
            {stack}
          </pre>
        )}
        <div className="flex gap-2">
          <button className="btn-primary px-3 py-1.5 text-[12px]" onClick={this.reset}>
            重试
          </button>
          <button className="btn-ghost px-3 py-1.5 text-[12px]" onClick={() => window.location.reload()}>
            重新加载
          </button>
        </div>
        <p className="text-[10.5px] text-slate-600">数据没有丢，重试或重新加载即可继续。</p>
      </div>
    )
  }
}
