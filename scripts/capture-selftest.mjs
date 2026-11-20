#!/usr/bin/env node
/**
 * 浏览器自动获取凭证 —— 本机自测。
 *
 * 用途：在**普通终端**（不是被沙箱限制的会话）里验证"不用油猴脚本拿 HttpOnly Cookie"
 * 这条链路在你这台机器上是否可用。
 *
 * 它会：
 *   1. 找到 Edge / Chrome
 *   2. 用固定 profile（~/.dsh/greasyfork/browser-profile）开一个调试端口启动浏览器
 *   3. 打开 greasyfork.org 登录页
 *   4. 轮询读取 cookie，打印每个 cookie 的名字 / 是否 HttpOnly / 长度
 *   5. 找到 _greasyfork_session 后把浏览器关掉
 *
 * 用法：
 *   node scripts/capture-selftest.mjs            # 等你在弹出的窗口里登录
 *   node scripts/capture-selftest.mjs --timeout 60
 *   node scripts/capture-selftest.mjs --keep     # 不自动关浏览器
 */

import process from 'node:process'
import {
  captureCookieViaBrowser,
  captureProfileDir,
  findBrowser,
  pickPort
} from '../lib/core/browser.js'
import { resolveDshHome } from '../lib/core/credentials.js'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = process.argv[i + 1]
  return value && !value.startsWith('--') ? value : true
}

const keep = arg('keep', false) === true
const timeoutSec = Number(arg('timeout', 300))

const browser = await findBrowser()
if (!browser) {
  console.error('✗ 没找到 Chrome / Edge / Chromium。装一个，或改用设置页的「手动填入」。')
  process.exit(1)
}
const port = await pickPort(9339)
const profile = captureProfileDir(resolveDshHome())

console.log(`浏览器：${browser.name}`)
console.log(`可执行：${browser.path}`)
console.log(`调试端口：${port}`)
console.log(`专用 profile：${profile}`)
console.log(`\n即将打开登录页。请在窗口里登录 greasyfork.org（${timeoutSec} 秒内）。\n`)

const started = Date.now()
const result = await captureCookieViaBrowser({
  dshHome: resolveDshHome(),
  site: 'https://greasyfork.org',
  domain: 'greasyfork.org',
  port,
  timeoutMs: timeoutSec * 1000,
  intervalMs: 1200,
  closeFn: keep ? async () => {} : undefined
})

if (result.ok) {
  const header = result.cookie || ''
  const names = header
    .split(';')
    .map((p) => p.trim().split('=')[0])
    .filter(Boolean)
  console.log(`✓ ${((Date.now() - started) / 1000).toFixed(1)} 秒后拿到 Cookie`)
  console.log(`  cookie 名：${names.join(', ')}`)
  console.log(`  有 _greasyfork_session：${names.includes('_greasyfork_session') ? '是' : '否'}`)
  console.log(`  长度：${header.length}`)
  console.log('\n把这段交给插件即可（或直接在设置页点「打开浏览器登录并自动获取」）：')
  console.log(`  ${header.slice(0, 40)}…（已省略，请勿贴到聊天里）`)
  console.log('\n说明：这个脚本只打印长度与名字，不打印值。')
} else {
  console.error(`✗ 失败（${result.reason}）：${result.message}`)
  console.error(`  浏览器：${result.browser ?? '-'}`)
  console.error(`  profile：${result.profile ?? profile}`)
  if (result.reason === 'launch-failed') {
    console.error('  提示：如果提示 EPERM / 拒绝访问，说明当前终端被沙箱限制，换一个普通终端再试。')
  }
  process.exit(1)
}
