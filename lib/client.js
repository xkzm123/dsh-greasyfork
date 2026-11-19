/**
 * 设置页（浏览器半边）：在「设置 → GreasyFork」里提供凭证配置区。
 *
 * 加载方式由 dsh 的 client 加载器决定：文件被当作模块工厂执行，
 * `require("react")` 由宿主提供，所以这里不打包 React、也不用 JSX。
 *
 * 所有实际操作都打到宿主路由 `/api/greasyfork/*`（见 lib/settings.js）：
 *   GET  /status        凭证状态（含来源、账号、Cookie 名）
 *   POST /credential    校验并保存手动填入的 Cookie
 *   POST /verify        强制重新校验
 *   POST /clear         删除本地凭证
 *   POST /open-login    用系统默认浏览器打开 GreasyFork 登录页
 *   GET  /helper.user.js 安装"Cookie 助手"用户脚本（GM_cookie 读 HttpOnly）
 *   GET  /snippet       控制台片段（带 HttpOnly 限制说明）
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
    var useRef = React.useRef

    var SECTION_ID = 'greasyfork'
    var API = '/api/greasyfork'

    // ── 样式（只用 DSH 自己的 token，跟随主题） ────────────────────────────
    var CSS = [
      '.gfs-root{display:flex;flex-direction:column;gap:14px;max-width:640px;padding:4px 0 24px}',
      '.gfs-h2{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary)}',
      '.gfs-h3{margin:0 0 2px;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.gfs-lead{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.gfs-card{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:14px;display:flex;flex-direction:column;gap:10px}',
      '.gfs-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.gfs-row-between{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.gfs-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}',
      '.gfs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.gfs-btn{border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;padding:6px 12px}',
      '.gfs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.gfs-btn:disabled{opacity:.55;cursor:default}',
      '.gfs-btn-primary{border-color:transparent;background:var(--dsw-alias-state-business-primary);color:#fff}',
      '.gfs-btn-primary:hover:not(:disabled){filter:brightness(1.06);background:var(--dsw-alias-state-business-primary)}',
      '.gfs-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:2px 10px;font-size:12px;line-height:18px;border:.5px solid var(--dsw-alias-border-l4)}',
      '.gfs-dot{width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.9}',
      '.gfs-ok{color:#22a06b;border-color:color-mix(in srgb,#22a06b 40%,transparent)}',
      '.gfs-bad{color:#d9534f;border-color:color-mix(in srgb,#d9534f 40%,transparent)}',
      '.gfs-idle{color:var(--dsw-alias-label-tertiary)}',
      '.gfs-textarea{width:100%;box-sizing:border-box;min-height:76px;resize:vertical;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:8px 10px}',
      '.gfs-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.gfs-msg{font-size:12px;line-height:18px;padding:6px 10px;border-radius:6px}',
      '.gfs-msg-ok{background:color-mix(in srgb,#22a06b 14%,transparent);color:var(--dsw-alias-label-primary)}',
      '.gfs-msg-err{background:color-mix(in srgb,#d9534f 14%,transparent);color:var(--dsw-alias-label-primary)}',
      '.gfs-msg-info{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-label-primary)}',
      '.gfs-steps{margin:0;padding-left:18px;display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}',
      '.gfs-hr{height:0;border:0;border-top:.5px solid var(--dsw-alias-border-l4);margin:2px 0}'
    ].join('')

    function ensureCss() {
      if (typeof document === 'undefined') return
      if (document.getElementById('dsh-greasyfork-css')) return
      var style = document.createElement('style')
      style.id = 'dsh-greasyfork-css'
      style.textContent = CSS
      ;(document.head || document.documentElement).appendChild(style)
    }

    /** 统一请求封装：错误也变成结构化对象，界面永远有话说。 */
    function request(path, init) {
      return fetch(API + path, Object.assign({ credentials: 'same-origin' }, init || {}))
        .then(function (res) {
          return res.text().then(function (text) {
            var data = {}
            try {
              data = text ? JSON.parse(text) : {}
            } catch (e) {
              data = { ok: false, code: 'E_BAD_RESPONSE', message: text.slice(0, 200) }
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
              '连不上插件宿主路由（' + API + '）。确认 greasyfork 插件已在 profile 里启用，并重启过 dsh。' +
              (err && err.message ? '（' + err.message + '）' : '')
          }
        })
    }

    function Badge(props) {
      var tone = props.tone || 'idle'
      return h(
        'span',
        { className: 'gfs-badge gfs-' + tone },
        h('span', { className: 'gfs-dot' }),
        props.children
      )
    }

    function Message(props) {
      if (!props.message || !props.message.text) return null
      return h('div', { className: 'gfs-msg gfs-msg-' + (props.message.tone || 'info') }, props.message.text)
    }

    function Section() {
      ensureCss()

      var [status, setStatus] = useState({ loading: true })
      var [input, setInput] = useState('')
      var [message, setMessage] = useState(null)
      var [busy, setBusy] = useState('')
      var mounted = useRef(true)

      function refresh(force) {
        return request('/status' + (force ? '?force=1' : ''), { method: 'GET' }).then(function (data) {
          if (!mounted.current) return
          if (data && data.ok === false) {
            setStatus({ loading: false, error: data })
            return
          }
          setStatus(Object.assign({ loading: false }, data))
        })
      }

      useEffect(function () {
        mounted.current = true
        refresh(false)
        var timer = setInterval(function () {
          refresh(false)
        }, 3000)
        return function () {
          mounted.current = false
          clearInterval(timer)
        }
      }, [])

      function openLogin() {
        setBusy('login')
        setMessage({ tone: 'info', text: '正在用系统默认浏览器打开 GreasyFork 登录页…' })
        request('/open-login', { method: 'POST' })
          .then(function (data) {
            if (data && data.ok) {
              setMessage({
                tone: 'info',
                text:
                  '已打开 ' + data.url + '。登录后安装下面的助手脚本，在 greasyfork.org 页面点一下按钮即可。' +
                  (data.opened === false ? '（系统浏览器没能自动打开，请手动访问该地址。）' : '')
              })
            } else {
              setMessage({ tone: 'err', text: (data && data.message) || '打开登录页失败。' })
            }
          })
          .finally(function () {
            setBusy('')
          })
      }

      function installHelper() {
        if (!status || !status.helperToken) {
          setMessage({ tone: 'err', text: '还没拿到助手脚本地址，先点「刷新状态」。' })
          return
        }
        var url = API + '/helper.user.js?token=' + encodeURIComponent(status.helperToken)
        var win = window.open(url, '_blank', 'noopener')
        if (!win) {
          setMessage({ tone: 'err', text: '弹窗被拦截了，请手动打开：' + url })
        } else {
          setMessage({
            tone: 'info',
            text: '已打开助手脚本。脚本管理器（Tampermonkey/Violentmonkey）会弹出安装确认，装上后打开 greasyfork.org 点右下角按钮。'
          })
        }
      }

      function saveCredential() {
        var cookie = (input || '').trim()
        if (!cookie) {
          setMessage({ tone: 'err', text: '先把 Cookie 粘贴到下面的输入框。' })
          return
        }
        setBusy('save')
        setMessage({ tone: 'info', text: '正在校验并保存…' })
        request('/credential', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cookie: cookie })
        })
          .then(function (data) {
            if (data && data.ok) {
              setInput('')
              setMessage({
                tone: 'ok',
                text: '已保存' + (data.username ? '（账号 ' + data.username + '）' : '') + '，之后 AI 就能直接发布了。'
              })
              refresh(true)
            } else {
              setMessage({ tone: 'err', text: (data && data.message) || '保存失败。' })
            }
          })
          .finally(function () {
            setBusy('')
          })
      }

      function pasteFromClipboard() {
        if (!navigator.clipboard || typeof navigator.clipboard.readText !== 'function') {
          setMessage({ tone: 'err', text: '这个环境不允许读剪贴板，请用 Ctrl+V 粘贴。' })
          return
        }
        navigator.clipboard
          .readText()
          .then(function (text) {
            if (!text) {
              setMessage({ tone: 'err', text: '剪贴板是空的。' })
              return
            }
            setInput(text.trim())
            setMessage({ tone: 'info', text: '已从剪贴板粘贴，检查一下再点「保存并校验」。' })
          })
          .catch(function () {
            setMessage({ tone: 'err', text: '读剪贴板被拒绝，请用 Ctrl+V 粘贴。' })
          })
      }

      function copySnippet() {
        request('/snippet', { method: 'GET' }).then(function (data) {
          var text = (data && data.snippet) || ''
          if (!text) {
            setMessage({ tone: 'err', text: '拿不到控制台片段。' })
            return
          }
          var done = function () {
            setMessage({
              tone: 'info',
              text: '控制台片段已复制。注意：_greasyfork_session 是 HttpOnly，控制台读不到，登录 Cookie 请用上面的助手脚本。'
            })
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(done, function () {
              setMessage({ tone: 'err', text: '复制失败，请手动打开：' + API + '/snippet' })
            })
          } else {
            setMessage({ tone: 'err', text: '这个环境不允许写剪贴板，请手动打开：' + API + '/snippet' })
          }
        })
      }

      function verify() {
        setBusy('verify')
        setMessage({ tone: 'info', text: '正在校验当前凭证…' })
        request('/verify', { method: 'POST' })
          .then(function (data) {
            if (data && data.ok === false) {
              setMessage({ tone: 'err', text: (data && data.message) || '校验失败。' })
              return
            }
            setStatus(Object.assign({ loading: false }, data))
            setMessage({
              tone: data && data.valid ? 'ok' : 'err',
              text: data && data.valid ? '凭证有效。' : '凭证已失效，请重新登录后更新。'
            })
          })
          .finally(function () {
            setBusy('')
          })
      }

      function clear() {
        setBusy('clear')
        request('/clear', { method: 'POST' })
          .then(function (data) {
            setMessage({
              tone: data && data.ok ? 'ok' : 'err',
              text: (data && data.ok ? '已删除本地凭证。' : (data && data.message) || '删除失败。') + (data && data.note ? ' ' + data.note : '')
            })
            refresh(true)
          })
          .finally(function () {
            setBusy('')
          })
      }

      var configured = status && status.configured === true
      var valid = status && status.valid === true
      var cookieNames = (status && status.cookie && status.cookie.names) || []

      return h(
        'div',
        { className: 'gfs-root' },
        h('h2', { className: 'gfs-h2' }, 'GreasyFork'),
        h(
          'p',
          { className: 'gfs-lead' },
          '配置一次登录凭证，之后 AI 就能像 git push 一样把用户脚本发布/更新到 GreasyFork，不需要你再去网页点发布。'
        ),

        status && status.error
          ? h(Message, { message: { tone: 'err', text: status.error.message || '读取状态失败。' } })
          : null,

        // ── 当前状态 ─────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h(
            'div',
            { className: 'gfs-row-between' },
            h(
              'div',
              { className: 'gfs-row' },
              h('span', { className: 'gfs-h3' }, '当前状态'),
              status.loading
                ? h(Badge, { tone: 'idle' }, '读取中…')
                : configured
                  ? valid
                    ? h(Badge, { tone: 'ok' }, '已配置 · 有效')
                    : h(Badge, { tone: 'bad' }, '已配置 · 已失效')
                  : h(Badge, { tone: 'idle' }, '未配置')
            ),
            h(
              'div',
              { className: 'gfs-row' },
              h('button', { className: 'gfs-btn', onClick: function () { refresh(true) } }, '刷新状态'),
              h('button', { className: 'gfs-btn', disabled: !configured || busy !== '', onClick: verify }, '验证'),
              h('button', { className: 'gfs-btn', disabled: !configured || busy !== '', onClick: clear }, '清除')
            )
          ),
          configured
            ? h(
                'div',
                { className: 'gfs-row', style: { gap: '16px' } },
                h('span', { className: 'gfs-label' }, '账号：' + (status.username || '（未知）')),
                h('span', { className: 'gfs-label' }, '来源：' + (status.source || '—'))
              )
            : null,
          configured
            ? h(
                'div',
                { className: 'gfs-label' },
                'Cookie：' + (cookieNames.length ? cookieNames.join('、') : '（已配置）')
              )
            : null,
          h('div', { className: 'gfs-mono' }, '存储位置：' + (status.storage || '—')),
          h(Message, { message: message })
        ),

        // ── 方式 A ───────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h('div', { className: 'gfs-h3' }, '方式 A · 浏览器登录后自动获取（推荐）'),
          h(
            'ol',
            { className: 'gfs-steps' },
            h('li', null, '点「打开登录页」，在系统浏览器里登录 GreasyFork。'),
            h('li', null, '点「安装 Cookie 助手」，脚本管理器确认安装（只需一次）。'),
            h('li', null, '回到 greasyfork.org 页面，点右下角「把 Cookie 交给 DSH」。'),
            h('li', null, '脚本会把 Cookie 复制到剪贴板并回传，本面板 3 秒内自动变成「已配置」。')
          ),
          h(
            'div',
            { className: 'gfs-row' },
            h(
              'button',
              { className: 'gfs-btn gfs-btn-primary', disabled: busy === 'login', onClick: openLogin },
              '打开登录页'
            ),
            h('button', { className: 'gfs-btn', onClick: installHelper }, '安装 Cookie 助手')
          ),
          h(
            'p',
            { className: 'gfs-note' },
            '为什么需要助手脚本：GreasyFork 的 _greasyfork_session 是 HttpOnly Cookie，浏览器控制台读不到；' +
              '脚本管理器（Tampermonkey/Violentmonkey）的 GM_cookie 才能读。脚本只做两件事：复制到剪贴板、POST 给本机插件。'
          )
        ),

        // ── 方式 B ───────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h('div', { className: 'gfs-h3' }, '方式 B · 手动填入'),
          h(
            'p',
            { className: 'gfs-note' },
            '从已登录的 greasyfork.org 页面：F12 → Application（应用）→ Cookies → https://greasyfork.org，' +
              '把 _greasyfork_session 的值（有 cf_clearance 也一起）拼成 `_greasyfork_session=…; cf_clearance=…` 粘到下面；' +
              '或直接复制任意请求的 Request Headers 里整行 Cookie。'
          ),
          h(
            'textarea',
            {
              className: 'gfs-textarea',
              placeholder: '_greasyfork_session=…; cf_clearance=…',
              value: input,
              spellCheck: false,
              onChange: function (e) {
                setInput(e.target.value)
              }
            }
          ),
          h(
            'div',
            { className: 'gfs-row' },
            h('button', { className: 'gfs-btn', onClick: pasteFromClipboard }, '从剪贴板粘贴'),
            h('button', { className: 'gfs-btn', onClick: copySnippet }, '复制控制台片段'),
            h(
              'button',
              { className: 'gfs-btn gfs-btn-primary', disabled: busy === 'save', onClick: saveCredential },
              '保存并校验'
            )
          ),
          h(
            'p',
            { className: 'gfs-note' },
            '保存前会先打一次 GreasyFork 登录校验：Cookie 不对就直接拒绝，不会存进去。' +
              '凭证写在存储位置那行指向的文件里（0600），不进配置、不进日志、也不会出现在对话里。'
          )
        ),

        h('hr', { className: 'gfs-hr' }),
        h(
          'p',
          { className: 'gfs-note' },
          '配好之后在对话里说「把 xxx.user.js 发到 GreasyFork」或「作为新版本推到脚本 123456」即可；' +
            '也可以随时让 AI 调 greasyfork_preflight 先看发布摘要。'
        )
      )
    }

    function Icon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.5 4.2h11v7.6h-11z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round'
        }),
        h('path', { d: 'M4.4 6.3h4.6M4.4 8.4h6.4M4.4 10.5h3.2', stroke: 'currentColor', strokeWidth: 1.1, strokeLinecap: 'round' })
      )
    }

    function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return
      // 某些宿主版本没有 settings.section.icon 槽位：inject 失败不能连累主面板。
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
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: 55,
              label: function () {
                return 'GreasyFork'
              }
            },
            Section
          )
        })
        var offIcon = safeInject('settings.section.icon', function () {
          return ctx.slots.register({ name: 'settings.section.icon', id: SECTION_ID }, Icon)
        })
        return function () {
          try {
            offIcon && offIcon()
          } catch (e) {}
          try {
            offSection && offSection()
          } catch (e) {}
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
