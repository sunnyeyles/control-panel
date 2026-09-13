import { defineConfig } from "vitest/config"

/**
 * The first test runner in this package, and it covers `src/lib/` only.
 *
 * **No `tsconfig.test.json`**, unlike the packages that compile to `dist/`,
 * where a test file must never land — this one has no build step, so its
 * `tsconfig.json` already covers these files and `typecheck` reaches them free.
 *
 * **`src/lib/` rather than `src/components/`, and that boundary is the point.**
 * `components/` is React over a DOM, which would mean a browser environment.
 * What is worth pinning is string-to-string and lives in `lib/` so it can be
 * reached without one — see `src/lib/markdown-plugins.ts`.
 */
export default defineConfig({
  test: {
    include: ["src/lib/**/*.test.ts"],
    environment: "node",
  },
})
