# 🔋 Claude & Codex Usage Battery

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS-000000?logo=apple&logoColor=white" alt="Platform: macOS">
  <img src="https://img.shields.io/badge/SwiftBar-plugin-FF9500" alt="SwiftBar plugin">
  <img src="https://img.shields.io/badge/runtime-bun-14151A?logo=bun&logoColor=white" alt="Runtime: bun">
  <img src="https://img.shields.io/badge/dependencies-none-brightgreen.svg" alt="Zero dependencies">
  <a href="https://github.com/dennykim123/claude-codex-battery/stargazers"><img src="https://img.shields.io/github/stars/dennykim123/claude-codex-battery?style=flat&logo=github" alt="GitHub stars"></a>
</p>

> A macOS menu bar widget that shows your remaining **Claude Code** and **Codex** usage limits as battery icons — so you never have to open `/usage` again.

<p align="center">
  <img src="docs/menubar@2x.png" alt="Menu bar battery widget" width="280">
</p>

`C` = Claude · `X` = Codex. Each battery shows the **remaining %** of a limit window — full & green means plenty left, red means almost out. Click for a detailed breakdown with reset times.

Built as a single [SwiftBar](https://github.com/swiftbar/SwiftBar) plugin — one self-contained script, **no third-party libraries**. The battery icons are rendered as PNGs from scratch in pure JavaScript (`node:zlib` only), so there's no image library and no `npm install`. It queries the official Anthropic usage endpoint and, when Grok CLI is logged in, xAI's CLI billing endpoint; there is also an **optional once-a-day update check** ([see Updating](#updating)). (`ccusage` is an optional extra for the cost breakdown.)

---

## What it shows

| Group | Batteries | Source |
|-------|-----------|--------|
| **`C` Claude** | 5-hour session · weekly · **Fable** (top-model weekly cap) | Anthropic's OAuth usage API — queried live with your local Claude Code login; **account-level**, so usage from every device/surface is included |
| **`X` Codex** | 5-hour · weekly (or credit balance on the premium plan) | `~/.codex/sessions/**/*.jsonl` → `rate_limits` |
| **Grok** | Weekly/monthly credit remaining and used % gauge, server reset time, product breakdown | xAI CLI billing API using the local Grok CLI login; dropdown gauge only, no separate menu-bar battery |

Click the widget for a dropdown with, per limit:

```
Claude Code
  5h remaining   ▕██████████████░░░░░░▏ 70%  (used 30%)  · resets 3h 18m
  weekly         ▕██████▋░░░░░░░░░░░░░▏ 33%  (used 67%)  · resets 3d 21h
  Fable          ▕████░░░░░░░░░░░░░░░░▏ 26%  (used 74%)  · resets 3d 21h
  today by model ▕████████████▏ Fable $75 · Opus $46 · Sonnet $5 …

Codex · prolite
  5h remaining   ▕████████████████████▏ 100% (used 0%)
  weekly         ▕████████████████▋░░░▏ 83%  (used 17%)
```

Colors follow a traffic-light scale: green ≥ 50 % left, amber < 50 %, red < 20 %.

---

## Requirements

| | Required? | Install |
|---|---|---|
| **macOS** | ✅ | — |
| **[SwiftBar](https://github.com/swiftbar/SwiftBar)** | ✅ | `brew install swiftbar` |
| **[bun](https://bun.sh)** | ✅ | `curl -fsSL https://bun.sh/install \| bash` |
| **Claude Code** | ✅ for `C` batteries | just needs to be **logged in** on this Mac (the widget reuses its login to query the usage API) |
| **Codex CLI** | optional | for the `X` batteries; without it, only Claude is shown |
| **Grok CLI** | optional | for the Grok dropdown section; without a login it shows “login required” |
| **[ccusage](https://github.com/ryoppippi/ccusage)** | optional | adds the cost / token / per-model breakdown in the dropdown — **the battery works fully without it** |

> **Note:** This widget shows *your own account's* limits — via your local Claude Code login and your local Codex session logs. If you don't use Claude Code (or Codex), there simply won't be any data to display.

---

## Install

```bash
git clone https://github.com/dennykim123/claude-codex-battery.git
cd claude-codex-battery
./install.sh
```

`install.sh` will:

1. Verify **bun** and **SwiftBar** are present (and tell you how to install them if not)
2. Copy the plugin into `~/.swiftbar-plugins/`, rewriting the shebang to your machine's `bun` path *(SwiftBar runs plugins with a minimal `PATH`, so an absolute shebang is required)*
3. Point SwiftBar at the plugin folder and launch it
4. Register SwiftBar as a login item, so the battery comes back automatically after a reboot

No `npm install`, no bundled libraries — the plugin is a single self-contained script.

The battery appears in your menu bar within a few seconds. It refreshes **every 2 minutes** (the `.2m.` in the filename).

### Manual install

If you prefer not to run the script:

```bash
mkdir -p ~/.swiftbar-plugins
# rewrite shebang to your bun path, then copy:
sed "1s|.*|#!$(command -v bun)|" claude-codex-usage.2m.js > ~/.swiftbar-plugins/claude-codex-usage.2m.js
chmod +x ~/.swiftbar-plugins/claude-codex-usage.2m.js
defaults write com.ameba.SwiftBar PluginDirectory -string ~/.swiftbar-plugins
open -a SwiftBar
```

---

## Updating

The widget checks GitHub for a newer version **at most once a day** — a tiny background request for the `VERSION` file. When a new version is out, a green **🆕 update** row appears in the dropdown; click it to replace the plugin in place and refresh (your previous copy is kept as `.bak`). There's also an always-visible **⬆️ update now** row that replaces the plugin with the latest `main` on demand — no waiting for the daily check.

Prefer to do it yourself? From your clone: `git pull && ./install.sh`.

To turn the check off entirely, comment out the `getUpdateInfo()` call near the bottom of the script — then the only network call left is the Anthropic usage query.

---

## Privacy & security

- **Claude limits come straight from Anthropic.** The widget reads your Claude Code OAuth token from the macOS Keychain (item `Claude Code-credentials`) and calls `api.anthropic.com/api/oauth/usage` — the same endpoint `/usage` uses. The token is sent **only to api.anthropic.com**, passed via stdin (never visible in `ps`), and never written to disk or logs. macOS may show a one-time Keychain permission prompt — click **Always Allow**. (Clicking *Deny* makes macOS re-prompt on every refresh — if you'd rather the widget never touch the Keychain, run `touch ~/.claude/swiftbar/.no-live` instead; it then reads local cache files only, like v1.1.)
- **Grok uses the Grok CLI login.** The widget reads the bearer token from `~/.grok/auth.json` (or `$GROK_HOME/auth.json`) on each collection and sends it only to `cli-chat-proxy.grok.com`. Headers are passed through stdin, so the token is absent from process arguments. The widget does not refresh or rewrite the login file, and its snapshot stores only normalized usage, period, plan, and product fields.
- **Codex credentials are not read.** Codex usage still comes only from local session logs. The existing PixelLab section reads its API key from local MCP settings and queries `api.pixellab.ai/v2/balance`.
- **No usage data is uploaded elsewhere.** Outbound calls are the Anthropic usage query, the optional Grok settings/billing and PixelLab balance queries, and the optional daily update check ([Updating](#updating)).
- **No conversation content.** From Codex session logs it parses only the `rate_limits` object (numbers), never the messages.
- **Auditable in one sitting.** The whole widget is a single dependency-free script — grep for `curl`/`fetch` and you've seen every network call it can make.

---

## How accurate / in-sync is it?

**Claude — live.** Every refresh queries Anthropic's usage API directly with your local Claude Code login — the *same* server-side data `/usage` shows, so the numbers match it by construction. Because the limits are **account-level**, usage from every surface and device (terminal, desktop app, web, another machine) is already included. If the query fails (offline, logged out), the widget falls back to its last successful response and labels the reading with its age in amber.

**Codex — as fresh as your last Codex run.** Codex writes rate-limit data to its session logs *only while you use it*, and records no reset time. So the value is a snapshot from your most recent session — the dropdown labels it "measured N ago" and warns past 3h. Run Codex and it re-syncs instantly.

**Grok — live when the CLI login is valid.** The dropdown uses xAI's credits billing response and displays only periods and reset times returned by the server. A failed or expired login does not trigger token refresh; the last valid reading remains visible with a cache age, or the section asks you to log in when no prior reading exists.

**TL;DR** — Claude and Grok are queried live and fall back to clearly labeled cached readings; Codex is a snapshot from your last session.

---

## How it works

The whole thing is one `.js` file run by bun on a timer.

- **Battery icons** are drawn pixel-by-pixel into an RGBA buffer and encoded to PNG using only `node:zlib` (hand-rolled CRC32 + IHDR/IDAT/IEND chunks). A 5×7 bitmap font renders the numbers and the `C`/`X` group labels. SwiftBar displays the PNG at pixels ÷ 2 pt.
- **Claude limits** are fetched from Anthropic's OAuth usage endpoint using the Claude Code login token in your Keychain, with the last good response cached at `~/.claude/swiftbar/.claude-usage.json` as an offline fallback. The Fable cap is the `weekly_scoped` entry.
- **Codex limits** come from the newest session's `rate_limits`. The premium plan reports a `credits` object instead of percentages when exhausted; the widget handles both shapes.
- **Grok usage** comes from `cli-chat-proxy.grok.com/v1/billing?format=credits`, with the optional plan label from `/v1/settings`. Missing percentages are shown as unavailable rather than assumed unused.

### Codex has one quirk

Codex only writes limit data to session logs **while you use it**, and doesn't record a reset time when exhausted. So if you haven't run Codex in a while, the value can be stale. The widget:

- flags values older than 3 hours in the dropdown, and
- **optionally** runs `codex exec --sandbox read-only` in the background to refresh — but *only* when Codex is exhausted **and** the value is 2h+ old, at most once every 6 hours (≈4×/day, ~20k tokens each).

If you'd rather it never spend tokens on its own, comment out the `maybeAutoRefreshCodex(codex)` call near the render section.

---

## Customizing

| Want to change | Where |
|---|---|
| Refresh interval | filename `.2m.` → `.1m.`, `.5m.`, `.30s.`, … |
| Battery size | **↕ row in the dropdown** — toggles between big (4×6 font, default) and small (3×5 font, ~25% narrower); stored in `~/.claude/swiftbar/.batt-size` |
| Color thresholds | `heatRemain` / `heatRemainHex` (20 % / 50 %) |
| Disable Codex auto-refresh | comment out `maybeAutoRefreshCodex(codex)` |
| Disable live Claude API / Keychain access | `touch ~/.claude/swiftbar/.no-live` (falls back to local cache files) |
| Which Claude limits to show | the `battItems.push(...)` block |

---

## Why a SwiftBar plugin (and not a standalone app)?

A single script stays dependency-free, easy to audit, and trivial to fork — and its audience (Claude Code / Codex developers) already lives in the terminal, so `brew install swiftbar` is no barrier. A native `.app` would drop the SwiftBar requirement but adds a Swift codebase, Apple code-signing + notarization ($99/yr), and ongoing maintenance. **Roadmap:** if there's enough demand, ship a signed one-click menu-bar `.app` (likely bundling SwiftBar) for non-terminal users.

## Contributing

Issues and PRs welcome — especially for other plans/tools (e.g. mapping additional `rate_limit` shapes, or adding providers). Keep it dependency-free.

## License

[MIT](LICENSE)
