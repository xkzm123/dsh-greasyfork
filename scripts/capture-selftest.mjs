#!/usr/bin/env node
/**
 * 浏览器自动获取凭证 —— 本机自测。
 *
 * 在**普通终端**里运行（不受会话沙箱限制），验证这条链路：
 *   1. 找到你的**系统默认浏览器**（Windows 读注册表；不是 Chromium 系就退到 Edge/Chrome）
 *   2. 用固定 profile 开一个调试端口，打开 greasyfork.org 登录页
 *   3. 轮询读 cookie，并且**每一轮都真的校验登录状态**（GreasyFork 对匿名访客也会发
 *      一个 _greasyfork_session，所以"读到 session"不等于"已登录"）
 *   4. 登录通过后打印结果并关掉浏览器
 *
 * 用法：
 *   node scripts/capture-selftest.mjs                # 默认 300 秒
 *   node scripts/capture-selftest.mjs --timeout 120
 *   node scripts/capture-selftest.mjs --keep         # 成功/失败都不关浏览器
 */

import process from 'node:process'
import {
  captureCookieViaBrowser,
  captureProfileDir,
  pickPort,
  resolveBrowser
} from '../lib/core/browser.js'
import { GreasyForkClient } from '../lib/core/client.js'
import { resolveDshHome } from '../lib/core/credentials.js'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = process.argv[i + 1]
  return value && !value.startsWith('--') ? value : true
}

const keep = arg('keep', false) === true
const timeoutSec = Number(arg('timeout', 300))
const dshHome = resolveDshHome()

const resolved = await resolveBrowser()
if (!resolved.browser) {
  console.error('✗ 没找到 Chrome / Edge / Chromium。装一个，或改用设置页的「手动填入」。')
  process.exit(1)
}

const port = await pickPort(9339)
const profile = captureProfileDir(dshHome, resolved.browser.id)

console.log(`默认浏览器：${resolved.defaultId ?? '(未知)'}${resolved.isDefault ? ' ✓ 与系统设置一致' : '（不是 Chromium 系，退到可用浏览器）'}`)
console.log(`将使用：${resolved.browser.name}`)
console.log(`可执行：${resolved.browser.path}`)
console.log(`调试端口：${port}`)
console.log(`专用 profile：${profile}`)
console.log(`\n即将打开登录页。请在弹出的窗口里登录 greasyfork.org（${timeoutSec} 秒内）。`)
console.log('注意：没登录时 GreasyFork 也会发一个匿名 session，所以下面会显示"检测到会话但未登录"，别被它误导。\n')

const phases = new Set()
const started = Date.now()
const result = await captureCookieViaBrowser({
  dshHome,
  site: 'https://greasyfork.org',
  domain: 'greasyfork.org',
  port,
  timeoutMs: timeoutSec * 1000,
  intervalMs: 1200,
  verify: async (cookie) => {
    const client = new GreasyForkClient({ cookie, timeoutMs: 20000 })
    return client.whoami()
  },
  onPhase: (info) => {
    if (!phases.has(info.phase)) {
      phases.add(info.phase)
      console.log(`  · ${info.phase}`)
    }
  },
  closeFn: keep ? async () => {} : undefined
})

if (result.ok) {
  const header = result.cookie || ''
  const names = header
    .split(';')
    .map((p) => p.trim().split('=')[0])
    .filter(Boolean)
  console.log(`\n✓ ${((Date.now() - started) / 1000).toFixed(1)} 秒后完成，**登录校验通过**`)
  console.log(`  账号：${result.username ?? '(未知)'}`)
  console.log(`  cookie 名：${names.join(', ')}`)
  console.log(`  长度：${header.length}（不打印值）`)
  console.log('\n设置页里点同一个按钮即可，效果一样。')
} else {
  console.error(`\n✗ 失败（${result.reason}）：${result.message}`)
  if (result.reason === 'launch-failed') {
    console.error('  提示：如果提示 EPERM / 拒绝访问，说明当前终端被沙箱限制，换普通终端再试。')
  }
  if (result.sawAnonymous) {
    console.error('  说明：浏览器确实打开了，也拿到了匿名 session，只是没检测到登录。')
  }
  process.exit(1)
}
