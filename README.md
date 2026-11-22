# dsh-greasyfork

把用户脚本像 `git push` 一样推到 [GreasyFork](https://greasyfork.org) 的 DeepSeek Harness 插件。

设置入口：**设置 → GreasyFork**。

## 能做什么

| 工具 | 作用 |
| --- | --- |
| `greasyfork_list` | 列出自己发布的脚本 / 按关键词搜索站内脚本 / 热门 / 库脚本 |
| `greasyfork_status` | 读某个脚本的名称、版本、版本历史、作者、链接（不需要登录） |
| `greasyfork_preflight` | 发布前预检：元数据解析、版本冲突、namespace 变更、体积、@match 数量 |
| `greasyfork_push` | 发布新脚本、发新版本（带 changelog）、`dryRun` 预览、`sync` 让站点从 GitHub 拉更新 |
| `greasyfork_auth` | 凭证状态 / 保存 / 校验 / 清除 |
| `greasyfork_guide` | 内置操作手册 |

命令行同样可用：

```bash
node lib/cli.js auth status
node lib/cli.js preflight --file my.user.js
node lib/cli.js push --file my.user.js --script-type public
node lib/cli.js push --file my.user.js --script-id 123456 --changelog "修复 X"
```

## 凭证：只手动录入，不驱动浏览器

2.0 起彻底移除了「自动开浏览器读 Cookie」那条路 —— 它会和用户自己的窗口抢 profile，还会被 Cloudflare 的 Turnstile 卡住。

现在的流程：

1. 浏览器装 [Cookie-Editor](https://cookie-editor.com/)（或 EditThisCookie）。
2. 登录 `greasyfork.org`。
3. 扩展里点 **Export → JSON**，复制整段内容。
4. 设置 → GreasyFork → 粘贴 → **校验并保存**。

支持的粘贴格式（都会自动识别）：

- Cookie-Editor / EditThisCookie 的 JSON 数组
- JSON 对象 `{ "name": "value" }` 或 `{ "cookies": [...] }`
- Netscape `cookies.txt`（7 列制表符）
- DevTools 请求头里的整行 `Cookie: a=1; b=2`
- 多行 `name=value`
- 单个 `_greasyfork_session=...`

凭证写在 `~/.dsh/greasyfork/credentials.json`（权限 0600），不进配置、不进日志，任何工具输出都不会回显原文。

### 有效期

`_greasyfork_session` 是 Rails 的会话 Cookie，站点不下发过期时间，所以插件显示为「会话型」：
只要不在别的浏览器/设备上重新登录把会话顶掉，它就长期有效。带 `expirationDate` 的导出（如 Cookie-Editor 的 JSON）会显示具体剩余天数。

## 实现要点

- 发布走 GreasyFork 的网页表单（站点没有写接口）：`POST /:locale/script_versions` 与 `POST /:locale/scripts/:id/versions`。
- `script_version[attachments][]` 是 `params.expect` 的必填键，缺失会让站点直接返回 HTTP 500 —— 插件会显式带上空值。
- 站点用 Cloudflare，Node 直连偶尔被挑战；此时校验会明确回报「判断不了」而不是「凭证失效」。

## 开发

```bash
npm test              # 107 个用例，全部离线
npm run dev:sync      # 把 lib/ 同步到 dsh profile
```

## License

MIT
