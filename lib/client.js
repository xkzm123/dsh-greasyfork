/**
 * 设置页（浏览器半边）：设置 → GreasyFork。
 *
 * 加载方式由 dsh 的 client 加载器决定：文件被当作模块工厂执行，
 * `require("react")` 由宿主提供，所以不打包 React、也不用 JSX。
 *
 * 所有实际操作都打到宿主路由 `/api/greasyfork/*`（见 lib/settings.js）：
 *   GET  /status            凭证状态（来源、账号、Cookie 名）
 *   POST /capture/start     启动带调试端口的浏览器，自动读 HttpOnly Cookie
 *   GET  /capture/status    采集进度
 *   POST /capture/cancel    取消采集并关掉那个浏览器
 *   POST /credential        校验并保存手动填入的 Cookie
 *   POST /verify | /clear   重新校验 / 删除
 *   GET  /snippet           控制台片段
 *   GET  /helper.user.js    可选：给已装用户脚本管理器的人用的助手脚本
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

    var CSS = [
      '.gfs-root{display:flex;flex-direction:column;gap:16px;max-width:620px;padding:2px 0 24px}',
      '.gfs-title{margin:0;font-size:20px;font-weight:600;line-height:28px;color:var(--dsw-alias-label-primary)}',
      '.gfs-card{border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-2);padding:16px;display:flex;flex-direction:column;gap:12px}',
      '.gfs-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
      '.gfs-between{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
      '.gfs-badge{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 12px;font-size:13px;line-height:20px;border:.5px solid var(--dsw-alias-border-l4)}',
      '.gfs-dot{width:8px;height:8px;border-radius:50%;background:currentColor}',
      '.gfs-ok{color:#22a06b;border-color:color-mix(in srgb,#22a06b 45%,transparent)}',
      '.gfs-bad{color:#d9534f;border-color:color-mix(in srgb,#d9534f 45%,transparent)}',
      '.gfs-idle{color:var(--dsw-alias-label-tertiary)}',
      '.gfs-run{color:#2f6feb;border-color:color-mix(in srgb,#2f6feb 45%,transparent)}',
      '.gfs-name{font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.gfs-sub{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.gfs-btn{border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;cursor:pointer;padding:7px 14px}',
      '.gfs-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.gfs-btn:disabled{opacity:.5;cursor:default}',
      '.gfs-primary{width:100%;border:0;border-radius:10px;background:var(--dsw-alias-state-business-primary);color:#fff;font:inherit;font-size:14px;font-weight:600;line-height:22px;cursor:pointer;padding:11px 16px}',
      '.gfs-primary:hover:not(:disabled){filter:brightness(1.07)}',
      '.gfs-primary:disabled{opacity:.6;cursor:default}',
      '.gfs-textarea{width:100%;box-sizing:border-box;min-height:70px;resize:vertical;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:12px/18px ui-monospace,SFMono-Regular,Menlo,monospace;padding:10px}',
      '.gfs-msg{font-size:13px;line-height:20px;padding:9px 12px;border-radius:8px}',
      '.gfs-msg-ok{background:color-mix(in srgb,#22a06b 15%,transparent)}',
      '.gfs-msg-err{background:color-mix(in srgb,#d9534f 15%,transparent)}',
      '.gfs-msg-info{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent)}',
      '.gfs-details{border-top:.5px solid var(--dsw-alias-border-l4);padding-top:12px}',
      '.gfs-details>summary{cursor:pointer;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);list-style:none;display:flex;align-items:center;gap:6px}',
      '.gfs-details>summary::-webkit-details-marker{display:none}',
      '.gfs-details>summary:before{content:"▸";font-size:11px;transition:transform .15s}',
      '.gfs-details[open]>summary:before{transform:rotate(90deg)}',
      '.gfs-details[open]>summary{margin-bottom:12px}',
      '.gfs-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
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
            if (!res.ok && data.ok !== false) data = { ok: false, code: 'E_HTTP_' + res.status, message: 'HTTP ' + res.status }
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

    function Badge(props) {
      return h(
        'span',
        { className: 'gfs-badge gfs-' + (props.tone || 'idle') },
        props.spin ? h('span', { className: 'gfs-spin' }) : h('span', { className: 'gfs-dot' }),
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
      var [capture, setCapture] = useState(null)
      var mounted = useRef(true)
      var timer = useRef(0)

      function applyStatus(data) {
        if (!mounted.current) return
        if (data && data.ok === false) {
          setStatus({ loading: false, error: data })
          return
        }
        setStatus(Object.assign({ loading: false }, data))
        if (data && data.capture) setCapture(data.capture)
      }

      function refresh(force) {
        return request('/status' + (force ? '?force=1' : ''), { method: 'GET' }).then(applyStatus)
      }

      // 采集进行中轮询快一点，其余时间慢一点；用返回值判断，避免读到旧的 state
      function schedule(ms) {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(function tick() {
          request('/status', { method: 'GET' }).then(function (data) {
            applyStatus(data)
            var running = data && data.capture && data.capture.state === 'running'
            var failed = data && data.ok === false
            schedule(failed ? 1500 : running ? 1200 : 5000)
          })
        }, ms)
      }

      useEffect(function () {
        mounted.current = true
        refresh(false).then(function () {
          schedule(4000)
        })
        return function () {
          mounted.current = false
          if (timer.current) clearTimeout(timer.current)
        }
      }, [])

      function startCapture() {
        setBusy('capture')
        setMessage(null)
        request('/capture/start', { method: 'POST' })
          .then(function (data) {
            if (data && data.ok) {
              setCapture(data.capture)
              setMessage({ tone: 'info', text: '已打开 ' + (data.browser || '浏览器') + '，请在新窗口里登录 GreasyFork，登录完不用管，这里会自动完成。' })
              schedule(1200)
            } else {
              setMessage({ tone: 'err', text: (data && data.message) || '启动浏览器失败。' })
            }
          })
          .finally(function () {
            setBusy('')
          })
      }

      function cancelCapture() {
        request('/capture/cancel', { method: 'POST' }).then(function (data) {
          if (data && data.capture) setCapture(data.capture)
          setMessage({ tone: 'info', text: '已取消。' })
        })
      }

      // 采集完成 / 失败时给一次提示
      useEffect(function () {
        if (!capture) return
        if (capture.state === 'done') {
          setMessage({ tone: 'ok', text: '已自动获取并保存' + (capture.username ? '（账号 ' + capture.username + '）' : '') + '，可以关掉那个浏览器窗口了。' })
          refresh(true)
        } else if (capture.state === 'timeout') {
          setMessage({ tone: 'err', text: capture.message || '等待登录超时，请重试。' })
        } else if (capture.state === 'error') {
          setMessage({ tone: 'err', text: capture.message || '自动获取失败，请改用手动填入。' })
        }
      }, [capture && capture.state, capture && capture.username])

      function saveCredential() {
        var cookie = (input || '').trim()
        if (!cookie) {
          setMessage({ tone: 'err', text: '先把 Cookie 粘贴到输入框。' })
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
              setMessage({ tone: 'ok', text: '已保存' + (data.username ? '（账号 ' + data.username + '）' : '') + '。' })
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
        navigator.clipboard.readText().then(
          function (text) {
            if (!text) {
              setMessage({ tone: 'err', text: '剪贴板是空的。' })
              return
            }
            setInput(text.trim())
            setMessage({ tone: 'info', text: '已粘贴，检查一下再点保存。' })
          },
          function () {
            setMessage({ tone: 'err', text: '读剪贴板被拒绝，请用 Ctrl+V 粘贴。' })
          }
        )
      }

      function copySnippet() {
        request('/snippet', { method: 'GET' }).then(function (data) {
          var text = (data && data.snippet) || ''
          if (!text) {
            setMessage({ tone: 'err', text: '拿不到控制台片段。' })
            return
          }
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
              function () {
                setMessage({ tone: 'info', text: '控制台片段已复制，粘到 greasyfork.org 的 Console 里运行。' })
              },
              function () {
                setMessage({ tone: 'err', text: '复制失败，可手动打开 ' + API + '/snippet' })
              }
            )
          } else {
            setMessage({ tone: 'err', text: '这个环境不允许写剪贴板，可手动打开 ' + API + '/snippet' })
          }
        })
      }

      function verify() {
        setBusy('verify')
        setMessage({ tone: 'info', text: '正在校验…' })
        request('/verify', { method: 'POST' })
          .then(function (data) {
            if (data && data.ok === false) {
              setMessage({ tone: 'err', text: data.message || '校验失败。' })
              return
            }
            applyStatus(data)
            setMessage({ tone: data && data.valid ? 'ok' : 'err', text: data && data.valid ? '凭证有效。' : '凭证已失效，请重新获取。' })
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
      var running = capture && capture.state === 'running'
      var cookieNames = (status && status.cookie && status.cookie.names) || []

      return h(
        'div',
        { className: 'gfs-root' },
        h('h2', { className: 'gfs-title' }, 'GreasyFork'),

        // ── 状态条 ──────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h(
            'div',
            { className: 'gfs-between' },
            h(
              'div',
              { className: 'gfs-row' },
              status.loading
                ? h(Badge, { tone: 'idle', spin: true }, '读取中')
                : configured
                  ? valid
                    ? h(Badge, { tone: 'ok' }, '已连接')
                    : h(Badge, { tone: 'bad' }, '凭证已失效')
                  : h(Badge, { tone: 'idle' }, '未配置'),
              h('span', { className: 'gfs-name' }, (status && status.username) || (configured ? '账号未知' : '还没有凭证'))
            ),
            h(
              'div',
              { className: 'gfs-row' },
              h('button', { className: 'gfs-btn', onClick: function () { refresh(true) } }, '刷新'),
              h('button', { className: 'gfs-btn', disabled: !configured || busy !== '', onClick: verify }, '校验'),
              h('button', { className: 'gfs-btn', disabled: !configured || busy !== '', onClick: clear }, '清除')
            )
          ),
          configured ? h('div', { className: 'gfs-sub' }, 'Cookie：' + (cookieNames.join('、') || '已保存')) : null,
          status && status.error ? h(Message, { message: { tone: 'err', text: status.error.message } }) : null
        ),

        // ── 自动获取 ────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h(
            'div',
            { className: 'gfs-between' },
            h('span', { className: 'gfs-name' }, '自动获取'),
            h('span', { className: 'gfs-sub' }, '不用装油猴脚本')
          ),
          running
            ? h(
                'div',
                { className: 'gfs-between' },
                h(Badge, { tone: 'run', spin: true }, '等待登录 · ' + Math.round((capture.elapsedMs || 0) / 1000) + 's'),
                h('button', { className: 'gfs-btn', onClick: cancelCapture }, '取消')
              )
            : h(
                'button',
                { className: 'gfs-primary', disabled: busy === 'capture', onClick: startCapture },
                busy === 'capture' ? '正在打开浏览器…' : configured ? '重新获取（打开浏览器）' : '打开浏览器登录并自动获取'
              ),
          h('div', { className: 'gfs-sub' }, running ? '在新窗口里登录 greasyfork.org，登录完成后这里会自动变绿。' : '会打开一个浏览器窗口，登录一次后长期有效。'),
          h(Message, { message: message }),
          h(
            'details',
            { className: 'gfs-details' },
            h('summary', null, '它是怎么拿到 Cookie 的？'),
            h(
              'div',
              { className: 'gfs-sub', style: { marginTop: '8px' } },
              'GreasyFork 的登录 Cookie 是 HttpOnly，页面脚本和 DevTools 控制台都读不到；新版 Chrome/Edge 的 Cookie 库又用 App-Bound 加密，外部程序解不开。所以插件用调试端口启动一个浏览器，登录后由浏览器自己把 Cookie 报给插件——全程不需要装任何脚本。'
            )
          )
        ),

        // ── 手动 ────────────────────────────────────────────────
        h(
          'div',
          { className: 'gfs-card' },
          h(
            'details',
            { className: 'gfs-details' },
            h('summary', null, '手动填入（备选）'),
            h(
              'div',
              { className: 'gfs-sub', style: { marginBottom: '10px' } },
              '登录 greasyfork.org 后：F12 → Application → Cookies → https://greasyfork.org，复制 _greasyfork_session 的值（有 cf_clearance 也一起），拼成一行粘进来。'
            ),
            h('textarea', {
              className: 'gfs-textarea',
              placeholder: '_greasyfork_session=…; cf_clearance=…',
              value: input,
              spellCheck: false,
              onChange: function (e) {
                setInput(e.target.value)
              }
            }),
            h(
              'div',
              { className: 'gfs-row', style: { marginTop: '10px' } },
              h('button', { className: 'gfs-btn', onClick: pasteFromClipboard }, '从剪贴板粘贴'),
              h('button', { className: 'gfs-btn', onClick: copySnippet }, '复制控制台片段'),
              h('button', { className: 'gfs-btn', disabled: busy === 'save', onClick: saveCredential }, '保存并校验')
            )
          )
        ),

        h('div', { className: 'gfs-foot' }, '凭证位置：' + ((status && status.storage) || '—') + '（0600，不进配置与日志）')
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
