/**
 * 确认协议（步骤④）：把用户一条消息的「1y 2n 3改…」标注，套到偏好卡上。
 *
 * 语义：
 *  - `Ny` 采纳字段 N；
 *  - `Nn` 不采纳字段 N；
 *  - `N改:新结论` 采纳字段 N 但用手写结论替换；
 *  - 未提及的字段 = 不写入。
 * 字段顺序固定（1-based）：1 称呼/语气、2 回复长度、3 格式化、4 话题领域、5 被纠正过的点、6 对思考过程。
 */

export const FIELD_ORDER = ['appellation', 'verbosity', 'formatting', 'topics', 'corrections', 'thinkingAttitude']

/**
 * 解析标注文本，返回 { [1-based 序号]: { op: 'y'|'n'|'change', text? } }
 * 例："1y 2n 3改:网络安全 4y" → { 1:{op:'y'}, 2:{op:'n'}, 3:{op:'change',text:'网络安全'}, 4:{op:'y'} }
 */
export function parseAnnotations(text) {
  const result = {}
  const re = /(\d+)\s*(y|n|改)(?:\s*[:：]\s*([^\s]+))?/g
  let m
  while ((m = re.exec(text)) !== null) {
    const idx = Number(m[1])
    const op = m[2]
    const val = m[3] ?? ''
    // 「改」但没给文本 → 按 n（不写入）处理
    result[idx] = op === 'y' ? { op: 'y' } : op === 'n' ? { op: 'n' } : val ? { op: 'change', text: val } : { op: 'n' }
  }
  return result
}

/**
 * 把标注套到卡片上，返回只含已确认字段的新卡片。
 * - `n` / 未提及 → 字段被移除；
 * - `y` → 原样保留；
 * - `change` → value.manualText 置为手写结论（renderBlockContent 优先渲染它）。
 */
export function applyConfirmation(card, annotations) {
  const out = { ...card, fields: {} }
  FIELD_ORDER.forEach((key, i) => {
    const a = annotations[i + 1]
    if (!a || a.op === 'n') return
    const field = { ...card.fields[key] }
    if (a.op === 'change') field.value = { ...field.value, manualText: a.text }
    out.fields[key] = field
  })
  return out
}
