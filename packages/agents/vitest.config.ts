import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    // Tests sit beside the code they cover, which is why `src/**/*.test.ts` is
    // excluded from tsconfig's `include` — they must not reach `dist/`, and
    // `dist/` is the whole published surface of this package.
    //
    // `evals/` is here for a different reason. The eval *runner* costs money
    // and is a script, not a suite; its **graders** are pure functions whose
    // correctness everything downstream depends on, so they are tested here,
    // for free, in the ordinary `pnpm test`. A grader that reports "no overlap"
    // while two boxes are stacked would make every eval number a lie.
    include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
    environment: "node",
  },
})
