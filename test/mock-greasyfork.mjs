/**
 * 本地 GreasyFork 仿真服务：只为测试发布链路（会话、CSRF、表单校验、重定向）。
 * 不联网、不碰真实账号。
 */

import { createServer } from 'node:http'

const FORM_PAGE = (token) => `<!DOCTYPE html><html><head>
<title>Post a new script</title>
<meta name="csrf-token" content="${token}">
</head><body>
<form action="/en/script_versions" method="post">
<input type="hidden" name="authenticity_token" value="${token}">
<textarea id="script_version_code" name="script_version[code]"></textarea>
</form></body></html>`

const SIGN_IN = `<!DOCTYPE html><html><head><title>Sign in to Greasy Fork</title></head><body>sign in</body></html>`

const VALIDATION_ERRORS = (message, overrides = []) => `<!DOCTYPE html><html><head>
<title>Post a new script</title><meta name="csrf-token" content="tok-1"></head><body>
<div class="validation-errors">
<p>${message}</p>
${overrides
  .map(
    (o) =>
      `<p><input type="checkbox" id="script_version_${o}" name="script_version[${o}]" value="1"> Override this warning</p>`
  )
  .join('\n')}
</div>
<form action="/en/script_versions" method="post"><textarea name="script_version[code]"></textarea></form>
</body></html>`

const RECAPTCHA_ERRORS = `<!DOCTYPE html><html><head><title>Post a new script</title></head><body>
<div class="validation-errors"><p>reCAPTCHA verification failed.</p></div>
<div class="g-recaptcha" data-sitekey="x"></div>
</body></html>`

function parseForm(text) {
  const params = new URLSearchParams(text)
  const out = {}
  for (const [k, v] of params) out[k] = v
  return out
}

/**
 * @param {{ cookieToken?: string, requireCfClearance?: boolean }} [options]
 */
export async function startMockGreasyfork(options = {}) {
  const sessionToken = options.cookieToken ?? 'session-good'
  const state = {
    scripts: new Map(),
    nextId: 1001,
    posts: [],
    patches: [],
    prefillBodies: [],
    csrfToken: 'tok-1',
    challengeAll: false
  }

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks).toString('utf8')
    const url = new URL(req.url, 'http://127.0.0.1')
    const cookie = req.headers.cookie ?? ''
    const authed = cookie.includes(`_greasyfork_session=${sessionToken}`)
    const cfOk = !options.requireCfClearance || cookie.includes('cf_clearance=')

    const send = (status, text, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
      res.end(text)
    }
    const json = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(value))
    }

    if (state.challengeAll) {
      res.writeHead(403, { 'content-type': 'text/html', 'cf-mitigated': 'challenge', server: 'cloudflare' })
      res.end('<html><head><title>Just a moment...</title></head><body></body></html>')
      return
    }
    if (!cfOk) {
      res.writeHead(403, { 'content-type': 'text/html', server: 'cloudflare' })
      res.end('<html><head><title>Just a moment...</title></head><body></body></html>')
      return
    }

    // 只读 JSON API
    let m = /^\/api\/en\/scripts\/(\d+)\.json$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const script = state.scripts.get(Number(m[1]))
      if (!script) return json(404, { error: 'not found' })
      return json(200, {
        id: script.id,
        name: script.name,
        description: script.description,
        version: script.version,
        namespace: script.namespace,
        url: `https://greasyfork.example/en/scripts/${script.id}-slug`,
        code_url: `http://127.0.0.1:${server.address().port}/en/scripts/${script.id}/code.user.js`,
        users: [{ id: 7, name: 'tester' }],
        license: null,
        code_updated_at: '2026-01-01T00:00:00.000Z'
      })
    }
    m = /^\/api\/en\/scripts\/(\d+)\/versions\.json$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const script = state.scripts.get(Number(m[1]))
      if (!script) return json(404, { error: 'not found' })
      return json(200, script.versions.map((v) => ({ version: v, created_at: '2026-01-01T00:00:00.000Z', url: '', code_url: '' })))
    }

    // 线上最新代码
    m = /^\/en\/scripts\/(\d+)\/code\.user\.js$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const script = state.scripts.get(Number(m[1]))
      if (!script) return send(404, 'not found')
      res.writeHead(200, { 'content-type': 'text/javascript' })
      return res.end(script.code)
    }

    // 用户页（登录校验）
    if (url.pathname === '/en/users/edit' && req.method === 'GET') {
      if (!authed) return send(302, '', { location: '/en/users/sign_in' })
      return send(200, '<html><head><title>Edit account</title></head><body><input name="user[name]" value="tester"></body></html>')
    }

    // 新建表单
    if (url.pathname === '/en/script_versions/new' && req.method === 'GET') {
      if (!authed) return send(200, SIGN_IN)
      return send(200, FORM_PAGE(state.csrfToken))
    }

    // 更新表单
    m = /^\/en\/scripts\/(\d+)\/versions\/new$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      if (!authed) return send(200, SIGN_IN)
      if (!state.scripts.has(Number(m[1]))) return send(404, 'not found')
      return send(200, FORM_PAGE(state.csrfToken))
    }

    // 预填
    if ((url.pathname === '/en/script_versions/prefill' || /^\/en\/scripts\/\d+\/versions\/prefill$/.test(url.pathname)) && req.method === 'POST') {
      state.prefillBodies.push(body)
      return send(200, FORM_PAGE(state.csrfToken))
    }

    // 新建脚本
    if (url.pathname === '/en/script_versions' && req.method === 'POST') {
      const form = parseForm(body)
      state.posts.push({ kind: 'create', form })
      if (form.authenticity_token !== state.csrfToken) return send(422, '')
      if (!authed) return send(302, '', { location: '/en/users/sign_in' })
      const code = form['script_version[code]'] ?? ''
      if (code.includes('MISSING_MATCH')) {
        return send(200, VALIDATION_ERRORS('Code must include at least one @match or @include key', ['version_check_override']))
      }
      if (code.includes('RECAPTCHA')) return send(200, RECAPTCHA_ERRORS)
      const id = state.nextId++
      const name = /@name\s+(.*)/.exec(code)?.[1]?.trim() ?? 'untitled'
      const version = /@version\s+(.*)/.exec(code)?.[1]?.trim() ?? '0.0.1'
      const typeId = Number(form['script[script_type]'] ?? 1)
      state.scripts.set(id, {
        id,
        name,
        description: /@description\s+(.*)/.exec(code)?.[1]?.trim() ?? '',
        namespace: /@namespace\s+(.*)/.exec(code)?.[1]?.trim() ?? null,
        scriptType: typeId === 2 ? 'unlisted' : typeId === 3 ? 'library' : 'public',
        version,
        code,
        versions: [version]
      })
      return send(302, '', { location: `/en/scripts/${id}-${name.replace(/\s+/g, '-')}` })
    }

    // 新版本
    m = /^\/en\/scripts\/(\d+)\/versions$/.exec(url.pathname)
    if (m && req.method === 'POST') {
      const form = parseForm(body)
      const id = Number(m[1])
      state.posts.push({ kind: 'update', scriptId: id, form })
      if (form.authenticity_token !== state.csrfToken) return send(422, '')
      if (!authed) return send(302, '', { location: '/en/users/sign_in' })
      const script = state.scripts.get(id)
      if (!script) return send(404, 'not found')
      const code = form['script_version[code]'] ?? ''
      if (code.includes('MISSING_MATCH')) {
        return send(200, VALIDATION_ERRORS('Code must include at least one @match or @include key'))
      }
      if (code.includes('RECAPTCHA')) return send(200, RECAPTCHA_ERRORS)
      const version = /@version\s+(.*)/.exec(code)?.[1]?.trim() ?? script.version
      // 复刻站点的"版本未递增"告警：代码变了但版本号没变；勾选覆盖项才放行
      if (code !== script.code && version === script.version && form['script_version[version_check_override]'] !== '1') {
        return send(200, VALIDATION_ERRORS('Script version has already been used', ['version_check_override']))
      }
      script.code = code
      script.version = version
      script.versions.unshift(version)
      const typeId = Number(form['script[script_type]'] ?? 1)
      script.scriptType = typeId === 2 ? 'unlisted' : typeId === 3 ? 'library' : 'public'
      return send(302, '', { location: `/en/scripts/${id}-slug` })
    }

    // 同步
    m = /^\/en\/scripts\/(\d+)\/sync_update$/.exec(url.pathname)
    if (m && req.method === 'PATCH') {
      const form = parseForm(body)
      state.patches.push({ scriptId: Number(m[1]), form })
      if (form.authenticity_token !== state.csrfToken) return send(422, '')
      if (!authed) return send(302, '', { location: '/en/users/sign_in' })
      return send(302, '', { location: `/en/scripts/${m[1]}-slug` })
    }

    // 脚本页（script_type 元信息 + 同步后的 flash）
    m = /^\/en\/scripts\/(\d+)(-[^/]*)?$/.exec(url.pathname)
    if (m && req.method === 'GET') {
      const script = state.scripts.get(Number(m[1]))
      const type = script?.scriptType ?? 'public'
      return send(
        200,
        `<html><body><li data-script-type="${type}" data-script-language="js"></li><div class="flash notice">Script successfully synced.</div></body></html>`
      )
    }

    return send(404, 'not found')
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    apiUrl: `http://127.0.0.1:${port}/api`,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}
