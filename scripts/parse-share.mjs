/**
 * 分享链接解析器：把 `/api/v0/share/content` 的响应转成插件自己的中间格式。
 *
 * 设计约束（对应需求 1–4、7）：
 *  - 只依赖结构化字段，不依赖任何文案：不判断 content 里写了什么，只看 type/role/数字。
 *  - 字段缺失或类型不对 → 抛 ShareParseError(SCHEMA_MISMATCH)，**绝不猜测补齐**。
 *  - 分支对话（同一 parent_id 多个子节点）→ 抛 UNSUPPORTED_BRANCHING，不静默平铺。
 *  - 未知 fragment 类型（例如将来的附件）→ 抛 UNSUPPORTED_FRAGMENT，并带上那个类型名。
 *
 * 接口来源：**从 DeepSeek 前端实测观察到的接口，不是官方公开文档接口**。
 * 因此本文件不绑定任何 bundle hash，也不假装它是稳定 API。
 */

import { ShareParseError, at, CODES } from './errors.mjs'

/** 中间格式版本。结构变化时改这个号。 */
export const SCHEMA = 'webvibe/share@1'

/** 已实测确认过的 fragment 类型（线性普通/思考/联网 + TIP/FILE 加性扩展） */
const KNOWN_FRAGMENTS = new Set(['REQUEST', 'RESPONSE', 'THINK', 'SEARCH', 'TIP', 'FILE'])

/** 分享页的标题是固定占位；见到它就当作"拿不到原题" */
const PLACEHOLDER_TITLE = 'Shared Conversation'

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

function need(cond, path, expected, actual) {
  if (!cond) throw new ShareParseError(CODES.SCHEMA_MISMATCH, `字段不符合预期：${path}`, at(path, expected, actual))
}

function needStr(v, path) {
  need(typeof v === 'string', path, 'string', typeof v)
  return v
}

function needNum(v, path) {
  need(typeof v === 'number' && Number.isFinite(v), path, 'finite number', typeof v === 'number' ? String(v) : typeof v)
  return v
}

function needBool(v, path) {
  need(typeof v === 'boolean', path, 'boolean', typeof v)
  return v
}

function needArray(v, path) {
  need(Array.isArray(v), path, 'array', typeof v)
  return v
}

/**
 * 消息 id 在实测响应里是**数字**（不是字符串），归一成字符串只为了内部可比较；
 * 类型仍严格校验：只接受有限数字或非空字符串，别的一律报错。
 */
function needId(v, path) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'string' && v.length > 0) return v
  need(false, path, 'finite number | non-empty string', typeof v)
}

/** 附件元数据：按显式别名表取值，取不到就 null（元数据缺字段不阻断解析），不猜 */
function pickStr(obj, keys, path) {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

function pickNum(obj, keys, path) {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return null
}

/** epoch 秒（浮点）→ ISO 字符串；非法值直接报错，不做兜底 */
function toIso(secs, path) {
  needNum(secs, path)
  const d = new Date(secs * 1000)
  need(!Number.isNaN(d.getTime()), path, 'valid timestamp', String(secs))
  return d.toISOString()
}

/** 把一条消息的 fragments 拆成中间格式的 blocks */
function toBlocks(fragments, msgPath, warnings) {
  const blocks = []
  for (const [i, f] of needArray(fragments, msgPath + '.fragments').entries()) {
    const p = `${msgPath}.fragments[${i}]`
    need(isObj(f), p, 'object', typeof f)
    const type = needStr(f.type, p + '.type')

    if (!KNOWN_FRAGMENTS.has(type)) {
      // 明确报错，不跳过：跳过就等于静默丢内容
      throw new ShareParseError(
        CODES.UNSUPPORTED_FRAGMENT,
        `遇到还没验证过的片段类型「${type}」，暂不支持，不做丢弃处理`,
        at(p + '.type', 'REQUEST|RESPONSE|THINK|SEARCH', type),
      )
    }

    if (type === 'REQUEST' || type === 'RESPONSE') {
      blocks.push({ type: 'text', role: type === 'REQUEST' ? 'user' : 'assistant', text: needStr(f.content, p + '.content') })
      continue
    }

    if (type === 'THINK') {
      blocks.push({
        type: 'thinking',
        text: needStr(f.content, p + '.content'),
        // elapsed_secs 在样本里存在，但它是"思考耗时"，缺失不影响正文可读性 → 标注而不报错
        elapsedSecs: typeof f.elapsed_secs === 'number' ? f.elapsed_secs : null,
      })
      if (typeof f.elapsed_secs !== 'number') warnings.push({ code: 'THINK_NO_ELAPSED', message: '这条思考没带耗时信息' })
      continue
    }

    // TIP：定型块 { type:'tip', style, text }，出现在 assistant 侧
    if (type === 'TIP') {
      blocks.push({
        type: 'tip',
        // style 是提示气泡的样式名；缺了就记 null，不猜
        style: typeof f.style === 'string' ? f.style : null,
        text: needStr(f.content, p + '.content'),
      })
      if (typeof f.style !== 'string') warnings.push({ code: 'TIP_NO_STYLE', message: '这条提示没有 style 字段' })
      continue
    }

    // FILE：定型块 { type:'file', files:[{name,size,modelKind}] }，出现在 user 侧
    // 隐私属性：只有元数据，没有文件本体
    if (type === 'FILE') {
      const arr = needArray(f.files, p + '.files')
      const files = arr.map((x, j) => {
        const fp = `${p}.files[${j}]`
        need(isObj(x), fp, 'object', typeof x)
        return {
          name: pickStr(x, ['name', 'file_name'], fp + '.name'),
          size: pickNum(x, ['size', 'file_size'], fp + '.size'),
          modelKind: pickStr(x, ['model_kind', 'modelKind'], fp + '.modelKind'),
        }
      })
      if (files.length === 0) warnings.push({ code: 'FILE_EMPTY', message: '这条附件片段没有 files 条目' })
      blocks.push({ type: 'file', files })
      continue
    }

    // SEARCH
    const results = needArray(f.results, p + '.results')
    blocks.push({
      type: 'search',
      status: typeof f.status === 'string' ? f.status : null,
      queries: Array.isArray(f.queries) ? f.queries.filter((q) => typeof q === 'string') : [],
      results: results.map((r, j) => {
        const rp = `${p}.results[${j}]`
        need(isObj(r), rp, 'object', typeof r)
        return {
          url: needStr(r.url, rp + '.url'),
          title: typeof r.title === 'string' ? r.title : null,
          snippet: typeof r.snippet === 'string' ? r.snippet : null,
          siteName: typeof r.site_name === 'string' ? r.site_name : null,
          publishedAt: typeof r.published_at === 'number' ? new Date(r.published_at * 1000).toISOString() : null,
        }
      }),
    })
  }
  return blocks
}

/**
 * 主入口：解析一份 `/api/v0/share/content` 的响应体。
 *
 * @param {unknown} raw 已 JSON.parse 的响应体
 * @returns 中间格式对象（见 SCHEMA）
 * @throws {ShareParseError}
 */
export function parseShareContent(raw) {
  need(isObj(raw), '$', 'object', typeof raw)
  need(isObj(raw.data), '$.data', 'object', typeof raw.data)

  const bizCode = raw.data.biz_code
  needNum(bizCode, '$.data.biz_code')
  if (bizCode !== 0) {
    // 错误码表尚未验证（需求 4：未知错误码暂不支持）→ 报错并原样带上码
    throw new ShareParseError(CODES.BIZ_CODE_UNKNOWN, `接口返回了失败码 biz_code=${bizCode}（该码的含义尚未验证）`, {
      bizCode,
    })
  }

  const biz = raw.data.biz_data
  need(isObj(biz), '$.data.biz_data', 'object', typeof biz)

  const rawMessages = needArray(biz.messages, '$.data.biz_data.messages')
  if (rawMessages.length === 0) {
    throw new ShareParseError(CODES.EMPTY_CONVERSATION, '这个分享里没有任何消息', { path: '$.data.biz_data.messages' })
  }

  const warnings = []

  // 1) 先过一遍结构，同时收集 parent_id 关系用于分支检测
  const ids = new Set()
  const children = new Map() // parent_id -> [child_id]
  const seen = []
  for (const [i, m] of rawMessages.entries()) {
    const p = `$.data.biz_data.messages[${i}]`
    need(isObj(m), p, 'object', typeof m)
    const id = needId(m.message_id, p + '.message_id')
    need(!ids.has(id), p + '.message_id', 'unique', `duplicate ${id}`)
    ids.add(id)

    const parentId = m.parent_id === null || m.parent_id === undefined ? null : needId(m.parent_id, p + '.parent_id')
    if (parentId) {
      if (!children.has(parentId)) children.set(parentId, [])
      children.get(parentId).push(id)
    }
    seen.push({ i, m, p, id, parentId })
  }

  // 2) 分支检测：同一父节点带多个子节点 = 分支对话，本版不支持
  const branched = [...children.entries()].filter(([, kids]) => kids.length > 1)
  if (branched.length > 0) {
    throw new ShareParseError(
      CODES.UNSUPPORTED_BRANCHING,
      '这个对话有分支（同一节点下有多条子消息），当前版本不支持分支对话',
      { nodes: branched.slice(0, 5).map(([parent, kids]) => ({ parent, children: kids.length })) },
    )
  }

  // 3) 单调性检查：分支排除后，父节点必须都在本集合内（根除外）
  for (const s of seen) {
    if (s.parentId && !ids.has(s.parentId)) {
      throw new ShareParseError(CODES.SCHEMA_MISMATCH, '消息的父节点不在分享内容里，结构不完整', at(`${s.p}.parent_id`, 'existing message_id', s.parentId))
    }
  }

  // 4) 逐条转换
  const messages = seen.map(({ m, p, id, parentId }) => {
    const role = needStr(m.role, p + '.role')
    need(role === 'USER' || role === 'ASSISTANT', p + '.role', 'USER|ASSISTANT', role)

    const thinkingEnabled = needBool(m.thinking_enabled, p + '.thinking_enabled')
    const searchEnabled = needBool(m.search_enabled, p + '.search_enabled')
    const insertedAt = toIso(m.inserted_at, p + '.inserted_at')

    const blocks = toBlocks(m.fragments, p, warnings)

    const incomplete = m.incomplete_message === true
    if (incomplete) warnings.push({ code: 'INCOMPLETE_MESSAGE', message: '有消息在分享时就不完整', messageId: id })

    // 已验证行为：联网对话里，某一轮可以没有 SEARCH 片段 —— 这不是错误，也不补任何东西
    const hasSearch = blocks.some((b) => b.type === 'search')
    if (searchEnabled && role === 'ASSISTANT' && !hasSearch) {
      warnings.push({
        code: 'SEARCH_TURN_WITHOUT_RESULTS',
        message: '这一轮标了联网，但没有检索片段（已实测存在这种情况）',
        messageId: id,
      })
    }

    return {
      id,
      parentId,
      role: role === 'USER' ? 'user' : 'assistant',
      insertedAt,
      thinkingEnabled,
      searchEnabled,
      incomplete,
      blocks,
    }
  })

  // 5) 标题与模型：知道拿不到，就明确标成 null + 原因，不假装有
  const rawTitle = typeof biz.title === 'string' ? biz.title : null
  const titleIsPlaceholder = rawTitle === null || rawTitle === PLACEHOLDER_TITLE
  const rawModel = typeof rawMessages[0].model === 'string' ? rawMessages[0].model : ''
  const modelIsEmpty = rawModel.trim() === ''

  const times = messages.map((m) => m.insertedAt).sort()

  return {
    schema: SCHEMA,
    source: {
      kind: 'share-link',
      // 接口来源声明：非官方文档接口
      api: '/api/v0/share/content',
      apiStatus: 'observed-from-frontend',
      apiNote: '从 DeepSeek 前端实测观察，非官方公开文档接口，不保证稳定',
    },
    conversation: {
      title: titleIsPlaceholder ? null : rawTitle,
      titleNote: titleIsPlaceholder ? '分享页标题是固定占位（Shared Conversation），原题拿不到' : null,
      model: modelIsEmpty ? null : rawModel,
      modelNote: modelIsEmpty ? 'model 字段为空串，拿不到模型名' : null,
      messageCount: messages.length,
      timeRange: { from: times[0] ?? null, to: times[times.length - 1] ?? null },
      // 附件：三个样本里都没有任何附件字段；本版不支持，见到未知片段会直接报错
      attachments: { supported: false, note: '分享页实测不含附件；遇到未知片段类型会报错而不是丢弃' },
    },
    warnings,
    messages,
  }
}
