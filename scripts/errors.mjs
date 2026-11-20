/**
 * 可读错误。每个错误都有一个稳定的 code，测试与调用方按 code 分支，
 * 不依赖中文文案（文案随时可改）。
 */

export class ShareParseError extends Error {
  /**
   * @param {string} code 稳定错误码
   * @param {string} message 给人看的一句话
   * @param {object} [detail] 结构化的定位信息（字段路径、实际类型等）
   */
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'ShareParseError'
    this.code = code
    this.detail = detail
  }
}

export class ShareFetchError extends Error {
  constructor(code, message, detail = {}) {
    super(message)
    this.name = 'ShareFetchError'
    this.code = code
    this.detail = detail
  }
}

/** 错误码表：一处定义，README 与测试都引用这里 */
export const CODES = {
  // 抓取层
  BAD_SHARE_ID: 'BAD_SHARE_ID',
  HTTP_NOT_OK: 'HTTP_NOT_OK',
  NETWORK: 'NETWORK',
  BIZ_CODE_UNKNOWN: 'BIZ_CODE_UNKNOWN',

  // 结构层（防御性校验）
  SCHEMA_MISMATCH: 'SCHEMA_MISMATCH',
  UNSUPPORTED_FRAGMENT: 'UNSUPPORTED_FRAGMENT',
  UNSUPPORTED_BRANCHING: 'UNSUPPORTED_BRANCHING',
  EMPTY_CONVERSATION: 'EMPTY_CONVERSATION',
}

/** 结构化定位：例如 data.biz_data.messages[2].fragments[0].type */
export function at(path, expected, actual) {
  return { path, expected, actual }
}
