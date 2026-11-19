# dsh-greasyfork

Publish userscripts to GreasyFork from DeepSeek Harness the way you push to GitHub: one tool call creates a script or ships a new version, and returns the script URL, version and status.

Chinese documentation (full research notes, install paths, credential handling, error table, test plan): **[README.zh.md](README.zh.md)**

## What it gives the model

| Tool | Purpose |
| --- | --- |
| `greasyfork_auth` | credential status / one-time `set` / `verify` / `clear` |
| `greasyfork_preflight` | read-only: parse `==UserScript==` metadata, apply GreasyFork's own validation rules, compare against the live version |
| `greasyfork_push` | create a script or publish a new version; `dryRun`, `acceptWarnings`, `mode=prefill|sync` |
| `greasyfork_status` | read-only script + version history lookup (no credential needed) |

## Why form POSTs

GreasyFork has **no write API** (its own help page says so). Publishing is a Rails form POST:

- `POST /:locale/script_versions` — create
- `POST /:locale/scripts/:id/versions` — new version
- `POST /:locale/script_versions/prefill` — official degraded path (skips CSRF)
- `PATCH /:locale/scripts/:id/sync_update` — pull code from a `sync_identifier` URL

So the plugin carries your session cookie (`_greasyfork_session`), scrapes the CSRF token from the real form page, and submits exactly what the browser would. Script name/description/version come from the code's metadata block — which is why preflight validates it locally first.

## Install

```bash
node scripts/install.mjs --profile web        # or --profile desktop
```

Then restart dsh (desktop app: fully quit and relaunch).

## Configure once (Settings → GreasyFork)

After install, **Settings → GreasyFork** adds a panel with two ways to get the credential:

- **Browser login + helper script** — opens the GreasyFork login page in your default browser, then installs a tiny userscript (`GM_cookie`) that copies the cookie to your clipboard and posts it back to the plugin; the panel flips to "configured" within seconds. A userscript is required because `_greasyfork_session` is **HttpOnly** (console `document.cookie` cannot see it, and modern Chrome/Edge cookie DBs are App-Bound encrypted).
- **Manual paste** — textarea, clipboard button, and a DevTools snippet (honestly labelled: it only sees non-HttpOnly cookies).

The panel talks to `/api/greasyfork/*` host routes (status / credential / beacon / verify / clear / open-login / helper.user.js / snippet).

## Configure once (CLI)

```bash
node lib/cli.js auth set --stdin
```

Paste `_greasyfork_session=…; cf_clearance=…` from a logged-in browser tab. It is verified before being saved to `~/.dsh/greasyfork/credentials.json` (mode 0600). Alternative sources, in priority order: tool argument → `GREASYFORK_COOKIE` env → harness credential store → that file.

The cookie value never appears in tool output, logs or errors — only cookie *names*. A test asserts this.

## Use

```bash
node lib/cli.js push --file examples/demo.user.js                 # first publish
node lib/cli.js push --file examples/demo-update.user.js --script-id 123456 --changelog "…"
node lib/cli.js push --file examples/demo.user.js --dry-run       # preview only
```

In chat: `greasyfork_push(file="examples/demo.user.js")`, or `greasyfork_preflight` first to see the summary.

## Test

```bash
npm test                              # 64 offline cases incl. a local GreasyFork simulator
GREASYFORK_LIVE=1 npm run test:live   # read-only live smoke test
```

## Known limits

- New-account **first** script creation may require reCAPTCHA → `mode="prefill"` leaves one browser click; updates never need it.
- Cloudflare may challenge HTML endpoints → export the full cookie including `cf_clearance`.
- Account restrictions (unverified email, rate limit, disposable email) surface as `E_RESTRICTED` with the concrete reason.
- Desktop profile is owned by Electron, so `dsh plugin` refuses it; `scripts/install.mjs` edits the profile directly.

License: MIT
