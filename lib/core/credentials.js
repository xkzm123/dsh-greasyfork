/**
 * 凭证存取。
 *
 * 设计取舍：不把 Cookie 塞进 cordis 配置（配置会被 dump、会被 UI 展示、会进日志），
 * 也不依赖 harness 的 credential 服务（插件要在 CLI、web profile、desktop profile
 * 三种环境下都能用）。因此：
 *
 *   读取优先级（高 → 低）
 *     1. 单次调用参数 cookie（临时，不落盘，只给"就这一次"的场景）
 *     2. 环境变量 GREASYFORK_COOKIE（适合 CI / 不想落盘）
 *     3. harness 凭证服务里的记录 greasyfork/cookie（如果用户更喜欢产品自带的存储）
 *     4. harness 凭证服务里的键 GREASYFORK_COOKIE
 *     5. 本插件私有文件 $DSH_HOME/greasyfork/credentials.json（0600，默认写这里）
 *
 * 写入默认只写第 5 项：一个文件、权限 0600、路径可预测、CLI 与插件共用。
 * 任何返回值都不包含 Cookie 原文，只有来源与 cookie 名列表。
 */

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { GreasyForkError } from './errors.js'

export const CREDENTIAL_ENV = 'GREASYFORK_COOKIE'
export const CREDENTIAL_RECORD_KEY = 'greasyfork/cookie'
export const CREDENTIAL_FILE_RELATIVE = join('greasyfork', 'credentials.json')

/** harness home：DSH_HOME 或 ~/.dsh。 */
export function resolveDshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  if (fromEnv && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 私有凭证文件路径。 */
export function credentialFilePath(env = process.env) {
  return join(resolveDshHome(env), CREDENTIAL_FILE_RELATIVE)
}

/** 只显示 Cookie 的名字，永远不显示值。 */
export function redactCookie(cookie) {
  if (!cookie) return { present: false }
  const names = String(cookie)
    .split(';')
    .map((part) => part.split('=')[0].trim())
    .filter(Boolean)
  return {
    present: true,
    names,
    hasSession: names.includes('_greasyfork_session'),
    hasCfClearance: names.includes('cf_clearance')
  }
}

/** 读私有文件。文件不存在/损坏时返回 undefined（不抛）。 */
export async function readCredentialFile(env = process.env) {
  const file = credentialFilePath(env)
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed.cookie !== 'string' || parsed.cookie.trim() === '') return undefined
    return {
      cookie: parsed.cookie,
      username: typeof parsed.username === 'string' ? parsed.username : null,
      userId: Number.isInteger(parsed.userId) ? parsed.userId : null,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : null,
      site: typeof parsed.site === 'string' ? parsed.site : null,
      expiresAt: typeof parsed.expiresAt === 'string' ? parsed.expiresAt : null,
      daysLeft: Number.isFinite(parsed.daysLeft) ? parsed.daysLeft : null,
      sessionScoped: parsed.sessionScoped === true,
      format: typeof parsed.format === 'string' ? parsed.format : null,
      file
    }
  } catch {
    return undefined
  }
}

/**
 * 写私有文件（目录 0700、文件 0600）。
 * @param {{ cookie: string, username?: string|null, userId?: number|null, site?: string|null }} data
 */
export async function writeCredentialFile(data, env = process.env) {
  const file = credentialFilePath(env)
  const payload = {
    version: 2,
    cookie: String(data.cookie || '').trim(),
    username: data.username ?? null,
    userId: data.userId ?? null,
    site: data.site ?? null,
    savedAt: new Date().toISOString(),
    expiresAt: data.expiresAt ?? null,
    daysLeft: Number.isFinite(data.daysLeft) ? data.daysLeft : null,
    sessionScoped: data.sessionScoped === true,
    format: data.format ?? null,
    note: 'GreasyFork 会话 Cookie。等同登录凭证，请勿提交到版本库或分享。'
  }
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    // Windows 上 chmod 只影响只读位；POSIX 上确保 0600
    await chmod(file, 0o600).catch(() => {})
  } catch (err) {
    throw new GreasyForkError('E_STORAGE', `无法写入凭证文件 ${file}：${err?.message ?? err}`)
  }
  return file
}

/** 删除私有文件（不存在也算成功）。 */
export async function clearCredentialFile(env = process.env) {
  const file = credentialFilePath(env)
  try {
    await rm(file, { force: true })
  } catch (err) {
    throw new GreasyForkError('E_STORAGE', `无法删除凭证文件 ${file}：${err?.message ?? err}`)
  }
  return file
}

/**
 * 从各种导出格式里解析出 cookie 条目。
 *
 * 支持的输入（都当成"用户从浏览器复制来的东西"处理）：
 *   1. Cookie-Editor / EditThisCookie 导出的 JSON 数组
 *   2. JSON 对象：`{ name: value }` 或 `{ cookies: [...] }`
 *   3. Netscape cookies.txt（7 列制表符）
 *   4. Cookie 请求头：`a=1; b=2`
 *   5. 多行 `name=value`
 *   6. 单个值：`_greasyfork_session=...`
 *
 * @returns {{ name: string, value: string, expires: number|null }[]} expires 为秒级时间戳
 */
export function parseCookieEntries(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return []

  // 1) / 2) JSON
  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const data = JSON.parse(text)
      if (Array.isArray(data)) {
        return data
          .filter((item) => item && typeof item === 'object' && typeof item.name === 'string' && item.name !== '')
          .map((item) => {
            const exp = Number(item.expirationDate ?? item.expires ?? item.expiration)
            return {
              name: String(item.name),
              value: String(item.value ?? ''),
              expires: Number.isFinite(exp) && exp > 0 ? exp : null
            }
          })
      }
      if (data && typeof data === 'object') {
        if (Array.isArray(data.cookies)) return parseCookieEntries(JSON.stringify(data.cookies))
        return Object.entries(data)
          .filter(([, value]) => typeof value === 'string')
          .map(([name, value]) => ({ name, value, expires: null }))
      }
    } catch {
      /* 不是合法 JSON，继续按文本解析 */
    }
  }

  // 3) Netscape cookies.txt
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.startsWith('#'))
  if (lines.some((line) => line.split('\t').length >= 7)) {
    const out = []
    for (const line of lines) {
      const parts = line.split('\t')
      if (parts.length < 7) continue
      const expires = Number(parts[4])
      out.push({
        name: parts[5],
        value: parts[6],
        expires: Number.isFinite(expires) && expires > 0 ? expires : null
      })
    }
    if (out.length > 0) return out
  }

  // 4) / 5) / 6) 文本形式
  const out = []
  for (const part of text.replace(/\r?\n/g, ';').split(';')) {
    const item = part.trim().replace(/^cookie\s*:\s*/i, '')
    if (item === '') continue
    const index = item.indexOf('=')
    if (index <= 0) continue
    const name = item.slice(0, index).trim()
    if (!/^[A-Za-z0-9_.\-]+$/.test(name)) continue
    out.push({ name, value: item.slice(index + 1).trim(), expires: null })
  }
  return out
}

/** 规范成 Cookie 请求头（任意支持格式都能进来）。 */
export function normalizeCookieInput(raw) {
  const entries = parseCookieEntries(raw)
  if (entries.length === 0) return ''
  return entries
    .map((entry) => `${entry.name}=${entry.value}`)
    .filter((pair) => pair !== '=')
    .join('; ')
}

/**
 * 汇总一份 cookie 的有效期信息，供设置页直接显示。
 * @param {{ name: string, value: string, expires: number|null }[]} entries
 */
export function describeCookieExpiry(entries) {
  const list = Array.isArray(entries) ? entries : []
  const session = list.find((entry) => entry.name === '_greasyfork_session') ?? null
  const stamps = list.map((entry) => entry.expires).filter((value) => Number.isFinite(value) && value > 0)
  const latest = stamps.length > 0 ? Math.max(...stamps) : null
  const earliest = stamps.length > 0 ? Math.min(...stamps) : null
  return {
    names: list.map((entry) => entry.name),
    count: list.length,
    hasSession: Boolean(session),
    // `_greasyfork_session` 是 Rails 会话 cookie，站点没有下发过期时间
    sessionScoped: Boolean(session) && !session.expires,
    sessionExpiresAt: session?.expires ? new Date(session.expires * 1000).toISOString() : null,
    latestExpiresAt: latest ? new Date(latest * 1000).toISOString() : null,
    earliestExpiresAt: earliest ? new Date(earliest * 1000).toISOString() : null,
    daysLeft: latest ? Math.max(0, Math.round((latest * 1000 - Date.now()) / 86400000)) : null
  }
}

/**
 * 解析凭证来源（不返回原文给调用方以外的任何人）。
 * @param {{
 *   credentials?: { readRecord?: Function, resolve?: Function } | undefined,
 *   env?: NodeJS.ProcessEnv,
 *   override?: string | undefined,
 *   recordKey?: string
 * }} options
 * @returns {Promise<{ cookie: string, source: string, username?: string|null, file?: string } | undefined>}
 */
export async function resolveCredential(options = {}) {
  const { credentials, env = process.env, override, recordKey = CREDENTIAL_RECORD_KEY } = options

  if (override && String(override).trim() !== '') {
    return { cookie: normalizeCookieInput(override), source: 'tool-argument' }
  }

  const fromEnv = env[CREDENTIAL_ENV]
  if (fromEnv && String(fromEnv).trim() !== '') {
    return { cookie: normalizeCookieInput(fromEnv), source: `env:${CREDENTIAL_ENV}` }
  }

  if (credentials && typeof credentials.readRecord === 'function') {
    try {
      const record = await credentials.readRecord(recordKey)
      const cookie = record?.payload?.cookie
      if (typeof cookie === 'string' && cookie.trim() !== '') {
        return {
          cookie: normalizeCookieInput(cookie),
          source: `credential-store:${recordKey}`,
          username: record.payload.username ?? null
        }
      }
    } catch {
      /* 凭证服务不可用就继续降级 */
    }
  }
  if (credentials && typeof credentials.resolve === 'function') {
    try {
      const hit = await credentials.resolve(CREDENTIAL_ENV)
      if (hit && typeof hit.value === 'string' && hit.value.trim() !== '') {
        return { cookie: normalizeCookieInput(hit.value), source: `credential-store:${CREDENTIAL_ENV}` }
      }
    } catch {
      /* 同上 */
    }
  }

  const file = await readCredentialFile(env)
  if (file) {
    return { cookie: normalizeCookieInput(file.cookie), source: `file:${file.file}`, username: file.username, file: file.file }
  }
  return undefined
}

/** 判断粘贴进来的东西是什么格式（只用于回显给用户看）。 */
export function detectCookieFormat(raw) {
  const text = String(raw ?? '').trim()
  if (text === '') return 'empty'
  if (text.startsWith('[') || text.startsWith('{')) return 'json'
  if (text.split(/\r?\n/).some((line) => line.split('\t').length >= 7)) return 'netscape'
  if (/^cookie\s*:/i.test(text)) return 'header'
  if (text.includes('\n')) return 'lines'
  if (text.includes(';')) return 'header'
  return 'pair'
}

/**
 * 保存凭证：默认写私有文件；若 harness 凭证服务可用，额外镜像一份记录（可选）。
 * @param {{ cookie: string, username?: string|null, userId?: number|null, site?: string|null, format?: string|null }} data
 * @param {{ credentials?: object|undefined, env?: NodeJS.ProcessEnv, mirrorToStore?: boolean }} [options]
 */
export async function saveCredential(data, options = {}) {
  const { credentials, env = process.env, mirrorToStore = false } = options
  const entries = parseCookieEntries(data.cookie)
  const cookie = normalizeCookieInput(data.cookie)
  if (cookie === '') throw new GreasyForkError('E_NO_CREDENTIAL', 'Cookie 为空，未保存。')
  if (!/_greasyfork_session=/.test(cookie)) {
    throw new GreasyForkError(
      'E_NO_CREDENTIAL',
      'Cookie 里没有 _greasyfork_session，这多半不是 greasyfork.org 的登录 Cookie。',
      { hint: '在已登录的 greasyfork.org 页面用 Cookie-Editor → Export → JSON 导出，或复制请求头里的整行 Cookie。' }
    )
  }
  const expiry = describeCookieExpiry(entries)
  const file = await writeCredentialFile(
    {
      ...data,
      cookie,
      expiresAt: expiry.latestExpiresAt,
      daysLeft: expiry.daysLeft,
      sessionScoped: expiry.sessionScoped,
      format: data.format ?? detectCookieFormat(data.cookie)
    },
    env
  )
  if (mirrorToStore && credentials && typeof credentials.modifyRecord === 'function') {
    try {
      await credentials.modifyRecord(CREDENTIAL_RECORD_KEY, async () => ({
        kind: 'grant',
        payload: {
          cookie,
          username: data.username ?? null,
          userId: data.userId ?? null,
          savedAt: new Date().toISOString()
        }
      }))
    } catch {
      /* 镜像失败不影响主存储 */
    }
  }
  return { file, cookieCount: redactCookie(cookie).names.length, expiry }
}
