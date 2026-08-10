import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import * as agents from "@workspace/agents"
import { describe, expect, it } from "vitest"

/**
 * `NAMING.md` R1, R2 and R8, asserted against the source tree.
 *
 * **This has to be a test rather than a lint rule**, and not because a lint rule
 * would be harder to write. `eslint-plugin-only-warn` is in
 * `packages/eslint-config/base.js`, so every rule in the repo is downgraded to a
 * warning and `pnpm lint` exits 0 no matter what it found. A convention nothing
 * can fail on is a convention that drifts, which is the whole reason these rules
 * were written down.
 *
 * ⚠️ **It must live under `lib/`.** `vitest.config.ts` has
 * `include: ["lib/**\/*.test.ts"]`, so a `naming.test.ts` at the app root would
 * be silently skipped — green, and never run.
 *
 * Every assertion here reads the tree with `node:fs` and matches on text. That
 * is coarse, deliberately: it costs nothing, needs no parser, and the three
 * properties it pins are all lexical. What it cannot see — whether a name is
 * *good* — is the reviewer's job and always was.
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

/**
 * Modules that legitimately deal in `jobs` rows — the cadence rows, which is
 * what `CONTEXT.md` reserves the word for.
 *
 * **The allowlist is the documentation.** R1 has no way to tell a correct `job`
 * from a Posting called one, so it asks instead that every file using the word
 * be a file somebody decided should. Adding an entry is a one-line diff a
 * reviewer sees; the alternative — no rule — is how `scoreOne` came to take a
 * parameter called `job` that held a Posting.
 */
const JOBS_ALLOWLIST = [
  "lib/jobs/",
  "lib/briefing-runs/",
  "lib/dev/fake-prisma.ts",
  "lib/dev/fixtures.ts",
  "components/jobs/job-tabs.tsx",
  // Reads `jobs` rows directly — `getPrisma().job.findMany` — and maps them to
  // Briefing summaries. The word is the schema's here.
  "components/jobs/schedules/briefing-section.tsx",
]

/** Directories under `components/` that are not route segments. */
const SHARED_COMPONENT_GROUPS = new Set(["forms"])

/**
 * The one subdirectory a section may have that is not a child route: what its
 * own index page is made of.
 *
 * `/jobs` *is* the Postings table, so `components/jobs/postings/` has no
 * `app/(app)/jobs/postings/` to mirror. The alternative was twenty-nine files
 * loose at `components/jobs/` beside two subdirectories, which is the layout the
 * eye cannot scan. One entry per section, declared, so the escape hatch cannot
 * quietly become a second convention.
 */
const SECTION_INDEX_GROUPS: Record<string, string> = { jobs: "postings" }

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

    expect(found.length).toBeGreaterThanOrEqual(7)
  })

  it("has agent factories to check against", () => {
    expect(AGENT_FACTORIES.size).toBeGreaterThanOrEqual(9)
  })

  it.each(sources)("%s", (path) => {
    const offenders = seamsIn(read(path)).filter(
      (name) => !AGENT_FACTORIES.has(name)
    )

    expect(offenders, `not exported by @workspace/agents`).toEqual([])
  })
})

describe("R1 — `job` names a row in `jobs`, never a Posting", () => {
  /**
   * ⚠️ **R1 is about identifiers, and only identifiers.**
   *
   * Prose uses the word constantly and correctly: `CONTEXT.md` defines a Posting
   * as "one open job advertisement", so "Paste the link to a single job
   * advertisement" is the glossary's own phrasing rather than a violation. Route
   * strings are the same — `/jobs` is the URL the Postings table lives on, and
   * changing it is a product decision. So comments, string literals and JSX text
   * are blanked out before anything is matched, leaving the positions where the
   * word would be a *name*.
   *
   * The blanking is regex-shaped and therefore approximate — it does not know
   * about a brace inside a string inside a JSX attribute, and it does not need
   * to. A false negative here costs one identifier the reviewer still sees; a
   * parser would cost a dependency and a maintenance burden for the same rule.
   */
  function code(source: string): string {
    return (
      source
        // Block comments, including the `{/* … */}` form JSX uses.
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/\/\/[^\n]*/g, " ")
        // String and template literals. Template substitutions go with them,
        // which loses a little coverage and no correctness.
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/`(?:[^`\\]|\\.)*`/g, "``")
        // JSX text: anything between a `>` and the next `<` that is not markup.
        .replace(/>[^<>{}]+</g, "><")
    )
  }

  /** `job` or `jobs` as a name — not `.job`, not part of a longer word. */
  const IDENTIFIER = /(?<![\w.$])jobs?(?![\w$])/

  const sources = [
    ...walk("lib", [".ts"]),
    ...walk("components", [".tsx", ".ts"]),
  ]
    .filter((path) => !path.endsWith(".test.ts"))
    .filter(
      (path) => !JOBS_ALLOWLIST.some((allowed) => path.startsWith(allowed))
    )

  it("checks a meaningful number of files", () => {
    expect(sources.length).toBeGreaterThan(50)
  })

  it.each(sources)("%s", (path) => {
    const offenders = code(read(path))
      .split("\n")
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => IDENTIFIER.test(line))
      .map(([number, line]) => `${number}: ${line.trim()}`)

    expect(
      offenders,
      "add the module to JOBS_ALLOWLIST if it really handles `jobs` rows"
    ).toEqual([])
  })

  it("still catches a Posting called a job", () => {
    const offending = `async function scoreOne(job: { postingId: string }) {}`

    expect(IDENTIFIER.test(code(offending))).toBe(true)
  })

  it("does not catch the glossary's own prose, or the route", () => {
    const fine = [
      `const COPY = "Paste the link to a single job advertisement"`,
      `redirect("/jobs")`,
      `// one job's runs, on the Jobs section`,
      `<p>Paste the link to a single job advertisement</p>`,
    ].join("\n")

    expect(IDENTIFIER.test(code(fine))).toBe(false)
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
   * The nested half of the rule: `components/jobs/schedules/` is legal because
   * `app/(app)/jobs/schedules/` exists. Without this, the first half would be
   * satisfied by putting every component in one directory named after a route.
   */
  it.each(
    componentDirs
      .filter((name) => routeSegments.has(name))
      .flatMap((section) =>
        readdirSync(join(APP, "components", section), { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => [section, entry.name] as const)
      )
  )("components/%s/%s", (section, segment) => {
    if (SECTION_INDEX_GROUPS[section] === segment) return

    let isRoute = true
    try {
      statSync(join(APP, "app/(app)", section, segment))
    } catch {
      isRoute = false
    }

    expect(
      isRoute,
      `app/(app)/${section}/${segment} does not exist, and ${segment} is not ${section}'s declared index group`
    ).toBe(true)
  })
})
