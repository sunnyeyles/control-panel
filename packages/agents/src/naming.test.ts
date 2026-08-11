import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import * as agents from "./index.ts"

/**
 * `NAMING.md` R3: every agent module here has the same three exports, and
 * `index.ts` re-exports all three.
 *
 * The rule is worth a test because the failures are silent. A prompt constant
 * that is declared but not exported, or exported from its module but missing
 * from `index.ts`, breaks nothing and compiles fine — it just means the one
 * place a reader would look for an agent's prompt does not have it. Three had
 * drifted that way before this existed: `BRIEF_WRITER_SYSTEM_PROMPT` was
 * module-private, and `PROFILE_EXTRACTOR_SYSTEM_PROMPT` and
 * `JOB_SCOUT_SYSTEM_PROMPT` never reached the barrel.
 *
 * Discovery is by export rather than by filename. `Object.keys` of the package
 * gives the factories; each one names the agent, and the agent names the other
 * two exports. So a new agent is covered the moment `index.ts` exports its
 * factory, and there is no list here to forget to update.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url))

/** `createCoverLetterWriter` → `CoverLetterWriter`. */
function agentOf(factory: string): string {
  return factory.slice("create".length)
}

/**
 * `CoverLetterWriter` → `COVER_LETTER_WRITER_SYSTEM_PROMPT`.
 *
 * A trailing `Agent` is dropped: it is a category noun rather than part of the
 * agent's name, and it is in `createWhiteboardAgent` only because
 * `createWhiteboard` would read as a factory for a whiteboard. The prompt is
 * `WHITEBOARD_SYSTEM_PROMPT`, which is right.
 */
function promptNameFor(agent: string): string {
  const name = agent.replace(/Agent$/, "")

  return `${name.replace(/(?<!^)([A-Z])/g, "_$1").toUpperCase()}_SYSTEM_PROMPT`
}

const factories = Object.keys(agents)
  .filter((name) => name.startsWith("create") && /^create[A-Z]/.test(name))
  .sort()

const exported = new Set(Object.keys(agents))

/**
 * `index.ts` as text, because a `type` re-export is erased at runtime and
 * `Object.keys` cannot see it. The options type is checked against the source
 * for that reason; the two value exports are checked against the module object,
 * which is stronger.
 */
const barrel = readFileSync(join(SRC, "index.ts"), "utf8")

describe("R3 — every agent module has one fixed surface", () => {
  it("found the agents", () => {
    expect(factories.length).toBeGreaterThanOrEqual(9)
    expect(factories).toContain("createBriefWriter")
    expect(factories).toContain("createWhiteboardAgent")
  })

  it.each(factories)("%s", (factory) => {
    const agent = agentOf(factory)

    expect(typeof agents[factory as keyof typeof agents]).toBe("function")

    expect(
      barrel,
      `Create${agent}Options is not re-exported from index.ts`
    ).toContain(`Create${agent}Options`)

    const prompt = promptNameFor(agent)

    expect(
      exported.has(prompt),
      `${prompt} is missing from index.ts — see NAMING.md R3`
    ).toBe(true)

    expect(typeof agents[prompt as keyof typeof agents]).toBe("string")
  })
})

describe("the derivation the rule rests on", () => {
  it("turns a factory name into its prompt constant", () => {
    expect(promptNameFor(agentOf("createCoverLetterWriter"))).toBe(
      "COVER_LETTER_WRITER_SYSTEM_PROMPT"
    )
    expect(promptNameFor(agentOf("createJobScout"))).toBe(
      "JOB_SCOUT_SYSTEM_PROMPT"
    )
    expect(promptNameFor(agentOf("createWhiteboardAgent"))).toBe(
      "WHITEBOARD_SYSTEM_PROMPT"
    )
  })
})

/**
 * Factories here that do not build an agent.
 *
 * `createSubmitFindings` builds the LangChain tool the scout hands its results
 * back through. It is `job-scout.ts`'s own dependency and has no business in the
 * package's public surface, so it is named here rather than exported to satisfy
 * a rule about agents.
 */
const NOT_AGENT_FACTORIES = new Set(["createSubmitFindings"])

describe("every agent module is reachable from index.ts", () => {
  /**
   * The other direction, and the one that catches a module nobody wired up: a
   * file that defines a `create<Agent>` and never reaches the barrel is a
   * feature that exists and cannot be imported.
   */
  const modules = readdirSync(SRC)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"))
    .filter((name) => name !== "index.ts")

  it.each(modules)("%s", (name) => {
    const source = readFileSync(join(SRC, name), "utf8")
    const declared = [
      ...source.matchAll(/^export (?:const|function) (create[A-Z]\w*)/gm),
    ]
      .map((match) => match[1] as string)
      .filter((factory) => !NOT_AGENT_FACTORIES.has(factory))

    for (const factory of declared) {
      expect(exported.has(factory), `${factory} never reaches index.ts`).toBe(
        true
      )
    }
  })
})
