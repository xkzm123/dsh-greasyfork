/**
 * 列表页解析：GreasyFork 没有"我的脚本"JSON 接口，只能读 HTML。
 * 这里用真实页面的结构片段做样本。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { listPath, parseScriptLinks, parseScriptVersion } from '../lib/core/list.js'

const SAMPLE = `
<ul class="script-list">
  <li class="script-list-item">
    <span class="script-list-version"><span class="script-version">1.2.3</span></span>
    <a class="script-link" href="/zh-CN/scripts/595909-dzmm-ai-%E5%A2%9E%E5%BC%BA%E5%8A%A9%E6%89%8B">DZMM AI 增强助手</a>
  </li>
  <li class="script-list-item">
    <a class="script-link" href="/zh-CN/scripts/558518-page-scroll">页面滚动神器 <em>手机</em></a>
  </li>
  <li class="script-list-item">
    <a href="/zh-CN/scripts/libraries">库</a>
  </li>
</ul>
<nav><a href="/zh-CN/scripts/595909-dzmm-ai-%E5%A2%9E%E5%BC%BA%E5%8A%A9%E6%89%8B">重复链接不该出现两次</a></nav>
`

test('parseScriptLinks：抠出 id / 名称 / 链接，且按 id 去重', () => {
  const items = parseScriptLinks(SAMPLE, { site: 'https://greasyfork.org' })
  assert.equal(items.length, 2)
  assert.deepEqual(items.map((i) => i.id), [595909, 558518])
  assert.equal(items[0].name, 'DZMM AI 增强助手')
  assert.equal(items[1].name, '页面滚动神器 手机')
  assert.equal(items[0].url, 'https://greasyfork.org/zh-CN/scripts/595909-dzmm-ai-%E5%A2%9E%E5%BC%BA%E5%8A%A9%E6%89%8B')
  assert.equal(items[0].path, '/zh-CN/scripts/595909-dzmm-ai-%E5%A2%9E%E5%BC%BA%E5%8A%A9%E6%89%8B')
})

test('parseScriptLinks：空页面 / 没登录的页面返回空数组', () => {
  assert.deepEqual(parseScriptLinks(''), [])
  assert.deepEqual(parseScriptLinks('<p>no scripts</p>'), [])
})

test('parseScriptVersion：能取到列表里的版本号', () => {
  assert.equal(parseScriptVersion(SAMPLE), '1.2.3')
  assert.equal(parseScriptVersion('<p>x</p>'), null)
})

test('listPath：四种 scope 的路径', () => {
  assert.equal(listPath({ scope: 'mine', userId: 1482629, userName: 'xkzm123' }), '/users/1482629-xkzm123')
  assert.equal(listPath({ scope: 'popular' }), '/scripts?sort=total_installs&page=1')
  assert.equal(listPath({ scope: 'popular', page: 3 }), '/scripts?sort=total_installs&page=3')
  assert.equal(listPath({ scope: 'libraries' }), '/scripts/libraries')
  assert.equal(listPath({ scope: 'search', query: '哔哩哔哩 bilibili' }), '/scripts?q=%E5%93%94%E5%93%A9%E5%93%94%E5%93%A9%20bilibili&page=1')
  assert.throws(() => listPath({ scope: 'mine' }), /登录/)
  assert.throws(() => listPath({ scope: 'search' }), /query/)
  assert.throws(() => listPath({ scope: 'nope' }), /未知 scope/)
})
