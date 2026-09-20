# opencode-quota-sidebar

An [OpenCode](https://opencode.ai) V2 sidebar plugin that shows, in one compact
block:

- **Month-to-date tokens** — input, output, cache, and API-equivalent cost
- **OpenCode Go quota** — rolling 5h / weekly / monthly percentage bars
- **Zen credit balance** — remaining account balance in dollars

No third-party runtime dependencies. It uses only APIs and built-ins already
present in the OpenCode (Bun) runtime.

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

### One command

```sh
npx opencode-quota-sidebar
```

The installer adds `opencode-quota-sidebar` to
`~/.config/opencode/cli.json` and, when the `opencode` CLI is on your `PATH`,
installs the package with `opencode plugin add`. Restart OpenCode afterwards.

### With the OpenCode CLI

```sh
opencode plugin add opencode-quota-sidebar
```

### Manual

Add the package to the `plugins` array in `~/.config/opencode/cli.json`:

```json
{
  "plugins": ["opencode-quota-sidebar"]
}
```

OpenCode installs configured package plugins on startup.

### From a local checkout

```sh
cd /path/to/opencode-quota-sidebar
npm install
npm run build
```

Then point `cli.json` at the checkout:

```json
{
  "plugins": ["file:///absolute/path/to/opencode-quota-sidebar"]
}
```

OpenCode's local file loader can also transform the TypeScript source directly,
so `file:///absolute/path/to/opencode-quota-sidebar/tui.tsx` works without a
build step while developing.

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
  `0600` in a `0700` directory. On Windows the mode flags are best-effort and
  the file inherits the user profile's ACLs.
- To sign out or revoke, delete that file (or remove the plugin).
- Diagnostics are **off by default**. Set `QUOTA_DEBUG=1` to write
  `opencode-quota-debug.log` in the system temporary directory (`os.tmpdir()`),
  created with mode `0600`; it contains only HTTP statuses and the billing
  response, never tokens.

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

`src/tui.tsx` is the source of truth. The published package ships a precompiled
`dist/tui.js` because OpenCode's package loader executes TypeScript from
`node_modules` with the default React JSX transform, which fails with
`Cannot find package 'react'`. The build compiles the JSX with the Solid
runtime (`jsxImportSource: "@opentui/solid"`) and leaves
`@opencode/plugin/tui` and `@opentui/solid/jsx-runtime` external; OpenCode
provides both at runtime.

```sh
npm install
npm run build       # writes dist/tui.js
npm run typecheck   # optional
npm pack            # runs the build again via prepack
```

The runtime layout OpenCode loads:

```text
opencode-quota-sidebar
├── dist/tui.js      # compiled entry (exports["./tui"])
├── src/tui.tsx      # source
└── tui.tsx          # local-development re-export
```

## Uninstall

```sh
npx opencode-quota-sidebar uninstall
```

or

```sh
opencode plugin remove opencode-quota-sidebar
```

Then delete `$XDG_STATE_HOME/opencode/quota-sidebar/` (`~/.local/state/opencode/quota-sidebar/`).

## License

MIT
