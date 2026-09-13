/**
 * Every environment variable a tool in this package can demand, declared.
 *
 * Each is read through `requireEnv` at call time rather than at import, so
 * importing a tool module never throws and a missing variable surfaces as a
 * failed call instead of a failed deploy — which is the right trade, and also
 * the reason the demand is invisible. Nothing about `@workspace/agent-tools`'s
 * surface says it wants a Tavily key; you find out when a search fails.
 *
 * So the demands are listed here, and `env.test.ts` asserts the list is
 * complete by reading every `requireEnv("…")` call in `src/`. One variable is
 * a thin list. The point is not today's one: it is that the next tool cannot
 * add a second without either declaring it or failing the suite.
 *
 * ⚠️ **Declaring a variable here does not make it reach a task.** Turborepo
 * runs in strict env mode, so a variable absent from `turbo.json` is removed
 * from the process environment rather than merely unhashed. This list is what a
 * deployer checks `globalEnv` and the deployment's configuration *against*; it
 * does not supply anything itself. See the strict-env note in the root
 * `CLAUDE.md`.
 */

export interface RequiredEnvVar {
  /** What the variable is for, in a sentence a deployer can act on. */
  purpose: string
  /** The modules that read it, relative to `src/`. */
  readBy: readonly string[]
}

export const REQUIRED_ENV: Record<string, RequiredEnvVar> = {
  TAVILY_API_KEY: {
    purpose: "Tavily's REST API, for general web search.",
    readBy: ["web-search.ts"],
  },
}
