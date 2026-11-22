/**
 * 设置页宿主半边的测试：路由行为、凭证校验与落盘。
 * 不联网：probe（登录校验）由测试注入。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createSettingsSurface } from '../lib/settings.js'
import { readCredentialFile } from '../lib/core/credentials.js'

function fakeReq({ method = 'GET', url = '/', headers = {}, body } = {}) {
  const listeners = { data: [], end: [] }
  const req = {
    method,
    url,
    headers,
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn)
      return req
    },
    destroy() {},
    emit() {
      if (body !== undefined) for (const fn of listeners.data) fn(Buffer.from(body))
      for (const fn of listeners.end) fn()
    }
  }
  setTimeout(() => req.emit(), 0)
  return req
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.statusCode = code
      Object.assign(this.headers, headers || {})
    },
    end(text) {
      this.body = text ?? ''
    },
    json() {
      return JSON.parse(this.body)
    }
  }
}

async function call(handler, { method = 'GET', url = '/', headers = {}, body } = {}) {
  const req = fakeReq({ method, url, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  const res = fakeRes()
  await handler(req, res)
  return res
}

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gf-settings-'))
  const previousHome = process.env.DSH_HOME
  const previousCookie = process.env.GREASYFORK_COOKIE
  process.env.DSH_HOME = dir
  delete process.env.GREASYFORK_COOKIE
  try {
    await fn(dir)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousCookie === undefined) delete process.env.GREASYFORK_COOKIE
    else process.env.GREASYFORK_COOKIE = previousCookie
    await rm(dir, { recursive: true, force: true })
  }
}

const CONFIG = {
  site: 'https://greasyfork.org',
  apiSite: 'https://api.greasyfork.org',
  locale: 'en',
  timeoutMs: 5000,
  userAgent: 'test'
}

const FAKE_RESOLVED = {
  browser: { id: 'edge', name: 'Microsoft Edge', path: 'x' },
  isDefault: true,
  defaultId: 'edge',
  detected: { id: 'edge', name: 'Microsoft Edge', path: 'x', chromium: true }
}

function surface(probeResult, extra = {}) {
  const ctx = { webServer: { port: 16435 } }
  return createSettingsSurface({
    ctx,
    config: CONFIG,
    resolveBrowserFn: async () => FAKE_RESOLVED,
    probe: async (cookie) =>
      probeResult ?? (cookie.includes('good')
        ? { authenticated: true, username: 'tester', userId: 7 }
        : { authenticated: false }),
    ...extra
  })
}

function route(s, path) {
  const found = s.routes.find((r) => r.path === path)
  assert.ok(found, `缺少路由 ${path}`)
  return found.handler
}

test('status：没有凭证时返回未配置与存储路径', async () => {
  await withHome(async () => {
    const s = surface()
    const res = await call(route(s, '/api/greasyfork/status'))
    assert.equal(res.statusCode, 200)
    const data = res.json()
    assert.equal(data.ok, true)
    assert.equal(data.configured, false)
    assert.equal(data.valid, false)
    assert.match(data.storage, /greasyfork[\\/]credentials\.json$/)
    assert.equal(data.expiry, null)
    // 同源接口不该开放跨源读取
    assert.equal(res.headers['access-control-allow-origin'], undefined)
  })
})

test('credential：缺少 _greasyfork_session 直接 400', async () => {
  await withHome(async () => {
    const s = surface()
    const res = await call(route(s, '/api/greasyfork/credential'), {
      method: 'POST',
      body: { cookie: 'foo=bar' }
    })
    assert.equal(res.statusCode, 400)
    assert.equal(res.json().code, 'E_NO_CREDENTIAL')
    assert.equal(await readCredentialFile(), undefined)
  })
})

test('credential：校验失败不落盘', async () => {
  await withHome(async () => {
    const s = surface({ authenticated: false })
    const res = await call(route(s, '/api/greasyfork/credential'), {
      method: 'POST',
      body: { cookie: '_greasyfork_session=stale' }
    })
    assert.equal(res.statusCode, 401)
    assert.equal(res.json().code, 'E_AUTH_EXPIRED')
    assert.equal(await readCredentialFile(), undefined)
  })
})

test('credential：校验通过后落盘，status 变成已配置', async () => {
  await withHome(async () => {
    const s = surface()
    const res = await call(route(s, '/api/greasyfork/credential'), {
      method: 'POST',
      body: { cookie: '_greasyfork_session=good; cf_clearance=xyz' }
    })
    assert.equal(res.statusCode, 200)
    assert.equal(res.json().username, 'tester')
    const saved = await readCredentialFile()
    assert.equal(saved.cookie, '_greasyfork_session=good; cf_clearance=xyz')

    const status = await call(route(s, '/api/greasyfork/status'), { url: '/api/greasyfork/status?force=1' })
    const data = status.json()
    assert.equal(data.configured, true)
    assert.equal(data.valid, true)
    assert.equal(data.username, 'tester')
    assert.deepEqual(data.cookie.names, ['_greasyfork_session', 'cf_clearance'])
    // 响应里绝不能出现 Cookie 值
    assert.ok(!JSON.stringify(data).includes('good'))
  })
})

test('clear：删除本地凭证', async () => {
  await withHome(async () => {
    const s = surface()
    await call(route(s, '/api/greasyfork/credential'), {
      method: 'POST',
      body: { cookie: '_greasyfork_session=good' }
    })
    assert.ok(await readCredentialFile())
    const res = await call(route(s, '/api/greasyfork/clear'), { method: 'POST' })
    assert.equal(res.statusCode, 200)
    assert.equal(await readCredentialFile(), undefined)
  })
})

test('非 GET/POST 方法返回 405', async () => {
  await withHome(async () => {
    const s = surface()
    const res = await call(route(s, '/api/greasyfork/credential'), { method: 'DELETE' })
    assert.equal(res.statusCode, 405)
  })
})

test('status：Node 端校验抛错时不再把凭证判成"已失效"', async () => {
  await withHome(async () => {
    const good = surface()
    await call(route(good, '/api/greasyfork/credential'), {
      method: 'POST',
      body: { cookie: '_greasyfork_session=good' }
    })
    // 换一个"被 Cloudflare 拦"的 probe，模拟 Node 端打不通
    const blocked = surface(null, {
      probe: async () => {
        throw new Error('E_CLOUDFLARE: 被 Cloudflare 拦截')
      }
    })
    const res = await call(route(blocked, '/api/greasyfork/status'), { url: '/api/greasyfork/status?force=1' })
    const data = res.json()
    assert.equal(data.configured, true)
    assert.equal(data.valid, null)
    assert.match(data.verifyError, /Cloudflare/)
  })
})

test('parse：只解析不落盘，并回显识别到的格式', async () => {
  await withHome(async () => {
    const s = surface()
    const raw = JSON.stringify([
      { name: '_ga', value: 'GA1.1.1', expirationDate: Math.floor(Date.now() / 1000) + 86400 },
      { name: '_greasyfork_session', value: 'abc' }
    ])
    const res = await call(route(s, '/api/greasyfork/parse'), {
      method: 'POST',
      body: { cookie: raw }
    })
    const data = res.json()
    assert.equal(data.ok, true)
    assert.equal(data.format, 'json')
    assert.equal(data.cookieCount, 2)
    assert.equal(data.hasSession, true)
    assert.equal(data.expiry.sessionScoped, true)
    assert.equal(await readCredentialFile(), undefined)
  })
})

