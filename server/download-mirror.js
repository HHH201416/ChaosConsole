'use strict'

/**
 * 下载加速镜像 + 发布包完整性校验。
 *
 * 为什么需要镜像：本机的 hosts 被加速器改过，「发布包」的域名
 * （objects.githubusercontent.com）被指到 127.0.0.1，于是所有下载都被强制过本机
 * 的加速器代理。实测那条链路只有 ~0.1MB/s —— 87MB 的安装包要十几分钟；而给地址
 * 加一个公共镜像前缀（`https://gh-proxy.com/https://github.com/...`）能到 5MB/s。
 *
 * 为什么必须配校验：镜像返回的是**接下来会被执行的安装包**，第三方镜像有篡改的
 * 动机和机会。所以下载完必须拿该 Release 自己在 `latest.yml` 里声明的 sha512 对
 * 一遍才算数 —— `latest.yml` 是走 GitHub API 取的（链路由 TLS 保证），不经镜像。
 *
 * 本文件刻意不依赖 electron：全是纯函数，scripts/regress.js 可以直接 require 来测。
 */

const crypto = require('crypto')
const fs = require('fs')

/** 去掉两头的引号 —— latest.yml 里的字符串有些带引号有些不带 */
const unquote = (s) => String(s == null ? '' : s).trim().replace(/^['"]|['"]$/g, '')

/** 取路径里的文件名，并解掉 URL 编码（GitHub 的资源名可能有中文/空格） */
function baseName(p) {
  const s = String(p || '').split('?')[0].split('#')[0]
  const last = s.split('/').pop() || ''
  try {
    return decodeURIComponent(last)
  } catch (_) {
    return last
  }
}

/**
 * 规范化镜像前缀：接受 `https://gh-proxy.com` 或带结尾斜杠的写法，
 * 非法（空、非 http(s)、没有主机名）一律返回 ''，调用方据此当作「没配」。
 */
function normalizeMirror(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return ''
  if (!/^https?:\/\//i.test(s)) return ''
  const trimmed = s.replace(/\/+$/, '')
  try {
    const u = new URL(trimmed)
    if (!u.hostname) return ''
    return trimmed
  } catch (_) {
    return ''
  }
}

/**
 * 给 GitHub 的地址套上镜像前缀。只改写 github.com 的地址 —— API、以及用户自己
 * 填的其它地址一律原样返回，避免把不相干的东西也塞进第三方。
 */
function applyMirror(url, mirror) {
  const m = normalizeMirror(mirror)
  if (!m) return url
  const u = String(url == null ? '' : url)
  if (!/^https:\/\/github\.com\//i.test(u)) return url
  return `${m}/${u}`
}

/**
 * 解析 electron-builder 生成的 latest.yml。
 *
 * 刻意不引 YAML 库：这份文件的形状由 electron-builder 固定生成，只有
 * version / files[]（url、sha512、size、blockMapSize）/ path / sha512 这几个键，
 * 而且我们的构建脚本还会自己重写它。为它拉一个依赖不划算。
 */
function parseLatestYml(text) {
  const src = String(text == null ? '' : text)
  const top = (key) => {
    const m = src.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))
    return unquote(m ? m[1] : '')
  }

  const files = []
  const block = src.split(/^files:[ \t]*$/m)[1] || ''
  // files 里每一项以「行首缩进 + - 」开头，按它切块
  for (const chunk of block.split(/^[ \t]*-[ \t]+/m).slice(1)) {
    const field = (key) => {
      const m = chunk.match(new RegExp(`^[ \\t]*${key}:[ \\t]*(.+)$`, 'm'))
      return unquote(m ? m[1] : '')
    }
    const url = field('url')
    if (!url) continue
    files.push({
      url,
      sha512: field('sha512'),
      size: Number(field('size')) || 0,
      blockMapSize: Number(field('blockMapSize')) || 0,
    })
  }

  return { version: top('version'), files, sha512: top('sha512'), path: top('path') }
}

/**
 * 从 latest.yml 里挑出指定安装包的 sha512。
 * 按文件名匹配；匹配不上（老格式或只有一个文件）就退回顶层声明的 sha512。
 * 都拿不到返回 null —— 调用方据此跳过校验并如实提示。
 */
function pickFileHash(info, assetName) {
  const want = baseName(assetName)
  const files = (info && info.files) || []
  if (want) {
    const hit = files.find((f) => baseName(f.url) === want && f.sha512)
    if (hit) return { sha512: hit.sha512, size: hit.size || 0 }
  }
  if (files.length === 1 && files[0].sha512) {
    return { sha512: files[0].sha512, size: files[0].size || 0 }
  }
  if (info && info.sha512) return { sha512: info.sha512, size: 0 }
  return null
}

/** 算文件的 sha512（base64）—— 与 latest.yml 里的写法一致，不是 hex */
function sha512Of(filePath) {
  return crypto.createHash('sha512').update(fs.readFileSync(filePath)).digest('base64')
}

/**
 * 校验文件。expectedSha512 为空表示「没有可用的基准」，此时 skipped=true，
 * 调用方应当放行但如实说明没有校验过（不要伪装成校验通过）。
 */
function verifyFile(filePath, expectedSha512) {
  const want = unquote(expectedSha512)
  if (!want) return { ok: true, skipped: true, actual: '' }
  const actual = sha512Of(filePath)
  return { ok: actual === want, skipped: false, actual }
}

module.exports = { normalizeMirror, applyMirror, parseLatestYml, pickFileHash, sha512Of, verifyFile }
