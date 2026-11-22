/**
 * 设置页的宿主半边：HTTP 路由 + 凭证解析 / 校验 / 落盘。
 *
 * 设计前提（2.0 起）：**只做手动凭证，不驱动任何浏览器**。
 * 用户从浏览器里把 Cookie 导出（Cookie-Editor / EditThisCookie / DevTools / cookies.txt），
 * 粘贴到这里；这里负责把它解析成标准 Cookie 头、校验一次、算出有效期再落盘。
 *
 * 路由（都挂在 ctx.webServer 的 /api/greasyfork 下）：
 *   GET  /status      当前凭证状态（账号、有效期、来源、校验结果）
 *   POST /parse       只解析不保存：把任意格式转成 Cookie 头并回显解析结果
 *   POST /credential  解析 → 校验 → 保存
 *   POST /verify      强制重新校验
 *   POST /clear       删除本地凭证
 */

import { GreasyForkClient } from './core/client.js'
import {
  clearCredentialFile,
  credentialFilePath,
  describeCookieExpiry,
  detectCookieFormat,
  normalizeCookieInput,
  parseCookieEntries,
  readCredentialFile,
  redactCookie,
  resolveCredential,
  saveCredential
} from './core/credentials.js'

const API_PREFIX = '/api/greasyfork'
const MAX_BODY_BYTES = 64 * 1024
const CACHE_TTL_MS = 20_000

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra
  })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (text === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('invalid json'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * 装配设置页的宿主面。
 * @param {{ ctx: any, webServer?: any, config: any, credentials?: any, probe?: Function, logger?: any }} options
 */
export function createSettingsSurface(options = {}) {
  const { ctx, config, credentials, logger } = options
  const webServer = options.webServer ?? (typeof ctx?.get === 'function' ? ctx.get('webServer') : ctx?.webServer)
  const site = String(config.site || 'https://greasyfork.org').replace(/\/+$/, '')

  const makeClient = (cookie) =>
    new GreasyForkClient({
      site,
      apiSite: config.apiSite,
      locale: config.locale,
      timeoutMs: config.timeoutMs,
      userAgent: config.userAgent,
      cookie
    })

  const probe =
    options.probe ??
    (async (cookie) => {
      const client = makeClient(cookie)
      return client.whoami()
    })

  let cache = { at: 0, value: null }

  async function statusPayload(force = false) {
    if (!force && cache.value && Date.now() - cache.at < CACHE_TTL_MS) return cache.value

    const resolved = await resolveCredential({ credentials, env: process.env }).catch(() => null)
    const file = await readCredentialFile(process.env).catch(() => null)

    if (!resolved) {
      const payload = {
        ok: true,
        configured: false,
        valid: false,
        storage: credentialFilePath(process.env),
        savedAt: null,
        expiry: null,
        format: null
      }
      cache = { at: Date.now(), value: payload }
      return payload
    }

    const entries = parseCookieEntries(resolved.cookie)
    const expiry = describeCookieExpiry(entries)
    let valid = null
    let username = resolved.username ?? null
    let userId = null
    let verifyError = null
    try {
      const who = await probe(resolved.cookie)
      valid = who.authenticated === true
      username = who.username ?? username
      userId = who.userId ?? null
    } catch (error) {
      // Cloudflare 拦住校验请求 ≠ 凭证失效，状态保持"判断不了"
      verifyError = error?.message ?? String(error)
      valid = null
    }

    const payload = {
      ok: true,
      configured: true,
      valid,
      verifyError,
      username,
      userId,
      source: resolved.source,
      storage: file?.file ?? credentialFilePath(process.env),
      savedAt: file?.savedAt ?? null,
      format: file?.format ?? detectCookieFormat(resolved.cookie),
      expiry,
      cookie: redactCookie(resolved.cookie)
    }
    cache = { at: Date.now(), value: payload }
    return payload
  }

  /** 解析一段粘贴内容，返回给前端预览（不落盘、不校验）。 */
  function parsePayload(raw) {
    const entries = parseCookieEntries(raw)
    const cookie = normalizeCookieInput(raw)
    return {
      ok: entries.length > 0,
      format: detectCookieFormat(raw),
      cookieCount: entries.length,
      cookieNames: entries.map((entry) => entry.name),
      hasSession: entries.some((entry) => entry.name === '_greasyfork_session'),
      expiry: describeCookieExpiry(entries),
      // 只回长度，不回原文
      headerLength: cookie.length,
      sample: entries.slice(0, 6).map((entry) => `${entry.name}=${entry.value.slice(0, 4)}…`)
    }
  }

  const routes = []

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/status`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      try {
        const force = String(req.url ?? '').includes('force=1')
        return sendJson(res, 200, await statusPayload(force))
      } catch (error) {
        return sendJson(res, 500, { ok: false, code: 'E_STATUS', message: error?.message ?? String(error) })
      }
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/parse`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      let body
      try {
        body = await readJson(req)
      } catch {
        return sendJson(res, 400, { ok: false, code: 'E_BAD_BODY', message: '请求体不是合法 JSON。' })
      }
      return sendJson(res, 200, parsePayload(body.cookie))
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/credential`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      let body
      try {
        body = await readJson(req)
      } catch {
        return sendJson(res, 400, { ok: false, code: 'E_BAD_BODY', message: '请求体不是合法 JSON。' })
      }

      const parsed = parsePayload(body.cookie)
      if (!parsed.ok) {
        return sendJson(res, 400, {
          ok: false,
          code: 'E_NO_CREDENTIAL',
          message: '没解析出任何 Cookie。请确认复制的是完整导出内容。',
          parsed
        })
      }
      if (!parsed.hasSession) {
        return sendJson(res, 400, {
          ok: false,
          code: 'E_NO_CREDENTIAL',
          message: '里面没有 _greasyfork_session，这不像 greasyfork.org 的登录 Cookie。',
          parsed
        })
      }

      const cookie = normalizeCookieInput(body.cookie)
      let who = { authenticated: false }
      let verifyError = null
      try {
        who = await probe(cookie)
      } catch (error) {
        verifyError = error?.message ?? String(error)
      }
      // 校验被 Cloudflare 拦住时仍然保存，只标注"未校验"
      const undetermined = verifyError !== null
      if (!who.authenticated && !undetermined) {
        return sendJson(res, 401, {
          ok: false,
          code: 'E_AUTH_EXPIRED',
          message: 'Cookie 未通过登录校验（已过期，或不是这个站点的登录态）。请重新登录后再导出。',
          parsed
        })
      }

      const saved = await saveCredential(
        {
          cookie,
          username: who.username ?? null,
          userId: who.userId ?? null,
          site,
          format: parsed.format
        },
        { credentials }
      )
      cache = { at: 0, value: null }
      logger?.info?.('greasyfork: 已保存手动录入的凭证（账号 %s）', who.username ?? '未校验')
      return sendJson(res, 200, {
        ok: true,
        verified: who.authenticated === true,
        verifyError,
        storage: saved.file,
        username: who.username ?? null,
        userId: who.userId ?? null,
        format: parsed.format,
        expiry: saved.expiry,
        cookie: redactCookie(cookie)
      })
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/verify`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      try {
        return sendJson(res, 200, await statusPayload(true))
      } catch (error) {
        return sendJson(res, 500, { ok: false, code: 'E_STATUS', message: error?.message ?? String(error) })
      }
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/clear`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      try {
        const file = await clearCredentialFile(process.env)
        cache = { at: 0, value: null }
        return sendJson(res, 200, {
          ok: true,
          storage: file,
          note: process.env.GREASYFORK_COOKIE ? '环境变量 GREASYFORK_COOKIE 仍然生效，需要一并清除。' : null
        })
      } catch (error) {
        return sendJson(res, 500, { ok: false, code: 'E_STORAGE', message: error?.message ?? String(error) })
      }
    }
  })

  return {
    routes,
    statusPayload,
    parsePayload,
    manager: {
      status: () => ({ alive: false, mode: null, browser: null }),
      dispose: async () => {}
    },
    detectedBrowser: null
  }
}

/**
 * 把路由挂到 webServer 上。
 * 必须由调用方在 `ctx.inject(['webServer'], …)` 里调用，否则服务还没就绪，
 * 路由会静默不注册（这正是 1.1.0 里面板显示 "not found" 的原因）。
 * @returns {() => void} disposer
 */
export function installSettingsRoutes(ctx, config, options = {}) {
  const webServer = options.webServer ?? (typeof ctx?.get === 'function' ? ctx.get('webServer') : ctx?.webServer)
  if (!webServer || typeof webServer.register !== 'function') return () => {}
  const surface = createSettingsSurface({ ctx, webServer, config, ...options })
  const disposers = surface.routes.map((route) => webServer.register(route))
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 已经卸载 */
      }
    }
  }
}
