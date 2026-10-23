'use strict'

/**
 * 8.0.0：中英文字典一致性检查。
 *
 * - zh / en 的 key 集合必须完全一致
 * - 源码里静态的 t('...') 调用必须能在两个字典里找到
 *
 * 动态 key（如 `board.${key}`）不在这里展开，由 e2e 覆盖。
 * 用法：npm run check:i18n
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const i18nFile = path.join(ROOT, 'src', 'lib', 'i18n.js')
const text = fs.readFileSync(i18nFile, 'utf8')

const enAt = text.indexOf('  en: {')
if (enAt < 0) {
  console.error('找不到 en 字典')
  process.exit(1)
}
const zhPart = text.slice(0, enAt)
const enPart = text.slice(enAt)

const keysOf = (part) => {
  const out = new Set()
  const re = /^\s*'([^']+)'\s*:/gm
  let m
  while ((m = re.exec(part))) out.add(m[1])
  return out
}

const zh = keysOf(zhPart)
const en = keysOf(enPart)

const missingEn = [...zh].filter((k) => !en.has(k))
const missingZh = [...en].filter((k) => !zh.has(k))

console.log(`\n=== i18n 检查：zh ${zh.size} 键 / en ${en.size} 键 ===`)
if (missingEn.length) {
  console.log(`en 缺少 ${missingEn.length} 个：`)
  for (const k of missingEn) console.log('  -', k)
}
if (missingZh.length) {
  console.log(`zh 缺少 ${missingZh.length} 个：`)
  for (const k of missingZh) console.log('  -', k)
}

// 扫描源码里的静态 t('...')
const used = new Map()
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (/\.(jsx?|mjs)$/.test(entry.name)) {
      const src = fs.readFileSync(full, 'utf8')
      const re = /\bt\(\s*'([^']+)'/g
      let m
      while ((m = re.exec(src))) {
        if (!used.has(m[1])) used.set(m[1], [])
        used.get(m[1]).push(path.relative(ROOT, full))
      }
    }
  }
}
walk(path.join(ROOT, 'src'))

const missingUsed = []
for (const [key, files] of used) {
  if (!zh.has(key) || !en.has(key)) missingUsed.push({ key, files: [...new Set(files)] })
}

if (missingUsed.length) {
  console.log(`\n源码使用但字典缺失 ${missingUsed.length} 个：`)
  for (const item of missingUsed) console.log(`  - ${item.key}  (${item.files.join(', ')})`)
}

const ok = !missingEn.length && !missingZh.length && !missingUsed.length
console.log(ok ? '\n=== i18n 检查通过 ===' : '\n=== i18n 检查失败 ===')
process.exit(ok ? 0 : 1)
