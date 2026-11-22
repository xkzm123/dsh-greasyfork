import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  CREDENTIAL_ENV,
  clearCredentialFile,
  credentialFilePath,
  describeCookieExpiry,
  normalizeCookieInput,
  parseCookieEntries,
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
  assert.equal(normalizeCookieInput('  a=1 ;; b=2 ;  '), 'a=1; b=2')
})

test('parseCookieEntries 支持 Cookie-Editor 的 JSON 导出', () => {
  const raw = JSON.stringify([
    { domain: '.greasyfork.org', name: '_ga', value: 'GA1.1.1', expirationDate: 1829891609.26 },
    { domain: 'greasyfork.org', name: '_greasyfork_session', value: 'abc%3D%3D', session: true }
  ])
  const entries = parseCookieEntries(raw)
  assert.equal(entries.length, 2)
  assert.equal(entries[1].name, '_greasyfork_session')
  assert.equal(entries[0].expires, 1829891609.26)
  assert.equal(entries[1].expires, null)
  assert.equal(normalizeCookieInput(raw), '_ga=GA1.1.1; _greasyfork_session=abc%3D%3D')
})

test('parseCookieEntries 支持 Netscape cookies.txt', () => {
  const raw = [
    '# Netscape HTTP Cookie File',
    '.greasyfork.org\tTRUE\t/\tTRUE\t1829891609\t_greasyfork_session\tXYZ',
    '.greasyfork.org\tTRUE\t/\tFALSE\t0\tlocale_messaged\ttrue'
  ].join('\n')
  const entries = parseCookieEntries(raw)
  assert.equal(entries.length, 2)
  assert.equal(entries[0].name, '_greasyfork_session')
  assert.equal(entries[0].expires, 1829891609)
  assert.equal(entries[1].expires, null)
})

test('parseCookieEntries 支持 JSON 对象与单值', () => {
  assert.equal(normalizeCookieInput('{"_greasyfork_session":"abc"}'), '_greasyfork_session=abc')
  assert.equal(normalizeCookieInput('_greasyfork_session=abc'), '_greasyfork_session=abc')
  assert.equal(parseCookieEntries('随便一段不是 cookie 的文字').length, 0)
})

test('describeCookieExpiry 能算出剩余天数与会话型标记', () => {
  const future = Math.floor(Date.now() / 1000) + 10 * 86400
  const withExpiry = describeCookieExpiry([
    { name: '_greasyfork_session', value: 'a', expires: future },
    { name: '_ga', value: 'b', expires: future }
  ])
  assert.equal(withExpiry.sessionScoped, false)
  assert.equal(withExpiry.daysLeft, 10)

  const sessionOnly = describeCookieExpiry([{ name: '_greasyfork_session', value: 'a', expires: null }])
  assert.equal(sessionOnly.sessionScoped, true)
  assert.equal(sessionOnly.daysLeft, null)
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
