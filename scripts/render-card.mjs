/**
 * 把偏好卡草稿渲染成给人审的 Markdown。
 * 只做展示，不改任何值、不写任何配置。
 */

const FIELD_LABEL = {
  appellation: '称呼 / 语气偏好',
  verbosity: '回复长度习惯',
  formatting: '格式化偏好（列表 / 代码块）',
  topics: '话题领域',
  corrections: '被纠正过的点',
  thinkingAttitude: '对思考过程的态度',
}

const fmtValue = (v) => {
  if (v === null) return '_（无足够素材，见下方说明）_'
  if (Array.isArray(v)) return v.length === 0 ? '_（没有命中）_' : v.map((x) => '· ' + JSON.stringify(x)).join('\n')
  if (typeof v === 'object') return '```json\n' + JSON.stringify(v, null, 1) + '\n```'
  return String(v)
}

const fmtEvidence = (e) => {
  const where = `对话${e.conversation} · 第 ${e.messageIndex} 条 · 第 ${e.blockIndex} 块 · ${e.blockType}`
  if (e.quote) return `- ${where}：\`${e.quote}\``
  if (e.note) return `- ${where}：${e.note}${e.elapsedSecs != null ? `（耗时 ${e.elapsedSecs}s）` : ''}`
  return `- ${where}`
}

/**
 * @param {object} card extractPreferences 的返回值
 * @returns {string} Markdown
 */
export function renderCardMarkdown(card) {
  const lines = []
  lines.push('# 交互偏好卡（草稿，待人审）')
  lines.push('')
  lines.push('> 这是**草稿**：`reviewed = false`，不会自动生效，本阶段也不写任何配置。')
  lines.push('> 每条都附证据；没有证据的地方会显式写“无足够素材”，不做猜测。')
  lines.push('')
  lines.push(`- 卡片格式：\`${card.schema}\``)
  lines.push(`- 素材来源：${card.generatedFrom.conversations} 个对话 / ${card.generatedFrom.messages} 条消息 / text ${card.generatedFrom.textBlocks} 块 / thinking ${card.generatedFrom.thinkingBlocks} 块 / search ${card.generatedFrom.searchBlocks} 块`)
  if (card.provenance) {
    lines.push(`- 语料来源：**${card.provenance}**`)
  }
  lines.push('')

  if (Array.isArray(card.caveats) && card.caveats.length) {
    lines.push('## 校准说明（先读这个）')
    lines.push('')
    for (const c of card.caveats) {
      lines.push(`- 涉及字段：${(c.fields || []).join('、') || '（未指定）'}`)
      lines.push(`- 说明：${c.note}`)
    }
    lines.push('')
  }

  for (const [key, label] of Object.entries(FIELD_LABEL)) {
    const f = card.fields[key]
    lines.push(`## ${label}`)
    lines.push('')
    lines.push(`- 置信度：**${f.confidence}**`)
    if (f.note) lines.push(`- 说明：${f.note}`)
    lines.push('')
    lines.push(fmtValue(f.value))
    lines.push('')
    if (f.evidence && f.evidence.length) {
      lines.push('**证据**：')
      lines.push('')
      lines.push(f.evidence.map(fmtEvidence).join('\n'))
      lines.push('')
    } else {
      lines.push('**证据**：无')
      lines.push('')
    }
  }

  lines.push('## 来源类型分布（只统计，不含文案）')
  lines.push('')
  lines.push(`- 检索轮次：${card.sources.turnsWithSearch} ｜ 来源条数：${card.sources.totalResults}`)
  if (card.sources.byDomain.length) {
    lines.push('')
    lines.push('| 域名 | 条数 |')
    lines.push('| --- | --- |')
    for (const d of card.sources.byDomain) lines.push(`| ${d.domain} | ${d.count} |`)
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push(card.reminder)
  lines.push('')
  return lines.join('\n')
}
