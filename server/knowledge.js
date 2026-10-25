'use strict'

/**
 * 知识库（Knowledge Base）。
 *
 * 应用内直接建库、导入/导出、检索。数据落 SQLite（knowledge_bases /
 * knowledge_docs 两张表，见 db.js SCHEMA），与任务、员工同库同备份。
 *
 * 两个消费方：
 *   1. 界面 —— /api/kb* 路由（见 index.js），增删改查、导入导出；
 *   2. Agent —— runner.js 组装提示词时调 contextFor()，把检索到的资料
 *      以「知识库参考资料」段落注入提示词（可用设置 kbInjectEnabled 关掉）。
 *
 * 检索是纯本地的关键词评分：查询拆成 CJK 二元组 + ASCII 词，对每篇文档的
 * 标题与正文计次打分，取最高分的几篇、截取命中窗口附近的片段。
 * 没有向量库、没有联网 embedding —— 知识库不应该把数据送出这台电脑。
 */

const crypto = require('crypto')
const db = require('./db')
const store = require('./store')

const MAX_DOCS_SCAN = 3000
const MAX_DOC_CHARS = 512 * 1024 // 单篇文档上限 512KB，防一次导入拖垮内存库

const now = () => Date.now()
const uid = () => crypto.randomUUID()

/** store.listAgents 返回的字段是驼峰；这里统一吐驼峰，前端与导出格式都好认 */
function rowToKb(r) {
  return {
    id: r.id,
    name: r.name,
    description: r.description || '',
    docCount: r.doc_count || 0,
    chars: r.chars || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function rowToDoc(r, { withContent = true } = {}) {
  const doc = {
    id: r.id,
    kbId: r.kb_id,
    title: r.title,
    source: r.source || '',
    createdAt: r.created_at,
    chars: (r.content || '').length,
  }
  if (withContent) doc.content = r.content || ''
  return doc
}

/* ------------------------------------------------------------------ *
 * 知识库 CRUD
 * ------------------------------------------------------------------ */

function listKbs() {
  return db
    .all(
      `SELECT kb.*,
              (SELECT COUNT(*) FROM knowledge_docs d WHERE d.kb_id = kb.id) AS doc_count,
              (SELECT IFNULL(SUM(LENGTH(d.content)), 0) FROM knowledge_docs d WHERE d.kb_id = kb.id) AS chars
       FROM knowledge_bases kb ORDER BY kb.updated_at DESC`,
    )
    .map(rowToKb)
}

function getKb(id) {
  const r = db.get('SELECT * FROM knowledge_bases WHERE id = ?', [id])
  return r ? rowToKb(r) : null
}

function emitChanged() {
  store.bus.emit('kb:changed', { at: now() })
}

function createKb({ name, description = '' } = {}) {
  const cleanName = String(name || '').trim()
  if (!cleanName) return { ok: false, error: '请填写知识库名称' }
  const kb = {
    id: uid(),
    name: cleanName.slice(0, 80),
    description: String(description || '').slice(0, 500),
    createdAt: now(),
    updatedAt: now(),
  }
  db.run(
    'INSERT INTO knowledge_bases (id, name, description, created_at, updated_at) VALUES (?,?,?,?,?)',
    [kb.id, kb.name, kb.description, kb.createdAt, kb.updatedAt],
  )
  emitChanged()
  return { ok: true, data: getKb(kb.id) }
}

function updateKb(id, patch = {}) {
  const kb = getKb(id)
  if (!kb) return { ok: false, error: '知识库不存在' }
  const name = patch.name !== undefined ? String(patch.name).trim().slice(0, 80) : kb.name
  if (!name) return { ok: false, error: '知识库名称不能为空' }
  const description =
    patch.description !== undefined ? String(patch.description || '').slice(0, 500) : kb.description
  db.run('UPDATE knowledge_bases SET name = ?, description = ?, updated_at = ? WHERE id = ?', [
    name,
    description,
    now(),
    id,
  ])
  emitChanged()
  return { ok: true, data: getKb(id) }
}

function deleteKb(id) {
  if (!getKb(id)) return { ok: false, error: '知识库不存在' }
  db.run('DELETE FROM knowledge_docs WHERE kb_id = ?', [id])
  db.run('DELETE FROM knowledge_bases WHERE id = ?', [id])
  emitChanged()
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * 文档
 * ------------------------------------------------------------------ */

function listDocs(kbId) {
  if (!getKb(kbId)) return { ok: false, error: '知识库不存在' }
  const rows = db.all('SELECT * FROM knowledge_docs WHERE kb_id = ? ORDER BY created_at DESC', [kbId])
  return { ok: true, data: rows.map((r) => rowToDoc(r)) }
}

function addDoc(kbId, { title, content, source = '' } = {}) {
  if (!getKb(kbId)) return { ok: false, error: '知识库不存在' }
  const cleanTitle = String(title || '').trim()
  const text = String(content || '')
  if (!cleanTitle) return { ok: false, error: '请填写文档标题' }
  if (!text.trim()) return { ok: false, error: '文档内容不能为空' }
  if (text.length > MAX_DOC_CHARS) return { ok: false, error: `单篇文档不能超过 ${Math.round(MAX_DOC_CHARS / 1024)} KB` }

  const doc = { id: uid(), title: cleanTitle.slice(0, 200) }
  db.run(
    'INSERT INTO knowledge_docs (id, kb_id, title, content, source, created_at) VALUES (?,?,?,?,?,?)',
    [doc.id, kbId, doc.title, text, String(source || '').slice(0, 200), now()],
  )
  db.run('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', [now(), kbId])
  emitChanged()
  return { ok: true, data: rowToDoc(db.get('SELECT * FROM knowledge_docs WHERE id = ?', [doc.id])) }
}

/**
 * 9.8.0：在应用内编辑已有文档（用户要求「知识库要可以创建编辑文件在应用内」）。
 * 只改传进来的字段；标题/内容都要过和新建一样的校验。
 */
function updateDoc(kbId, docId, { title, content, source } = {}) {
  const row = db.get('SELECT * FROM knowledge_docs WHERE id = ? AND kb_id = ?', [docId, kbId])
  if (!row) return { ok: false, error: '文档不存在' }

  const nextTitle = title !== undefined ? String(title || '').trim().slice(0, 200) : row.title
  if (!nextTitle) return { ok: false, error: '请填写文档标题' }
  const nextContent = content !== undefined ? String(content || '') : row.content
  if (!nextContent.trim()) return { ok: false, error: '文档内容不能为空' }
  if (nextContent.length > MAX_DOC_CHARS) {
    return { ok: false, error: `单篇文档不能超过 ${Math.round(MAX_DOC_CHARS / 1024)} KB` }
  }
  const nextSource = source !== undefined ? String(source || '').slice(0, 200) : row.source

  db.run('UPDATE knowledge_docs SET title = ?, content = ?, source = ? WHERE id = ?', [
    nextTitle,
    nextContent,
    nextSource,
    docId,
  ])
  db.run('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', [now(), kbId])
  emitChanged()
  return { ok: true, data: rowToDoc(db.get('SELECT * FROM knowledge_docs WHERE id = ?', [docId])) }
}

function deleteDoc(kbId, docId) {
  const r = db.get('SELECT * FROM knowledge_docs WHERE id = ? AND kb_id = ?', [docId, kbId])
  if (!r) return { ok: false, error: '文档不存在' }
  db.run('DELETE FROM knowledge_docs WHERE id = ?', [docId])
  db.run('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', [now(), kbId])
  emitChanged()
  return { ok: true }
}

/* ------------------------------------------------------------------ *
 * 导入 / 导出
 * ------------------------------------------------------------------ */

/**
 * 导入一整个知识库。
 *   targetId 缺省 → 新建库（name 必填）
 *   targetId 给定 → 文档并入已有库（title 相同的跳过，避免重复导入）
 * docs: [{title, content, source?}]
 */
function importKb({ targetId, name, description = '', docs = [] } = {}) {
  if (!Array.isArray(docs) || !docs.length) return { ok: false, error: '导入文件里没有文档' }
  if (docs.length > 500) return { ok: false, error: '一次最多导入 500 篇文档' }

  let kbId = targetId
  if (kbId) {
    if (!getKb(kbId)) return { ok: false, error: '目标知识库不存在' }
  } else {
    const created = createKb({ name, description })
    if (!created.ok) return created
    kbId = created.data.id
  }

  const existing = new Set(
    db.all('SELECT title FROM knowledge_docs WHERE kb_id = ?', [kbId]).map((r) => r.title),
  )
  let added = 0
  let skipped = 0
  for (const doc of docs.slice(0, 500)) {
    const title = String(doc?.title || '').trim().slice(0, 200)
    const content = String(doc?.content || '')
    if (!title || !content.trim() || content.length > MAX_DOC_CHARS) {
      skipped++
      continue
    }
    if (existing.has(title)) {
      skipped++
      continue
    }
    existing.add(title)
    db.run(
      'INSERT INTO knowledge_docs (id, kb_id, title, content, source, created_at) VALUES (?,?,?,?,?,?)',
      [uid(), kbId, title, content, String(doc?.source || 'import').slice(0, 200), now()],
    )
    added++
  }
  db.run('UPDATE knowledge_bases SET updated_at = ? WHERE id = ?', [now(), kbId])
  emitChanged()
  return { ok: true, data: { kbId, added, skipped } }
}

/** 导出为 {filename, contentType, body}；format: 'json' | 'md' */
function exportKb(kbId, format = 'json') {
  const kb = getKb(kbId)
  if (!kb) return { ok: false, error: '知识库不存在' }
  const docs = db
    .all('SELECT * FROM knowledge_docs WHERE kb_id = ? ORDER BY created_at ASC', [kbId])
    .map((r) => rowToDoc(r))

  if (format === 'md') {
    const parts = [`# ${kb.name}`, '']
    if (kb.description) parts.push(`> ${kb.description}`, '')
    for (const d of docs) {
      parts.push(`## ${d.title}`, '', d.content, '')
    }
    return {
      ok: true,
      data: {
        filename: `${kb.name}.md`.replace(/[\\/:*?"<>|]/g, '_'),
        contentType: 'text/markdown; charset=utf-8',
        body: parts.join('\n'),
      },
    }
  }

  const body = JSON.stringify(
    { chaosKnowledgeBase: 1, name: kb.name, description: kb.description, exportedAt: now(), docs },
    null,
    2,
  )
  return {
    ok: true,
    data: {
      filename: `${kb.name}.chaoskb.json`.replace(/[\\/:*?"<>|]/g, '_'),
      contentType: 'application/json; charset=utf-8',
      body,
    },
  }
}

/* ------------------------------------------------------------------ *
 * 检索（本地关键词评分）
 * ------------------------------------------------------------------ */

/** CJK 拆二元组，ASCII 拆小写词。查询与文档用同一套分词。 */
function tokenize(text) {
  const src = String(text || '').toLowerCase()
  const tokens = []
  for (const m of src.matchAll(/[\u4e00-\u9fff]+/g)) {
    const seg = m[0]
    if (seg.length === 1) {
      tokens.push(seg)
      continue
    }
    for (let i = 0; i < seg.length - 1; i++) tokens.push(seg.slice(i, i + 2))
  }
  for (const m of src.matchAll(/[a-z0-9_][a-z0-9_-]{1,31}/g)) tokens.push(m[0])
  return tokens
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0
  let count = 0
  let idx = 0
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count++
    idx += needle.length
  }
  return count
}

/** 挑命中词附近的一段原文（往两边各扩 ~300 字符） */
function excerptOf(content, tokens) {
  let firstIdx = -1
  for (const tk of tokens) {
    if (!/[\u4e00-\u9fff a-z0-9]/.test(tk[0]) && tk.length < 2) continue
    const idx = content.indexOf(tk)
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) firstIdx = idx
  }
  if (firstIdx === -1) return content.slice(0, 500)
  const start = Math.max(0, firstIdx - 300)
  const end = Math.min(content.length, firstIdx + 500)
  return (start > 0 ? '…' : '') + content.slice(start, end) + (end < content.length ? '…' : '')
}

/**
 * 全库检索。返回 [{kbId, kbName, docId, title, score, excerpt}]，按分数降序。
 * query 至少要有一个 token 才动手，否则返回空（避免全量扫表）。
 */
function search(query, { limit = 8 } = {}) {
  const tokens = [...new Set(tokenize(query))]
  if (!tokens.length) return []

  const rows = db
    .all(
      `SELECT d.id, d.kb_id, d.title, d.content, kb.name AS kb_name
       FROM knowledge_docs d JOIN knowledge_bases kb ON kb.id = d.kb_id
       LIMIT ${MAX_DOCS_SCAN}`,
    )
    .map((r) => {
      const title = String(r.title || '').toLowerCase()
      const content = String(r.content || '').toLowerCase()
      let score = 0
      let hits = 0
      for (const tk of tokens) {
        const inTitle = countOccurrences(title, tk)
        const inBody = countOccurrences(content, tk)
        if (inTitle || inBody) hits++
        score += inTitle * 5 + inBody
      }
      // 命中词覆盖率高加分（3 个词里中 2 个比只中 1 个强）
      score *= 1 + hits / tokens.length
      return { row: r, score, content: String(r.content || '') }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))

  return rows.map(({ row, score, content }) => ({
    kbId: row.kb_id,
    kbName: row.kb_name,
    docId: row.id,
    title: row.title,
    score: Math.round(score * 100) / 100,
    excerpt: excerptOf(content, tokens),
  }))
}

/**
 * 给提示词注入用的上下文。取前 3 篇，每篇片段封顶，总量封顶 maxChars。
 * 没有知识库 / 没命中 / 设置关掉时返回空串 —— 调用方直接跳过拼接。
 */
function contextFor(query, { maxChars = 2400, kbIds = null } = {}) {
  const count = db.get('SELECT COUNT(*) AS n FROM knowledge_docs')
  if (!count || !count.n) return ''
  const hits = search(query, { limit: 3 })
  const filtered = kbIds ? hits.filter((h) => kbIds.includes(h.kbId)) : hits
  if (!filtered.length) return ''

  const parts = []
  let used = 0
  for (const h of filtered) {
    const piece = `【${h.title}】（知识库：${h.kbName}）\n${h.excerpt}`
    if (used + piece.length > maxChars) break
    parts.push(piece)
    used += piece.length
  }
  if (!parts.length) return ''
  return ['## 知识库参考资料', '下面是与任务相关的本地知识库片段，供参考；与任务无关就忽略：', '', ...parts].join('\n')
}

function summary() {
  const kb = db.get('SELECT COUNT(*) AS n FROM knowledge_bases')
  const doc = db.get('SELECT COUNT(*) AS n FROM knowledge_docs')
  return { bases: kb?.n || 0, docs: doc?.n || 0 }
}

module.exports = {
  listKbs,
  getKb,
  createKb,
  updateKb,
  deleteKb,
  listDocs,
  addDoc,
  updateDoc,
  deleteDoc,
  importKb,
  exportKb,
  search,
  contextFor,
  summary,
  _private: { tokenize },
}
