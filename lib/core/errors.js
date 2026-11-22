/**
 * 统一错误码与可操作提示。
 *
 * 所有面向模型/用户的失败都带 `code`（稳定、可判断）、`message`（发生了什么）
 * 和 `hint`（下一步怎么做）。凭证、Cookie 值永远不会进入 message。
 */

/** @typedef {'E_NO_CREDENTIAL'|'E_AUTH_EXPIRED'|'E_CLOUDFLARE'|'E_RATE_LIMITED'|'E_NOT_AUTHOR'|'E_CSRF'|'E_VALIDATION'|'E_VERSION_CONFLICT'|'E_NETWORK'|'E_TIMEOUT'|'E_HTTP'|'E_SOURCE_MISSING'|'E_SOURCE_EMPTY'|'E_BAD_META'|'E_SCRIPT_NOT_FOUND'|'E_RECAPTCHA'|'E_RESTRICTED'|'E_NO_CHANGES'|'E_BAD_ARGUMENT'|'E_UNSUPPORTED'|'E_STORAGE'} GreasyForkErrorCode */

/** 每个错误码的默认处理建议（中文）。 */
export const ERROR_HINTS = {
  E_NO_CREDENTIAL:
    '先配置一次 GreasyFork 会话 Cookie：在已登录的浏览器里打开 greasyfork.org，导出 Cookie（至少含 _greasyfork_session，有 cf_clearance 也一起带上），然后运行 `node lib/cli.js auth set` 粘贴保存，或调用 greasyfork_auth(action="set")。',
  E_AUTH_EXPIRED:
    '会话已失效。重新登录 greasyfork.org，复制新的 Cookie 覆盖旧值（auth set 会直接覆盖）。',
  E_CLOUDFLARE:
    '请求被 Cloudflare 挑战拦截。请用同一个浏览器把 Cookie 完整导出（包含 cf_clearance），或先在浏览器里打开 greasyfork.org 通过一次验证再重试。',
  E_RATE_LIMITED:
    'GreasyFork 对该账号做了频率限制。等一段时间再发布，或减少连续发布次数。',
  E_NOT_AUTHOR:
    '当前登录账号不是该脚本的作者，无法发布新版本。确认 scriptId 是否正确、Cookie 是否属于脚本作者账号。',
  E_CSRF:
    'CSRF 令牌无效（通常是 Cookie 过期或站点刚更新）。重新执行一次即可；连续失败请重新登录并更新 Cookie。',
  E_VALIDATION:
    '元数据或代码未通过 GreasyFork 校验。按 errors 里的提示修正后重发；带 override 的告警可在确认无误后加对应覆盖项或 acceptWarnings=true。',
  E_VERSION_CONFLICT:
    '版本号没有递增。把 @version 改成比线上更大的值（建议语义化版本，如 1.2.4 → 1.2.5），或用 versionCheckOverride 明确覆盖。',
  E_NETWORK: '网络请求失败。检查网络/代理后重试。',
  E_TIMEOUT: '请求超时。检查网络，或在插件 config 里调大 timeoutMs。',
  E_HTTP: 'GreasyFork 返回了非预期状态码。稍后重试；持续出现请附上 message 里的状态码排查。',
  E_SOURCE_MISSING: '找不到脚本文件。确认路径（相对路径以当前会话工作目录为基准）或改用 code 直接传内容。',
  E_SOURCE_EMPTY: '脚本内容为空。检查文件是否为空或读到了错误路径。',
  E_BAD_META: '元数据块无法解析。确认文件以 `// ==UserScript==` 开头、以 `// ==/UserScript==` 结束，且每行是 `// @key value`。',
  E_SCRIPT_NOT_FOUND: 'GreasyFork 上找不到该脚本。确认 scriptId/URL 正确，或改用 create 模式新建。',
  E_RECAPTCHA:
    '该账号发布新脚本时被要求过人机验证。改用 mode="prefill" 走降级流程（表单已预填，只需在浏览器点一次发布），或用已存在脚本走 update（更新不需要验证码）。',
  E_RESTRICTED:
    '账号当前状态不允许发脚本（未验证邮箱 / 新账号限流 / 需要安全登录）。按 hint 在网页上完成一次账号验证后再试。',
  E_NO_CHANGES:
    '代码和版本号都与线上最新版一致，没有可发布的内容。递增 @version 或修改代码后重试；确实要重发同一版本可传 force=true。',
  E_BAD_ARGUMENT: '参数不合法。按 message 里的字段说明修正。',
  E_UNSUPPORTED: '当前平台/配置不支持该操作。',
  E_STORAGE: '凭证文件读写失败。检查 ~/.dsh/greasyfork 目录权限（应为当前用户可写、0600）。'
}

/** 带错误码的异常。 */
export class GreasyForkError extends Error {
  /**
   * @param {GreasyForkErrorCode|string} code
   * @param {string} message
   * @param {{ hint?: string, details?: unknown, cause?: unknown, retryable?: boolean }} [extra]
   */
  constructor(code, message, extra = {}) {
    super(message, extra.cause === undefined ? undefined : { cause: extra.cause })
    this.name = 'GreasyForkError'
    this.code = code
    this.hint = extra.hint ?? ERROR_HINTS[code] ?? ''
    this.details = extra.details
    this.retryable = extra.retryable ?? false
  }

  /** 转成工具结果里的失败对象（纯 JSON）。 */
  toResult(extra = {}) {
    return failure(this.code, this.message, { hint: this.hint, details: this.details, ...extra })
  }
}

/**
 * 构造统一的失败返回体。
 * @param {string} code
 * @param {string} message
 * @param {{ hint?: string, details?: unknown, errors?: unknown[], warnings?: unknown[], [key: string]: unknown }} [extra]
 */
export function failure(code, message, extra = {}) {
  const { hint, details, ...rest } = extra
  return {
    ok: false,
    code,
    message,
    hint: hint ?? ERROR_HINTS[code] ?? '',
    ...(details === undefined ? {} : { details }),
    ...rest
  }
}

/** 把任意异常收敛成失败返回体，绝不把堆栈或凭证写进去。 */
export function failureFromError(error, fallbackCode = 'E_UNSUPPORTED') {
  if (error instanceof GreasyForkError) {
    const result = error.toResult()
    // Cloudflare 只拦 Node 的 TLS 指纹：提示用户让浏览器通道活着
    if (result.code === 'E_CLOUDFLARE' && !result.hint) {
      result.hint =
        '先在 设置 → GreasyFork 点一次「运行自检」，让登录窗口保持打开，然后重试：插件会改借浏览器发请求，Cloudflare 拦不住。'
    }
    return result
  }
  if (error && error.name === 'AbortError') {
    return failure('E_TIMEOUT', '请求被取消或超时。')
  }
  const message = error instanceof Error ? error.message : String(error)
  return failure(fallbackCode, message || '未知错误。')
}
