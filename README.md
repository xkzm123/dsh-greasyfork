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

After install, **Settings → GreasyFork** adds a panel whose main button is **"Open browser and capture automatically"** — **no userscript required**:

1. The plugin launches a browser with a DevTools port (dedicated profile at `~/.dsh/greasyfork/browser-profile`) on the GreasyFork login page.
2. You log in there (first time only; the profile persists).
3. The plugin reads `_greasyfork_session` over CDP (`Network.getAllCookies`, so HttpOnly included), verifies it, saves it, and closes the browser.

Why not read the browser you already use? `_greasyfork_session` is **HttpOnly** (page JS and DevTools console cannot see it), Chrome/Edge 127+ encrypt their cookie DB with App-Bound Encryption (every cookie on this machine is `v20`, so DPAPI-based tools like `browser_cookie3` no longer work), and Electron's `session.cookies` is out of reach because the dsh host runs in a child Node process, not the Electron main process. A browser the plugin launches is the only zero-script automated path.

Fallbacks kept: manual paste (DevTools → Application → Cookies) and an optional helper userscript (`GM_cookie`) for people who already run Tampermonkey.

Host routes: `/api/greasyfork/{status,capture/start,capture/status,capture/cancel,credential,beacon,verify,clear,open-login,helper.user.js,snippet}`.

Self-test the capture path on your machine with one command:

```bash
node scripts/capture-selftest.mjs --timeout 120
```

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
