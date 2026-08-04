import { defineConfig } from "vitest/config"

/**
 * The first test runner in this package, and it covers `src/lib/` only.
 *
 * **No `tsconfig.test.json`, for the reason `apps/dashboard/vitest.config.ts`
 * gives**: that file is needed by the packages whose sources compile to `dist/`,
 * where a test file must never land. This package has no build step at all — it
 * is consumed as source — so its `tsconfig.json` already covers every `.ts` file
 * under it and `pnpm typecheck` reaches these tests for free.
 *
 * **`src/lib/` rather than `src/components/`, and that boundary is the point.**
 * Everything under `components/` is React over a DOM, and testing it would mean
 * a browser environment plus ProseMirror, which is a different undertaking from
 * this one. What is worth pinning here is string-to-string and was deliberately
 * moved out of the editor so it could be reached without any of that — see
 * `src/lib/markdown.ts`, which exists because the dialect it fixes had already
 * silently rewritten every letter it touched.
 */
export default defineConfig({
  test: {
    include: ["src/lib/**/*.test.ts"],
    environment: "node",
  },
})
