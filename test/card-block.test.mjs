/**
 * 托管区块的只读演练测试：标记配对 / 撤销 / 手改冲突 三条路径。
 * 全部在临时目录里跑，绝不碰 ~/.dsh/AGENTS.md。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MARK_BEGIN,
  MARK_END,
  BLOCK_CODES,
  BlockError,
  renderBlockContent,
  collectQuotes,
  locateBlock,
  planWrite,
  planUndo,
  applyBlock,
  lineDiff,
} from '../scripts/card-block.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

/** 构造好的一张"已确认"卡（含引文，用于验证区块不带引文）——从 fixture 读，单一来源 */
function makeCard() {
  return JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures', 'preference-card.confirmed.json'), 'utf8'))
}

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'webvibe-rehearsal-'))

// ───────────────── 路径一：标记配对 ─────────────────

test('标记配对①：文件里没有区块 → append，且只出现一对标记', () => {
  const plan = planWrite('# 我的笔记\n\n原文第一行\n', makeCard())
  assert.equal(plan.action, 'append')
  assert.equal(plan.nextText.split(MARK_BEGIN).length - 1, 1)
  assert.equal(plan.nextText.split(MARK_END).length - 1, 1)
  assert.ok(plan.nextText.startsWith('# 我的笔记'), '原有内容必须保留在最前')
  assert.ok(plan.nextText.indexOf(MARK_BEGIN) > plan.nextText.indexOf('原文第一行'))
})

test('标记配对②：已有区块 → replace，原有其它内容不动', () => {
  const first = planWrite('前言\n', makeCard())
  const second = planWrite(first.nextText, makeCard())
  assert.equal(second.action, 'replace')
  assert.equal(second.nextText.split(MARK_BEGIN).length - 1, 1, '不得出现第二个区块')
  assert.ok(second.nextText.includes('前言'))
})

test('标记配对③：只有开始标记 / 只有结束标记 / 顺序颠倒 / 重复 → 各自报错', () => {
  const cases = [
    [`前言\n${MARK_BEGIN}\n内容\n`, BLOCK_CODES.MARK_UNPAIRED],
    [`前言\n内容\n${MARK_END}\n`, BLOCK_CODES.MARK_UNPAIRED],
    [`前言\n${MARK_END}\n中\n${MARK_BEGIN}\n`, BLOCK_CODES.MARK_ORDER],
    [`${MARK_BEGIN}\na\n${MARK_END}\n${MARK_BEGIN}\nb\n${MARK_END}\n`, BLOCK_CODES.MARK_DUPLICATE],
  ]
  for (const [text, code] of cases) {
    try {
      locateBlock(text)
      assert.fail('应当报错')
    } catch (err) {
      assert.ok(err instanceof BlockError)
      assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}`)
    }
  }
})

test('标记配对④：幂等 —— 同一张卡连写两次，文件不变', () => {
  const once = planWrite('前言\n', makeCard())
  const twice = planWrite(once.nextText, makeCard())
  assert.equal(twice.nextText, once.nextText)
  assert.equal(twice.blockHash, once.blockHash)
})

// ───────────────── 区块内容纪律 ─────────────────

test('区块内容只带结论与置信度，不带任何原文引文', () => {
  const card = makeCard()
  const content = renderBlockContent(card)
  assert.ok(content.includes('置信度'))
  for (const q of collectQuotes(card)) {
    assert.equal(content.includes(q), false, `引文泄漏到区块：${q}`)
  }

  // 渲染纪律①：置信度 none 的字段整行省略
  const withNone = makeCard()
  withNone.fields.appellation.confidence = 'none'
  const c2 = renderBlockContent(withNone)
  assert.equal(c2.includes('称呼与语气'), false, 'none 置信度的字段必须整行省略')
  assert.equal(/（未出现[^）]*）（置信度/.test(c2), false, '不得出现重复括号套娃')

  // 渲染纪律②：列表使用率必须标明是"样本特征"，不能写成用户要求
  assert.match(content, /AI 侧 \d+\/\d+ 条回答使用列表（样本特征，非用户要求）/)
  // 排版纪律：不得出现「…）（置信度」这种双括号
  assert.equal(/）\s*（置信度/.test(content), false, '不得出现连续括号')
})

test('防御：若内容里混进引文 → 拒绝写入（QUOTE_LEAK）', () => {
  const card = makeCard()
  // 人为把一条引文塞进 value 的 label 里，模拟上游 bug
  card.fields.corrections.value[0].label = '构造引文丁：被判成纠正的句子'
  try {
    planWrite('', card)
    assert.fail('应当拦下含引文的区块')
  } catch (err) {
    // 引文被塞进 label 后会被渲染进内容，必须被 QUOTE_LEAK 拦住
    assert.equal(err.code, BLOCK_CODES.QUOTE_LEAK)
  }
})

// ───────────────── 路径二：撤销 ─────────────────

test('撤销①：写入后再撤销，文本回到写入前（逐字节，含末尾换行归一）', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'notes.rehearsal.md')
  const before = '# 原文\n\n第一段\n'
  fs.writeFileSync(file, before, 'utf8')

  const res = applyBlock(file, makeCard(), { dryRun: false, allowRealWrite: true })
  assert.equal(res.written, true)

  const afterWrite = fs.readFileSync(file, 'utf8')
  const undo = planUndo(afterWrite, res.record)
  assert.equal(undo.ok, true, undo.reason)

  fs.writeFileSync(file, undo.nextText, 'utf8')
  assert.equal(fs.readFileSync(file, 'utf8'), before, '撤销后必须与写入前完全一致')
})

test('撤销②：撤销后文件里不再有托管标记', () => {
  const plan = planWrite('前言\n', makeCard())
  const undo = planUndo(plan.nextText, { afterWriteHash: plan.beforeHash === plan.beforeHash ? undefined : undefined, afterWriteText: plan.nextText })
  // 不给 record 的 hash → 跳过手改检测，直接按区块删除
  assert.equal(undo.ok, true)
  assert.equal(undo.nextText.includes(MARK_BEGIN), false)
  assert.equal(undo.nextText.includes(MARK_END), false)
})

// ───────────────── 路径三：手改冲突 ─────────────────

test('手改冲突①：写入后用户改了别处 → 拒绝自动撤销并给出 diff', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'notes2.rehearsal.md')
  fs.writeFileSync(file, '# 原文\n', 'utf8')

  const res = applyBlock(file, makeCard(), { dryRun: false, allowRealWrite: true })

  // 模拟用户手改：在文件末尾加一行
  const edited = fs.readFileSync(file, 'utf8') + '\n用户后来加的一行\n'
  fs.writeFileSync(file, edited, 'utf8')

  const undo = planUndo(fs.readFileSync(file, 'utf8'), res.record)
  assert.equal(undo.ok, false)
  assert.equal(undo.code, BLOCK_CODES.MANUAL_EDIT)
  assert.match(undo.reason, /被改动过/)
  assert.ok(Array.isArray(undo.diff) && undo.diff.length > 0, '必须输出 diff')
  assert.ok(undo.diff.some((l) => l.includes('用户后来加的一行')), 'diff 要指认出用户改的那行')
})

test('手改冲突②：文件被清空 → 拒绝撤销（区块已不在）', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'notes3.rehearsal.md')
  fs.writeFileSync(file, '', 'utf8')
  const res = applyBlock(file, makeCard(), { dryRun: false, allowRealWrite: true })
  fs.writeFileSync(file, '', 'utf8')

  const undo = planUndo('', res.record)
  assert.equal(undo.ok, false)
  // 清空会先触发手改检测（hash 变了）
  assert.ok([BLOCK_CODES.MANUAL_EDIT, BLOCK_CODES.BLOCK_MISSING].includes(undo.code))
})

// ───────────────── 写盘闸门（只读演练的护栏） ─────────────────

test('写盘闸门①：默认 dry-run，不产生任何文件', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'never-created.md')
  const res = applyBlock(file, makeCard(), {})
  assert.equal(res.written, false)
  assert.equal(fs.existsSync(file), false)
})

test('写盘闸门②：没有 allowRealWrite 就拒绝写盘', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'x.rehearsal.md')
  assert.throws(() => applyBlock(file, makeCard(), { dryRun: false }), (e) => e.code === BLOCK_CODES.REAL_WRITE_BLOCKED)
})

test('写盘闸门③：演练阶段只允许 *.rehearsal.md', () => {
  const dir = tmpdir()
  const file = path.join(dir, 'AGENTS.md')
  assert.throws(
    () => applyBlock(file, makeCard(), { dryRun: false, allowRealWrite: true }),
    (e) => e.code === BLOCK_CODES.REAL_WRITE_BLOCKED,
  )
})

test('lineDiff：能标出增/删/改三类', () => {
  const d = lineDiff('a\nb\nc', 'a\nB\nc\nd')
  assert.ok(d.some((l) => l.startsWith('~ 2:')), '改')
  assert.ok(d.some((l) => l.startsWith('+ 4:')), '增')
  const d2 = lineDiff('a\nb\nc', 'a\nc')
  assert.ok(d2.some((l) => l.startsWith('- ')), '删（按行号对齐，可能表现为后移）')
})
