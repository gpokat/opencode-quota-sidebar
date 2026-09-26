// Compiles src/tui.tsx to dist/tui.js with the same Solid transform OpenTUI
// uses at load time. esbuild only transpiles JSX, which produces static
// children and breaks Solid reactivity in the host; Babel's solid preset
// emits the getters/memos the renderer expects.
import { transformAsync } from "@babel/core"
import solid from "babel-preset-solid"
import typescript from "@babel/preset-typescript"
import { mkdir, readFile, writeFile } from "node:fs/promises"

const entry = new URL("../src/tui.tsx", import.meta.url)
const output = new URL("../dist/tui.js", import.meta.url)

const source = await readFile(entry, "utf8")
const result = await transformAsync(source, {
  filename: "src/tui.tsx",
  configFile: false,
  babelrc: false,
  presets: [
    [solid, { moduleName: "@opentui/solid", generate: "universal" }],
    [typescript],
  ],
})
if (!result?.code) throw new Error("build: Babel produced no output")

await mkdir(new URL("../dist/", import.meta.url), { recursive: true })
await writeFile(output, result.code + "\n")
console.log(`built dist/tui.js (${(result.code.length / 1024).toFixed(1)}kb)`)
