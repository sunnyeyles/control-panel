import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * The first test runner in an app rather than a package, and deliberately
 * smaller than the four in `packages/`.
 *
 * **No `tsconfig.test.json` here, and that is not an oversight.** Those packages
 * need one because their tests are excluded from `tsconfig.json` — their sources
 * compile to `dist/`, and a test file must never land in it. This app emits no
 * `dist/` and its tsconfig `include` already covers every `.ts`, so `pnpm
 * typecheck` covers these tests for free.
 *
 * Only `lib/` is covered. Everything else needs a Next request context, a live
 * session, or a browser — which is why the logic worth testing was put where it
 * can be reached without any of them, behind a `createXActions(deps)` seam.
 */
export default defineConfig({
  test: {
    include: ["lib/**/*.test.ts"],
    environment: "node",
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL(".", import.meta.url)),
    },
  },
})
