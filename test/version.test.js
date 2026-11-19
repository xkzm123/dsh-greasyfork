import assert from 'node:assert/strict'
import test from 'node:test'
import { bumpVersion, compareVersions, isVersionLike, splitVersion } from '../lib/core/version.js'

// 这些期望值直接对照 greasyfork/app/models/script_version.rb 的 split_version 行为。
test('splitVersion 按 GreasyFork 的 4 段规则切分', () => {
  assert.deepEqual(splitVersion('1.2.3'), [1, '', 0, '', 2, '', 0, '', 3, '', 0, '', 0, '', 0, ''])
  assert.deepEqual(splitVersion('1.6a'), [1, '', 0, '', 6, 'a', 0, '', 0, '', 0, '', 0, '', 0, ''])
  assert.deepEqual(splitVersion('20231121.2').slice(0, 4), [20231121, '', 0, ''])
  // Ruby 的 split('.', 4) 只取前 4 段，多出来的忽略
  assert.deepEqual(splitVersion('2.0.0.0.1'), splitVersion('2.0.0.0.9'))
})

test('compareVersions 与站点一致', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1)
  assert.equal(compareVersions('1.0', '1.0.0'), 0)
  assert.equal(compareVersions('1.10', '1.9'), 1)
  // 有字符串的一段更小：1.6a < 1.6
  assert.equal(compareVersions('1.6a', '1.6'), -1)
  assert.equal(compareVersions('1.6', '1.6a'), 1)
  assert.equal(compareVersions('', '1.0'), null)
  assert.equal(compareVersions(null, '1.0'), null)
  assert.equal(compareVersions('1.0.0', undefined), null)
})

test('bumpVersion 递增最后一段数字（同站点自动生成规则）', () => {
  assert.equal(bumpVersion('1.0.0'), '1.0.0.1')
  assert.equal(bumpVersion('1.2'), '1.2.0.1')
  assert.equal(bumpVersion('20231121.2'), '20231121.2.0.1')
  assert.equal(bumpVersion('1.0.0.1'), '1.0.0.2')
})

test('isVersionLike 基本形态检查', () => {
  assert.equal(isVersionLike('1.0.0'), true)
  assert.equal(isVersionLike('1.0.0-beta.1'), true)
  assert.equal(isVersionLike(''), false)
  assert.equal(isVersionLike('   '), false)
  assert.equal(isVersionLike('x'.repeat(201)), false)
  assert.equal(isVersionLike('1.0 0'), false)
})
