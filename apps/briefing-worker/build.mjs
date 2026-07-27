import { copyFile, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, "dist")

/**
 * `dist/` is the complete deploy root, not just compiler output: the zip that
 * reaches Flex Consumption is its contents and nothing else. That is why
 * `host.json` is copied in and a second `package.json` is generated below —
 * the Functions host looks for both at the root of the package it runs.
 *
 * Bundling is the whole point of the packaging choice: pnpm's symlinked
 * `node_modules` does not survive run-from-package mounting, so the artifact
 * ships with no `node_modules` at all. `@azure/functions` and the LangChain
 * stack are pure JS and bundle cleanly; the one exception is noted below.
 */
await rm(outDir, { recursive: true, force: true })
await mkdir(outDir, { recursive: true })

await esbuild.build({
  entryPoints: [join(root, "src/index.ts")],
  outfile: join(outDir, "index.js"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  sourcemap: true,
  // Not an npm package: the Functions host injects `@azure/functions-core`
  // into the worker at runtime. Bundling it is impossible — it must resolve
  // from the host, so it stays external even though nothing else does.
  external: ["@azure/functions-core"],
  // Some transitive CommonJS in the LangChain stack calls `require` at load
  // time, which an ESM bundle has no binding for. Supply one.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module"',
      "const require = __createRequire(import.meta.url)",
    ].join("\n"),
  },
  logLevel: "info",
})

await copyFile(join(root, "host.json"), join(outDir, "host.json"))

// The v4 Node programming model finds the module that registers functions
// through `main`. Deliberately minimal and dependency-free: the bundle has no
// runtime dependencies left to declare.
await writeFile(
  join(outDir, "package.json"),
  `${JSON.stringify(
    {
      name: "briefing-worker",
      version: "0.0.0",
      type: "module",
      main: "index.js",
    },
    null,
    2
  )}\n`
)
