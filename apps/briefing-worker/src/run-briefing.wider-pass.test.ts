import { describe, expect, it, vi } from "vitest"

import {
  CATALOG,
  FINDINGS,
  JOB,
  POSTING_ID,
  SCOUT_FINDINGS,
  SLOT,
  fakeAgent,
  fakeSession,
  installRunBriefingFixtures,
  kept,
  noSearches,
  puts,
  recorded,
  run,
  scoutPerPass,
  scoutReturning,
  searchFailed,
  searchResult,
  searched,
  streamOptions,
  tracked,
  writerReturning,
} from "./run-briefing.test-helpers.ts"

installRunBriefingFixtures()

/**
 * A run that reports nothing has spent its money and produced a briefing with
 * no postings in it, so one more attempt is worth making before it gives up.
 * What these pin is *when* the second pass happens — the cases where it does
 * not are as much of the rule as the case where it does.
 */
describe("the second, wider pass", () => {
  it("runs when the first pass found nothing and finds something", async () => {
    const report = await run({
      createScout: scoutPerPass(
        fakeSession({ findings: { postings: [] } }),
        fakeSession({ findings: SCOUT_FINDINGS })
      ),
    })

    expect(report.scoutPasses).toBe(2)
    expect(report.postings).toBe(1)
    // A run that recovered is a run that found postings: no warning, because
    // nothing is being explained away.
    expect(report.warnings).toBeUndefined()
    expect(tracked[0]?.postings).toHaveLength(1)
  })

  it("asks for the same criteria, read wider", async () => {
    const prompts: string[] = []

    await run({
      createScout: scoutPerPass(
        fakeSession({ findings: { postings: [] } }),
        fakeSession({ findings: SCOUT_FINDINGS })
      ),
      trace: (event) => {
        if (event.type === "prompt" && event.agent === "scout") {
          prompts.push(event.text)
        }
      },
    })

    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toMatch(/search wider/i)
    // The criteria themselves are unchanged — a wider brief relaxes how they
    // are read, and never invents a role the candidate never asked for.
    expect(prompts[1]).toMatch(/search wider/i)
    expect(prompts[1]).toContain("senior backend engineer")
  })

  it("does not run when the first pass found postings", async () => {
    const report = await run()

    expect(report.scoutPasses).toBe(1)
  })

  it("does not run when the title filter is what emptied the run", async () => {
    // A wider search finds more of the same roles and the filter eats those
    // too, so a second pass would spend a scout's worth of model calls to
    // arrive back here. The warning says so instead.
    const report = await run({
      titleExclusions: ["senior"],
      createScout: scoutPerPass(fakeSession({ findings: SCOUT_FINDINGS })),
    })

    expect(report.scoutPasses).toBe(1)
    expect(report.postings).toBe(0)
    expect(report.excludedPostings).toBe(1)
    expect(report.warnings?.noPostings).toMatchObject({
      reason: "all-excluded",
    })
  })

  it("cannot make a run worse than not having attempted it", async () => {
    // The retry is a bonus. A board that goes down between the two passes must
    // not turn a run that honestly found nothing into a failed one — so the
    // wider pass's failure is recorded on the warning rather than thrown.
    const report = await run({
      createScout: scoutPerPass(
        fakeSession({ findings: { postings: [] } }),
        fakeSession({
          findings: { postings: [] },
          attempts: [searchFailed()],
        })
      ),
      createWriter: writerReturning("No roles matched this week."),
    })

    expect(report.outcome).toBe("success")
    expect(report.scoutPasses).toBe(2)
    expect(report.warnings?.noPostings).toMatchObject({
      reason: "no-matches",
      widerPassFailed: expect.stringMatching(/failed/) as unknown as string,
    })
  })
})
