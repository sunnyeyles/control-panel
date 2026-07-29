import { fileURLToPath } from "node:url"

import { defineConfig } from "vitest/config"

/**
 * The first test runner in an app rather than a package, and it is deliberately
 * smaller than the four in `packages/`.
 *
 * **No `tsconfig.test.json` here, and that difference is not an oversight.**
 * Those packages need one because their tests are excluded from `tsconfig.json`
 * — their sources compile to `dist/`, which is their entire published surface,
 * and a test file must never land in it. This app emits no `dist/`, and its
 * tsconfig `include` already covers every `.ts` file, so `pnpm typecheck`
 * covers these tests for free. Adding a second tsconfig for symmetry would only
 * give the tests a config that never runs.
 *
 * Only `lib/documents` is covered. Everything else in this app needs a Next
 * request context, a live session, or a browser — things Vitest cannot supply
 * and a fake would only pretend to. The logic worth testing was deliberately
 * put where it can be reached without any of them.
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
