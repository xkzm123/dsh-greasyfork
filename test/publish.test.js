import assert from 'node:assert/strict'
import test from 'node:test'
import { GreasyForkClient } from '../lib/core/client.js'
import { executePublish, preparePublish, renderPlan, runSync } from '../lib/core/publish.js'
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

function makeClient(mock, cookie = '_greasyfork_session=session-good') {
  return new GreasyForkClient({ site: mock.url, apiSite: mock.apiUrl, cookie, timeoutMs: 5000 })
}

test('首次发布：create 走表单并返回脚本链接与版本', async () => {
  const mock = await startMockGreasyfork()
  try {
    const client = makeClient(mock)
    const plan = await preparePublish({ source: { code: GOOD }, client })
    assert.equal(plan.ok, true)
    assert.equal(plan.action, 'create')

    const result = await executePublish({ plan, client })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.action, 'created')
    assert.equal(result.scriptId, 1001)
    assert.equal(result.version, '1.0.0')
    assert.match(result.url, /\/en\/scripts\/1001/)

    const posted = mock.state.posts.at(-1)
    assert.equal(posted.kind, 'create')
    assert.equal(posted.form['script[script_type]'], '1')
    assert.equal(posted.form['script_version[code]'], GOOD)
    assert.ok(posted.form.authenticity_token)
  } finally {
    await mock.close()
  }
})

test('更新已有脚本：带上 changelog 发布新版本', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.scripts.set(2002, {
      id: 2002,
      name: 'Demo Script',
      description: 'A demo userscript for tests',
      namespace: 'https://example.com/demo',
      version: '1.0.0',
      code: GOOD,
      versions: ['1.0.0']
    })
    const client = makeClient(mock)
    const next = GOOD.replace('1.0.0', '1.1.0').replace("console.log('hello')", "console.log('hello v1.1')")
    const plan = await preparePublish({
      source: { code: next },
      scriptId: 2002,
      options: { changelog: '修复若干问题' },
      client
    })
    assert.equal(plan.ok, true, renderPlan(plan))
    assert.equal(plan.action, 'update')
    assert.equal(plan.stats.codeChanged, true)

    const result = await executePublish({ plan, client, options: { changelog: '修复若干问题' } })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(result.action, 'updated')
    assert.equal(result.previousVersion, '1.0.0')
    assert.equal(result.version, '1.1.0')

    const posted = mock.state.posts.at(-1)
    assert.equal(posted.kind, 'update')
    assert.equal(posted.scriptId, 2002)
    assert.equal(posted.form['script_version[changelog]'], '修复若干问题')
  } finally {
    await mock.close()
  }
})

test('代码与版本都没变：默认拦下，force 放行', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.scripts.set(3003, {
      id: 3003,
      name: 'Demo Script',
      description: 'A demo userscript for tests',
      namespace: 'https://example.com/demo',
      version: '1.0.0',
      code: GOOD,
      versions: ['1.0.0']
    })
    const client = makeClient(mock)
    const plan = await preparePublish({ source: { code: GOOD }, scriptId: 3003, client })
    assert.equal(plan.ok, false)
    assert.ok(plan.errors.some((e) => e.code === 'E_NO_CHANGES'))

    const forced = await preparePublish({ source: { code: GOOD }, scriptId: 3003, options: { force: true }, client })
    assert.equal(forced.ok, true)
  } finally {
    await mock.close()
  }
})

test('版本未递增：站点拒绝 → 暴露 neededOverrides；acceptWarnings 后重试成功', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.scripts.set(4004, {
      id: 4004,
      name: 'Demo Script',
      description: 'A demo userscript for tests',
      namespace: 'https://example.com/demo',
      version: '1.0.0',
      code: GOOD,
      versions: ['1.0.0']
    })
    const client = makeClient(mock)
    const changed = GOOD.replace("console.log('hello')", "console.log('hello again')")
    const plan = await preparePublish({ source: { code: changed }, scriptId: 4004, client })
    // 本地预检已经把版本冲突标成阻塞性告警
    assert.ok(plan.warnings.some((w) => w.code === 'version_not_incremented'))

    const denied = await executePublish({ plan, client })
    assert.equal(denied.ok, false)
    assert.equal(denied.code, 'E_VALIDATION')
    assert.deepEqual(denied.neededOverrides, ['versionCheckOverride'])

    const retried = await executePublish({ plan, client, options: { acceptWarnings: true } })
    assert.equal(retried.ok, true, JSON.stringify(retried))
    const last = mock.state.posts.at(-1)
    assert.equal(last.form['script_version[version_check_override]'], '1')
  } finally {
    await mock.close()
  }
})

test('新建时被人机验证拦住 → 返回 E_RECAPTCHA 与降级建议', async () => {
  const mock = await startMockGreasyfork()
  try {
    const client = makeClient(mock)
    const code = GOOD.replace('Demo Script', 'RECAPTCHA')
    const plan = await preparePublish({ source: { code }, client })
    const result = await executePublish({ plan, client })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_RECAPTCHA')
    assert.equal(result.fallback.mode, 'prefill')
  } finally {
    await mock.close()
  }
})

test('prefill 降级：POST 预填后给出表单地址', async () => {
  const mock = await startMockGreasyfork()
  try {
    const client = makeClient(mock)
    const plan = await preparePublish({ source: { code: GOOD }, client })
    const result = await executePublish({ plan, client, options: { mode: 'prefill' } })
    assert.equal(result.ok, true)
    assert.equal(result.action, 'prefilled')
    assert.match(result.formUrl, /\/en\/script_versions\/new$/)
    assert.equal(mock.state.prefillBodies.length, 1)
  } finally {
    await mock.close()
  }
})

test('会话失效：Cookie 不对时明确报 E_AUTH_EXPIRED', async () => {
  const mock = await startMockGreasyfork()
  try {
    const client = makeClient(mock, '_greasyfork_session=stale')
    const plan = await preparePublish({ source: { code: GOOD }, client })
    const result = await executePublish({ plan, client })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_AUTH_EXPIRED')
  } finally {
    await mock.close()
  }
})

test('Cloudflare 挑战：识别为 E_CLOUDFLARE', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.challengeAll = true
    const client = makeClient(mock)
    const plan = await preparePublish({ source: { code: GOOD }, client })
    const result = await executePublish({ plan, client })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_CLOUDFLARE')
  } finally {
    await mock.close()
  }
})

test('dryRun 不发写请求', async () => {
  const mock = await startMockGreasyfork()
  try {
    const client = makeClient(mock)
    const plan = await preparePublish({ source: { code: GOOD }, client })
    const result = await executePublish({ plan, client, options: { dryRun: true } })
    assert.equal(result.ok, true)
    assert.equal(result.action, 'dry-run')
    assert.equal(mock.state.posts.length, 0)
    assert.match(result.text, /新建脚本/)
  } finally {
    await mock.close()
  }
})

test('sync 模式：PATCH sync_update 并读到同步结果', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.scripts.set(5005, {
      id: 5005,
      name: 'Demo Script',
      description: 'd',
      namespace: 'https://example.com/demo',
      version: '1.0.0',
      code: GOOD,
      versions: ['1.0.0']
    })
    const client = makeClient(mock)
    const result = await runSync({
      client,
      scriptId: 5005,
      syncIdentifier: 'https://raw.githubusercontent.com/u/r/main/demo.user.js',
      syncType: 'manual'
    })
    assert.equal(result.ok, true)
    assert.equal(result.status, 'synced')
    const patch = mock.state.patches.at(-1)
    assert.equal(patch.form['update-and-sync'], '1')
    assert.equal(patch.form['script[sync_type]'], 'manual')
  } finally {
    await mock.close()
  }
})

test('更新 unlisted 脚本时默认保持原可见性（不会被改成 public）', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.scripts.set(8008, {
      id: 8008,
      name: 'Demo Script',
      description: 'A demo userscript for tests',
      namespace: 'https://example.com/demo',
      scriptType: 'unlisted',
      version: '1.0.0',
      code: GOOD,
      versions: ['1.0.0']
    })
    const client = makeClient(mock)
    const next = GOOD.replace('1.0.0', '1.0.1')
    const plan = await preparePublish({ source: { code: next }, scriptId: 8008, client })
    assert.equal(plan.scriptType, 'unlisted', '未显式指定时应沿用线上可见性')
    const result = await executePublish({ plan, client })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(mock.state.posts.at(-1).form['script[script_type]'], '2')
    assert.equal(mock.state.scripts.get(8008).scriptType, 'unlisted')
  } finally {
    await mock.close()
  }
})

test('显式指定 scriptType 时以调用方为准', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.scripts.set(9009, {
      id: 9009,
      name: 'Demo Script',
      description: 'A demo userscript for tests',
      namespace: 'https://example.com/demo',
      scriptType: 'unlisted',
      version: '1.0.0',
      code: GOOD,
      versions: ['1.0.0']
    })
    const client = makeClient(mock)
    const plan = await preparePublish({
      source: { code: GOOD.replace('1.0.0', '1.0.1') },
      scriptId: 9009,
      options: { scriptType: 'public' },
      client
    })
    assert.equal(plan.scriptType, 'public')
  } finally {
    await mock.close()
  }
})

test('status 类只读调用：getScript / getVersions 可用', async () => {
  const mock = await startMockGreasyfork()
  try {
    mock.state.scripts.set(6006, {
      id: 6006,
      name: 'Demo Script',
      description: 'd',
      namespace: 'https://example.com/demo',
      version: '2.0.0',
      code: GOOD,
      versions: ['2.0.0', '1.0.0']
    })
    const client = makeClient(mock)
    const script = await client.getScript(6006)
    assert.equal(script.version, '2.0.0')
    const versions = await client.getVersions(6006)
    assert.equal(versions.length, 2)
    const code = await client.getLatestCode(script)
    assert.match(code, /Demo Script/)
  } finally {
    await mock.close()
  }
})
