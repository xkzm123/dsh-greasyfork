#!/usr/bin/env node
/**
 * dsh-greasyfork CLI —— 与插件共用同一套核心逻辑。
 *
 * 用途：
 *   1) 一次性配置凭证（推荐：不把 Cookie 写进对话记录）
 *   2) 在 CI / 终端里直接发布，不经过模型
 *
 * 所有命令都支持 --json。
 */

import { readFile } from 'node:fs/promises'
import process from 'node:process'
import { GreasyForkClient, DEFAULT_API_SITE, DEFAULT_SITE } from './core/client.js'
import {
  CREDENTIAL_ENV,
  clearCredentialFile,
  credentialFilePath,
  normalizeCookieInput,
  redactCookie,
  resolveCredential,
  saveCredential
} from './core/credentials.js'
import { failureFromError } from './core/errors.js'
import { executePublish, preparePublish, renderPlan, runSync } from './core/publish.js'

const USAGE = `dsh-greasyfork — GreasyFork 发布工具

用法:
  dsh-greasyfork auth status                 查看凭证是否已配置
  dsh-greasyfork auth set [--stdin|--cookie <s>|--cookie-file <f>] [--no-verify]
  dsh-greasyfork auth verify                 验证当前凭证
  dsh-greasyfork auth clear                  删除本地凭证
  dsh-greasyfork status --script-id <id|url>
  dsh-greasyfork preflight --file <path> [--script-id <id>] [--json]
  dsh-greasyfork push --file <path> [--script-id <id>] [--changelog "…"]
                      [--dry-run] [--accept-warnings] [--force]
                      [--mode auto|create|update|prefill|sync]
                      [--sync-identifier <url>] [--script-type public|unlisted|library]

全局选项:
  --site <url>        默认 https://greasyfork.org
  --locale <code>     默认 en
  --json              以 JSON 输出
  --help              显示帮助

凭证来源优先级: --cookie > 环境变量 ${CREDENTIAL_ENV} > harness 凭证服务 > ${credentialFilePath()}
`

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const eq = arg.indexOf('=')
    const key = (eq === -1 ? arg.slice(2) : arg.slice(2, eq)).trim()
    if (eq !== -1) {
      out[key] = arg.slice(eq + 1)
      continue
    }
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
    } else {
      out[key] = next
      i += 1
    }
  }
  return out
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function makeClient(args, cookie) {
  return new GreasyForkClient({
    site: args.site || DEFAULT_SITE,
    apiSite: args['api-site'] || DEFAULT_API_SITE,
    locale: args.locale || 'en',
    timeoutMs: Number(args['timeout-ms'] || 30000),
    cookie
  })
}

function print(result, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return
  }
  process.stdout.write(`${result?.text ?? JSON.stringify(result, null, 2)}\n`)
}

async function cmdAuth(args) {
  const sub = args._[1] ?? 'status'
  if (sub === 'set') {
    let cookie = args.cookie ? String(args.cookie) : ''
    if (!cookie && args['cookie-file']) cookie = await readFile(String(args['cookie-file']), 'utf8')
    if (!cookie && args.stdin) {
      process.stderr.write('粘贴 greasyfork.org 的 Cookie 后按 Ctrl+Z 回车（Windows）/ Ctrl+D（macOS/Linux）：\n')
      cookie = await readStdin()
    }
    if (!cookie) {
      process.stderr.write('缺少 Cookie：用 --stdin、--cookie 或 --cookie-file 提供。\n')
      return 2
    }
    cookie = normalizeCookieInput(cookie)
    if (args['no-verify'] !== true) {
      const who = await makeClient(args, cookie).whoami()
      if (!who.authenticated) {
        process.stderr.write('Cookie 未通过登录校验，未保存。请确认复制的是已登录状态下的完整 Cookie。\n')
        return 1
      }
      const saved = await saveCredential({ cookie, username: who.username, userId: who.userId, site: args.site || DEFAULT_SITE })
      const result = {
        ok: true,
        status: 'saved',
        storage: saved.file,
        username: who.username,
        cookie: redactCookie(cookie),
        text: `凭证已保存到 ${saved.file}（0600）。账号：${who.username ?? '(未知)'}。`
      }
      print(result, args.json)
      return 0
    }
    const saved = await saveCredential({ cookie, site: args.site || DEFAULT_SITE })
    print({ ok: true, status: 'saved', storage: saved.file, text: `凭证已保存到 ${saved.file}（未做登录校验）。` }, args.json)
    return 0
  }

  if (sub === 'clear') {
    const file = await clearCredentialFile()
    print({ ok: true, status: 'cleared', storage: file, text: `已删除 ${file}。` }, args.json)
    return 0
  }

  const resolved = await resolveCredential({ env: process.env, override: args.cookie })
  if (!resolved) {
    const result = {
      ok: true,
      configured: false,
      storage: credentialFilePath(),
      text: `尚未配置凭证。\n运行: node lib/cli.js auth set --stdin\n存储位置: ${credentialFilePath()}`
    }
    print(result, args.json)
    return sub === 'verify' ? 1 : 0
  }
  if (sub === 'status' && args['no-verify'] === true) {
    print(
      {
        ok: true,
        configured: true,
        source: resolved.source,
        storage: credentialFilePath(),
        cookie: redactCookie(resolved.cookie),
        text: `已配置（来源：${resolved.source}）。`
      },
      args.json
    )
    return 0
  }
  const who = await makeClient(args, resolved.cookie).whoami()
  const result = {
    ok: who.authenticated === true,
    configured: true,
    valid: who.authenticated === true,
    source: resolved.source,
    username: who.username ?? null,
    userId: who.userId ?? null,
    cookie: redactCookie(resolved.cookie),
    storage: credentialFilePath(),
    text: who.authenticated
      ? `凭证有效（来源：${resolved.source}，账号：${who.username ?? '未知'}）。`
      : `凭证存在但已失效（来源：${resolved.source}），请重新登录后更新。`
  }
  print(result, args.json)
  return result.ok ? 0 : 1
}

async function cmdStatus(args) {
  const id = args['script-id'] || args.scriptId
  if (!id) {
    process.stderr.write('缺少 --script-id\n')
    return 2
  }
  const client = makeClient(args)
  const { extractScriptId } = await import('./core/meta.js')
  const scriptId = extractScriptId(id)
  const script = await client.getScript(scriptId)
  if (!script) {
    print({ ok: false, code: 'E_SCRIPT_NOT_FOUND', message: `脚本 ${scriptId} 不存在。` }, args.json)
    return 1
  }
  const versions = await client.getVersions(scriptId)
  print(
    {
      ok: true,
      scriptId: script.id,
      name: script.name,
      version: script.version,
      url: script.url,
      description: script.description,
      versions: versions.slice(0, 10).map((v) => ({ version: v.version, createdAt: v.created_at })),
      text: [
        `#${script.id} ${script.name}`,
        `线上版本：${script.version}`,
        `页面：${script.url}`,
        versions.length ? `最近版本：${versions.slice(0, 5).map((v) => v.version).join(' ← ')}` : null
      ]
        .filter(Boolean)
        .join('\n')
    },
    args.json
  )
  return 0
}

async function cmdPreflight(args) {
  const resolved = await resolveCredential({ env: process.env, override: args.cookie })
  const client = makeClient(args, resolved?.cookie ?? '')
  const plan = await preparePublish({
    source: { file: args.file, code: args.code },
    scriptId: args['script-id'],
    options: {
      language: args.language,
      scriptType: args['script-type'],
      defaultScriptType: 'public',
      changelog: args.changelog
    },
    client,
    cwd: process.cwd()
  })
  print(
    {
      ok: plan.ok,
      ready: plan.ok,
      summary: plan.summary,
      errors: plan.errors,
      warnings: plan.warnings,
      text: `${renderPlan(plan)}\n\n${plan.ok ? '预检通过，可以发布。' : '预检未通过：先修掉阻塞项再发布。'}`
    },
    args.json
  )
  return plan.ok ? 0 : 1
}

async function cmdPush(args) {
  const resolved = await resolveCredential({ env: process.env, override: args.cookie })
  if (!resolved) {
    process.stderr.write(`缺少凭证。先运行: node lib/cli.js auth set --stdin\n或设置环境变量 ${CREDENTIAL_ENV}\n`)
    return 2
  }
  const client = makeClient(args, resolved.cookie)
  const plan = await preparePublish({
    source: { file: args.file, code: args.code },
    scriptId: args['script-id'],
    options: {
      language: args.language,
      scriptType: args['script-type'],
      defaultScriptType: 'public',
      changelog: args.changelog,
      force: args.force === true
    },
    client,
    cwd: process.cwd()
  })

  if (args.mode === 'sync') {
    const result = await runSync({
      client,
      scriptId: plan.scriptId,
      syncIdentifier: args['sync-identifier'],
      syncType: args['sync-type'] ?? 'manual'
    })
    print(result, args.json)
    return result.ok ? 0 : 1
  }

  const result = await executePublish({
    plan,
    client,
    options: {
      dryRun: args['dry-run'] === true,
      mode: args.mode ?? 'auto',
      changelog: args.changelog,
      acceptWarnings: args['accept-warnings'] === true,
      force: args.force === true,
      syncIdentifier: args['sync-identifier'],
      syncType: args['sync-type']
    }
  })
  print(result, args.json)
  return result.ok ? 0 : 1
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help || args._.length === 0) {
    process.stdout.write(USAGE)
    return args._.length === 0 ? 2 : 0
  }
  const command = args._[0]
  try {
    switch (command) {
      case 'auth':
        return await cmdAuth(args)
      case 'status':
        return await cmdStatus(args)
      case 'preflight':
        return await cmdPreflight(args)
      case 'push':
        return await cmdPush(args)
      default:
        process.stderr.write(`未知命令: ${command}\n\n${USAGE}`)
        return 2
    }
  } catch (error) {
    const failure = failureFromError(error)
    print(failure, args.json)
    return 1
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  }
)
