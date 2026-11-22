/**
 * 拿到 HttpOnly Cookie：由插件自己驱动一个 Chromium 内核浏览器，用 CDP 读它的 cookie 存储。
 *
 * 为什么只能这么做（本机实测结论）：
 *  - GreasyFork 的 `_greasyfork_session` 带 `HttpOnly`，页面里的 `document.cookie` 读不到；
 *  - Chrome/Edge 127+ 的 cookie 库改成 App-Bound 加密（本机全是 v20），外部进程解不开；
 *  - Electron 的 `session.cookies` 也拿不到——插件跑在 dsh 宿主 spawn 的子 Node 进程里。
 *
 * 传输层（1.3 起）：
 *  - 主通道 `--remote-debugging-pipe`（fd3/fd4 管道，`\0` 分帧）：不占端口、不依赖 WebSocket。
 *    实测新版 Edge 上「端口 + WebSocket」会出现握手成功但命令永不回包，管道没有这个问题。
 *  - 备通道 端口 + 手写 RFC6455 客户端（不协商 permessage-deflate）。
 *
 * 实例策略：单实例常驻。首次启动一次（专用 profile，登录态留在里面），之后每次采集
 * 只在**已打开的那个浏览器里新开一个标签页**（`Target.createTarget`），秒级完成。
 */

import { spawn, execFile } from 'node:child_process'
import net from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/* ─────────────────────────────────────────────────────────────────────────────
 * CDP 传输层（原 lib/core/cdp.js，1.4 起并入本文件）
 *
 * 为什么要自己写：
 *  - 端口 + WebSocket 那条路在新版 Edge（实测 Edg/156）上出现过「握手成功但命令
 *    永不回包」，Node 内置 WebSocket 协商 permessage-deflate 后对不上就会这样；
 *  - `--remote-debugging-pipe` 走 fd3/fd4 管道，不占端口、不过防火墙、不依赖
 *    任何 WebSocket 实现，是 puppeteer `pipe: true` 用的同一条路。
 * 所以：管道优先，端口 + 手写 RFC6455（不协商任何扩展）兜底。
 * ──────────────────────────────────────────────────────────────────────────── */

const PIPE_SEPARATOR = '\u0000'
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** CDP 相关错误：带上出错阶段，UI 才能告诉用户卡在哪。 */
export class CdpError extends Error {
  constructor(message, { method, stage, cause } = {}) {
    super(message)
    this.name = 'CdpError'
    this.method = method ?? null
    this.stage = stage ?? null
    if (cause) this.cause = cause
  }
}

/**
 * 命令客户端。transport 只需三件事：write / onMessage / onClose。
 * @param {{ write(text: string): void, onMessage(fn: (text: string) => void): void,
 *   onClose(fn: (reason?: string) => void): void, close(): void }} transport
 */
export function createCdpClient(transport, { defaultTimeoutMs = 8000 } = {}) {
  let seq = 0
  let closed = false
  let closeReason = null
  const pending = new Map()
  const listeners = new Map()

  transport.onMessage((text) => {
    let message
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id)
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(
          new CdpError(`${entry.method}: ${message.error.message ?? JSON.stringify(message.error)}`, {
            method: entry.method,
            stage: 'command'
          })
        )
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }
    if (message.method) {
      for (const fn of listeners.get(message.method) ?? []) {
        try {
          fn(message.params ?? {}, message)
        } catch {
          /* 监听器自己炸了不该影响协议 */
        }
      }
    }
  })

  transport.onClose((reason) => {
    closed = true
    closeReason = reason ?? null
    for (const [, entry] of pending) {
      clearTimeout(entry.timer)
      entry.reject(
        new CdpError(`连接已关闭${reason ? `（${reason}）` : ''}`, { method: entry.method, stage: 'transport' })
      )
    }
    pending.clear()
    for (const fn of listeners.get('close') ?? []) {
      try {
        fn(closeReason)
      } catch {
        /* 忽略 */
      }
    }
  })

  return {
    get closed() {
      return closed
    },
    get closeReason() {
      return closeReason
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, [])
      listeners.get(method).push(fn)
      return () => {
        const list = listeners.get(method) ?? []
        const index = list.indexOf(fn)
        if (index >= 0) list.splice(index, 1)
      }
    },
    send(method, params = {}, { sessionId, timeoutMs } = {}) {
      if (closed) {
        return Promise.reject(
          new CdpError(`连接已关闭${closeReason ? `（${closeReason}）` : ''}`, { method, stage: 'transport' })
        )
      }
      const id = ++seq
      const payload = sessionId ? { id, method, params, sessionId } : { id, method, params }
      const wait = timeoutMs ?? defaultTimeoutMs
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new CdpError(`${method} 超时（${wait}ms）`, { method, stage: 'timeout' }))
        }, wait)
        pending.set(id, { resolve, reject, timer, method })
        try {
          transport.write(JSON.stringify(payload))
        } catch (error) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new CdpError(`发送 ${method} 失败：${error?.message ?? error}`, { method, stage: 'transport', cause: error }))
        }
      })
    },
    close() {
      try {
        transport.close()
      } catch {
        /* 已经关了 */
      }
    }
  }
}

/**
 * 管道传输：`--remote-debugging-pipe`，命令/响应走 fd3/fd4，`\0` 分帧。
 * @param {{ exePath: string, args: string[], env?: object, spawnFn?: typeof spawn }} options
 */
export function createPipeTransport(options) {
  const { exePath, args, env = {}, spawnFn = spawn } = options
  const child = spawnFn(exePath, args, {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'],
    detached: false,
    windowsHide: false,
    env: { ...process.env, ...env }
  })
  const writable = child.stdio?.[3]
  const readable = child.stdio?.[4]
  if (!writable || !readable) {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
    throw new CdpError('拿不到管道的 fd3/fd4，无法建立 CDP 连接', { stage: 'spawn' })
  }

  let messageHandler = () => {}
  let closeHandler = () => {}
  let buffer = ''
  let closed = false

  const finish = (reason) => {
    if (closed) return
    closed = true
    closeHandler(reason)
  }

  readable.setEncoding('utf8')
  readable.on('data', (chunk) => {
    buffer += chunk
    let index = buffer.indexOf(PIPE_SEPARATOR)
    while (index >= 0) {
      const text = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (text.trim() !== '') messageHandler(text)
      index = buffer.indexOf(PIPE_SEPARATOR)
    }
  })
  readable.on('end', () => finish('管道已关闭'))
  readable.on('error', (error) => finish(`管道错误：${error?.message ?? error}`))
  writable.on('error', (error) => finish(`管道写入错误：${error?.message ?? error}`))
  child.on('exit', (code, signal) => finish(`浏览器已退出（code=${code}${signal ? `, signal=${signal}` : ''}）`))
  child.on('error', (error) => finish(`浏览器启动失败：${error?.message ?? error}`))

  return {
    child,
    write(text) {
      if (closed) throw new CdpError('管道已关闭', { stage: 'transport' })
      writable.write(text + PIPE_SEPARATOR)
    },
    onMessage(fn) {
      messageHandler = fn
    },
    onClose(fn) {
      closeHandler = fn
    },
    close() {
      finish('主动关闭')
      try {
        writable.end()
      } catch {
        /* 忽略 */
      }
      try {
        child.kill()
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 客户端帧：必须加掩码，且不带任何扩展。 */
function encodeClientFrame(text) {
  const payload = Buffer.from(text, 'utf8')
  const mask = randomBytes(4)
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x81, 0x80 | length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const masked = Buffer.alloc(length)
  for (let i = 0; i < length; i += 1) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/**
 * WebSocket 传输（手写 RFC6455，不请求 permessage-deflate）。
 * @param {string} wsUrl 形如 ws://127.0.0.1:9339/devtools/browser/xxx
 */
export function createWebSocketTransport(wsUrl, { timeoutMs = 8000 } = {}) {
  const url = new URL(wsUrl)
  const socket = net.connect(Number(url.port || 80), url.hostname)
  const key = randomBytes(16).toString('base64')
  let messageHandler = () => {}
  let closeHandler = () => {}
  let upgraded = false
  let closed = false
  let buffer = Buffer.alloc(0)
  const queued = []

  const finish = (reason) => {
    if (closed) return
    closed = true
    try {
      socket.destroy()
    } catch {
      /* 忽略 */
    }
    closeHandler(reason)
  }

  const timer = setTimeout(() => finish(`WebSocket 握手超时（${timeoutMs}ms）`), timeoutMs)

  socket.on('connect', () => {
    socket.write(
      `GET ${url.pathname}${url.search} HTTP/1.1\r\n` +
        `Host: ${url.host}\r\n` +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Key: ${key}\r\n` +
        'Sec-WebSocket-Version: 13\r\n\r\n'
    )
  })

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buffer.subarray(0, end).toString('utf8')
      const statusLine = head.split('\r\n')[0] ?? ''
      const expected = createHash('sha1')
        .update(key + WS_GUID)
        .digest('base64')
      const accept = /sec-websocket-accept:\s*(\S+)/i.exec(head)?.[1]
      buffer = buffer.subarray(end + 4)
      if (!/ 101 /.test(statusLine) || accept !== expected) {
        clearTimeout(timer)
        finish(`WebSocket 握手失败：${statusLine || '无响应'}`)
        return
      }
      clearTimeout(timer)
      upgraded = true
      // 握手前写进来的命令先补发，调用方不必关心连接状态
      while (queued.length > 0) {
        try {
          socket.write(encodeClientFrame(queued.shift()))
        } catch {
          break
        }
      }
    }
    while (buffer.length >= 2) {
      const first = buffer[0]
      const second = buffer[1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let length = second & 0x7f
      let cursor = 2
      if (length === 126) {
        if (buffer.length < cursor + 2) return
        length = buffer.readUInt16BE(cursor)
        cursor += 2
      } else if (length === 127) {
        if (buffer.length < cursor + 8) return
        length = Number(buffer.readBigUInt64BE(cursor))
        cursor += 8
      }
      let mask = null
      if (masked) {
        if (buffer.length < cursor + 4) return
        mask = buffer.subarray(cursor, cursor + 4)
        cursor += 4
      }
      if (buffer.length < cursor + length) return
      const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
      if (mask) for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
      buffer = buffer.subarray(cursor + length)
      if (opcode === 0x1) {
        messageHandler(payload.toString('utf8'))
      } else if (opcode === 0x8) {
        finish('浏览器关闭了 WebSocket')
        return
      } else if (opcode === 0x9) {
        // ping → pong（不带掩码的客户端帧不合规，这里仍按客户端规则加掩码）
        try {
          const pong = encodeClientFrame('')
          pong[0] = 0x8a
          socket.write(pong)
        } catch {
          /* 忽略 */
        }
      }
    }
  })

  socket.on('error', (error) => finish(`WebSocket 错误：${error?.message ?? error}`))
  socket.on('close', () => finish('WebSocket 已断开'))

  return {
    get upgraded() {
      return upgraded
    },
    write(text) {
      if (closed) throw new CdpError('WebSocket 已关闭', { stage: 'transport' })
      if (!upgraded) {
        queued.push(text)
        return
      }
      socket.write(encodeClientFrame(text))
    },
    onMessage(fn) {
      messageHandler = fn
    },
    onClose(fn) {
      closeHandler = fn
    },
    close() {
      if (!closed && upgraded) {
        try {
          socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]))
        } catch {
          /* 忽略 */
        }
      }
      finish('主动关闭')
    }
  }
}

/* ───────────────────────────── 传输层结束 ───────────────────────────── */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const execFileAsync = promisify(execFile)

const LOGIN_PATH = '/en/users/sign_in'

/** exe 文件名 → 浏览器 id。 */
function idFromExe(exePath) {
  const name = String(exePath ?? '').toLowerCase()
  if (/msedge\.exe|microsoft edge$/.test(name)) return 'edge'
  if (/chrome\.exe|google chrome$/.test(name)) return 'chrome'
  if (/brave\.exe|brave browser$/.test(name)) return 'brave'
  if (/vivaldi\.exe|vivaldi$/.test(name)) return 'vivaldi'
  if (/opera\.exe|opera$/.test(name)) return 'opera'
  if (/chromium\.exe|chromium$/.test(name)) return 'chromium'
  if (/firefox\.exe|firefox$/.test(name)) return 'firefox'
  if (/safari$/.test(name)) return 'safari'
  return null
}

const BROWSER_NAMES = {
  edge: 'Microsoft Edge',
  chrome: 'Google Chrome',
  brave: 'Brave',
  vivaldi: 'Vivaldi',
  opera: 'Opera',
  chromium: 'Chromium',
  firefox: 'Firefox',
  safari: 'Safari'
}

/** 能走 CDP 的内核。 */
const CHROMIUM_IDS = new Set(['edge', 'chrome', 'brave', 'vivaldi', 'opera', 'chromium'])

/** 候选浏览器（按平台）。 */
export function browserCandidates(platform = process.platform, env = process.env) {
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean)
    const out = []
    for (const root of roots) {
      out.push({ id: 'edge', name: BROWSER_NAMES.edge, path: join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe') })
      out.push({ id: 'chrome', name: BROWSER_NAMES.chrome, path: join(root, 'Google', 'Chrome', 'Application', 'chrome.exe') })
      out.push({ id: 'brave', name: BROWSER_NAMES.brave, path: join(root, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe') })
      out.push({ id: 'vivaldi', name: BROWSER_NAMES.vivaldi, path: join(root, 'Vivaldi', 'Application', 'vivaldi.exe') })
      out.push({ id: 'chromium', name: BROWSER_NAMES.chromium, path: join(root, 'Chromium', 'Application', 'chrome.exe') })
      out.push({ id: 'opera', name: BROWSER_NAMES.opera, path: join(root, 'Programs', 'Opera', 'launcher.exe') })
    }
    return out
  }
  if (platform === 'darwin') {
    return [
      { id: 'chrome', name: BROWSER_NAMES.chrome, path: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' },
      { id: 'edge', name: BROWSER_NAMES.edge, path: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' },
      { id: 'brave', name: BROWSER_NAMES.brave, path: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser' },
      { id: 'vivaldi', name: BROWSER_NAMES.vivaldi, path: '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi' },
      { id: 'chromium', name: BROWSER_NAMES.chromium, path: '/Applications/Chromium.app/Contents/MacOS/Chromium' }
    ]
  }
  return [
    { id: 'chrome', name: BROWSER_NAMES.chrome, path: '/usr/bin/google-chrome' },
    { id: 'chromium', name: BROWSER_NAMES.chromium, path: '/usr/bin/chromium' },
    { id: 'chromium', name: BROWSER_NAMES.chromium, path: '/usr/bin/chromium-browser' },
    { id: 'edge', name: BROWSER_NAMES.edge, path: '/usr/bin/microsoft-edge' },
    { id: 'brave', name: BROWSER_NAMES.brave, path: '/usr/bin/brave-browser' }
  ]
}

/** 文件是否存在且可执行。 */
async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 读 Windows 的"默认浏览器"ProgId（HKCU 的 https 协议关联）。
 * @returns {Promise<string|null>} 浏览器 id
 */
export async function defaultBrowserId(platform = process.platform, runner = execFileAsync) {
  if (platform !== 'win32') return null
  const stdout = await runReg(runner, USER_CHOICE_ARGS)
  if (!stdout) return null
  try {
    const match = /ProgId\s+REG_SZ\s+(\S+)/i.exec(stdout)
    if (!match) return null
    const progId = match[1].trim()
    if (/^MSEdge/i.test(progId) || /MicrosoftEdge/i.test(progId)) return 'edge'
    if (/^Chrome/i.test(progId)) return 'chrome'
    if (/^Brave/i.test(progId)) return 'brave'
    if (/^Vivaldi/i.test(progId)) return 'vivaldi'
    if (/^Opera/i.test(progId)) return 'opera'
    if (/^Chromium/i.test(progId)) return 'chromium'
    if (/^Firefox/i.test(progId)) return 'firefox'
    return null
  } catch {
    return null
  }
}

/** 从 `reg query "HKCR\<ProgId>\shell\open\command"` 的输出里抠出 exe 路径。 */
function exeFromRegOutput(stdout) {
  const text = String(stdout ?? '')
  const quoted = /REG_(?:EXPAND_)?SZ\s+"([^"]+\.exe)"/i.exec(text)
  if (quoted) return quoted[1]
  const bare = /REG_(?:EXPAND_)?SZ\s+(\S+\.exe)/i.exec(text)
  return bare ? bare[1] : null
}

/**
 * 跑一次 reg 查询。`reg` 不在 PATH 或被拦时，用 System32 下的绝对路径再试一次。
 * @returns {Promise<string|null>} stdout，失败返回 null
 */
async function runReg(runner, args) {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows'
  const attempts = [['reg', args], [join(systemRoot, 'System32', 'reg.exe'), args]]
  for (const [command, argv] of attempts) {
    try {
      const { stdout } = await runner(command, argv)
      if (stdout) return stdout
    } catch {
      /* 试下一个 */
    }
  }
  return null
}

const USER_CHOICE_ARGS = [
  'query',
  'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice',
  '/v',
  'ProgId'
]

/**
 * 识别系统默认浏览器，并解析出**真实 exe 路径**（不靠猜安装目录）。
 * 每台机器都可能不一样，所以这一步必须真的去问系统。
 * @returns {Promise<{ id: string|null, name: string, path: string|null, progId: string|null,
 *   chromium: boolean }>}
 */
export async function detectDefaultBrowser(options = {}) {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? execFileAsync
  const none = { id: null, name: '', path: null, progId: null, chromium: false }

  if (platform === 'win32') {
    const userChoice = await runReg(runner, USER_CHOICE_ARGS)
    if (!userChoice) return none
    const progId = /ProgId\s+REG_SZ\s+(\S+)/i.exec(userChoice)?.[1]?.trim() ?? null
    if (!progId) return none
    let path = null
    try {
      const command = await runReg(runner, ['query', `HKCR\\${progId}\\shell\\open\\command`, '/ve'])
      path = command ? exeFromRegOutput(command) : null
    } catch {
      path = null
    }
    const id = path ? idFromExe(path) : (await defaultBrowserId('win32', runner))
    return {
      id,
      name: BROWSER_NAMES[id] ?? '',
      path,
      progId,
      chromium: id ? CHROMIUM_IDS.has(id) : false
    }
  }

  if (platform === 'darwin') {
    try {
      const { stdout } = await runner('defaults', [
        'read',
        'com.apple.LaunchServices/com.apple.launchservices.secure',
        'LSHandlers'
      ])
      const blocks = String(stdout).split(/\}\s*,\s*\{|\}\s*\n\s*\{/)
      for (const block of blocks) {
        if (!/LSHandlerURLScheme\s*=\s*"?https"?/i.test(block)) continue
        const bundle = /LSHandlerRoleAll\s*=\s*"?([\w.-]+)"?/i.exec(block)?.[1]
        if (!bundle) continue
        const lower = bundle.toLowerCase()
        const id = lower.includes('edge')
          ? 'edge'
          : lower.includes('brave')
            ? 'brave'
            : lower.includes('vivaldi')
              ? 'vivaldi'
              : lower.includes('chromium')
                ? 'chromium'
                : lower.includes('firefox')
                  ? 'firefox'
                  : lower.includes('safari')
                    ? 'safari'
                    : lower.includes('google')
                      ? 'chrome'
                      : null
        return { id, name: BROWSER_NAMES[id] ?? bundle, path: null, progId: bundle, chromium: id ? CHROMIUM_IDS.has(id) : false }
      }
    } catch {
      /* 读不到就退回候选扫描 */
    }
    return none
  }

  // linux 等：xdg-settings
  try {
    const { stdout } = await runner('xdg-settings', ['get', 'default-web-browser'])
    const desktop = String(stdout).trim().toLowerCase()
    const id = desktop.includes('edge')
      ? 'edge'
      : desktop.includes('brave')
        ? 'brave'
        : desktop.includes('vivaldi')
          ? 'vivaldi'
          : desktop.includes('chromium')
            ? 'chromium'
            : desktop.includes('firefox')
              ? 'firefox'
              : desktop.includes('chrome')
                ? 'chrome'
                : null
    return { id, name: BROWSER_NAMES[id] ?? desktop, path: null, progId: desktop || null, chromium: id ? CHROMIUM_IDS.has(id) : false }
  } catch {
    return none
  }
}

/**
 * 选浏览器：优先系统默认浏览器（并解析真实路径）；默认浏览器不是 Chromium 系
 * 或没装时，退到第一个可用的 Chromium。
 * @returns {Promise<{ browser: object|null, isDefault: boolean, defaultId: string|null,
 *   detected: object, fallbackFrom?: string, reason?: string }>}
 */
export async function resolveBrowser(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const detected =
    options.detected !== undefined
      ? options.detected
      : options.defaultId !== undefined
        ? options.defaultId
          ? {
              id: options.defaultId,
              name: BROWSER_NAMES[options.defaultId] ?? '',
              path: null,
              progId: null,
              chromium: CHROMIUM_IDS.has(options.defaultId)
            }
          : null
        : await (options.detectFn ?? detectDefaultBrowser)({ platform, runner: options.runner })

  const seen = new Set()
  const available = []
  const candidates = browserCandidates(platform, env)
  // 注册表里拿到的真实路径优先级最高（支持自定义安装目录）
  if (detected?.path && detected?.id) {
    candidates.unshift({ id: detected.id, name: detected.name || BROWSER_NAMES[detected.id] || detected.id, path: detected.path })
  }
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue
    if (await executable(candidate.path)) {
      seen.add(candidate.id)
      available.push(candidate)
    }
  }

  const defaultId = detected?.id ?? null
  const isChromiumDefault = defaultId ? CHROMIUM_IDS.has(defaultId) : false
  if (defaultId && isChromiumDefault) {
    const hit = available.find((c) => c.id === defaultId)
    if (hit) return { browser: hit, isDefault: true, defaultId, detected }
  }
  const chromiumFallback = available.find((c) => CHROMIUM_IDS.has(c.id)) ?? available[0] ?? null
  if (!chromiumFallback) {
    return { browser: null, isDefault: false, defaultId, detected, reason: 'no-browser' }
  }
  return {
    browser: chromiumFallback,
    isDefault: false,
    defaultId,
    detected,
    fallbackFrom: defaultId ?? undefined,
    reason: defaultId ? (isChromiumDefault ? 'not-installed' : 'not-chromium') : 'no-default'
  }
}

/** 找到第一个真实存在的浏览器（保留旧接口）。 */
export async function findBrowser(platform = process.platform, env = process.env) {
  const resolved = await resolveBrowser({ platform, env, detected: null })
  return resolved.browser
}

/** 专用 profile 目录（登录状态保存在这里，下次免登录）。 */
export function captureProfileDir(dshHome, browserId = 'default') {
  return join(dshHome, 'greasyfork', 'browser-profile-' + browserId)
}

/** 等 CDP HTTP 端点可用（仅端口模式用）。 */
export async function waitForEndpoint(port, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) })
      if (res.ok) return await res.json()
    } catch (error) {
      lastError = error
    }
    await sleep(250)
  }
  throw new CdpError(`浏览器调试端口 ${port} 没起来${lastError ? `（${lastError.message}）` : ''}`, { stage: 'handshake' })
}

/** 列出页面目标（仅端口模式用）。 */
export async function listTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
  if (!res.ok) throw new CdpError(`读取目标列表失败：HTTP ${res.status}`, { stage: 'target' })
  return res.json()
}

/**
 * 读浏览器里某个域名的全部 cookie（含 HttpOnly）——端口 + WebSocket 通道。
 * 保留给自测脚本与旧调用方；插件主流程走 BrowserManager。
 */
export async function readCookies(port, domain) {
  const targets = await listTargets(port)
  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (pages.length === 0) throw new CdpError('浏览器里还没有页面目标', { stage: 'target' })
  const preferred = pages.find((t) => (t.url || '').includes(domain)) ?? pages[0]
  const transport = createWebSocketTransport(preferred.webSocketDebuggerUrl)
  const client = createCdpClient(transport, { defaultTimeoutMs: 6000 })
  try {
    let cookies = null
    try {
      await client.send('Network.enable', {})
      const all = await client.send('Network.getAllCookies', {})
      cookies = all.cookies
    } catch {
      const stored = await client.send('Storage.getCookies', {})
      cookies = stored.cookies
    }
    return (cookies ?? []).filter((c) => String(c.domain || '').includes(domain))
  } finally {
    client.close()
  }
}

/**
 * 把浏览器内请求包装成 `fetch` 兼容的函数，供 GreasyForkClient 使用。
 * 作用：Cloudflare 只认浏览器的 TLS 指纹，Node 的 fetch 会被挑战；
 * 换成这条路之后，登录校验、抓 CSRF、发布表单都能借浏览器完成。
 */
export function createBrowserFetch(manager) {
  return async function browserFetchImpl(input, init = {}) {
    const url = typeof input === 'string' ? input : input?.url
    const result = await manager.browserFetch(url, init)
    const headers = new Headers()
    for (const [key, value] of Object.entries(result.headers ?? {})) {
      try {
        headers.set(key, value)
      } catch {
        /* 某些头不允许设置 */
      }
    }
    const status = Number(result.status) >= 200 && Number(result.status) <= 599 ? Number(result.status) : 599
    const response = new Response(result.text ?? '', { status, headers })
    try {
      Object.defineProperty(response, 'url', { value: result.url ?? String(url), configurable: true })
    } catch {
      /* 忽略 */
    }
    return response
  }
}

/** 把 CDP cookie 列表拼成 Cookie 请求头。 */
export function cookiesToHeader(cookies) {
  return dedupeCookies(cookies)
    .filter((c) => c && c.name && c.value !== undefined)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ')
}

/**
 * 同名 cookie 只留一条。
 *
 * 为什么需要：`Storage.getCookies` 会同时返回 `greasyfork.org` 与 `.greasyfork.org`
 * 两个域下的同名 cookie（匿名会话与登录会话可能各有一条）。直接 map().join()
 * 拼出来的头里同名项会互相覆盖，旧值可能把新值盖掉。
 * 规则：域名更长（更具体）的优先，其次过期时间更晚的优先。
 */
export function dedupeCookies(cookies) {
  const best = new Map()
  for (const cookie of cookies ?? []) {
    if (!cookie || !cookie.name) continue
    const prev = best.get(cookie.name)
    if (!prev) {
      best.set(cookie.name, cookie)
      continue
    }
    const a = [String(cookie.domain || '').length, Number(cookie.expires ?? 0)]
    const b = [String(prev.domain || '').length, Number(prev.expires ?? 0)]
    if (a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1])) best.set(cookie.name, cookie)
  }
  return [...best.values()]
}

/** 去重后挑出登录会话 cookie。 */
export function pickSessionCookie(cookies) {
  return dedupeCookies(cookies).find((c) => c.name === '_greasyfork_session') ?? null
}

/**
 * 从标签页列表里挑一个目标。
 * - `requireSite`：只认本站页面（`Runtime.evaluate` 里的 fetch 受同源限制，
 *   在 github.com 的标签页上跑 `fetch('/en/users/edit')` 会打到 github）。
 * - 优先用我们上次开的那个标签页（tabId），其次本站页面，最后任意页面。
 */
function pickTarget(targetInfos, tabId, site, requireSite) {
  const pages = (targetInfos ?? []).filter((t) => t.type === 'page')
  if (pages.length === 0) return null
  const isSite = (t) => String(t.url || '').startsWith(site)
  const byTab = tabId ? pages.find((t) => t.targetId === tabId) : null
  if (requireSite) {
    if (byTab && isSite(byTab)) return byTab
    return pages.find(isSite) ?? null
  }
  return byTab ?? pages.find(isSite) ?? pages[0] ?? null
}

/** 关掉采集用的浏览器实例（端口模式；对不存在的端口安静返回）。 */
export async function closeBrowser(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return
    const info = await res.json()
    const transport = createWebSocketTransport(info.webSocketDebuggerUrl, { timeoutMs: 4000 })
    const client = createCdpClient(transport, { defaultTimeoutMs: 3000 })
    await client.send('Browser.close', {}, { timeoutMs: 3000 })
    client.close()
  } catch {
    /* 已经关了 */
  }
}

/**
 * 单实例浏览器管理器：进程 + CDP 连接常驻，采集时只在里面新开标签页。
 */
export function createBrowserManager(options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const spawnFn = options.spawnFn ?? spawn
  const resolveFn = options.resolveFn ?? resolveBrowser
  const site = String(options.site ?? 'https://greasyfork.org').replace(/\/+$/, '')
  const dshHome = options.dshHome ?? join(homedir(), '.dsh')
  const port = options.port ?? 9339
  const logger = options.logger
  const loginUrl = `${site}${LOGIN_PATH}`
  const seed = options.seed ?? null
  /** 回写钩子：把浏览器里最新的 Cookie 交回给调用方落盘（关闭 / 空闲回收前调用）。 */
  const persist = typeof options.persist === 'function' ? options.persist : null
  const entries = []
  let session = null
  let lastError = null

  function note(text, extra = {}) {
    const entry = { at: Date.now(), text, ...extra }
    entries.push(entry)
    if (entries.length > 60) entries.shift()
    try {
      logger?.debug?.(`greasyfork: ${text}`)
    } catch {
      /* 忽略 */
    }
    return entry
  }

  /** 最近 20 条诊断日志。 */
  function log() {
    return entries.slice(-20)
  }

  function baseArgs(profile) {
    return [
      `--user-data-dir=${profile}`,
      // 首次运行/隐私同意弹窗一律压掉，否则新 profile 会弹"Microsoft 重视您的隐私"
      '--no-first-run',
      '--no-default-browser-check',
      '--no-service-autorun',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-client-side-phishing-detection',
      '--password-store=basic',
      '--use-mock-keychain',
      // 少一点自动化特征：Cloudflare 的 Turnstile 对 CDP 控制的浏览器更敏感，
      // 去掉 Blink 的 AutomationControlled 标记能明显提高一次通过的几率
      '--disable-blink-features=AutomationControlled',
      '--disable-features=msEdgeFirstRunExperience,msImplicitSignin,msEdgeSidebarV2,msEdgeStartupBoost,Translate,EdgeCollections',
      '--remote-allow-origins=*',
      '--window-size=1100,860'
    ]
  }

  function stateFile() {
    return join(dshHome, 'greasyfork', 'browser-state.json')
  }

  async function writeState(extra) {
    try {
      await mkdir(join(dshHome, 'greasyfork'), { recursive: true })
      await writeFile(stateFile(), JSON.stringify({ pid: extra.child?.pid ?? null, ...extra, at: Date.now() }), 'utf8')
    } catch {
      /* 状态文件只是锦上添花 */
    }
  }

  async function clearState() {
    try {
      await rm(stateFile(), { force: true })
    } catch {
      /* 忽略 */
    }
  }

  async function readState() {
    try {
      return JSON.parse(await readFile(stateFile(), 'utf8'))
    } catch {
      return null
    }
  }

  function pidAlive(pid) {
    if (!pid) return false
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  /**
   * 找出用我们 profile 启动的浏览器进程（不含子进程）。
   * 状态文件丢了也能兜住——插件重载/宿主重启后最常见的就是这种孤儿。
   */
  async function findOrphanPids(profile) {
    const pids = new Set()
    const state = await readState()
    if (state?.pid && pidAlive(state.pid)) pids.add(state.pid)
    if (platform !== 'win32') return [...pids]
    const escaped = String(profile).replace(/'/g, "''")
    const script =
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and ` +
      `$_.CommandLine.Contains('${escaped}') -and $_.CommandLine -notmatch '--type=' } | ` +
      `ForEach-Object { $_.ProcessId }`
    try {
      const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
        timeout: 8000,
        windowsHide: true
      })
      for (const line of String(stdout).split(/\s+/)) {
        const pid = Number.parseInt(line, 10)
        if (Number.isInteger(pid) && pid > 0) pids.add(pid)
      }
    } catch {
      /* 拿不到进程表就算了，状态文件已经覆盖大部分情况 */
    }
    return [...pids]
  }

  /** 上次的实例还占着 profile（宿主重启 / 插件重载后常见）→ 关掉它，好让新实例能启动。 */
  async function cleanupOrphan(profile) {
    const pids = await findOrphanPids(profile)
    if (pids.length === 0) {
      await clearState()
      return false
    }
    note(`上一次的浏览器实例还在（pid ${pids.join(', ')}），先关掉它`)
    for (const pid of pids) {
      try {
        if (platform === 'win32') {
          // /T 连子进程一起杀：只杀主进程时，GPU/网络子进程还会占着 profile
          await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 8000, windowsHide: true })
        } else {
          process.kill(pid, 'SIGTERM')
        }
      } catch (error) {
        note(`关掉旧实例 ${pid} 失败：${error?.message ?? error}`)
        try {
          process.kill(pid)
        } catch {
          /* 已经没了 */
        }
      }
    }
    for (let i = 0; i < 25; i += 1) {
      if (!pids.some((pid) => pidAlive(pid))) break
      await sleep(200)
    }
    await clearState()
    return true
  }

  async function launchPipe(browser, profile) {
    const transport = createPipeTransport({
      exePath: browser.path,
      args: ['--remote-debugging-pipe', ...baseArgs(profile), loginUrl],
      spawnFn
    })
    const client = createCdpClient(transport, { defaultTimeoutMs: 10000 })
    try {
      const version = await client.send('Browser.getVersion', {}, { timeoutMs: 25000 })
      await writeState({ mode: 'pipe', profile, browser: browser.name, child: transport.child })
      return { client, child: transport.child, mode: 'pipe', version }
    } catch (error) {
      client.close()
      throw error
    }
  }

  async function launchPort(browser, profile) {
    const child = spawnFn(browser.path, [`--remote-debugging-port=${port}`, ...baseArgs(profile), loginUrl], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    })
    child.on('error', () => {})
    try {
      child.unref()
    } catch {
      /* 忽略 */
    }
    const version = await waitForEndpoint(port, 12000)
    const transport = createWebSocketTransport(version.webSocketDebuggerUrl)
    const client = createCdpClient(transport, { defaultTimeoutMs: 10000 })
    await client.send('Browser.getVersion', {}, { timeoutMs: 10000 })
    await writeState({ mode: 'port', profile, browser: browser.name, child })
    return { client, child, mode: 'port', version }
  }

  // 空闲自动关闭：10 分钟没人用就收掉，避免任务栏堆窗口
  const IDLE_CLOSE_MS = options.idleCloseMs ?? 10 * 60 * 1000
  let idleTimer = null
  let lastUsedAt = Date.now()

  function touch() {
    lastUsedAt = Date.now()
    if (idleTimer) clearTimeout(idleTimer)
    if (!Number.isFinite(IDLE_CLOSE_MS) || IDLE_CLOSE_MS <= 0) return
    idleTimer = setTimeout(() => {
      if (!session) return
      if (Date.now() - lastUsedAt < IDLE_CLOSE_MS) return
      note(`空闲 ${Math.round(IDLE_CLOSE_MS / 60000)} 分钟，自动关闭登录窗口`)
      close().catch(() => {})
    }, IDLE_CLOSE_MS)
    try {
      idleTimer.unref?.()
    } catch {
      /* 忽略 */
    }
  }

  // 每个浏览器实例都要重新注入一次已保存的凭证。
  // 原实现用进程级布尔值 `seeded`，只在插件生命周期里注入一次；而 Rails 的
  // `_greasyfork_session` 没有 Max-Age，浏览器一关就丢，重启后的实例其实是未登录的，
  // 于是「刚登录就报会话失效」。改为按实例记录。
  let seededSession = null
  async function maybeSeed() {
    if (!seed || !session || seededSession === session) return
    seededSession = session
    try {
      const header = await seed()
      if (header) await restoreCookies(header)
    } catch (error) {
      note(`读取已保存凭证失败：${error?.message ?? error}`)
    }
  }

  /** 一次完整的启动尝试：管道 → 接管遗留端口实例 → 端口。 */
  async function tryLaunch(browser, profile, resolved) {
    let pipeError = null
    try {
      const launched = await launchPipe(browser, profile)
      session = {
        browser,
        isDefault: resolved.isDefault === true,
        profile,
        mode: launched.mode,
        client: launched.client,
        child: launched.child,
        startedAt: Date.now(),
        tabId: null,
        justLaunched: true,
        version: launched.version?.Browser ?? null
      }
      note(`管道通道已连接（${session.version ?? 'unknown'}）`)
      await maybeSeed()
      return session
    } catch (error) {
      pipeError = error
      note(`管道通道失败：${error?.message ?? error}，改用调试端口`)
    }

    // 宿主重启后可能还留着上一次的端口模式实例：能接上就别再开第二个
    try {
      const version = await waitForEndpoint(port, 1200)
      const transport = createWebSocketTransport(version.webSocketDebuggerUrl)
      const client = createCdpClient(transport, { defaultTimeoutMs: 10000 })
      await client.send('Browser.getVersion', {}, { timeoutMs: 8000 })
      session = {
        browser,
        isDefault: resolved.isDefault === true,
        profile,
        mode: 'port',
        client,
        child: null,
        startedAt: Date.now(),
        tabId: null,
        version: version.Browser ?? null
      }
      note(`接上了上次遗留的调试端口实例（${session.version ?? 'unknown'}）`)
      await maybeSeed()
      return session
    } catch {
      /* 没有遗留实例，正常启动 */
    }

    try {
      const launched = await launchPort(browser, profile)
      session = {
        browser,
        isDefault: resolved.isDefault === true,
        profile,
        mode: launched.mode,
        client: launched.client,
        child: launched.child,
        startedAt: Date.now(),
        tabId: null,
        justLaunched: true,
        version: launched.version?.Browser ?? null
      }
      note(`端口通道已连接（${session.version ?? 'unknown'}）`)
      await maybeSeed()
      return session
    } catch (error) {
      lastError = `管道：${pipeError?.message ?? pipeError}；端口：${error?.message ?? error}`
      note(`端口通道也失败：${error?.message ?? error}`)
      const wrapped = new CdpError(`浏览器连不上：${lastError}`, { stage: 'spawn' })
      wrapped.code = 'launch-failed'
      throw wrapped
    }
  }

  async function ensure() {
    if (session && !session.client.closed) return session
    session = null
    lastError = null
    const resolved = await resolveFn({ platform, env })
    if (!resolved?.browser) {
      const error = new CdpError('没找到可用的 Chrome / Edge / Chromium', { stage: 'spawn' })
      error.code = 'no-browser'
      lastError = error.message
      throw error
    }
    const browser = resolved.browser
    const profile = captureProfileDir(dshHome, browser.id)
    await mkdir(profile, { recursive: true })
    note(`启动 ${browser.name}${resolved.isDefault ? '（系统默认）' : '（默认浏览器不可用，改用这个）'}`, {
      browser: browser.name
    })

    try {
      return await tryLaunch(browser, profile, resolved)
    } catch (error) {
      // profile 被上一次的实例占着时，先把它关掉再试一次
      const cleaned = await cleanupOrphan(profile)
      if (!cleaned) {
        error.message += '。如果任务栏里还留着上次的登录窗口，先关掉它再试。'
        throw error
      }
      note('清掉旧实例后重试启动')
      try {
        return await tryLaunch(browser, profile, resolved)
      } catch (second) {
        second.message += '。如果任务栏里还留着上次的登录窗口，先关掉它再试。'
        throw second
      }
    }
  }

  /**
   * 用已保存的 Cookie 恢复登录态。
   * Rails 的 `_greasyfork_session` 是没有 Max-Age 的会话 cookie，浏览器进程一关就没了；
   * 每次启动后重新塞回去，才谈得上"登录一次长期有效"。
   */
  // 注入时给的远期有效期：Chromium 只把带 expires 的 cookie 写进磁盘，
  // 没有这一项就是 session cookie，浏览器进程一关就消失。
  const RESTORED_COOKIE_TTL_SECONDS = 180 * 24 * 60 * 60
  const cookieDomain = (() => {
    try {
      return '.' + new URL(site).hostname
    } catch {
      return '.greasyfork.org'
    }
  })()

  async function restoreCookies(header) {
    const pairs = String(header ?? '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
    const cookies = []
    const expires = Math.floor(Date.now() / 1000) + RESTORED_COOKIE_TTL_SECONDS
    for (const pair of pairs) {
      const index = pair.indexOf('=')
      if (index <= 0) continue
      const name = pair.slice(0, index)
      const value = pair.slice(index + 1)
      cookies.push({
        name,
        value,
        domain: cookieDomain,
        path: '/',
        secure: true,
        httpOnly: name === '_greasyfork_session',
        expires
      })
    }
    if (cookies.length === 0) return 0
    const current = await ensure()

    // 优先 Page 域的 Network.setCookie：部分 Edge 版本上 Browser 域的
    // Storage.setCookies 会让管道连接直接断开（注入完就再也问不到浏览器了）。
    let applied = 0
    try {
      applied = await withPageSession(async (client, sessionId) => {
        let count = 0
        for (const cookie of cookies) {
          try {
            await client.send(
              'Network.setCookie',
              {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain,
                path: '/',
                secure: true,
                httpOnly: cookie.httpOnly,
                expires: cookie.expires
              },
              { sessionId, timeoutMs: 4000 }
            )
            count += 1
          } catch {
            /* 单条失败不影响其他 cookie */
          }
        }
        return count
      })
    } catch (error) {
      note(`Network.setCookie 注入失败：${error?.message ?? error}，回退 Storage.setCookies`)
    }

    if (applied === 0) {
      try {
        await current.client.send('Storage.setCookies', { cookies }, { timeoutMs: 6000 })
        applied = cookies.length
      } catch (error) {
        note(`恢复登录态失败：${error?.message ?? error}`)
        return 0
      }
    }
    note(`已用保存的凭证恢复登录态（${applied} 条 cookie）`)
    return applied
  }

  /** 在"本站标签页"的 session 里跑一段 CDP 命令（拿不到标签页就先开一个）。 */
  async function withPageSession(fn) {
    const current = await ensure()
    let { targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 5000 })
    let target = pickTarget(targetInfos, current.tabId, site, false)
    if (!target) {
      await openTab()
      ;({ targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 5000 }))
      target = pickTarget(targetInfos, current.tabId, site, false)
    }
    if (!target) throw new CdpError('没有可用的标签页', { stage: 'target' })
    const { sessionId } = await current.client.send(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      { timeoutMs: 5000 }
    )
    try {
      return await fn(current.client, sessionId)
    } finally {
      try {
        await current.client.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 2000 })
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 把浏览器里**当前**的 Cookie 回写给调用方落盘。
   * 站点在登录/刷新时可能换掉 `_greasyfork_session`（例如 OAuth 回跳、二次验证），
   * 不回写就会一直拿着旧值去重连。
   */
  async function syncCookiesBack(reason = '关闭前') {
    if (!persist) return 0
    if (!session || session.client.closed) return 0
    try {
      const list = await cookies('greasyfork.org')
      const header = cookiesToHeader(list)
      if (!header || !/_greasyfork_session=/.test(header)) return 0
      await persist(header)
      note(`${reason}把浏览器里的 ${dedupeCookies(list).length} 条 cookie 回写到凭证文件`)
      return dedupeCookies(list).length
    } catch (error) {
      note(`回写 cookie 失败：${error?.message ?? error}`)
      return 0
    }
  }

  /**
   * 重新注入已保存的凭证并复检。
   * 发布时撞到「被跳转到登录页」就是靠它自愈：浏览器重启后 session 丢了，
   * 但凭证文件里的 cookie 仍然有效，塞回去就能继续。
   */
  async function relogin() {
    seededSession = null
    if (!session || session.client.closed) {
      try {
        await ensure()
      } catch (error) {
        return { ok: false, reason: 'no-browser', error: error?.message ?? String(error) }
      }
    }
    await maybeSeed()
    const check = await verifyLogin().catch((error) => ({ ok: false, error: error?.message ?? String(error) }))
    if (check?.ok === true) {
      await openTab()
      return { ok: true, check }
    }
    return { ok: false, check }
  }

  /** 等标签页真的落到本站（新开的标签页先是 about:blank，此时 fetch 的相对地址解析不了）。 */
  async function waitForSiteTab(current, timeoutMs = 12000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const { targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 4000 })
        const target = pickTarget(targetInfos, current.tabId, site, true)
        if (target) return target
      } catch {
        /* 下一轮 */
      }
      await sleep(300)
    }
    return null
  }

  async function openTab(url = loginUrl) {
    const current = await ensure()
    touch()
    // 启动时已经把登录页作为参数传进去了：认领那个标签页，别急着再开一个
    if (current.justLaunched) {
      current.justLaunched = false
      try {
        const { targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 4000 })
        const first = (targetInfos ?? []).find((t) => t.type === 'page')
        if (first) {
          current.tabId = first.targetId
          try {
            await current.client.send('Target.activateTarget', { targetId: first.targetId }, { timeoutMs: 3000 })
          } catch {
            /* 忽略 */
          }
          note(`认领启动时打开的标签页（${first.url || '加载中'}）`)
          return first.targetId
        }
      } catch {
        /* 拿不到就照旧新开 */
      }
    }
    // 已经有 greasyfork 标签页就直接切过去，别把标签页开成一排
    try {
      const { targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 4000 })
      const existing = (targetInfos ?? []).find((t) => t.type === 'page' && String(t.url || '').startsWith(site))
      if (existing) {
        current.tabId = existing.targetId
        try {
          await current.client.send('Target.activateTarget', { targetId: existing.targetId }, { timeoutMs: 3000 })
        } catch {
          /* 切不过去不影响读 cookie */
        }
        note('浏览器里已经有 greasyfork 标签页，直接切过去')
        return existing.targetId
      }
    } catch {
      /* 拿不到目标列表就老老实实新开一个 */
    }
    const { targetId } = await current.client.send('Target.createTarget', { url }, { timeoutMs: 10000 })
    current.tabId = targetId
    try {
      await current.client.send('Target.activateTarget', { targetId }, { timeoutMs: 3000 })
    } catch {
      /* 激活失败不影响读 cookie */
    }
    note(`已在浏览器里新开标签页：${url}`)
    return targetId
  }

  async function cookies(domain = 'greasyfork.org') {
    const current = await ensure()
    touch()
    let list = null
    try {
      const result = await current.client.send('Storage.getCookies', {}, { timeoutMs: 8000 })
      list = result.cookies
    } catch (error) {
      note(`Storage.getCookies 失败：${error?.message ?? error}，改在标签页会话里读`)
      list = await pageCookies(current)
    }
    return (list ?? []).filter((c) => String(c.domain || '').includes(domain))
  }

  /**
   * 降级读法：`Network.getAllCookies` 属于 Page 域，在 Browser 级连接上直接发会报错，
   * 必须先 attach 到具体标签页拿 sessionId 再发。
   */
  async function pageCookies(current) {
    let { targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 5000 })
    let target = pickTarget(targetInfos, current.tabId, site, false)
    if (!target) {
      await openTab()
      ;({ targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 5000 }))
      target = pickTarget(targetInfos, current.tabId, site, false)
    }
    if (!target) throw new CdpError('没有可用的标签页，读不到 cookie', { stage: 'target' })
    const { sessionId } = await current.client.send(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      { timeoutMs: 5000 }
    )
    try {
      const { cookies: list } = await current.client.send('Network.getAllCookies', {}, { sessionId, timeoutMs: 8000 })
      return list
    } finally {
      try {
        await current.client.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 2000 })
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 在页面里跑一段 JS（`awaitPromise` + `returnByValue`）。
   * 用途：拿"这个浏览器实例自己"的登录状态——Node 端请求被 Cloudflare 拦掉时，
   * 只有浏览器自己的 fetch 能给出真相。
   */
  async function evaluate(expression, { requireSite = false } = {}) {
    const current = await ensure()
    let { targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 5000 })
    let target = pickTarget(targetInfos, current.tabId, site, requireSite)
    if (requireSite) {
      // 目标可能已经存在但页面还在导航中（about:blank），此时相对 URL 解析不了
      const ready = await waitForSiteTab(current, 6000)
      if (ready) target = ready
    }
    if (!target && requireSite) {
      // OAuth 登录过程中标签页可能停在 github/google，也可能被用户关掉了：
      // 这里补开一个本站标签页再问，而不是直接判"没有标签页"。
      note('浏览器里没有 greasyfork 标签页，补开一个')
      await openTab()
      target = await waitForSiteTab(current)
    }
    if (!target) return { error: '浏览器里没有可用的标签页' }
    const { sessionId } = await current.client.send(
      'Target.attachToTarget',
      { targetId: target.targetId, flatten: true },
      { timeoutMs: 5000 }
    )
    try {
      const result = await current.client.send(
        'Runtime.evaluate',
        { expression, awaitPromise: true, returnByValue: true },
        { sessionId, timeoutMs: 20000 }
      )
      if (result.exceptionDetails) {
        return { error: result.exceptionDetails.text ?? result.exceptionDetails.exception?.description ?? '页面里执行失败' }
      }
      return result.result?.value ?? null
    } finally {
      try {
        await current.client.send('Target.detachFromTarget', { sessionId }, { timeoutMs: 2000 })
      } catch {
        /* 忽略 */
      }
    }
  }

  /**
   * 用**浏览器自己**的会话问一次"我登录了吗"。
   * 返回 { ok, status, url, username } —— 不依赖 Node 的 TLS 指纹，Cloudflare 不会拦。
   */
  /**
   * 扫一遍标签页，认出"登录还没走完"的中间态。
   * 人机验证、第三方授权、OAuth 回跳都发生在 greasyfork 页面之外（或挑战页上），
   * 这时候在站内 fetch 只会拿到登录页，报"未登录"会让人以为凭证坏了。
   */
  async function detectLoginStage() {
    const current = await ensure()
    const { targetInfos } = await current.client.send('Target.getTargets', {}, { timeoutMs: 4000 })
    const urls = (targetInfos ?? []).filter((t) => t.type === 'page').map((t) => String(t.url || ''))
    const cf = urls.find((u) => /challenges\.cloudflare\.com/i.test(u))
    if (cf) return { kind: 'challenge', url: cf }
    const oauth = urls.find((u) => /^https:\/\/(?:github\.com\/login\/oauth|accounts\.google\.com)/i.test(u))
    if (oauth) return { kind: 'oauth', url: oauth }
    const callback = urls.find((u) => /\/auth\/[a-z0-9_-]+\/callback/i.test(u))
    if (callback) return { kind: 'oauth-callback', url: callback }
    return null
  }

  async function verifyLogin() {
    touch()
    const stage = await detectLoginStage().catch(() => null)
    if (stage) {
      const label =
        {
          challenge: 'Cloudflare 人机验证进行中（请在弹出的窗口里完成验证）',
          oauth: '正在第三方授权页，请点 Authorize 完成授权',
          'oauth-callback': 'OAuth 回跳处理中，稍等一下'
        }[stage.kind] ?? stage.kind
      note(`浏览器内校验：${label}`)
      if (stage.kind === 'challenge') {
        try {
          await openTab()
        } catch {
          /* 激活失败不影响判断 */
        }
      }
      return {
        ok: false,
        challenge: stage.kind === 'challenge',
        stage: stage.kind,
        label,
        url: stage.url,
        signIn: false
      }
    }
    const script = [
      '(async () => {',
      '  try {',
      "    const href = String(location.href || '')",
      "    const title = String(document.title || '')",
      '    const cf = /Just a moment|Attention Required|Verifying you are human|Checking your browser|请稍候/i.test(title)',
      "      || !!document.querySelector('#challenge-form, #cf-challenge-running, #challenge-stage, #turnstile-wrapper, iframe[src*=\"challenges.cloudflare.com\"]')",
      '    if (cf) return { challenge: true, title: title, url: href }',
      "    if (href.indexOf('greasyfork.org') === -1) return { error: 'not-on-site:' + href }",
      "    const res = await fetch('/en/users/edit', { credentials: 'include', redirect: 'follow' })",
      '    const text = await res.text()',
      "    const url = String(res.url || '')",
      "    const redirected = url.indexOf('/users/sign_in') !== -1",
      '    const loginForm = /name="user\\[password\\]"/i.test(text) && /name="user\\[email\\]"/i.test(text)',
      '    const name = /name="user\\[name\\]"[^>]*value="([^"]*)"/i.exec(text)',
      '    return { status: res.status, url, signIn: redirected || loginForm, username: name ? name[1] : null }',
      '  } catch (e) {',
      '    return { error: String((e && e.message) || e) }',
      '  }',
      '})()'
    ].join('\n')
    let raw = null
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        raw = await evaluate(script, { requireSite: true })
      } catch (error) {
        raw = { error: error?.message ?? String(error) }
      }
      // 新标签页可能还没落到本站（about:blank），稍等一下再问
      if (!raw || !raw.error || String(raw.error).indexOf('not-on-site') === -1) break
      await sleep(400)
    }
    if (raw && raw.challenge) {
      // 人机验证没过 ≠ 未登录：别把它当凭证失效报出去。
      // 顺手激活一下标签页，把窗口提到前台，用户才看得到那个验证框。
      try {
        await openTab()
      } catch {
        /* 激活失败不影响判断 */
      }
      note('浏览器内校验：Cloudflare 人机验证未通过（请在窗口里手动完成验证）')
      return {
        ok: false,
        challenge: true,
        status: null,
        url: raw.url ?? null,
        title: raw.title ?? null,
        signIn: false
      }
    }
    if (!raw || raw.error) {
      note(`浏览器内校验失败：${raw?.error ?? '无返回'}`)
      return { ok: false, error: raw?.error ?? '无返回' }
    }
    const ok = raw.status === 200 && raw.signIn !== true
    note(
      `浏览器内校验：${ok ? '已登录' : '未登录'}（HTTP ${raw.status}${raw.signIn ? '，跳到了登录页' : ''}${raw.username ? `，账号 ${raw.username}` : ''}）`
    )
    return { ok, status: raw.status, url: raw.url, username: raw.username ?? null, signIn: raw.signIn === true }
  }

  /**
   * 用浏览器发一个 HTTP 请求（同源，自动带 cookie，真浏览器 TLS 指纹）。
   * Cloudflare 只拦 Node 的指纹，拦不住这个。
   * @returns {Promise<{status:number, url:string, headers:Record<string,string>, text:string}>}
   */
  async function browserFetch(url, init = {}) {
    const target = new URL(url, site).href
    const method = String(init.method ?? 'GET').toUpperCase()
    const headers = init.headers ?? {}
    let body = init.body
    if (body && typeof body !== 'string') body = String(body)
    const script = `(async () => {
  try {
    const res = await fetch(${JSON.stringify(target)}, {
      method: ${JSON.stringify(method)},
      headers: ${JSON.stringify(headers)},
      body: ${body === undefined || body === null ? 'undefined' : JSON.stringify(body)},
      credentials: 'include',
      redirect: 'follow'
    })
    const text = await res.text()
    const out = {}
    res.headers.forEach((v, k) => { out[k] = v })
    return { status: res.status, url: res.url, headers: out, text }
  } catch (e) {
    return { error: String((e && e.message) || e) }
  }
})()`
    // 页面可能还在导航中（此时 fetch 会抛 Failed to fetch），重试几次
    let raw = null
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        raw = await evaluate(script, { requireSite: true })
      } catch (error) {
        raw = { error: error?.message ?? String(error) }
      }
      if (raw && !raw.error) break
      await sleep(400)
    }
    if (!raw || raw.error) {
      throw new CdpError(`浏览器内请求失败：${raw?.error ?? '无返回'}`, { stage: 'evaluate' })
    }
    return raw
  }

  /** 一次性诊断包：实例状态、cookie 概况、浏览器内登录判断、最近日志。 */
  async function diagnose() {
    const out = { at: Date.now(), instance: null, cookies: null, browserCheck: null, log: [] }
    try {
      const list = await cookies('greasyfork.org')
      const session = pickSessionCookie(list)
      out.cookies = {
        count: list.length,
        names: dedupeCookies(list).map((c) => c.name),
        domains: [...new Set(list.map((c) => String(c.domain || '')))],
        sessionLength: session ? String(session.value || '').length : 0
      }
    } catch (error) {
      out.cookies = { error: error?.message ?? String(error) }
    }
    try {
      out.browserCheck = await verifyLogin()
    } catch (error) {
      out.browserCheck = { error: error?.message ?? String(error) }
    }
    // 实例快照放在 ensure 之后，否则第一次自检永远显示"未启动"
    out.instance = status()
    out.log = log()
    return out
  }

  async function close() {
    if (!session || session.client.closed) {
      session = null
      return false
    }
    // 关之前先把最新 cookie 落盘：下一次启动靠它免登录
    await syncCookiesBack('关闭前').catch(() => {})
    const current = session
    session = null
    try {
      await current.client.send('Browser.close', {}, { timeoutMs: 2500 })
    } catch {
      /* 忽略 */
    }
    try {
      current.client.close()
    } catch {
      /* 忽略 */
    }
    try {
      current.child?.kill?.()
    } catch {
      /* 忽略 */
    }
    await clearState()
    note('已关闭登录窗口')
    return true
  }

  function status() {
    const alive = Boolean(session && !session.client.closed)
    return {
      alive,
      mode: session?.mode ?? null,
      browser: session?.browser?.name ?? null,
      isDefault: session?.isDefault === true,
      profile: session?.profile ?? null,
      startedAt: session?.startedAt ?? null,
      tabId: session?.tabId ?? null,
      version: session?.version ?? null,
      loginUrl,
      error: lastError
    }
  }

  return {
    ensure,
    openTab,
    cookies,
    evaluate,
    verifyLogin,
    browserFetch,
    diagnose,
    restoreCookies,
    syncCookiesBack,
    relogin,
    dispose: close,
    note,
    close,
    status,
    log,
    get session() {
      return session
    }
  }
}

/**
 * 一次完整的采集：确保浏览器在（必要时启动）→ 新开登录标签页 → 轮询 cookie
 * → 命中并校验通过后保存。**默认不关浏览器**，登录态留给下次。
 *
 * @param {{
 *   dshHome: string, site: string, domain?: string, port?: number,
 *   timeoutMs?: number, intervalMs?: number, manager?: object,
 *   keepAlive?: boolean, verify?: Function|null, onPhase?: Function,
 *   now?: () => number, shouldStop?: () => boolean,
 *   resolveBrowserFn?: Function, launchFn?: Function, waitFn?: Function,
 *   readFn?: Function, closeFn?: Function
 * }} options
 */
export async function captureCookieViaBrowser(options = {}) {
  const {
    dshHome = join(homedir(), '.dsh'),
    site = 'https://greasyfork.org',
    domain = 'greasyfork.org',
    port = 9339,
    timeoutMs = 5 * 60 * 1000,
    intervalMs = 1500,
    verify = null,
    onPhase = () => {},
    shouldStop = () => false,
    now = Date.now,
    keepAlive = true,
    resolveBrowserFn = resolveBrowser,
    launchFn = null,
    waitFn = null,
    readFn = null,
    closeFn = null
  } = options

  const startedAt = now()
  const loginUrl = `${site.replace(/\/+$/, '')}${LOGIN_PATH}`
  const injected = Boolean(launchFn || readFn)
  const manager =
    options.manager ?? (injected ? null : createBrowserManager({ dshHome, site, port, resolveFn: resolveBrowserFn }))
  // 浏览器内校验（Node 端被 Cloudflare 拦时的真相来源），每 5 秒最多问一次
  const BROWSER_CHECK_INTERVAL_MS = 5000
  const browserCheck =
    options.verifyInBrowser ??
    (manager && typeof manager.verifyLogin === 'function' ? () => manager.verifyLogin() : null)
  let lastBrowserCheckAt = 0
  let lastBrowserCheck = null
  let lastReadError = null
  let lastLoggedReadError = null
  const logNote = typeof manager?.note === 'function' ? (text) => manager.note(text) : () => {}

  let browserName = null
  let isDefault = false
  let profile = null
  let read
  let closeSession = async () => {}

  if (injected) {
    const resolved = await resolveBrowserFn()
    const browser = options.browser ?? resolved?.browser
    if (!browser) {
      return {
        ok: false,
        reason: 'no-browser',
        message: '没找到可用的 Chrome / Edge / Chromium。请安装其中之一，或改用手动填入。',
        elapsedMs: 0
      }
    }
    browserName = browser.name
    isDefault = resolved?.isDefault === true
    profile = captureProfileDir(dshHome, browser.id)
    onPhase({ phase: 'launching', browser: browserName, isDefault, profile })
    try {
      if (launchFn) await launchFn({ browser, profileDir: profile, port, url: loginUrl })
      if (waitFn) await waitFn(port, 25000)
    } catch (error) {
      return {
        ok: false,
        reason: 'launch-failed',
        browser: browserName,
        profile,
        message: `启动 ${browserName} 失败：${error?.message ?? error}`,
        elapsedMs: now() - startedAt
      }
    }
    read = readFn ?? ((p, d) => readCookies(p, d))
    closeSession = async () => {
      if (closeFn) await closeFn(port).catch(() => {})
    }
  } else {
    try {
      const current = await manager.ensure()
      browserName = current.browser.name
      isDefault = current.isDefault === true
      profile = current.profile
      onPhase({ phase: 'opened', browser: browserName, isDefault, profile, mode: current.mode })
      await manager.openTab(loginUrl)
      onPhase({ phase: 'waiting', browser: browserName, isDefault, profile, mode: current.mode })
    } catch (error) {
      return {
        ok: false,
        reason: error?.code === 'no-browser' ? 'no-browser' : 'launch-failed',
        message: error?.message ?? String(error),
        elapsedMs: now() - startedAt,
        log: manager.log()
      }
    }
    read = (_p, d) => manager.cookies(d)
    closeSession = async () => {
      if (!keepAlive) await manager.close()
    }
  }

  // GreasyFork 对**未登录访客**也会下发 _greasyfork_session，
  // 所以"读到 session"不等于"已登录"：每一轮都要真的校验一次。
  let sawAnonymous = false
  let lastVerifyError = null

  try {
    while (now() - startedAt < timeoutMs) {
      if (shouldStop()) {
        return {
          ok: false,
          reason: 'cancelled',
          browser: browserName,
          profile,
          message: '已取消',
          elapsedMs: now() - startedAt,
          log: manager?.log?.() ?? []
        }
      }
      let cookies = []
      try {
        cookies = await read(port, domain)
        lastReadError = null
      } catch (error) {
        lastReadError = error?.message ?? String(error)
        // 同类错误只记一次，别让 1.5 秒一轮把日志刷爆
        if (lastReadError !== lastLoggedReadError) {
          lastLoggedReadError = lastReadError
          logNote(`读 cookie 失败：${lastReadError}（会继续重试）`)
        }
      }
      const session = pickSessionCookie(cookies)
      if (session && session.value) {
        const cookie = cookiesToHeader(cookies)
        if (!verify) {
          return {
            ok: true,
            cookie,
            browser: browserName,
            isDefault,
            profile,
            verified: false,
            elapsedMs: now() - startedAt,
            log: manager?.log?.() ?? []
          }
        }
        onPhase({ phase: sawAnonymous ? 'verifying' : 'checking', browser: browserName, isDefault, profile })
        let who = null
        try {
          who = await verify(cookie)
        } catch (error) {
          lastVerifyError = error?.message ?? String(error)
        }
        if (who && who.authenticated === true) {
          onPhase({ phase: 'done', browser: browserName, isDefault, profile })
          return {
            ok: true,
            cookie,
            username: who.username ?? null,
            userId: who.userId ?? null,
            browser: browserName,
            isDefault,
            profile,
            verified: true,
            verifiedBy: 'node',
            elapsedMs: now() - startedAt,
            log: manager?.log?.() ?? []
          }
        }
        // Node 端校验没过（可能是没登录，也可能是 Cloudflare 把 Node 的请求拦了）。
        // 问浏览器自己：它带着同一套 cookie，而且 TLS 指纹是真浏览器的。
        if (browserCheck && now() - lastBrowserCheckAt >= BROWSER_CHECK_INTERVAL_MS) {
          lastBrowserCheckAt = now()
          let check = null
          try {
            check = await browserCheck()
          } catch (error) {
            check = { ok: false, error: error?.message ?? String(error) }
          }
          lastBrowserCheck = check
          if (check && check.ok === true) {
            onPhase({ phase: 'done', browser: browserName, isDefault, profile })
            return {
              ok: true,
              cookie,
              username: who?.username ?? check.username ?? null,
              userId: null,
              browser: browserName,
              isDefault,
              profile,
              verified: true,
              verifiedBy: 'browser',
              nodeError: lastVerifyError,
              elapsedMs: now() - startedAt,
              log: manager?.log?.() ?? []
            }
          }
          if (check && check.challenge === true) {
            onPhase({ phase: 'challenge', browser: browserName, isDefault, profile, url: check.url ?? null })
          }
          if (check && (check.stage === 'oauth' || check.stage === 'oauth-callback')) {
            onPhase({ phase: 'oauth', browser: browserName, isDefault, profile, url: check.url ?? null })
          }
        }
        if (!sawAnonymous) {
          sawAnonymous = true
          if (lastBrowserCheck?.challenge === true) {
            onPhase({ phase: 'challenge', browser: browserName, isDefault, profile, url: lastBrowserCheck.url ?? null })
          } else {
            onPhase({ phase: 'waiting-login', browser: browserName, isDefault, profile })
          }
        }
      }
      await sleep(intervalMs)
    }
    return {
      ok: false,
      reason: 'timeout',
      browser: browserName,
      profile,
      sawAnonymous,
      browserCheck: lastBrowserCheck,
      message: sawAnonymous
        ? `检测到 GreasyFork 的会话，但 ${Math.round(timeoutMs / 1000)} 秒内没有确认登录。` +
          (lastBrowserCheck
            ? lastBrowserCheck.ok === true
              ? '浏览器里显示已登录，但 Node 端校验没通过。'
              : lastBrowserCheck.challenge === true
                ? '登录窗口卡在 Cloudflare 人机验证：需要在弹出的窗口里手动点一下验证框（脚本不会替你点），验证通过后会自动继续。'
                : `浏览器里也没有登录（HTTP ${lastBrowserCheck.status ?? '?'}${lastBrowserCheck.signIn ? '，被重定向到登录页' : ''}）——请确认你是在**插件打开的那个窗口**里登录的。`
            : '') +
          (lastVerifyError ? `（Node 校验错误：${lastVerifyError}）` : '')
        : `等了 ${Math.round(timeoutMs / 1000)} 秒，浏览器里没有出现 greasyfork.org 的会话。请确认窗口里的标签页没有被关掉。` +
          (lastReadError ? `（读 cookie 一直失败：${lastReadError}）` : ''),
      elapsedMs: now() - startedAt,
      log: manager?.log?.() ?? []
    }
  } finally {
    await closeSession().catch(() => {})
  }
}
