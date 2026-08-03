import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Tests sit beside the code they cover, which is why `src/**/*.test.ts` is
    // excluded from tsconfig's `include` — they must not reach `dist/`, and
    // `dist/` is the whole published surface of this package.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
})
