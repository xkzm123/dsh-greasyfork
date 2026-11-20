/**
 * 汇总入口：`node --test --test-isolation=none test/all.test.js`
 * 逐个 import 各测试文件（node:test 会在进程退出时统一汇报）。
 * 这样在受限环境（子进程 spawn 被禁止）里也能跑全量测试。
 */

import './version.test.js'
import './meta.test.js'
import './credentials.test.js'
import './publish.test.js'
import './plugin.test.js'
import './settings.test.js'
import './client.test.js'
import './browser.test.js'
