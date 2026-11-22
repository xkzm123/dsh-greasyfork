/**
 * 发布编排：读源 → 预检 → 发布 → 结果。
 *
 * 分成 prepare（只读、可 dry-run）与 execute（有副作用）两步，
 * 这样"发布前展示摘要"不是礼貌，而是流程里一个必然存在的阶段。
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve as resolvePath } from 'node:path'
import { GreasyForkError, failure, failureFromError } from './errors.js'
import {
  MAX_CODE_BYTES,
  extractScriptId,
  normalizeCode,
  validateSource
} from './meta.js'
import { compareVersions } from './meta.js'
import {
  isCloudflareChallenge,
  isSignInPage,
  parseValidationErrors,
  OVERRIDE_PARAM
} from './client.js'

export const SCRIPT_TYPES = { public: 1, unlisted: 2, library: 3 }
export const SCRIPT_TYPE_NAMES = { 1: 'public', 2: 'unlisted', 3: 'library' }

/** 覆盖项参数名 → 驼峰名（parseValidationErrors 返回的是参数名）。 */
const PARAM_TO_CAMEL = Object.fromEntries(
  Object.entries(OVERRIDE_PARAM).map(([camel, param]) => [param, camel])
)

/** 从文件名猜语言。 */
export function guessLanguage(path) {
  if (!path) return 'js'
  return /\.user\.css$/i.test(path) || /\.css$/i.test(path) ? 'css' : 'js'
}

/**
 * 读发布源：file 优先还是 code 优先？两者都给时以 code 为准并标注。
 * @param {{ file?: string, code?: string }} source
 * @param {string} cwd
 */
export async function loadSource(source, cwd = process.cwd()) {
  const { file, code } = source ?? {}
  if (typeof code === 'string' && code.trim() !== '') {
    return { code: normalizeCode(code), origin: 'inline', path: null }
  }
  if (!file || String(file).trim() === '') {
    throw new GreasyForkError('E_BAD_ARGUMENT', '缺少发布源：请提供 file（本地 .user.js 路径）或 code（脚本内容）。', {
      hint: '例如 file="scripts/demo.user.js"，或直接传 code。'
    })
  }
  const target = isAbsolute(file) ? file : resolvePath(cwd, file)
  let info
  try {
    info = await stat(target)
  } catch {
    throw new GreasyForkError('E_SOURCE_MISSING', `找不到脚本文件：${target}`, {
      hint: '相对路径以当前会话工作目录为基准；确认文件存在，或改用 code 传内容。'
    })
  }
  if (info.isDirectory()) {
    throw new GreasyForkError('E_SOURCE_MISSING', `${target} 是目录，不是脚本文件。`)
  }
  if (info.size > MAX_CODE_BYTES) {
    throw new GreasyForkError('E_CODE_TOO_LARGE', `文件 ${target} 有 ${info.size} 字节，超过 GreasyFork 2 MB 上限。`)
  }
  let text
  try {
    text = await readFile(target, 'utf8')
  } catch (err) {
    throw new GreasyForkError('E_SOURCE_MISSING', `读取 ${target} 失败：${err?.message ?? err}`)
  }
  return { code: normalizeCode(text), origin: 'file', path: target, bytes: info.size }
}

/** 把预检结果压缩成一段"发布摘要"，用于 dry-run 与结果回显。 */
function buildSummary({ loaded, validation, scriptType, scriptId, remote, changelog, language }) {
  const meta = validation.meta
  return {
    action: scriptId ? 'update' : 'create',
    scriptId: scriptId ?? null,
    source: loaded.origin === 'file' ? loaded.path : 'inline',
    language,
    visibility: scriptType,
    name: meta.name,
    version: meta.version,
    namespace: meta.namespace,
    description: meta.description,
    license: meta.license,
    match: [...meta.match, ...meta.include].slice(0, 12),
    matchCount: meta.match.length + meta.include.length,
    grant: meta.grant,
    require: meta.require,
    bytes: validation.stats.bytes,
    lines: validation.stats.lines,
    changelog: changelog ?? null,
    remote: remote
      ? { id: remote.id, name: remote.name, version: remote.version, url: remote.url }
      : null,
    codeChanged: validation.stats.codeChanged
  }
}

/**
 * 预检 + 生成发布计划（只读，不发写请求）。
 * @param {{
 *   source: { file?: string, code?: string },
 *   scriptId?: number|string|null,
 *   options?: { language?: 'js'|'css', scriptType?: 'public'|'unlisted'|'library',
 *     changelog?: string, force?: boolean, overrides?: Record<string, boolean> },
 *   client: import('./client.js').GreasyForkClient,
 *   cwd?: string
 * }} input
 */
export async function preparePublish(input) {
  const { source, client, cwd = process.cwd() } = input
  const options = input.options ?? {}
  const scriptId = extractScriptId(input.scriptId)
  if (input.scriptId !== undefined && input.scriptId !== null && input.scriptId !== '' && !scriptId) {
    throw new GreasyForkError('E_BAD_ARGUMENT', `scriptId 无法解析：${JSON.stringify(input.scriptId)}`)
  }

  const loaded = await loadSource(source, cwd)

  let remote = null
  let versions = []
  let remoteCode = null
  let remotePageInfo = null
  if (scriptId) {
    remote = await client.getScript(scriptId)
    if (!remote) {
      throw new GreasyForkError('E_SCRIPT_NOT_FOUND', `GreasyFork 上不存在脚本 ${scriptId}。`, {
        hint: '确认 scriptId / 脚本 URL；如果是首次发布，不要传 scriptId。'
      })
    }
    versions = await client.getVersions(scriptId)
    remoteCode = await client.getLatestCode(remote)
    remotePageInfo = await client.getScriptPageInfo(scriptId)
  }

  // 更新时默认沿用线上可见性/语言，避免"没写 scriptType 就把 unlisted 改成 public"
  const explicitType = options.scriptType ?? null
  const scriptType = explicitType ?? remotePageInfo?.scriptType ?? options.defaultScriptType ?? 'public'
  if (!(scriptType in SCRIPT_TYPES)) {
    throw new GreasyForkError('E_BAD_ARGUMENT', `scriptType 只能是 public / unlisted / library，收到 ${JSON.stringify(scriptType)}。`)
  }
  const language = options.language ?? remotePageInfo?.language ?? guessLanguage(loaded.path)

  const validation = validateSource({
    code: loaded.code,
    language,
    scriptType,
    creating: !scriptId,
    remote: remote
      ? { version: remote.version, name: remote.name, namespace: remote.namespace, code: remoteCode }
      : null
  })

  const blocking = [...validation.errors]
  const warnings = validation.warnings.map((w) => ({ ...w }))

  // 线上已有、代码与版本都没变化：默认拦下，避免"空发布"
  if (scriptId && remote) {
    const sameCode = validation.stats.codeChanged === false
    const sameVersion = compareVersions(validation.meta.version, remote.version) === 0
    if (sameCode && sameVersion && !options.force) {
      blocking.push({
        code: 'E_NO_CHANGES',
        message: `代码与 @version（${validation.meta.version}）都和线上最新版一致，没有可发布的内容。`,
        fix: '递增 @version 或修改代码后重试；确实要重发同一版本，传 force=true。'
      })
    }
  }

  const plan = {
    ok: blocking.length === 0,
    action: scriptId ? 'update' : 'create',
    scriptId: scriptId ?? null,
    language,
    scriptType,
    code: validation.normalized,
    meta: validation.meta,
    stats: validation.stats,
    errors: blocking,
    warnings,
    remote,
    versions,
    summary: buildSummary({ loaded, validation, scriptType, scriptId, remote, changelog: options.changelog, language }),
    loaded
  }
  return plan
}

/** 把计划转成"能直接看"的文本块。 */
export function renderPlan(plan) {
  const s = plan.summary
  const lines = []
  lines.push(`动作：${plan.action === 'create' ? '新建脚本' : `更新脚本 #${plan.scriptId}`}`)
  lines.push(`名称：${s.name ?? '(缺失)'}   版本：${s.version ?? '(缺失)'}`)
  lines.push(`可见性：${s.visibility}   语言：${s.language}   体积：${s.bytes} B / ${s.lines} 行`)
  if (s.namespace) lines.push(`namespace：${s.namespace}`)
  if (s.description) lines.push(`描述：${s.description}`)
  if (s.matchCount) lines.push(`匹配规则：${s.matchCount} 条${s.match.length ? `（${s.match.slice(0, 3).join(' , ')}${s.matchCount > 3 ? ' …' : ''}）` : ''}`)
  if (s.remote) lines.push(`线上现状：v${s.remote.version} — ${s.remote.url}`)
  if (s.changelog) lines.push(`更新说明：${s.changelog}`)
  if (plan.errors.length > 0) {
    lines.push('', `阻塞项（${plan.errors.length}）：`)
    for (const e of plan.errors) lines.push(`  ✗ [${e.code}] ${e.message}${e.fix ? ` → ${e.fix}` : ''}`)
  }
  if (plan.warnings.length > 0) {
    lines.push('', `告警（${plan.warnings.length}）：`)
    for (const w of plan.warnings) {
      lines.push(`  ! [${w.code}] ${w.message}${w.override ? `（可覆盖：${w.override}）` : ''}`)
    }
  }
  return lines.join('\n')
}

function interpretWrite(res) {
  if (isCloudflareChallenge(res.status, res.headers, res.text)) {
    throw new GreasyForkError('E_CLOUDFLARE', '发布请求被 Cloudflare 挑战拦截。')
  }
  if (res.status === 422) {
    throw new GreasyForkError('E_CSRF', 'CSRF 校验失败（HTTP 422）。')
  }
  if ([301, 302, 303].includes(res.status) && res.location) {
    if (/\/users\/sign_in/.test(res.location)) {
      throw new GreasyForkError('E_AUTH_EXPIRED', '发布时被跳转到登录页，会话已失效。')
    }
    const m = /\/scripts\/(\d+)/.exec(res.location)
    if (m) return { ok: true, scriptId: Number.parseInt(m[1], 10), url: res.location }
    return {
      ok: false,
      code: 'E_HTTP',
      message: `发布后跳转到 ${res.location}，没有拿到脚本页面地址。`,
      hint: '到 greasyfork.org 上确认脚本是否已创建；若已创建，后续更新请带上 scriptId。'
    }
  }
  if (res.status === 200) {
    // 浏览器内请求会自动跟随 302：此时 location 拿不到，但"落到脚本页"这件事能从最终 URL 看出来
    // （POST 目标 /script_versions、/scripts/<id>/versions 本身不算落地）
    let landedPath = ''
    try {
      landedPath = new URL(String(res.url ?? '')).pathname
    } catch {
      landedPath = ''
    }
    const landed = /(?:^|\/)scripts\/(\d+)(?:-|$|\/versions\/\d+)/.exec(landedPath)
    if (landed && !/\/new$/.test(landedPath)) {
      return { ok: true, scriptId: Number.parseInt(landed[1], 10), url: res.url }
    }
    if (isSignInPage(res.text)) throw new GreasyForkError('E_AUTH_EXPIRED', '会话已失效（返回了登录页）。')
    const parsed = parseValidationErrors(res.text)
    if (parsed.recaptcha && parsed.messages.length === 0) {
      throw new GreasyForkError('E_RECAPTCHA', '账号发布新脚本需要过人机验证。')
    }
    return {
      ok: false,
      code: parsed.recaptcha ? 'E_RECAPTCHA' : 'E_VALIDATION',
      messages: parsed.messages,
      neededOverrides: parsed.overrides.map((p) => PARAM_TO_CAMEL[p] ?? p),
      recaptcha: parsed.recaptcha
    }
  }
  if (res.status === 403) throw new GreasyForkError('E_NOT_AUTHOR', '无权发布（HTTP 403）。')
  if (res.status === 429) throw new GreasyForkError('E_RATE_LIMITED', '发布被限流（HTTP 429）。')
  throw new GreasyForkError('E_HTTP', `发布失败：HTTP ${res.status}`)
}

/** 合并覆盖项：显式传入的 + acceptWarnings 时计划里的告警。 */
function mergeOverrides(plan, options) {
  const overrides = { ...(options.overrides ?? {}) }
  if (options.acceptWarnings) {
    for (const w of plan.warnings) {
      if (!w.blocking || !w.override) continue
      // 告警里的 override 是 Rails 参数名（如 version_check_override），
      // 而 overrideFields 认驼峰名，这里统一转换。
      overrides[PARAM_TO_CAMEL[w.override] ?? w.override] = true
    }
  }
  return overrides
}

/**
 * 执行发布（有副作用）。
 * @param {{
 *   plan: Awaited<ReturnType<typeof preparePublish>>,
 *   client: import('./client.js').GreasyForkClient,
 *   options?: { dryRun?: boolean, changelog?: string, acceptWarnings?: boolean,
 *     overrides?: Record<string, boolean>, syncIdentifier?: string, syncType?: 'manual'|'automatic',
 *     localeId?: number, mode?: 'auto'|'create'|'update'|'prefill'|'sync' }
 * }} input
 */
export async function executePublish(input) {
  try {
    return await executePublishInner(input)
  } catch (error) {
    // 预期内的失败（会话失效 / Cloudflare / 无权限 / 网络）一律变成结构化失败，
    // 让模型拿到 code + hint，而不是一条异常文本。
    return failureFromError(error)
  }
}

async function executePublishInner(input) {
  const { plan, client } = input
  const options = input.options ?? {}
  const mode = options.mode ?? 'auto'

  if (!plan.ok) {
    return failure('E_VALIDATION', '预检未通过，未发起发布。', {
      errors: plan.errors,
      warnings: plan.warnings,
      summary: plan.summary
    })
  }

  if (options.dryRun) {
    return {
      ok: true,
      action: 'dry-run',
      summary: plan.summary,
      warnings: plan.warnings,
      text: renderPlan(plan)
    }
  }

  if (mode === 'prefill') return runPrefill({ plan, client })

  const overrides = mergeOverrides(plan, options)
  const token = (await client.getFormPage(plan.scriptId ?? undefined)).token
  const payload = {
    token,
    code: plan.code,
    scriptType: SCRIPT_TYPES[plan.scriptType],
    overrides,
    language: plan.language
  }

  let outcome = plan.scriptId
    ? interpretWrite(
        await client.createVersion({
          ...payload,
          scriptId: plan.scriptId,
          changelog: options.changelog ?? plan.summary.changelog ?? undefined
        })
      )
    : interpretWrite(
        await client.createScript({
          ...payload,
          importUrl: options.syncIdentifier,
          syncType: options.syncType,
          localeId: options.localeId
        })
      )

  // 站点把"告警"渲染成需要勾选的复选框：拿到信号后带覆盖项重试一次
  let retried = false
  if (
    !outcome.ok &&
    outcome.code === 'E_VALIDATION' &&
    Array.isArray(outcome.neededOverrides) &&
    outcome.neededOverrides.length > 0 &&
    options.acceptWarnings &&
    !retried
  ) {
    retried = true
    const merged = { ...overrides }
    for (const name of outcome.neededOverrides) merged[name] = true
    const retryToken = (await client.getFormPage(plan.scriptId ?? undefined)).token
    outcome = plan.scriptId
      ? interpretWrite(
          await client.createVersion({
            ...payload,
            token: retryToken,
            overrides: merged,
            scriptId: plan.scriptId,
            changelog: options.changelog ?? plan.summary.changelog ?? undefined
          })
        )
      : interpretWrite(
          await client.createScript({
            ...payload,
            token: retryToken,
            overrides: merged,
            importUrl: options.syncIdentifier,
            syncType: options.syncType,
            localeId: options.localeId
          })
        )
    if (outcome.ok) outcome.appliedOverrides = Object.keys(merged)
  }

  if (!outcome.ok) {
    if (outcome.code === 'E_RECAPTCHA') {
      return failure('E_RECAPTCHA', '发布被 GreasyFork 的人机验证拦住（新账号首次发布常见）。', {
        errors: [],
        warnings: plan.warnings,
        summary: plan.summary,
        fallback: {
          mode: 'prefill',
          why: '更新已有脚本不需要验证码；只有"新建脚本"可能触发。',
          how: '改用 mode="prefill"：插件会把代码预填到官方表单，你在浏览器里点一次"发布"即可；之后所有更新都可以全自动。'
        }
      })
    }
    return failure(outcome.code ?? 'E_VALIDATION', outcome.message ?? 'GreasyFork 拒绝了这次发布。', {
      errors: (outcome.messages ?? []).map((m) => ({ message: m })),
      neededOverrides: outcome.neededOverrides ?? [],
      warnings: plan.warnings,
      summary: plan.summary
    })
  }

  const info = await client.getScript(outcome.scriptId).catch(() => null)
  const url = info?.url ?? outcome.url
  return {
    ok: true,
    action: plan.scriptId ? 'updated' : 'created',
    status: 'published',
    scriptId: outcome.scriptId,
    url,
    name: info?.name ?? plan.summary.name,
    version: info?.version ?? plan.summary.version,
    previousVersion: plan.remote?.version ?? null,
    visibility: plan.scriptType,
    warnings: plan.warnings,
    appliedOverrides: outcome.appliedOverrides ?? Object.keys(overrides),
    summary: plan.summary,
    text: [
      plan.scriptId ? `已发布新版本 v${info?.version ?? plan.summary.version}` : `已创建脚本 v${info?.version ?? plan.summary.version}`,
      `页面：${url}`,
      plan.warnings.length ? `附带 ${plan.warnings.length} 条告警（已按 acceptWarnings 处理或本身不阻塞）。` : '无告警。'
    ].join('\n')
  }
}

/** 降级：把代码预填到官方表单，用户只需在浏览器点一次发布。 */
async function runPrefill({ plan, client }) {
  const result = await client.prefill({ code: plan.code, scriptId: plan.scriptId ?? undefined })
  if (!result.ok) {
    return failure('E_UNSUPPORTED', `预填失败（HTTP ${result.status}），表单页没有返回。`, {
      hint: '确认 Cookie 仍然有效；或直接打开表单页手动粘贴代码。',
      summary: plan.summary
    })
  }
  const formUrl = plan.scriptId
    ? `${client.site}/${client.locale}/scripts/${plan.scriptId}/versions/new`
    : `${client.site}/${client.locale}/script_versions/new`
  return {
    ok: true,
    action: 'prefilled',
    status: 'manual-step-required',
    scriptId: plan.scriptId ?? null,
    formUrl,
    summary: plan.summary,
    text: [
      '已把代码提交到 GreasyFork 的"预填表单"接口。',
      `下一步：在浏览器打开 ${formUrl}（代码已在表单里），点一次「发布」即可。`,
      plan.scriptId ? '更新流程不需要验证码，通常可直接用默认的自动模式。' : '这是新建脚本遇到人机验证时的降级路径。'
    ].join('\n')
  }
}

/** 让 GreasyFork 从 sync_identifier 重新拉取（GitHub 托管模式）。 */
export async function runSync(input) {
  const { client, scriptId, syncIdentifier, syncType = 'manual', trigger = true } = input
  const id = extractScriptId(scriptId)
  if (!id) return failure('E_BAD_ARGUMENT', 'sync 模式需要有效的 scriptId。')
  if (!syncIdentifier) return failure('E_BAD_ARGUMENT', 'sync 模式需要 syncIdentifier（GreasyFork 会从这个 URL 拉代码）。')
  const token = (await client.getFormPage(id)).token
  const res = await client.syncUpdate({ scriptId: id, token, syncIdentifier, syncType, trigger })
  if (isCloudflareChallenge(res.status, res.headers, res.text)) {
    throw new GreasyForkError('E_CLOUDFLARE', '同步请求被 Cloudflare 拦截。')
  }
  if (res.status === 422) throw new GreasyForkError('E_CSRF', 'CSRF 校验失败（HTTP 422）。')
  if (![301, 302, 303].includes(res.status)) {
    return failure('E_HTTP', `同步请求返回 HTTP ${res.status}，未触发同步。`, { hint: '确认脚本确实配置了 sync_identifier。' })
  }
  const page = await client.get(res.location ?? client.path(`/scripts/${id}`))
  const text = page.text || ''
  const notice =
    /Script successfully synced, but no changes found/i.test(text)
      ? 'no-changes'
      : /Script successfully synced/i.test(text)
        ? 'synced'
        : /Script sync failed[^<]*/i.exec(text)?.[0] ?? 'unknown'
  return {
    ok: true,
    action: 'synced',
    status: notice,
    scriptId: id,
    syncIdentifier,
    text: `已触发 GreasyFork 从 ${syncIdentifier} 同步：${notice}`
  }
}
