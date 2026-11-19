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
    version: 1,
    cookie: String(data.cookie || '').trim(),
    username: data.username ?? null,
    userId: data.userId ?? null,
    site: data.site ?? null,
    savedAt: new Date().toISOString(),
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

/** 规范化用户粘进来的 Cookie 文本（支持整段 Cookie 头 / 多行 / 单值）。 */
export function normalizeCookieInput(raw) {
  let text = String(raw ?? '').trim()
  if (text === '') return ''
  // 允许用户直接粘贴 `Cookie: xxx` 这一行
  text = text.replace(/^cookie\s*:\s*/i, '')
  // 允许 `_greasyfork_session=abc` 单值
  return text
    .replace(/\r?\n+/g, '; ')
    .replace(/;\s*;/g, ';')
    .replace(/;\s*$/, '')
    .trim()
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

/**
 * 保存凭证：默认写私有文件；若 harness 凭证服务可用，额外镜像一份记录（可选）。
 * @param {{ cookie: string, username?: string|null, userId?: number|null, site?: string|null }} data
 * @param {{ credentials?: object|undefined, env?: NodeJS.ProcessEnv, mirrorToStore?: boolean }} [options]
 */
export async function saveCredential(data, options = {}) {
  const { credentials, env = process.env, mirrorToStore = false } = options
  const cookie = normalizeCookieInput(data.cookie)
  if (cookie === '') throw new GreasyForkError('E_NO_CREDENTIAL', 'Cookie 为空，未保存。')
  if (!/_greasyfork_session=/.test(cookie)) {
    throw new GreasyForkError(
      'E_NO_CREDENTIAL',
      'Cookie 里没有 _greasyfork_session，这多半不是 greasyfork.org 的登录 Cookie。',
      { hint: '在已登录的 greasyfork.org 页面用开发者工具 → Application → Cookies 复制整行，或复制请求头里的 Cookie。' }
    )
  }
  const file = await writeCredentialFile({ ...data, cookie }, env)
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
  return { file, cookieCount: redactCookie(cookie).names.length }
}
