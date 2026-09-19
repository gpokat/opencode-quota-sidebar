# opencode-quota-sidebar

An [OpenCode](https://opencode.ai) V2 sidebar plugin that shows, in one compact
block:

- **Month-to-date tokens** — input, output, cache, and API-equivalent cost
- **OpenCode Go quota** — rolling 5h / weekly / monthly percentage bars
- **Zen credit balance** — remaining account balance in dollars

No third-party dependencies. It uses only APIs and built-ins already present in
the OpenCode (Bun) runtime.

```
USAGE · Sep 2026
in       116.6K
out       20.1K
cache      5.8M
cost     $0.069

QUOTA SPEND
5h       0% ▄▄▄▄▄▄▄▄▄▄▄▄
week    44% ▄▄▄▄▄▄▄▄▄▄▄▄
month  100% ▄▄▄▄▄▄▄▄▄▄▄▄
credit    $9.04
```

Bars fill the measured sidebar width, resize with the terminal, and use only
your theme's text colors. They are half-height (`▄`), so they are compact while
still separated.

## Requirements

- OpenCode **V2** (`opencode --version` ≥ 2.0.0)
- An authenticated **OpenCode Go** provider (for the quota bars)
- A one-time **`/quota-login`** for the credit balance

## Install

The plugin is TUI-only, so it is configured in `cli.json`.

### From npm

```sh
cd ~/.config/opencode
npm install opencode-quota-sidebar
```

```json
{
  "plugins": ["opencode-quota-sidebar"]
}
```

Or let the CLI do both steps:

```sh
opencode plugin add opencode-quota-sidebar
```

### From a local checkout

```sh
cd ~/.config/opencode
npm install /absolute/path/to/opencode-quota-sidebar
```

```json
{
  "plugins": ["opencode-quota-sidebar"]
}
```

Or reference the checkout directly:

```json
{
  "plugins": ["file:///absolute/path/to/opencode-quota-sidebar"]
}
```

### As a discovered local plugin

Copy `src/tui.tsx` to `~/.config/opencode/plugins/quota/tui.tsx` and put a
`package.json` with `"exports": { "./tui": "./tui.tsx" }` beside it. OpenCode
loads discovered plugins automatically.

Restart OpenCode after installing.

## Credit balance login

The Zen/Go balance has **no official API** and the Go API key cannot read billing
(it returns `403`). The console requires an OAuth session, so this plugin uses
the console's **device-code login**:

1. In the TUI, run **`/quota-login`** (also in the command palette as
   *Quota: sign in to view credits*).
2. A dialog shows a URL and a code. Open the URL, sign in with Google/GitHub,
   and approve.
3. The plugin stores the refresh token locally and refreshes access tokens
   automatically. The sidebar then shows `credit  $X.XX`.

Before login the row reads `credit  login`; if the session is revoked it reads
`credit  re-login`.

## How it works

| Value | Source | Auth |
| --- | --- | --- |
| Tokens + cost | `client.session.stats({ from, to, tools: "none" })` (message-level, calendar month) | server |
| Go quota | `GET https://opencode.ai/zen/go/v1/usage` | Go API key |
| Zen credits | `GET https://console.opencode.ai/api/billing/status` | console OAuth (device login) |

The Go API key is resolved from `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY`, then
the V2 credential store in `opencode.db`, then a legacy `auth.json`. No
configuration is required if the `opencode-go` provider is already connected.

## Security

- The plugin contains **no credentials** and ships **no secrets**.
- It never sends data anywhere except OpenCode's own endpoints
  (`opencode.ai`, `console.opencode.ai`) and the connected OpenCode server.
- The console OAuth token is stored in a **user-private file**:
  `$XDG_STATE_HOME/opencode/quota-sidebar/auth.json`
  (default `~/.local/state/opencode/quota-sidebar/auth.json`), created with mode
  `0600` in a `0700` directory.
- To sign out or revoke, delete that file (or remove the plugin).
- Diagnostics are **off by default**. Set `QUOTA_DEBUG=1` to write
  `/tmp/opencode-quota-debug.log` (mode `0600`); it contains only HTTP statuses
  and the billing response, never tokens.

See [SECURITY.md](./SECURITY.md).

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` | Override the discovered Go key |
| `QUOTA_POLL_MS` | Refresh interval in ms. Default `300000` |
| `QUOTA_DEBUG` | `1` enables the diagnostics log |
| `XDG_STATE_HOME` | Overrides where the OAuth token file is stored |

## Behavior

- Refreshes every 5 minutes, and ~1.5s after each assistant turn.
- Failures degrade gracefully: `usage: error`, `quota: <reason>`,
  `credit  login | no access | re-login | unreadable`.

## Development

The plugin is shipped as TypeScript (`src/tui.tsx`) and loaded by OpenCode's Bun
runtime. `@opencode/plugin/tui` is resolved by OpenCode at runtime, so there is
no build step and no runtime dependency to install.

```sh
# type-check (optional; requires dev deps)
npm install -D typescript @types/bun @opentui/core @opentui/solid @opencode/plugin
npx tsc --noEmit
```

## Uninstall

Remove the entry from `cli.json` (or run `opencode plugin remove
opencode-quota-sidebar`), restart OpenCode, then delete
`$XDG_STATE_HOME/opencode/quota-sidebar/`.

## License

MIT
