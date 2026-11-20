/**
 * 托管区块的写入 / 撤销 / 冲突检测（阶段 3b 第一步：只读演练用）。
 *
 * 规范（已定死）：
 *  - 起止标记：`<!-- dsh-webvibe:begin v1 -->` … `<!-- dsh-webvibe:end -->`
 *  - 区块内容：**只带字段结论 + 置信度**，**不带任何原文引文**（引文留在本机卡片）
 *  - 写前记录文件 hash；写后记录 hash
 *  - 撤销 = 删除区块；若当前文件 hash ≠ 写后 hash（说明用户手改过），**拒绝自动撤销并输出 diff**
 *  - 标记不成对 / 重复 / 顺序颠倒 → 直接报错，不写
 */

import fs from 'node:fs'
import crypto from 'node:crypto'

export const MARK_BEGIN = '<!-- dsh-webvibe:begin v1 -->'
export const MARK_END = '<!-- dsh-webvibe:end -->'

export class BlockError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'BlockError'
    this.code = code
    this.detail = detail
  }
}

export const BLOCK_CODES = {
  MARK_UNPAIRED: 'MARK_UNPAIRED',
  MARK_DUPLICATE: 'MARK_DUPLICATE',
  MARK_ORDER: 'MARK_ORDER',
  MANUAL_EDIT: 'MANUAL_EDIT',
  BLOCK_MISSING: 'BLOCK_MISSING',
  QUOTE_LEAK: 'QUOTE_LEAK',
  REAL_WRITE_BLOCKED: 'REAL_WRITE_BLOCKED',
}

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')

/** 归一化：把 CRLF 变 LF，只用于比较与写入 */
const norm = (s) => s.replace(/\r\n/g, '\n')

/**
 * 把偏好卡渲染成**区块内容**：只有结论与置信度，没有引文。
 * 两条渲染纪律（2026-11-18 按用户要求修订）：
 *  1. **置信度 none 的字段整行省略**——那是"没有素材"，写进去只会给模型模糊印象；
 *  2. **区分"样本特征"与"用户要求"**——例如列表使用率是 AI 侧行为，不能写成用户偏好。
 * @param {object} card preference-card@1
 */
export function renderBlockContent(card) {
  const f = card.fields
  const entries = []

  const push = (label, text, conf) => {
    if (conf === 'none') return // ① 没素材就不写
    // 结尾已有右括号时不再套一层，避免「…（非用户要求）（置信度 medium）」这种双括号
    const suffix = text.endsWith('）') ? `，置信度 ${conf}` : `（置信度 ${conf}）`
    entries.push(`- ${label}：${text}${suffix}`)
  }

  // 「改」的字段：用户手写结论（value.manualText）优先于自动提炼，直接渲染，不带置信度
  const manual = (key, label) => {
    const v = f[key]?.value
    if (v && typeof v === 'object' && v.manualText != null) {
      entries.push(`- ${label}：${v.manualText}`)
      return true
    }
    return false
  }

  if (!manual('appellation', '称呼与语气')) {
    const appellation = f.appellation?.value
    if (appellation) {
      const forms = appellation.forms?.length ? appellation.forms.map((x) => x.form).join('、') : '未出现称呼词'
      push('称呼与语气', `${appellation.tone}；称呼：${forms}`, f.appellation.confidence)
    }
  }

  if (!manual('verbosity', '回复长度')) {
    const verbosity = f.verbosity?.value
    if (verbosity) {
      push('回复长度', `${verbosity.style}；提问字数中位数 ${verbosity.userMedianChars ?? '—'}`, f.verbosity.confidence)
    }
  }

  if (!manual('formatting', '格式化')) {
    const fmtAssist = f.formatting?.value?.assistant
    if (fmtAssist && fmtAssist.samples > 0) {
      // ② 明确标成"样本特征"，不冒充用户要求
      const fence = fmtAssist.withCodeFence > 0 ? `，代码块 ${fmtAssist.withCodeFence}/${fmtAssist.samples}` : ''
      push('格式化', `AI 侧 ${fmtAssist.withList}/${fmtAssist.samples} 条回答使用列表（样本特征，非用户要求）${fence}`, f.formatting.confidence)
    }
  }

  if (!manual('topics', '话题领域')) {
    const topics = (f.topics?.value ?? []).filter((t) => t.evidenceLevel !== 'synthetic-only')
    if (topics.length) {
      push('话题领域', topics.map((t) => t.topic).join('、'), f.topics.confidence)
    }
  }

  if (!manual('corrections', '纠正偏好')) {
    const corrections = f.corrections?.value ?? []
    if (corrections.length) {
      push('纠正偏好', `${corrections.length} 处，类型：${[...new Set(corrections.map((c) => c.label))].join('、')}`, f.corrections.confidence)
    }
  }

  if (!manual('thinkingAttitude', '对思考过程')) {
    const think = f.thinkingAttitude?.value
    if (think) {
      push('对思考过程', `${think.attitude}；带思考的回答占比 ${think.thinkingRatioPercent ?? '—'}%`, f.thinkingAttitude.confidence)
    }
  }

  const body = entries.length ? entries : ['- （本轮没有足够素材形成结论）']

  const lines = [
    MARK_BEGIN,
    '## 对话偏好（由 dsh-webvibe 生成，已由用户确认；无引文，仅结论）',
    '',
    ...body,
    '',
    `> 本区块由工具维护，手工修改可能导致撤销检测失败。生成于 ${card.provenance ?? '本机偏好卡'}。`,
    MARK_END,
  ]
  return lines.join('\n')
}

/** 收集卡片里所有引文（用于"内容不得含引文"的自检） */
export function collectQuotes(card) {
  const quotes = []
  for (const f of Object.values(card.fields)) {
    for (const e of f.evidence ?? []) if (e.quote) quotes.push(e.quote)
    if (Array.isArray(f.value)) for (const v of f.value) if (v.quote) quotes.push(v.quote)
  }
  return quotes
}

/** 标出区块位置；标记不成对/重复/顺序错都报错 */
export function locateBlock(text) {
  const t = norm(text)
  const beginIdx = []
  const endIdx = []
  let i = 0
  while ((i = t.indexOf(MARK_BEGIN, i)) !== -1) {
    beginIdx.push(i)
    i += MARK_BEGIN.length
  }
  i = 0
  while ((i = t.indexOf(MARK_END, i)) !== -1) {
    endIdx.push(i)
    i += MARK_END.length
  }

  if (beginIdx.length === 0 && endIdx.length === 0) return { present: false }
  if (beginIdx.length > 1 || endIdx.length > 1) {
    throw new BlockError(BLOCK_CODES.MARK_DUPLICATE, `区块标记重复：begin ${beginIdx.length} 个、end ${endIdx.length} 个`, {
      begin: beginIdx.length,
      end: endIdx.length,
    })
  }
  if (beginIdx.length !== 1 || endIdx.length !== 1) {
    throw new BlockError(BLOCK_CODES.MARK_UNPAIRED, '区块标记不成对', { begin: beginIdx.length, end: endIdx.length })
  }
  if (endIdx[0] < beginIdx[0]) {
    throw new BlockError(BLOCK_CODES.MARK_ORDER, '结束标记出现在开始标记之前', { begin: beginIdx[0], end: endIdx[0] })
  }
  return { present: true, start: beginIdx[0], end: endIdx[0] + MARK_END.length }
}

/**
 * 计算写入计划（纯函数，不碰磁盘）。
 * @returns {{action:'append'|'replace', nextText:string, beforeHash:string, blockHash:string}}
 */
export function planWrite(existingText, card) {
  const content = renderBlockContent(card)

  // 自检：区块内容不得包含卡片里的任何引文
  for (const q of collectQuotes(card)) {
    const probe = q.replace(/\s+/g, ' ').trim()
    if (probe.length >= 8 && content.includes(probe)) {
      throw new BlockError(BLOCK_CODES.QUOTE_LEAK, '区块内容里出现了原文引文，拒绝写入', { quote: probe.slice(0, 20) })
    }
  }

  const text = norm(existingText ?? '')
  const beforeHash = sha(text)
  const located = locateBlock(text)

  let nextText
  let action
  if (!located.present) {
    action = 'append'
    const sep = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n'
    nextText = text + (text.length === 0 ? '' : sep) + content + '\n'
  } else {
    action = 'replace'
    nextText = text.slice(0, located.start) + content + text.slice(located.end)
    if (!nextText.endsWith('\n')) nextText += '\n'
  }

  return { action, nextText, beforeHash, blockHash: sha(content), content }
}

/** 撤销计划：删掉区块，恢复其余内容 */
export function planUndo(currentText, record) {
  const text = norm(currentText ?? '')
  const currentHash = sha(text)

  if (record?.afterWriteHash && currentHash !== record.afterWriteHash) {
    return {
      ok: false,
      code: BLOCK_CODES.MANUAL_EDIT,
      reason: '文件在写入之后被改动过，拒绝自动撤销',
      diff: lineDiff(record.afterWriteText ?? '', text),
      currentHash,
      expectedHash: record.afterWriteHash,
    }
  }

  let located
  try {
    located = locateBlock(text)
  } catch (err) {
    return { ok: false, code: err.code ?? BLOCK_CODES.BLOCK_MISSING, reason: err.message }
  }
  if (!located.present) return { ok: false, code: BLOCK_CODES.BLOCK_MISSING, reason: '文件里没有托管区块' }

  // 删掉区块，并收敛它留下的一处空行
  let next = text.slice(0, located.start) + text.slice(located.end)
  next = next.replace(/\n{3,}/g, '\n\n')
  return { ok: true, nextText: next.replace(/\n+$/, '\n'), removedBlockHash: sha(text.slice(located.start, located.end)) }
}

/** 极简逐行 diff（够人看懂"哪里被改了"即可） */
export function lineDiff(before, after) {
  const a = norm(before).split('\n')
  const b = norm(after).split('\n')
  const out = []
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i++) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined && b[i] === undefined) out.push(`- ${i + 1}: ${a[i]}`)
    else if (a[i] === undefined && b[i] !== undefined) out.push(`+ ${i + 1}: ${b[i]}`)
    else out.push(`~ ${i + 1}: ${a[i]}  →  ${b[i]}`)
    if (out.length >= 40) {
      out.push('…（diff 已截断）')
      break
    }
  }
  return out
}

/**
 * 应用到磁盘。**默认 dry-run**：只返回计划，不写。
 * 真正写盘必须显式传 allowRealWrite，并且目标必须是 .rehearsal 路径或已确认。
 */
export function applyBlock(filePath, card, { allowRealWrite = false, dryRun = true, rehearsalPathRequired = true } = {}) {
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : ''
  const plan = planWrite(existing, card)

  if (dryRun) return { ...plan, written: false, filePath }

  if (!allowRealWrite) {
    throw new BlockError(BLOCK_CODES.REAL_WRITE_BLOCKED, '未授予 allowRealWrite，拒绝写盘', { filePath })
  }
  if (rehearsalPathRequired && !filePath.endsWith('.rehearsal.md')) {
    throw new BlockError(BLOCK_CODES.REAL_WRITE_BLOCKED, '演练阶段只允许写 *.rehearsal.md', { filePath })
  }

  fs.writeFileSync(filePath, plan.nextText, 'utf8')
  return {
    ...plan,
    written: true,
    filePath,
    record: { filePath, beforeHash: plan.beforeHash, afterWriteHash: sha(plan.nextText), afterWriteText: plan.nextText, blockHash: plan.blockHash },
  }
}
