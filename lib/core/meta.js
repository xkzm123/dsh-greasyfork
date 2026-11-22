/**
 * 用户脚本元数据解析与本地预检。
 *
 * 解析规则逐条对齐 GreasyFork 的 `lib/js_parser.rb`：
 *  - 元数据块必须以 `// ==UserScript==` 开始、`// ==/UserScript==` 结束；
 *  - 每条是 `// @key value`（`//` 后必须有空白，`@key` 后必须有空白）；
 *  - `//@key value` 这种缺空格的写法会被站点判为 invalid meta directive；
 *  - `@name:zh-CN` 这类本地化键按原键保存。
 *
 * 校验规则对齐 `app/models/script_version.rb` 与 `app/models/script.rb`：
 * 错误（必然发布失败）与告警（站点会要求勾选 override 才放行）分开返回。
 */

/* ─────────────────────────────────────────────────────────────────────────────
 * 版本号比较（原 lib/core/version.js，1.4 起并入本文件）
 *
 * 逐行移植 GreasyFork 的 `ScriptVersion.split_version` / `compare_versions`
 * （app/models/script_version.rb）。意义：发布前就能算出站点会怎么比较版本，
 * 从而在本地拦下"版本号没递增"这类会被判为告警/冲突的情况。
 * ──────────────────────────────────────────────────────────────────────────── */

/** 把版本号切成 16 段（4 组 × 数字/字符串/数字/字符串）。 */
export function splitVersion(versionNumber) {
  const parts = String(versionNumber ?? '').split('.', 4)
  while (parts.length < 4) parts.push('0')
  const out = []
  for (const part of parts) {
    const match = /((?:-?[0-9]+)?)([^0-9-]*)((?:-?[0-9]+)?)(.*)/.exec(part)
    // Ruby 的 to_i 对 "" 返回 0；正则第 1/3 组可能为空
    out.push(
      match && match[1] !== '' ? Number.parseInt(match[1], 10) : 0,
      match ? match[2] : '',
      match && match[3] !== '' ? Number.parseInt(match[3], 10) : 0,
      match ? match[4] : ''
    )
  }
  return out
}

function cmpScalar(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1
  const sa = String(a)
  const sb = String(b)
  return sa === sb ? 0 : sa < sb ? -1 : 1
}

/**
 * GreasyFork 的版本比较。
 * @returns {number|null} 1 / 0 / -1；无法比较时 null。
 */
export function compareVersions(v1, v2) {
  if (v1 === undefined || v1 === null || v2 === undefined || v2 === null) return null
  if (String(v1).trim() === '' || String(v2).trim() === '') return null
  const a = splitVersion(v1)
  const b = splitVersion(v2)
  for (let i = 0; i < 16; i += 1) {
    // 奇数位是字符串：存在字符串的一段更小（1.6a < 1.6）
    if (i % 2 === 1) {
      if (a[i] === '' && b[i] !== '') return 1
      if (a[i] !== '' && b[i] === '') return -1
    }
    const r = cmpScalar(a[i], b[i])
    if (r !== 0) return r
  }
  return 0
}

/** 版本号是否"看起来合法"（不强制，GreasyFork 本身只做软校验）。 */
export function isVersionLike(value) {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (v === '' || v.length > 200) return false
  return /^[0-9A-Za-z][0-9A-Za-z.\-_+]*$/.test(v)
}

/**
 * 建议下一个版本号（同 GreasyFork 的自动生成规则：把最后一段数字 +1）。
 * @param {string} version
 * @returns {string}
 */
export function bumpVersion(version) {
  const a = splitVersion(version)
  for (const i of [0, 2, 4, 6, 8, 10, 12, 14]) if (a[i] === 0) a[i] = null
  if (a[13] === '' && a[14] == null) a[12] = a[12] == null ? 1 : a[12] + 1
  else a[14] = a[14] == null ? 1 : a[14] + 1
  const seg = (i) => (a[i] == null ? '' : String(a[i]))
  const p1 = seg(0) + seg(1) + seg(2) + seg(3)
  const p2 = seg(4) + seg(5) + seg(6) + seg(7)
  const p3 = seg(8) + seg(9) + seg(10) + seg(11)
  const p4 = seg(12) + seg(13) + seg(14) + seg(15)
  return [p1, p2, p3, p4].map((p) => (p === '' ? '0' : p)).join('.')
}

/* ───────────────────────────── 版本号比较结束 ───────────────────────────── */


export const META_START = '// ==UserScript=='
export const META_END = '// ==/UserScript=='

/** GreasyFork 的单版本代码上限（2 MB）。 */
export const MAX_CODE_BYTES = 2 * 1024 * 1024
/** 站点要求代码至少 20 字符。 */
export const MIN_CODE_LENGTH = 20
export const MAX_NAME_LENGTH = 100
export const MAX_DESCRIPTION_LENGTH = 500

/** 统一换行、去掉 BOM（GreasyFork 也会把 CRLF 归一化成 LF）。 */
export function normalizeCode(input) {
  let code = typeof input === 'string' ? input : String(input ?? '')
  if (code.charCodeAt(0) === 0xfeff) code = code.slice(1)
  return code.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** 找到元数据块的位置与原文；没有则返回 null。 */
export function findMetaBlock(code) {
  const start = code.indexOf(META_START)
  if (start === -1) return null
  const endStart = code.indexOf(META_END, start)
  if (endStart === -1) return null
  const end = endStart + META_END.length
  return { start, end, text: code.slice(start, end) }
}

/** 元数据块之前的代码与之后的代码（GreasyFork 用它判断"有没有可执行代码"）。 */
export function getCodeBlocks(code) {
  const block = findMetaBlock(code)
  if (!block) return [code, '']
  return [block.start === 0 ? '' : code.slice(0, block.start), code.slice(block.end)]
}

function collectLocalized(entries, base) {
  const out = {}
  for (const [key, values] of Object.entries(entries)) {
    if (!key.startsWith(`${base}:`)) continue
    const locale = key.slice(base.length + 1)
    if (values.length > 0) out[locale] = values[0]
  }
  return out
}

/**
 * 解析元数据。
 * @param {string} rawCode
 */
export function parseMeta(rawCode) {
  const code = normalizeCode(rawCode)
  const block = findMetaBlock(code)
  /** @type {Record<string, string[]>} */
  const entries = {}
  if (block) {
    for (const line of block.text.split('\n')) {
      const m = /^\s*\/\/\s+@([A-Za-z:-]+)\s+(.*)$/.exec(line)
      if (!m) continue
      const key = m[1]
      const value = m[2].trim()
      if (!entries[key]) entries[key] = []
      entries[key].push(value)
    }
  }
  const first = (key) => (entries[key] && entries[key].length > 0 ? entries[key][0] : null)
  return {
    hasMetaBlock: Boolean(block),
    block,
    entries,
    keys: Object.keys(entries),
    name: first('name'),
    description: first('description'),
    version: first('version'),
    namespace: first('namespace'),
    license: first('license'),
    author: first('author'),
    match: entries.match ?? [],
    include: entries.include ?? [],
    exclude: entries.exclude ?? [],
    grant: entries.grant ?? [],
    require: entries.require ?? [],
    resource: entries.resource ?? [],
    connect: entries.connect ?? [],
    runAt: first('run-at'),
    updateURL: first('updateURL'),
    downloadURL: first('downloadURL'),
    supportURL: first('supportURL'),
    homepageURL: first('homepageURL') ?? first('homepage'),
    icon: first('icon'),
    localizedNames: collectLocalized(entries, 'name'),
    localizedDescriptions: collectLocalized(entries, 'description')
  }
}

/** 解析时用的"最少一段可执行代码"判断，等价于 GF 的 get_code_blocks 全 blank 检查。 */
function hasExecutableCode(code) {
  const [before, after] = getCodeBlocks(code)
  return before.trim() !== '' || after.trim() !== ''
}

/** GreasyFork 的"看起来被压缩过"启发式：某一行超长且含 function。 */
export function appearsMinified(code) {
  return normalizeCode(code)
    .split('\n')
    .some((line) => line.length > 5000 && line.includes('function'))
}

/** 站点要求代码"看起来像代码"：至少出现一个 = . : [ ( 之一。 */
export function looksLikeCode(code) {
  return /[=.:[(]/.test(code)
}

/** 告警码 → 表单覆盖字段名（与 script_version.rb 的 attr_accessor 一一对应）。 */
export const OVERRIDE_FIELDS = {
  version_missing: 'add_missing_version',
  version_not_incremented: 'version_check_override',
  namespace_missing: 'add_missing_namespace',
  namespace_changed: 'namespace_check_override',
  potentially_minified: 'minified_confirmation',
  automatic_sensitive: 'sensitive_site_confirmation',
  code_previously_posted: 'allow_code_previously_posted',
  license_missing: 'license_missing_override',
  meta_not_at_start: 'meta_not_at_start_confirmation'
}

/**
 * 预检：解析 + 校验 + 与线上状态比对。
 *
 * @param {object} input
 * @param {string} input.code 原始代码
 * @param {'js'|'css'} [input.language]
 * @param {'public'|'unlisted'|'library'} [input.scriptType]
 * @param {boolean} [input.creating] 是否新建（部分告警只在新建时出现）
 * @param {{ version?: string|null, name?: string|null, namespace?: string|null, code?: string|null }} [input.remote] 线上最新状态
 * @returns {{
 *   meta: ReturnType<typeof parseMeta>,
 *   normalized: string,
 *   stats: { bytes: number, lines: number, minified: boolean, codeChanged: boolean|null },
 *   errors: Array<{code: string, message: string, fix: string}>,
 *   warnings: Array<{code: string, message: string, override: string|null, blocking: boolean}>,
 *   ok: boolean
 * }}
 */
export function validateSource(input) {
  const { language = 'js', scriptType = 'public', creating = true, remote = null } = input
  const normalized = normalizeCode(input.code)
  const meta = parseMeta(normalized)
  const bytes = Buffer.byteLength(normalized, 'utf8')
  const lines = normalized === '' ? 0 : normalized.split('\n').length
  const isLibrary = scriptType === 'library'

  /** @type {Array<{code: string, message: string, fix: string}>} */
  const errors = []
  /** @type {Array<{code: string, message: string, override: string|null, blocking: boolean}>} */
  const warnings = []

  const error = (code, message, fix) => errors.push({ code, message, fix })
  const warn = (code, message, extra = {}) =>
    warnings.push({
      code,
      message,
      override: OVERRIDE_FIELDS[code] ?? null,
      blocking: true,
      ...extra
    })

  if (bytes === 0) {
    error('E_SOURCE_EMPTY', '脚本内容为空。', '检查文件路径是否正确、文件是否有内容。')
  } else if (bytes > MAX_CODE_BYTES) {
    error(
      'E_CODE_TOO_LARGE',
      `脚本体积 ${bytes} 字节，超过 GreasyFork 单版本上限 ${MAX_CODE_BYTES} 字节（2 MB）。`,
      '拆分脚本、去掉内嵌资源或压缩后再发布。'
    )
  } else if (normalized.length < MIN_CODE_LENGTH) {
    error(
      'E_CODE_TOO_SHORT',
      `脚本只有 ${normalized.length} 个字符，GreasyFork 要求至少 ${MIN_CODE_LENGTH} 个字符。`,
      '确认没有截断文件内容。'
    )
  }

  if (!meta.hasMetaBlock) {
    error(
      'E_NO_META',
      '缺少用户脚本元数据块（未找到 `// ==UserScript==` … `// ==/UserScript==`）。',
      '在文件开头补上元数据块，至少包含 @name、@description、@version、@namespace、@match。'
    )
    return {
      meta,
      normalized,
      stats: { bytes, lines, minified: appearsMinified(normalized), codeChanged: null },
      errors,
      warnings,
      ok: false
    }
  }

  if (meta.block && /\/\/@[A-Za-z:-]+\s+/.test(meta.block.text)) {
    error(
      'E_INVALID_META_DIRECTIVE',
      '元数据块里存在 `//@key value` 这种写法（`//` 与 `@` 之间缺空格）。',
      '改成 `// @key value`，GreasyFork 只认带空格的格式。'
    )
  }

  if (!meta.name) {
    error('E_MISSING_NAME', '缺少 @name（脚本名称）。', '在元数据块里加一行 `// @name 你的脚本名`。')
  } else if (meta.name.length > MAX_NAME_LENGTH) {
    error(
      'E_NAME_TOO_LONG',
      `@name 长度 ${meta.name.length}，超过上限 ${MAX_NAME_LENGTH}。`,
      '把名称改短（本地化名 `@name:zh-CN` 同样受限）。'
    )
  }

  if (!isLibrary) {
    if (!meta.description) {
      error(
        'E_MISSING_DESCRIPTION',
        '缺少 @description（脚本描述），GreasyFork 必填。',
        '加一行 `// @description 这个脚本做什么`。'
      )
    } else if (meta.description.length > MAX_DESCRIPTION_LENGTH) {
      error(
        'E_DESCRIPTION_TOO_LONG',
        `@description 长度 ${meta.description.length}，超过上限 ${MAX_DESCRIPTION_LENGTH}。`,
        '把描述精简到 500 字符以内。'
      )
    } else if (meta.description.trim() === 'try to take over the world!') {
      error('E_DESCRIPTION_PLACEHOLDER', '@description 是占位文案，GreasyFork 会拒绝。', '写一段真实的脚本用途说明。')
    }
  }

  if (!meta.version) {
    warn(
      'version_missing',
      '缺少 @version。GreasyFork 会提示可自动生成版本号（勾选后由站点生成）。',
      { override: 'add_missing_version' }
    )
  } else if (String(meta.version).length > 200) {
    error('E_VERSION_TOO_LONG', '@version 超过 200 字符上限。', '改用简短的语义化版本号。')
  } else if (!isVersionLike(meta.version)) {
    warn(
      'version_unusual',
      `@version "${meta.version}" 不是常见的版本号格式，GreasyFork 的比较结果可能不符合预期。`,
      { override: null, blocking: false }
    )
  }

  if (!isLibrary && !meta.namespace) {
    warn('namespace_missing', '缺少 @namespace。GreasyFork 会提示可自动生成（勾选后由站点生成）。', {
      override: 'add_missing_namespace'
    })
  }

  if (!isLibrary && language === 'js' && meta.match.length === 0 && meta.include.length === 0) {
    error(
      'E_MISSING_MATCH',
      '缺少 @match / @include，GreasyFork 要求至少一个匹配规则。',
      '加一行 `// @match https://example.com/*`（注意每个域名单独一行）。'
    )
  }

  if (!hasExecutableCode(normalized)) {
    error('E_NO_EXECUTABLE', '元数据块之外没有任何可执行代码。', '在元数据块之后写脚本主体。')
  } else if (!looksLikeCode(normalized)) {
    error(
      'E_NOT_CODE',
      '内容不像代码（没有出现 = . : [ ( 中任何一个符号），GreasyFork 会拒绝。',
      '确认文件不是纯文本或 HTML。'
    )
  }

  if (!isLibrary && normalized.indexOf(META_START) > 0) {
    warn(
      'meta_not_at_start',
      '元数据块不在文件开头。GreasyFork 会告警（可能影响解析）。',
      { override: 'meta_not_at_start_confirmation' }
    )
  }

  if (!isLibrary && !meta.license) {
    warn('license_missing', '缺少 @license。GreasyFork 建议声明许可证（会要求勾选确认）。', {
      override: 'license_missing_override'
    })
  }

  const minified = appearsMinified(normalized)
  if (creating && minified) {
    warn(
      'potentially_minified',
      '代码看起来被压缩过（有超长单行）。GreasyFork 只对新建脚本告警。',
      { override: 'minified_confirmation' }
    )
  }

  // 与线上版本比对
  let codeChanged = null
  if (remote && remote.code != null) {
    codeChanged = normalizeCode(remote.code) !== normalized
  }
  if (remote && remote.version) {
    const version = meta.version
    if (!version) {
      // 已在 version_missing 里覆盖
    } else if (codeChanged === false && compareVersions(version, remote.version) === 0) {
      // 完全相同，交给上层判定 "没有可发布内容"
    } else {
      const cmp = compareVersions(version, remote.version)
      if (cmp !== 1) {
        warn(
          'version_not_incremented',
          `本地 @version ${version} 没有大于线上最新版本 ${remote.version}，GreasyFork 会拒绝并要求确认。`,
          { override: 'version_check_override', remoteVersion: remote.version }
        )
      }
    }
  }

  if (remote && remote.name && meta.name && remote.name !== meta.name) {
    warnings.push({
      code: 'name_changed',
      message: `脚本名会从「${remote.name}」变成「${meta.name}」。`,
      override: null,
      blocking: false
    })
  }

  if (remote && remote.namespace && meta.namespace && remote.namespace !== meta.namespace) {
    warn(
      'namespace_changed',
      `@namespace 从「${remote.namespace}」变成「${meta.namespace}」，GreasyFork 会当成另一个脚本并告警。`,
      { override: 'namespace_check_override' }
    )
  }

  return {
    meta,
    normalized,
    stats: { bytes, lines, minified, codeChanged },
    errors,
    warnings,
    ok: errors.length === 0
  }
}

/** 从 URL 或纯数字里取出 GreasyFork 脚本 id。 */
export function extractScriptId(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  const text = String(value).trim()
  if (/^\d+$/.test(text)) return Number.parseInt(text, 10)
  const m = /\/scripts\/(\d+)/.exec(text)
  return m ? Number.parseInt(m[1], 10) : null
}
