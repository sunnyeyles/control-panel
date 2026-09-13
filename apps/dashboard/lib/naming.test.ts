import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import * as agents from "@workspace/agents"
import { describe, expect, it } from "vitest"

/**
 * `NAMING.md` R2, R5 and R8, asserted against the source tree.
 *
 * **This has to be a test rather than a lint rule.** `eslint-plugin-only-warn`
 * is in `packages/eslint-config/base.js`, so every rule in the repo is
 * downgraded to a warning and `pnpm lint` exits 0 no matter what it found. A
 * convention nothing can fail on is a convention that drifts.
 *
 * ⚠️ **It must live under `lib/`.** `vitest.config.ts` has
 * `include: ["lib/**\/*.test.ts"]`, so a `naming.test.ts` at the app root would
 * be silently skipped — green, and never run.
 *
 * Every assertion reads the tree with `node:fs` and matches on text. Coarse,
 * deliberately: it costs nothing, needs no parser, and the three properties it
 * pins are all lexical. Whether a name is *good* is the reviewer's job.
 */

const APP = fileURLToPath(new URL("..", import.meta.url))

/**
 * The factory names `@workspace/agents` exports, derived rather than listed.
 *
 * Listing them here would make R2 a rule about this file: adding an agent would
 * mean editing the allowed set, and forgetting to would fail a correct seam.
 * Reading the package's own exports means a new agent's factory is admissible
 * the moment it exists, and a seam naming an agent that does *not* exist fails.
 */
const AGENT_FACTORIES = new Set(
  Object.keys(agents).filter((name) => name.startsWith("create"))
)

/** Directories under `components/` that are not route segments. */
const SHARED_COMPONENT_GROUPS = new Set(["forms"])

function walk(dir: string, extensions: string[]): string[] {
  const entries = readdirSync(join(APP, dir), { withFileTypes: true })

  return entries.flatMap((entry) => {
    const path = `${dir}/${entry.name}`

    if (entry.isDirectory()) return walk(path, extensions)
    if (!extensions.some((ext) => entry.name.endsWith(ext))) return []

    return [path]
  })
}

function read(path: string): string {
  return readFileSync(join(APP, path), "utf8")
}

describe("R2 — an agent seam is named after the agent's exported factory", () => {
  /**
   * Every `create…` field declared in an interface under `lib/`.
   *
   * The match is deliberately loose about *which* interface: a seam is a
   * `create…?: () => Agent` line whatever the surrounding type is called, and
   * requiring the declaration to be inside a `*Deps` block would let a seam
   * escape the rule by being declared somewhere else.
   */
  function seamsIn(source: string): string[] {
    return [...source.matchAll(/^ {2}(create[A-Z]\w*)\?*:/gm)].map(
      (match) => match[1] as string
    )
  }

  const sources = walk("lib", [".ts"]).filter(
    (path) => !path.endsWith(".test.ts")
  )

  it("finds the seams at all, so a passing suite is not an empty one", () => {
    const found = sources.flatMap((path) => seamsIn(read(path)))

    // `ChatHandlerDeps.createAssistant` and
    // `WhiteboardHandlerDeps.createWhiteboardAgent`.
    expect(found.length).toBeGreaterThanOrEqual(2)
  })

  it("has agent factories to check against", () => {
    expect(AGENT_FACTORIES.size).toBeGreaterThanOrEqual(2)
  })

  it.each(sources)("%s", (path) => {
    const offenders = seamsIn(read(path)).filter(
      (name) => !AGENT_FACTORIES.has(name)
    )

    expect(offenders, `not exported by @workspace/agents`).toEqual([])
  })
})

describe("R5 — a `Row` does not cross into a client component", () => {
  /**
   * The half of R5 that is a runtime property rather than taste.
   *
   * A `<X>Row` is a shape `@workspace/db` returns, `Date` fields and all; a
   * `<X>View` is what has already been projected to strings for the client.
   * TypeScript will not stop a `Row` reaching a component, because a `Date` is a
   * perfectly good `Date` right up until React serializes it across the RSC
   * boundary or a browser formats it in the visitor's own locale.
   *
   * ⚠️ **The module specifier is matched first, and that filter is
   * load-bearing.** `document-list.tsx` imports `TableRow` from
   * `@workspace/ui/components/table`, which is a `<tr>` and not a row of
   * anything. The rule is about our own data crossing the boundary, so it looks
   * only at `@/lib/…` and `@workspace/db`.
   */
  const DATA_MODULE = /^(@\/lib\/|@workspace\/db$)/

  /** Named imports as `[imported, local]`, per module specifier. */
  function namedImports(source: string): { from: string; names: string[] }[] {
    return [
      ...source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g
      ),
    ].map((match) => ({
      from: match[2] as string,
      names: (match[1] as string)
        .split(",")
        // Both halves of `X as Y`: an alias is how a `Row` would arrive under
        // a name that does not say so, and the original is what it really is.
        .flatMap((binding) => binding.split(/\bas\b/))
        .map((name) => name.replace(/^\s*type\s+/, "").trim())
        .filter((name) => name.length > 0),
    }))
  }

  const sources = walk("components", [".tsx", ".ts"])

  it("sees the imports it is meant to police", () => {
    const fromData = sources
      .flatMap((path) => namedImports(read(path)))
      .filter((statement) => DATA_MODULE.test(statement.from))

    // A parse that stopped matching would otherwise pass by finding nothing.
    expect(fromData.length).toBeGreaterThanOrEqual(18)
  })

  it.each(sources)("%s", (path) => {
    const offenders = namedImports(read(path))
      .filter((statement) => DATA_MODULE.test(statement.from))
      .flatMap((statement) =>
        statement.names
          .filter((name) => name.endsWith("Row"))
          .map((name) => `${name} from ${statement.from}`)
      )

    expect(
      offenders,
      "project it to a `View` on the server — a `Row` carries `Date`s"
    ).toEqual([])
  })

  it("still catches a Row reaching a component", () => {
    const offending = `import type { DocumentRow } from "@/lib/documents/list-documents"`

    expect(
      namedImports(offending)[0]?.names.some((name) => name.endsWith("Row"))
    ).toBe(true)
  })

  it("does not catch the table primitive every list imports", () => {
    const fine = `import { TableBody, TableRow } from "@workspace/ui/components/table"`

    expect(DATA_MODULE.test(namedImports(fine)[0]?.from ?? "")).toBe(false)
  })
})

describe("R8 — `components/` mirrors the route tree", () => {
  const routeSegments = new Set(
    readdirSync(join(APP, "app/(app)"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  )

  const componentDirs = readdirSync(join(APP, "components"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)

  it.each(componentDirs)("components/%s", (name) => {
    expect(
      routeSegments.has(name) || SHARED_COMPONENT_GROUPS.has(name),
      `neither a segment of app/(app)/ nor a declared shared group`
    ).toBe(true)
  })

  /**
   * The nested half of the rule: `components/<section>/<segment>/` is legal only
   * where `app/(app)/<section>/<segment>/` exists. Without this, the first half
   * would be satisfied by putting every component in one directory named after
   * a route.
   *
   * One test rather than `it.each`: there are no nested directories today, and
   * an empty table would run nothing.
   */
  it("nests only under child routes that exist", () => {
    const offenders = componentDirs
      .filter((name) => routeSegments.has(name))
      .flatMap((section) =>
        readdirSync(join(APP, "components", section), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => `${section}/${entry.name}`)
      )
      .filter((path) => {
        try {
          statSync(join(APP, "app/(app)", path))
          return false
        } catch {
          return true
        }
      })

    expect(offenders, `no matching segment under app/(app)/`).toEqual([])
  })
})
