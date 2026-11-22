/**
 * 设置页（浏览器半边）：设置 → GreasyFork。
 *
 * 2.0 起只做「手动录入凭证」：不启动、不接管任何浏览器窗口。
 * 所有实际操作都打到宿主路由 `/api/greasyfork/*`（见 lib/settings.js）：
 *   GET  /status      凭证状态（账号、有效期、来源、校验结果）
 *   POST /parse       只解析不保存，回显识别到的格式与 cookie 名
 *   POST /credential  解析 → 校验 → 落盘
 *   POST /verify      强制重新校验
 *   POST /clear       删除本地凭证
 */

window.__ModuleLoader__.load({
  id: 'dsh-greasyfork',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement
    var useState = React.useState
    var useEffect = React.useEffect

    var SECTION_ID = 'greasyfork'
    var API = '/api/greasyfork'

    var CSS = [
      '.gfs-root{display:flex;flex-direction:column;gap:16px;max-width:640px;padding:2px 0 24px}',
      '.gfs-title{margin:0;font-size:20px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary)}',
      '.gfs-lead{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.gfs-card{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:16px;display:flex;flex-direction:column;gap:12px}',
      '.gfs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.gfs-between{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.gfs-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 12px;font-size:13px;line-height:20px;border:.5px solid var(--dsw-alias-border-l4)}',
      '.gfs-dot{width:8px;height:8px;border-radius:50%;background:currentColor}',
      '.gfs-ok{color:#22a06b;border-color:color-mix(in srgb,#22a06b 45%,transparent)}',
      '.gfs-bad{color:#d9534f;border-color:color-mix(in srgb,#d9534f 45%,transparent)}',
      '.gfs-warn{color:#d68a1e;border-color:color-mix(in srgb,#d68a1e 45%,transparent)}',
      '.gfs-idle{color:var(--dsw-alias-label-tertiary)}',
      '.gfs-name{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.gfs-sub{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.gfs-kv{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;line-height:20px}',
      '.gfs-kv dt{color:var(--dsw-alias-label-tertiary)}',
      '.gfs-kv dd{margin:0;color:var(--dsw-alias-label-primary);word-break:break-all}',
      '.gfs-btn{border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;padding:7px 14px}',
      '.gfs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.gfs-btn:disabled{opacity:.5;cursor:default}',
      '.gfs-primary{width:100%;border:0;border-radius:10px;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;font-size:14px;font-weight:600;line-height:22px;cursor:pointer;padding:11px 16px}',
      '.gfs-primary:hover:not(:disabled){filter:brightness(1.07)}',
      '.gfs-primary:disabled{opacity:.6;cursor:default}',
      '.gfs-textarea{width:100%;box-sizing:border-box;min-height:96px;resize:vertical;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px}',
      '.gfs-msg{font-size:13px;line-height:20px;padding:9px 12px;border-radius:8px}',
      '.gfs-msg-ok{background:color-mix(in srgb,#22a06b 15%,transparent)}',
      '.gfs-msg-err{background:color-mix(in srgb,#d9534f 15%,transparent)}',
      '.gfs-msg-info{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}',
      '.gfs-msg-warn{background:color-mix(in srgb,#d68a1e 16%,transparent)}',
      '.gfs-details{border-top:.5px solid var(--dsw-alias-border-l4);padding-top:12px}',
      '.gfs-details>summary{cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);list-style:none;display:flex;align-items:center;gap:6px}',
      '.gfs-details>summary::-webkit-details-marker{display:none}',
      '.gfs-details>summary:before{content:"▸";font-size:11px;transition:transform .15s}',
      '.gfs-details[open]>summary:before{transform:rotate(90deg)}',
      '.gfs-details[open]>summary{margin-bottom:12px}',
      '.gfs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.gfs-ol{margin:0;padding-left:20px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary)}',
      '.gfs-ol code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;background:var(--dsw-alias-bg-layer-1);border-radius:4px;padding:1px 5px}',
      '.gfs-list{margin:0;padding-left:18px;font-size:13px;line-height:22px;color:var(--dsw-alias-label-secondary)}',
      '.gfs-foot{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.gfs-spin{display:inline-block;width:12px;height:12px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:gfs-rot 1s linear infinite;vertical-align:-2px}',
      '@keyframes gfs-rot{to{transform:rotate(360deg)}}'
    ].join('')

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-greasyfork-css')) return
      var style = document.createElement('style')
      style.id = 'dsh-greasyfork-css'
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
    }

    function request(path, init) {
      return fetch(API + path, Object.assign({ credentials: 'same-origin' }, init || {}))
        .then(function (res) {
          return res.text().then(function (text) {
            var data = {}
            try {
              data = text ? JSON.parse(text) : {}
            } catch (e) {
              data = {
                ok: false,
                code: 'E_BAD_RESPONSE',
                message: '宿主返回的不是 JSON（HTTP ' + res.status + '）：' + String(text).slice(0, 120)
              }
            }
            if (!res.ok && data.ok !== false) {
              data = { ok: false, code: 'E_HTTP_' + res.status, message: 'HTTP ' + res.status }
            }
            return data
          })
        })
        .catch(function (err) {
          return {
            ok: false,
            code: 'E_UNREACHABLE',
            message:
              '连不上插件宿主路由（' + API + '）。确认 greasyfork 插件已启用并重启过 dsh。' +
              (err && err.message ? '（' + err.message + '）' : '')
          }
        })
    }

    function formatDays(expiry) {
      if (!expiry) return null
      if (expiry.sessionScoped) return '会话型（站点未设过期）'
      if (typeof expiry.daysLeft === 'number') return '剩余 ' + expiry.daysLeft + ' 天'
      return null
    }

    function statusTone(status) {
      if (!status || !status.configured) return { cls: 'gfs-idle', text: '未配置' }
      if (status.valid === true) return { cls: 'gfs-ok', text: '凭证有效' }
      if (status.valid === null) return { cls: 'gfs-warn', text: '暂时判断不了' }
      return { cls: 'gfs-bad', text: '凭证失效' }
    }

    function Section() {
      var [status, setStatus] = useState(null)
      var [input, setInput] = useState('')
      var [busy, setBusy] = useState('')
      var [msg, setMsg] = useState(null)
      var [parsed, setParsed] = useState(null)

      useEffect(() => {
        ensureCss()
        loadStatus(false)
      }, [])

      function loadStatus(force) {
        setBusy(function (prev) {
          return prev || 'status'
        })
        return request('/status' + (force ? '?force=1' : ''), { method: 'GET' })
          .then(function (data) {
            setStatus(data && data.ok ? data : null)
            setBusy('')
            return data
          })
          .catch(function () {
            setBusy('')
          })
      }

      function doParse() {
        if (!input.trim()) {
          setMsg({ kind: 'warn', text: '先粘贴 Cookie 内容。' })
          return
        }
        setBusy('parse')
        setMsg(null)
        request('/parse', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cookie: input })
        })
          .then(function (data) {
            setBusy('')
            setParsed(data)
            if (!data || !data.ok) {
              setMsg({ kind: 'err', text: (data && data.message) || '没解析出 Cookie。' })
              return
            }
            if (!data.hasSession) {
              setMsg({ kind: 'err', text: '解析出 ' + data.cookieCount + ' 条，但没有 _greasyfork_session —— 这多半不是登录态 Cookie。' })
              return
            }
            setMsg({
              kind: 'info',
              text: '解析成功：识别为 ' + data.format + '，共 ' + data.cookieCount + ' 条，含 _greasyfork_session。'
            })
          })
          .catch(function (err) {
            setBusy('')
            setMsg({ kind: 'err', text: String((err && err.message) || err) })
          })
      }

      function doSave() {
        if (!input.trim()) {
          setMsg({ kind: 'warn', text: '先粘贴 Cookie 内容。' })
          return
        }
        setBusy('save')
        setMsg(null)
        request('/credential', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cookie: input })
        })
          .then(function (data) {
            setBusy('')
            if (!data || !data.ok) {
              setMsg({ kind: 'err', text: (data && data.message) || '保存失败。' })
              return
            }
            if (data.verified) {
              setMsg({ kind: 'ok', text: '已保存并校验通过（账号 ' + (data.username || '未知') + '）。' })
            } else {
              setMsg({
                kind: 'warn',
                text: '已保存，但这次没能校验（' + (data.verifyError || '站点没返回可判定的结果') + '）。真正发布时会再校验一次。'
              })
            }
            setInput('')
            setParsed(null)
            loadStatus(true)
          })
          .catch(function (err) {
            setBusy('')
            setMsg({ kind: 'err', text: String((err && err.message) || err) })
          })
      }

      function doVerify() {
        setBusy('verify')
        setMsg(null)
        request('/verify', { method: 'POST' })
          .then(function (data) {
            setBusy('')
            setStatus(data && data.ok ? data : null)
            if (data && data.valid === true) setMsg({ kind: 'ok', text: '校验通过，账号 ' + (data.username || '未知') + '。' })
            else if (data && data.valid === null) setMsg({ kind: 'warn', text: '判断不了：' + (data.verifyError || '请求被拦截') + '。这不等于凭证失效。' })
            else setMsg({ kind: 'err', text: '校验没通过，站点把请求跳到了登录页，需要重新导出 Cookie。' })
          })
          .catch(function (err) {
            setBusy('')
            setMsg({ kind: 'err', text: String((err && err.message) || err) })
          })
      }

      function doClear() {
        setBusy('clear')
        request('/clear', { method: 'POST' })
          .then(function (data) {
            setBusy('')
            setMsg({ kind: data && data.ok ? 'ok' : 'err', text: (data && data.message) || (data && data.ok ? '已删除本地凭证。' : '删除失败。') })
            loadStatus(true)
          })
          .catch(function (err) {
            setBusy('')
            setMsg({ kind: 'err', text: String((err && err.message) || err) })
          })
      }

      function pasteFromClipboard() {
        if (!navigator.clipboard || !navigator.clipboard.readText) {
          setMsg({ kind: 'warn', text: '这个浏览器不允许读剪贴板，请手动 Ctrl+V。' })
          return
        }
        navigator.clipboard.readText().then(
          function (text) {
            setInput(text || '')
            setMsg({ kind: 'info', text: '已从剪贴板读入 ' + String(text || '').length + ' 个字符。' })
          },
          function () {
            setMsg({ kind: 'warn', text: '读剪贴板被拒绝，请手动 Ctrl+V。' })
          }
        )
      }

      var tone = statusTone(status)
      var expiry = status && status.expiry
      var daysText = formatDays(expiry)

      return h(
        'div',
        { className: 'gfs-root' },
        h(
          'div',
          null,
          h('h2', { className: 'gfs-title' }, 'GreasyFork'),
          h(
            'p',
            { className: 'gfs-lead' },
            '把用户脚本像 git push 一样推到 GreasyFork：读自己的脚本与版本、发布新脚本、发新版本、改简介、搜索站内脚本、查账号信息。'
          )
        ),

        // ── 状态 ────────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h(
            'div',
            { className: 'gfs-between' },
            h(
              'div',
              { className: 'gfs-row' },
              h('span', { className: 'gfs-badge ' + tone.cls }, h('span', { className: 'gfs-dot' }), tone.text),
              status && status.username ? h('span', { className: 'gfs-name' }, status.username) : null
            ),
            h(
              'div',
              { className: 'gfs-row' },
              h(
                'button',
                { className: 'gfs-btn', disabled: busy === 'verify', onClick: doVerify },
                busy === 'verify' ? h('span', { className: 'gfs-spin' }) : '重新校验'
              ),
              h(
                'button',
                { className: 'gfs-btn', disabled: busy === 'clear' || !(status && status.configured), onClick: doClear },
                '删除凭证'
              )
            )
          ),
          status && status.configured
            ? h(
                'dl',
                { className: 'gfs-kv' },
                h('dt', null, '有效期'),
                h(
                  'dd',
                  null,
                  daysText || '未知',
                  expiry && expiry.sessionScoped
                    ? '　—— 只要不在别的设备/浏览器上重新登录把会话顶掉，就会一直有效'
                    : expiry && expiry.latestExpiresAt
                      ? '（' + new Date(expiry.latestExpiresAt).toLocaleString() + ' 到期）'
                      : ''
                ),
                h('dt', null, '录入时间'),
                h('dd', null, status.savedAt ? new Date(status.savedAt).toLocaleString() : '—'),
                h('dt', null, '来源'),
                h('dd', null, status.source || '—'),
                h('dt', null, '格式'),
                h('dd', null, status.format || '—'),
                h('dt', null, 'Cookie'),
                h('dd', null, (status.cookie && status.cookie.names ? status.cookie.names.join('、') : '—'))
              )
            : h('div', { className: 'gfs-sub' }, '还没有凭证。按下面的步骤导出一次，之后长期有效。'),

          msg
            ? h('div', { className: 'gfs-msg gfs-msg-' + (msg.kind === 'ok' ? 'ok' : msg.kind === 'err' ? 'err' : msg.kind === 'warn' ? 'warn' : 'info') }, msg.text)
            : null
        ),

        // ── 手动录入 ────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h('div', { className: 'gfs-name' }, '粘贴 Cookie'),
          h(
            'div',
            { className: 'gfs-sub' },
            '支持这些格式，直接整段粘进来就行：Cookie-Editor / EditThisCookie 的 JSON 导出、Netscape cookies.txt、' +
              'DevTools 里复制的请求头 Cookie、多行 name=value。'
          ),
          h('textarea', {
            className: 'gfs-textarea',
            placeholder: '[{"domain":".greasyfork.org","name":"_greasyfork_session","value":"…"}]\n或 _greasyfork_session=…; locale_messaged=true',
            value: input,
            spellCheck: false,
            onChange: function (e) {
              setInput(e.target.value)
              setParsed(null)
            }
          }),
          h(
            'div',
            { className: 'gfs-row' },
            h('button', { className: 'gfs-btn', onClick: pasteFromClipboard }, '从剪贴板粘贴'),
            h(
              'button',
              { className: 'gfs-btn', disabled: busy === 'parse' || !input.trim(), onClick: doParse },
              busy === 'parse' ? h('span', { className: 'gfs-spin' }) : '先解析看看'
            )
          ),
          parsed && parsed.ok
            ? h(
                'div',
                { className: 'gfs-sub' },
                '识别：' + parsed.format + ' · ' + parsed.cookieCount + ' 条 · ' + (parsed.hasSession ? '含会话键' : '缺会话键') +
                  (parsed.expiry && parsed.expiry.sessionScoped ? ' · 会话型 Cookie' : '')
              )
            : null,
          h(
            'button',
            { className: 'gfs-primary', disabled: busy === 'save' || !input.trim(), onClick: doSave },
            busy === 'save' ? h('span', { className: 'gfs-spin' }) : '校验并保存'
          )
        ),

        // ── 教程 ────────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h(
            'details',
            { className: 'gfs-details', open: !(status && status.configured) },
            h('summary', null, '怎么导出 Cookie（推荐：Cookie-Editor）'),
            h(
              'ol',
              { className: 'gfs-ol' },
              h('li', null, '给浏览器装扩展 ', h('code', null, 'Cookie-Editor'), '（Chrome / Edge 商店搜名字即可，图标是一块饼干）。'),
              h('li', null, '打开 ', h('code', null, 'https://greasyfork.org'), ' 并登录（右上角出现你的用户名即成功）。'),
              h('li', null, '点工具栏上的 Cookie-Editor 图标，确认列表里有 ', h('code', null, '_greasyfork_session'), '。'),
              h('li', null, '点右下角 ', h('code', null, 'Export'), ' → 选 ', h('code', null, 'JSON'), '（带 expirationDate 字段的那种）。'),
              h('li', null, '复制弹窗里的整段内容，粘贴到上面的输入框，点「校验并保存」。')
            ),
            h(
              'div',
              { className: 'gfs-sub', style: { marginTop: '10px' } },
              '注意：导出前不要在其他浏览器/设备上重新登录 GreasyFork —— 站点会轮换会话，旧 Cookie 立刻失效。'
            )
          ),

          h(
            'details',
            { className: 'gfs-details' },
            h('summary', null, '其他导出途径'),
            h(
              'ul',
              { className: 'gfs-list' },
              h('li', null, h('strong', null, 'EditThisCookie：'), '同样 Export → JSON，格式与 Cookie-Editor 兼容。'),
              h('li', null, h('strong', null, 'DevTools 请求头：'), 'F12 → Network → 刷新页面 → 点任意 greasyfork.org 请求 → 复制 Request Headers 里 Cookie 这一整行。'),
              h('li', null, h('strong', null, 'DevTools 存储面板：'), 'F12 → Application → Cookies → https://greasyfork.org → 把需要的行拼成 name=value; 形式。'),
              h('li', null, h('strong', null, 'cookies.txt：'), '任何导出 Netscape 格式的扩展都可以，插件会按 7 列制表符解析。'),
              h('li', null, h('strong', null, '只要会话键：'), '最少可以只粘 _greasyfork_session=… 一行，其它键会由站点按需补发。')
            )
          ),

          h(
            'details',
            { className: 'gfs-details' },
            h('summary', null, '这个插件能做什么'),
            h(
              'ul',
              { className: 'gfs-list' },
              h('li', null, '读：列出自己发布的脚本、看版本历史、看线上代码、按关键词搜索站内脚本、查账号信息。'),
              h('li', null, '写：发布新脚本、给已有脚本发新版本（带 changelog）、从 GitHub 源同步更新。'),
              h('li', null, '改：更新脚本简介与附加信息、调整可见性（public / unlisted / library）。'),
              h('li', null, '把关：发布前预检元数据（版本号、license、namespace 变更、体积、@match 数量），提前发现会被打回的问题。')
            )
          )
        ),

        h('div', { className: 'gfs-foot' }, '凭证位置：' + ((status && status.storage) || '—') + '（权限 0600，不进配置、不进日志）')
      )
    }

    function Icon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', { d: 'M2.5 4.2h11v7.6h-11z', stroke: 'currentColor', strokeWidth: 1.2, strokeLinejoin: 'round' }),
        h('path', { d: 'M4.4 6.3h4.6M4.4 8.4h6.4M4.4 10.5h3.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' })
      )
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
      var safeInject = function (name, factory) {
        try {
          return ctx.slots.inject(name, factory)
        } catch (e) {
          return null
        }
      }
      var register = function () {
        var offSection = safeInject('settings.section', function () {
          return ctx.slots.register(
            { name: 'settings.section', id: SECTION_ID, order: 55, label: function () { return 'GreasyFork' } },
            Section
          )
        })
        var offIcon = safeInject('settings.section.icon', function () {
          return ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID }, Icon)
        })
        return function () {
          try { offIcon && offIcon() } catch (e) {}
          try { offSection && offSection() } catch (e) {}
        }
      }
      if (typeof ctx.effect === 'function') ctx.effect(register, 'dsh-greasyfork: settings section')
      else register()
    }

    exports.apply = apply
    exports.inject = ['slots']
    exports.SECTION_ID = SECTION_ID
    return module.exports
  }
})
