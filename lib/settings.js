/**
 * 设置页的宿主半边：HTTP 路由 + 凭证采集。
 *
 * 浏览器里的设置面板（lib/client.js）只负责界面；读状态、校验 Cookie、落盘、
 * 打开浏览器这些事都在这里，经由 `ctx.webServer` 的 `/api/greasyfork/*` 完成。
 *
 * 采集凭证有三条路，优先级从高到低：
 *   1. `POST /capture/start` —— 启动一个开了调试端口的 Chrome/Edge（固定 profile，
 *      登录一次以后免登录），用 CDP 读 `_greasyfork_session`（HttpOnly 也能读）。
 *      **不需要安装任何油猴脚本。**
 *   2. `POST /credential` —— 手动粘贴（DevTools 里复制）。
 *   3. `POST /beacon` —— 给"已经装了用户脚本管理器"的用户留的通道（助手脚本回传）。
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { GreasyForkClient } from './core/client.js'
import { captureCookieViaBrowser, closeBrowser, findBrowser, pickPort } from './core/browser.js'
import {
  credentialFilePath,
  normalizeCookieInput,
  redactCookie,
  resolveCredential,
  resolveDshHome,
  saveCredential,
  clearCredentialFile
} from './core/credentials.js'

const API_PREFIX = '/api/greasyfork'
const LOGIN_URL = 'https://greasyfork.org/en/users/sign_in'
const MAX_BODY_BYTES = 64 * 1024
const CAPTURE_PORT = 9339

/** 只有助手脚本那条路需要跨源（它从 greasyfork.org 页面发起请求）。 */
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '600'
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...extra
  })
  res.end(JSON.stringify(body))
}

function sendText(res, status, body, contentType, extra = {}) {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store', ...extra })
  res.end(body)
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

/** 生成"Cookie 助手"用户脚本（可选通道，不是必需）。 */
export function buildHelperUserscript({ origin, token, site = 'https://greasyfork.org' }) {
  const endpoint = `${origin}${API_PREFIX}/beacon`
  const match = `${site.replace(/\/+$/, '')}/*`
  return `// ==UserScript==
// @name         DSH GreasyFork Cookie 助手
// @namespace    https://github.com/xkzm123/dsh-greasyfork
// @version      1.0.0
// @description  把 GreasyFork 登录 Cookie 复制到剪贴板，并回传给本机 DeepSeek Harness 的 greasyfork 插件
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
  var btn = document.createElement('button')
  btn.textContent = '把 Cookie 交给 DSH'
  btn.setAttribute('style', 'position:fixed;right:18px;bottom:18px;z-index:2147483647;cursor:pointer;border:0;border-radius:10px;padding:10px 14px;background:#2f6feb;color:#fff;font:600 13px/1.2 system-ui,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25)')
  btn.addEventListener('click', function () {
    btn.disabled = true
    btn.textContent = '正在读取…'
    var done = false
    function finish(err, cookies) {
      if (done) return
      done = true
      var header = typeof cookies === 'string' ? cookies : (cookies || []).filter(function (c) {
        return c && c.name && (c.domain || '').indexOf('greasyfork') !== -1
      }).map(function (c) { return c.name + '=' + c.value }).join('; ')
      if (!header || header.indexOf('_greasyfork_session=') === -1) {
        btn.disabled = false
        btn.textContent = '没读到登录 Cookie，先登录 greasyfork.org'
        return
      }
      try { GM_setClipboard(header, 'text') } catch (e) {}
      GM_xmlhttpRequest({
        method: 'POST',
        url: ENDPOINT,
        headers: { 'content-type': 'application/json' },
        data: JSON.stringify({ token: TOKEN, cookie: header }),
        onload: function (res) {
          var data = {}
          try { data = JSON.parse(res.responseText) } catch (e) {}
          btn.disabled = false
          btn.textContent = data && data.ok ? '已交给 DSH' : '回传失败（Cookie 已在剪贴板）'
        },
        onerror: function () {
          btn.disabled = false
          btn.textContent = '连不上 DSH（Cookie 已在剪贴板）'
        }
      })
    }
    try {
      if (typeof GM_cookie === 'undefined' || !GM_cookie || typeof GM_cookie.list !== 'function') {
        return finish(null, document.cookie)
      }
      var maybe = GM_cookie.list({ domain: 'greasyfork.org' }, function (cookies, err) { finish(err, cookies) })
      if (maybe && typeof maybe.then === 'function') maybe.then(function (c) { finish(null, c) }, function (e) { finish(e) })
    } catch (e) {
      finish(e, document.cookie)
    }
  })
  ;(document.body || document.documentElement).appendChild(btn)
})()
`
}

/**
 * 控制台片段：能在页面里跑，但不依赖 DevTools 的 copy()。
 * 如实说明 HttpOnly 限制。
 */
export function buildConsoleSnippet() {
  return `// 在已登录的 greasyfork.org 页面 → F12 → Console 里粘贴运行。
// 说明：_greasyfork_session 是 HttpOnly，页面 JS 读不到它。
//   这段能读到的是非 HttpOnly 的 Cookie；登录 Cookie 请用设置页里的
//   「自动获取」（插件会开一个调试端口的浏览器自己读），或
//   DevTools → Application → Cookies → https://greasyfork.org 手动复制。
(() => {
  const all = document.cookie
  const hasSession = /(?:^|;\\s*)_greasyfork_session=/.test(all)
  const box = document.createElement('textarea')
  box.value = all
  document.body.appendChild(box)
  box.select()
  document.execCommand('copy')
  box.remove()
  console.log(hasSession
    ? '[DSH] 已复制：' + all.slice(0, 60) + '…'
    : '[DSH] 已复制非 HttpOnly 部分。没有 _greasyfork_session —— 它在 HttpOnly 里，请用「自动获取」。')
  return all
})()`
}

/**
 * 装配设置页的宿主面。
 * @param {{ ctx: any, webServer?: any, config: any, credentials?: any, probe?: Function,
 *   capture?: Function, logger?: any }} options
 */
export function createSettingsSurface(options) {
  const { ctx, config, credentials, logger } = options
  const webServer = options.webServer ?? (typeof ctx?.get === 'function' ? ctx.get('webServer') : ctx?.webServer)
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

  const captureFn = options.capture ?? captureCookieViaBrowser
  const findBrowserFn = options.findBrowserFn ?? findBrowser

  /** whoami 缓存：面板每 1.5 秒轮询一次，别把 GreasyFork 打爆。 */
  let cache = { at: 0, value: null }
  async function statusPayload(force = false) {
    const resolved = await resolveCredential({ credentials, env: process.env })
    const base = {
      ok: true,
      configured: Boolean(resolved),
      storage: credentialFilePath(process.env),
      site,
      loginUrl: LOGIN_URL,
      helperToken: token,
      capture: captureView()
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

  // ── 采集状态机 ────────────────────────────────────────────────────────────
  let capture = null
  let cancelRequested = false

  function captureView() {
    if (!capture) return null
    return {
      id: capture.id,
      state: capture.state,
      startedAt: capture.startedAt,
      elapsedMs: Date.now() - capture.startedAt,
      browser: capture.result?.browser ?? capture.browser ?? null,
      profile: capture.result?.profile ?? null,
      message: capture.result?.message ?? capture.message ?? null,
      username: capture.result?.username ?? null
    }
  }

  function startCapture(port = CAPTURE_PORT) {
    if (capture && capture.state === 'running') return captureView()
    cancelRequested = false
    const id = randomBytes(8).toString('hex')
    capture = { id, state: 'running', startedAt: Date.now(), result: null, port }
    const dshHome = resolveDshHome(process.env)
    Promise.resolve()
      .then(() =>
        captureFn({
          dshHome,
          site,
          domain: 'greasyfork.org',
          port,
          shouldStop: () => cancelRequested
        })
      )
      .then(async (result) => {
        if (cancelRequested) {
          capture = { ...capture, state: 'cancelled', result: { ok: false, message: '已取消' } }
          return
        }
        if (!result.ok) {
          capture = { ...capture, state: result.reason === 'timeout' ? 'timeout' : 'error', result }
          return
        }
        let who = { authenticated: false }
        try {
          who = await probe(result.cookie)
        } catch (error) {
          capture = {
            ...capture,
            state: 'error',
            result: { ok: false, message: `读到了 Cookie 但校验请求失败：${error?.message ?? error}` }
          }
          return
        }
        if (!who.authenticated) {
          capture = {
            ...capture,
            state: 'error',
            result: { ok: false, message: '读到了 _greasyfork_session，但 GreasyFork 认为它无效（可能还没登录成功）。' }
          }
          return
        }
        await saveCredential(
          { cookie: result.cookie, username: who.username ?? null, userId: who.userId ?? null, site },
          { credentials }
        )
        cache = { at: 0, value: null }
        logger?.info?.('greasyfork: 已通过浏览器自动采集凭证（账号 %s）', who.username ?? '未知')
        capture = {
          ...capture,
          state: 'done',
          result: { ok: true, username: who.username ?? null, browser: result.browser, profile: result.profile }
        }
      })
      .catch((error) => {
        capture = { ...capture, state: 'error', result: { ok: false, message: String(error?.message ?? error) } }
      })
    return captureView()
  }

  const routes = []

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/status`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      try {
        return sendJson(res, 200, await statusPayload(String(req.url ?? '').includes('force=1')))
      } catch (error) {
        return sendJson(res, 500, { ok: false, code: 'E_STATUS', message: error?.message ?? String(error) })
      }
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/capture/start`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      try {
        const browser = await findBrowserFn().catch(() => null)
        if (!browser) {
          return sendJson(res, 409, {
            ok: false,
            code: 'E_NO_BROWSER',
            message: '没找到 Chrome / Edge / Chromium，无法自动获取。请改用手动填入。'
          })
        }
        const port = await (options.pickPortFn ?? pickPort)(CAPTURE_PORT)
        return sendJson(res, 200, { ok: true, browser: browser.name, port, capture: startCapture(port) })
      } catch (error) {
        return sendJson(res, 500, { ok: false, code: 'E_CAPTURE', message: error?.message ?? String(error) })
      }
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/capture/status`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      const view = captureView()
      if (!view) return sendJson(res, 200, { ok: true, capture: null })
      const payload = { ok: true, capture: view }
      if (view.state === 'done') payload.status = await statusPayload(true).catch(() => null)
      return sendJson(res, 200, payload)
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/capture/cancel`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      cancelRequested = true
      if (capture && capture.port) await closeBrowser(capture.port).catch(() => {})
      if (capture && capture.state === 'running') capture = { ...capture, state: 'cancelled', result: { ok: false, message: '已取消' } }
      return sendJson(res, 200, { ok: true, capture: captureView() })
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
      if (!cookie) return sendJson(res, 400, { ok: false, code: 'E_NO_CREDENTIAL', message: 'Cookie 为空。' })
      if (!/_greasyfork_session=/.test(cookie)) {
        return sendJson(res, 400, {
          ok: false,
          code: 'E_NO_CREDENTIAL',
          message: 'Cookie 里没有 _greasyfork_session，这不像是 greasyfork.org 的登录 Cookie。'
        })
      }
      let who = { authenticated: false }
      try {
        who = await probe(cookie)
      } catch (error) {
        return sendJson(res, 502, {
          ok: false,
          code: 'E_NETWORK',
          message: `无法校验 Cookie：${error?.message ?? error}`
        })
      }
      if (!who.authenticated) {
        return sendJson(res, 401, {
          ok: false,
          code: 'E_AUTH_EXPIRED',
          message: 'Cookie 未通过登录校验（已过期或不是这个站点的）。请重新登录后导出。'
        })
      }
      const saved = await saveCredential(
        { cookie, username: who.username ?? null, userId: who.userId ?? null, site },
        { credentials }
      )
      cache = { at: 0, value: null }
      return sendJson(res, 200, {
        ok: true,
        storage: saved.file,
        username: who.username ?? null,
        userId: who.userId ?? null
      })
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
          note: process.env.GREASYFORK_COOKIE ? '环境变量 GREASYFORK_COOKIE 仍然生效，需要一并清除。' : null
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
      return sendJson(res, 200, { ok: true, url: LOGIN_URL, opened: openExternal(LOGIN_URL) })
    }
  })

  routes.push({
    kind: 'exact',
    path: `${API_PREFIX}/snippet`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, code: 'E_METHOD' })
      return sendJson(res, 200, { ok: true, snippet: buildConsoleSnippet() })
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
      const origin = originOf(req, webServer)
      return sendText(res, 200, buildHelperUserscript({ origin, token, site }), 'text/javascript; charset=utf-8', {
        'content-disposition': 'inline; filename="dsh-greasyfork-cookie-helper.user.js"'
      })
    }
  })

  return { token, routes, statusPayload, captureView }
}

/** 推断本机服务地址：优先请求的 Host，其次 webServer.port。 */
function originOf(req, webServer) {
  const host = req?.headers?.host
  if (host && /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host)) return `http://${host}`
  const port = webServer?.port
  if (port) return `http://127.0.0.1:${port}`
  return 'http://127.0.0.1:16435'
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
