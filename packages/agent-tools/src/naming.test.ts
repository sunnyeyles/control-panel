import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import type { StructuredToolInterface } from "@langchain/core/tools"
import { describe, expect, it } from "vitest"

import { JOB_BOARDS } from "./boards/registry.ts"
import { createPostingDetails } from "./boards/posting-details.ts"
import { createSearchLog } from "./boards/search-log.ts"
import { getCurrentTime } from "./time.ts"
import { webSearch } from "./web-search.ts"
import { createCanvasTools } from "./whiteboard/canvas.ts"
import { createBoardSession } from "./whiteboard/session.ts"
import { sequentialCatalog } from "./test-support/search-fakes.ts"

/**
 * `NAMING.md` R9: what a tool module in this package looks like, and where a
 * tool may not appear at all.
 *
 * Worth a test for the reason R3 is: the failures are silent. A second tool
 * named `web_search` compiles, and only fails when an agent carrying both is
 * constructed — `createToolRegistry` in `@workspace/agents-core` throws on a
 * duplicate, which is late and far from the edit that caused it. A tool wrapped
 * around a page fetcher compiles and never fails at all; it just quietly hands
 * a chat agent an arbitrary-URL fetcher.
 *
 * Discovery is by construction rather than by reading source, wherever a tool
 * can be built without a network: the assertions then run against the real
 * `name` a model would see, and building every factory proves each one is
 * constructible at all. `pages/` is the exception and is checked as text,
 * because the property being asserted there is the *absence* of a tool.
 */

const SRC = fileURLToPath(new URL(".", import.meta.url))

/**
 * Every tool this package can produce, built the way a caller builds them.
 *
 * The run-bound factories get throwaway per-run state, exactly as a scout or a
 * whiteboard turn would — which is also why there is no list of tool names
 * here to fall behind: a new board in `JOB_BOARDS` is covered the moment it is
 * listed, and a new canvas verb the moment `createCanvasTools` returns it.
 */
function everyTool(): StructuredToolInterface[] {
  const catalog = sequentialCatalog()
  const log = createSearchLog()

  const session = createBoardSession({
    shapes: [],
    connections: [],
    selection: [],
    viewport: { x: 0, y: 0, w: 1200, h: 800 },
    recentEdits: [],
  })

  return [
    getCurrentTime,
    webSearch,
    createPostingDetails(catalog),
    ...JOB_BOARDS.map((board) => board.createSearch(catalog, log)),
    ...createCanvasTools(session, { turnId: "t1" }),
  ]
}

const tools = everyTool()

describe("R9 — tool names", () => {
  it("are unique across the whole catalog", () => {
    const names = tools.map((held) => held.name)
    const duplicated = names.filter(
      (name, index) => names.indexOf(name) !== index
    )

    expect(duplicated).toEqual([])
  })

  it("are snake_case, so one reads the same in every prompt", () => {
    const wrong = tools
      .map((held) => held.name)
      .filter((name) => !/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(name))

    expect(wrong).toEqual([])
  })

  it("carry a description that tells a model when to call them", () => {
    for (const held of tools) {
      expect(
        held.description.length,
        `${held.name} has no description`
      ).toBeGreaterThan(40)
    }
  })
})

/**
 * The containment that used to be spelled "absent from `allTools`", in the form
 * that cannot be satisfied by a tool merely staying out of one array.
 *
 * `pages/` is where the general fetchers live. Both retrieve a URL somebody
 * else chose, which `OVERVIEW.md` says must not be handed to an agent casually
 * — so the rule is that nothing in that directory may be a tool. A fetcher that
 * ought to become one moves out of `pages/` first, and moving it is the review
 * this rule exists to force.
 *
 * Checked by importing rather than by grepping for `tool(`. The prose in these
 * modules says "adding `tool()` around this would…" in as many words, so a text
 * match reports the warning as the violation; and an export re-exported from
 * elsewhere would pass a text match while being just as much a tool. What
 * actually matters is whether anything leaving the module has a tool's shape.
 */
describe("R9 — no tool under pages/", () => {
  const modules = readdirSync(join(SRC, "pages")).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts")
  )

  it("finds the fetchers it means to be checking", () => {
    expect(modules).toContain("page-extract.ts")
    expect(modules).toContain("page-extract-apify.ts")
  })

  /** A `StructuredToolInterface` is the pair a model is dispatched through. */
  function isToolLike(value: unknown): boolean {
    if (typeof value !== "object" && typeof value !== "function") return false
    if (value === null) return false
    return "schema" in value && "invoke" in value
  }

  for (const name of modules) {
    it(`${name} exports nothing with a tool's shape`, async () => {
      const module: Record<string, unknown> = await import(
        `./pages/${name.replace(/\.ts$/, ".ts")}`
      )

      const toolish = Object.entries(module)
        .filter(([, value]) => isToolLike(value))
        .map(([exported]) => exported)

      expect(toolish).toEqual([])
    })

    it(`${name} does not import tool() at all`, () => {
      const source = readFileSync(join(SRC, "pages", name), "utf8")

      expect(source).not.toMatch(/^import .*\btool\b.*from "@langchain\/core/m)
    })
  }
})
