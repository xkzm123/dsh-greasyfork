/**
 * 设置页宿主半边的测试：路由行为、助手脚本内容、凭证校验与落盘。
 * 不联网：probe（登录校验）由测试注入。
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  buildConsoleSnippet,
  buildHelperUserscript,
  createSettingsSurface
} from '../lib/settings.js'
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

function surface(probeResult) {
  const ctx = { webServer: { port: 16435 } }
  return createSettingsSurface({
    ctx,
    config: CONFIG,
    probe: async (cookie) =>
      probeResult ?? (cookie.includes('good')
        ? { authenticated: true, username: 'tester', userId: 7 }
        : { authenticated: false })
  })
}

function route(s, path) {
  const found = s.routes.find((r) => r.path === path)
  assert.ok(found, `缺少路由 ${path}`)
  return found.handler
}

test('助手脚本：包含 token、回传地址、GM_cookie 与站点匹配', () => {
  const script = buildHelperUserscript({
    origin: 'http://127.0.0.1:16435',
    token: 'tok-abc',
    site: 'https://greasyfork.org'
  })
  assert.match(script, /\/\/ ==UserScript==/)
  assert.match(script, /@match {2,}https:\/\/greasyfork\.org\/\*/)
  assert.match(script, /@grant\s+GM_cookie/)
  assert.match(script, /@grant\s+GM_setClipboard/)
  assert.match(script, /@grant\s+GM_xmlhttpRequest/)
  assert.match(script, /@connect\s+127\.0\.0\.1/)
  assert.ok(script.includes('http://127.0.0.1:16435/api/greasyfork/beacon'))
  assert.ok(script.includes('"tok-abc"'))
  // 不能把 token 写成裸标识符拼进 JS（必须 JSON 转义）
  assert.ok(script.includes('var TOKEN = "tok-abc"'))
})

test('控制台片段：如实说明 HttpOnly', () => {
  const snippet = buildConsoleSnippet({ origin: 'http://127.0.0.1:16435' })
  assert.match(snippet, /HttpOnly/)
  assert.match(snippet, /copy\(/)
})

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
    assert.ok(data.helperToken)
    assert.match(data.loginUrl, /greasyfork\.org/)
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

test('beacon：token 不对 403；token 正确则保存', async () => {
  await withHome(async () => {
    const s = surface()
    const bad = await call(route(s, '/api/greasyfork/beacon'), {
      method: 'POST',
      body: { token: 'wrong', cookie: '_greasyfork_session=good' }
    })
    assert.equal(bad.statusCode, 403)

    const ok = await call(route(s, '/api/greasyfork/beacon'), {
      method: 'POST',
      body: { token: s.token, cookie: '_greasyfork_session=good' }
    })
    assert.equal(ok.statusCode, 200)
    assert.equal(ok.json().username, 'tester')
    assert.equal((await readCredentialFile()).cookie, '_greasyfork_session=good')
  })
})

test('beacon：预检请求带 CORS 头', async () => {
  await withHome(async () => {
    const s = surface()
    const res = await call(route(s, '/api/greasyfork/beacon'), { method: 'OPTIONS' })
    assert.equal(res.statusCode, 204)
    assert.equal(res.headers['access-control-allow-origin'], '*')
  })
})

test('helper.user.js：token 正确才下发脚本', async () => {
  await withHome(async () => {
    const s = surface()
    const denied = await call(route(s, '/api/greasyfork/helper.user.js'), {
      url: '/api/greasyfork/helper.user.js?token=nope',
      headers: { host: '127.0.0.1:16435' }
    })
    assert.equal(denied.statusCode, 403)

    const ok = await call(route(s, '/api/greasyfork/helper.user.js'), {
      url: `/api/greasyfork/helper.user.js?token=${s.token}`,
      headers: { host: '127.0.0.1:16435' }
    })
    assert.equal(ok.statusCode, 200)
    assert.match(ok.headers['content-type'], /javascript/)
    assert.ok(ok.body.includes('http://127.0.0.1:16435/api/greasyfork/beacon'))
    assert.ok(ok.body.includes(s.token))
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

test('snippet：返回控制台片段', async () => {
  await withHome(async () => {
    const s = surface()
    const res = await call(route(s, '/api/greasyfork/snippet'), { headers: { host: '127.0.0.1:16435' } })
    assert.equal(res.statusCode, 200)
    assert.match(res.json().snippet, /HttpOnly/)
  })
})

test('open-login：返回官方登录地址（不抛异常）', async () => {
  await withHome(async () => {
    const s = surface()
    const res = await call(route(s, '/api/greasyfork/open-login'), { method: 'POST' })
    assert.equal(res.statusCode, 200)
    const data = res.json()
    assert.equal(data.ok, true)
    assert.match(data.url, /greasyfork\.org\/en\/users\/sign_in/)
    assert.equal(typeof data.opened, 'boolean')
  })
})

test('非 GET/POST 方法返回 405', async () => {
  await withHome(async () => {
    const s = surface()
    const res = await call(route(s, '/api/greasyfork/credential'), { method: 'DELETE' })
    assert.equal(res.statusCode, 405)
  })
})
