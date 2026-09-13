import type { StructuredToolInterface } from "@langchain/core/tools"
import { describe, expect, it } from "vitest"

import { getCurrentTime } from "./time.ts"
import { webSearch } from "./web-search.ts"
import { createCanvasTools } from "./whiteboard/canvas.ts"
import { createBoardSession } from "./whiteboard/session.ts"

/**
 * `NAMING.md` R9: what a tool module in this package looks like.
 *
 * Worth a test for the reason R3 is: the failures are silent. A second tool
 * named `web_search` compiles, and only fails when an agent carrying both is
 * constructed — `createToolRegistry` in `@workspace/agents-core` throws on a
 * duplicate, which is late and far from the edit that caused it.
 *
 * Discovery is by construction rather than by reading source: the assertions
 * then run against the real `name` a model would see, and building every
 * factory proves each one is constructible at all.
 */

/**
 * Every tool this package can produce, built the way a caller builds them.
 *
 * The turn-bound factory gets throwaway state, exactly as a whiteboard turn
 * would — which is also why there is no list of tool names here to fall
 * behind: a new canvas verb is covered the moment `createCanvasTools` returns
 * it.
 */
function everyTool(): StructuredToolInterface[] {
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
