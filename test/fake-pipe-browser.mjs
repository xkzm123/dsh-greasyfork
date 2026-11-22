/**
 * 仿真"管道模式的浏览器"：只实现插件用到的那几个 CDP 命令。
 *
 * 真浏览器不方便在单测里拉起来，但 `--remote-debugging-pipe` 的**分帧**
 * （fd3/fd4 + `\0` 分隔）必须被真实验证，否则接错 fd 就会永远读不到 cookie。
 */

import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

/**
 * @param {{ cookies?: Array<object>, failStorage?: boolean, version?: string }} [options]
 */
export function startFakePipeBrowser(options = {}) {
  const cookies = options.cookies ?? [
    { name: '_greasyfork_session', value: 'SESSION-VALUE', domain: '.greasyfork.org', httpOnly: true },
    { name: 'cf_clearance', value: 'CF-VALUE', domain: '.greasyfork.org', httpOnly: true }
  ]
  const state = { commands: [], spawns: [], targets: [], evaluated: [], setCookies: [], closed: false, killed: false }

  /** 每次 spawn 都造一对管道：fd3 = 我们写浏览器读，fd4 = 浏览器写我们读。 */
  function spawnFn(exePath, args) {
    state.spawns.push({ exePath, args })
    const toBrowser = new PassThrough()
    const fromBrowser = new PassThrough()
    const child = new EventEmitter()
    child.stdio = [null, null, null, toBrowser, fromBrowser]
    child.pid = 4242 + state.spawns.length
    child.kill = () => {
      state.killed = true
      child.emit('exit', 0, null)
      return true
    }

    let buffer = ''
    toBrowser.setEncoding('utf8')
    toBrowser.on('data', (chunk) => {
      buffer += chunk
      let index = buffer.indexOf('\u0000')
      while (index >= 0) {
        const text = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\u0000')
        if (text.trim() === '') continue
        let command
        try {
          command = JSON.parse(text)
        } catch {
          continue
        }
        state.commands.push(command.method)
        let result = {}
        let error = null
        if (command.method === 'Browser.getVersion') {
          result = { Browser: options.version ?? 'FakeChrome/1.0', protocolVersion: '1.3' }
        } else if (command.method === 'Target.createTarget') {
          const targetId = 'TARGET' + (state.targets.length + 1)
          state.targets.push({ id: targetId, url: command.params?.url })
          result = { targetId }
        } else if (command.method === 'Target.attachToTarget') {
          result = { sessionId: 'SESSION1' }
        } else if (command.method === 'Target.detachFromTarget') {
          result = {}
        } else if (command.method === 'Runtime.evaluate') {
          state.evaluated.push(command.params?.expression ?? '')
          const value = options.pageEval ?? { status: 200, url: 'https://greasyfork.org/en/users/edit', signIn: false, username: 'browser-user' }
          result = { result: { type: 'object', value } }
        } else if (command.method === 'Target.getTargets') {
          result = {
            targetInfos: state.targets.map((t) => ({ targetId: t.id, type: 'page', url: t.url, title: '' }))
          }
        } else if (command.method === 'Target.activateTarget') {
          result = {}
        } else if (command.method === 'Storage.setCookies') {
          state.setCookies = command.params?.cookies ?? []
          result = {}
        } else if (command.method === 'Storage.getCookies') {
          if (options.failStorage) error = { code: -32601, message: 'not supported' }
          else result = { cookies }
        } else if (command.method === 'Network.getAllCookies') {
          result = { cookies }
        } else if (command.method === 'Browser.close') {
          state.closed = true
          result = {}
        } else {
          error = { code: -32601, message: `unknown method ${command.method}` }
        }
        fromBrowser.write(JSON.stringify(error ? { id: command.id, error } : { id: command.id, result }) + '\u0000')
      }
    })

    return child
  }

  return { spawnFn, state }
}
