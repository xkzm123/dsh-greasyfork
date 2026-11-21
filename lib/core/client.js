/**
 * GreasyFork HTTP 客户端。
 *
 * 事实依据（2026-11 核对 greasyfork 源码与线上行为）：
 *  - 站点没有写接口，发布/更新走的是网页表单：
 *      POST /:locale/script_versions                    → 新建脚本（script_versions#create）
 *      POST /:locale/scripts/:id/versions               → 新版本（script_versions#create, 嵌套）
 *      PATCH /:locale/scripts/:id/sync_update           → 从 sync_identifier 拉取更新
 *      POST /:locale/script_versions/prefill            → 官方"预填表单"降级通道（跳过 CSRF）
 *  - 鉴权是 Rails cookie session，cookie 名 `_greasyfork_session`（cookie_store）；
 *    生产站点挂了 Cloudflare，因此完整 Cookie（含 cf_clearance）成功率最高。
 *  - 所有非 prefill 的写请求都要 `authenticity_token`（全局 CSRF，不是 per-form）。
 *  - 只读数据走 JSON：/:locale/scripts/:id.json 与 /:locale/scripts/:id/versions.json
 *    （api.greasyfork.org 同样可用，且更少被 Cloudflare 挑战）。
 */

import { GreasyForkError } from './errors.js'
import { extractScriptId } from './meta.js'

export const DEFAULT_SITE = 'https://greasyfork.org'
export const DEFAULT_API_SITE = 'https://api.greasyfork.org'
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
export const ACCEPT_HTML =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'

/** 极简 cookie 罐：解析、合并 Set-Cookie、输出 Cookie 头。 */
export class CookieJar {
  /** @param {string} [initial] 形如 `a=1; b=2` 或浏览器导出的多行文本 */
  constructor(initial = '') {
    /** @type {Map<string, string>} */
    this.map = new Map()
    this.absorb(initial)
  }

  /** 合并一段 Cookie 文本（也接受 `name=value` 单值）。 */
  absorb(raw) {
    if (!raw) return
    const text = String(raw).replace(/\r?\n/g, '; ')
    for (const part of text.split(';')) {
      const item = part.trim()
      if (!item) continue
      const i = item.indexOf('=')
      if (i <= 0) continue
      const name = item.slice(0, i).trim()
      const value = item.slice(i + 1).trim()
      if (!/^[A-Za-z0-9_.\-]+$/.test(name)) continue
      this.map.set(name, value)
    }
  }

  /** 吸收响应里的 Set-Cookie。 */
  absorbResponse(res) {
    const getSetCookie = res.headers?.getSetCookie
    const list = typeof getSetCookie === 'function' ? getSetCookie.call(res.headers) : []
    for (const line of list) {
      const first = String(line).split(';')[0]
      const i = first.indexOf('=')
      if (i <= 0) continue
      const name = first.slice(0, i).trim()
      const value = first.slice(i + 1).trim()
      const expired = /max-age=0/i.test(line) || /expires=thu, 01 jan 1970/i.test(line)
      if (value === '' || expired) this.map.delete(name)
      else this.map.set(name, value)
    }
  }

  /** 输出 Cookie 头；空串表示没有 cookie。 */
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  get size() {
    return this.map.size
  }

  names() {
    return [...this.map.keys()]
  }

  has(name) {
    return this.map.has(name)
  }

  /** 用于日志/结果的安全摘要：只有名字，没有值。 */
  describe() {
    const names = this.names()
    return {
      cookieCount: names.length,
      hasSession: this.map.has('_greasyfork_session'),
      hasCfClearance: this.map.has('cf_clearance'),
      names
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 判断是不是 Cloudflare 挑战/拦截页。 */
export function isCloudflareChallenge(status, headers, text) {
  if (headers && typeof headers.get === 'function') {
    if (headers.get('cf-mitigated') === 'challenge') return true
    if (headers.get('server') === 'cloudflare' && status === 403) return true
  }
  if (status !== 403 && status !== 429 && status !== 503) return false
  return /<title>\s*(Just a moment|Attention Required|请稍候)/i.test(text || '')
}

/** 判断响应是不是"未登录"页面（Rails/Devise 登录页）。 */
export function isSignInPage(text) {
  return /<title>[^<]*Sign in[^<]*<\/title>/i.test(text || '') || /id="new_user"[\s\S]{0,2000}sign_in/i.test(text || '')
}

/** 从页面 HTML 里取 CSRF 令牌（meta 优先，其次表单隐藏域）。 */
export function parseCsrfToken(html) {
  const meta = /<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i.exec(html)
  if (meta) return meta[1]
  const inputA = /<input[^>]+name="authenticity_token"[^>]+value="([^"]+)"/i.exec(html)
  if (inputA) return inputA[1]
  const inputB = /<input[^>]+value="([^"]+)"[^>]+name="authenticity_token"/i.exec(html)
  if (inputB) return inputB[1]
  return null
}

/** 账号状态页（新建页可能渲染这些分支而不是表单）。 */
const RESTRICTION_MARKERS = [
  { key: 'must_confirm', re: /You must confirm your account before you can post scripts/i, message: '账号需要先完成邮箱/外部登录验证才能发布脚本。' },
  { key: 'rate_limited', re: /You have posted too many scripts recently/i, message: '近期发布过于频繁，被站点限流。' },
  { key: 'delayed', re: /new accounts may not immediately post scripts/i, message: '新账号有延迟发布限制。' },
  { key: 'needs_secure_login', re: /secure login|Two-factor|2FA/i, message: '账号需要更安全的登录方式（邮箱验证/二次验证）。' },
  { key: 'disposable_email', re: /disposable email address/i, message: '使用了临时邮箱域名，站点禁止发布。' },
  { key: 'new_script_notice', re: /What are you trying to do\?/i, message: '首次发布前的说明页（不影响直接 POST，仅提示）。' }
]

/**
 * 分析"新建/更新表单页"。
 * @param {string} html
 */
export function analyzeFormPage(html) {
  const token = parseCsrfToken(html)
  const hasForm = /name="script_version\[code\]"/i.test(html) || /id="script_version_code"/i.test(html)
  const signedIn = !isSignInPage(html)
  const restriction = RESTRICTION_MARKERS.find((r) => r.re.test(html)) ?? null
  return { token, hasForm, signedIn, restriction, html }
}

/** 从渲染后的表单页里抓校验错误与需要勾选的覆盖项。 */
export function parseValidationErrors(html) {
  const blockMatch = /<div class="validation-errors">([\s\S]*?)<\/div>\s*(?:<div|<%|\n\s*<)/i.exec(html) ||
    /<div class="validation-errors">([\s\S]*?)<\/div>/i.exec(html)
  const block = blockMatch ? blockMatch[1] : ''
  const messages = []
  const re = /<p[^>]*>([\s\S]*?)<\/p>/gi
  let m
  while ((m = re.exec(block)) !== null) {
    const text = stripTags(m[1])
    if (text) messages.push(text)
  }
  const overrides = []
  const overrideRe = /id="script_version_(version_check_override|add_missing_version|namespace_check_override|add_missing_namespace|minified_confirmation|sensitive_site_confirmation|allow_code_previously_posted|license_missing_override|meta_not_at_start_confirmation)"/g
  let om
  while ((om = overrideRe.exec(html)) !== null) if (!overrides.includes(om[1])) overrides.push(om[1])
  const recaptcha = /recaptcha/i.test(html)
  return { messages, overrides, recaptcha, hasErrorBlock: Boolean(blockMatch) }
}

/** 去掉标签并解码常见实体。 */
export function stripTags(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * 表单字段名 ↔ 覆盖项名字的映射（驼峰 → Rails 参数）。
 * @type {Record<string, string>}
 */
export const OVERRIDE_PARAM = {
  versionCheckOverride: 'version_check_override',
  addMissingVersion: 'add_missing_version',
  namespaceCheckOverride: 'namespace_check_override',
  addMissingNamespace: 'add_missing_namespace',
  minifiedConfirmation: 'minified_confirmation',
  sensitiveSiteConfirmation: 'sensitive_site_confirmation',
  allowCodePreviouslyPosted: 'allow_code_previously_posted',
  licenseMissingOverride: 'license_missing_override',
  metaNotAtStartConfirmation: 'meta_not_at_start_confirmation',
  notJsConvertibleOverride: 'not_js_convertible_override'
}

/** 把覆盖项对象翻成表单字段（值为真才带上）。 */
export function overrideFields(overrides = {}) {
  const out = {}
  for (const [camel, param] of Object.entries(OVERRIDE_PARAM)) {
    if (overrides[camel]) out[`script_version[${param}]`] = '1'
  }
  return out
}

export class GreasyForkClient {
  /**
   * @param {{
   *   site?: string, apiSite?: string, locale?: string, cookie?: string,
   *   userAgent?: string, timeoutMs?: number, fetchImpl?: typeof fetch, signal?: AbortSignal
   * }} [options]
   */
  constructor(options = {}) {
    this.site = String(options.site || DEFAULT_SITE).replace(/\/+$/, '')
    this.apiSite = String(options.apiSite || DEFAULT_API_SITE).replace(/\/+$/, '')
    this.locale = options.locale || 'en'
    this.jar = new CookieJar(options.cookie || '')
    this.userAgent = options.userAgent || DEFAULT_USER_AGENT
    this.timeoutMs = Number.isFinite(options.timeoutMs) ? Number(options.timeoutMs) : 30000
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.signal = options.signal
    /** @type {Array<{method: string, url: string, status: number}>} */
    this.trace = []
  }

  /** 相对站点路径。 */
  path(p) {
    return `/${this.locale}${p.startsWith('/') ? p : `/${p}`}`
  }

  /** 组装请求信号：调用方取消 + 超时。 */
  #signal() {
    const timeout = AbortSignal.timeout(this.timeoutMs)
    if (!this.signal) return timeout
    return AbortSignal.any([this.signal, timeout])
  }

  /** 是否该给这个 URL 带上会话 Cookie（只发给站点自身，不发跨域 CDN）。 */
  #shouldSendCookies(url) {
    try {
      const host = new URL(url).host
      return host === new URL(this.site).host || host === new URL(this.apiSite).host
    } catch {
      return false
    }
  }

  /**
   * 发一个请求（默认不自动跟随重定向，因为 POST 的成功信号就是 302）。
   * @param {string} pathOrUrl
   * @param {{ method?: string, form?: Record<string, unknown>, body?: BodyInit, formData?: FormData,
   *   headers?: Record<string,string>, base?: string, expectJson?: boolean, follow?: number,
   *   retries?: number }} [options]
   */
  async request(pathOrUrl, options = {}) {
    const {
      method = 'GET',
      form,
      body,
      formData,
      headers = {},
      base = this.site,
      expectJson = false,
      follow = 0,
      retries = 0
    } = options
    let url = /^https?:/i.test(pathOrUrl) ? pathOrUrl : `${base}${pathOrUrl}`
    const h = {
      'user-agent': this.userAgent,
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      ...(expectJson ? { accept: 'application/json, text/plain, */*' } : { accept: ACCEPT_HTML }),
      ...headers
    }
    let payload = body
    if (form) {
      const usp = new URLSearchParams()
      for (const [key, value] of Object.entries(form)) {
        if (value === undefined || value === null || value === '') continue
        usp.append(key, String(value))
      }
      payload = usp.toString()
      h['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
    }
    if (formData) payload = formData
    if (payload !== undefined && !h['content-type'] && !formData) {
      h['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8'
    }

    for (let redirects = 0; ; redirects += 1) {
      // 只给站点自己发 Cookie：跨域（例如 update.greasyfork.org 的代码下载）不带会话。
      if (this.jar.size > 0 && this.#shouldSendCookies(url)) h.cookie = this.jar.header()
      else delete h.cookie
      let res
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: h,
          body: payload,
          redirect: 'manual',
          signal: this.#signal()
        })
      } catch (err) {
        if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          if (this.signal && this.signal.aborted) throw new GreasyForkError('E_TIMEOUT', '操作已取消。')
          throw new GreasyForkError('E_TIMEOUT', `请求超时（>${this.timeoutMs}ms）：${url}`)
        }
        if (retries > 0) {
          retries -= 1
          await sleep(300)
          continue
        }
        throw new GreasyForkError('E_NETWORK', `网络请求失败：${err?.message ?? err}`, { cause: err })
      }
      this.jar.absorbResponse(res)
      const text = await res.text()
      const location = res.headers.get('location')
      this.trace.push({ method, url, status: res.status })
      const shouldFollow = follow > 0 && [301, 302, 303, 307, 308].includes(res.status) && location && redirects < follow
      if (shouldFollow) {
        url = new URL(location, url).href
        if (res.status === 303) {
          method = 'GET'
          payload = undefined
          delete h['content-type']
        }
        continue
      }
      return { status: res.status, headers: res.headers, text, url, location: location ? new URL(location, url).href : null }
    }
  }

  /** GET 并跟随重定向。 */
  async get(pathOrUrl, options = {}) {
    return this.request(pathOrUrl, { ...options, method: 'GET', follow: options.follow ?? 5, retries: options.retries ?? 1 })
  }

  /** 只读：脚本 JSON。不存在返回 undefined。 */
  async getScript(scriptIdOrUrl) {
    const id = extractScriptId(scriptIdOrUrl)
    if (!id) throw new GreasyForkError('E_SCRIPT_NOT_FOUND', `无法从 ${JSON.stringify(scriptIdOrUrl)} 解析出 GreasyFork 脚本 id。`)
    const res = await this.request(this.path(`/scripts/${id}.json`), { base: this.apiSite, expectJson: true, retries: 1, follow: 3 })
    if (res.status === 404) return undefined
    if (isCloudflareChallenge(res.status, res.headers, res.text)) {
      throw new GreasyForkError('E_CLOUDFLARE', '读取脚本信息被 Cloudflare 拦截。')
    }
    if (res.status !== 200) {
      throw new GreasyForkError('E_HTTP', `读取脚本 ${id} 失败：HTTP ${res.status}`)
    }
    try {
      return JSON.parse(res.text)
    } catch {
      throw new GreasyForkError('E_HTTP', `脚本 ${id} 的 JSON 无法解析。`)
    }
  }

  /** 只读：版本列表（新→旧）。 */
  async getVersions(scriptId) {
    const id = extractScriptId(scriptId)
    if (!id) throw new GreasyForkError('E_SCRIPT_NOT_FOUND', '缺少脚本 id。')
    const res = await this.request(this.path(`/scripts/${id}/versions.json`), {
      base: this.apiSite,
      expectJson: true,
      retries: 1,
      follow: 3
    })
    if (res.status === 404) return []
    if (res.status !== 200) {
      throw new GreasyForkError('E_HTTP', `读取脚本 ${id} 版本列表失败：HTTP ${res.status}`)
    }
    try {
      const parsed = JSON.parse(res.text)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /** 只读：脚本页面上的元信息（script_type / language），用于更新时保持原可见性。 */
  async getScriptPageInfo(scriptId) {
    const id = extractScriptId(scriptId)
    if (!id) return null
    try {
      const res = await this.get(this.path(`/scripts/${id}`), { follow: 3 })
      if (res.status !== 200) return null
      const type = /data-script-type="([a-z]+)"/.exec(res.text)?.[1] ?? null
      const language = /data-script-language="([a-z]+)"/.exec(res.text)?.[1] ?? null
      return { scriptType: type, language }
    } catch {
      return null
    }
  }

  /** 只读：线上最新版本代码（用于判断"代码有没有变"）。 */
  async getLatestCode(script) {
    const url = script?.code_url
    if (!url) return null
    try {
      const res = await this.request(url, { base: this.site, retries: 1, follow: 3 })
      if (res.status !== 200) return null
      return res.text
    } catch {
      return null
    }
  }

  /** 取 CSRF 令牌 + 表单页状态。scriptId 存在时走"更新表单"。 */
  async getFormPage(scriptId) {
    const id = scriptId === undefined || scriptId === null ? null : extractScriptId(scriptId)
    const path = id ? this.path(`/scripts/${id}/versions/new`) : this.path('/script_versions/new')
    const res = await this.get(path, { headers: { referer: `${this.site}/` } })
    if (isCloudflareChallenge(res.status, res.headers, res.text)) {
      throw new GreasyForkError('E_CLOUDFLARE', '打开发布表单时被 Cloudflare 挑战拦截。')
    }
    if (res.status === 403) {
      throw new GreasyForkError('E_NOT_AUTHOR', id ? `当前账号不是脚本 ${id} 的作者，无法发布新版本。` : '账号无权访问发布表单。')
    }
    if (res.status === 404) {
      throw new GreasyForkError('E_SCRIPT_NOT_FOUND', id ? `脚本 ${id} 不存在。` : '发布表单地址不存在。')
    }
    if (res.status !== 200) {
      throw new GreasyForkError('E_HTTP', `打开发布表单失败：HTTP ${res.status}`)
    }
    const analyzed = analyzeFormPage(res.text)
    if (!analyzed.signedIn) {
      throw new GreasyForkError('E_AUTH_EXPIRED', '会话已失效（打开表单时被跳转到登录页）。')
    }
    if (analyzed.restriction && analyzed.restriction.key !== 'new_script_notice') {
      throw new GreasyForkError('E_RESTRICTED', analyzed.restriction.message, {
        details: { page: analyzed.restriction.key }
      })
    }
    if (!analyzed.token) {
      throw new GreasyForkError('E_CSRF', '发布表单页里没有找到 CSRF 令牌。')
    }
    return { ...analyzed, url: res.url }
  }

  /** 新建脚本：POST /:locale/script_versions */
  async createScript({ token, code, scriptType = 1, overrides = {}, importUrl, syncType, language = 'js', localeId }) {
    const form = {
      authenticity_token: token,
      'script_version[code]': code,
      'script[script_type]': String(scriptType),
      language,
      ...overrideFields(overrides)
    }
    if (localeId) form['script[locale_id]'] = String(localeId)
    if (importUrl) {
      form.import_url = importUrl
      form.sync_type = syncType || 'manual'
    }
    return this.request(this.path('/script_versions'), {
      method: 'POST',
      form,
      headers: { referer: `${this.site}${this.path('/script_versions/new')}`, origin: this.site }
    })
  }

  /** 发布新版本：POST /:locale/scripts/:id/versions */
  async createVersion({ scriptId, token, code, changelog, scriptType = 1, overrides = {}, language = 'js' }) {
    const id = extractScriptId(scriptId)
    if (!id) throw new GreasyForkError('E_BAD_ARGUMENT', '缺少有效的 scriptId。')
    const form = {
      authenticity_token: token,
      'script_version[code]': code,
      'script[script_type]': String(scriptType),
      language,
      ...overrideFields(overrides)
    }
    if (changelog) form['script_version[changelog]'] = changelog
    return this.request(this.path(`/scripts/${id}/versions`), {
      method: 'POST',
      form,
      headers: { referer: `${this.site}${this.path(`/scripts/${id}/versions/new`)}`, origin: this.site }
    })
  }

  /**
   * 官方降级通道：把代码 POST 到 prefill，站点会渲染"已填好代码"的表单。
   * 该接口显式跳过 CSRF（GreasyFork help/api 有说明），但用户仍需在浏览器点一次发布。
   */
  async prefill({ code, scriptId }) {
    const id = scriptId === undefined || scriptId === null ? null : extractScriptId(scriptId)
    const path = id ? this.path(`/scripts/${id}/versions/prefill`) : this.path('/script_versions/prefill')
    const formData = new FormData()
    formData.append('script_version[code]', code)
    const res = await this.request(path, {
      method: 'POST',
      formData,
      headers: { referer: `${this.site}${id ? this.path(`/scripts/${id}/versions/new`) : this.path('/script_versions/new')}`, origin: this.site }
    })
    if (isCloudflareChallenge(res.status, res.headers, res.text)) {
      throw new GreasyForkError('E_CLOUDFLARE', '预填表单时被 Cloudflare 拦截。')
    }
    if (res.status === 302 && res.location && /sign_in/.test(res.location)) {
      throw new GreasyForkError('E_AUTH_EXPIRED', '会话已失效，预填表单被跳转到登录页。')
    }
    const analyzed = analyzeFormPage(res.text)
    return { ok: res.status === 200 && analyzed.hasForm, status: res.status, hasForm: analyzed.hasForm, html: res.text }
  }

  /** 让 GreasyFork 从 sync_identifier 重新拉取代码并生成新版本。 */
  async syncUpdate({ scriptId, syncIdentifier, syncType = 'manual', trigger = true, token }) {
    const id = extractScriptId(scriptId)
    if (!id) throw new GreasyForkError('E_BAD_ARGUMENT', '缺少有效的 scriptId。')
    const form = {
      authenticity_token: token,
      'script[sync_type]': syncType,
      'script[sync_identifier]': syncIdentifier
    }
    if (trigger) form['update-and-sync'] = '1'
    return this.request(this.path(`/scripts/${id}/sync_update`), {
      method: 'PATCH',
      form,
      headers: { referer: `${this.site}${this.path(`/scripts/${id}/admin`)}`, origin: this.site }
    })
  }

  /** 探测登录状态（不抛异常）。 */
  async whoami() {
    // 两个"必须登录才能看"的页面互为兜底：/users/edit 是账号设置页，
    // /users/webhook-info 是 webhook 设置页。任一返回 200 且不是登录页，就认为已登录。
    const probes = ['/users/edit', '/users/webhook-info']
    let sawSignIn = false
    for (const path of probes) {
      const res = await this.get(this.path(path), { headers: { referer: `${this.site}/` } })
      if (isCloudflareChallenge(res.status, res.headers, res.text)) {
        throw new GreasyForkError('E_CLOUDFLARE', '校验登录状态时被 Cloudflare 拦截。', {
          hint: '用浏览器打开一次 greasyfork.org 通过验证，或稍后重试。'
        })
      }
      if (isSignInPage(res.text)) {
        sawSignIn = true
        continue
      }
      if (res.status !== 200) continue
      const nameMatch =
        /name="user\[name\]"[^>]*value="([^"]*)"/i.exec(res.text) ||
        /value="([^"]*)"[^>]*name="user\[name\]"/i.exec(res.text)
      const idMatch = /\/users\/(\d+)(?:-|\/webhook)/.exec(res.text)
      return {
        authenticated: true,
        username: nameMatch ? nameMatch[1] : null,
        userId: idMatch ? Number.parseInt(idMatch[1], 10) : null,
        cookie: this.jar.describe()
      }
    }
    return { authenticated: false, sawSignIn }
  }
}
