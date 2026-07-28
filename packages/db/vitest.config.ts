import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * Load `.env.local` into `process.env` before the suite is collected.
 *
 * Vitest does **not** do this. Vite reads `.env` files, but only exposes keys
 * matching `envPrefix` (`VITE_` by default) and only on `import.meta.env` —
 * `process.env`, which is where `stores.test.ts` looks for
 * `DATABASE_URL_UNPOOLED`, is left untouched.
 *
 * That gap is worth closing here rather than documenting, because of how it
 * fails: the integration suite skips itself when the variable is absent, so a
 * developer who has put real credentials in `.env.local` gets a green run that
 * silently exercised none of the database behaviour. A skip that looks like a
 * pass is the failure mode this whole suite exists to avoid.
 *
 * `process.loadEnvFile` is built into Node from 20.12, so this adds no
 * dependency. Existing environment variables win — CI sets
 * `DATABASE_URL_UNPOOLED` for a disposable Neon branch, and a local file must
 * not override it.
 */
const envFile = fileURLToPath(new URL(".env.local", import.meta.url))

if (existsSync(envFile)) {
  const before = { ...process.env }
  process.loadEnvFile(envFile)

  for (const [key, value] of Object.entries(before)) {
    if (value !== undefined) process.env[key] = value
  }
}

export default defineConfig({
  test: {
    // Tests sit beside the code they cover, which is why `src/**/*.test.ts` is
    // excluded from tsconfig's `include` — they must not reach `dist/`, and
    // `dist/` is the whole published surface of this package.
    include: ["src/**/*.test.ts"],
    environment: "node",
    // Test files run in a separate process, which does not inherit the mutation
    // above — Vitest only forwards what it is told to. Named explicitly rather
    // than passing all of `process.env`, so a credential that is not this
    // suite's business never reaches a worker.
    env: {
      ...(process.env.DATABASE_URL_UNPOOLED
        ? { DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED }
        : {}),
    },
    // The integration suite talks to a real Postgres and skips itself when
    // DATABASE_URL_UNPOOLED is unset, so this ceiling only bites where a
    // database exists. A claim race that deadlocks should fail the run rather
    // than hang it.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
