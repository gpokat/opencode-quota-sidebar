/**
 * OpenCode V2 CLI plugin: monthly token/cost usage + OpenCode Go quota + Zen
 * credit balance in the session sidebar.
 *
 * Data sources
 *  - Month-to-date tokens and cost: the connected server's session stats API
 *    (`client.session.stats`), which aggregates assistant-message usage in the
 *    requested range.
 *  - OpenCode Go subscription quota: the official usage endpoint
 *    (GET https://opencode.ai/zen/go/v1/usage) authenticated with the Go API
 *    key. Resolved from the environment, the V2 credential store in
 *    `opencode.db`, or a legacy `auth.json`. Each bar shows the window spend
 *    and the time left until it resets (e.g. "2h45m"), refreshed every poll
 *    interval and shortly after each assistant turn.
 *  - Zen credit balance: the console billing API
 *    (GET https://console.opencode.ai/api/billing/status). It needs a console
 *    OAuth session, which is obtained with the console's device-code login
 *    (`/quota-login`). The refresh token is stored durably and access tokens are
 *    refreshed automatically.
 *
 * No third-party dependencies: `bun:sqlite` and `fetch` are built into the
 * OpenCode (Bun) runtime.
 */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage"
const CONSOLE_AUTH = "https://console.opencode.ai/auth"
const CONSOLE_API = "https://console.opencode.ai/api"
const OAUTH_CLIENT_ID = "opencode"
const OAUTH_SCOPE = "openid profile email offline_access"
const CONSOLE_ORIGIN = "https://opencode.ai"
const POLL_MS = Number(process.env.QUOTA_POLL_MS) > 0 ? Number(process.env.QUOTA_POLL_MS) : 5 * 60 * 1000
const DEBOUNCE_MS = 1500
const TICK_MS = 30_000
const MIN_BAR_WIDTH = 4
const FALLBACK_WIDTH = 8
const LABEL_WIDTH = 6
const PCT_WIDTH = 4
const RESET_WIDTH = 6
const RESET_GAP = 1
const MICROCENTS_PER_DOLLAR = 100_000_000

type GoWindow = { status: string; percent: number; resetsAt?: string }
type GoQuota = { rolling?: GoWindow; weekly?: GoWindow; monthly?: GoWindow }
type Tokens = { access_token?: string; refresh_token?: string; expires_in?: number }

type QuotaState = {
  ready: boolean
  width: number
  /** Wall clock used to compute quota reset countdowns between refreshes. */
  now: number
  tokens: { input: number; output: number; cache: number; reasoning: number }
  cost: number
  quota?: GoQuota
  credit?: number
  hasAuth: boolean
  statsError?: string
  quotaError?: string
  creditError?: string
}

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

function compact(n: number): string {
  if (!Number.isFinite(n)) return "-"
  const a = Math.abs(n)
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "")
  if (a >= 1e9) return `${trim(n / 1e9)}B`
  if (a >= 1e6) return `${trim(n / 1e6)}M`
  if (a >= 1e3) return `${trim(n / 1e3)}K`
  return String(Math.round(n))
}

function money(n: number): string {
  if (!Number.isFinite(n)) return "-"
  return `$${n.toFixed(n < 1 ? 3 : 2)}`
}

function dollars(n: number): string {
  if (!Number.isFinite(n)) return "-"
  return `$${n.toFixed(2)}`
}

function barWidth(available: number): number {
  if (!available || available <= 0) return FALLBACK_WIDTH
  return Math.max(MIN_BAR_WIDTH, available - LABEL_WIDTH - PCT_WIDTH - 1 - RESET_GAP - RESET_WIDTH)
}

function barSegments(percent: number, available: number): { filled: number; empty: number } {
  const width = barWidth(available)
  const p = Math.max(0, Math.min(100, percent))
  const filled = Math.round((p / 100) * width)
  return { filled, empty: Math.max(0, width - filled) }
}

/** Compact remaining time until a window resets, e.g. "2h45m", "3d4h", "45m".
 *  At most RESET_WIDTH characters ("31d23h"), so every bar row stays aligned. */
function formatReset(resetsAt: string | undefined, now: number): string {
  if (!resetsAt) return ""
  const at = Date.parse(resetsAt)
  if (!Number.isFinite(at)) return ""
  const seconds = Math.max(0, Math.round((at - now) / 1000))
  const days = Math.floor(seconds / 86400)
  if (days >= 1) return `${days}d${Math.floor((seconds % 86400) / 3600)}h`
  const hours = Math.floor(seconds / 3600)
  if (hours >= 1) return `${hours}h${Math.floor((seconds % 3600) / 60)}m`
  const minutes = Math.floor(seconds / 60)
  if (minutes >= 1) return `${minutes}m`
  return "<1m"
}

function row(label: string, value: string): string {
  return label.padEnd(LABEL_WIDTH) + value.padStart(9)
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Diagnostics for the console login/billing path. Enabled with QUOTA_DEBUG=1. */
function debugLog(message: string) {
  if (!process.env.QUOTA_DEBUG) return
  void Promise.all([import("node:fs"), import("node:os"), import("node:path")])
    .then(([{ appendFileSync }, { tmpdir }, { join }]) => {
      try {
        appendFileSync(join(tmpdir(), "opencode-quota-debug.log"), `${new Date().toISOString()} ${message}\n`, {
          mode: 0o600,
        })
      } catch {
        // ignore
      }
    })
    .catch(() => {})
}

// ---------------------------------------------------------------------------
// console token storage (user-private file, mode 0600)
// ---------------------------------------------------------------------------

type StoredTokens = { accessToken: string; refreshToken: string; expires: number }

const EMPTY_TOKENS: StoredTokens = { accessToken: "", refreshToken: "", expires: 0 }

async function tokenFile(): Promise<string> {
  const os = await import("node:os")
  const path = await import("node:path")
  const stateHome = process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state")
  return path.join(stateHome, "opencode", "quota-sidebar", "auth.json")
}

/** Move away from the older TUI storage file, which the host writes world-readable. */
async function migrateLegacyTokens(): Promise<void> {
  try {
    const os = await import("node:os")
    const path = await import("node:path")
    const { readFile, rm } = await import("node:fs/promises")
    const legacy = path.join(
      os.homedir(),
      ".local",
      "state",
      "opencode",
      "latest",
      "tui",
      "plugin.quota.sidebar.auth.json",
    )
    const parsed = JSON.parse(await readFile(legacy, "utf8")) as Partial<StoredTokens>
    if (parsed?.refreshToken) {
      const saved = await saveTokens({
        accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : "",
        refreshToken: parsed.refreshToken,
        expires: typeof parsed.expires === "number" ? parsed.expires : 0,
      })
      // Keep the legacy file if the new location could not be written.
      if (!saved) return
    }
    await rm(legacy, { force: true })
  } catch {
    // no legacy file
  }
}

async function readTokens(): Promise<StoredTokens> {
  try {
    const { readFile } = await import("node:fs/promises")
    const parsed = JSON.parse(await readFile(await tokenFile(), "utf8")) as Partial<StoredTokens>
    return {
      accessToken: typeof parsed.accessToken === "string" ? parsed.accessToken : "",
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : "",
      expires: typeof parsed.expires === "number" ? parsed.expires : 0,
    }
  } catch {
    return { ...EMPTY_TOKENS }
  }
}

async function saveTokens(tokens: StoredTokens): Promise<boolean> {
  try {
    const path = await import("node:path")
    const { mkdir, writeFile, chmod } = await import("node:fs/promises")
    const file = await tokenFile()
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await writeFile(file, JSON.stringify(tokens), { mode: 0o600 })
    await chmod(file, 0o600)
    return true
  } catch {
    // persistence is best-effort (mode flags are a no-op on Windows)
    return false
  }
}

async function clearTokens(): Promise<void> {
  try {
    const { rm } = await import("node:fs/promises")
    await rm(await tokenFile(), { force: true })
  } catch {
    // ignore
  }
}

// ---------------------------------------------------------------------------
// OpenCode Go key
// ---------------------------------------------------------------------------

async function readDbKey(): Promise<string | undefined> {
  try {
    const { Database } = await import("bun:sqlite")
    const os = await import("node:os")
    const path = await import("node:path")
    const file = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
    const db = new Database(file, { readonly: true })
    try {
      const found = db
        .query("select value from credential where integration_id = ? and active = 1 limit 1")
        .get("opencode-go") as { value?: string } | undefined
      if (!found?.value) return undefined
      try {
        const parsed = JSON.parse(found.value)
        if (parsed && typeof parsed.key === "string") return parsed.key
      } catch {
        // stored value is a bare key
      }
      return found.value
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

async function readAuthJsonKey(): Promise<string | undefined> {
  try {
    const os = await import("node:os")
    const path = await import("node:path")
    const { readFile } = await import("node:fs/promises")
    const candidates = [
      path.join(os.homedir(), ".local", "share", "opencode", "auth.json"),
      path.join(os.homedir(), ".config", "opencode", "auth.json"),
    ]
    for (const file of candidates) {
      try {
        const parsed = JSON.parse(await readFile(file, "utf8"))
        const entry = parsed?.["opencode-go"]
        const key = entry?.key ?? entry?.apiKey
        if (typeof key === "string" && key.trim()) return key.trim()
      } catch {
        // try next candidate
      }
    }
    return undefined
  } catch {
    return undefined
  }
}

async function resolveGoKey(): Promise<string | undefined> {
  const env = process.env.OPENCODE_GO_API_KEY ?? process.env.OPENCODE_API_KEY
  if (env && env.trim()) return env.trim()
  return (await readDbKey()) ?? (await readAuthJsonKey())
}

async function fetchGoQuota(
  key: string | undefined,
  timeoutMs = 8000,
): Promise<GoQuota | { error: string }> {
  if (!key) return { error: "no Go key" }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: controller.signal,
    })
    if (!res.ok) return { error: `Go API ${res.status}` }
    const body = (await res.json()) as { usage?: Record<string, unknown> }
    const usage = body?.usage
    if (!usage) return { error: "bad Go response" }
    const pick = (k: string): GoWindow | undefined => {
      const w = usage[k] as { status?: unknown; percent?: unknown; resetsAt?: unknown } | undefined
      if (!w || typeof w.percent !== "number" || !Number.isFinite(w.percent)) return undefined
      return {
        status: typeof w.status === "string" ? w.status : "ok",
        percent: w.percent,
        resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : undefined,
      }
    }
    return { rolling: pick("rolling"), weekly: pick("weekly"), monthly: pick("monthly") }
  } catch (error: any) {
    return { error: error?.name === "AbortError" ? "timeout" : String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Console OAuth: device-code login + token refresh + billing balance
// ---------------------------------------------------------------------------

type DeviceCode = {
  device_code: string
  user_code: string
  verification_uri?: string
  verification_uri_complete?: string
  expires_in?: number
  interval?: number
}

async function requestDeviceCode(): Promise<DeviceCode | { error: string }> {
  try {
    const res = await fetch(`${CONSOLE_AUTH}/device/code`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ client_id: OAUTH_CLIENT_ID, scope: OAUTH_SCOPE, supports_org_scope: true }),
    })
    if (!res.ok) {
      debugLog(`device/code status=${res.status}`)
      return { error: `device/code ${res.status}` }
    }
    const body = (await res.json()) as DeviceCode
    debugLog(`device/code ok user_code=${body?.user_code}`)
    if (!body?.device_code || !body?.user_code) return { error: "bad device code response" }
    return body
  } catch (error: any) {
    debugLog(`device/code error ${String(error?.message ?? error)}`)
    return { error: String(error?.message ?? error) }
  }
}

/** Poll once. Returns tokens, "pending", "slow_down", or an error string. */
async function pollDeviceToken(
  deviceCode: string,
): Promise<Tokens | "pending" | "slow_down" | { error: string }> {
  try {
    const res = await fetch(`${CONSOLE_AUTH}/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: deviceCode,
        client_id: OAUTH_CLIENT_ID,
      }),
    })
    const body = (await res.json().catch(() => ({}))) as Tokens & { error?: string }
    if (body.access_token) return body
    if (body.error === "authorization_pending") return "pending"
    if (body.error === "slow_down") return "slow_down"
    debugLog(`device/token error status=${res.status} error=${body.error}`)
    return { error: body.error ?? `device/token ${res.status}` }
  } catch (error: any) {
    return { error: String(error?.message ?? error) }
  }
}

async function refreshAccessToken(refreshToken: string): Promise<Tokens | { error: string }> {
  try {
    const res = await fetch(`${CONSOLE_AUTH}/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }),
    })
    const body = (await res.json().catch(() => ({}))) as Tokens & { error?: string }
    if (!res.ok || !body.access_token) {
      debugLog(`refresh status=${res.status} error=${body.error}`)
      return { error: body.error ?? `refresh ${res.status}` }
    }
    return body
  } catch (error: any) {
    return { error: String(error?.message ?? error) }
  }
}

async function fetchBalance(accessToken: string): Promise<number | { error: string }> {
  try {
    const res = await fetch(`${CONSOLE_API}/billing/status`, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    })
    const text = await res.text().catch(() => "")
    debugLog(`billing status=${res.status} body=${text.slice(0, 300)}`)
    if (res.status === 401 || res.status === 403) return { error: "no billing access" }
    if (!res.ok) return { error: `billing ${res.status}` }
    const body = (() => {
      try {
        return JSON.parse(text) as Record<string, unknown>
      } catch {
        return {} as Record<string, unknown>
      }
    })()
    const rawMicro =
      body.availableMicroCents ??
      body.balanceMicroCents ??
      (typeof body.balance === "number" ? (body.balance as number) * MICROCENTS_PER_DOLLAR : undefined)
    const micro = typeof rawMicro === "string" ? Number(rawMicro) : rawMicro
    if (typeof micro !== "number" || !Number.isFinite(micro)) return { error: "unreadable" }
    return micro / MICROCENTS_PER_DOLLAR
  } catch (error: any) {
    debugLog(`billing fetch error ${String(error?.message ?? error)}`)
    return { error: String(error?.message ?? error) }
  }
}

// ---------------------------------------------------------------------------
// view
// ---------------------------------------------------------------------------

/** Half-height progress bar. Uses the lower half block so each bar occupies the
 *  bottom half of a terminal cell; the empty upper half of every row is the gap
 *  between bars, giving compact spacing without full blank rows. The remaining
 *  time until the window resets is shown right after the bar (e.g. "2h45m"). */
function QuotaLine(props: {
  label: string
  percent: number
  width: number
  reset: string
  color: any
  track: any
}) {
  const { filled, empty } = barSegments(props.percent, props.width)
  return (
    <box flexDirection="row">
      <text fg={props.track}>{`${props.label.padEnd(LABEL_WIDTH)}${`${Math.round(props.percent)}%`.padStart(PCT_WIDTH)} `}</text>
      {filled > 0 ? <text fg={props.color}>{"▄".repeat(filled)}</text> : null}
      {empty > 0 ? <text fg={props.track}>{"▄".repeat(empty)}</text> : null}
      <text fg={props.track}>{" ".repeat(RESET_GAP) + props.reset.padEnd(RESET_WIDTH)}</text>
    </box>
  )
}

function creditLabel(s: QuotaState): string {
  if (s.credit !== undefined) return dollars(s.credit)
  if (!s.hasAuth) return "login"
  const raw = s.creditError ?? ""
  const e = raw.toLowerCase()
  if (!e) return "…"
  if (e.includes("no billing access")) return "no access"
  if (e.includes("401") || e.includes("403")) return "re-login"
  if (e.includes("unreadable")) return "unreadable"
  if (e.includes("timeout")) return "timeout"
  return raw.slice(0, 12)
}

function View(props: {
  ctx: Context
  state: QuotaState
  setState: (fn: (d: QuotaState) => void) => void
}) {
  const theme = props.ctx.theme
  const s = props.state
  const month = new Date().toLocaleString("en-US", { month: "short", year: "numeric" })

  return (
    <box
      flexDirection="column"
      width="100%"
      ref={((el: any) => {
        if (!el) return
        const update = () => {
          const width = (el.width ?? 0) | 0
          props.setState((d) => {
            if (d.width !== width) d.width = width
          })
        }
        el.onSizeChange = update
        queueMicrotask(update)
      }) as any}
    >
      <text fg={theme.text.base}>{`USAGE · ${month}`}</text>
      <text fg={theme.text.muted}>{row("in", compact(s.tokens.input))}</text>
      <text fg={theme.text.muted}>{row("out", compact(s.tokens.output))}</text>
      <text fg={theme.text.muted}>{row("cache", compact(s.tokens.cache))}</text>
      <text fg={theme.text.muted}>{row("cost", money(s.cost))}</text>
      {s.statsError ? <text fg={theme.text.feedback.error.base}>usage: error</text> : null}
      {s.quotaError ? (
        <text fg={theme.text.feedback.error.base}>{`quota: ${s.quotaError}`}</text>
      ) : null}
      {s.quota || s.credit !== undefined || s.hasAuth || s.creditError ? (
        <box flexDirection="column">
          <text fg={theme.text.muted}> </text>
          <text fg={theme.text.base}>QUOTA SPEND</text>
          {s.quota?.rolling ? (
            <QuotaLine
              label="5h"
              percent={s.quota.rolling.percent}
              reset={formatReset(s.quota.rolling.resetsAt, s.now)}
              width={s.width}
              color={theme.text.base}
              track={theme.text.muted}
            />
          ) : null}
          {s.quota?.weekly ? (
            <QuotaLine
              label="week"
              percent={s.quota.weekly.percent}
              reset={formatReset(s.quota.weekly.resetsAt, s.now)}
              width={s.width}
              color={theme.text.base}
              track={theme.text.muted}
            />
          ) : null}
          {s.quota?.monthly ? (
            <QuotaLine
              label="month"
              percent={s.quota.monthly.percent}
              reset={formatReset(s.quota.monthly.resetsAt, s.now)}
              width={s.width}
              color={theme.text.base}
              track={theme.text.muted}
            />
          ) : null}
          <text fg={s.credit !== undefined ? theme.text.base : theme.text.muted}>
            {row("credit", creditLabel(s))}
          </text>
        </box>
      ) : null}
    </box>
  )
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

export default Plugin.define({
  id: "quota.sidebar",
  setup(ctx: Context) {
    const [state, setState] = ctx.storage.memory<QuotaState>("state", {
      initial: {
        ready: false,
        width: 0,
        now: Date.now(),
        tokens: { input: 0, output: 0, cache: 0, reasoning: 0 },
        cost: 0,
        hasAuth: false,
      },
    })
    let auth: StoredTokens = { ...EMPTY_TOKENS }
    let authLoaded = false
    const loadAuth = async () => {
      if (authLoaded) return
      await migrateLegacyTokens()
      auth = await readTokens()
      authLoaded = true
    }

    let key: string | undefined
    let keyResolved = false
    let disposed = false
    let refreshTimer: ReturnType<typeof setTimeout> | undefined
    let loginActive = false

    const refreshStats = async () => {
      try {
        const d = new Date()
        const from = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0).getTime()
        const stats = await ctx.client.session.stats({ from, to: Date.now(), tools: "none" })
        if (disposed) return
        setState((s) => {
          s.tokens.input = stats.tokens.input
          s.tokens.output = stats.tokens.output
          s.tokens.reasoning = stats.tokens.reasoning
          s.tokens.cache = stats.tokens.cache.read + stats.tokens.cache.write
          s.cost = stats.cost
          s.statsError = undefined
        })
      } catch (error: any) {
        if (disposed) return
        setState((s) => {
          s.statsError = String(error?.message ?? error)
        })
      }
    }

    const refreshQuota = async () => {
      if (!keyResolved) {
        key = await resolveGoKey()
        keyResolved = true
      }
      const result = await fetchGoQuota(key)
      if (disposed) return
      if ("error" in result) {
        setState((s) => {
          s.quotaError = result.error
        })
      } else {
        setState((s) => {
          s.quota = result
          s.quotaError = undefined
        })
      }
    }

    /** Ensure a usable console access token, refreshing if needed. */
    const accessToken = async (): Promise<string | undefined> => {
      await loadAuth()
      if (auth.accessToken && auth.expires > Date.now() + 30_000) return auth.accessToken
      if (!auth.refreshToken) return undefined
      const refreshed = await refreshAccessToken(auth.refreshToken)
      if ("error" in refreshed) {
        auth = { ...EMPTY_TOKENS }
        await clearTokens()
        return undefined
      }
      auth = {
        accessToken: refreshed.access_token ?? "",
        refreshToken: refreshed.refresh_token ?? auth.refreshToken,
        expires: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
      }
      await saveTokens(auth)
      return refreshed.access_token
    }

    const refreshCredit = async () => {
      const token = await accessToken()
      if (disposed) return
      debugLog(`credit token=${token ? "yes" : "no"} refresh=${auth.refreshToken ? "yes" : "no"}`)
      if (!token) {
        setState((s) => {
          s.hasAuth = Boolean(auth.refreshToken)
          s.credit = undefined
          s.creditError = undefined
        })
        return
      }
      const result = await fetchBalance(token)
      if (disposed) return
      if (typeof result === "number") {
        debugLog(`credit=$${result.toFixed(2)}`)
        setState((s) => {
          s.credit = result
          s.hasAuth = true
          s.creditError = undefined
        })
      } else {
        setState((s) => {
          s.credit = undefined
          s.hasAuth = true
          s.creditError = result.error
        })
      }
    }

    const startLogin = async () => {
      if (loginActive) return
      loginActive = true
      try {
        const dc = await requestDeviceCode()
        if ("error" in dc) {
          ctx.ui.toast.show({ message: `Quota login failed: ${dc.error}`, variant: "error" })
          return
        }
        const url = `${CONSOLE_ORIGIN}${dc.verification_uri_complete ?? dc.verification_uri ?? "/console/device"}`
        ctx.ui.toast.show({
          title: "Quota login",
          message: `Open ${url} and approve code ${dc.user_code}`,
          variant: "info",
          duration: 20000,
        })
        ctx.ui.dialog.alert({
          title: "Sign in to OpenCode Console",
          message: `Open this URL and approve:\n${url}\n\nCode: ${dc.user_code}`,
        })
        const deadline = Date.now() + (dc.expires_in ?? 900) * 1000
        let interval = Math.max(2, dc.interval ?? 5) * 1000
        while (!disposed && Date.now() < deadline) {
          await sleep(interval)
          const result = await pollDeviceToken(dc.device_code)
          if (result === "pending") continue
          if (result === "slow_down") {
            interval += 2000
            continue
          }
          if ("error" in result) {
            ctx.ui.toast.show({ message: `Quota login failed: ${result.error}`, variant: "error" })
            return
          }
          auth = {
            accessToken: result.access_token ?? "",
            refreshToken: result.refresh_token ?? "",
            expires: Date.now() + (result.expires_in ?? 3600) * 1000,
          }
          authLoaded = true
          await saveTokens(auth)
          ctx.ui.toast.show({ message: "Quota login complete", variant: "success" })
          await refreshCredit()
          return
        }
        ctx.ui.toast.show({ message: "Quota login timed out", variant: "warning" })
      } finally {
        loginActive = false
      }
    }

    const refreshAll = async () => {
      await Promise.all([refreshStats(), refreshQuota(), refreshCredit()])
      if (disposed) return
      setState((s) => {
        s.ready = true
      })
    }

    void (async () => {
      await loadAuth()
      await refreshAll()
    })()
    const interval = setInterval(() => void refreshAll(), POLL_MS)

    // Keep the reset countdowns moving between refreshes.
    const tick = setInterval(() => {
      if (disposed) return
      setState((s) => {
        s.now = Date.now()
      })
    }, TICK_MS)

    // Refresh usage and quota shortly after the assistant finishes a turn, so
    // the bars track usage instead of waiting for the next poll.
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => void refreshAll(), DEBOUNCE_MS)
    }
    const stops = [
      ctx.data.on("session.execution.succeeded", scheduleRefresh),
      ctx.data.on("session.execution.failed", scheduleRefresh),
      ctx.data.on("session.execution.interrupted", scheduleRefresh),
      ctx.data.on("session.idle", scheduleRefresh),
    ]

    const disposeCommand = ctx.ui.slot({
      append: "app",
      render: () => {
        ctx.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "quota.login",
              title: "Quota: sign in to view credits",
              group: "Quota",
              palette: true,
              slash: { name: "quota-login" },
              run: () => void startLogin(),
            },
          ],
        }))
        return null
      },
    })

    const disposeSlot = ctx.ui.slot({
      append: "sidebar.content",
      render: () => <View ctx={ctx} state={state} setState={setState} />,
    })

    return () => {
      disposed = true
      clearInterval(interval)
      clearInterval(tick)
      if (refreshTimer) clearTimeout(refreshTimer)
      for (const stop of stops) stop()
      disposeSlot()
      disposeCommand()
    }
  },
})
