#!/usr/bin/env node
/**
 * opencode-quota-sidebar installer.
 *
 * `npx opencode-quota-sidebar` adds the plugin to the global OpenCode CLI
 * configuration (`cli.json`) and, when the `opencode` CLI is available,
 * installs the package through `opencode plugin add` immediately.
 *
 * Usage:
 *   npx opencode-quota-sidebar [install]     add the plugin (default)
 *   npx opencode-quota-sidebar uninstall     remove the plugin
 *   npx opencode-quota-sidebar --config DIR  use a custom OpenCode config dir
 *   npx opencode-quota-sidebar --no-install  only edit cli.json
 *   npx opencode-quota-sidebar --help
 *   npx opencode-quota-sidebar --version
 */
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_NAME = "opencode-quota-sidebar"
const SCHEMA_URL = "https://opencode.ai/v2/cli.json"

function readPackageVersion() {
  try {
    const manifest = fileURLToPath(new URL("../package.json", import.meta.url))
    return JSON.parse(readFileSync(manifest, "utf8")).version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
}

function usage() {
  console.log(`OpenCode Quota Sidebar installer

Usage:
  npx ${PACKAGE_NAME} [install]      Add the plugin to ~/.config/opencode/cli.json
  npx ${PACKAGE_NAME} uninstall      Remove the plugin from cli.json
  npx ${PACKAGE_NAME} --version
  npx ${PACKAGE_NAME} --help

Options:
  --config <dir>   Use a specific OpenCode configuration directory
  --no-install     Only edit cli.json; do not run "opencode plugin add"

Restart OpenCode after installing or uninstalling.`)
}

function parseArgs(argv) {
  const options = {
    command: "install",
    configDir: undefined,
    runOpencode: true,
    help: false,
    version: false,
    error: undefined,
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "install" || arg === "add") options.command = "install"
    else if (arg === "uninstall" || arg === "remove") options.command = "uninstall"
    else if (arg === "-h" || arg === "--help" || arg === "help") options.help = true
    else if (arg === "-v" || arg === "--version") options.version = true
    else if (arg === "--no-install") options.runOpencode = false
    else if (arg === "--config" || arg === "--config-dir") {
      options.configDir = argv[++index]
      if (!options.configDir) options.error = `Missing value for ${arg}`
    } else if (arg.startsWith("--config=")) options.configDir = arg.slice("--config=".length)
    else options.error = `Unknown argument: ${arg}`
  }
  return options
}

function resolveConfigDir(explicit) {
  if (explicit) return resolve(explicit)
  if (process.env.OPENCODE_CONFIG_DIR) return resolve(process.env.OPENCODE_CONFIG_DIR)
  if (process.env.XDG_CONFIG_HOME) return join(resolve(process.env.XDG_CONFIG_HOME), "opencode")
  return join(homedir(), ".config", "opencode")
}

/** Parse JSON with comments and trailing commas (cli.json is JSONC-friendly). */
function parseJsonc(text) {
  const source = text.replace(/^\uFEFF/, "")
  let output = ""
  let inString = false
  let escaped = false
  let lineComment = false
  let blockComment = false
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    const next = source[index + 1]
    if (lineComment) {
      if (char === "\n") {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        index++
      }
      continue
    }
    if (inString) {
      output += char
      if (escaped) escaped = false
      else if (char === "\\") escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') {
      inString = true
      output += char
      continue
    }
    if (char === "/" && next === "/") {
      lineComment = true
      index++
      continue
    }
    if (char === "/" && next === "*") {
      blockComment = true
      index++
      continue
    }
    output += char
  }
  return output.replace(/,\s*([}\]])/g, "$1")
}

function readConfig(configPath) {
  if (!existsSync(configPath)) return { $schema: SCHEMA_URL }
  let parsed
  try {
    parsed = JSON.parse(parseJsonc(readFileSync(configPath, "utf8")))
  } catch (error) {
    throw new Error(`Could not parse ${configPath}: ${error.message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Could not use ${configPath}: the root value must be a JSON object`)
  }
  return parsed
}

function writeConfig(configPath, config) {
  mkdirSync(resolve(configPath, ".."), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

/** Extract the package name from a cli.json plugin entry ("-pkg@1.2.3" -> "pkg"). */
function entryName(entry) {
  const value =
    typeof entry === "string" ? entry : entry && typeof entry.package === "string" ? entry.package : undefined
  if (!value) return undefined
  const bare = value.replace(/^[+-]/, "")
  const match = bare.match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.*)?$/)
  return match ? match[1] : bare
}

function runOpencode(args, configDir) {
  const result = spawnSync("opencode", args, {
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
    encoding: "utf8",
    env: { ...process.env, OPENCODE_CONFIG_DIR: configDir },
  })
  if (result.error) return { ok: false, reason: result.error.message }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split(/\r?\n/).filter(Boolean)[0]
    return { ok: false, reason: detail ?? `exit code ${result.status}` }
  }
  return { ok: true }
}

function install(options) {
  const configDir = resolveConfigDir(options.configDir)
  const configPath = join(configDir, "cli.json")
  const config = readConfig(configPath)
  if (config.plugins !== undefined && !Array.isArray(config.plugins)) {
    throw new Error(`${configPath}: "plugins" must be an array`)
  }
  const plugins = Array.isArray(config.plugins) ? [...config.plugins] : []
  const present = plugins.some((entry) => entryName(entry) === PACKAGE_NAME)
  if (!present) plugins.push(PACKAGE_NAME)
  config.plugins = plugins
  writeConfig(configPath, config)

  if (present) {
    console.log(`Already configured in ${configPath}.`)
  } else {
    console.log(`Added "${PACKAGE_NAME}" to ${configPath}.`)
  }

  if (options.runOpencode) {
    const result = runOpencode(["plugin", "add", PACKAGE_NAME], configDir)
    if (result.ok) {
      console.log("Installed the package with the OpenCode CLI.")
    } else {
      console.log(`Skipped "opencode plugin add" (${result.reason}).`)
      console.log("OpenCode installs configured package plugins automatically on startup.")
    }
  }

  console.log("Restart OpenCode to load the plugin. Optional: run /quota-login for the credit balance.")
}

function uninstall(options) {
  const configDir = resolveConfigDir(options.configDir)
  const configPath = join(configDir, "cli.json")
  if (!existsSync(configPath)) {
    console.log(`Nothing to do: ${configPath} does not exist.`)
    return
  }
  const config = readConfig(configPath)
  const plugins = Array.isArray(config.plugins) ? config.plugins : []
  const filtered = plugins.filter((entry) => entryName(entry) !== PACKAGE_NAME)
  if (filtered.length === plugins.length) {
    console.log(`"${PACKAGE_NAME}" is not configured in ${configPath}.`)
  } else {
    config.plugins = filtered
    writeConfig(configPath, config)
    console.log(`Removed "${PACKAGE_NAME}" from ${configPath}.`)
  }
  if (options.runOpencode) {
    const result = runOpencode(["plugin", "remove", PACKAGE_NAME], configDir)
    if (result.ok) console.log("Removed the package with the OpenCode CLI.")
  }
  console.log("Restart OpenCode to unload the plugin.")
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.error) {
    console.error(`error: ${options.error}`)
    usage()
    process.exitCode = 2
    return
  }
  if (options.help) {
    usage()
    return
  }
  if (options.version) {
    console.log(`${PACKAGE_NAME} ${readPackageVersion()}`)
    return
  }
  if (options.command === "uninstall") uninstall(options)
  else install(options)
}

try {
  main()
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
