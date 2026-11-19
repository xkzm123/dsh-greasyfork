import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appearsMinified,
  extractScriptId,
  findMetaBlock,
  normalizeCode,
  parseMeta,
  validateSource
} from '../lib/core/meta.js'

const GOOD = `// ==UserScript==
// @name         Demo Script
// @namespace    https://example.com/demo
// @version      1.0.0
// @description  A demo userscript for tests
// @match        https://example.com/*
// @license      MIT
// ==/UserScript==

(function () {
  console.log('hello')
})()
`

test('normalizeCode 去 BOM 并统一换行', () => {
  assert.equal(normalizeCode('\uFEFFa\r\nb\rc'), 'a\nb\nc')
})

test('parseMeta 解析基本字段与本地化名称', () => {
  const code = GOOD.replace('// @name         Demo Script', '// @name         Demo Script\n// @name:zh-CN   演示脚本')
  const meta = parseMeta(code)
  assert.equal(meta.hasMetaBlock, true)
  assert.equal(meta.name, 'Demo Script')
  assert.equal(meta.localizedNames['zh-CN'], '演示脚本')
  assert.equal(meta.version, '1.0.0')
  assert.equal(meta.namespace, 'https://example.com/demo')
  assert.deepEqual(meta.match, ['https://example.com/*'])
  assert.equal(meta.license, 'MIT')
  assert.ok(findMetaBlock(code))
})

test('parseMeta 对 `//@key` 缺空格不识别（与站点一致）', () => {
  const code = GOOD.replace('// @version      1.0.0', '//@version 1.0.0')
  const meta = parseMeta(code)
  assert.equal(meta.version, null)
})

test('validateSource：合格脚本零错误', () => {
  const result = validateSource({ code: GOOD })
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
  assert.equal(result.meta.name, 'Demo Script')
})

test('validateSource：缺 @name / @description / @match 都报错', () => {
  const code = `// ==UserScript==
// @version 1.0.0
// ==/UserScript==
console.log('x')
`
  const result = validateSource({ code })
  const codes = result.errors.map((e) => e.code)
  assert.ok(codes.includes('E_MISSING_NAME'))
  assert.ok(codes.includes('E_MISSING_DESCRIPTION'))
  assert.ok(codes.includes('E_MISSING_MATCH'))
  assert.equal(result.ok, false)
})

test('validateSource：library 类型豁免描述与匹配规则', () => {
  const code = `// ==UserScript==
// @name  Lib
// @version 1.0.0
// @namespace https://example.com/lib
// ==/UserScript==
function helper() { return 1 }
`
  const result = validateSource({ code, scriptType: 'library' })
  const codes = result.errors.map((e) => e.code)
  assert.ok(!codes.includes('E_MISSING_DESCRIPTION'))
  assert.ok(!codes.includes('E_MISSING_MATCH'))
  assert.equal(result.ok, true)
})

test('validateSource：过短、无元数据块、非法指令', () => {
  const tiny = validateSource({ code: 'abc' })
  assert.ok(tiny.errors.some((e) => e.code === 'E_NO_META'))
  assert.ok(tiny.errors.some((e) => e.code === 'E_CODE_TOO_SHORT'))

  const noMeta = validateSource({ code: 'console.log(1); console.log(2);' })
  assert.ok(noMeta.errors.some((e) => e.code === 'E_NO_META'))

  const invalid = validateSource({ code: GOOD.replace('// @version      1.0.0', '//@version 1.0.0') })
  assert.ok(invalid.errors.some((e) => e.code === 'E_INVALID_META_DIRECTIVE'))
})

test('validateSource：告警项带 override 名', () => {
  const code = `// ==UserScript==
// @name Demo
// @description d
// @match https://example.com/*
// ==/UserScript==
console.log('x')
`
  const result = validateSource({ code })
  const byCode = Object.fromEntries(result.warnings.map((w) => [w.code, w]))
  assert.equal(byCode.version_missing.override, 'add_missing_version')
  assert.equal(byCode.namespace_missing.override, 'add_missing_namespace')
  assert.equal(byCode.license_missing.override, 'license_missing_override')
})

test('validateSource：与线上版本比对给出 version_not_incremented', () => {
  const remote = { version: '1.0.0', name: 'Demo Script', namespace: 'https://example.com/demo', code: GOOD.replace('hello', 'bye') }
  const result = validateSource({ code: GOOD, creating: false, remote })
  const codes = result.warnings.map((w) => w.code)
  assert.ok(codes.includes('version_not_incremented'))
  assert.equal(result.stats.codeChanged, true)

  const bumped = validateSource({ code: GOOD.replace('1.0.0', '1.0.1'), creating: false, remote })
  assert.ok(!bumped.warnings.some((w) => w.code === 'version_not_incremented'))
})

test('validateSource：namespace 变更给告警', () => {
  const remote = { version: '0.9.0', namespace: 'https://other.example/ns', code: 'x' }
  const result = validateSource({ code: GOOD, creating: false, remote })
  assert.ok(result.warnings.some((w) => w.code === 'namespace_changed' && w.override === 'namespace_check_override'))
})

test('appearsMinified 只对超长单行生效', () => {
  assert.equal(appearsMinified(GOOD), false)
  const minified = `// ==UserScript==\n// @name x\n// ==/UserScript==\n${'function a(){return 1}'.repeat(400)}`
  assert.equal(appearsMinified(minified), true)
})

test('extractScriptId 支持 id 与 URL', () => {
  assert.equal(extractScriptId(123), 123)
  assert.equal(extractScriptId('123'), 123)
  assert.equal(extractScriptId('https://greasyfork.org/zh-CN/scripts/456789-name'), 456789)
  assert.equal(extractScriptId('nope'), null)
  assert.equal(extractScriptId(null), null)
})
