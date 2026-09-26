# opencode-quota-sidebar

OpenCode V2 sidebar plugin: month-to-date tokens/cost, OpenCode Go quota
(rolling 5h / weekly / monthly) with reset countdowns, and the Zen credit
balance.

```
USAGE · Sep 2026
in         2.4M
out      415.3K
cache    232.1M
cost      $1.74

QUOTA SPEND
5h      3% ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ 2h17m
week    2% ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ 1d5h
month   1% ▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄ 23d23h
credit    $8.29
```

## Setup

1. **Install the plugin** (OpenCode V2):

   ```sh
   opencode plugin add opencode-quota-sidebar
   ```

   Or add it to the global `~/.config/opencode/cli.json` yourself:

   ```json
   {
     "plugins": ["opencode-quota-sidebar"]
   }
   ```

2. **Connect the OpenCode Go provider** so the quota bars have data:

   ```sh
   opencode auth login    # choose OpenCode Go
   ```

3. **Sign in to the Zen console once** for the credit balance, from the TUI:

   ```
   /quota-login
   ```

4. **Restart OpenCode.**

### From a local checkout

```sh
cd /path/to/opencode-quota-sidebar
npm install && npm run build
```

Then point `cli.json` at the checkout:

```json
{
  "plugins": ["file:///absolute/path/to/opencode-quota-sidebar"]
}
```

## What OpenCode must provide

| Sidebar data | Required | Where it comes from |
| --- | --- | --- |
| Tokens + cost | connected server | `client.session.stats` for the calendar month — no setup |
| Go quota | OpenCode Go API key | `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY`, else the `opencode-go` credential in `~/.local/share/opencode/opencode.db` (written by `opencode auth login`), else a legacy `auth.json` in `~/.local/share/opencode/` or `~/.config/opencode/` |
| Zen credits | OpenCode Console session | `/quota-login` (device-code flow), token stored in `$XDG_STATE_HOME/opencode/quota-sidebar/auth.json` — default `~/.local/state/opencode/quota-sidebar/auth.json` |

Notes:

- If the Go provider is already connected, no key configuration is needed.
- Before `/quota-login` the row reads `credit login`; if the session is revoked
  it reads `credit re-login`.
- Signing out: delete the token file above (or remove the plugin). The OAuth
  token is stored mode `0600` in a `0700` directory.

## Configuration

| Variable | Purpose |
| --- | --- |
| `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY` | Override the discovered Go key |
| `QUOTA_POLL_MS` | Refresh interval in ms. Default `300000` (5 min) |
| `QUOTA_DEBUG` | `1` writes diagnostics to `opencode-quota-debug.log` in the system temp dir (no tokens) |
| `XDG_STATE_HOME` | Overrides where the console OAuth token file is stored |

## Notes

- Refreshes every 5 minutes and ~1.5 s after each assistant turn; reset
  countdowns (`2h45m`, `1d6h`, `23d23h`) tick every 30 seconds.
- The usage endpoint reports whole (floored) percentages while the console page
  rounds raw spend, so a bar can read up to 1% lower than the website.
- Failures degrade gracefully: `usage: error`, `quota: <reason>`,
  `credit  login | no access | re-login | unreadable`.

## Uninstall

```sh
npx opencode-quota-sidebar uninstall
```

or

```sh
opencode plugin remove opencode-quota-sidebar
```

Then delete `$XDG_STATE_HOME/opencode/quota-sidebar/`
(`~/.local/state/opencode/quota-sidebar/`).

## Security

The plugin ships no credentials and only talks to OpenCode's own endpoints
(`opencode.ai`, `console.opencode.ai`) and the connected server. See
[SECURITY.md](./SECURITY.md).

## License

MIT
