import { describe, expect, it } from "vitest"

import { createSearchLog } from "./search-log.ts"

/**
 * The log itself, which is deliberately almost nothing: what a search *records*
 * is `apify-search.test.ts`'s subject, and that is where the interesting cases
 * are. What is asserted here is the two properties a caller relies on that the
 * recording tests cannot show — order, and that one run's searches stay in one
 * run.
 */

const ATTEMPT = {
  toolName: "seek_search",
  board: "SEEK",
  query: "backend engineer",
  outcome: "ok",
  results: 3,
} as const

describe("createSearchLog", () => {
  it("keeps attempts in the order they completed", () => {
    const log = createSearchLog()

    log.record({ ...ATTEMPT, query: "first" })
    log.record({ ...ATTEMPT, query: "second" })

    expect(log.attempts().map((attempt) => attempt.query)).toEqual([
      "first",
      "second",
    ])
  })

  it("starts empty, which is what 'the scout never searched' looks like", () => {
    expect(createSearchLog().attempts()).toEqual([])
  })

  it("holds one run's searches and no other's", () => {
    // Why this is a factory and not a module-level instance. A warm Lambda
    // container serves several runs, and a log shared between them would have the
    // second run believing the first one's searches — including believing that
    // boards answered when none of them had been called yet.
    const first = createSearchLog()
    const second = createSearchLog()

    first.record(ATTEMPT)

    expect(first.attempts()).toHaveLength(1)
    expect(second.attempts()).toEqual([])
  })
})
