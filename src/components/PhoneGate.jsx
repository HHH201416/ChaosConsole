import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'

/**
 * 9.7.0：手机号绑定闸门。
 *
 * 用户要求「手机号是必须填了才能用这个应用」—— 所以这是一层**不可关闭**的全屏遮罩：
 * 没绑定之前界面进不去，绑定成功后自动消失（store.bindChaosPhone 会 refreshSystem）。
 *
 * 号只存在本机 chaos.db 里（settings.chaosQuota.phones），不上传任何服务器。
 */
export default function PhoneGate() {
  const bindChaosPhone = useStore((s) => s.bindChaosPhone)
  const [phone, setPhone] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    const id = setTimeout(() => inputRef.current?.focus(), 300)
    return () => clearTimeout(id)
  }, [])

  const valid = /^1[3-9]\d{9}$/.test(phone.replace(/[\s-]/g, '').replace(/^\+?86/, ''))

  const submit = async () => {
    if (!valid || busy) return
    setBusy(true)
    setErr('')
    try {
      // 失败时 store 里已经弹了 toast，这里再留一条常驻提示，
      // 免得 10 秒后 toast 消失、用户以为点空了
      const ok = await bindChaosPhone(phone.trim())
      if (!ok) setErr('绑定没成功，检查一下号码或稍后再试')
    } finally {
      setBusy(false)
    }
  }

  return (
    // 注意：ink 色板只到 900，没有更深的档位 —— 写更深的那个类名会被当成无效
    // 类名、遮罩直接透明（9.7.0 踩过）。别把这里的 ink-900 调深。
    <div className="fixed inset-0 z-[92] flex items-center justify-center bg-ink-900/97 px-4 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-2xl border border-ink-500 bg-ink-800 p-6 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <span className="text-2xl">🌀</span>
          <div>
            <h2 className="text-[15px] font-semibold text-slate-100">绑定手机号后开始使用</h2>
            <p className="mt-0.5 text-[10.5px] text-slate-500">ChaosConsole · 首次使用需要激活额度</p>
          </div>
        </div>

        <input
          ref={inputRef}
          value={phone}
          onChange={(e) => setPhone(e.target.value.replace(/[^\d+\s-]/g, '').slice(0, 19))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
          placeholder="输入手机号（11 位）"
          inputMode="tel"
          className="field w-full py-2 text-center font-mono text-[14px] tracking-[0.15em]"
        />

        <button className="btn-primary mt-3 w-full py-2" disabled={!valid || busy} onClick={submit}>
          {busy ? '绑定中…' : '绑定并开始使用'}
        </button>

        {err && <p className="mt-2 text-center text-[11px] text-rose-400">{err}</p>}

        <ul className="mt-3 space-y-1 text-[10.5px] leading-relaxed text-slate-500">
          <li>· 每个手机号每天 3000 万 token，跨天自动恢复</li>
          <li>· 号码只保存在本机数据库，不上传任何服务器</li>
          <li>· 换电脑重新绑定同一个号即可，额度按号计算</li>
        </ul>
      </div>
    </div>
  )
}
