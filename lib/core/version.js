/**
 * 版本号比较：逐行移植 GreasyFork 的 `ScriptVersion.split_version` /
 * `compare_versions`（app/models/script_version.rb）。
 *
 * 移植的意义：发布前就能算出 GreasyFork 会怎么比较版本，从而在本地拦下
 * "版本号没递增" 这类会被站点判为告警/冲突的情况，而不是发出去才发现。
 */

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
