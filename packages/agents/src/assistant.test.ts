import { describe, expect, it } from "vitest"

import { ASSISTANT_TOOLS } from "./assistant.ts"

/**
 * The general assistant's tool set, pinned.
 *
 * The guarantee is that nothing beyond these two — an arbitrary-URL fetcher
 * above all — reaches a chat agent, and this is where it is held.
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
