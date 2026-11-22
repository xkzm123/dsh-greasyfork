/**
 * dsh-greasyfork —— DeepSeek Harness 插件入口。
 *
 * 注册四个模型可调用的工具（全部走同一套核心逻辑，CLI 也复用）：
 *   greasyfork_auth       凭证状态 / 一次性配置 / 清除 / 验证
 *   greasyfork_preflight  只读预检：解析元数据、校验、与线上比对、给发布摘要
 *   greasyfork_push       真正的"推送"：新建脚本或发布新版本（可 dryRun）
 *   greasyfork_status     只读查看线上脚本与版本
 *
 * 约束：本文件不 import 任何 @deepseek-ai/* 包，避免插件在 profile 的
 * node_modules 里解析不到 harness 内部包；工具定义按 dsh-tools 的
 * ToolDefinition 形状手写（name / description / parameters(JSON Schema) /
 * output.schema / output.render / execute）。
 */

import {
  DEFAULT_API_SITE,
  DEFAULT_SITE,
  DEFAULT_USER_AGENT,
  GreasyForkClient
} from './core/client.js'
import {
  clearCredentialFile,
  credentialFilePath,
  describeCookieExpiry,
  detectCookieFormat,
  parseCookieEntries,
  readCredentialFile,
  redactCookie,
  resolveCredential,
  resolveDshHome,
  saveCredential
} from './core/credentials.js'
import { createBrowserFetch, createBrowserManager, resolveBrowser } from './core/browser.js'
import { GreasyForkError, failure, failureFromError } from './core/errors.js'
import { extractScriptId } from './core/meta.js'
import { TOPICS, renderGuide } from './core/guide.js'
import { listPath, parseScriptLinks } from './core/list.js'
import { executePublish, preparePublish, renderPlan, runSync } from './core/publish.js'
import { installSettingsRoutes } from './settings.js'

/** 插件身份（cordis loader 用）。 */
export const name = 'greasyfork'
/** 只依赖工具注册表；凭证服务按需用 ctx.get('credentials') 取，缺了也能工作。 */
export const inject = ['tools']

const DEFAULT_CONFIG = {
  site: DEFAULT_SITE,
  apiSite: DEFAULT_API_SITE,
  locale: 'en',
  timeoutMs: 30000,
  userAgent: DEFAULT_USER_AGENT,
  defaultScriptType: 'public',
  mirrorCredentialToStore: false,
  /** 是否允许启动受控浏览器（发布时用来绕过 Cloudflare）。测试里关掉。 */
  browser: true
}

/** 输出 schema：宽松对象，工具结果本身是纯 JSON。 */
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    status: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
    hint: { type: 'string' },
    text: { type: 'string' },
    scriptId: { type: 'number' },
    url: { type: 'string' },
    name: { type: 'string' },
    version: { type: 'string' }
  }
}

const textRender = (_args, value) => [
  { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) }
]

/** 把工具结果里的对象字段收敛成合法 JSON（去掉 undefined）。 */
function clean(value) {
  if (value === undefined || value === null) return {}
  return JSON.parse(
    JSON.stringify(value, (_k, v) => {
      if (v === undefined) return undefined
      if (typeof v === 'bigint') return String(v)
      return v
    })
  )
}

function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const merged = { ...DEFAULT_CONFIG, ...config }
  if (!Number.isFinite(Number(merged.timeoutMs)) || Number(merged.timeoutMs) <= 0) merged.timeoutMs = DEFAULT_CONFIG.timeoutMs
  merged.timeoutMs = Number(merged.timeoutMs)
  if (!['public', 'unlisted', 'library'].includes(merged.defaultScriptType)) merged.defaultScriptType = 'public'
  return merged
}

/** 从工具执行上下文里拿会话工作目录。 */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd()
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Partial<typeof DEFAULT_CONFIG>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const logger = typeof ctx.logger === 'function' ? ctx.logger('greasyfork') : console
  const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : undefined
  const dshHome = resolveDshHome(process.env)
  const site = String(config.site || 'https://greasyfork.org').replace(/\/+$/, '')

  /**
   * 浏览器管理器：设置页和工具共用同一个实例。
   * 有它才能走"浏览器内请求"——Cloudflare 只拦 Node 的 TLS 指纹。
   */
  const browserDisabled = { skipped: '浏览器通道已关闭（config.browser=false）' }
  const manager =
    config.browser === false
      ? {
          status: () => ({ alive: false, mode: null, browser: null, error: browserDisabled.skipped }),
          ensure: async () => {
            throw new Error(browserDisabled.skipped)
          },
          openTab: async () => null,
          cookies: async () => [],
          evaluate: async () => ({ error: browserDisabled.skipped }),
          verifyLogin: async () => ({ ok: false, error: browserDisabled.skipped }),
          browserFetch: async () => {
            throw new Error(browserDisabled.skipped)
          },
          diagnose: async () => browserDisabled,
          restoreCookies: async () => 0,
          syncCookiesBack: async () => 0,
          relogin: async () => ({ ok: false, reason: browserDisabled.skipped }),
          close: async () => false,
          dispose: async () => {},
          note: () => {},
          log: () => [],
          session: null
        }
      : createBrowserManager({
          dshHome,
          site,
          resolveFn: resolveBrowser,
          logger,
          seed: async () => {
            const saved = await resolveCredential({ credentials, env: process.env }).catch(() => null)
            return saved?.cookie ?? null
          },
          // 浏览器里滚动后的 cookie 回写：站点换 session（OAuth 回跳、二次验证）后
          // 不更新文件，下次启动就会拿旧值去重连，表现就是"刚登录就失效"。
          persist: async (header) => {
            const saved = await resolveCredential({ credentials, env: process.env }).catch(() => null)
            await saveCredential(
              { cookie: header, username: saved?.username ?? null, userId: null, site },
              { credentials }
            ).catch((error) => logger?.warn?.('greasyfork: 回写凭证失败（%s）', error?.message ?? error))
          }
        })

  /** 按当前凭证建一个客户端。 */
  const makeClient = async (exec, cookieOverride, options = {}) => {
    const resolved = await resolveCredential({
      credentials,
      env: process.env,
      override: cookieOverride
    })
    if (!resolved) {
      throw new GreasyForkError('E_NO_CREDENTIAL', '还没有配置 GreasyFork 凭证。')
    }
    // 默认纯 Node 请求：不启动、不接管任何浏览器窗口。
    // 只有用户显式打开 config.browser、且浏览器实例本来就活着时才借用它。
    const viaBrowser = config.browser === true && manager.status().alive === true
    const client = new GreasyForkClient({
      site: config.site,
      apiSite: config.apiSite,
      locale: config.locale,
      timeoutMs: config.timeoutMs,
      userAgent: config.userAgent,
      cookie: resolved.cookie,
      signal: exec?.signal,
      // 浏览器实例在跑就借它的指纹与 cookie，Cloudflare 拦不住
      fetchImpl: viaBrowser ? createBrowserFetch(manager) : undefined
    })
    return { client, resolved, viaBrowser }
  }

  // ── greasyfork_auth ────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'greasyfork_auth',
    description:
      '管理 GreasyFork 登录凭证（会话 Cookie）。action=status 查看是否已配置及来源；action=set 保存一次性配置（cookie 参数）；action=verify 验证当前凭证是否仍有效；action=clear 删除本地保存的凭证。凭证默认保存在 harness home 下的 greasyfork/credentials.json（权限 0600），也可用环境变量 GREASYFORK_COOKIE 提供。任何时候都不会回显 Cookie 原文。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'set', 'verify', 'clear'],
          description: '要执行的动作，默认 status。'
        },
        cookie: {
          type: 'string',
          description:
            'action=set 时必填：从已登录浏览器导出的 greasyfork.org Cookie（含 _greasyfork_session，最好也含 cf_clearance）。保存后不会再出现在任何输出里。'
        }
      }
    },
    output: { schema: OUTPUT_SCHEMA, render: textRender },
    async execute(args, exec) {
      try {
        const action = args?.action ?? 'status'
        if (action === 'set') {
          const cookie = args?.cookie
          if (!cookie || String(cookie).trim() === '') {
            return clean(
              failure('E_BAD_ARGUMENT', 'action=set 需要 cookie 参数。', {
                hint: '把浏览器里 greasyfork.org 的 Cookie 整行传进来；或运行 node lib/cli.js auth set 从标准输入粘贴。'
              })
            )
          }
          // 先验证再落盘：避免把错东西存起来
          const probe = new GreasyForkClient({
            site: config.site,
            apiSite: config.apiSite,
            locale: config.locale,
            timeoutMs: config.timeoutMs,
            userAgent: config.userAgent,
            cookie,
            signal: exec?.signal
          })
          const who = await probe.whoami().catch((err) => ({ authenticated: false, error: err }))
          // 保存前尽量校验一次，但 Cloudflare 拦 Node 不代表 Cookie 无效。
          // 遇到判断不了的情况：先注入浏览器复检，还是判断不了就先存下来（发布时会再校验）。
          let verified = who.authenticated === true
          let verifiedBy = verified ? 'node' : null
          let undetermined = false
          if (!verified) {
            const nodeCode = who.error instanceof GreasyForkError ? who.error.code : null
            const looksLikeChallenge =
              nodeCode === 'E_CLOUDFLARE' || nodeCode === 'E_NETWORK' || nodeCode === 'E_TIMEOUT'
            // Cloudflare 拦住校验请求 ≠ Cookie 无效：先存下来，真正用的时候再判
            if (looksLikeChallenge) undetermined = true
          }
          if (!verified && !undetermined) {
            return clean(
              failure('E_AUTH_EXPIRED', '这个 Cookie 没能通过登录校验，未保存。', {
                hint: '确认复制的是 greasyfork.org 的完整 Cookie（含 _greasyfork_session），且浏览器里当前是登录状态。'
              })
            )
          }
          const saved = await saveCredential(
            { cookie, username: who.username, userId: who.userId, site: config.site },
            { credentials, mirrorToStore: config.mirrorCredentialToStore }
          )
          return clean({
            ok: true,
            action: 'set',
            status: 'saved',
            configured: true,
            verified,
            verifiedBy,
            username: who.username ?? null,
            userId: who.userId ?? null,
            storage: saved.file,
            expiry: saved.expiry,
            cookie: redactCookie(cookie),
            text: [
              `凭证已保存到 ${saved.file}（权限 0600）。账号：${who.username ?? '(未知)'}。` +
                (verified
                  ? `校验方式：${verifiedBy === 'browser' ? '浏览器内复检' : 'Node 直连'}。`
                  : '本次没能校验（Cloudflare 拦住了 Node 直连），已先存下，发布时会在浏览器里复检。'),
              verified ? '登录态已注入插件专用浏览器，之后无需重复登录。' : null,
              process.env.GREASYFORK_COOKIE ? '注意：当前进程还设置了环境变量 GREASYFORK_COOKIE，它的优先级更高，会覆盖这个文件。' : null
            ]
              .filter(Boolean)
              .join('\n')
          })
        }

        if (action === 'clear') {
          const file = await clearCredentialFile(process.env)
          return clean({
            ok: true,
            action: 'clear',
            status: 'cleared',
            storage: file,
            text: [
              `已删除 ${file}。`,
              process.env.GREASYFORK_COOKIE ? '注意：环境变量 GREASYFORK_COOKIE 仍然生效，需要一并清除。' : null,
              '如果凭证来自 harness 凭证服务，需要在凭证设置里另行删除。'
            ]
              .filter(Boolean)
              .join('\n')
          })
        }

        const resolved = await resolveCredential({ credentials, env: process.env })
        if (!resolved) {
          return clean({
            ok: true,
            action,
            configured: false,
            storage: credentialFilePath(process.env),
            text: [
              '尚未配置 GreasyFork 凭证。',
              `存储位置（配置后会写这里）：${credentialFilePath(process.env)}`,
              '配置方式二选一：',
              '  1) 运行 `node lib/cli.js auth set`，粘贴一次 Cookie（推荐，不经过对话记录）；',
              '  2) 调用 greasyfork_auth(action="set", cookie="…")。',
              'Cookie 获取：登录 greasyfork.org → 开发者工具 → Application → Cookies，复制 _greasyfork_session（有 cf_clearance 也一起）。'
            ].join('\n')
          })
        }

        const client = new GreasyForkClient({
          site: config.site,
          apiSite: config.apiSite,
          locale: config.locale,
          timeoutMs: config.timeoutMs,
          userAgent: config.userAgent,
          cookie: resolved.cookie,
          signal: exec?.signal
        })
        let who = await client.whoami().catch((err) => ({ authenticated: false, error: err }))
        // Node 直连会被 Cloudflare 挑战（403 + "Just a moment..."），那不是"凭证过期"。
        // 遇到这种判断不了的情况，问一次浏览器：它带同一套 cookie，但 TLS 指纹是真的。
        let verifiedBy = 'node'
        let undetermined = false
        let challengeStage = null
        if (who.authenticated !== true) {
          const nodeCode = who.error instanceof GreasyForkError ? who.error.code : null
          // 纯 Node 通道：被 Cloudflare 拦就是"判断不了"，不是凭证失效
          if (nodeCode === 'E_CLOUDFLARE' || nodeCode === 'E_NETWORK' || nodeCode === 'E_TIMEOUT') {
            undetermined = true
            challengeStage = 'Cloudflare 拦住了校验请求'
          }
        }
        const valid = who.authenticated === true ? true : undetermined ? null : false
        return clean({
          ok: true,
          action,
          configured: true,
          valid,
          verifiedBy,
          source: resolved.source,
          username: who.username ?? resolved.username ?? null,
          userId: who.userId ?? null,
          cookie: redactCookie(resolved.cookie),
          expiry: describeCookieExpiry(parseCookieEntries(resolved.cookie)),
          savedAt: (await readCredentialFile(process.env).catch(() => null))?.savedAt ?? null,
          storage: credentialFilePath(process.env),
          text:
            valid === true
              ? `凭证有效（来源：${resolved.source}，账号：${who.username ?? '未知'}${verifiedBy === 'browser' ? '，浏览器内校验' : ''}）。`
              : valid === null
                ? challengeStage
                  ? `凭证已存在（来源：${resolved.source}），但登录还没走完：${challengeStage}。这不等于凭证失效——在插件打开的窗口里完成验证/授权后，再跑一次即可。`
                  : `凭证已存在（来源：${resolved.source}），但这次判断不了：Node 直连被 Cloudflare 挡住，浏览器通道也没起来。这不等于凭证失效，发布时会在浏览器里自动复检。`
                : `凭证已存在（来源：${resolved.source}），但登录校验没通过：站点把请求跳到了登录页，会话确实失效了，需要重新登录。`
        })
      } catch (error) {
        logger?.error?.('greasyfork_auth failed: %s', error?.message ?? error)
        return clean(failureFromError(error))
      }
    }
  })

  // ── greasyfork_preflight ───────────────────────────────────────────────────
  const sourceParams = {
    file: { type: 'string', description: '本地用户脚本路径（.user.js / .user.css），相对路径以当前会话工作目录为基准。' },
    code: { type: 'string', description: '直接给脚本内容（与 file 二选一，同时给时以 code 为准）。' },
    scriptId: { type: 'string', description: '要更新的 GreasyFork 脚本 id 或脚本 URL；首次发布不要传。' },
    scriptType: {
      type: 'string',
      enum: ['public', 'unlisted', 'library'],
      description: '发布类型：public 公开、unlisted 不列出、library 库脚本。默认 public。'
    },
    language: { type: 'string', enum: ['js', 'css'], description: '脚本语言，默认按扩展名推断。' }
  }

  ctx.tools.register({
    name: 'greasyfork_preflight',
    description:
      '只读预检：读取本地脚本（或直接给内容），解析用户脚本元数据（@name/@description/@version/@namespace/@match 等），按 GreasyFork 的校验规则给出错误与告警，并在传入 scriptId 时拉取线上最新版本做版本冲突与 namespace 变更比对。不产生任何写操作，返回可直接展示给用户的发布摘要。发布前建议先跑它。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { ...sourceParams }
    },
    output: { schema: OUTPUT_SCHEMA, render: textRender },
    async execute(args, exec) {
      try {
        const { client } = await makeClient(exec)
        const plan = await preparePublish({
          source: { file: args?.file, code: args?.code },
          scriptId: args?.scriptId,
          options: {
            language: args?.language,
            scriptType: args?.scriptType,
            defaultScriptType: config.defaultScriptType
          },
          client,
          cwd: sessionCwd(exec)
        })
        return clean({
          ok: plan.ok,
          action: 'preflight',
          ready: plan.ok,
          summary: plan.summary,
          errors: plan.errors,
          warnings: plan.warnings,
          text: `${renderPlan(plan)}\n\n${plan.ok ? '预检通过，可以发布。' : '预检未通过：先修掉阻塞项再发布。'}`
        })
      } catch (error) {
        if (error instanceof GreasyForkError && error.code === 'E_NO_CREDENTIAL') {
          // 预检本身不需要登录：没有凭证时退化成"纯本地校验"
          try {
            const localPlan = await preparePublish({
              source: { file: args?.file, code: args?.code },
              scriptId: null,
              options: {
                language: args?.language,
                scriptType: args?.scriptType,
                defaultScriptType: config.defaultScriptType
              },
              client: new GreasyForkClient({ site: config.site, apiSite: config.apiSite, locale: config.locale }),
              cwd: sessionCwd(exec)
            })
            return clean({
              ok: localPlan.ok,
              action: 'preflight',
              ready: localPlan.ok,
              offline: true,
              summary: localPlan.summary,
              errors: localPlan.errors,
              warnings: localPlan.warnings,
              text: `${renderPlan(localPlan)}\n\n（未配置凭证，本次只做了本地校验，未与线上版本比对。）`
            })
          } catch (inner) {
            return clean(failureFromError(inner))
          }
        }
        logger?.error?.('greasyfork_preflight failed: %s', error?.message ?? error)
        return clean(failureFromError(error))
      }
    }
  })

  // ── greasyfork_push ────────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'greasyfork_push',
    description:
      '把用户脚本推送到 GreasyFork：不带 scriptId 时新建脚本，带 scriptId 时在该脚本下发布新版本（等价于 git push）。内部先做与 greasyfork_preflight 相同的元数据校验与版本冲突检查，再走 GreasyFork 的网页发布流程，成功后返回脚本页面链接、版本号与状态。dryRun=true 时只返回将要发布的摘要，不写任何东西。mode="prefill" 是遇到人机验证时的降级路径；mode="sync" 让 GreasyFork 从 syncIdentifier 拉取代码（GitHub 托管脚本用）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...sourceParams,
        changelog: { type: 'string', description: '本次更新的更新说明（更新已有脚本时展示在版本历史里）。' },
        mode: {
          type: 'string',
          enum: ['auto', 'create', 'update', 'prefill', 'sync'],
          description: 'auto（默认，按是否有 scriptId 决定新建/更新）、prefill（降级预填）、sync（让站点从 URL 同步）。'
        },
        dryRun: { type: 'boolean', description: 'true 时只做预检并返回摘要，不发布。' },
        acceptWarnings: {
          type: 'boolean',
          description:
            'true 时自动带上 GreasyFork 要求的覆盖项（版本未递增、缺 license、namespace 变更等）重试一次。默认 false，让告警显式暴露。'
        },
        overrides: {
          type: 'object',
          additionalProperties: true,
          description:
            '精确指定覆盖项：versionCheckOverride / addMissingVersion / namespaceCheckOverride / addMissingNamespace / minifiedConfirmation / sensitiveSiteConfirmation / allowCodePreviouslyPosted / licenseMissingOverride / metaNotAtStartConfirmation。'
        },
        force: { type: 'boolean', description: '代码与版本都没变化时仍然发布（默认会拦下）。' },
        syncIdentifier: {
          type: 'string',
          description: '新建脚本时把来源 URL 记到 GreasyFork（配合 sync_type 可实现"站点自动从 GitHub 拉更新"）。'
        },
        syncType: { type: 'string', enum: ['manual', 'automatic'], description: '同步方式，默认 manual。' },
        localeId: { type: 'number', description: '脚本默认语言的 locale id（可省略，跟随站点默认）。' },
        cookie: {
          type: 'string',
          description: '仅本次调用使用的 Cookie（通常不需要；已配置凭证时留空）。'
        }
      }
    },
    output: { schema: OUTPUT_SCHEMA, render: textRender },
    async execute(args, exec) {
      try {
        if (args?.mode === 'create' && args?.scriptId) {
          return clean(failure('E_BAD_ARGUMENT', 'mode="create" 与 scriptId 冲突：新建脚本不要带 scriptId。'))
        }
        if (args?.mode === 'update' && !args?.scriptId) {
          return clean(failure('E_BAD_ARGUMENT', 'mode="update" 需要 scriptId。'))
        }
        const { client, resolved } = await makeClient(exec, args?.cookie, { ensureBrowser: true })
        const plan = await preparePublish({
          source: { file: args?.file, code: args?.code },
          scriptId: args?.scriptId,
          options: {
            language: args?.language,
            scriptType: args?.scriptType,
            defaultScriptType: config.defaultScriptType,
            changelog: args?.changelog,
            force: args?.force === true,
            overrides: args?.overrides
          },
          client,
          cwd: sessionCwd(exec)
        })

        if (args?.mode === 'sync') {
          if (!plan.scriptId) {
            return clean(failure('E_BAD_ARGUMENT', 'sync 模式需要 scriptId。', { hint: 'sync 是"让站点从 URL 拉更新"，必须先有脚本。' }))
          }
          const result = await runSync({
            client,
            scriptId: plan.scriptId,
            syncIdentifier: args?.syncIdentifier,
            syncType: args?.syncType ?? 'manual',
            trigger: true
          })
          return clean({ ...result, credentialSource: resolved.source })
        }

        const publishOptions = {
          dryRun: args?.dryRun === true,
          mode: args?.mode ?? 'auto',
          changelog: args?.changelog,
          acceptWarnings: args?.acceptWarnings === true,
          overrides: args?.overrides,
          syncIdentifier: args?.syncIdentifier,
          syncType: args?.syncType,
          localeId: args?.localeId
        }
        let result
        try {
          result = await executePublish({ plan, client, options: publishOptions })
        } catch (error) {
          // 浏览器重启后 Rails 的 session cookie 就没了，站点会把表单跳登录页。
          // 凭证文件里的 cookie 通常还有效，注回浏览器再发一次即可，不该让用户重登。
          if (!(error instanceof GreasyForkError) || error.code !== 'E_AUTH_EXPIRED') throw error
          // 浏览器通道没开时无法自愈：直接给出可执行的提示
          if (!(manager.status().alive === true)) {
            throw new GreasyForkError('E_AUTH_EXPIRED', error.message, {
              hint: '站点侧的会话失效了：在设置 → GreasyFork 里重新导出一份 Cookie 粘贴进来。'
            })
          }
          const healed = await manager.relogin().catch((err) => ({ ok: false, error: err?.message ?? String(err) }))
          if (!healed?.ok) {
            throw new GreasyForkError('E_AUTH_EXPIRED', error.message, {
              hint: '已尝试用保存的凭证恢复登录态但没成功：站点侧的会话确实失效了，在设置 → GreasyFork 重新采集一次即可。'
            })
          }
          logger?.info?.('greasyfork: 发布被跳登录页，已注入保存的凭证恢复登录态并重试')
          result = await executePublish({ plan, client, options: publishOptions })
        }
        return clean({ ...result, credentialSource: resolved.source })
      } catch (error) {
        logger?.error?.('greasyfork_push failed: %s', error?.message ?? error)
        return clean(failureFromError(error))
      }
    }
  })

  // ── greasyfork_status ──────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'greasyfork_status',
    description:
      '只读查询 GreasyFork 脚本状态：名称、描述、线上最新版本、版本历史、作者、页面链接。不需要登录凭证。用于发布前后确认线上现状。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scriptId: { type: 'string', description: 'GreasyFork 脚本 id 或脚本 URL。' }
      },
      required: ['scriptId']
    },
    output: { schema: OUTPUT_SCHEMA, render: textRender },
    async execute(args, exec) {
      try {
        const id = extractScriptId(args?.scriptId)
        if (!id) return clean(failure('E_BAD_ARGUMENT', `无法解析脚本 id：${JSON.stringify(args?.scriptId)}`))
        const client = new GreasyForkClient({
          site: config.site,
          apiSite: config.apiSite,
          locale: config.locale,
          timeoutMs: config.timeoutMs,
          userAgent: config.userAgent,
          signal: exec?.signal
        })
        const script = await client.getScript(id)
        if (!script) return clean(failure('E_SCRIPT_NOT_FOUND', `GreasyFork 上不存在脚本 ${id}。`))
        const versions = await client.getVersions(id)
        const authors = Array.isArray(script.users) ? script.users.map((u) => u.name).filter(Boolean) : []
        return clean({
          ok: true,
          action: 'status',
          scriptId: script.id,
          name: script.name,
          version: script.version,
          url: script.url,
          description: script.description,
          namespace: script.namespace,
          license: script.license ?? null,
          authors,
          updatedAt: script.code_updated_at ?? null,
          versions: versions.slice(0, 10).map((v) => ({ version: v.version, createdAt: v.created_at })),
          text: [
            `#${script.id} ${script.name}`,
            `线上版本：${script.version}`,
            `页面：${script.url}`,
            authors.length ? `作者：${authors.join(', ')}` : null,
            versions.length ? `最近版本：${versions.slice(0, 5).map((v) => v.version).join(' ← ')}` : null
          ]
            .filter(Boolean)
            .join('\n')
        })
      } catch (error) {
        logger?.error?.('greasyfork_status failed: %s', error?.message ?? error)
        return clean(failureFromError(error))
      }
    }
  })

  // ── greasyfork_guide ──────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'greasyfork_guide',
    description:
      'GreasyFork 操作手册（插件内置）。**收到任何 GreasyFork 相关指令**（看我的脚本、更新脚本、查脚本资料、发布、改简介……）时，直接调用本插件的工具，不要用浏览器自动化去点页面。不确定用哪个工具、或者报错了，先读这里：greasyfork_guide（不带 topic 看总览，带 topic 看单章）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic: {
          type: 'string',
          description: `章节名，可选：${TOPICS.join(' / ')}。省略返回总览 + 目录。`
        }
      }
    },
    output: { schema: OUTPUT_SCHEMA, render: textRender },
    async execute(args) {
      const topic = String(args?.topic ?? '').trim()
      const text = renderGuide(topic)
      return clean({ ok: true, action: 'guide', topic: topic || 'overview', text })
    }
  })

  // ── greasyfork_list ───────────────────────────────────────────────────────
  ctx.tools.register({
    name: 'greasyfork_list',
    description:
      '列出 GreasyFork 脚本：scope=mine 看自己发布的（需要登录）、search 按关键词搜、popular 看热门、libraries 看库脚本。返回每条脚本的 id / 名称 / 链接；拿到 id 后用 greasyfork_status 看详情、用 greasyfork_push 发新版本。不要用浏览器去点页面。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: {
          type: 'string',
          enum: ['mine', 'search', 'popular', 'libraries'],
          description: '默认 mine（我的脚本）。'
        },
        query: { type: 'string', description: 'scope=search 时的关键词。' },
        page: { type: 'number', description: '页码，从 1 开始，默认 1。' },
        limit: { type: 'number', description: '最多返回多少条，默认 20，上限 100。' }
      }
    },
    output: { schema: OUTPUT_SCHEMA, render: textRender },
    async execute(args, exec) {
      try {
        const scope = String(args?.scope ?? 'mine')
        const page = Math.max(1, Number(args?.page ?? 1) || 1)
        const limit = Math.min(Math.max(Number(args?.limit ?? 20) || 20, 1), 100)
        // mine 要读个人主页 HTML，必须走浏览器通道（Cloudflare 拦 Node）
        const { client, viaBrowser } = await makeClient(exec, undefined, { ensureBrowser: scope === 'mine' })
        let userId = null
        let userName = null
        if (scope === 'mine') {
          const who = await client.whoami()
          if (who?.authenticated !== true) {
            return clean(
              failure('E_AUTH_EXPIRED', '当前凭证没通过登录校验，先在设置 → GreasyFork 重新采集一次。', {
                hint: '也可以调 greasyfork_auth action=verify 看具体状态。'
              })
            )
          }
          userId = who.userId ?? null
          userName = who.username ?? null
          if (!userId || !userName) {
            return clean(
              failure('E_AUTH_EXPIRED', '登录校验通过了，但没从页面里解析出账号 id / 用户名。', {
                hint: '稍后重试；或直接给 greasyfork_status 传 scriptId。'
              })
            )
          }
        }
        const path = listPath({ scope, query: args?.query, page, userId, userName })
        const res = await client.get(path, { follow: 5 })
        if (res.status !== 200) {
          return clean(failure('E_HTTP', `列表页返回 HTTP ${res.status}（${path}）。`))
        }
        const items = parseScriptLinks(res.text, { site: config.site }).slice(0, limit)
        const header = {
          mine: `我的脚本${userName ? `（${userName}）` : ''}`,
          search: `搜索「${args?.query ?? ''}」`,
          popular: '热门脚本',
          libraries: '库脚本'
        }[scope]
        return clean({
          ok: true,
          action: 'list',
          scope,
          page,
          count: items.length,
          viaBrowser,
          items,
          text: [
            `${header} · 第 ${page} 页 · ${items.length} 条`,
            ...items.map((item) => `#${item.id}  ${item.name}`),
            items.length === 0 ? '（没解析到脚本；页面结构可能变了，或这一页是空的）' : null
          ]
            .filter(Boolean)
            .join('\n')
        })
      } catch (error) {
        logger?.error?.('greasyfork_list failed: %s', error?.message ?? error)
        return clean(failureFromError(error))
      }
    }
  })

  // 设置页的宿主半边：必须等 webServer 服务就绪再注册路由。
  // （直接 ctx.get('webServer') 在 apply 时机常常还是 undefined，路由会静默不挂载 ——
  //   这就是 1.1.0 面板显示 "not found" 的根因。）
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => {
        const dispose = installSettingsRoutes(scoped, config, { credentials, logger, manager, dshHome })
        if (typeof scoped.effect === 'function') scoped.effect(() => dispose, 'greasyfork: settings routes')
      })
    } else {
      const dispose = installSettingsRoutes(ctx, config, { credentials, logger, manager, dshHome })
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'greasyfork: settings routes')
    }
  } catch (error) {
    logger?.warn?.('greasyfork: 设置页路由挂载失败（%s）', error?.message ?? error)
  }

  logger?.info?.('greasyfork 插件已就绪（site=%s, locale=%s）', config.site, config.locale)
}

export default { name, inject, apply }
