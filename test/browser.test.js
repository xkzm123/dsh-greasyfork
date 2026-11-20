/**
 * 浏览器采集（CDP）单元测试。
 * 不真的启动浏览器：launch / wait / read / close 全部注入。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  browserCandidates,
  captureCookieViaBrowser,
  closeBrowser,
  cookiesToHeader,
  findBrowser,
  readCookies
} from '../lib/core/browser.js'
import { startFakeCdp } from './fake-cdp.mjs'

const FAKE_BROWSER = { id: 'edge', name: 'Microsoft Edge', path: '/fake/msedge' }

test('browserCandidates 覆盖 Edge / Chrome，且路径带可执行文件名', () => {
  const win = browserCandidates('win32', { PROGRAMFILES: 'C:/PF', 'PROGRAMFILES(X86)': 'C:/PF86', LOCALAPPDATA: 'C:/LA' })
  const names = win.map((b) => b.id)
  assert.ok(names.includes('edge'))
  assert.ok(names.includes('chrome'))
  for (const b of win) assert.match(b.path, /(msedge|chrome)\.exe$/)

  const mac = browserCandidates('darwin', {})
  assert.ok(mac.length > 0)
  assert.ok(mac.every((b) => b.path.startsWith('/Applications/')))

  const linux = browserCandidates('linux', {})
  assert.ok(linux.some((b) => b.id === 'chrome'))
})

test('findBrowser 找不到时返回 null', async () => {
  const found = await findBrowser('linux', {})
  assert.equal(found, null)
})

test('cookiesToHeader 只拼 name=value', () => {
  assert.equal(
    cookiesToHeader([
      { name: '_greasyfork_session', value: 'abc' },
      { name: 'cf_clearance', value: 'xyz' }
    ]),
    '_greasyfork_session=abc; cf_clearance=xyz'
  )
  assert.equal(cookiesToHeader([]), '')
  assert.equal(cookiesToHeader(null), '')
})

test('captureCookieViaBrowser：读到 session 就返回完整 Cookie 头并关掉浏览器', async () => {
  let closed = 0
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    findBrowserFn: async () => FAKE_BROWSER,
    launchFn: async () => ({}),
    waitFn: async () => ({ Browser: 'Edg/1' }),
    readFn: async () => [
      { name: '_greasyfork_session', value: 'session-1', httpOnly: true },
      { name: 'cf_clearance', value: 'cf-1' }
    ],
    closeFn: async () => {
      closed += 1
    },
    timeoutMs: 1000,
    intervalMs: 1
  })
  assert.equal(result.ok, true)
  assert.equal(result.cookie, '_greasyfork_session=session-1; cf_clearance=cf-1')
  assert.equal(result.browser, 'Microsoft Edge')
  assert.equal(closed, 1)
})

test('captureCookieViaBrowser：没有浏览器时给出 no-browser', async () => {
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    findBrowserFn: async () => null
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-browser')
  assert.match(result.message, /Chrome|Edge/)
})

test('captureCookieViaBrowser：启动失败给出 launch-failed', async () => {
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    findBrowserFn: async () => FAKE_BROWSER,
    launchFn: async () => {
      throw new Error('spawn EPERM')
    }
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'launch-failed')
  assert.match(result.message, /EPERM/)
})

test('captureCookieViaBrowser：等不到登录会超时，并且仍然关掉浏览器', async () => {
  let closed = 0
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    findBrowserFn: async () => FAKE_BROWSER,
    launchFn: async () => ({}),
    waitFn: async () => ({ Browser: 'Edg/1' }),
    readFn: async () => [{ name: 'locale_messaged', value: 'true' }],
    closeFn: async () => {
      closed += 1
    },
    timeoutMs: 40,
    intervalMs: 5
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(closed, 1)
})

test('captureCookieViaBrowser：读 cookie 报错时继续轮询而不是直接失败', async () => {
  let calls = 0
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    findBrowserFn: async () => FAKE_BROWSER,
    launchFn: async () => ({}),
    waitFn: async () => ({ Browser: 'Edg/1' }),
    readFn: async () => {
      calls += 1
      if (calls < 3) throw new Error('no page target yet')
      return [{ name: '_greasyfork_session', value: 'ok' }]
    },
    closeFn: async () => {},
    timeoutMs: 2000,
    intervalMs: 1
  })
  assert.equal(result.ok, true)
  assert.equal(calls >= 3, true)
})

test('captureCookieViaBrowser：shouldStop 立即取消', async () => {
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    findBrowserFn: async () => FAKE_BROWSER,
    launchFn: async () => ({}),
    waitFn: async () => ({ Browser: 'Edg/1' }),
    readFn: async () => [],
    closeFn: async () => {},
    timeoutMs: 5000,
    intervalMs: 5,
    shouldStop: () => true
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'cancelled')
})

// ── 真跑一遍 WebSocket 协议：对着一个仿真 CDP 服务读 cookie ──────────────────
test('readCookies：走 WebSocket + Network.getAllCookies，能拿到 HttpOnly cookie', async () => {
  const cdp = await startFakeCdp()
  try {
    const cookies = await readCookies(cdp.port, 'greasyfork.org')
    assert.equal(cookies.length, 2)
    assert.deepEqual(cookies.map((c) => c.name).sort(), ['_greasyfork_session', 'cf_clearance'])
    assert.equal(cookies.every((c) => c.httpOnly === true), true)
    assert.deepEqual(cdp.state.commands, ['Network.enable', 'Network.getAllCookies'])
    assert.equal(cookiesToHeader(cookies), '_greasyfork_session=SESSION-VALUE; cf_clearance=CF-VALUE')
  } finally {
    await cdp.close()
  }
})

test('readCookies：Network.enable 不被支持时回退到 Storage.getCookies', async () => {
  const cdp = await startFakeCdp({ failNetworkEnable: true })
  try {
    const cookies = await readCookies(cdp.port, 'greasyfork.org')
    assert.equal(cookies.length, 2)
    assert.ok(cdp.state.commands.includes('Storage.getCookies'))
  } finally {
    await cdp.close()
  }
})

test('readCookies：端口上没有 CDP 时抛错（由上层轮询兜住）', async () => {
  await assert.rejects(() => readCookies(1, 'greasyfork.org'))
})

test('closeBrowser：对不存在的端口安静返回', async () => {
  await assert.doesNotReject(() => closeBrowser(1))
})
