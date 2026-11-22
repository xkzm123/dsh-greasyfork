/**
 * GreasyFork 操作手册（内置给模型看）。
 *
 * 目的：任何"看我的脚本 / 更新脚本 / 查脚本资料 / 发布"的指令，都直接调本插件的工具，
 * 不要去点浏览器、不要用 UI 自动化——工具已经处理了登录、CSRF、Cloudflare、表单细节。
 */

export const TOPICS = [
  'overview',
  'auth',
  'view',
  'publish',
  'update',
  'sync',
  'prefill',
  'errors',
  'browser',
  'rules'
]

const SECTIONS = {
  overview: `## 一、先看这张表

| 用户想做什么 | 调用 | 说明 |
| --- | --- | --- |
| 看我的账号 / 有没有登录 | \`greasyfork_auth\` action=status | 不发请求，只看本地凭证与校验结果 |
| 看我发布过哪些脚本 | \`greasyfork_list\` scope=mine | 需要登录；返回 id / 名称 / 链接 |
| 搜某个脚本 | \`greasyfork_list\` scope=search query=关键词 | 公开数据，不需要登录 |
| 看热门 / 库脚本 | \`greasyfork_list\` scope=popular 或 libraries | 公开数据 |
| 看某个脚本的资料 | \`greasyfork_status\` scriptId=… | 名称/版本/作者/最近版本/页面链接 |
| 发布一个新脚本 | \`greasyfork_push\` file=…（不带 scriptId） | 会先做本地校验 |
| 给已有脚本发新版本 | \`greasyfork_push\` file=… scriptId=… | 更新不需要人机验证 |
| 只想先看看会发什么 | \`greasyfork_push\` … dryRun=true | 不发写请求 |
| 发布前检查元数据 | \`greasyfork_preflight\` file=… | 纯本地 + 线上版本对比 |
| 换/删凭证 | \`greasyfork_auth\` action=set / clear | set 可传 cookie 或从设置页粘贴 |
| 不知道用哪个 / 报错了 | \`greasyfork_guide\` topic=errors | 错误码与处理 |`,

  auth: `## 二、凭证

- 凭证就是一个 Cookie 头：\`_greasyfork_session=…\`（有 \`cf_clearance\` 也一起存，但**不会**发给 Node）。
- 存储：\`~/.dsh/greasyfork/credentials.json\`（0600），也可用环境变量 \`GREASYFORK_COOKIE\`。
- 优先级：工具参数 > \`GREASYFORK_COOKIE\` > harness 凭证服务 > 上面的文件。
- 采集：设置 → GreasyFork → 「用 <默认浏览器> 登录并获取」；登录窗口会常驻，下次直接复用。
- 校验：\`greasyfork_auth\` action=verify（或设置页「校验」）。\`valid\` 可能是三态：
  \`true\` 有效、\`false\` 失效、\`null\` 暂时判断不了（Node 被 Cloudflare 拦，但浏览器内已确认登录）。
- Cookie 原文永远不会出现在工具输出、日志、错误里，只出现名字。`,

  view: `## 三、查看

### 我的脚本
\`\`\`
greasyfork_list scope="mine" limit=20
\`\`\`
返回每条：\`id\`、\`name\`、\`url\`、\`version\`（能拿到时）。需要登录态。

### 搜索 / 热门 / 库
\`\`\`
greasyfork_list scope="search" query="bilibili"
greasyfork_list scope="popular"
greasyfork_list scope="libraries"
\`\`\`
翻页用 \`page\`（从 1 开始）。

### 单个脚本资料
\`\`\`
greasyfork_status scriptId="595909"
greasyfork_status scriptId="https://greasyfork.org/zh-CN/scripts/595909-xxx"
\`\`\`
返回：名称、线上版本、描述、namespace、license、作者、更新时间、最近 10 个版本。不需要登录。`,

  publish: `## 四、发布新脚本

1. 先看会发什么（可选但推荐）：
   \`\`\`
   greasyfork_preflight file="examples/demo.user.js"
   greasyfork_push file="examples/demo.user.js" dryRun=true
   \`\`\`
2. 真发：
   \`\`\`
   greasyfork_push file="examples/demo.user.js"
   \`\`\`
3. 名称/描述/版本/namespace 都来自脚本的 \`==UserScript==\` 元数据块——不要另外传。
4. 站点判为"告警"（版本未递增、缺 license 等）时，工具会返回 \`neededOverrides\`；
   加 \`acceptWarnings=true\` 重试即可自动带上覆盖项。
5. 新账号首次发布可能撞人机验证 → 返回 \`E_RECAPTCHA\`，此时用 \`mode="prefill"\` 降级：
   插件把代码预填到官方表单，用户在浏览器点一次「发布」。之后所有更新都能全自动。`,

  update: `## 五、更新已有脚本

\`\`\`
greasyfork_push file="script.user.js" scriptId="595909" changelog="修了什么"
\`\`\`
- 更新**不需要**人机验证，也不需要重新填名称/描述。
- 版本号必须比线上大，否则站点会拦；工具会先把线上版本拉下来对比。
- 不想改可见性：不传 \`scriptType\` 就保持原样。
- 只想看会改什么：加 \`dryRun=true\`。`,

  sync: `## 六、从 URL 同步代码

脚本在 GreasyFork 上绑定了 \`@updateURL\` / 同步源时：

\`\`\`
greasyfork_push scriptId="595909" mode="sync" syncIdentifier="https://raw.githubusercontent.com/…/x.user.js" syncType="automatic"
\`\`\`

站点自己去拉代码，插件只触发一次并回报结果。`,

  prefill: `## 七、prefill 降级通道

\`\`\`
greasyfork_push file="x.user.js" mode="prefill"
\`\`\`
- 把代码 POST 到官方 prefill 接口，返回一个"已填好"的表单页地址；
- 用户在那个页面点一次「发布」即可；
- 适用：首次发布撞验证码、或站点要求人工确认时。`,

  errors: `## 八、错误码与处理

| 码 | 含义 | 怎么办 |
| --- | --- | --- |
| \`E_NO_CREDENTIAL\` | 没有凭证 | 设置页采集，或 \`greasyfork_auth\` action=set |
| \`E_AUTH_EXPIRED\` | 会话失效 | 重新登录采集；Cookie 过期或被踢 |
| \`E_CLOUDFLARE\` | Cloudflare 挑战 | 让登录窗口保持运行（设置页「运行自检」），工具会自动改走浏览器通道；仍失败就稍后重试 |
| \`E_CSRF\` | 表单 token 失效 | 重试一次即可（工具会自动重抓 token） |
| \`E_VALIDATION\` | 站点校验不通过 | 看 \`errors\` 字段；版本未递增/缺 license 等 |
| \`E_RECAPTCHA\` | 需要人机验证 | 用 \`mode="prefill"\` |
| \`E_RESTRICTED\` | 账号受限 | 看 message：未验证邮箱 / 限流 / 一次性邮箱 |
| \`E_NOT_AUTHOR\` | 无权改这个脚本 | 不是你的脚本 |
| \`E_RATE_LIMITED\` | 限流 | 等一会儿 |
| \`E_SCRIPT_NOT_FOUND\` | 脚本不存在 | 检查 id |
| \`E_NETWORK\` / \`E_TIMEOUT\` | 网络问题 | 检查代理；代理必须能通 greasyfork.org |`,

  browser: `## 九、浏览器通道（为什么有时候需要它）

Cloudflare 会按 **TLS 指纹**拦非浏览器客户端：同一台机器、同一个 Cookie，
浏览器里 200，Node 的 \`fetch\` 却是 403「Just a moment...」。
实测：\`api.greasyfork.org\`（JSON）不拦，\`greasyfork.org\`（HTML）拦。

所以插件有两条通道：

1. **Node 直连**：读 JSON API（脚本资料、版本历史）没问题；
2. **浏览器内请求**：借已登录的那个受控实例发请求（同源 fetch），Cloudflare 拦不住。
   - 什么时候自动用：登录窗口活着的时候；
   - \`greasyfork_push\` 会**主动拉起**这个窗口（发布是 HTML 表单 POST，Node 必被拦）；
   - 窗口用的是专用 profile \`~/.dsh/greasyfork/browser-profile-<浏览器>\`，和日常浏览器互不影响；
   - 启动时会用保存的 Cookie 回填登录态（Rails 的 session cookie 关掉浏览器就没了）。

**用户不需要手动点浏览器。**`,

  rules: `## 十、硬性规则（给 AI）

1. 收到任何 GreasyFork 相关指令（看我的脚本、更新、发布、查资料、改简介……），
   **直接调本插件的工具**，不要用浏览器自动化去点页面。
2. 不确定用哪个工具 → 先 \`greasyfork_guide\`（不带 topic 返回总览）。
3. 发布前默认先 \`dryRun=true\`，把计划给用户看一眼再真发。
4. 不要把 Cookie 原文写进对话；工具输出里只有名字。
5. 用户说"发不出去/报错" → 先 \`greasyfork_auth\` action=status 看凭证，再看错误码表。
6. 更新脚本必须带 \`scriptId\`；新建脚本不要带。
7. 发布用的文件路径相对当前工作目录；也可以用 \`code\` 直接传脚本源码。`
}

/**
 * 生成手册文本。
 * @param {string} [topic] 章节名；省略则返回总览 + 目录
 */
export function renderGuide(topic) {
  const key = String(topic ?? '').trim()
  if (!key || key === 'all') {
    return [
      '# GreasyFork 插件使用手册',
      '',
      '**规则：所有 GreasyFork 操作都走本插件的工具，不要用浏览器去点页面。**',
      '',
      SECTIONS.overview,
      '',
      '---',
      '',
      '可用章节（`greasyfork_guide topic=…`）：',
      TOPICS.filter((t) => t !== 'overview')
        .map((t) => `- \`${t}\``)
        .join('\n'),
      '',
      '不带 topic 时看到的就是这一页；带上 topic 只返回对应章节。'
    ].join('\n')
  }
  if (!SECTIONS[key]) {
    return `没有章节 ${JSON.stringify(key)}。可用：${TOPICS.join(', ')}`
  }
  return SECTIONS[key]
}

export default { TOPICS, renderGuide }
