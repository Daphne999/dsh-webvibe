#!/usr/bin/env node
/**
 * 生成合成 fixture：把一份真实 share@1 的正文全部替换成占位，只保留结构。
 * 用法：node make-synthetic.mjs <real.json> <synthetic.json>
 * 目的：仓库只放合成件（无真实聊天内容），本地用真实件校准。
 */
import fs from 'node:fs'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('用法：node make-synthetic.mjs <real.json> <synthetic.json>')
  process.exit(1)
}

const conv = JSON.parse(fs.readFileSync(input, 'utf8'))
let n = 0
for (const m of conv.messages) {
  for (const b of m.blocks) {
    if (b.type === 'text') {
      b.text = b.role === 'user' ? `[合成] 用户消息 ${++n}` : `[合成] 助手回答 ${++n}`
    } else if (b.type === 'thinking') {
      b.text = `[合成] 思考摘要 ${++n}`
    } else if (b.type === 'search' && Array.isArray(b.results)) {
      b.results = b.results.map((r, i) => ({
        url: `https://example.invalid/source-${i + 1}`,
        title: `[合成] 来源 ${i + 1}`,
        snippet: `[合成] 摘要 ${i + 1}`,
        siteName: `[合成] 站点 ${i + 1}`,
        publishedAt: r.publishedAt ?? null,
      }))
    }
  }
}
conv.conversation.title = null
conv.conversation.titleNote = '合成 fixture（正文已脱敏）'
if (conv.source) {
  conv.source.apiStatus = 'observed-from-frontend'
  conv.source.apiNote = '合成 fixture，仅用于测试结构'
}
fs.writeFileSync(output, JSON.stringify(conv, null, 1) + '\n', 'utf8')
console.log(`synthetic written: ${output}`)
