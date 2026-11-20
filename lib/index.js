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
  redactCookie,
  resolveCredential,
  saveCredential
} from './core/credentials.js'
import { GreasyForkError, failure, failureFromError } from './core/errors.js'
import { extractScriptId } from './core/meta.js'
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
  mirrorCredentialToStore: false
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

  /** 按当前凭证建一个客户端。 */
  const makeClient = async (exec, cookieOverride) => {
    const resolved = await resolveCredential({
      credentials,
      env: process.env,
      override: cookieOverride
    })
    if (!resolved) {
      throw new GreasyForkError('E_NO_CREDENTIAL', '还没有配置 GreasyFork 凭证。')
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
    return { client, resolved }
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
          if (!who.authenticated) {
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
            username: who.username,
            userId: who.userId,
            storage: saved.file,
            cookie: redactCookie(cookie),
            text: [
              `凭证已保存到 ${saved.file}（权限 0600）。账号：${who.username ?? '(未知)'}。`,
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
        const who = await client.whoami().catch((err) => ({ authenticated: false, error: err }))
        return clean({
          ok: who.authenticated !== false,
          action,
          configured: true,
          valid: who.authenticated === true,
          source: resolved.source,
          username: who.username ?? resolved.username ?? null,
          userId: who.userId ?? null,
          cookie: redactCookie(resolved.cookie),
          storage: credentialFilePath(process.env),
          text: who.authenticated
            ? `凭证有效（来源：${resolved.source}，账号：${who.username ?? '未知'}）。`
            : `凭证已存在（来源：${resolved.source}），但登录校验没通过，可能已过期。请重新登录后更新 Cookie。`
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
        const { client, resolved } = await makeClient(exec, args?.cookie)
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

        const result = await executePublish({
          plan,
          client,
          options: {
            dryRun: args?.dryRun === true,
            mode: args?.mode ?? 'auto',
            changelog: args?.changelog,
            acceptWarnings: args?.acceptWarnings === true,
            overrides: args?.overrides,
            syncIdentifier: args?.syncIdentifier,
            syncType: args?.syncType,
            localeId: args?.localeId
          }
        })
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

  // 设置页的宿主半边：必须等 webServer 服务就绪再注册路由。
  // （直接 ctx.get('webServer') 在 apply 时机常常还是 undefined，路由会静默不挂载 ——
  //   这就是 1.1.0 面板显示 "not found" 的根因。）
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (scoped) => {
        const dispose = installSettingsRoutes(scoped, config, { credentials, logger })
        if (typeof scoped.effect === 'function') scoped.effect(() => dispose, 'greasyfork: settings routes')
      })
    } else {
      const dispose = installSettingsRoutes(ctx, config, { credentials, logger })
      if (typeof ctx.effect === 'function') ctx.effect(() => dispose, 'greasyfork: settings routes')
    }
  } catch (error) {
    logger?.warn?.('greasyfork: 设置页路由挂载失败（%s）', error?.message ?? error)
  }

  logger?.info?.('greasyfork 插件已就绪（site=%s, locale=%s）', config.site, config.locale)
}

export default { name, inject, apply }
