import { describe, expect, it } from "vitest"

import {
  fakeSession,
  installRunBriefingFixtures,
  run,
  scoutPerPass,
  searched,
  writerReturning,
} from "./run-briefing.test-helpers.ts"
import { runBriefing } from "./run-briefing.ts"

installRunBriefingFixtures()

/**
 * The silence this whole change exists to end.
 *
 * A run that recorded nothing used to be indistinguishable from a perfect one:
 * `succeeded`, a brief in S3, `recordPostings` early-returning zero without
 * touching the database, and "last ran 5 minutes ago" as the only thing
 * anybody was told.
 */
describe("a run that recorded no postings", () => {
  /** Both passes find nothing, which is the ordinary quiet-market run. */
  function quietRun(
    overrides: Partial<Parameters<typeof runBriefing>[0]> = {}
  ) {
    return run({
      createScout: scoutPerPass(
        fakeSession({
          findings: { postings: [], notes: "Nothing open this week." },
          attempts: [searched("seek_search", 0), searched("indeed_search", 0)],
        })
      ),
      createWriter: writerReturning("No roles matched this week."),
      ...overrides,
    })
  }

  it("says so, and says why", async () => {
    const report = await quietRun()

    expect(report.postings).toBe(0)
    expect(report.warnings?.noPostings).toMatchObject({
      reason: "no-matches",
      searched: 4,
      results: 0,
      excluded: 0,
      passes: 2,
      // The scout's own account of the search, which is otherwise only in a
      // brief nobody opens when it is empty.
      notes: "Nothing open this week.",
    })
  })

  it("writes a sentence a person can act on", async () => {
    const report = await quietRun()
    const noPostings = report.warnings?.noPostings as { message: string }

    // It is read on the briefing strip beside "last ran …", so it has to be
    // prose rather than counts: the run succeeded, and there is nothing else
    // on the page to explain an unchanged table.
    expect(noPostings.message).toMatch(/nothing is currently listed/i)
    expect(noPostings.message).toMatch(/broader role title/i)
  })

  it("says something different when the boards had plenty to look at", async () => {
    const report = await run({
      createScout: scoutPerPass(
        fakeSession({
          findings: { postings: [] },
          attempts: [searched("seek_search", 40)],
        })
      ),
      createWriter: writerReturning("No roles matched this week."),
    })

    const noPostings = report.warnings?.noPostings as { message: string }

    // "Nothing is listed" and "80 roles were listed and none of them fit" are
    // different problems with different answers.
    expect(noPostings.message).toMatch(/none of which matched/i)
  })

  it("stays quiet on a run that recorded something", async () => {
    const report = await run()

    expect(report.warnings).toBeUndefined()
  })
})
