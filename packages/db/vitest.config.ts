import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Tests sit beside the code they cover, which is why `src/**/*.test.ts` is
    // excluded from tsconfig's `include` — they must not reach `dist/`, and
    // `dist/` is the whole published surface of this package.
    include: ["src/**/*.test.ts"],
    environment: "node",
    // The integration suite talks to a real Postgres and skips itself when
    // DATABASE_URL_UNPOOLED is unset, so this ceiling only bites in CI where a
    // database exists. A claim race that deadlocks should fail the run rather
    // than hang it.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
