/**
 * 不用油猴脚本拿到 HttpOnly Cookie：用 DevTools Protocol 读浏览器自己的 cookie 存储。
 *
 * 为什么只能这么做（本机实测结论）：
 *  - GreasyFork 的 `_greasyfork_session` 带 `HttpOnly`，页面里的 `document.cookie` 读不到；
 *  - Chrome/Edge 127+ 的 cookie 库改成 App-Bound 加密（本机 1383 条全是 v20），
 *    外部进程拿 DPAPI 解不开，`browser_cookie3` 这类库在新版上直接失效；
 *  - Electron 的 `session.cookies` 也拿不到——dsh 宿主是 Electron 主进程 spawn 出来的
 *    子 Node 进程（`dsh-desktop-host`），插件里 `import('electron')` 不可用。
 *
 * 所以唯一"零油猴脚本"的路径是：**由插件启动一个开了调试端口的浏览器**，
 * 用户在里面走官方登录，插件用 CDP 的 `Network.getAllCookies` 读回 HttpOnly Cookie。
 * 用固定 profile 目录，登录一次之后就一直有效，后续采集是秒级。
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { access, mkdir } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 候选浏览器（按平台）。 */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean)
    const out = []
    for (const root of roots) {
      out.push({ id: 'edge', name: 'Microsoft Edge', path: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })
      out.push({ id: 'chrome', name: 'Google Chrome', path: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') })
    }
    return out
  }
  if (platform === 'darwin') {
    return [
      { id: 'chrome', name: 'Google Chrome', path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { id: 'edge', name: 'Microsoft Edge', path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { id: 'chromium', name: 'Chromium', path: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
    ]
  }
  return [
    { id: 'chrome', name: 'Google Chrome', path: '/usr/bin/google-chrome' },
    { id: 'chromium', name: 'Chromium', path: '/usr/bin/chromium' },
    { id: 'chromium', name: 'Chromium', path: '/usr/bin/chromium-browser' },
    { id: 'edge', name: 'Microsoft Edge', path: '/usr/bin/microsoft-edge' }
  ]
}

/** 找到第一个真实存在的浏览器。 */
export async function findBrowser(platform = process.platform, env = process.env) {
  for (const candidate of browserCandidates(platform, env)) {
    try {
      await access(candidate.path, constants.X_OK)
      return candidate
    } catch {
      /* 继续找 */
    }
  }
  return null
}

/** 找一个空闲的本地端口（给调试端口用）。 */
export function pickPort(start = 9339, attempts = 12) {
  return new Promise((resolve, reject) => {
    let port = start
    const tryPort = () => {
      if (port >= start + attempts) return reject(new Error(`${start}-${start + attempts - 1} 之间没有空闲端口`))
      const server = createServer()
      server.once('error', () => {
        port += 1
        tryPort()
      })
      server.once('listening', () => {
        const actual = server.address().port
        server.close(() => resolve(actual))
      })
      server.listen(port, '127.0.0.1')
    }
    tryPort()
  })
}

/** 专用 profile 目录（登录状态保存在这里，下次免登录）。 */
export function captureProfileDir(dshHome) {
  return join(dshHome, 'greasyfork', 'browser-profile')
}

/**
 * 启动带调试端口的浏览器。
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, port: number, browser: object }>}
 */
export async function launchDebugBrowser(options) {
  const { browser, profileDir, port, url } = options
  await mkdir(profileDir, { recursive: true })
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=msEdgeSidebarV2,msEdgeStartupBoost',
    '--remote-allow-origins=*',
    url
  ]
  const child = spawn(browser.path, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return child
}

/** 等到 CDP HTTP 端点可用。 */
export async function waitForEndpoint(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (res.ok) return await res.json()
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new Error(`浏览器调试端口 ${port} 没起来${lastError ? `（${lastError.message}）` : ''}`)
}

/** 列出页面目标。 */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new Error(`读取目标列表失败：HTTP ${res.status}`)
  return res.json()
}

/** 极简 CDP 客户端（只用到请求/响应，不处理事件流）。 */
export function connectCdp(wsUrl, { timeoutMs = 8000 } = {}) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), timeoutMs)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve()
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('CDP WebSocket 连接失败'))
    })
  })
  ws.addEventListener('message', (event) => {
    let message
    try {
      message = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'))
    } catch {
      return
    }
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message ?? JSON.stringify(message.error)}`))
      else entry.resolve(message.result)
    }
  })
  return {
    ready,
    send(method, params = {}, sessionId) {
      const id = ++seq
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`${method} 超时`))
        }, timeoutMs)
        pending.set(id, { resolve, reject, timer, method })
        try {
          ws.send(JSON.stringify(payload))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        }
      })
    },
    close() {
      try {
        ws.close()
      } catch {
        /* 已关闭 */
      }
    }
  }
}

/**
 * 读浏览器里某个域名的全部 cookie（含 HttpOnly）。
 * 优先在页面目标自己的 WebSocket 上调用 Network.getAllCookies（不需要 attach session）。
 */
export async function readCookies(port, domain) {
  const targets = await listTargets(port)
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (pages.length === 0) throw new Error('浏览器里还没有页面目标')
  // 优先挑目标站点自己的页面
  const preferred = pages.find((t) => (t.url || '').includes(domain)) ?? pages[0]
  const cdp = connectCdp(preferred.webSocketDebuggerUrl)
  await cdp.ready
  try {
    let cookies = null
    try {
      await cdp.send('Network.enable', {})
      const all = await cdp.send('Network.getAllCookies', {})
      cookies = all.cookies
    } catch {
      const stored = await cdp.send('Storage.getCookies', {})
      cookies = stored.cookies
    }
    return (cookies ?? []).filter((c) => String(c.domain || '').includes(domain))
  } finally {
    cdp.close()
  }
}

/** 把 CDP cookie 列表拼成 Cookie 请求头。 */
export function cookiesToHeader(cookies) {
  return (cookies ?? [])
    .filter((c) => c && c.name && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

/**
 * 一次完整的采集：启动浏览器 → 轮询 cookie → 命中后关闭浏览器。
 *
 * @param {{
 *   dshHome: string, site: string, domain?: string, port?: number,
 *   timeoutMs?: number, intervalMs?: number, findBrowserFn?: typeof findBrowser,
 *   launchFn?: typeof launchDebugBrowser, readFn?: typeof readCookies, now?: () => number
 * }} options
 * @returns {Promise<{ ok: boolean, cookie?: string, browser?: string, profile?: string,
 *   reason?: string, message?: string, elapsedMs: number }>}
 */
export async function captureCookieViaBrowser(options) {
  const {
    dshHome,
    site,
    domain = 'greasyfork.org',
    port = 9339,
    timeoutMs = 5 * 60 * 1000,
    intervalMs = 1500,
    findBrowserFn = findBrowser,
    launchFn = launchDebugBrowser,
    waitFn = waitForEndpoint,
    readFn = readCookies,
    closeFn = closeBrowser,
    now = Date.now,
    shouldStop = () => false
  } = options
  const startedAt = now()
  const browser = await findBrowserFn()
  if (!browser) {
    return {
      ok: false,
      reason: 'no-browser',
      message: '没找到可用的 Chrome / Edge / Chromium。请安装其中之一，或改用手动填入。',
      elapsedMs: 0
    }
  }
  const profile = captureProfileDir(dshHome)
  let launched = false
  try {
    await launchFn({ browser, profileDir: profile, port, url: `${site}/en/users/sign_in` })
    launched = true
    await waitFn(port, 25000)
  } catch (error) {
    return {
      ok: false,
      reason: 'launch-failed',
      browser: browser.name,
      profile,
      message: `启动 ${browser.name} 失败：${error?.message ?? error}`,
      elapsedMs: now() - startedAt
    }
  }

  try {
    while (now() - startedAt < timeoutMs) {
      if (shouldStop()) {
        return { ok: false, reason: 'cancelled', browser: browser.name, profile, message: '已取消', elapsedMs: now() - startedAt }
      }
      let cookies = []
      try {
        cookies = await readFn(port, domain)
      } catch {
        /* 页面还没起来，下一轮再试 */
      }
      const session = cookies.find((c) => c.name === '_greasyfork_session')
      if (session && session.value) {
        return {
          ok: true,
          cookie: cookiesToHeader(cookies),
          browser: browser.name,
          profile,
          elapsedMs: now() - startedAt
        }
      }
      await sleep(intervalMs)
    }
    return {
      ok: false,
      reason: 'timeout',
      browser: browser.name,
      profile,
      message: `等了 ${Math.round(timeoutMs / 1000)} 秒还没检测到登录状态。请在弹出的浏览器窗口里完成登录后再试。`,
      elapsedMs: now() - startedAt
    }
  } finally {
    if (launched) await closeFn(port).catch(() => {})
  }
}

/** 关掉采集用的浏览器实例（只关我们启动的那个端口）。 */
export async function closeBrowser(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return
    const info = await res.json()
    const cdp = connectCdp(info.webSocketDebuggerUrl, { timeoutMs: 3000 })
    await cdp.ready
    await cdp.send('Browser.close', {})
    cdp.close()
  } catch {
    /* 已经关了 */
  }
}
