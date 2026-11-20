/**
 * 解析器与抓取层的测试。
 *
 * 全部用脱敏 fixture（test/fixtures/*.json），不联网。
 * 断言按"结构化结论"写，不匹配任何文案字符串（解析器本身也不依赖文案）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { parseShareContent, SCHEMA } from '../scripts/parse-share.mjs'
import { CODES, ShareParseError, ShareFetchError } from '../scripts/errors.mjs'
import { fetchShareContent, extractShareId, redactShareId } from '../scripts/fetch-share.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const fx = (name) => JSON.parse(readFileSync(join(HERE, 'fixtures', name + '.json'), 'utf8'))
const clone = (o) => JSON.parse(JSON.stringify(o))

/** 断言抛出某个 code */
function expectCode(fn, code) {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof ShareParseError || err instanceof ShareFetchError, '应抛自定义错误')
    assert.equal(err.code, code, `期望 ${code}，实际 ${err.code}：${err.message}`)
    return err
  }
  assert.fail(`没有抛错，期望 ${code}`)
}

// ───────────────────────── 三类正向解析 ─────────────────────────

test('普通对话：8 条消息，线性，无 THINK/SEARCH', () => {
  const out = parseShareContent(fx('normal'))
  assert.equal(out.schema, SCHEMA)
  assert.equal(out.conversation.messageCount, 8)
  assert.equal(out.messages.length, 8)
  assert.deepEqual(
    out.messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
  )
  for (const m of out.messages) {
    assert.equal(m.blocks.some((b) => b.type === 'thinking'), false)
    assert.equal(m.blocks.some((b) => b.type === 'search'), false)
    assert.ok(m.blocks.some((b) => b.type === 'text'))
  }
})

test('思考对话：ASSISTANT 带完整 thinking 块，且保留耗时', () => {
  const out = parseShareContent(fx('thinking'))
  const assistants = out.messages.filter((m) => m.role === 'assistant')
  assert.ok(assistants.length >= 1)
  for (const m of assistants) {
    const think = m.blocks.find((b) => b.type === 'thinking')
    assert.ok(think, '思考对话的每个回答都应有 thinking 块')
    assert.ok(think.text.length > 0, '思考内容是完整文本，不应为空')
    assert.equal(typeof think.elapsedSecs, 'number')
  }
  assert.equal(out.warnings.some((w) => w.code === 'THINK_NO_ELAPSED'), false)
})

test('联网对话：首轮带 search 块与结构化来源；某一轮没有 SEARCH 也不算错', () => {
  const out = parseShareContent(fx('search'))
  const assistants = out.messages.filter((m) => m.role === 'assistant')
  const withSearch = assistants.filter((m) => m.blocks.some((b) => b.type === 'search'))
  const withoutSearch = assistants.filter((m) => !m.blocks.some((b) => b.type === 'search'))

  assert.ok(withSearch.length >= 1, '至少有一轮带检索结果')
  assert.ok(withoutSearch.length >= 1, '已实测：联网对话里存在没有 SEARCH 的一轮')

  const s = withSearch[0].blocks.find((b) => b.type === 'search')
  assert.ok(Array.isArray(s.results) && s.results.length > 0)
  const r = s.results[0]
  for (const k of ['url', 'title', 'snippet', 'siteName', 'publishedAt']) {
    assert.ok(k in r, `来源字段 ${k} 应存在`)
  }
  assert.match(r.url, /^https?:\/\//)

  // 缺 SEARCH 的那一轮 → 产出 warning，而不是伪造空 search 块
  assert.ok(
    out.warnings.some((w) => w.code === 'SEARCH_TURN_WITHOUT_RESULTS'),
    '缺检索的一轮应产生 warning',
  )
})

test('标题与模型：拿不到就标 null + 原因，不假装有', () => {
  for (const name of ['normal', 'thinking', 'search']) {
    const out = parseShareContent(fx(name))
    assert.equal(out.conversation.title, null)
    assert.ok(out.conversation.titleNote)
    assert.equal(out.conversation.model, null)
    assert.ok(out.conversation.modelNote)
  }
})

test('接口来源声明：标注为非官方文档接口，且不绑定 bundle hash', () => {
  const out = parseShareContent(fx('normal'))
  assert.equal(out.source.apiStatus, 'observed-from-frontend')
  assert.match(out.source.apiNote, /非官方/)
  assert.equal(JSON.stringify(out.source).match(/main\.[a-f0-9]{6,}\.js/), null, '不应把 bundle 文件名写进结果')
})

test('时间戳：转成 ISO，且时间范围有序', () => {
  const out = parseShareContent(fx('normal'))
  for (const m of out.messages) assert.match(m.insertedAt, /^\d{4}-\d{2}-\d{2}T/)
  const { from, to } = out.conversation.timeRange
  assert.ok(Date.parse(from) <= Date.parse(to))
})

test('解析器不依赖文案：把正文全部换成任意字符串，结构结论不变', () => {
  const base = fx('thinking')
  const out1 = parseShareContent(base)

  const mutated = clone(base)
  let n = 0
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk)
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (typeof o[k] === 'string' && k === 'content') o[k] = 'ZZZ' + n++
        else walk(o[k])
      }
    }
  }
  walk(mutated.data.biz_data)
  const out2 = parseShareContent(mutated)

  assert.equal(out1.conversation.messageCount, out2.conversation.messageCount)
  assert.deepEqual(
    out1.messages.map((m) => m.blocks.map((b) => b.type)),
    out2.messages.map((m) => m.blocks.map((b) => b.type)),
  )
})

// ───────────────────────── 防御性校验（需求 7） ─────────────────────────

test('biz_code != 0 → BIZ_CODE_UNKNOWN，带出原始码', () => {
  const bad = clone(fx('normal'))
  bad.data.biz_code = 42
  const err = expectCode(() => parseShareContent(bad), CODES.BIZ_CODE_UNKNOWN)
  assert.equal(err.detail.bizCode, 42)
})

test('缺少 messages → SCHEMA_MISMATCH', () => {
  const bad = clone(fx('normal'))
  delete bad.data.biz_data.messages
  expectCode(() => parseShareContent(bad), CODES.SCHEMA_MISMATCH)
})

test('messages 为空 → EMPTY_CONVERSATION', () => {
  const bad = clone(fx('normal'))
  bad.data.biz_data.messages = []
  expectCode(() => parseShareContent(bad), CODES.EMPTY_CONVERSATION)
})

test('role 不是 USER/ASSISTANT → SCHEMA_MISMATCH', () => {
  const bad = clone(fx('normal'))
  bad.data.biz_data.messages[0].role = 'SYSTEM'
  expectCode(() => parseShareContent(bad), CODES.SCHEMA_MISMATCH)
})

test('inserted_at 类型不对 → SCHEMA_MISMATCH（不做猜测转换）', () => {
  const bad = clone(fx('normal'))
  bad.data.biz_data.messages[0].inserted_at = '2026-11-18'
  expectCode(() => parseShareContent(bad), CODES.SCHEMA_MISMATCH)
})

test('未知片段类型（仍未知的种类）→ UNSUPPORTED_FRAGMENT，护栏不许拆', () => {
  const bad = clone(fx('normal'))
  // 注意：FILE/TIP 已由加性扩展支持，这里改用**仍然未知**的类型来测护栏
  bad.data.biz_data.messages[1].fragments.push({ id: 99, type: 'VOICE', content: 'x' })
  const err = expectCode(() => parseShareContent(bad), CODES.UNSUPPORTED_FRAGMENT)
  assert.equal(err.detail.actual, 'VOICE')
})

test('分支对话（同一父节点多个子节点）→ UNSUPPORTED_BRANCHING，不静默平铺', () => {
  const bad = clone(fx('normal'))
  const msgs = bad.data.biz_data.messages
  // 复制第 2 条（assistant）挂到同一个 parent 上，制造分叉
  const dup = clone(msgs[1])
  dup.message_id = 'dup-child-1'
  msgs.push(dup)
  expectCode(() => parseShareContent(bad), CODES.UNSUPPORTED_BRANCHING)
})

test('父节点不在集合里 → SCHEMA_MISMATCH', () => {
  const bad = clone(fx('normal'))
  bad.data.biz_data.messages[1].parent_id = 'not-exist-id'
  expectCode(() => parseShareContent(bad), CODES.SCHEMA_MISMATCH)
})

// ───────────────────────── 抓取层（需求 5） ─────────────────────────

test('extractShareId：接受分享链接与裸 id，拒绝其他域名与非 /share 路径', () => {
  assert.equal(extractShareId('https://chat.deepseek.com/share/sampleid0000test1'), 'sampleid0000test1')
  assert.equal(extractShareId('sampleid0000test1'), 'sampleid0000test1')
  expectCode(() => extractShareId('https://evil.example.com/share/abcdefghijklmnop'), CODES.BAD_SHARE_ID)
  expectCode(() => extractShareId('https://chat.deepseek.com/chat/abcdefghijklmnop'), CODES.BAD_SHARE_ID)
  expectCode(() => extractShareId(''), CODES.BAD_SHARE_ID)
})

test('redactShareId：脱敏后不出现完整 id', () => {
  const id = 'sampleid0000test1'
  const r = redactShareId(id)
  assert.equal(r.includes(id), false)
})

test('抓取：不带 Cookie / Authorization，只请求一次', async () => {
  const calls = []
  const fake = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, text: async () => JSON.stringify(fx('normal')) }
  }
  const body = await fetchShareContent('sampleid0000test1', { fetchImpl: fake })

  assert.equal(calls.length, 1, '只应请求一次，不重试')
  const h = calls[0].init.headers
  const keys = Object.keys(h).map((k) => k.toLowerCase())
  assert.equal(keys.some((k) => k === 'cookie' || k === 'authorization'), false)
  assert.match(calls[0].url, /^https:\/\/chat\.deepseek\.com\/api\/v0\/share\/content\?share_id=/)
  assert.equal(body.data.biz_code, 0)
})

test('抓取失败：网络错误 / HTTP 非 200 / 非 JSON，分别给出可读错误且不含原始链接', async () => {
  const netErr = async () => {
    throw new Error('boom')
  }
  const e1 = await fetchShareContent('sampleid0000test1', { fetchImpl: netErr }).catch((e) => e)
  assert.equal(e1.code, CODES.NETWORK)

  const http500 = async () => ({ ok: false, status: 500, text: async () => '' })
  const e2 = await fetchShareContent('sampleid0000test1', { fetchImpl: http500 }).catch((e) => e)
  assert.equal(e2.code, CODES.HTTP_NOT_OK)
  assert.equal(e2.detail.status, 500)

  const html = async () => ({ ok: true, status: 200, text: async () => '<html>login</html>' })
  const e3 = await fetchShareContent('sampleid0000test1', { fetchImpl: html }).catch((e) => e)
  assert.equal(e3.code, CODES.SCHEMA_MISMATCH)

  for (const e of [e1, e2, e3]) {
    const blob = JSON.stringify({ m: e.message, d: e.detail })
    assert.equal(blob.includes('sampleid0000test1'), false, '错误信息里不得出现完整 share id')
  }
})

// ───────────── 思考摘要两种真实格式的解析回归（语料 C6 主谓式 / C7 动宾式） ─────────────

test('思考摘要两种格式都能原样解析成 thinking 块（解析器只搬运、不改写）', () => {
  const 主谓式 = '识别出对方在开玩笑，决定配合互动。'
  const 动宾式 = '思考如何回应一个玩笑式的请求。'

  for (const text of [主谓式, 动宾式]) {
    const raw = clone(fx('thinking'))
    const msg = raw.data.biz_data.messages.find((m) => m.fragments.some((f) => f.type === 'THINK'))
    msg.fragments.find((f) => f.type === 'THINK').content = text

    const out = parseShareContent(raw)
    const parsed = out.messages
      .flatMap((m) => m.blocks)
      .find((b) => b.type === 'thinking' && b.text === text)
    assert.ok(parsed, `格式未被原样保留：${text}`)

    const asText = out.messages.flatMap((m) => m.blocks).some((b) => b.type === 'text' && b.text === text)
    assert.equal(asText, false, '思考摘要不得变成 text 块')
  }
})

// ───────────── 加性扩展：TIP / FILE（同型构造数据，不含真实文件名） ─────────────

test('TIP → 定型块 {type:"tip", style, text}，且不进入提炼素材', async () => {
  const raw = clone(fx('normal'))
  const target = raw.data.biz_data.messages[1]
  target.fragments.push({ id: 501, type: 'TIP', style: 'bubble-hint', content: '（构造提示）这是一条提示气泡' })

  const out = parseShareContent(raw)
  const tip = out.messages.flatMap((m) => m.blocks).find((b) => b.type === 'tip')
  assert.ok(tip, '应解析出 tip 块')
  assert.equal(tip.style, 'bubble-hint')
  assert.equal(tip.text, '（构造提示）这是一条提示气泡')

  // 钉死：tip 不进入提炼素材
  const { extractPreferences } = await import('../scripts/preferences.mjs')
  const card = extractPreferences(out)
  assert.equal(JSON.stringify(card).includes('（构造提示）'), false, 'tip 文本不得进卡片')
  assert.equal(card.generatedFrom.textBlocks, out.messages.flatMap((m) => m.blocks).filter((b) => b.type === 'text').length)
})

test('FILE → 定型块 {type:"file", files:[{name,size,modelKind}]}，只有元数据且不进入提炼素材', async () => {
  const raw = clone(fx('normal'))
  const target = raw.data.biz_data.messages[0] // user 侧
  target.fragments.push({
    id: 601,
    type: 'FILE',
    files: [{ name: '构造附件-A.pdf', size: 12345, model_kind: 'document' }],
  })

  const out = parseShareContent(raw)
  const file = out.messages.flatMap((m) => m.blocks).find((b) => b.type === 'file')
  assert.ok(file, '应解析出 file 块')
  assert.equal(file.files.length, 1)
  assert.deepEqual(file.files[0], { name: '构造附件-A.pdf', size: 12345, modelKind: 'document' })
  assert.equal('content' in file.files[0], false, 'FILE 只带元数据，不得有文件本体')

  // 钉死：file 元数据不进入提炼素材，但会触发 caveat
  const { extractPreferences } = await import('../scripts/preferences.mjs')
  const card = extractPreferences(out)
  assert.equal(JSON.stringify(card.fields).includes('构造附件-A.pdf'), false, '附件名不得进字段')
  assert.equal(card.generatedFrom.fileBlocks, 1)
  assert.ok(
    card.caveats.some((c) => c.note.includes('附件内容') && c.note.includes('不可见')),
    '存在 FILE 时必须给出"提炼不可见"提示',
  )
})
