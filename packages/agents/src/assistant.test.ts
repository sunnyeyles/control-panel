import { describe, expect, it } from "vitest"

import { ASSISTANT_TOOLS } from "./assistant.ts"

/**
 * The general assistant's tool set, pinned.
 *
 * This is the half of the old `allTools` assertion worth keeping. Those lived
 * in `@workspace/agent-tools`, in `page-extract.test.ts` and `board-posting.test.ts`,
 * and asserted an exact list — the guarantee being that an arbitrary-URL
 * fetcher never reaches a chat agent. `allTools` is gone, so the guarantee
 * moved to the two places that can still carry it: R9 in that package forbids a
 * `tool()` under `pages/` at all, and this pins what the assistant is handed.
 *
 * An exact list rather than a "does not contain a fetcher" check, deliberately.
 * Adding a tool to the general assistant is a product decision — it widens what
 * a chat agent can do for anyone who can reach the chat — and a failing test is
 * the right way to be asked to make it on purpose.
 */
describe("ASSISTANT_TOOLS", () => {
  it("is exactly the two tools that are safe to hand a chat agent", () => {
    expect(ASSISTANT_TOOLS.map((held) => held.name)).toEqual([
      "get_current_time",
      "web_search",
    ])
  })

  it("holds module singletons, so importing this never builds a run's state", () => {
    for (const held of ASSISTANT_TOOLS) {
      expect(typeof held.invoke).toBe("function")
    }
  })
})
