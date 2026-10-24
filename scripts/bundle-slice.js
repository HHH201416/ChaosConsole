// 精确定位 bundle 中报错列号的源码片段
const fs = require('fs')

const file = process.argv[2]
const lineNo = Number(process.argv[3] || 40)
const col = Number(process.argv[4] || 41026)
const pad = Number(process.argv[5] || 260)

const lines = fs.readFileSync(file, 'utf8').split('\n')
const line = lines[lineNo - 1] || ''
console.log(`line ${lineNo} length=${line.length}, total lines=${lines.length}`)
const start = Math.max(0, col - pad)
const end = Math.min(line.length, col + pad)

// 打印前后两段，并用 ^ 标出精确列
console.log('--- 片段 ---')
console.log(line.slice(start, end))
console.log('--- 精确列附近 ---')
console.log(line.slice(Math.max(0, col - 60), col) + ' <<<HERE>>> ' + line.slice(col, col + 60))
