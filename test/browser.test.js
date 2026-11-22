/**
 * 浏览器采集（CDP）单元测试。
 * 不真的启动浏览器：launch / wait / read / close 全部注入。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { tmpdir } from 'node:os'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  browserCandidates,
  captureCookieViaBrowser,
  closeBrowser,
  cookiesToHeader,
  createBrowserManager,
  defaultBrowserId,
  detectDefaultBrowser,
  findBrowser,
  pickSessionCookie,
  readCookies,
  resolveBrowser
} from '../lib/core/browser.js'
import { createCdpClient, createPipeTransport } from '../lib/core/browser.js'
import { startFakeCdp } from './fake-cdp.mjs'
import { startFakePipeBrowser } from './fake-pipe-browser.mjs'

const FAKE_BROWSER = { id: 'edge', name: 'Microsoft Edge', path: '/fake/msedge' }
const resolveTo = (browser = FAKE_BROWSER, isDefault = true) => async () => ({ browser, isDefault, defaultId: browser?.id ?? null })

test('browserCandidates 覆盖 Edge / Chrome，且路径带可执行文件名', () => {
  const win = browserCandidates('win32', { PROGRAMFILES: 'C:/PF', 'PROGRAMFILES(X86)': 'C:/PF86', LOCALAPPDATA: 'C:/LA' })
  const names = win.map((b) => b.id)
  assert.ok(names.includes('edge'))
  assert.ok(names.includes('chrome'))
  assert.ok(names.includes('brave'))
  for (const b of win) assert.match(b.path, /(msedge|chrome|brave|vivaldi|launcher)\.exe$/)

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
    resolveBrowserFn: resolveTo(),
    launchFn: async () => ({}),
    waitFn: async () => ({ Browser: 'Edg/1' }),
    readFn: async () => [
      { name: '_greasyfork_session', value: 'session-1', httpOnly: true },
      { name: 'cf_clearance', value: 'cf-1' }
    ],
    verify: async () => ({ authenticated: true, username: 'tester' }),
    closeFn: async () => {
      closed += 1
    },
    timeoutMs: 1000,
    intervalMs: 1
  })
  assert.equal(result.ok, true)
  assert.equal(result.cookie, '_greasyfork_session=session-1; cf_clearance=cf-1')
  assert.equal(result.browser, 'Microsoft Edge')
  assert.equal(result.username, 'tester')
  assert.equal(result.verified, true)
  assert.equal(result.isDefault, true)
  assert.equal(closed, 1)
})

test('captureCookieViaBrowser：没有浏览器时给出 no-browser', async () => {
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    resolveBrowserFn: resolveTo(null, false)
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'no-browser')
  assert.match(result.message, /Chrome|Edge/)
})

test('captureCookieViaBrowser：启动失败给出 launch-failed', async () => {
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    resolveBrowserFn: resolveTo(),
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
    resolveBrowserFn: resolveTo(),
    launchFn: async () => ({}),
    waitFn: async () => ({ Browser: 'Edg/1' }),
    readFn: async () => [{ name: 'locale_messaged', value: 'true' }],
    verify: async () => ({ authenticated: false }),
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
    resolveBrowserFn: resolveTo(),
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
    resolveBrowserFn: resolveTo(),
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

test('captureCookieViaBrowser：匿名 session 不算成功，登录后才返回', async () => {
  let reads = 0
  const phases = []
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    resolveBrowserFn: resolveTo(),
    launchFn: async () => ({}),
    waitFn: async () => ({ Browser: 'Edg/1' }),
    readFn: async () => {
      reads += 1
      return [{ name: '_greasyfork_session', value: 'anonymous-' + reads }]
    },
    verify: async (cookie) =>
      cookie.includes('anonymous-1') || cookie.includes('anonymous-2')
        ? { authenticated: false }
        : { authenticated: true, username: 'real-user' },
    onPhase: (info) => phases.push(info.phase),
    closeFn: async () => {},
    timeoutMs: 3000,
    intervalMs: 1
  })
  assert.equal(result.ok, true)
  assert.equal(result.username, 'real-user')
  assert.ok(reads >= 3, `应该多轮之后才成功，实际读了 ${reads} 轮`)
  assert.ok(phases.includes('waiting-login'), `阶段：${phases.join(',')}`)
  assert.ok(phases.includes('verifying'))
})

test('captureCookieViaBrowser：一直没登录时超时消息要说明"检测到会话但没登录"', async () => {
  const result = await captureCookieViaBrowser({
    dshHome: '/tmp/dsh',
    site: 'https://greasyfork.org',
    resolveBrowserFn: resolveTo(),
    launchFn: async () => ({}),
    waitFn: async () => ({ Browser: 'Edg/1' }),
    readFn: async () => [{ name: '_greasyfork_session', value: 'anonymous' }],
    verify: async () => ({ authenticated: false }),
    closeFn: async () => {},
    timeoutMs: 30,
    intervalMs: 5
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.equal(result.sawAnonymous, true)
  assert.match(result.message, /登录/)
})

test('defaultBrowserId：解析 Windows 默认浏览器的 ProgId', async () => {
  const fake = (progId) => async () => ({ stdout: `HKEY_CURRENT_USER\\...\\UserChoice\r\n    ProgId    REG_SZ    ${progId}\r\n` })
  assert.equal(await defaultBrowserId('win32', fake('MSEdgeHTM')), 'edge')
  assert.equal(await defaultBrowserId('win32', fake('ChromeHTML')), 'chrome')
  assert.equal(await defaultBrowserId('win32', fake('FirefoxURL-308046B0AF4A39CB')), 'firefox')
  assert.equal(await defaultBrowserId('win32', fake('BraveHTML')), 'brave')
  assert.equal(await defaultBrowserId('win32', fake('VivaldiHTM')), 'vivaldi')
  assert.equal(await defaultBrowserId('linux'), null)
  assert.equal(
    await defaultBrowserId('win32', async () => {
      throw new Error('reg missing')
    }),
    null
  )
})

test('resolveBrowser：默认浏览器在候选里就优先返回，并标记 isDefault', async () => {
  // 用本机真实候选路径做一次只读解析：只要机器上装了 Edge 或 Chrome 就能断言
  const resolved = await resolveBrowser({ platform: process.platform, env: process.env, defaultId: null })
  if (!resolved.browser) return // 无 Chromium 的机器跳过
  assert.equal(typeof resolved.browser.path, 'string')
  assert.equal(resolved.isDefault, false)
  const withDefault = await resolveBrowser({ platform: process.platform, env: process.env, defaultId: resolved.browser.id })
  assert.equal(withDefault.browser.id, resolved.browser.id)
  assert.equal(withDefault.isDefault, true)
})

// ── 1.3：默认浏览器真识别 ─────────────────────────────────────────────────
test('detectDefaultBrowser：从注册表解析默认浏览器的真实 exe 路径', async () => {
  const runner = async (_cmd, args) => {
    if (args.join(' ').includes('UserChoice')) return { stdout: '    ProgId    REG_SZ    ChromeHTML\r\n' }
    if (String(args[1] ?? '').startsWith('HKCR\\')) {
      return { stdout: '    (默认)    REG_SZ    "D:\\Portable\\Chrome\\chrome.exe" -- "%1"\r\n' }
    }
    throw new Error('unexpected reg query')
  }
  const detected = await detectDefaultBrowser({ platform: 'win32', runner })
  assert.equal(detected.id, 'chrome')
  assert.equal(detected.path, 'D:\\Portable\\Chrome\\chrome.exe')
  assert.equal(detected.progId, 'ChromeHTML')
  assert.equal(detected.chromium, true)
})

test('detectDefaultBrowser：Firefox 默认时标记为不可用内核', async () => {
  const runner = async (_cmd, args) => {
    if (args.join(' ').includes('UserChoice')) return { stdout: '    ProgId    REG_SZ    FirefoxURL-ABC\r\n' }
    return { stdout: '    (默认)    REG_SZ    "C:\\Program Files\\Mozilla Firefox\\firefox.exe" -osint -url "%1"\r\n' }
  }
  const detected = await detectDefaultBrowser({ platform: 'win32', runner })
  assert.equal(detected.id, 'firefox')
  assert.equal(detected.chromium, false)
})

test('resolveBrowser：默认浏览器是 Chromium 时用注册表里的真实路径', async () => {
  const detected = { id: 'edge', name: 'Microsoft Edge', path: process.execPath, progId: 'MSEdgeHTM', chromium: true }
  const resolved = await resolveBrowser({ platform: 'win32', env: {}, detected })
  assert.equal(resolved.browser.id, 'edge')
  assert.equal(resolved.browser.path, process.execPath)
  assert.equal(resolved.isDefault, true)
})

test('resolveBrowser：默认浏览器不是 Chromium 时不把它当采集浏览器', async () => {
  const detected = { id: 'firefox', name: 'Firefox', path: process.execPath, progId: 'FirefoxURL', chromium: false }
  const resolved = await resolveBrowser({ platform: 'win32', env: process.env, detected })
  assert.equal(resolved.isDefault, false)
  if (!resolved.browser) return // 机器上没有任何 Chromium 就跳过
  assert.notEqual(resolved.browser.id, 'firefox')
  assert.equal(resolved.fallbackFrom, 'firefox')
})

// ── 1.3：管道传输 ─────────────────────────────────────────────────────────
test('管道传输：fd3/fd4 分帧能跑通 Browser.getVersion 与 Storage.getCookies', async () => {
  const fake = startFakePipeBrowser()
  const transport = createPipeTransport({ exePath: '/fake/msedge', args: ['--remote-debugging-pipe'], spawnFn: fake.spawnFn })
  const client = createCdpClient(transport, { defaultTimeoutMs: 2000 })
  const version = await client.send('Browser.getVersion')
  assert.equal(version.Browser, 'FakeChrome/1.0')
  const { cookies } = await client.send('Storage.getCookies')
  assert.equal(cookies.length, 2)
  assert.deepEqual(fake.state.commands, ['Browser.getVersion', 'Storage.getCookies'])
  assert.ok(fake.state.spawns[0].args.includes('--remote-debugging-pipe'))
  client.close()
})

test('管道传输：Storage.getCookies 不支持时回退 Network.getAllCookies', async () => {
  const fake = startFakePipeBrowser({ failStorage: true })
  const manager = createBrowserManager({
    dshHome: tmpdir(),
    spawnFn: fake.spawnFn,
    resolveFn: async () => ({ browser: { id: 'edge', name: 'Microsoft Edge', path: '/fake/msedge' }, isDefault: true })
  })
  const cookies = await manager.cookies('greasyfork.org')
  assert.equal(cookies.length, 2)
  assert.ok(fake.state.commands.includes('Network.getAllCookies'))
  await manager.close()
})

// ── 1.3：单实例管理器 ─────────────────────────────────────────────────────
const managerResolve = async () => ({
  browser: { id: 'edge', name: 'Microsoft Edge', path: '/fake/msedge' },
  isDefault: true,
  defaultId: 'edge',
  detected: { id: 'edge', chromium: true }
})

test('BrowserManager：只启动一次，之后在同一个实例里新开标签页', async () => {
  const fake = startFakePipeBrowser()
  const manager = createBrowserManager({ dshHome: tmpdir(), spawnFn: fake.spawnFn, resolveFn: managerResolve })
  const first = await manager.ensure()
  assert.equal(first.mode, 'pipe')
  await manager.openTab()
  await manager.openTab()
  assert.equal(fake.state.spawns.length, 1, '不该启动第二个浏览器进程')
  assert.equal(fake.state.targets.length, 1, '第二次应该切到已有标签页，而不是再开一个')
  assert.equal(fake.state.commands.filter((c) => c === 'Target.createTarget').length, 1)
  assert.equal(manager.status().alive, true)
  assert.equal(manager.status().browser, 'Microsoft Edge')
  assert.equal(await manager.close(), true)
  assert.equal(fake.state.closed, true)
  assert.equal(manager.status().alive, false)
})

test('captureCookieViaBrowser：走管理器时成功后不关浏览器（登录态留着）', async () => {
  const fake = startFakePipeBrowser()
  const manager = createBrowserManager({ dshHome: tmpdir(), spawnFn: fake.spawnFn, resolveFn: managerResolve })
  const phases = []
  const result = await captureCookieViaBrowser({
    manager,
    site: 'https://greasyfork.org',
    timeoutMs: 3000,
    intervalMs: 5,
    verify: async () => ({ authenticated: true, username: 'tester' }),
    onPhase: (info) => phases.push(info.phase)
  })
  assert.equal(result.ok, true)
  assert.equal(result.username, 'tester')
  assert.match(result.cookie, /_greasyfork_session=SESSION-VALUE/)
  assert.equal(manager.status().alive, true, '默认 keepAlive，浏览器该留着')
  assert.equal(fake.state.closed, false)
  assert.ok(phases.includes('opened'))
  assert.ok(phases.includes('done'))
  await manager.close()
})

test('captureCookieViaBrowser：keepAlive=false 时采集完关掉浏览器', async () => {
  const fake = startFakePipeBrowser()
  const manager = createBrowserManager({ dshHome: tmpdir(), spawnFn: fake.spawnFn, resolveFn: managerResolve })
  const result = await captureCookieViaBrowser({
    manager,
    site: 'https://greasyfork.org',
    timeoutMs: 3000,
    intervalMs: 5,
    keepAlive: false,
    verify: async () => ({ authenticated: true })
  })
  assert.equal(result.ok, true)
  assert.equal(fake.state.closed, true)
  assert.equal(manager.status().alive, false)
})

test('captureCookieViaBrowser：浏览器起不来时给出 launch-failed 与诊断日志', async () => {
  const manager = createBrowserManager({
    dshHome: tmpdir(),
    spawnFn: () => {
      throw new Error('spawn EPERM')
    },
    resolveFn: managerResolve
  })
  const result = await captureCookieViaBrowser({ manager, timeoutMs: 300, intervalMs: 5 })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'launch-failed')
  assert.match(result.message, /EPERM|连不上/)
  assert.ok(Array.isArray(result.log) && result.log.length > 0)
})

test('BrowserManager：已经有 greasyfork 标签页时切过去，不再新开', async () => {
  const fake = startFakePipeBrowser()
  fake.state.targets.push({ id: 'OLD', url: 'https://greasyfork.org/en/users/sign_in' })
  const manager = createBrowserManager({ dshHome: tmpdir(), spawnFn: fake.spawnFn, resolveFn: managerResolve })
  const tabId = await manager.openTab()
  assert.equal(tabId, 'OLD')
  assert.equal(fake.state.targets.length, 1, '不该多开标签页')
  assert.ok(fake.state.commands.includes('Target.activateTarget'))
  assert.ok(!fake.state.commands.includes('Target.createTarget'))
  await manager.close()
})

test('captureCookieViaBrowser：Node 校验失败时用浏览器内校验兜底', async () => {
  const fake = startFakePipeBrowser()
  const manager = createBrowserManager({ dshHome: tmpdir(), spawnFn: fake.spawnFn, resolveFn: managerResolve })
  const result = await captureCookieViaBrowser({
    manager,
    site: 'https://greasyfork.org',
    timeoutMs: 4000,
    intervalMs: 5,
    // 模拟 Cloudflare 把 Node 的请求拦掉：Node 端永远校验不过
    verify: async () => ({ authenticated: false, sawSignIn: true }),
    verifyInBrowser: () => manager.verifyLogin()
  })
  assert.equal(result.ok, true)
  assert.equal(result.verifiedBy, 'browser')
  assert.equal(result.username, 'browser-user')
  assert.ok(fake.state.evaluated.some((code) => code.includes('/en/users/edit')))
  await manager.close()
})

test('captureCookieViaBrowser：浏览器里也没登录时继续等，超时消息指向"没登录"', async () => {
  const fake = startFakePipeBrowser({ pageEval: { status: 200, url: 'https://greasyfork.org/en/users/sign_in', signIn: true } })
  const manager = createBrowserManager({ dshHome: tmpdir(), spawnFn: fake.spawnFn, resolveFn: managerResolve })
  const result = await captureCookieViaBrowser({
    manager,
    site: 'https://greasyfork.org',
    timeoutMs: 120,
    intervalMs: 5,
    verify: async () => ({ authenticated: false }),
    verifyInBrowser: () => manager.verifyLogin()
  })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.match(result.message, /没有登录|没登录|登录页/)
  await manager.close()
})

test('cookiesToHeader：同名 cookie 只保留一条（域名更具体优先）', () => {
  const cookies = [
    { name: '_greasyfork_session', value: 'old-anonymous', domain: 'greasyfork.org', expires: 1 },
    { name: '_greasyfork_session', value: 'new-login', domain: '.greasyfork.org', expires: 9999999999 },
    { name: 'cf_clearance', value: 'cf', domain: '.greasyfork.org' }
  ]
  assert.equal(cookiesToHeader(cookies), '_greasyfork_session=new-login; cf_clearance=cf')
  assert.equal(pickSessionCookie(cookies).value, 'new-login')
  assert.equal(pickSessionCookie([]), null)
})

test('captureCookieViaBrowser：读 cookie 一直失败时把错误写进日志和超时消息', async () => {
  const fake = startFakePipeBrowser()
  const manager = createBrowserManager({ dshHome: tmpdir(), spawnFn: fake.spawnFn, resolveFn: managerResolve })
  const brokenManager = {
    ensure: () => manager.ensure(),
    openTab: () => manager.openTab(),
    cookies: async () => {
      throw new Error('管道已关闭')
    },
    close: () => manager.close(),
    status: () => manager.status(),
    log: () => manager.log(),
    note: (text) => manager.note(text)
  }
  const result = await captureCookieViaBrowser({
    site: 'https://greasyfork.org',
    timeoutMs: 150,
    intervalMs: 10,
    verifyInBrowser: null,
    // 模拟 CDP 读 cookie 一直报错
    manager: brokenManager
  })
  const _unused = {
  }
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'timeout')
  assert.match(result.message, /管道已关闭/)
  assert.ok((result.log || []).some((e) => String(e.text).includes('读 cookie 失败')))
  await manager.close()
})

test('BrowserManager.diagnose：返回实例、cookie 概况、浏览器内校验与日志', async () => {
  const fake = startFakePipeBrowser()
  const manager = createBrowserManager({ dshHome: tmpdir(), spawnFn: fake.spawnFn, resolveFn: managerResolve })
  const report = await manager.diagnose()
  assert.equal(report.instance.alive, true)
  assert.equal(report.cookies.count, 2)
  assert.equal(report.cookies.sessionLength, 'SESSION-VALUE'.length)
  assert.equal(report.browserCheck.ok, true)
  assert.ok(Array.isArray(report.log) && report.log.length > 0)
  await manager.close()
})

test('BrowserManager：启动后用保存的凭证恢复登录态', async () => {
  const fake = startFakePipeBrowser()
  const manager = createBrowserManager({
    dshHome: tmpdir(),
    spawnFn: fake.spawnFn,
    resolveFn: managerResolve,
    seed: async () => '_greasyfork_session=SAVED-VALUE; cf_clearance=CF-VALUE'
  })
  await manager.ensure()
  assert.equal(fake.state.setCookies.length, 2)
  const names = fake.state.setCookies.map((c) => c.name).sort()
  assert.deepEqual(names, ['_greasyfork_session', 'cf_clearance'])
  assert.equal(fake.state.setCookies.find((c) => c.name === '_greasyfork_session').httpOnly, true)
  await manager.close()
})

test('BrowserManager：启动写状态文件、关闭时删掉（供下次清理孤儿进程）', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-gf-state-'))
  const fake = startFakePipeBrowser()
  const manager = createBrowserManager({ dshHome: home, spawnFn: fake.spawnFn, resolveFn: managerResolve })
  await manager.ensure()
  const state = JSON.parse(await readFile(join(home, 'greasyfork', 'browser-state.json'), 'utf8'))
  assert.equal(state.mode, 'pipe')
  assert.equal(typeof state.pid, 'number')
  await manager.close()
  await assert.rejects(() => readFile(join(home, 'greasyfork', 'browser-state.json'), 'utf8'))
})
