# dsh-greasyfork

把用户脚本**像 `git push` 一样**推到 GreasyFork 的 DeepSeek Harness 插件：AI 调一次工具就完成"新建脚本 / 发布新版本"，返回脚本页面链接、版本号与发布状态。

- 4 个模型可调用的工具：`greasyfork_auth` / `greasyfork_preflight` / `greasyfork_push` / `greasyfork_status`
- 发布前做与站点一致的元数据校验、版本递增检查、namespace 变更检查，并输出可审阅的发布摘要
- 凭证一次性配置，存在 `~/.dsh/greasyfork/credentials.json`（0600），不进配置、不进日志、不进对话
- 零运行时依赖（只用 Node 内置 `fetch` / `FormData`），同一套核心同时供插件与 CLI 使用
- 覆盖失败场景：会话失效、Cloudflare 挑战、人机验证、账号限制、版本冲突、元数据错误，每种都有可操作提示

---

## 1. 调研结论

### 1.1 DeepSeek Harness 的插件机制（本机 0.1.5-rc.x）

| 事实 | 依据 / 影响 |
| --- | --- |
| profile 目录 = `~/.dsh/profiles/<name>/`，`package.json` 里的 `dsh.profile.bundles` 是**有序的补丁层栈** | 插件必须作为 bundle 加入这个列表才会被加载 |
| bundle = 一个 npm 包 + `package.json` 里的 `dsh.bundle.patch` 指向 `cordis.patch.yml` | 本包的 `cordis.patch.yml` 只有一行 `insert`，插入 id 为 `greasyfork` 的插件行 |
| 插件 = cordis 插件：`export const name` / `inject` / `apply(ctx, config)` | `inject = ['tools']`，凭证服务用 `ctx.get('credentials')` 按需取，缺了也能跑 |
| `ctx.tools.register(definition)` **注册即对模型可见**，不需要在 agent preset 里加白名单 | 工具 schema 会进入系统提示 |
| `ToolDefinition` 需要 `name` / `description` / `parameters`(JSON Schema) / `output.schema` / `output.render` / `execute(args, exec)` | 本插件按这个形状手写定义，不 import `@deepseek-ai/dsh-tools` |
| 凭证服务 `ctx.credentials` 由 `dsh-credentials-local` 提供，默认存 `~/.dsh/.credentials.yaml` | 可作为凭证来源之一（见 3.3） |
| `desktop` profile 由 Electron 独占，`dsh plugin --profile desktop …` 会被拒绝 | 桌面版要走"直接改 profile 的 package.json + pnpm install" |
| `dsh plugin --profile <p> add <spec>` = 转发 pnpm + 按安装结果回填 `bundles` | web profile 用一条命令即可 |
| 浏览器侧界面靠 `package.json` 的 `dsh.client` + `exports["./client"]` 发现，产物是 `window.__ModuleLoader__.load({ id, factory })` 形式的普通脚本（`require("react")` 由宿主提供） | 设置页面板据此实现，不打包 React、不用构建工具 |
| 设置页用槽位扩展：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name, id, order, label }, Component))` | 本插件注册 id=`greasyfork` 的设置区 |
| 宿主 HTTP 面：`ctx.webServer.register({ kind:"exact", path, handler })`，`ctx.webServer.port` 读监听端口 | 设置页的 `/api/greasyfork/*` 路由 |

**为什么工具定义是手写的**：插件装在 profile 的 `node_modules` 里，`@deepseek-ai/*` 不保证能从这里解析到；一旦 `import` 失败，整个插件不会加载。手写 JSON Schema 换来的是"装哪都能跑"。

### 1.2 GreasyFork 的发布约束（2026-11 核对源码与线上行为）

| 事实 | 依据 |
| --- | --- |
| **没有写接口**。官方帮助页明确写 "While there is no API for updates" | <https://greasyfork.org/en/help/api> |
| 新建脚本 = `POST /:locale/script_versions`；发布新版本 = `POST /:locale/scripts/:id/versions` | `script_versions_controller.rb#create` + `config/routes.rb` |
| 鉴权是 Rails cookie session，cookie 名 `_greasyfork_session`（`cookie_store`） | `config/initializers/session_store.rb` |
| 所有写请求都要 `authenticity_token`（全局 CSRF，非 per-form） | 无 `per_form_csrf_tokens`；未带 token 的 POST 返回 **422 空响应**（已实测） |
| 脚本名称/描述/版本**来自代码元数据块**，不是单独表单字段 | `create` 里 `calculate_all` / `apply_from_script_version` |
| 站点校验：`@name`、`@description`、`@match`/`@include`、代码 ≥ 20 字符、≤ 2 MB、`//@key` 缺空格算非法指令、元数据块之外必须有可执行代码 | `script_version.rb` / `script.rb` |
| 9 类"告警"以复选框覆盖才放行：版本未递增、缺版本、缺 namespace、namespace 变更、疑似压缩、敏感站点、代码曾发布过、缺 license、meta 不在开头 | `script_version.rb#warnings` + `_form.html.erb` |
| 新建脚本对新账号可能要求 **reCAPTCHA**；**更新不需要** | `recaptcha_ok = !@script.new_record? || …` |
| 账号限制会渲染独立页面：未验证邮箱 / 新账号限流 / 需要安全登录 / 临时邮箱 | `UserRestrictionService#new_script_restriction` |
| 生产站点前面有 **Cloudflare**；JSON 接口（`api.greasyfork.org`）通常不被挑战，HTML 表单页可能被挑战 | 实测：`/scripts/1.json` 200，`/scripts/search` 403 "Just a moment…" |
| 官方降级通道：`POST /:locale/script_versions/prefill`（显式跳过 CSRF），把代码预填进表单 | help/api + `skip_before_action :verify_authenticity_token, only: :prefill` |
| 支持从 URL 同步：脚本带 `sync_identifier`，`PATCH /:locale/scripts/:id/sync_update` 可立即拉取 | `scripts_controller.rb#sync_update`（`update-and-sync=1`） |

**结论**：想"一次触发就完成发布"，唯一可行路径是**带着用户会话 Cookie 直接提交网页表单**；浏览器自动化或"官方 API"都不存在。人机验证只可能拦"新账号首次新建"，更新路径可以做到 100% 自动。

---

## 2. 安装

前置：Node ≥ 20，profile 已存在（跑过一次 `dsh --profile web` 或桌面版启动过）。

### 2.1 web profile（一条命令）

```bash
# 在插件目录（本 README 所在目录）里
node scripts/install.mjs --profile web
```

它做三件事：给 `~/.dsh/profiles/web/package.json` 加依赖 `"dsh-greasyfork": "file:<本目录>"`、把 `dsh-greasyfork` 加进 `dsh.profile.bundles`、在 profile 里跑 `pnpm install`。

也可以直接用官方命令（效果等价）：

```bash
dsh plugin --profile web add "file:C:/path/to/dsh-greasyfork"
```

### 2.2 桌面版（desktop profile）

桌面版的 profile 由 Electron 独占，CLI 会拒绝操作它，所以用脚本直接改（脚本对 desktop 同样适用）：

```bash
node scripts/install.mjs --profile desktop
```

然后**完全退出桌面应用再启动**（新增依赖需要重新解析模块；只改 `cordis.patch.yml` 才会热重载）。

### 2.3 卸载

```bash
node scripts/install.mjs --profile web --uninstall
```

### 2.4 验证安装

重启后，在对话里让 AI 调用：

```
greasyfork_auth(action="status")
```

返回 `configured: false` 说明插件已加载、只差凭证。

同时 **设置 → GreasyFork** 会出现配置区（左侧导航里的独立分区）；那里是配凭证最省事的地方。

---

## 3. 配置凭证（一次性）

配置有三个入口，任选其一即可，写的是同一个存储：

| 入口 | 适合 | 见 |
| --- | --- | --- |
| **设置页 → GreasyFork**（图形界面） | 想点几下就配好 | 3.0 |
| CLI `auth set --stdin` | 不想把 Cookie 带进对话 | 3.2 |
| 工具 `greasyfork_auth(action="set")` | 交给 AI 代劳 | 3.2 |

### 3.0 在 Harness 设置页里配置（推荐）

安装并重启后，**设置 → GreasyFork** 会多出一个配置区。主按钮是「打开浏览器登录并自动获取」，**不需要安装任何油猴脚本**：

1. 点按钮 → 插件用调试端口启动一个浏览器窗口，打开 GreasyFork 登录页
2. 你在那个窗口里正常登录（首次需要，之后长期有效）
3. 登录一完成，插件自己把 `_greasyfork_session` 读回来、校验、保存，面板自动变绿

浏览器用的是固定的专用 profile：`~/.dsh/greasyfork/browser-profile`。所以只有**第一次**要登录，之后每次都是秒级完成；这个 profile 和你日常用的浏览器互不影响。

**为什么不能直接读你正在用的浏览器？**（本机实测，三条路都堵死）

| 方案 | 结果 |
| --- | --- |
| 页面 JS / DevTools 控制台 `document.cookie` | 读不到：`_greasyfork_session` 带 `HttpOnly` |
| 直接解 Chrome/Edge 的 Cookie 数据库 | 读不到：Chrome/Edge 127+ 改成 App-Bound 加密（本机 1383 条 cookie 全是 `v20`），DPAPI 解不开，`browser_cookie3` 这类库在新版上直接失效 |
| Electron 的 `session.cookies` | 不可用：dsh 宿主是 Electron 主进程 spawn 出来的**子 Node 进程**，插件里 `import('electron')` 拿不到 |

所以走 DevTools Protocol：**由插件启动的浏览器**自己把 Cookie 报给插件（`Network.getAllCookies`，HttpOnly 也会返回）。这是唯一"零脚本"的自动化路径。

> 备选：面板里还留着「手动填入」（DevTools → Application → Cookies 复制），以及给已经装了用户脚本管理器的人用的助手脚本通道（`GM_cookie`）。两条都不影响主流程。

设置页里的每个动作都打到宿主路由（`/api/greasyfork/*`）：

| 路由 | 作用 |
| --- | --- |
| `GET /api/greasyfork/status` | 凭证状态、来源、账号、Cookie 名（不含值）、采集进度 |
| `POST /api/greasyfork/capture/start` | 启动浏览器并开始自动采集 |
| `GET /api/greasyfork/capture/status` | 采集进度（running / done / timeout / error） |
| `POST /api/greasyfork/capture/cancel` | 取消采集并关掉那个浏览器 |
| `POST /api/greasyfork/credential` | 校验并保存手动填入的 Cookie |
| `POST /api/greasyfork/beacon` | 助手脚本回传 Cookie（需 `token`，仅本机 UI 可见） |
| `POST /api/greasyfork/verify` / `clear` | 重新校验 / 删除本地凭证 |
| `POST /api/greasyfork/open-login` | 用系统默认浏览器打开登录页 |
| `GET /api/greasyfork/helper.user.js` | 生成并下发助手脚本（token 校验） |
| `GET /api/greasyfork/snippet` | 控制台片段 |

除 `/beacon`（跨源但要求 `token`）之外，其余路由都只按同源使用，**不返回 CORS 头**——否则任意网页都能读到 `helperToken` 并覆盖你的凭证。

> **1.1.0 面板显示 `not found` 的原因**：那版在 `apply()` 里直接 `ctx.get('webServer')`，此时 webServer 服务往往还没就绪，路由静默没注册，请求落到了 SPA 的 404。现在改成 `ctx.inject(['webServer'], …)`，服务就绪后再挂路由，并有回归测试守着（`test/plugin.test.js`）。

### 3.1 拿到 Cookie（手动方式的细节）

1. 浏览器登录 <https://greasyfork.org>
2. F12 → **Application / 存储 → Cookies → https://greasyfork.org**
3. 复制 `_greasyfork_session` 的值；如果列表里有 `cf_clearance`，一起复制（更不容易被 Cloudflare 挑战）
4. 拼成一行：`_greasyfork_session=…; cf_clearance=…`

> 也可以：Network 面板 → 任意一个请求 → Request Headers → 整行 `Cookie:` 复制，插件会自动清理格式。

### 3.2 三种保存方式

```bash
# 推荐：从标准输入粘贴，不经过对话记录、不进 shell 历史
node lib/cli.js auth set --stdin

# 或从文件读
node lib/cli.js auth set --cookie-file ./cookie.txt

# 或交给 AI（会把值写进本次对话，谨慎）
greasyfork_auth(action="set", cookie="_greasyfork_session=…")
```

保存前会先打一次"登录校验"，Cookie 不对直接拒绝保存，避免存进去一个废值。

### 3.3 存储位置与读取顺序

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | 单次调用参数 `cookie` | 只用于"就这一次"，不落盘 |
| 2 | 环境变量 `GREASYFORK_COOKIE` | 适合 CI / 不想落盘 |
| 3 | harness 凭证服务记录 `greasyfork/cookie` | 如果你更喜欢产品自带的存储（`~/.dsh/.credentials.yaml`） |
| 4 | harness 凭证服务键 `GREASYFORK_COOKIE` | 同上 |
| 5 | **`~/.dsh/greasyfork/credentials.json`（0600）** | 默认写入位置，CLI 与插件共用 |

`~/.dsh` 可用环境变量 `DSH_HOME` 改。

### 3.4 安全边界（如实说明）

- Cookie **不写进 cordis 配置**（配置会被 `--dump-config`、被 UI 展示、可能进日志），只进上面那个 0600 文件或环境变量。
- 所有工具返回值、错误信息、日志里只有 **cookie 名列表**（`_greasyfork_session` / `cf_clearance`），没有值；有测试专门断言这一点（`test/plugin.test.js`）。
- 局限：agent 的工具进程以**同一个 OS 用户**运行，所以这个文件挡不住同用户的其它进程 —— 文件权限只能防"别的用户"和"误提交到 git"。要更强隔离，就把 Cookie 放环境变量、并只在需要时导出。
- 失效/轮换：在 GreasyFork 修改密码或退出登录后重新导出覆盖即可；`auth clear` 删除本地副本。

---

## 4. 工具 API

### `greasyfork_auth`

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `action` | `status` \| `set` \| `verify` \| `clear` | 默认 `status` |
| `cookie` | string | `set` 时必填 |

返回：`configured` / `valid` / `source` / `username` / `cookie`(仅名字) / `storage`。

### `greasyfork_preflight`（只读）

| 参数 | 说明 |
| --- | --- |
| `file` | 本地脚本路径（相对路径以会话工作目录为基准） |
| `code` | 直接给内容（与 `file` 二选一，同时给以 `code` 为准） |
| `scriptId` | 更新场景：脚本 id 或脚本 URL |
| `scriptType` | `public`（默认）/ `unlisted` / `library` |
| `language` | `js` / `css`，默认按扩展名推断 |

返回：`summary`（名称/版本/描述/匹配规则/体积/线上现状）、`errors`、`warnings`、`ready`。没配凭证时会退化成"纯本地校验"（`offline: true`）。

### `greasyfork_push`

在 preflight 的基础上增加：

| 参数 | 说明 |
| --- | --- |
| `changelog` | 更新说明 |
| `dryRun` | `true` 只返回摘要，不发布 |
| `mode` | `auto`（默认）/ `create` / `update` / `prefill` / `sync` |
| `acceptWarnings` | `true` 时自动带上站点要求的覆盖项重试一次 |
| `overrides` | 精确指定覆盖项：`versionCheckOverride`、`addMissingVersion`、`namespaceCheckOverride`、`addMissingNamespace`、`minifiedConfirmation`、`sensitiveSiteConfirmation`、`allowCodePreviouslyPosted`、`licenseMissingOverride`、`metaNotAtStartConfirmation` |
| `force` | 代码与版本都没变时仍然发布 |
| `syncIdentifier` / `syncType` | 新建时把来源 URL 记进 GreasyFork（配合 sync 模式实现站点自动拉更新） |
| `localeId` | 脚本默认语言 locale id（可省略） |
| `cookie` | 仅本次调用使用的 Cookie |

成功返回：`action`（`created` / `updated`）、`scriptId`、`url`、`version`、`previousVersion`、`visibility`、`warnings`、`appliedOverrides`。

### `greasyfork_status`（只读，不需要凭证）

| 参数 | 说明 |
| --- | --- |
| `scriptId` | 脚本 id 或 URL（必填） |

返回：`name` / `version` / `url` / `description` / `authors` / `versions`（最近 10 个）。

---

## 5. 使用示例

### 5.1 场景 A：首次发布

对话里：

> 把 `examples/demo.user.js` 发到 GreasyFork。

AI 会先 `greasyfork_preflight(file="examples/demo.user.js")`，把摘要贴给你，然后 `greasyfork_push(file="examples/demo.user.js")`。

手动等价：

```bash
node lib/cli.js preflight --file examples/demo.user.js
node lib/cli.js push      --file examples/demo.user.js
```

返回：

```json
{
  "ok": true,
  "action": "created",
  "status": "published",
  "scriptId": 123456,
  "url": "https://greasyfork.org/en/scripts/123456-demo-script",
  "version": "1.0.0",
  "visibility": "public"
}
```

### 5.2 场景 B：更新已有脚本

```bash
# 先看一眼线上现状
node lib/cli.js status --script-id 123456

# 预检：会比对线上最新版本，检查版本号有没有递增、namespace 有没有变
node lib/cli.js preflight --file examples/demo-update.user.js --script-id 123456

# 发布新版本
node lib/cli.js push --file examples/demo-update.user.js --script-id 123456 \
  --changelog "徽标改为可点击链接"
```

对话里则是：

> 把 demo-update.user.js 作为新版本推到脚本 123456，更新说明写"徽标改为可点击链接"。

> 更新时如果没显式传 `scriptType`，插件会沿用线上脚本原本的可见性（public/unlisted/library），不会把 unlisted 脚本悄悄改成公开。

### 5.3 场景 C：先看后发（避免误发）

```
greasyfork_push(file="examples/demo.user.js", dryRun=true)
```

只返回将要发布的摘要（名称、版本、描述、匹配规则、体积、线上现状、阻塞项/告警），不发任何请求。

### 5.4 场景 D：GitHub 托管 + 站点自动同步

如果脚本代码放在 GitHub（`https://raw.githubusercontent.com/...`）：

```
greasyfork_push(file="dist/demo.user.js",
                syncIdentifier="https://raw.githubusercontent.com/u/r/main/demo.user.js",
                syncType="manual")
```

首次发布后，以后只需要：

```
greasyfork_push(scriptId=123456, mode="sync",
                syncIdentifier="https://raw.githubusercontent.com/u/r/main/demo.user.js")
```

GreasyFork 会自己从那个 URL 拉代码生成新版本 —— 这才是真正意义上的"站点侧自动更新"。

### 5.5 场景 E：被人机验证拦住

新账号首次**新建**脚本时可能遇到 reCAPTCHA。此时 `greasyfork_push` 返回 `E_RECAPTCHA` 并给出降级路径：

```
greasyfork_push(file="examples/demo.user.js", mode="prefill")
```

插件把代码 POST 到官方的 prefill 接口，返回表单地址；你在浏览器打开、点一次「发布」即可。**之后的每次更新都不需要验证码**。

---

## 6. 错误码

| code | 含义 | 处理 |
| --- | --- | --- |
| `E_NO_CREDENTIAL` | 没配凭证 | `auth set --stdin` |
| `E_AUTH_EXPIRED` | 会话失效 | 重新登录并覆盖 Cookie |
| `E_CLOUDFLARE` | 被 Cloudflare 挑战 | 导出含 `cf_clearance` 的完整 Cookie；先在浏览器通过一次验证 |
| `E_RATE_LIMITED` | 发布频率限制 | 稍后再发 |
| `E_NOT_AUTHOR` | 不是该脚本作者 | 换账号 / 确认 scriptId |
| `E_CSRF` | CSRF 令牌无效 | 重试一次；仍失败就更新 Cookie |
| `E_VALIDATION` | 元数据/代码校验失败 | 按 `errors` 修；带 override 的看 `neededOverrides` |
| `E_VERSION_CONFLICT` | 版本未递增 | 递增 `@version`，或 `acceptWarnings=true` |
| `E_NO_CHANGES` | 代码与版本都没变 | 改代码/升版本；确要重发用 `force=true` |
| `E_RECAPTCHA` | 新建时人机验证 | `mode="prefill"` 或先发一次已有脚本 |
| `E_RESTRICTED` | 账号状态不允许发脚本 | 按 `hint` 在网页完成邮箱/安全登录验证 |
| `E_SOURCE_MISSING` / `E_SOURCE_EMPTY` | 文件不存在 / 为空 | 检查路径 |
| `E_SCRIPT_NOT_FOUND` | 线上没有该脚本 | 确认 id/URL；首次发布别传 scriptId |
| `E_NETWORK` / `E_TIMEOUT` | 网络问题 | 重试或调大 `timeoutMs` |
| `E_STORAGE` | 凭证文件读写失败 | 检查 `~/.dsh/greasyfork` 权限 |

---

## 7. 平台限制与降级方案（如实说明）

| 限制 | 影响 | 本插件的处理 |
| --- | --- | --- |
| GreasyFork 无写接口 | 只能提交网页表单 | 带会话 Cookie 直接 POST 表单，效果与网页点"发布"一致 |
| CSRF + Cloudflare | 裸请求会被 422 / 403 | 自动抓 CSRF；识别挑战并给出"补 `cf_clearance`"的明确指引 |
| 新账号新建脚本可能要求 reCAPTCHA | 无法在纯 HTTP 里完成 | 返回 `E_RECAPTCHA` + `mode="prefill"` 降级（表单预填，只需点一次） |
| 站点可能对新脚本做人工/自动审核 | 发布后不一定立刻公开列出 | 返回 `status: "published"` + 页面链接，审核状态以站点为准 |
| 桌面版 profile 被 Electron 独占 | `dsh plugin` 拒绝操作 | `scripts/install.mjs --profile desktop` 直接改 profile |
| 账号限制（未验证邮箱/限流/临时邮箱） | 表单页渲染限制页而非表单 | 识别为 `E_RESTRICTED` 并指出具体原因 |
| 无浏览器可用时 | 无法"过验证码" | 诚实的降级：prefill + 一次点击；或配合 `dsh-browser-bridge` 这类浏览器插件点那一下 |

---

## 8. 测试

```bash
# 全量（84 个用例，离线，不需要账号）
npm test

# 线上只读冒烟（只读公开 JSON，不登录不写）
GREASYFORK_LIVE=1 npm run test:live
```

覆盖：

| 测试文件 | 内容 |
| --- | --- |
| `test/version.test.js` | `split_version` / `compare_versions` 与 GreasyFork 源码逐位对齐（含 `1.6a < 1.6` 这类边界） |
| `test/meta.test.js` | 元数据解析、本地化名、`//@key` 非法写法、9 类告警的 override 映射、版本冲突判定 |
| `test/credentials.test.js` | 0600 写入、来源优先级、凭证服务异常时降级、无 `_greasyfork_session` 拒收 |
| `test/publish.test.js` | **本地仿真 GreasyFork**（`test/mock-greasyfork.mjs`）上的端到端：新建、更新、可见性沿用、版本冲突重试、reCAPTCHA、prefill、会话失效、Cloudflare、dry-run、sync |
| `test/plugin.test.js` | 用最小 cordis ctx 桩跑 `apply()`：4 个工具注册、schema 形状、工具级端到端、"输出不含 Cookie 原文"断言 |
| `test/settings.test.js` | 设置页宿主路由：状态/保存/校验失败不落盘/beacon token 校验/助手脚本内容与 token/清除/CORS 预检 |
| `test/browser.test.js` | 浏览器采集：候选路径、超时/取消/启动失败、**对着仿真 CDP 服务真跑一遍 WebSocket + `Network.getAllCookies`**（含 HttpOnly 与 Storage 回退） |
| `test/client.test.js` | 在 `vm` 里加载 `lib/client.js`（假 React + 假 slots）：注册 `settings.section`、id/label 正确、面板能渲染出两种获取方式、无 slots 时安静退出 |
| `test/live-readonly.test.js` | 线上只读冒烟（默认跳过） |

### 真实发布测试（有风险，务必用测试账号）

```bash
# 1) 用**测试账号**登录 greasyfork.org，导出它的 Cookie
node lib/cli.js auth set --stdin

# 2) 先 dry-run 确认摘要
node lib/cli.js push --file examples/demo.user.js --dry-run

# 3) 真的发（会创建一个公开脚本，事后请在网页上删除）
node lib/cli.js push --file examples/demo.user.js
```

风险提示：

- 发布是**真实、公开、不可静默撤销**的动作（删除需要去网页操作，且可能留痕）。
- 同一账号短时间内重复新建可能触发限流甚至风控，别拿主账号做循环测试。
- 建议：测试账号 + `scriptType=unlisted`（不公开列出）+ 测完删除。

---

## 9. 设计取舍

1. **直接提交表单，而不是驱动浏览器**：不依赖 Playwright/Chromium，能在 harness 进程内同步完成；代价是依赖 Cookie 与 CSRF，并且对 Cloudflare 敏感。
2. **prepare / execute 两阶段**：`dryRun` 不是附加功能，而是流程里必然存在的一步——"发布前展示摘要"由结构保证。
3. **在本地复刻站点校验**：把 `split_version`/`compare_versions`、告警 → override 的映射搬到 JS，让"版本没递增""namespace 变了"在发请求之前就暴露，而不是靠站点 200 页面回吐错误。
4. **告警不静默覆盖**：默认把告警摊开给用户；只有显式 `acceptWarnings` 才带覆盖项，且只重试一次。
5. **凭证不进程内加密**：加密没有意义（密钥也在同一台机器、同一用户），不如老实放 0600 文件 + 环境变量，并把"能读到它的边界"写清楚。
6. **零 `@deepseek-ai/*` 依赖**：插件在 profile 的 `node_modules` 里运行，解析不到 harness 内部包就会整插件挂掉；手写 JSON Schema 换来可移植性。
7. **prefill 作为降级而非伪装**：做不到 100% 自动时，明确说清楚"还差一次点击"，而不是让用户以为失败了。
8. **保留 sync 模式**：对 GitHub 托管脚本，GreasyFork 自己的同步机制比我们刷表单更"原生"，值得作为一等公民支持。

---

## 10. 目录结构

```
.
├── package.json            # dsh.bundle.patch → cordis.patch.yml；dsh.client → exports["./client"]
├── cordis.patch.yml        # 插入 id=greasyfork 的插件行
├── lib/
│   ├── index.js            # 插件入口：4 个工具 + 配置 + 凭证接线 + 设置页路由
│   ├── client.js           # 设置页（浏览器半边）：设置 → GreasyFork 配置区
│   ├── settings.js         # 设置页宿主半边：/api/greasyfork/* 路由 + 采集状态机
│   ├── cli.js              # CLI：auth / status / preflight / push
│   └── core/
│       ├── client.js       # GreasyFork HTTP 客户端（cookie 罐、CSRF、表单、prefill、sync）
│       ├── meta.js         # 元数据解析 + 站点规则校验
│       ├── version.js      # split_version / compare_versions 移植
│       ├── publish.js      # prepare → execute 编排
│       ├── browser.js      # 不用油猴脚本的采集：启动调试端口浏览器 + CDP 读 Cookie
│       ├── credentials.js  # 凭证解析与 0600 存储
│       └── errors.js       # 错误码 + 处理建议
├── scripts/install.mjs     # 安装进任意 profile（含 desktop）
├── scripts/capture-selftest.mjs  # 一条命令自测"浏览器自动获取"是否可用
├── examples/               # 示例脚本（首次发布 / 更新）
└── test/                   # 84 个离线用例 + 本地 GreasyFork 仿真
```

---

## 11. 配置项（可选）

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: greasyfork
  name: 'dsh-greasyfork'
  config:
    site: https://greasyfork.org
    apiSite: https://api.greasyfork.org
    locale: en                 # 表单/页面语言，影响返回的脚本 URL
    timeoutMs: 30000
    defaultScriptType: public  # public | unlisted | library
    mirrorCredentialToStore: false  # true 时额外镜像一份到 harness 凭证服务
```

License: MIT
