/**
 * 内置手册：模型收到 GreasyFork 指令时先读这里，再用工具，而不是去点浏览器。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { TOPICS, renderGuide } from '../lib/core/guide.js'

test('renderGuide：不带 topic 返回总览 + 目录', () => {
  const text = renderGuide()
  assert.match(text, /不要用浏览器/)
  assert.match(text, /greasyfork_list/)
  assert.match(text, /greasyfork_push/)
  for (const topic of TOPICS.filter((t) => t !== 'overview')) {
    assert.ok(text.includes(topic), `目录里应该有 ${topic}`)
  }
})

test('renderGuide：每个章节都能单独渲染，且带关键内容', () => {
  const expectations = {
    overview: /看我的账号/,
    auth: /credentials\.json/,
    view: /scope="mine"/,
    publish: /dryRun/,
    update: /scriptId/,
    sync: /syncIdentifier/,
    prefill: /prefill/,
    errors: /E_CLOUDFLARE/,
    browser: /TLS 指纹/,
    rules: /不要用浏览器自动化/
  }
  for (const [topic, pattern] of Object.entries(expectations)) {
    const text = renderGuide(topic)
    assert.match(text, pattern, `${topic} 章节内容不对`)
  }
})

test('renderGuide：未知章节给出可用列表', () => {
  const text = renderGuide('nope')
  assert.match(text, /没有章节/)
  assert.match(text, /overview/)
})
