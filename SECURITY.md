# Security

## Reporting a vulnerability

Open a private security advisory on GitHub, or contact the maintainer directly.
Please do not open a public issue for sensitive reports.

## What this plugin accesses

- **OpenCode Go API key** — read from `OPENCODE_GO_API_KEY` / `OPENCODE_API_KEY`,
  the V2 credential store in `opencode.db` (read-only), or a legacy `auth.json`.
  It is sent only to `https://opencode.ai/zen/go/v1/usage`.
- **Console OAuth tokens** — obtained through the OpenCode Console device-code
  login (`/quota-login`) and sent only to `https://console.opencode.ai`.
- **Local session statistics** — read through the connected OpenCode server.

The plugin has no network egress to any other host and collects no telemetry.

## Credential storage

The console OAuth token (access + refresh) is stored at:

```
$XDG_STATE_HOME/opencode/quota-sidebar/auth.json
# default:
~/.local/state/opencode/quota-sidebar/auth.json
```

The directory is created `0700` and the file `0600`. On Windows the mode flags
are best-effort and the file inherits the user profile's ACLs. It is never
written inside the plugin package or the repository. To revoke access, delete
the file and remove the plugin.

Earlier versions relied on the host's generic TUI storage, which the host
creates world-readable (`0664`). The plugin now migrates any such file to the
private path and deletes the old one only after the new file is written.

## Installer

`npx opencode-quota-sidebar` edits the global `cli.json` plugin list and runs
`opencode plugin add`. It writes no credentials and reads no secrets.

## Diagnostics

Diagnostics are disabled by default. Setting `QUOTA_DEBUG=1` writes
`opencode-quota-debug.log` in the system temporary directory (`os.tmpdir()`),
created with mode `0600`. The log contains HTTP statuses and the raw billing
response (balance only) — never API keys, cookies, or OAuth tokens.

## Dependencies

There are no runtime dependencies. The plugin uses `fetch`, `bun:sqlite`, and
`node:fs`, all provided by the OpenCode (Bun) runtime.
