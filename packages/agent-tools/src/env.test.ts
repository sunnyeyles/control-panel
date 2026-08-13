import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, it } from "vitest"

import { REQUIRED_ENV } from "./env.ts"

/**
 * `env.ts` is only worth having if it cannot fall behind the code, and a
 * hand-kept list always can. So the list is checked against the calls.
 *
 * Discovery is by reading source text rather than by importing: `requireEnv`
 * is called *inside* the function that needs the variable, which is the whole
 * point of it — no import runs one, and nothing at module scope can be
 * observed. Matching the literal is what makes a new demand visible.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url))

/** Every `.ts` under `src/`, tests and fakes excluded. */
function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      return entry.name === "test-support" ? [] : sourceFiles(path)
    }
    if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts"))
      return []
    return [path]
  })
}

const sources = sourceFiles(SRC)

/**
 * `requireEnv("APIFY_TOKEN", …)` → `APIFY_TOKEN`.
 *
 * The declaration in `internal/http.ts` is excluded by matching a call with a
 * string literal first argument — the definition's parameter is `name`, which
 * does not match.
 */
const demanded = new Set(
  sources.flatMap((path) =>
    [...readFileSync(path, "utf8").matchAll(/requireEnv\(\s*"([A-Z0-9_]+)"/g)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined)
  )
)

describe("REQUIRED_ENV", () => {
  it("declares every variable a module actually demands", () => {
    const undeclared = [...demanded].filter((name) => !(name in REQUIRED_ENV))
    expect(undeclared).toEqual([])
  })

  it("declares nothing no module reads", () => {
    const unread = Object.keys(REQUIRED_ENV).filter(
      (name) => !demanded.has(name)
    )
    expect(unread).toEqual([])
  })

  it("names, for each variable, a module that exists and reads it", () => {
    for (const [name, declared] of Object.entries(REQUIRED_ENV)) {
      expect(declared.readBy.length, `${name} lists no reader`).toBeGreaterThan(
        0
      )

      for (const relative of declared.readBy) {
        const source = readFileSync(join(SRC, relative), "utf8")
        expect(source, `${relative} does not read ${name}`).toContain(
          `requireEnv("${name}"`
        )
      }
    }
  })
})
