#!/usr/bin/env node
/**
 * 把 dsh-greasyfork 安装进某个 dsh profile。
 *
 * 做的事（等价于 dsh plugin add，但对 desktop profile 也适用）：
 *   1. profile 的 package.json 里加依赖 "dsh-greasyfork": "file:<本包绝对路径>"
 *   2. 把 "dsh-greasyfork" 加进 dsh.profile.bundles（它自带 cordis.patch.yml，
 *      会被当成一个 bundle 层插入）
 *   3. 在该 profile 目录里跑 pnpm install（可用 --no-install 跳过）
 *
 * 用法：
 *   node scripts/install.mjs                       # 装进 web profile
 *   node scripts/install.mjs --profile desktop     # 装进桌面版 profile
 *   node scripts/install.mjs --dry-run             # 只打印将要做的事
 *   node scripts/install.mjs --uninstall
 */

import { spawnSync } from 'node:child_process'
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const PACKAGE_NAME = 'dsh-greasyfork'
const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) args[key] = true
    else {
      args[key] = next
      i += 1
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const dshHome = args.home || process.env.DSH_HOME || join(homedir(), '.dsh')
const profileName = args.profile || 'web'
const profileDir = join(dshHome, 'profiles', profileName)
const manifestPath = join(profileDir, 'package.json')
const dryRun = args['dry-run'] === true
const uninstall = args.uninstall === true
const skipInstall = args['no-install'] === true

function log(message) {
  process.stdout.write(`${message}\n`)
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  if (!(await exists(manifestPath))) {
    process.stderr.write(
      `找不到 profile：${profileDir}\n` +
        `先让 dsh 初始化这个 profile（例如运行一次 \`dsh --profile ${profileName}\`），或用 --profile 指定已有 profile。\n`
    )
    return 2
  }

  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies = manifest.dependencies ?? {}
  manifest.dsh = manifest.dsh ?? {}
  manifest.dsh.profile = manifest.dsh.profile ?? {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []

  if (uninstall) {
    delete manifest.dependencies[PACKAGE_NAME]
    manifest.dsh.profile.bundles = bundles.filter((b) => b !== PACKAGE_NAME)
    log(`将从 ${manifestPath} 移除 ${PACKAGE_NAME}`)
    if (!dryRun) {
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await rm(join(profileDir, 'node_modules', PACKAGE_NAME), { recursive: true, force: true })
    }
    log('完成。重启 dsh / 桌面应用后生效。')
    return 0
  }

  const spec = `file:${packageDir.replace(/\\/g, '/')}`
  const changedDependency = manifest.dependencies[PACKAGE_NAME] !== spec
  manifest.dependencies[PACKAGE_NAME] = spec
  if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
  manifest.dsh.profile.bundles = bundles

  log(`profile:   ${profileName}  (${profileDir})`)
  log(`依赖:      ${PACKAGE_NAME} → ${spec}${changedDependency ? '  [新增/更新]' : '  [已是最新]'}`)
  log(`bundles:   ${bundles.join(' → ')}`)

  if (dryRun) {
    log('\n--dry-run：不写入任何文件，也不安装依赖。')
    return 0
  }

  await mkdir(profileDir, { recursive: true })
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  if (skipInstall) {
    log('\n已写入 package.json。请手动在该 profile 目录运行：pnpm install')
    return 0
  }

  if (args.copy === true) {
    const target = await copyIntoProfile(profileDir)
    log(`\n已复制到 ${target}（--copy 模式，未使用 pnpm）。`)
    printNextSteps(profileName)
    return 0
  }

  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
  log('\n运行 pnpm install …')
  const result = spawnSync(pnpm, ['install'], { cwd: profileDir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error || result.status !== 0) {
    process.stderr.write(
      `\npnpm 不可用或安装失败（${result.error?.code ?? `exit ${result.status}`}），改用直接复制到 profile 的 node_modules。\n`
    )
    const target = await copyIntoProfile(profileDir)
    log(`已复制到 ${target}。注意：以后在该 profile 里执行 pnpm install 可能会把它清掉，届时重跑本脚本即可。`)
    printNextSteps(profileName)
    return 0
  }

  const installed = join(profileDir, 'node_modules', PACKAGE_NAME, 'package.json')
  if (await exists(installed)) {
    log(`\n已安装：${installed}`)
  } else {
    log('\n注意：node_modules 里没找到该包，改用直接复制。')
    await copyIntoProfile(profileDir)
  }

  printNextSteps(profileName)
  return 0
}

/** 把包直接复制进 profile 的 node_modules（pnpm 不可用时的兜底）。 */
async function copyIntoProfile(dir) {
  const target = join(dir, 'node_modules', PACKAGE_NAME)
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const entry of ['lib', 'scripts', 'examples', 'cordis.patch.yml', 'package.json']) {
    const from = join(packageDir, entry)
    if (!(await exists(from))) continue
    await cp(from, join(target, entry), { recursive: true })
  }
  return target
}

function printNextSteps(name) {
  log(
    [
      '',
      '下一步：',
      `  1) 重启 dsh${name === 'desktop' ? '（桌面应用需要完全退出再启动）' : ` --profile ${name}`}`,
      '  2) 配置一次凭证：',
      `     node "${join(packageDir, 'lib', 'cli.js')}" auth set --stdin`,
      '  3) 在对话里让 AI 调 greasyfork_auth(action="status") 确认已生效，',
      '     之后就可以 greasyfork_push(file="…") 直接发布。'
    ].join('\n')
  )
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`)
    process.exitCode = 1
  }
)
