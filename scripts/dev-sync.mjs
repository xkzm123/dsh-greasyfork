#!/usr/bin/env node
/**
 * 把工作区的插件代码同步到"真正被 dsh 加载"的目录。
 *
 * 为什么要这一步：dsh 加载的是 profile 里的副本
 *   ~/.dsh/profiles/<profile>/node_modules/dsh-greasyfork
 * 改工作区不会生效，必须同步过去。
 *
 * 用法：
 *   node scripts/dev-sync.mjs                 # 同步一次
 *   node scripts/dev-sync.mjs --watch         # 监听 lib/ 变化，自动同步
 *   node scripts/dev-sync.mjs --profile desktop
 *
 * 同步之后还需要两步才生效：
 *   1) 宿主代码（lib/index.js、lib/settings.js）：在 dsh 里把 greasyfork 插件关一次再开
 *      （设置 → 插件市场/已安装，或调用 plugin_manager set_plugin enabled=false/true）
 *   2) 客户端代码（lib/client.js）：刷新页面（Ctrl+R）
 */

import { cp, readdir, rm, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const here = dirname(fileURLToPath(import.meta.url))
const packageDir = resolve(here, '..')
const PACKAGE_NAME = 'dsh-greasyfork'
const COPY_ENTRIES = ['lib', 'scripts', 'examples', 'package.json', 'cordis.patch.yml', 'LICENSE']
const STALE_ENTRIES = ['README.md', 'README.zh.md']

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = process.argv[i + 1]
  return value && !value.startsWith('--') ? value : true
}

const dshHome = process.env.DSH_HOME || join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
const onlyProfile = arg('profile', null)
const watchMode = arg('watch', false) === true

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 找到所有 profile 里已安装的插件副本。 */
async function findTargets() {
  const profilesDir = join(dshHome, 'profiles')
  let names = []
  try {
    names = await readdir(profilesDir)
  } catch {
    return []
  }
  const targets = []
  for (const name of names) {
    if (onlyProfile && name !== onlyProfile) continue
    const target = join(profilesDir, name, 'node_modules', PACKAGE_NAME)
    if (await exists(join(target, 'package.json'))) targets.push({ profile: name, target })
  }
  return targets
}

/** 覆盖式同步：先删再拷，避免 pnpm 硬链接把内容写回全局 store。 */
async function syncOne({ profile, target }) {
  for (const entry of STALE_ENTRIES) await rm(join(target, entry), { force: true })
  for (const entry of COPY_ENTRIES) {
    const from = join(packageDir, entry)
    if (!(await exists(from))) continue
    const to = join(target, entry)
    await rm(to, { recursive: true, force: true })
    await cp(from, to, { recursive: true })
  }
  return profile
}

async function syncAll(reason) {
  const targets = await findTargets()
  if (targets.length === 0) {
    console.error(`没找到已安装的 ${PACKAGE_NAME}。先装一次：node scripts/install.mjs --profile desktop`)
    return []
  }
  const done = []
  for (const item of targets) done.push(await syncOne(item))
  const stamp = new Date().toLocaleTimeString()
  console.log(`[${stamp}] 已同步到 profile：${done.join(', ')}${reason ? `（${reason}）` : ''}`)
  return done
}

const done = await syncAll()
if (done.length === 0) process.exit(1)

if (!watchMode) {
  console.log('')
  console.log('下一步（两步都要）：')
  console.log('  1) 宿主代码：在 dsh 里把 greasyfork 插件关一次再开（设置 → 插件；或 plugin_manager set_plugin）')
  console.log('  2) 客户端代码：刷新页面（Ctrl+R）')
  process.exit(0)
}

console.log('监听中：改 lib/ 下的文件会自动同步（Ctrl+C 退出）')
let timer = null
watch(join(packageDir, 'lib'), { recursive: true }, (_event, filename) => {
  if (filename && !/\.(js|mjs|json|yml|yaml|css)$/.test(String(filename))) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    syncAll(String(filename)).catch((error) => console.error('同步失败：', error?.message ?? error))
  }, 250)
})
