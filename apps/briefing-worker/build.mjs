import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import * as esbuild from "esbuild"

const root = dirname(fileURLToPath(import.meta.url))
const outDir = join(root, "dist")

/**
 * `dist/` is the complete deploy root, not just compiler output: the zip that
 * reaches Lambda is its contents and nothing else. That is why a second
 * `package.json` is generated below — Lambda reads it from the root of the
 * package it unpacks.
 *
 * Bundling is the whole point of the packaging choice: pnpm's symlinked
 * `node_modules` does not survive being zipped, so the artifact ships with no
 * `node_modules` at all. The AWS SDK and the LangChain stack are pure JS and
 * bundle cleanly; the one wrinkle is noted below.
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
  // Off deliberately. Node ignores source maps unless started with
  // --enable-source-maps, which this app does not set, so shipping one would
  // add ~8 MB to a package Lambda unpacks on every cold start for no runtime
  // benefit. Diagnostics come from the run report's `error` field instead.
  // Flip to `true` locally when a stack trace is worth it.
  sourcemap: false,
  // Nothing is external. The Node 22 runtime does ship an AWS SDK, but relying
  // on it pins the worker to whatever version the runtime happens to carry;
  // bundling `client-secrets-manager` costs about a megabyte and makes the
  // deployed version the one in the lockfile.
  //
  // Some transitive CommonJS in the LangChain stack calls `require` at load
  // time, which an ESM bundle has no binding for. Supply one. This is
  // load-bearing: without it the bundle dies at import with an opaque
  // `require is not defined`.
  banner: {
    js: [
      'import { createRequire as __createRequire } from "node:module"',
      "const require = __createRequire(import.meta.url)",
    ].join("\n"),
  },
  logLevel: "info",
})

// `"type": "module"` is the whole reason this file exists: it is what makes
// Lambda load `index.js` as ESM, so the runtime finds the named `handler`
// export. Without it the runtime treats the bundle as CommonJS and fails at
// import. There is no `main` — Lambda locates the entry from its own
// `handler = "index.handler"` setting, not from this file. Deliberately
// dependency-free: the bundle has no runtime dependencies left to declare.
await writeFile(
  join(outDir, "package.json"),
  `${JSON.stringify(
    {
      name: "briefing-worker",
      version: "0.0.0",
      type: "module",
    },
    null,
    2
  )}\n`
)
