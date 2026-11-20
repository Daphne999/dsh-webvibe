/**
 * 偏好提炼的测试。
 *
 * 重点证明三条硬约束确实被代码强制（而不是靠自觉）：
 *  - 正文素材只来自 text 块；
 *  - thinking 块只出现在「对思考过程的态度」的 evidence 里；
 *  - search 块只贡献域名统计，标题/摘要等文案不得进入卡片。
 *
 * 输入全部是**构造的**，不用真实对话。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { extractPreferences, CARD_SCHEMA, collectForeignText } from '../scripts/preferences.mjs'
import { SCHEMA } from '../scripts/parse-share.mjs'

const T_THINK = '思考块里的独特标记ZZTHINKZZ不该出现在正文素材里'
const T_SEARCH_TITLE = '检索标题里的独特标记ZZSEARCHZZ不该进卡片'
const T_SEARCH_SNIPPET = '检索摘要里的独特标记ZZSNIPPETZZ不该进卡片'

/** 造一个 share@1 对话 */
function makeConv({ texts = [], thinks = [], searches = [], title = null } = {}) {
  const blocks = []
  for (const t of texts) blocks.push({ type: 'text', role: t.role === 'user' ? 'user' : 'assistant', text: t.text })
  for (const t of thinks) blocks.push({ type: 'thinking', text: t, elapsedSecs: 8 })
  for (const s of searches) {
    blocks.push({
      type: 'search',
      status: 'FINISHED',
      queries: [],
      results: s.map((r, i) => ({
        url: `https://${r.domain}/p/${i}`,
        title: r.title ?? T_SEARCH_TITLE,
        snippet: r.snippet ?? T_SEARCH_SNIPPET,
        siteName: r.domain,
        publishedAt: null,
      })),
    })
  }

  // 一条 assistant 消息装一个块，保持索引清晰
  const messages = blocks.map((b, i) => ({
    id: String(i + 1),
    parentId: i === 0 ? null : String(i),
    role: b.type === 'thinking' || b.type === 'search' ? 'assistant' : b.role,
    insertedAt: new Date(1794992684 + i).toISOString(),
    thinkingEnabled: b.type === 'thinking',
    searchEnabled: b.type === 'search',
    incomplete: false,
    blocks: [b],
  }))

  return {
    schema: SCHEMA,
    source: { kind: 'share-link', api: '/api/v0/share/content', apiStatus: 'observed-from-frontend', apiNote: '测试' },
    conversation: { title, model: null, messageCount: messages.length, timeRange: { from: null, to: null } },
    warnings: [],
    messages,
  }
}

const sampleConversations = () =>
  makeConv({
    texts: [
      { role: 'user', text: '麻烦你帮我看看这段代码为什么报错' },
      { role: 'assistant', text: '好的，先看这段：\n- 第 3 行少了个括号\n- 第 7 行变量未定义\n```js\nconst a = 1\n```' },
      { role: 'user', text: '太长了，简短说，下次直接给结论' },
      { role: 'assistant', text: '第 3 行少括号，第 7 行变量未定义。' },
      { role: 'user', text: '不要用列表，我不喜欢' },
      { role: 'assistant', text: '明白。' },
      { role: 'user', text: '还有，慢慢想清楚再回答，别急着下结论' },
      { role: 'assistant', text: '好。' },
    ],
    thinks: [T_THINK],
    searches: [[{ domain: 'docs.example.com' }, { domain: 'docs.example.com' }, { domain: 'blog.example.org' }]],
  })

// ───────────────────── 基本形状 ─────────────────────

test('输出是草稿：draft=true、reviewed=false、schema 正确', () => {
  const card = extractPreferences(sampleConversations())
  assert.equal(card.schema, CARD_SCHEMA)
  assert.equal(card.draft, true)
  assert.equal(card.reviewed, false)
  assert.match(card.reminder, /草稿/)
})

test('六个字段都在，且每个字段有 value / confidence / evidence', () => {
  const card = extractPreferences(sampleConversations())
  for (const key of ['appellation', 'verbosity', 'formatting', 'topics', 'corrections', 'thinkingAttitude']) {
    const f = card.fields[key]
    assert.ok(f, `缺少字段 ${key}`)
    assert.ok('value' in f, `${key} 缺 value`)
    assert.ok('confidence' in f, `${key} 缺 confidence`)
    assert.ok(Array.isArray(f.evidence), `${key} 缺 evidence`)
  }
})

test('接受 1–3 个对话；超过 3 个或 schema 不对直接报错', () => {
  const c = sampleConversations()
  assert.doesNotThrow(() => extractPreferences(c))
  assert.doesNotThrow(() => extractPreferences([c, c, c]))
  assert.throws(() => extractPreferences([c, c, c, c]), /最多/)
  assert.throws(() => extractPreferences({ schema: 'other@1', messages: [] }), /不是/)
})

// ───────────────────── 硬约束 ─────────────────────

test('约束一：正文素材只来自 text 块 —— 证据里的 blockType 只能是 text', () => {
  const card = extractPreferences(sampleConversations())
  for (const [key, f] of Object.entries(card.fields)) {
    if (key === 'thinkingAttitude') continue // 该字段允许 thinking 证据
    for (const e of f.evidence) {
      assert.equal(e.blockType, 'text', `${key} 出现了非 text 证据`)
    }
  }
})

test('约束二：thinking 原文只允许出现在「对思考过程的态度」的证据里，且只带存在性不带正文', () => {
  const card = extractPreferences(sampleConversations())
  const json = JSON.stringify(card)

  // 全文任何位置都不该出现思考块的原文
  assert.equal(json.includes(T_THINK), false, '思考块原文泄漏进了卡片')

  // 该字段可以引用 thinking 块，但只给索引与耗时，不给正文
  const t = card.fields.thinkingAttitude.evidence.filter((e) => e.blockType === 'thinking')
  assert.ok(t.length >= 1, '应当引用思考块的存在')
  for (const e of t) {
    assert.equal('quote' in e, false, 'thinking 证据不应带正文引文')
    assert.equal(typeof e.messageIndex, 'number')
    assert.equal(typeof e.blockIndex, 'number')
  }
})

test('约束三：search 块只统计域名分布，标题与摘要不得进卡片', () => {
  const card = extractPreferences(sampleConversations())
  const json = JSON.stringify(card)

  assert.equal(json.includes(T_SEARCH_TITLE), false, '检索标题泄漏')
  assert.equal(json.includes(T_SEARCH_SNIPPET), false, '检索摘要泄漏')

  assert.equal(card.sources.totalResults, 3)
  const domains = card.sources.byDomain.map((d) => d.domain)
  assert.deepEqual(domains, ['docs.example.com', 'blog.example.org'])
  assert.equal(card.sources.byDomain[0].count, 2)
})

test('证据索引可回指：每条 text 证据都能在原对话里找到对应块', () => {
  const conv = sampleConversations()
  const card = extractPreferences(conv)
  let checked = 0
  for (const f of Object.values(card.fields)) {
    for (const e of f.evidence) {
      const m = conv.messages[e.messageIndex]
      assert.ok(m, '证据指向不存在的消息')
      const b = m.blocks[e.blockIndex]
      assert.ok(b, '证据指向不存在的块')
      if (e.blockType === 'text') assert.equal(b.type, 'text')
      if (e.blockType === 'thinking') assert.equal(b.type, 'thinking')
      checked++
    }
  }
  assert.ok(checked >= 5, '证据数量过少')
})

// ───────────────────── 字段行为 ─────────────────────

test('被纠正过的点：能抓到“太长了/不要用列表/别急着下结论”', () => {
  const card = extractPreferences(sampleConversations())
  const c = card.fields.corrections
  assert.ok(c.value.length >= 2)
  const joined = c.value.map((v) => v.quote).join(' | ')
  assert.match(joined, /太长/)
  assert.match(joined, /不要/)
})

test('格式化偏好：统计到 assistant 用了列表与代码块', () => {
  const card = extractPreferences(sampleConversations())
  const f = card.fields.formatting.value
  assert.ok(f.assistant.samples >= 1)
  assert.ok(f.assistant.withList >= 1)
  assert.ok(f.assistant.withCodeFence >= 1)
})

test('长度习惯：给出中位数与显式要求次数', () => {
  const card = extractPreferences(sampleConversations())
  const v = card.fields.verbosity.value
  assert.equal(typeof v.assistantMedianChars, 'number')
  assert.ok(v.explicitShortRequests >= 1)
})

test('称呼与语气：统计到“你”以及礼貌词', () => {
  const card = extractPreferences(sampleConversations())
  const a = card.fields.appellation.value
  assert.ok(a.forms.some((x) => x.form === '你'))
  assert.ok(a.politeHits >= 1)
  assert.match(a.tone, /礼貌|直接|未出现/)
})

test('话题领域：只输出词典内的桶', () => {
  const card = extractPreferences(sampleConversations())
  const names = card.fields.topics.value.map((t) => t.topic)
  for (const n of names) assert.ok(['编程技术', '学习考试', '生活日常', '生活家居', '写作表达', '产品需求'].includes(n))
})

test('对思考过程的态度：同时记录想要思考与想直接要结论的要求', () => {
  const card = extractPreferences(sampleConversations())
  const t = card.fields.thinkingAttitude.value
  assert.equal(t.assistantAnswers >= 1, true)
  assert.equal(t.answersWithThinking, 1)
  assert.equal(typeof t.thinkingRatioPercent, 'number')
  assert.ok(t.wantsThinkingRequests >= 1)
  assert.ok(t.dislikesThinkingRequests >= 1)
})

test('空输入：没有用户发言时给 null + 原因，不硬编造', () => {
  const card = extractPreferences(makeConv({ texts: [{ role: 'assistant', text: '只有回复。' }] }))
  assert.equal(card.fields.appellation.value, null)
  assert.match(card.fields.appellation.note, /没有用户发言/)
  assert.equal(card.fields.appellation.confidence, 'none')
})

test('collectForeignText 只收集 thinking 与 search 的文案（供泄漏自检）', () => {
  const conv = sampleConversations()
  const foreign = collectForeignText([conv])
  assert.ok(foreign.includes(T_THINK))
  assert.ok(foreign.includes(T_SEARCH_TITLE))
  assert.ok(foreign.includes(T_SEARCH_SNIPPET))
})

// ───────────────────── 校准回归 v0.0.4（新增，不计入 34 条基线） ─────────────────────
// 每一条都对应试跑暴露的一个失真，用真实样本的原句或等价构造句回归。

const oneUser = (text) =>
  makeConv({
    texts: [
      { role: 'user', text },
      { role: 'assistant', text: '好。' },
    ],
  })

test('回归①：否定词单独出现不再算纠正 ——「不用说什么大道理」必须不命中', () => {
  // 用与真实样本同型的构造句（不引用真实对话原文）：否定词 + 非输出对象
  const card = extractPreferences(oneUser('陪我随便聊聊就行，也不用说什么大道理。'))
  assert.equal(card.fields.corrections.value.length, 0, '「不用」出现在自然叙述里，不应判成纠正')
})

test('回归①：真纠正仍然命中 ——「太长了，下次直接给结论」「不要用列表」「别解释，直接说」', () => {
  for (const text of ['太长了，下次直接给结论', '不要用列表，我不喜欢', '别解释，直接说重点']) {
    const card = extractPreferences(oneUser(text))
    assert.equal(card.fields.corrections.value.length, 1, `「${text}」应判成纠正`)
  }
})

test('回归②：话题桶收窄 —— 哲学思辨不再误进「学习考试」；真课程词仍然命中', () => {
  const philosophy = extractPreferences(
    oneUser('我最近一直在想：人是不是一定要变得"有用"才算没白活？我更多时候只想发呆、看云、做没意义的小事。'),
  )
  const names1 = philosophy.fields.topics.value.map((t) => t.topic)
  assert.equal(names1.includes('学习考试'), false, '思辨句不该归进学习考试')

  const course = extractPreferences(oneUser('今天上课老师讲的这个知识点我没跟上，作业也不会做'))
  const names2 = course.fields.topics.value.map((t) => t.topic)
  assert.ok(names2.includes('学习考试'), '真课程内容应命中学习考试')
})

test('回归③：新增「生活家居」桶 —— 植物/家居对话能抓到', () => {
  // 同型构造句，不引用真实对话原文
  const card = extractPreferences(oneUser('阳台想养几盆好养活的盆栽，浇水和光照不太会'))
  const names = card.fields.topics.value.map((t) => t.topic)
  assert.ok(names.includes('生活家居'), '植物/家居内容应命中生活家居')
})

test('回归④：appellation 判"偏直接"时必须带得出证据', () => {
  // 构造与联网卡同型：用户消息里没有"你/您/DeepSeek"等字面称呼，但有直接语气
  const card = extractPreferences(oneUser('给我列个清单，快点'))
  const a = card.fields.appellation
  assert.equal(a.value.forms.length, 0, '故意不含称呼词')
  assert.ok(a.value.directHits >= 1)
  assert.match(a.value.tone, /直接/)
  assert.ok(a.evidence.length >= 1, '判成偏直接时证据区不能为空')
  assert.equal(a.evidence[0].blockType, 'text')
})

test('回归⑤：校准说明随卡片输出，渲染里能看见', async () => {
  const { renderCardMarkdown } = await import('../scripts/render-card.mjs')
  const card = extractPreferences(sampleConversations(), {
    caveats: [{ fields: ['appellation', 'verbosity'], note: '本次样本混有第三方笔迹，结论仅作参考，待纯用户样本复核' }],
  })
  assert.equal(card.caveats.length, 1)
  const md = renderCardMarkdown(card)
  assert.match(md, /校准说明/)
  assert.match(md, /待纯用户样本复核/)
})

// ───────────────────── 语料校准 v0.0.4（第二料驱动，新增，另计） ─────────────────────
// 纪律：不直接引用语料原文，一律用**同型构造句**；语料原文只留在语料文档里。

const twoTurn = (a, b) =>
  makeConv({
    texts: [
      { role: 'user', text: a },
      { role: 'assistant', text: b },
    ],
  })

test('语料①：否定词非纠错 8 类全部判负（含「先别放答案」）', () => {
  const negatives = [
    '不认识，您是？',
    '没有，不记得了',
    '不像我会干的事',
    '先别放答案', // 真实语料误报样本的同型句
    '陪我聊聊就行，不用说什么大道理',
    '小熊被抛弃了',
    '不是那个意思啦',
    '我不太记得了',
  ]
  for (const text of negatives) {
    const card = extractPreferences(oneUser(text))
    assert.equal(card.fields.corrections.value.length, 0, `应判负：${text}`)
  }
})

test('语料①：隐性纠错两类必须判正（未按约定执行 / 质疑答案）', () => {
  const positives = [
    ['哪里有划线的地方', 'not-followed'],
    ['它不是连词吗', 'challenge'],
  ]
  for (const [text, ruleId] of positives) {
    const card = extractPreferences(oneUser(text))
    const hits = card.fields.corrections.value
    assert.equal(hits.length, 1, `应判正：${text}`)
    assert.equal(hits[0].rule, ruleId, `规则应为 ${ruleId}`)
    assert.ok(hits[0].label && hits[0].label.length > 0, '命中要带人可读的 label')
  }
})

test('语料②：AI 侧否定词不进入用户侧统计（防污染）', () => {
  const conv = makeConv({
    texts: [
      { role: 'user', text: '再来一次' },
      { role: 'assistant', text: '不按了。' },
      { role: 'assistant', text: '好了，拍了。别装可怜了。' },
      { role: 'assistant', text: '被骗一次就够了。' },
    ],
  })
  const card = extractPreferences(conv)
  assert.equal(card.fields.corrections.value.length, 0, 'AI 文本里的否定词不得进用户侧统计')
  assert.equal(card.fields.corrections.evidence.length, 0)
})

test('语料③：称呼正向（宝宝 / 老公）与反向称呼不消费', () => {
  const card = extractPreferences(
    makeConv({
      texts: [
        { role: 'user', text: '我们一起玩个游戏吧，宝宝' },
        { role: 'assistant', text: '行。' },
        { role: 'user', text: '老公来接一下后半句' },
        { role: 'assistant', text: '嗯。' },
      ],
    }),
  )
  const forms = card.fields.appellation.value.forms.map((f) => f.form)
  assert.ok(forms.includes('宝宝') || forms.includes('老公'), '应识别到真实称呼')
})

test('语料③：间接句式「让 AI 自己挑称呼」能被识别并带引文', () => {
  const card = extractPreferences(oneUser('称呼你定，满分十分，以后就按最高分叫你'))
  const a = card.fields.appellation.value
  assert.ok(a.indirectRequests >= 1, '应识别到间接称呼请求')
  assert.ok(a.indirect[0].label.includes('称呼'), '要带人可读标签')
})

test('语料④：新增消费购物 / 数码科技桶命中；生活家居标 synthetic-only', () => {
  const shop = extractPreferences(oneUser('千元左右的钢笔哪个最值得入'))
  const shopTopics = shop.fields.topics.value
  assert.ok(shopTopics.some((t) => t.topic === '消费购物'), '钢笔选购应命中消费购物')

  const tech = extractPreferences(oneUser('锐评一下这款笔记本的缺点'))
  assert.ok(tech.fields.topics.value.some((t) => t.topic === '数码科技'), '笔记本锐评应命中数码科技')

  const home = extractPreferences(oneUser('阳台想养几盆好养活的盆栽'))
  const homeTopic = home.fields.topics.value.find((t) => t.topic === '生活家居')
  assert.ok(homeTopic, '合成句应命中生活家居')
  assert.equal(homeTopic.evidenceLevel, 'synthetic-only', '生活家居必须标合成验证')
})

test('语料⑤：四字以内追问式指令判「简洁」（题号区间 / 二选一 / 纯数字）', () => {
  const conv = makeConv({
    texts: [
      { role: 'user', text: '16-20' },
      { role: 'assistant', text: '好。' },
      { role: 'user', text: 'a 还是 d' },
      { role: 'assistant', text: 'd。' },
      { role: 'user', text: '19' },
      { role: 'assistant', text: '因为时态。' },
    ],
  })
  const v = extractPreferences(conv).fields.verbosity.value
  assert.equal(v.terseProbeCount, 3)
  assert.match(v.style, /极简追问/)
})

test('语料⑥：provenance 与 caveats 同时出现在卡片与渲染里', async () => {
  const { renderCardMarkdown } = await import('../scripts/render-card.mjs')
  const card = extractPreferences(oneUser('随便聊聊'), { provenance: '真实用户语料' })
  assert.equal(card.provenance, '真实用户语料')
  assert.match(renderCardMarkdown(card), /语料来源：\*\*真实用户语料\*\*/)
})

test('语料⑦：思考摘要是两种真实格式之一，也只进该字段、不进正文素材', async () => {
  const { collectForeignText } = await import('../scripts/preferences.mjs')
  const mkThink = (t) => makeConv({ texts: [{ role: 'user', text: '嗯' }], thinks: [t] })
  const 主谓 = '识别出对方在开玩笑，决定配合互动。'
  const 动宾 = '思考如何回应一个玩笑式的请求。'
  for (const t of [主谓, 动宾]) {
    const conv = mkThink(t)
    const card = extractPreferences(conv)
    const json = JSON.stringify(card)
    assert.equal(json.includes(t), false, '思考摘要原文不得进卡片')
    assert.ok(collectForeignText([conv]).includes(t))
    const ev = card.fields.thinkingAttitude.evidence.filter((e) => e.blockType === 'thinking')
    assert.ok(ev.length >= 1 && !('quote' in ev[0]), 'thinking 证据只给索引')
  }
})
