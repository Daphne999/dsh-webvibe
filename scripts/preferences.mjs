/**
 * 交互偏好提炼（阶段二·只做提取，不做写入）。
 *
 * 输入：1–3 个 `webvibe/share@1` 对话（parseShareContent 的返回值）
 * 输出：一张「交互偏好卡」草稿（`webvibe/preference-card@1`）
 *
 * 三条硬约束（代码里靠取值函数强制，不靠自觉）：
 *  1. **只用 text 块做提炼素材** —— 所有字段的证据都从 `textBlocks()` 取。
 *  2. **thinking 块只用于「对思考过程的态度」这一个字段** —— 只有该字段调用 `thinkingBlocks()`。
 *  3. **search 块只统计来源类型分布** —— 只数域名，不把任何文案带进卡片。
 *
 * 每条偏好都必须带 evidence（来自第几个对话、第几条消息、第几个块），
 * 不允许出现没有出处的推断；拿不到证据的字段直接给 null + 原因。
 *
 * 产出物是**给人审的草稿**：`reviewed: false`，不自动生效。
 */

export const CARD_SCHEMA = 'webvibe/preference-card@1'
export const INPUT_SCHEMA = 'webvibe/share@1'

const QUOTE_MAX = 60

// ───────────────────────── 证据取值（约束在此强制） ─────────────────────────

/** 唯一允许的正文素材来源 */
function textBlocks(conversations) {
  const out = []
  for (const [ci, conv] of conversations.entries()) {
    for (const [mi, m] of conv.messages.entries()) {
      for (const [bi, b] of m.blocks.entries()) {
        if (b.type !== 'text') continue
        out.push({ ci, mi, bi, role: m.role, text: b.text, insertedAt: m.insertedAt })
      }
    }
  }
  return out
}

/** 只给「对思考过程的态度」用 */
function thinkingBlocks(conversations) {
  const out = []
  for (const [ci, conv] of conversations.entries()) {
    for (const [mi, m] of conv.messages.entries()) {
      for (const [bi, b] of m.blocks.entries()) {
        if (b.type !== 'thinking') continue
        out.push({ ci, mi, bi, text: b.text, elapsedSecs: b.elapsedSecs })
      }
    }
  }
  return out
}

/** 只统计，不取值 */
function searchBlocks(conversations) {
  const out = []
  for (const [ci, conv] of conversations.entries()) {
    for (const [mi, m] of conv.messages.entries()) {
      for (const [bi, b] of m.blocks.entries()) {
        if (b.type !== 'search') continue
        out.push({ ci, mi, bi, results: b.results })
      }
    }
  }
  return out
}

/** FILE 块只数个数：附件元数据不参与提炼，只用于产生提示 */
function fileBlocks(conversations) {
  const out = []
  for (const [ci, conv] of conversations.entries()) {
    for (const [mi, m] of conv.messages.entries()) {
      for (const [bi, b] of m.blocks.entries()) {
        if (b.type === 'file') out.push({ ci, mi, bi })
      }
    }
  }
  return out
}

const clip = (s) => (s.length > QUOTE_MAX ? s.slice(0, QUOTE_MAX) + '…' : s)
const ev = (hit) => ({
  conversation: hit.ci,
  messageIndex: hit.mi,
  blockIndex: hit.bi,
  blockType: 'text',
  role: hit.role,
  quote: clip(hit.text.replace(/\s+/g, ' ').trim()),
})

const median = (nums) => {
  if (nums.length === 0) return null
  const a = [...nums].sort((x, y) => x - y)
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid] : Math.round((a[mid - 1] + a[mid]) / 2)
}

function confidence(evidenceCount, sampleSize) {
  if (evidenceCount === 0) return 'none'
  if (evidenceCount >= 3 || sampleSize >= 10) return 'medium'
  return 'low'
}

// ───────────────────────── 六个字段 ─────────────────────────

/** 1. 称呼 / 语气偏好 */
function appellation(texts) {
  const user = texts.filter((t) => t.role === 'user')
  const forms = new Map()
  const FORM_PATTERNS = [
    ['你', /你/g],
    ['您', /您/g],
    ['DeepSeek', /deepseek/gi],
    // 校准 v0.0.4：真实语料补入（C1 宝宝 / C4 老公 / C6 哥哥）
    ['宝宝', /宝宝/g],
    ['老公', /老公/g],
    ['宝贝', /宝贝/g],
    ['哥哥', /哥哥/g],
    ['小鱼', /小鱼/g],
    ['沈蓝', /沈蓝/g],
    ['助手', /助手/g],
  ]
  // 间接句式（真实语料 C8）：「你的称呼，你打分，满分十分，我以后就按最高分的称呼叫你」
  const INDIRECT = [
    { id: 'self-pick-name', label: '让 AI 自己挑称呼', re: /(称呼|叫你|叫你什么|怎么叫你)[^。！？\n]{0,20}(打分|满分|挑|选|定|决定)/ },
    { id: 'future-call', label: '约定以后的称呼', re: /(以后|之后|往后)[^。！？\n]{0,14}叫/ },
  ]
  let indirectHits = 0
  const indirectList = []
  for (const t of user) {
    for (const [name, re] of FORM_PATTERNS) {
      const n = (t.text.match(re) || []).length
      if (n > 0) forms.set(name, (forms.get(name) || 0) + n)
    }
    for (const rule of INDIRECT) {
      if (rule.re.test(t.text)) {
        indirectHits++
        indirectList.push({ rule: rule.id, label: rule.label, messageIndex: t.mi, quote: clip(t.text.replace(/\s+/g, ' ').trim()) })
        break
      }
    }
  }

  const POLITE = /(请|麻烦|谢谢|辛苦|拜托)/
  const DIRECT = /(给我|帮我|直接|马上|快点|别废话|锐评)/
  let polite = 0
  let direct = 0
  const evidence = []
  let directEvAdded = 0 // 校准项：direct 命中也要收证据（最多 1 条）
  for (const t of user) {
    const isPolite = POLITE.test(t.text)
    const isDirect = DIRECT.test(t.text)
    if (isPolite) polite++
    if (isDirect) direct++
    if (isPolite && evidence.length < 3) evidence.push(ev(t))
    else if (isDirect && directEvAdded < 1) {
      evidence.push(ev(t))
      directEvAdded++
    }
  }

  if (user.length === 0) {
    return { value: null, note: '输入里没有用户发言，无法判断称呼与语气', confidence: 'none', evidence: [] }
  }
  const tone = polite === 0 && direct === 0 ? '未出现明显的礼貌词或命令词' : polite >= direct ? '偏礼貌/委托式' : '偏直接/命令式'
  const topForms = [...forms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)

  return {
    value: {
      forms: topForms.map(([form, count]) => ({ form, count })),
      tone,
      politeHits: polite,
      directHits: direct,
      indirectRequests: indirectHits,
      indirect: indirectList,
    },
    note: '只统计字面形式与间接句式，不代表真实称呼偏好——需要人判断；AI→用户的称呼（如"小朋友"）当前不消费',
    confidence: confidence(evidence.length + topForms.length + indirectHits, user.length),
    evidence,
  }
}

/** 2. 回复长度习惯 */
function verbosity(texts) {
  const user = texts.filter((t) => t.role === 'user')
  const assistant = texts.filter((t) => t.role === 'assistant')

  const explicitShort = /(太长了|简短|简单说|一句话|别啰嗦|说重点|精简)/
  const explicitLong = /(详细|展开|具体点|多说|完整)/
  const shortHits = assistant.length ? user.filter((t) => explicitShort.test(t.text)) : []
  const longHits = user.filter((t) => explicitLong.test(t.text))

  // 校准 v0.0.4（真实语料 R1/R2）：「16-20」「a 还是 d」这类**四字以内的追问式指令**判"简洁"
  const isTerseProbe = (s) => {
    const t = s.trim()
    if (t.length === 0) return false
    if (/^[0-9]{1,3}\s*[-–—~]\s*[0-9]{1,3}$/.test(t)) return true // 题号区间
    if (/^[a-dA-D]\s*(还是|或|or)\s*[a-dA-D]$/i.test(t)) return true // 二选一
    if (/^[0-9]{1,3}$/.test(t)) return true // 纯题号
    return t.replace(/\s/g, '').length <= 4 // 四字以内
  }
  const terseProbes = user.filter((t) => isTerseProbe(t.text))

  const evidence = [...shortHits.slice(0, 2), ...longHits.slice(0, 2)].map(ev)

  return {
    value: {
      assistantMedianChars: median(assistant.map((t) => t.text.length)),
      userMedianChars: median(user.map((t) => t.text.length)),
      assistantSamples: assistant.length,
      userSamples: user.length,
      explicitShortRequests: shortHits.length,
      explicitLongRequests: longHits.length,
      terseProbeCount: terseProbes.length,
      terseProbeRatio: user.length ? Math.round((terseProbes.length / user.length) * 100) : null,
      style: terseProbes.length >= 2 ? '偏向极简追问（题号 / 二选一 / 四字以内）' : '未出现明显的极简追问',
    },
    note: '长度是这一份对话里的实际分布，不等于用户偏好；terseProbe 按"四字以内或题号/二选一"判定，显式要求更可信',
    confidence: confidence(explicitShort.length + explicitLong.length + terseProbes.length, user.length + assistant.length),
    evidence,
  }
}

/** 3. 格式化偏好（列表 / 代码块） */
function formatting(texts) {
  const list = /(^|\n)\s*(?:[-*+]|\d+\.)\s+/
  const fence = /```/
  const table = /\n\s*\|[^\n]*\|/
  const stat = (arr) => ({
    samples: arr.length,
    withList: arr.filter((t) => list.test(t.text)).length,
    withCodeFence: arr.filter((t) => fence.test(t.text)).length,
    withTable: arr.filter((t) => table.test(t.text)).length,
  })

  const assistant = stat(texts.filter((t) => t.role === 'assistant'))
  const user = stat(texts.filter((t) => t.role === 'user'))
  const evidence = texts
    .filter((t) => t.role === 'user' && (list.test(t.text) || fence.test(t.text)))
    .slice(0, 3)
    .map(ev)

  // 置信度看样本量：有统计就至少 low，不因为"用户自己没用列表"就变成 none
  const samples = assistant.samples + user.samples
  const conf = samples === 0 ? 'none' : evidence.length >= 3 || samples >= 10 ? 'medium' : 'low'

  return {
    value: { assistant, user },
    note: '统计的是"实际用了多少"，偏好取舍需要人判断',
    confidence: conf,
    evidence,
  }
}

/** 4. 话题领域（固定词典，可扩展） 
 *  每个桶带证据等级：real = 有真实语料支撑；synthetic-only = 只有合成句验证过。
 *  这个标记会随卡片输出，避免把"合成验证"当成真实结论。
 */
const TOPIC_DICT = {
  编程技术: { re: /(代码|函数|报错|编译|插件|接口|api|git|部署|脚本|正则|sql|vps|nginx|ssh)/i, level: 'real' },
  // 校准 v0.0.4：去掉裸「题」「课」，只认成词，避免"人是不是有用"这类思辨被归进来
  学习考试: { re: /(考试|作业|复习|知识点|课程|上课|课堂|课表|老师|习题|真题|做题|刷题|错题|词性|完形填空|英语)/, level: 'real' },
  生活日常: { re: /(吃|睡|天气|累|困|放学|回家|周末|心情)/, level: 'real' },
  // 校准 v0.0.4：新增，但【只有合成验证】，真实语料尚未覆盖
  生活家居: { re: /(植物|盆栽|绿植|花卉|养花|浇水|家居|收纳|装修|厨房|阳台|房间|沙发|清洁)/, level: 'synthetic-only' },
  // 校准 v0.0.4：真实语料 R3（钢笔选购）支撑
  消费购物: { re: /(推荐.{0,4}品牌|品牌|选购|值得入|性价比|预算|下单|买|价格|多少钱|钢笔|千元)/, level: 'real' },
  // 校准 v0.0.4：真实语料 R4（笔记本锐评）支撑
  数码科技: { re: /(笔记本|显卡|处理器|手机|耳机|相机|显示器|数码|锐评|配置|跑分|型号|款)/, level: 'real' },
  写作表达: { re: /(写|文案|稿|标题|润色|排版)/, level: 'real' },
  产品需求: { re: /(需求|用户|功能|体验|要不要做|值不值得)/, level: 'real' },
}

function topics(texts) {
  const user = texts.filter((t) => t.role === 'user')
  const counts = new Map()
  const firstQuote = new Map()
  for (const t of user) {
    for (const [name, def] of Object.entries(TOPIC_DICT)) {
      if (def.re.test(t.text)) {
        counts.set(name, (counts.get(name) || 0) + 1)
        if (!firstQuote.has(name)) firstQuote.set(name, t)
      }
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  const evidence = ranked.map(([name]) => ev(firstQuote.get(name)))

  return {
    value: ranked.map(([name, count]) => ({ topic: name, hits: count, evidenceLevel: TOPIC_DICT[name].level })),
    note: '词典是固定的，只做粗分类；evidenceLevel=synthetic-only 表示该桶只有合成验证、无真实语料',
    confidence: confidence(evidence.length, user.length),
    evidence,
  }
}

/** 5. 被纠正过的点（校准 v0.0.4：双向修订——既收窄误报，也补隐性纠错） */
function corrections(texts) {
  const user = texts.filter((t) => t.role === 'user')

  // 每条规则都有 id 与 label，命中时随证据一起给出，方便人审"为什么算纠正"
  const RULES = [
    { id: 'too-long', label: '嫌长 / 要重点', re: /(太长|太啰嗦|啰嗦|说重点|废话)/ },
    { id: 'wrong', label: '指出错误', re: /(错了|不对|不是这样|又重新|你又)/ },
    { id: 'no-explain', label: '不要解释', re: /(别解释|不要解释)/ },
    // 隐性纠错（真实语料 R1 补）：质疑答案正确性 —— 放在 not-followed 之前，归属更准
    { id: 'challenge', label: '质疑答案', re: /(它|这|那)?不是[^\n]{0,8}(吗|么)/ },
    // 隐性纠错（真实语料 R1 补）：指出没按约定执行
    { id: 'not-followed', label: '指出未按约定执行', re: /(没(说|提)过|没(按|照)|没有(按|照)|哪(里|儿)?有[^\n]{0,12}(划线|线|要求|说过|答案|标注))/ },
  ]

  // 弱否定词：必须**紧接祈使动词**且句中含**输出对象词**才算纠正。
  // 这样「先别放答案」（别+放，非祈使动词表内）、「不用说什么大道理」（无对象词）都判负。
  const WEAK = /(不要|别|不用|应该|改成)/
  const IMPERATIVE_AFTER = /^[\s，,。.!！~、]{0,2}(用|列|写|给|解释|总结|加|删|改|说)/
  const OBJECT = /(列表|表格|代码|解释|结论|格式|标点|段落|例子|这么长|小标题)/

  const judge = (text) => {
    for (const r of RULES) if (r.re.test(text)) return { id: r.id, label: r.label }
    const m = WEAK.exec(text)
    if (m) {
      const rest = text.slice(m.index + m[0].length)
      if (IMPERATIVE_AFTER.test(rest) && OBJECT.test(text)) return { id: 'negate-with-object', label: '否定 + 输出对象' }
    }
    return null
  }

  const hits = []
  for (const t of user) {
    const r = judge(t.text)
    if (r) hits.push({ t, r })
  }

  return {
    value: hits.map(({ t, r }) => ({
      messageIndex: t.mi,
      quote: clip(t.text.replace(/\s+/g, ' ').trim()),
      rule: r.id,
      label: r.label,
    })),
    note: '规则双向：强标记与隐性纠错（未按约定/质疑答案）直接命中；弱否定词需"紧接祈使动词 + 出现输出对象词"。仍可能漏判（无否定词的批评）',
    confidence: confidence(hits.length, user.length),
    evidence: hits.slice(0, 6).map(({ t, r }) => ({ ...ev(t), rule: r.id, label: r.label })),
  }
}

/** 6. 对思考过程的态度（**唯一允许使用 thinking 块的字段**） */
function thinkingAttitude(texts, thinks) {
  const user = texts.filter((t) => t.role === 'user')
  const wantThink = /(慢慢想|想清楚|分析一下|推理|认真想|深入)/
  const noThink = /(直接说|直接给|别解释|不用想|简单|简短|别啰嗦)/
  const want = user.filter((t) => wantThink.test(t.text))
  const no = user.filter((t) => noThink.test(t.text))

  const assistantMsgs = new Set(texts.filter((t) => t.role === 'assistant').map((t) => `${t.ci}:${t.mi}`))
  const withThinking = new Set(thinks.map((t) => `${t.ci}:${t.mi}`))
  const ratio = assistantMsgs.size ? Math.round((withThinking.size / assistantMsgs.size) * 100) : null

  // 只在"需要思考"的证据里引用 thinking 块的存在，不引用其正文
  const thinkingEvidence = thinks.slice(0, 3).map((t) => ({
    conversation: t.ci,
    messageIndex: t.mi,
    blockIndex: t.bi,
    blockType: 'thinking',
    note: '该回答带思考过程',
    elapsedSecs: t.elapsedSecs,
  }))

  return {
    value: {
      thinkingRatioPercent: ratio,
      assistantAnswers: assistantMsgs.size,
      answersWithThinking: withThinking.size,
      wantsThinkingRequests: want.length,
      dislikesThinkingRequests: no.length,
      attitude:
        want.length > no.length ? '倾向要更充分的思考' : no.length > want.length ? '倾向少解释、直接给结论' : '未出现明确要求',
    },
    note: '思考块本身不作为正文素材；这里只统计它的存在比例与用户显式要求',
    confidence: confidence(want.length + no.length + thinks.length, user.length),
    evidence: [...want.slice(0, 2).map(ev), ...no.slice(0, 2).map(ev), ...thinkingEvidence],
  }
}

/** 来源类型分布（只计数，不带任何文案） */
function sourceDistribution(searches) {
  const domains = new Map()
  let total = 0
  for (const s of searches) {
    for (const r of s.results) {
      total++
      let host = 'unknown'
      try {
        host = new URL(r.url).hostname
      } catch {
        /* 保留 unknown */
      }
      domains.set(host, (domains.get(host) || 0) + 1)
    }
  }
  return {
    totalResults: total,
    turnsWithSearch: searches.length,
    byDomain: [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([domain, count]) => ({ domain, count })),
    note: '只做来源类型分布统计，不把标题/摘要等文案带进卡片',
  }
}

/** 检测输入里的 thinking/search/tip 原文有没有泄漏进卡片（给测试用的辅助导出） */
export function collectForeignText(conversations) {
  const foreign = []
  for (const conv of conversations) {
    for (const m of conv.messages) {
      for (const b of m.blocks) {
        if (b.type === 'thinking') foreign.push(b.text)
        if (b.type === 'tip') foreign.push(b.text)
        if (b.type === 'search') {
          for (const r of b.results) {
            if (r.title) foreign.push(r.title)
            if (r.snippet) foreign.push(r.snippet)
          }
        }
        if (b.type === 'file') {
          for (const f of b.files) if (f.name) foreign.push(f.name)
        }
      }
    }
  }
  return foreign
}

// ───────────────────────── 主入口 ─────────────────────────

/**
 * @param {object|object[]} input 一个或多个 `webvibe/share@1` 对话
 * @param {{caveats?: Array<{fields: string[], note: string}>}} [opts] 校准说明（例如样本混有第三方笔迹）
 * @returns 偏好卡草稿
 */
export function extractPreferences(input, opts = {}) {
  const conversations = Array.isArray(input) ? input : [input]
  if (conversations.length === 0) throw new TypeError('至少需要一个对话')
  if (conversations.length > 3) throw new TypeError('一次最多处理 3 个对话')
  for (const [i, c] of conversations.entries()) {
    if (!c || c.schema !== INPUT_SCHEMA) {
      throw new TypeError(`第 ${i + 1} 个输入不是 ${INPUT_SCHEMA}（收到 ${c && c.schema}）`)
    }
    if (!Array.isArray(c.messages)) throw new TypeError(`第 ${i + 1} 个输入缺少 messages`)
  }

  const texts = textBlocks(conversations)
  const thinks = thinkingBlocks(conversations)
  const searches = searchBlocks(conversations)
  const files = fileBlocks(conversations)

  const fields = {
    appellation: appellation(texts),
    verbosity: verbosity(texts),
    formatting: formatting(texts),
    topics: topics(texts),
    corrections: corrections(texts),
    thinkingAttitude: thinkingAttitude(texts, thinks),
  }

  // 存在 FILE 块时自动加一条提示：附件内容对提炼不可见
  const caveats = Array.isArray(opts.caveats) ? [...opts.caveats] : []
  if (files.length > 0) {
    caveats.push({
      fields: ['corrections', 'verbosity', 'topics'],
      note: `存在 ${files.length} 个 FILE 块：用户后续极简追问可能引用附件内容，而提炼不可见（FILE 只有元数据，无文件本体）`,
    })
  }

  return {
    schema: CARD_SCHEMA,
    draft: true,
    reviewed: false,
    generatedFrom: {
      conversations: conversations.length,
      messages: conversations.reduce((n, c) => n + c.messages.length, 0),
      textBlocks: texts.length,
      thinkingBlocks: thinks.length,
      searchBlocks: searches.length,
      fileBlocks: files.length,
    },
    sources: sourceDistribution(searches),
    caveats,
    provenance: opts.provenance ?? null,
    fields,
    reminder: '这是草稿，需要人逐条确认后才可能生效；本阶段不写任何配置。',
  }
}
