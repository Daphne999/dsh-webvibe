/**
 * 抓取分享内容。
 *
 * 边界（需求 5）：
 *  - 只访问调用方给的那一个 share_id，不枚举、不试参数、不猜 id；
 *  - 不带 Cookie、不带登录态、不带 API Key；
 *  - **不记录原始链接**：日志与错误里只出现脱敏形式 `share/***`；
 *  - 遇到登录墙/验证码/限流 → 立刻停，不重试轰炸、不换 UA 绕过。
 *
 * 接口来源：从 DeepSeek 前端实测观察（`/api/v0/share/content?share_id=`），
 * **不是官方公开文档接口**，不绑定任何 bundle hash。
 */

import { ShareFetchError, CODES } from './errors.mjs'

const ENDPOINT = 'https://chat.deepseek.com/api/v0/share/content'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** share_id 的合法形状：已验证样本为 17 位小写字母数字 */
const SHARE_ID_RE = /^[a-z0-9]{10,32}$/

/** 永远不要把原始链接写进任何输出 */
export function redactShareId(raw) {
  const s = String(raw ?? '')
  return s.length <= 6 ? '***' : s.slice(0, 2) + '***' + s.slice(-2)
}

/** 从用户粘贴的链接或裸 id 里取出 share_id；形状不对直接报错 */
export function extractShareId(input) {
  const s = String(input ?? '').trim()
  if (!s) throw new ShareFetchError(CODES.BAD_SHARE_ID, '没有提供分享链接')

  let id = s
  if (/^https?:/i.test(s)) {
    let u
    try {
      u = new URL(s)
    } catch {
      throw new ShareFetchError(CODES.BAD_SHARE_ID, '这不是一个能解析的网址')
    }
    if (u.hostname !== 'chat.deepseek.com') {
      throw new ShareFetchError(CODES.BAD_SHARE_ID, '只接受 chat.deepseek.com 的分享链接', { host: u.hostname })
    }
    const m = u.pathname.match(/^\/share\/([^/]+)\/?$/)
    if (!m) throw new ShareFetchError(CODES.BAD_SHARE_ID, '链接里没有 /share/<id> 这一段')
    id = m[1]
  }

  if (!SHARE_ID_RE.test(id)) {
    throw new ShareFetchError(CODES.BAD_SHARE_ID, '分享 id 形状不对', { shareId: redactShareId(id) })
  }
  return id
}

/**
 * 抓一份分享内容。
 * @param {string} input 用户粘贴的链接或裸 share_id
 * @param {{ fetchImpl?: typeof fetch, signal?: AbortSignal }} [opts]
 * @returns {Promise<unknown>} 已 JSON.parse 的响应体（交给 parseShareContent）
 */
export async function fetchShareContent(input, opts = {}) {
  const shareId = extractShareId(input)
  const doFetch = opts.fetchImpl ?? fetch

  let res
  try {
    res = await doFetch(`${ENDPOINT}?share_id=${encodeURIComponent(shareId)}`, {
      method: 'GET',
      // 刻意不带 Cookie / Authorization
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: opts.signal,
    })
  } catch (err) {
    throw new ShareFetchError(CODES.NETWORK, '没能连上分享服务（可能是网络问题）', {
      shareId: redactShareId(shareId),
      cause: String(err && err.message ? err.message : err),
    })
  }

  if (!res.ok) {
    // 不重试、不换 UA：把状态码原样报出来
    throw new ShareFetchError(CODES.HTTP_NOT_OK, `分享服务返回了 HTTP ${res.status}`, {
      shareId: redactShareId(shareId),
      status: res.status,
    })
  }

  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new ShareFetchError(CODES.SCHEMA_MISMATCH, '返回的不是 JSON（可能被拦到了登录页或验证页）', {
      shareId: redactShareId(shareId),
      bytes: text.length,
    })
  }
}
