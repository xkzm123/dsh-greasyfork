/**
 * 只读线上冒烟测试（默认跳过）。
 *
 * 只访问 GreasyFork 的公开 JSON 接口，不登录、不写任何东西。
 * 手动跑：GREASYFORK_LIVE=1 node --test test/live-readonly.test.js
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { GreasyForkClient } from '../lib/core/client.js'

const live = process.env.GREASYFORK_LIVE === '1'

test('线上只读：读取公开脚本 JSON 与版本列表', { skip: !live && '设置 GREASYFORK_LIVE=1 才跑线上冒烟' }, async () => {
  const client = new GreasyForkClient({ timeoutMs: 20000 })
  const script = await client.getScript(1)
  assert.ok(script, '脚本 1 应该存在')
  assert.equal(typeof script.name, 'string')
  assert.equal(typeof script.version, 'string')
  const versions = await client.getVersions(1)
  assert.ok(Array.isArray(versions))
  assert.ok(versions.length > 0)
  assert.equal(versions[0].version, script.version)
})

test('线上只读：脚本 id 从 URL 解析后可直接查询', { skip: !live && '设置 GREASYFORK_LIVE=1 才跑线上冒烟' }, async () => {
  const client = new GreasyForkClient({ timeoutMs: 20000 })
  const script = await client.getScript('https://greasyfork.org/en/scripts/1-greasemonkey-tampermonkey-violentmonkey-test-style')
  assert.equal(script.id, 1)
})
