/**
 * 极简 CDP 仿真服务：只为在测试里验证 readCookies 的 WebSocket 协议处理。
 * 支持 /json/version、/json/list 与 Network.enable / Network.getAllCookies。
 */

import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64')
}

function decodeFrames(buffer) {
  const messages = []
  let offset = 0
  while (offset + 2 <= buffer.length) {
    const first = buffer[offset]
    const second = buffer[offset + 1]
    const opcode = first & 0x0f
    const masked = (second & 0x80) !== 0
    let length = second & 0x7f
    let cursor = offset + 2
    if (length === 126) {
      if (cursor + 2 > buffer.length) break
      length = buffer.readUInt16BE(cursor)
      cursor += 2
    } else if (length === 127) {
      if (cursor + 8 > buffer.length) break
      length = Number(buffer.readBigUInt64BE(cursor))
      cursor += 8
    }
    let mask = null
    if (masked) {
      if (cursor + 4 > buffer.length) break
      mask = buffer.subarray(cursor, cursor + 4)
      cursor += 4
    }
    if (cursor + length > buffer.length) break
    const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
    if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
    messages.push({ opcode, payload })
    offset = cursor + length
  }
  return { messages, rest: buffer.subarray(offset) }
}

function encodeFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.from([0x81, len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, payload])
}

/**
 * @param {{ cookies?: Array<object>, failNetworkEnable?: boolean }} [options]
 */
export async function startFakeCdp(options = {}) {
  const cookies = options.cookies ?? [
    { name: '_greasyfork_session', value: 'SESSION-VALUE', domain: '.greasyfork.org', httpOnly: true },
    { name: 'cf_clearance', value: 'CF-VALUE', domain: '.greasyfork.org', httpOnly: true },
    { name: 'other', value: 'x', domain: '.example.com', httpOnly: false }
  ]
  const state = { commands: [], connections: 0 }

  const server = createServer((req, res) => {
    if (req.url.startsWith('/json/version')) {
      const port = server.address().port
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ Browser: 'FakeChrome/1.0', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake` }))
      return
    }
    if (req.url.startsWith('/json/list')) {
      const port = server.address().port
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify([
          {
            id: 'PAGE1',
            type: 'page',
            url: 'https://greasyfork.org/en/users/sign_in',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/PAGE1`
          }
        ])
      )
      return
    }
    res.writeHead(404)
    res.end('not found')
  })

  server.on('upgrade', (req, socket) => {
    state.connections += 1
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}`,
        '',
        ''
      ].join('\r\n')
    )
    let buffer = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      const { messages, rest } = decodeFrames(buffer)
      buffer = rest
      for (const message of messages) {
        if (message.opcode === 0x8) {
          socket.end()
          return
        }
        if (message.opcode !== 0x1) continue
        let command
        try {
          command = JSON.parse(message.payload.toString('utf8'))
        } catch {
          continue
        }
        state.commands.push(command.method)
        let result = {}
        let error = null
        if (command.method === 'Network.enable') {
          if (options.failNetworkEnable) error = { code: -32601, message: 'not supported' }
        } else if (command.method === 'Network.getAllCookies') {
          result = { cookies }
        } else if (command.method === 'Storage.getCookies') {
          result = { cookies }
        } else if (command.method === 'Browser.close') {
          result = {}
        }
        const reply = error ? { id: command.id, error } : { id: command.id, result }
        socket.write(encodeFrame(JSON.stringify(reply)))
      }
    })
    socket.on('error', () => {})
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: server.address().port,
    state,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      })
  }
}
