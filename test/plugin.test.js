/**
 * 插件层测试：用最小 cordis ctx 桩把 index.js 跑起来，验证
 *   - 四个工具都注册了，且参数/输出 schema 形状符合 dsh-tools 的约定
 *   - 工具调用能端到端打到 GreasyFork（这里是本地仿真服务）
 *   - 任何输出里都不会出现 Cookie 原文
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { startMockGreasyfork } from './mock-greasyfork.mjs'

const GOOD = `// ==UserScript==
// @name         Demo Script
// @namespace    https://example.com/demo
// @version      1.0.0
// @description  A demo userscript for tests
// @match        https://example.com/*
// @license      MIT
// ==/UserScript==

(function () {
  console.log('hello')
})()
`

function createContext(credentials) {
  const tools = new Map()
  const logs = []
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
      }
    },
    get(name) {
      return name === 'credentials' ? credentials : undefined
    },
    logger() {
      return { info: (...a) => logs.push(a), error: (...a) => logs.push(a), warn: (...a) => logs.push(a) }
    }
  }
  return { ctx, tools, logs }
}

function execFor(cwd) {
  return { agent: { session: { header: { cwd } } }, signal: undefined, callId: 'call-1' }
}

function makePlugin(mock, credentials) {
  const { ctx, tools, logs } = createContext(credentials)
  apply(ctx, {
    site: mock.url,
    apiSite: mock.apiUrl,
    locale: 'en',
    timeoutMs: 5000,
    defaultScriptType: 'public'
  })
  return { tools, logs }
}

test('插件导出形状符合 cordis 约定', async () => {
  const mod = await import('../lib/index.js')
  assert.equal(mod.name, 'greasyfork')
  assert.deepEqual(mod.inject, ['tools'])
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.default.name, 'greasyfork')
})

test('设置页路由：等 webServer 就绪后才注册（回归 1.1.0 的 not found）', async () => {
  const registered = []
  const fakeServer = {
    port: 16435,
    register(route) {
      registered.push(route)
      return () => {}
    }
  }
  const injected = []
  const ctx = {
    tools: { register() {} },
    get() {
      return undefined // apply 时机 webServer 还没就绪
    },
    logger() {
      return { info() {}, error() {}, warn() {} }
    },
    effect(fn) {
      fn()
    },
    inject(deps, cb) {
      injected.push(deps)
      const scoped = {
        get: (name) => (name === 'webServer' ? fakeServer : undefined),
        effect(fn) {
          fn()
        },
        logger() {
          return { info() {}, error() {}, warn() {} }
        }
      }
      cb(scoped)
    }
  }
  apply(ctx, { site: 'https://greasyfork.org', apiSite: 'https://api.greasyfork.org' })
  assert.deepEqual(injected, [['webServer']])
  const paths = registered.map((r) => r.path)
  assert.ok(paths.includes('/api/greasyfork/status'), `注册到的路由：${paths.join(', ')}`)
  assert.ok(paths.includes('/api/greasyfork/capture/start'))
})

test('没有 webServer 时安静跳过，不影响工具注册', () => {
  const tools = new Map()
  const ctx = {
    tools: { register: (d) => tools.set(d.name, d) },
    get: () => undefined,
    logger: () => ({ info() {}, error() {}, warn() {} }),
    effect: (fn) => fn()
  }
  assert.doesNotThrow(() => apply(ctx, {}))
  assert.equal(tools.size, 4)
})

test('注册四个工具且 schema 形状正确', () => {
  const { tools } = makePlugin({ url: 'http://127.0.0.1:1', apiUrl: 'http://127.0.0.1:1/api' })
  assert.deepEqual([...tools.keys()].sort(), ['greasyfork_auth', 'greasyfork_preflight', 'greasyfork_push', 'greasyfork_status'])
  for (const [name, def] of tools) {
    assert.equal(typeof def.description, 'string', `${name} 缺 description`)
    assert.ok(def.description.length > 20, `${name} description 太短`)
    assert.equal(def.parameters.type, 'object', `${name} parameters 必须是 object`)
    assert.equal(def.parameters.additionalProperties, false, `${name} 参数应闭合`)
    assert.equal(def.output.schema.type, 'object', `${name} 输出必须是 object`)
    assert.equal(typeof def.output.render, 'function', `${name} 缺 output.render`)
    assert.equal(typeof def.execute, 'function', `${name} 缺 execute`)
    for (const [key, spec] of Object.entries(def.parameters.properties)) {
      assert.ok(typeof spec.type === 'string', `${name}.${key} 缺 type`)
    }
  }
  const push = tools.get('greasyfork_push')
  assert.ok(push.parameters.properties.file)
  assert.ok(push.parameters.properties.scriptId)
  assert.ok(push.parameters.properties.dryRun)
  assert.ok(push.parameters.properties.acceptWarnings)
})

test('greasyfork_preflight 在没有凭证时退化为纯本地校验', async () => {
  const previous = process.env.GREASYFORK_COOKIE
  delete process.env.GREASYFORK_COOKIE
  try {
    const { tools } = makePlugin({ url: 'http://127.0.0.1:1', apiUrl: 'http://127.0.0.1:1/api' })
    const result = await tools.get('greasyfork_preflight').execute({ code: GOOD }, execFor(process.cwd()))
    assert.equal(result.ok, true)
    assert.equal(result.offline, true)
    assert.equal(result.summary.name, 'Demo Script')
  } finally {
    if (previous !== undefined) process.env.GREASYFORK_COOKIE = previous
  }
})

test('greasyfork_push：create 成功并返回链接与版本', async () => {
  const mock = await startMockGreasyfork()
  const previous = process.env.GREASYFORK_COOKIE
  process.env.GREASYFORK_COOKIE = '_greasyfork_session=session-good'
  try {
    const { tools } = makePlugin(mock)
    const result = await tools.get('greasyfork_push').execute({ code: GOOD }, execFor(process.cwd()))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.action, 'created')
    assert.equal(result.scriptId, 1001)
    assert.match(result.url, /\/en\/scripts\/1001/)
    assert.equal(result.credentialSource, 'env:GREASYFORK_COOKIE')
  } finally {
    if (previous === undefined) delete process.env.GREASYFORK_COOKIE
    else process.env.GREASYFORK_COOKIE = previous
    await mock.close()
  }
})

test('greasyfork_push：dryRun 不发布', async () => {
  const mock = await startMockGreasyfork()
  const previous = process.env.GREASYFORK_COOKIE
  process.env.GREASYFORK_COOKIE = '_greasyfork_session=session-good'
  try {
    const { tools } = makePlugin(mock)
    const result = await tools.get('greasyfork_push').execute({ code: GOOD, dryRun: true }, execFor(process.cwd()))
    assert.equal(result.ok, true)
    assert.equal(result.action, 'dry-run')
    assert.equal(mock.state.posts.length, 0)
  } finally {
    if (previous === undefined) delete process.env.GREASYFORK_COOKIE
    else process.env.GREASYFORK_COOKIE = previous
    await mock.close()
  }
})

test('greasyfork_status：读线上脚本信息', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.scripts.set(7007, {
      id: 7007,
      name: 'Demo Script',
      description: 'd',
      namespace: 'https://example.com/demo',
      version: '3.1.0',
      code: GOOD,
      versions: ['3.1.0', '3.0.0']
    })
    const { tools } = makePlugin(mock)
    const result = await tools.get('greasyfork_status').execute({ scriptId: '7007' }, execFor(process.cwd()))
    assert.equal(result.ok, true)
    assert.equal(result.version, '3.1.0')
    assert.equal(result.versions.length, 2)
  } finally {
    await mock.close()
  }
})

test('凭证与输出：任何工具结果里都不出现 Cookie 原文', async () => {
  const mock = await startMockGreasyfork()
  const previous = process.env.GREASYFORK_COOKIE
  const secret = '_greasyfork_session=SUPER-SECRET-VALUE'
  process.env.GREASYFORK_COOKIE = secret
  try {
    const { tools } = makePlugin(mock)
    const auth = tools.get('greasyfork_auth')
    const status = await auth.execute({ action: 'status' }, execFor(process.cwd()))
    assert.equal(status.configured, true)
    assert.ok(!JSON.stringify(status).includes('SUPER-SECRET-VALUE'), 'auth status 泄露了 Cookie 值')

    const push = await tools.get('greasyfork_push').execute({ code: GOOD, dryRun: true }, execFor(process.cwd()))
    assert.ok(!JSON.stringify(push).includes('SUPER-SECRET-VALUE'), 'push 结果泄露了 Cookie 值')

    const pre = await tools.get('greasyfork_preflight').execute({ code: GOOD }, execFor(process.cwd()))
    assert.ok(!JSON.stringify(pre).includes('SUPER-SECRET-VALUE'), 'preflight 结果泄露了 Cookie 值')
  } finally {
    if (previous === undefined) delete process.env.GREASYFORK_COOKIE
    else process.env.GREASYFORK_COOKIE = previous
    await mock.close()
  }
})

test('凭证来自 harness 凭证服务时也能发布', async () => {
  const mock = await startMockGreasyfork()
  const previous = process.env.GREASYFORK_COOKIE
  delete process.env.GREASYFORK_COOKIE
  const credentials = {
    async readRecord(key) {
      assert.equal(key, 'greasyfork/cookie')
      return { kind: 'grant', payload: { cookie: '_greasyfork_session=session-good', username: 'store-user' } }
    }
  }
  try {
    const { tools } = makePlugin(mock, credentials)
    const result = await tools.get('greasyfork_push').execute({ code: GOOD }, execFor(process.cwd()))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.credentialSource, 'credential-store:greasyfork/cookie')
  } finally {
    if (previous !== undefined) process.env.GREASYFORK_COOKIE = previous
    await mock.close()
  }
})

test('greasyfork_push：没凭证时给出 E_NO_CREDENTIAL 与配置指引', async () => {
  const previous = process.env.GREASYFORK_COOKIE
  delete process.env.GREASYFORK_COOKIE
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = `${process.cwd()}/.tmp-no-credential`
  try {
    const { tools } = makePlugin({ url: 'http://127.0.0.1:1', apiUrl: 'http://127.0.0.1:1/api' })
    const result = await tools.get('greasyfork_push').execute({ code: GOOD }, execFor(process.cwd()))
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_NO_CREDENTIAL')
    assert.match(result.hint, /auth set|greasyfork_auth/)
  } finally {
    if (previous !== undefined) process.env.GREASYFORK_COOKIE = previous
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('greasyfork_push：本地文件路径（相对 cwd）', async () => {
  const mock = await startMockGreasyfork()
  const previous = process.env.GREASYFORK_COOKIE
  process.env.GREASYFORK_COOKIE = '_greasyfork_session=session-good'
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gf-src-'))
  try {
    await writeFile(join(dir, 'demo.user.js'), GOOD, 'utf8')
    const { tools } = makePlugin(mock)
    const result = await tools.get('greasyfork_push').execute({ file: 'demo.user.js' }, execFor(dir))
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.summary.source, join(dir, 'demo.user.js'))
  } finally {
    if (previous === undefined) delete process.env.GREASYFORK_COOKIE
    else process.env.GREASYFORK_COOKIE = previous
    await rm(dir, { recursive: true, force: true })
    await mock.close()
  }
})
