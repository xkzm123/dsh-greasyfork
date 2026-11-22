/**
 * GreasyFork 列表页解析。
 *
 * GreasyFork 没有"我的脚本"JSON 接口，只能读 HTML：
 *  - 个人主页 `/users/<id>-<name>` 里就是该用户发布的脚本列表；
 *  - 搜索页 `/scripts?q=…`、热门 `/scripts?sort=total_installs`、库 `/scripts/libraries` 同理。
 * 这里只做纯函数解析，取数与登录交给上层。
 */

const SCRIPT_ANCHOR = /<a\b[^>]*href="([^"]*\/scripts\/(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
const VERSION_TEXT = /<span[^>]*class="[^"]*script-version[^"]*"[^>]*>([\s\S]*?)<\/span>/i

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function cleanText(html) {
  return decodeEntities(String(html ?? '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 从列表页 HTML 里抠出脚本条目。
 * @returns {Array<{ id: number, name: string, url: string, path: string }>}
 */
export function parseScriptLinks(html, { site = 'https://greasyfork.org' } = {}) {
  const out = []
  const seen = new Set()
  const text = String(html ?? '')
  SCRIPT_ANCHOR.lastIndex = 0
  let match
  while ((match = SCRIPT_ANCHOR.exec(text)) !== null) {
    const [, href, rawId, inner] = match
    const id = Number.parseInt(rawId, 10)
    if (!Number.isInteger(id) || seen.has(id)) continue
    const name = cleanText(inner)
    if (!name) continue
    seen.add(id)
    const path = href.startsWith('http') ? new URL(href).pathname : href
    out.push({ id, name, path, url: href.startsWith('http') ? href : `${site}${href}` })
  }
  return out
}

/** 列表页里的版本号（有就取，没有返回 null）。 */
export function parseScriptVersion(html) {
  const match = VERSION_TEXT.exec(String(html ?? ''))
  return match ? cleanText(match[1]) || null : null
}

/**
 * 组装列表页路径（相对 site，locale 由 client.path() 补）。
 * @param {{ scope: string, query?: string, page?: number, userId?: number, userName?: string }} options
 */
export function listPath({ scope = 'mine', query = '', page = 1, userId, userName } = {}) {
  const pageNo = Math.max(1, Number(page) || 1)
  if (scope === 'mine') {
    if (!userId || !userName) throw new Error('mine 需要先登录（拿不到用户名）')
    return `/users/${userId}-${encodeURIComponent(userName)}`
  }
  if (scope === 'libraries') return '/scripts/libraries'
  if (scope === 'popular') return `/scripts?sort=total_installs&page=${pageNo}`
  if (scope === 'search') {
    const q = String(query ?? '').trim()
    if (!q) throw new Error('search 需要 query')
    return `/scripts?q=${encodeURIComponent(q)}&page=${pageNo}`
  }
  throw new Error(`未知 scope：${scope}`)
}
