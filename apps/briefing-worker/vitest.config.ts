import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Tests sit beside the code they cover. Nothing here is bundled by
    // `build.mjs`, which has a single entry point, so they cannot reach
    // `lambda.zip` — but they are still excluded from `tsconfig.json` to keep
    // the arrangement identical to the packages.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
})
