/* 诊断脚本：提取 Electron localStorage（leveldb log）里的 chaos.* 条目 */
const fs = require('fs')
const path = require('path')
const dir = process.argv[2] || 'C:/Users/Andy/AppData/Roaming/ChaosConsole/Local Storage/leveldb'
for (const f of fs.readdirSync(dir)) {
  if (!/\.(log|ldb)$/.test(f)) continue
  const buf = fs.readFileSync(path.join(dir, f))
  const s = buf.toString('latin1').replace(/\x00/g, '')
  const hits = s.match(/chaos\.[a-zA-Z_]{2,20}[^a-zA-Z_][^\v]{0,300}/g) || []
  const seen = new Set()
  for (const h of hits) {
    const clean = h.replace(/[^\x20-\x7e]/g, '.').slice(0, 260)
    if (!seen.has(clean)) {
      seen.add(clean)
      console.log('--- ' + f)
      console.log(clean)
    }
  }
  console.log('[' + f + '] hits:', hits.length)
}
