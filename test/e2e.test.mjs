/**
 * 端到端（分发版）：合成 share@1 fixture → preference-card → 渲染 → 确认协议 → 写块计划。
 * 全部用合成 fixture（无真实聊天内容），网络无关。
 * 跑法：node --test --test-isolation=none test/e2e.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractPreferences } from '../scripts/preferences.mjs'
import { renderCardMarkdown } from '../scripts/render-card.mjs'
import { parseAnnotations, applyConfirmation } from '../scripts/confirm.mjs'
import { renderBlockContent, planWrite } from '../scripts/card-block.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const read = (p) => JSON.parse(fs.readFileSync(path.join(__dirname, p), 'utf8'))

test('confirm: parseAnnotations 解析 1y 2n 3改:网络安全 4y', () => {
  const a = parseAnnotations('1y 2n 3改:网络安全 4y')
  assert.deepEqual(a, {
    1: { op: 'y' },
    2: { op: 'n' },
    3: { op: 'change', text: '网络安全' },
    4: { op: 'y' },
  })
})

test('confirm: 「改」缺文本按 n 处理（不写入）', () => {
  const card = read('fixtures/preference-card.confirmed.json')
  const out = applyConfirmation(card, parseAnnotations('1改 2y'))
  assert.deepEqual(Object.keys(out.fields), ['verbosity'])
})

test('confirm: 全角冒号 3改：网络安全 也能解析', () => {
  const a = parseAnnotations('3改：网络安全')
  assert.deepEqual(a, { 3: { op: 'change', text: '网络安全' } })
})

test('confirm: 越界字段 7y 被忽略，不报错', () => {
  const card = read('fixtures/preference-card.confirmed.json')
  const out = applyConfirmation(card, parseAnnotations('7y 1y'))
  assert.deepEqual(Object.keys(out.fields), ['appellation'])
})

test('confirm: applyConfirmation 只留 y/改，改字段手动覆盖并写进区块', () => {
  const card = read('fixtures/preference-card.confirmed.json')
  const out = applyConfirmation(card, parseAnnotations('1y 2n 4改:网络安全 6y'))
  assert.deepEqual(Object.keys(out.fields).sort(), ['appellation', 'thinkingAttitude', 'topics'])
  assert.equal(out.fields.topics.value.manualText, '网络安全')
  const block = renderBlockContent(out)
  assert.ok(block.includes('网络安全'))
  assert.ok(!block.includes('学习考试'))
})

test('e2e 合成件：share@1 → 卡 → 确认 → 区块 → 写计划', () => {
  const conv = read('fixtures/synthetic-share.json')
  const card = extractPreferences(conv, { provenance: '合成 fixture' })
  assert.ok(card.fields, 'card.fields 存在')
  const md = renderCardMarkdown(card)
  assert.ok(md.length > 0, '渲染出卡片 markdown')
  const confirmed = applyConfirmation(card, parseAnnotations('1y 2y 3y 4y 5y 6y'))
  const block = renderBlockContent(confirmed)
  assert.ok(block.includes('<!-- dsh-webvibe:begin v1 -->'), '区块带 begin 标记')
  const plan = planWrite('', confirmed)
  assert.equal(plan.action, 'append')
  assert.ok(plan.nextText.includes('<!-- dsh-webvibe:begin v1 -->'))
})
