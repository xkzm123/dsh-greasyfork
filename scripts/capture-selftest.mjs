#!/usr/bin/env node
/**
 * 浏览器自动获取凭证 —— 本机自测。
 *
 * 在**普通终端**里运行（不受会话沙箱限制），验证这条链路：
 *   1. 识别你的**系统默认浏览器**（Windows 读注册表并解析真实 exe 路径；
 *      不是 Chromium 系就退到已装的 Chromium）
 *   2. 用专用 profile 启动一个受控实例（优先 `--remote-debugging-pipe` 管道，
 *      失败再退端口），在里面新开 greasyfork 登录标签页
 *   3. 轮询读 cookie，并且**每一轮都真的校验登录状态**（GreasyFork 对匿名访客也会发
 *      一个 _greasyfork_session，所以"读到 session"不等于"已登录"）
 *   4. 成功后打印结果；默认**保留**浏览器（下次只新开标签页），`--close` 才关
 *
 * 用法：
 *   node scripts/capture-selftest.mjs                # 默认 300 秒
 *   node scripts/capture-selftest.mjs --timeout 120
 *   node scripts/capture-selftest.mjs --close        # 结束后关掉浏览器
 *   node scripts/capture-selftest.mjs --detect       # 只看识别结果，不启动浏览器
 *   node scripts/capture-selftest.mjs --check        # 不等待：直接问浏览器"登录了吗"
 */

import process from 'node:process'
import { captureCookieViaBrowser, createBrowserManager, detectDefaultBrowser, resolveBrowser } from '../lib/core/browser.js'
import { GreasyForkClient } from '../lib/core/client.js'
import { resolveDshHome } from '../lib/core/credentials.js'

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = process.argv[i + 1]
  return value && !value.startsWith('--') ? value : true
}

const closeAfter = arg('close', false) === true
const checkOnly = arg('check', false) === true
const timeoutSec = Number(arg('timeout', 300))
const detectOnly = arg('detect', false) === true
const dshHome = resolveDshHome()

const detected = await detectDefaultBrowser()
console.log(`系统默认浏览器：${detected.name || '(识别不到)'}${detected.progId ? `（${detected.progId}）` : ''}`)
if (detected.path) console.log(`  真实路径：${detected.path}`)
if (detected.id && !detected.chromium) console.log('  注意：它不是 Chromium 内核，读 cookie 需要换一个浏览器')

const resolved = await resolveBrowser({ detected })
if (!resolved.browser) {
  console.error('✗ 没找到可用的 Chrome / Edge / Brave / Vivaldi。装一个，或改用设置页的「手动填入」。')
  process.exit(1)
}
console.log(`将使用：${resolved.browser.name}${resolved.isDefault ? ' ✓ 就是系统默认' : '（默认浏览器不可用，已退回）'}`)
console.log(`  可执行：${resolved.browser.path}`)
if (resolved.reason === 'not-chromium') console.log('  原因：默认浏览器不是 Chromium 内核，CDP 读不了 cookie')

if (detectOnly) process.exit(0)

const manager = createBrowserManager({ dshHome, site: 'https://greasyfork.org' })

// --check：不等待，直接问浏览器"你登录了吗"，并把 cookie 名打出来
if (checkOnly) {
  await manager.ensure()
  await manager.openTab()
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const who = await manager.verifyLogin()
  let cookies = []
  try {
    cookies = await manager.cookies('greasyfork.org')
  } catch (error) {
    console.error(`读 cookie 失败：${error?.message ?? error}`)
  }
  const session = cookies.find((c) => c.name === '_greasyfork_session')
  console.log('\n--- 诊断 ---')
  console.log(`浏览器内校验：${who.ok ? '已登录' : '未登录'}（HTTP ${who.status ?? '?'}${who.signIn ? '，被重定向到登录页' : ''}）`)
  if (who.username) console.log(`  账号：${who.username}`)
  if (who.error) console.log(`  错误：${who.error}`)
  console.log(`cookie 数：${cookies.length}；_greasyfork_session：${session ? '有（' + session.value.length + ' 字符）' : '没有'}`)
  console.log(`cookie 名：${cookies.map((c) => c.name).join(', ') || '(空)'}`)
  console.log('\n诊断日志：')
  for (const entry of manager.log()) console.log(`  ${new Date(entry.at).toLocaleTimeString()}  ${entry.text}`)
  if (closeAfter) await manager.close()
  process.exit(who.ok ? 0 : 2)
}

console.log(`专用 profile：${manager.status().profile ?? '(启动后确定)'}`)
console.log(`\n即将启动浏览器并新开登录标签页，请在里面登录 greasyfork.org（${timeoutSec} 秒内）。`)
console.log('注意：没登录时 GreasyFork 也会发一个匿名 session，所以会先看到"检测到会话但未登录"，别被它误导。\n')

const phases = new Set()
const started = Date.now()
const result = await captureCookieViaBrowser({
  dshHome,
  site: 'https://greasyfork.org',
  domain: 'greasyfork.org',
  manager,
  keepAlive: !closeAfter,
  timeoutMs: timeoutSec * 1000,
  intervalMs: 1200,
  verify: async (cookie) => {
    const client = new GreasyForkClient({ cookie, timeoutMs: 20000 })
    return client.whoami()
  },
  onPhase: (info) => {
    if (phases.has(info.phase)) return
    phases.add(info.phase)
    console.log(`  · ${info.phase}${info.mode ? `（${info.mode} 通道）` : ''}`)
  }
})

const log = result.log ?? manager.log()
if (log.length > 0) {
  console.log('\n诊断日志：')
  for (const entry of log) console.log(`  ${new Date(entry.at).toLocaleTimeString()}  ${entry.text}`)
}

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
  console.log(`  校验方式：${result.verifiedBy === 'browser' ? '浏览器内校验（Node 端被拦）' : 'Node 端 whoami'}`)
  console.log(closeAfter ? '\n浏览器已关闭。' : '\n浏览器保留着：下次采集只在它里面新开标签页（--close 可关掉）。')
} else {
  console.error(`\n✗ 失败（${result.reason}）：${result.message}`)
  if (result.reason === 'launch-failed') {
    console.error('  提示：EPERM / 拒绝访问 说明当前终端被沙箱限制，换普通终端再试。')
  }
  if (result.sawAnonymous) {
    console.error('  说明：浏览器确实打开了，也拿到了匿名 session，只是没检测到登录。')
  }
  await manager.close()
  process.exit(1)
}
