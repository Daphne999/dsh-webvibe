/**
 * 真实数据试跑入口：fetch → parse → extract → render。
 *
 * 原则：
 *  - 全程在内存里流转，**不落盘任何中间产物**（不存原始响应、不存解析结果、不存卡片 JSON）；
 *  - 只写出**最终给人看的 Markdown 卡片**；
 *  - 任何一步失败就**原样抛出**，不降级、不跳过；
 *  - 不在日志里打印 share_id 或原始链接。
 *
 * 用法：
 *   node lib/run-real.mjs --out <目录> --name 普通 <链接或 id> --name 思考 <链接或 id> ...
 */

import fs from 'node:fs'
import path from 'node:path'

import { fetchShareContent, redactShareId, extractShareId } from './fetch-share.mjs'
import { parseShareContent } from './parse-share.mjs'
import { extractPreferences } from './preferences.mjs'
import { renderCardMarkdown } from './render-card.mjs'

function parseArgs(argv) {
  const out = { jobs: [], caveats: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--out') out.dir = argv[++i]
    else if (a === '--provenance') out.provenance = argv[++i]
    else if (a === '--caveat-fields') {
      const fields = String(argv[++i]).split(',').map((s) => s.trim()).filter(Boolean)
      const note = argv[++i]
      out.caveats.push({ fields, note })
    } else if (a === '--name') {
      const name = argv[++i]
      const input = argv[++i]
      out.jobs.push({ name, input })
    } else throw new Error(`不认识的参数：${a}`)
  }
  if (!out.dir) throw new Error('缺少 --out <目录>')
  if (out.jobs.length === 0) throw new Error('至少需要一个 --name <标签> <链接>')
  return out
}

const args = parseArgs(process.argv.slice(2))
fs.mkdirSync(args.dir, { recursive: true })

const log = (msg) => console.log(msg)
const report = []

for (const [i, job] of args.jobs.entries()) {
  // 只打印脱敏后的 id，绝不打印原始链接
  let id = '<invalid>'
  try {
    id = redactShareId(extractShareId(job.input))
  } catch {
    /* 交给下面统一抛 */
  }
  log(`\n[${i + 1}/${args.jobs.length}] 标签=${job.name} id=${id} 开始`)

  // ① fetch —— 失败原样抛出
  const raw = await fetchShareContent(job.input)
  log(`  ✓ fetch：拿到响应（${JSON.stringify(raw).length} 字节）`)

  // ② parse
  const conv = parseShareContent(raw)
  const counts = conv.messages.reduce((acc, m) => {
    for (const b of m.blocks) acc[b.type] = (acc[b.type] || 0) + 1
    return acc
  }, {})
  const fmt = ['text', 'thinking', 'search', 'tip', 'file'].map((k) => `${k}=${counts[k] || 0}`).join(' ')
  log(`  ✓ parse：${conv.messages.length} 条消息，块 ${fmt}`)
  if (conv.warnings.length) log(`    warnings: ${conv.warnings.map((w) => w.code).join(', ')}`)

  // ③ extract
  const card = extractPreferences(conv, { caveats: args.caveats, provenance: args.provenance })
  const conf = Object.entries(card.fields)
    .map(([k, v]) => `${k}=${v.confidence}`)
    .join(' ')
  log(`  ✓ extract：${conf}`)

  // ④ render（唯一落盘的东西）
  const md = renderCardMarkdown(card)
  const file = path.join(args.dir, `偏好卡-${job.name}.md`)
  fs.writeFileSync(file, md)
  const lines = md.split('\n').length
  log(`  ✓ render：${file}（${lines} 行 / ${Buffer.byteLength(md)} 字节）`)

  report.push({ name: job.name, id, messages: conv.messages.length, lines, bytes: Buffer.byteLength(md), conf })
}

log('\n=== 汇总 ===')
for (const r of report) {
  log(`${r.name}: 消息 ${r.messages} ｜ 卡片 ${r.lines} 行 / ${r.bytes} 字节 ｜ ${r.conf}`)
}
log('\n中间产物：未落盘（原始响应、解析结果、卡片 JSON 均只在内存里）')
