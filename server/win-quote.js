'use strict'

/**
 * 给即将经 cmd.exe 解析的命令行参数补引号。
 *
 * 从 mcp.js 抽出来单独放这里，是因为 runner 也要用同一套规则给
 * `--mcp-config <路径>` 补引号（那个路径在 %APPDATA% 下，用户名带空格就会拆参数）。
 * 两处各写一份迟早会漂移，而这类漂移的后果是静默的参数损坏。
 *
 * Windows：调用方走 shell:true，参数最终由 cmd.exe 再解析一遍。
 *  - 只在含空格时才补引号是错的：`&`、`|`、`>` 会被 cmd 当成控制符。
 *    postgres 连接串 `...?a=1&b=2` 会被从 `&` 处截断后注册（半截字符串），
 *    `b=2` 还会被当成第二条命令执行 —— 既是静默的参数损坏，也是命令注入。
 *  - 补了引号还要遵守 CreateProcess/MSVCRT 的解析规则：只有紧跟在引号前的
 *    `\` 才有转义含义，所以尾随反斜杠必须翻倍，否则 `D:\`（filesystem 的
 *    allowedDirs 就会传这个）会被解析成 `D:"`。
 *  - `%VAR%` 在引号内**仍然**会被 cmd 展开，而引号内的 `^` 是普通字符、
 *    转义无效，所以只能在 `%` 处把引号断开，用引号外的 `^%` 写出字面 `%`。
 *  - `&|<>()`、`!`、`^` 在引号内本来就是普通字符（`!` 只在 cmd /V:on 下才有
 *    意义，而 node 起的是 /d /s /c），再补一层 `^` 反而会凭空多出一个 `^`
 *    字符，所以只靠引号屏蔽，不做 caret 转义。以上几条都是实测过的：
 *    spawn(shell:true) 起一个只回显 argv 的进程，逐个用例比对原串。
 *
 * 非 Windows：调用方是 shell:false，参数直接进 argv，一个字都不能动 ——
 * 补引号会把引号变成路径的一部分（`/home/me/My Projects` 会带上字面引号）。
 */
function quoteArg(arg) {
  const s = String(arg)
  if (process.platform !== 'win32') return s
  // 先按 `%` 切开，每段各自加引号，段间用引号外的 ^% 连接
  return s.split('%').map(quoteWinSegment).join('^%')
}

/** 单个片段：双引号包裹，并按 MSVCRT 规则处理内部引号与前置反斜杠 */
function quoteWinSegment(part) {
  let out = '"'
  let backslashes = 0
  for (const ch of part) {
    if (ch === '\\') {
      backslashes++
      continue
    }
    // 引号前的反斜杠要翻倍（2n+1 个才能既保留 n 个 \ 又得到一个字面 "）
    if (ch === '"') {
      out += '\\'.repeat(backslashes * 2 + 1) + '"'
      backslashes = 0
      continue
    }
    out += '\\'.repeat(backslashes) + ch
    backslashes = 0
  }
  return out + '\\'.repeat(backslashes * 2) + '"'
}

module.exports = { quoteArg, quoteWinSegment }
