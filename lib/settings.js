/**
 * 设置页的宿主半边：HTTP 路由 + 助手脚本生成。
 *
 * 浏览器里的设置面板（lib/client.js）只负责界面，所有真正的事——读凭证状态、
 * 校验 Cookie、落盘、打开系统浏览器——都在这里，经由 `ctx.webServer` 的
 * `/api/greasyfork/*` 路由完成。
 *
 * 为什么需要"助手脚本"：
 *   GreasyFork 的 `_greasyfork_session` 是 **HttpOnly** Cookie（线上 Set-Cookie
 *   实测带 `httponly`），所以 DevTools 控制台里的 `document.cookie` 读不到它，
 *   浏览器 Cookie 数据库在现代 Chrome/Edge 上又是 App-Bound 加密（v20），
 *   外部进程解不开。真正能"一键拿到"的路径只有一条：在 greasyfork.org 页面里
 *   以用户脚本身份调用 `GM_cookie`（Tampermonkey 的 cookies API），拿到值后
 *   复制到剪贴板、并直接 POST 回本机插件。
 *
 * 于是这里提供：
 *   - `/api/greasyfork/helper.user.js`  生成并直接提供该用户脚本（点开即装）
 *   - `/api/greasyfork/beacon`          助手脚本把 Cookie 回传到这里
 *   - `/api/greasyfork/snippet`         控制台版片段（能读到的部分 + 诚实说明）
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { GreasyForkClient } from './core/client.js'
import {
  credentialFilePath,
  normalizeCookieInput,
  redactCookie,
  resolveCredential,
  saveCredential
} from './core/credentials.js'
import { clearCredentialFile } from './core/credentials.js'

const API_PREFIX = '/api/greasyfork'
const LOGIN_URL = 'https://greasyfork.org/en/users/sign_in'
const MAX_BODY_BYTES = 64 * 1024

/** 允许跨源访问的路径：助手脚本从 greasyfork.org 页面发起请求。 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600'
}

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra
  })
  res.end(text)
}

function sendText(res, status, body, contentType, extra = {}) {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', ...extra })
  res.end(body)
}

/** 读 JSON 请求体（限长）。 */
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

/** 用系统默认浏览器打开一个 URL（失败不抛）。 */
function openExternal(url) {
  const platform = process.platform
  const command = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * 生成"Cookie 助手"用户脚本。
 * @param {{ origin: string, token: string, site: string }} options
 */
export function buildHelperUserscript({ origin, token, site = 'https://greasyfork.org' }) {
  const endpoint = `${origin}${API_PREFIX}/beacon`
  const match = `${site.replace(/\/+$/, '')}/*`
  return `// ==UserScript==
// @name         DSH GreasyFork Cookie 助手
// @namespace    https://github.com/xkzm123/dsh-greasyfork
// @version      1.0.0
// @description  一键把 GreasyFork 登录 Cookie 复制到剪贴板，并回传给本机 DeepSeek Harness 的 greasyfork 插件
// @author       dsh-greasyfork
// @match        ${match}
// @grant        GM_cookie
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict'

  var ENDPOINT = ${JSON.stringify(endpoint)}
  var TOKEN = ${JSON.stringify(token)}

  function el(tag, style, text) {
    var node = document.createElement(tag)
    if (style) node.setAttribute('style', style)
    if (text != null) node.textContent = text
    return node
  }

  var box = el('div', 'position:fixed;right:18px;bottom:18px;z-index:2147483647;display:flex;flex-direction:column;gap:8px;align-items:flex-end;font:12px/1.5 system-ui,-apple-system,sans-serif')
  var status = el('div', 'max-width:260px;padding:6px 10px;border-radius:8px;background:rgba(20,20,20,.88);color:#fff;display:none')
  var btn = el('button', 'cursor:pointer;border:0;border-radius:10px;padding:10px 14px;background:#2f6feb;color:#fff;font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25)', '把 Cookie 交给 DSH')

  function say(text, tone) {
    status.style.display = 'block'
    status.style.background = tone === 'error' ? 'rgba(160,30,30,.92)' : 'rgba(20,20,20,.88)'
    status.textContent = text
  }

  function readCookies(cb) {
    var done = false
    function finish(err, value) {
      if (done) return
      done = true
      cb(err, value)
    }
    try {
      if (typeof GM_cookie === 'undefined' || !GM_cookie || typeof GM_cookie.list !== 'function') {
        return finish(new Error('no-gm-cookie'), document.cookie)
      }
      var maybe = GM_cookie.list({ domain: 'greasyfork.org' }, function (cookies, err) {
        if (err) return finish(err)
        finish(null, cookies)
      })
      if (maybe && typeof maybe.then === 'function') {
        maybe.then(function (cookies) { finish(null, cookies) }, function (err) { finish(err) })
      }
    } catch (e) {
      finish(e)
    }
  }

  function toHeader(cookies) {
    if (typeof cookies === 'string') return cookies
    if (!Array.isArray(cookies)) return ''
    return cookies
      .filter(function (c) { return c && c.name && (c.domain || '').indexOf('greasyfork') !== -1 })
      .map(function (c) { return c.name + '=' + c.value })
      .join('; ')
  }

  btn.addEventListener('click', function () {
    btn.disabled = true
    say('正在读取 Cookie…')
    readCookies(function (err, cookies) {
      var header = toHeader(cookies)
      if (!header || header.indexOf('_greasyfork_session=') === -1) {
        btn.disabled = false
        say(err && err.message === 'no-gm-cookie'
          ? '当前脚本管理器不支持 GM_cookie，读不到 HttpOnly 的登录 Cookie。请改用「手动填入」。'
          : '没读到 _greasyfork_session：确认已登录 greasyfork.org 后刷新页面再试。', 'error')
        return
      }
      try { GM_setClipboard(header, 'text') } catch (e) {}
      say('已复制到剪贴板，正在回传…')
      try {
        GM_xmlhttpRequest({
          method: 'POST',
          url: ENDPOINT,
          headers: { 'content-type': 'application/json' },
          data: JSON.stringify({ token: TOKEN, cookie: header }),
          onload: function (res) {
            btn.disabled = false
            var data = {}
            try { data = JSON.parse(res.responseText) } catch (e) {}
            if (data && data.ok) {
              say('已交给 DSH' + (data.username ? '（账号 ' + data.username + '）' : '') + '，回去点一下「刷新状态」即可。')
              btn.textContent = '已交给 DSH'
            } else {
              say('回传失败：' + ((data && (data.message || data.code)) || ('HTTP ' + res.status)) + '（Cookie 已在剪贴板，可手动粘贴）', 'error')
            }
          },
          onerror: function () {
            btn.disabled = false
            say('连不上 DSH（127.0.0.1）。Cookie 已复制到剪贴板，请手动粘贴。', 'error')
          }
        })
      } catch (e) {
        btn.disabled = false
        say('Cookie 已复制到剪贴板，请手动粘贴到 DSH 设置页。', 'error')
      }
    })
  })

  box.appendChild(status)
  box.appendChild(btn)
  ;(document.body || document.documentElement).appendChild(box)
})()
`
}

/** 控制台片段：诚实说明 HttpOnly 限制。 */
export function buildConsoleSnippet({ origin }) {
  return `// 在已登录的 greasyfork.org 页面 → F12 → Console 里粘贴运行。
// 注意：_greasyfork_session 是 HttpOnly，浏览器控制台读不到它。
//   这段只能抓非 HttpOnly 的 Cookie；要拿登录 Cookie，请用设置页里的
//   「Cookie 助手」脚本（GM_cookie 能读 HttpOnly），或
//   DevTools → Application → Cookies → https://greasyfork.org 手动复制。
(function () {
  var all = document.cookie
  var hasSession = /(?:^|;\\s*)_greasyfork_session=/.test(all)
  if (!hasSession) {
    console.warn('[DSH] 没有读到 _greasyfork_session（HttpOnly）。请用「Cookie 助手」脚本，或从 Application → Cookies 复制。')
  }
  copy(all) // DevTools 的 copy()：复制到剪贴板
  return all
})()
`
}

/**
 * 装配设置页的宿主面。
 *
 * @param {{
 *   ctx: any, config: { site: string, apiSite: string, locale: string, timeoutMs: number, userAgent: string },
 *   credentials?: any,
 *   probe?: (cookie: string) => Promise<{ authenticated: boolean, username?: string|null, userId?: number|null }>,
 *   logger?: any
 * }} options
 */
export function createSettingsSurface(options) {
  const { ctx, config, credentials, logger } = options
  const token = randomBytes(16).toString('hex')
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

  /** whoami 结果缓存，避免面板轮询把 GreasyFork 打爆。 */
  let cache = { at: 0, value: null }
  async function statusPayload(force = false) {
    const resolved = await resolveCredential({ credentials, env: process.env })
    const base = {
      ok: true,
      configured: Boolean(resolved),
      storage: credentialFilePath(process.env),
      site,
      helperToken: token,
      loginUrl: LOGIN_URL
    }
    if (!resolved) return { ...base, valid: false, cookie: { present: false } }
    const now = Date.now()
    if (!force && cache.value && now - cache.at < 15000) {
      return { ...base, ...cache.value, source: resolved.source }
    }
    let who = { authenticated: false }
    try {
      who = await probe(resolved.cookie)
    } catch (error) {
      who = { authenticated: false, error: error?.message ?? String(error) }
    }
    const value = {
      valid: who.authenticated === true,
      username: who.username ?? resolved.username ?? null,
      userId: who.userId ?? null,
      cookie: redactCookie(resolved.cookie),
      error: who.authenticated ? null : who.error ?? null
    }
    cache = { at: now, value }
    return { ...base, ...value, source: resolved.source }
  }

  const routes = []

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/status`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      try {
        return sendJson(res, 200, await statusPayload(req.url?.includes('force=1') === true))
      } catch (error) {
        return sendJson(res, 500, { ok: false, code: 'E_STATUS', message: error?.message ?? String(error) })
      }
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
      const cookie = normalizeCookieInput(body.cookie)
      if (!cookie) {
        return sendJson(res, 400, { ok: false, code: 'E_NO_CREDENTIAL', message: 'Cookie 为空。' })
      }
      if (!/_greasyfork_session=/.test(cookie)) {
        return sendJson(
          res,
          400,
          {
            ok: false,
            code: 'E_NO_CREDENTIAL',
            message: 'Cookie 里没有 _greasyfork_session，这不像是 greasyfork.org 的登录 Cookie。'
          }
        )
      }
      let who = { authenticated: false }
      try {
        who = await probe(cookie)
      } catch (error) {
        return sendJson(
          res,
          502,
          { ok: false, code: 'E_NETWORK', message: `无法校验 Cookie：${error?.message ?? error}` }
        )
      }
      if (!who.authenticated) {
        return sendJson(
          res,
          401,
          {
            ok: false,
            code: 'E_AUTH_EXPIRED',
            message: 'Cookie 未通过登录校验（已过期或不是这个站点的）。请重新登录后导出。'
          }
        )
      }
      const saved = await saveCredential(
        { cookie, username: who.username ?? null, userId: who.userId ?? null, site },
        { credentials }
      )
      cache = { at: 0, value: null }
      return sendJson(
        res,
        200,
        { ok: true, storage: saved.file, username: who.username ?? null, userId: who.userId ?? null }
        )
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/beacon`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS)
        return res.end()
      }
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' }, CORS_HEADERS)
      let body
      try {
        body = await readJson(req)
      } catch {
        return sendJson(res, 400, { ok: false, code: 'E_BAD_BODY', message: '请求体不是合法 JSON。' }, CORS_HEADERS)
      }
      if (body.token !== token) {
        return sendJson(res, 403, { ok: false, code: 'E_FORBIDDEN', message: 'token 不匹配。' }, CORS_HEADERS)
      }
      const cookie = normalizeCookieInput(body.cookie)
      if (!/_greasyfork_session=/.test(cookie)) {
        return sendJson(res, 400, { ok: false, code: 'E_NO_CREDENTIAL', message: '回传内容里没有 _greasyfork_session。' }, CORS_HEADERS)
      }
      let who = { authenticated: false }
      try {
        who = await probe(cookie)
      } catch (error) {
        return sendJson(res, 502, { ok: false, code: 'E_NETWORK', message: String(error?.message ?? error) }, CORS_HEADERS)
      }
      if (!who.authenticated) {
        return sendJson(res, 401, { ok: false, code: 'E_AUTH_EXPIRED', message: '回传的 Cookie 已失效。' }, CORS_HEADERS)
      }
      await saveCredential({ cookie, username: who.username ?? null, userId: who.userId ?? null, site }, { credentials })
      cache = { at: 0, value: null }
      logger?.info?.('greasyfork: 已通过助手脚本接收凭证（账号 %s）', who.username ?? '未知')
      return sendJson(res, 200, { ok: true, username: who.username ?? null }, CORS_HEADERS)
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/verify`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      cache = { at: 0, value: null }
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
          note: process.env.GREASYFORK_COOKIE
            ? '环境变量 GREASYFORK_COOKIE 仍然生效，需要一并清除。'
            : null
        })
      } catch (error) {
        return sendJson(res, 500, { ok: false, code: 'E_STORAGE', message: error?.message ?? String(error) })
      }
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/open-login`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      const opened = openExternal(LOGIN_URL)
      return sendJson(res, 200, { ok: true, url: LOGIN_URL, opened })
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/snippet`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      const origin = originOf(req, ctx)
      return sendJson(res, 200, { ok: true, snippet: buildConsoleSnippet({ origin }) })
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/helper.user.js`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendText(res, 405, 'method not allowed', 'text/plain; charset=utf-8')
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token') !== token) {
        return sendText(res, 403, 'forbidden: bad token', 'text/plain; charset=utf-8')
      }
      const origin = originOf(req, ctx)
      const script = buildHelperUserscript({ origin, token, site })
      return sendText(res, 200, script, 'text/javascript; charset=utf-8', {
        'content-disposition': 'inline; filename="dsh-greasyfork-cookie-helper.user.js"'
      })
    }
  })

  return { token, routes, statusPayload }
}

/** 推断本机服务地址：优先请求的 Host，其次 webServer.port。 */
function originOf(req, ctx) {
  const host = req?.headers?.host
  if (host && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return `http://${host}`
  const port = ctx?.get?.('webServer')?.port
  if (port) return `http://127.0.0.1:${port}`
  return 'http://127.0.0.1:16435'
}

/**
 * 把路由挂到 webServer 上。没有 webServer（headless / sdk profile）时安静跳过。
 * @returns {() => void} disposer
 */
export function installSettingsRoutes(ctx, config, options = {}) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') return () => {}
  const surface = createSettingsSurface({ ctx, config, ...options })
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
