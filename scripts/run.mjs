#!/usr/bin/env node
/**
 * dsh-webvibe 单一入口 CLI。
 *
 * 用法：
 *   node run.mjs check                                    # 自测（合成 fixture，离线）
 *   node run.mjs from <分享链接或 share_id> [--out <card.json>]   # fetch→parse→extract→render，输出卡片并保存 card.json
 *   node run.mjs --card <card.json> --confirm '<1y 2n 4改:…>'    # 套确认，出写块 diff（不写盘）
 *   node run.mjs --card <card.json> --confirm '<…>' --write      # 显式写盘 AGENTS.md
 *
 * 隐私：不打印原始链接/share_id；不落盘原始响应；卡片 JSON 只在本机。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fetchShareContent, extractShareId, redactShareId } from './fetch-share.mjs'
import { parseShareContent } from './parse-share.mjs'
import { extractPreferences } from './preferences.mjs'
import { renderCardMarkdown } from './render-card.mjs'
import { parseAnnotations, applyConfirmation } from './confirm.mjs'
import { renderBlockContent, planWrite, applyBlock } from './card-block.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AGENTS_PATH = process.env.DSH_HOME
  ? path.join(process.env.DSH_HOME, 'AGENTS.md')
  : path.join(os.homedir(), '.dsh', 'AGENTS.md')

function help() {
  console.log(`dsh-webvibe

用法：
  node run.mjs check                                    自测（合成 fixture，离线）
  node run.mjs from <链接或 share_id> [--out <card.json>]  五步到确认前：输出卡片 + 保存 card.json
  node run.mjs --card <card.json> --confirm '<标注>'      套确认，出写块 diff（不写盘）
  node run.mjs --card <card.json> --confirm '<标注>' --write  显式写盘 $DSH_HOME/AGENTS.md

标注格式：1y 2n 3改:新结论 …（y=采纳 n=不采纳 改=改后采纳；未提及不写入）`)
}

/** 自测：合成 share@1 跑全流程 + 确认协议边界 */
function runCheck() {
  const dir = path.join(__dirname, '..', 'test', 'fixtures')
  const conv = JSON.parse(fs.readFileSync(path.join(dir, 'synthetic-share.json'), 'utf8'))
  const card = extractPreferences(conv, { provenance: '合成 fixture' })
  const md = renderCardMarkdown(card)
  const confirmed = applyConfirmation(card, parseAnnotations('1y 2y 3y 4y 5y 6y'))
  const block = renderBlockContent(confirmed)
  const plan = planWrite('', confirmed)
  if (!md || !block.includes('<!-- dsh-webvibe:begin v1 -->') || plan.action !== 'append') {
    throw new Error('合成 share@1 全流程失败')
  }
  // 确认协议边界：「改」缺文本 → n
  const pc = JSON.parse(fs.readFileSync(path.join(dir, 'preference-card.confirmed.json'), 'utf8'))
  const nc = applyConfirmation(pc, parseAnnotations('1改'))
  if (Object.keys(nc.fields).length !== 0) throw new Error('「改」缺文本未按 n 处理')
  console.log('check PASS: 合成 share@1 全流程 + 确认协议边界通过')
}

async function runFrom(input, outPath) {
  let id = '<invalid>'
  try { id = redactShareId(extractShareId(input)) } catch { /* 交给下面统一抛 */ }
  process.stderr.write(`[fetch] ${id}\n`)
  const raw = await fetchShareContent(input)
  const conv = parseShareContent(raw)
  const card = extractPreferences(conv, { provenance: '真实用户语料' })
  const md = renderCardMarkdown(card)
  const out = outPath || '.webvibe-card.json'
  fs.writeFileSync(out, JSON.stringify(card, null, 1) + '\n', 'utf8')
  process.stdout.write(md + '\n')
  process.stderr.write(`\n[卡已保存] ${out} ｜ 回 y/n/改 后：node run.mjs --card ${out} --confirm '<标注>' [--write]\n`)
}

function runConfirm(cardPath, annText, doWrite) {
  const card = JSON.parse(fs.readFileSync(cardPath, 'utf8'))
  const annotations = parseAnnotations(annText)
  if (Object.keys(annotations).length === 0) throw new Error(`标注解析为空：${annText}`)
  const confirmed = applyConfirmation(card, annotations)
  const block = renderBlockContent(confirmed)
  const existing = fs.existsSync(AGENTS_PATH) ? fs.readFileSync(AGENTS_PATH, 'utf8') : ''
  const plan = planWrite(existing, confirmed)
  process.stdout.write('=== 写块内容 ===\n' + block + '\n')

  if (!doWrite) {
    process.stderr.write(`\n[dry-run] 未写盘。确认无误后加 --write。\n`)
    return
  }
  const result = applyBlock(AGENTS_PATH, confirmed, { allowRealWrite: true, dryRun: false, rehearsalPathRequired: false })
  process.stderr.write(`\n[已写入] ${AGENTS_PATH}（${result.written ? 'written' : 'dry'}）\n已写入，下一次对话即生效（无需 /new）。\n`)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') { help(); return }
  if (argv[0] === 'check') { runCheck(); return }
  if (argv[0] === 'from') {
    let out = null
    for (let i = 2; i < argv.length; i++) { if (argv[i] === '--out') out = argv[++i]; else throw new Error(`不认识的参数：${argv[i]}`) }
    if (!argv[1]) throw new Error('缺少分享链接')
    await runFrom(argv[1], out)
    return
  }
  // --card ... --confirm ... [--write]
  let cardPath = null, ann = null, doWrite = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--card') cardPath = argv[++i]
    else if (a === '--confirm') ann = argv[++i]
    else if (a === '--write') doWrite = true
    else throw new Error(`不认识的参数：${a}`)
  }
  if (!cardPath) throw new Error('缺少 --card <card.json>')
  if (ann == null) throw new Error('缺少 --confirm <标注>')
  runConfirm(cardPath, ann, doWrite)
}

main().catch((err) => { process.stderr.write(`错误：${err.message}\n`); process.exitCode = 1 })
