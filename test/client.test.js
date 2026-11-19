/**
 * 设置页浏览器半边的测试：把 lib/client.js 放进 vm 里跑，用假 React / 假 slots
 * 验证「注册了 settings.section」以及「组件能渲染出配置区」。
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props: props || {}, children: children.flat() })
  return {
    createElement,
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useRef: (value) => ({ current: value })
  }
}

async function loadClient() {
  const code = await readFile(clientPath, 'utf8')
  let loaded = null
  const sandbox = {
    window: {},
    document: {
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, appendChild() {}, set textContent(v) {} }),
      head: { appendChild() {} },
      documentElement: { appendChild() {} }
    },
    navigator: {},
    fetch: async () => ({ ok: true, status: 200, text: async () => '{"ok":true}' }),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout,
    clearTimeout,
    console,
    URL,
    JSON
  }
  sandbox.window.__ModuleLoader__ = {
    load(spec) {
      loaded = spec
    }
  }
  vm.runInNewContext(code, sandbox, { filename: 'client.js' })
  assert.ok(loaded, 'client.js 没有调用 __ModuleLoader__.load')
  return loaded
}

test('client bundle：注册 id 与入口形状正确', async () => {
  const spec = await loadClient()
  assert.equal(spec.id, 'dsh-greasyfork')
  const mod = spec.factory((name) => {
    if (name === 'react') return fakeReact()
    throw new Error(`unexpected require(${name})`)
  })
  assert.equal(typeof mod.apply, 'function')
  assert.equal(mod.inject.length, 1)
  assert.equal(mod.inject[0], 'slots')
  assert.equal(mod.SECTION_ID, 'greasyfork')
})

test('client bundle：apply 在 settings.section 里注册 GreasyFork 面板', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())
  const registered = []
  const injected = []
  const ctx = {
    slots: {
      inject(name, cb) {
        injected.push(name)
        return cb()
      },
      register(spec, component) {
        registered.push({ spec, component })
        return () => {}
      }
    },
    effect(fn) {
      fn()
    }
  }
  mod.apply(ctx)
  assert.ok(injected.includes('settings.section'), `注入的槽位：${injected.join(', ')}`)
  const section = registered.find((r) => r.spec.name === 'settings.section')
  assert.ok(section, '没有注册 settings.section')
  assert.equal(section.spec.id, 'greasyfork')
  assert.equal(section.spec.label(), 'GreasyFork')
  assert.equal(typeof section.component, 'function')
})

test('client bundle：面板能渲染出两种获取方式与状态区', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())
  let component
  const ctx = {
    slots: {
      inject: (_name, cb) => cb(),
      register: (s, c) => {
        if (s.name === 'settings.section') component = c
        return () => {}
      }
    },
    effect: (fn) => fn()
  }
  mod.apply(ctx)
  assert.equal(typeof component, 'function')
  const tree = component({})
  const text = JSON.stringify(tree)
  assert.ok(text.includes('GreasyFork'))
  assert.ok(text.includes('方式 A'))
  assert.ok(text.includes('方式 B'))
  assert.ok(text.includes('安装 Cookie 助手'))
  assert.ok(text.includes('保存并校验'))
  assert.ok(text.includes('打开登录页'))
  assert.ok(text.includes('当前状态'))
})

test('client bundle：没有 slots 服务时安静退出', async () => {
  const spec = await loadClient()
  const mod = spec.factory(() => fakeReact())
  assert.doesNotThrow(() => mod.apply({}))
  assert.doesNotThrow(() => mod.apply({ slots: {} }))
})
