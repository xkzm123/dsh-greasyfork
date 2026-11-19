import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CREDENTIAL_ENV,
  clearCredentialFile,
  credentialFilePath,
  normalizeCookieInput,
  readCredentialFile,
  redactCookie,
  resolveCredential,
  saveCredential
} from '../lib/core/credentials.js'

async function withHome(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gf-test-'))
  const previous = process.env.DSH_HOME
  const previousCookie = process.env[CREDENTIAL_ENV]
  process.env.DSH_HOME = dir
  delete process.env[CREDENTIAL_ENV]
  try {
    await fn(dir)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    if (previousCookie === undefined) delete process.env[CREDENTIAL_ENV]
    else process.env[CREDENTIAL_ENV] = previousCookie
    await rm(dir, { recursive: true, force: true })
  }
}

test('normalizeCookieInput 支持整段 Cookie 头与多行', () => {
  assert.equal(normalizeCookieInput('Cookie: a=1; b=2'), 'a=1; b=2')
  assert.equal(normalizeCookieInput('a=1\nb=2\n'), 'a=1; b=2')
  assert.equal(normalizeCookieInput('  a=1 ;; b=2 ;  '), 'a=1 ; b=2')
})

test('redactCookie 只暴露名字', () => {
  const info = redactCookie('_greasyfork_session=SECRET; cf_clearance=XYZ')
  assert.deepEqual(info.names, ['_greasyfork_session', 'cf_clearance'])
  assert.equal(info.hasSession, true)
  assert.equal(info.hasCfClearance, true)
  assert.ok(!JSON.stringify(info).includes('SECRET'))
})

test('凭证文件：写入 0600、可读、可清除', async () => {
  await withHome(async () => {
    const saved = await saveCredential({ cookie: '_greasyfork_session=abc; cf_clearance=def', username: 'tester' })
    assert.equal(saved.file, credentialFilePath())
    const read = await readCredentialFile()
    assert.equal(read.cookie, '_greasyfork_session=abc; cf_clearance=def')
    assert.equal(read.username, 'tester')

    const file = saved.file
    if (process.platform !== 'win32') {
      const info = await stat(file)
      assert.equal(info.mode & 0o777, 0o600)
    }

    const raw = await readFile(file, 'utf8')
    assert.ok(raw.includes('_greasyfork_session=abc'))

    await clearCredentialFile()
    assert.equal(await readCredentialFile(), undefined)
  })
})

test('没有 _greasyfork_session 的 Cookie 被拒绝保存', async () => {
  await withHome(async () => {
    await assert.rejects(() => saveCredential({ cookie: 'foo=bar' }), /_greasyfork_session/)
  })
})

test('解析优先级：env > 文件', async () => {
  await withHome(async () => {
    await saveCredential({ cookie: '_greasyfork_session=from-file' })
    const fromFile = await resolveCredential({ env: process.env })
    assert.equal(fromFile.cookie, '_greasyfork_session=from-file')
    assert.match(fromFile.source, /^file:/)

    process.env[CREDENTIAL_ENV] = '_greasyfork_session=from-env'
    const fromEnv = await resolveCredential({ env: process.env })
    assert.equal(fromEnv.cookie, '_greasyfork_session=from-env')
    assert.equal(fromEnv.source, `env:${CREDENTIAL_ENV}`)

    const override = await resolveCredential({ env: process.env, override: '_greasyfork_session=inline' })
    assert.equal(override.cookie, '_greasyfork_session=inline')
    assert.equal(override.source, 'tool-argument')
  })
})

test('harness 凭证服务可用时优先于文件', async () => {
  await withHome(async () => {
    await saveCredential({ cookie: '_greasyfork_session=from-file' })
    const credentials = {
      async readRecord() {
        return { kind: 'grant', payload: { cookie: '_greasyfork_session=from-store', username: 'store-user' } }
      }
    }
    const resolved = await resolveCredential({ credentials, env: process.env })
    assert.equal(resolved.cookie, '_greasyfork_session=from-store')
    assert.equal(resolved.username, 'store-user')
    assert.equal(resolved.source, 'credential-store:greasyfork/cookie')
  })
})

test('凭证服务抛错时安静降级到文件', async () => {
  await withHome(async () => {
    await saveCredential({ cookie: '_greasyfork_session=from-file' })
    const credentials = {
      async readRecord() {
        throw new Error('store broken')
      },
      async resolve() {
        throw new Error('store broken')
      }
    }
    const resolved = await resolveCredential({ credentials, env: process.env })
    assert.equal(resolved.cookie, '_greasyfork_session=from-file')
  })
})

test('没有任何来源时返回 undefined', async () => {
  await withHome(async () => {
    assert.equal(await resolveCredential({ env: process.env }), undefined)
  })
})
