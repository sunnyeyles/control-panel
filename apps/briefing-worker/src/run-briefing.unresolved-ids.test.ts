import { describe, expect, it } from "vitest"

import {
  FINDINGS,
  POSTING_ID,
  SCOUT_FINDINGS,
  fakeSession,
  installRunBriefingFixtures,
  kept,
  puts,
  run,
  scoutReturning,
  tracked,
} from "./run-briefing.test-helpers.ts"
import type { TraceEvent } from "./trace.ts"

installRunBriefingFixtures()

describe("when a search did not return one of the reported ids", () => {
  const REAL = SCOUT_FINDINGS.postings[0]!
  const INVENTED = {
    ...REAL,
    id: "deadbeefdeadbeef",
    title: "Staff Engineer",
  }

  /** A run reporting one posting a search returned and one it did not. */
  function runWithOneInvented() {
    return run({
      createScout: scoutReturning({ postings: [REAL, INVENTED] }),
    })
  }

  it("still writes the brief from the postings that survived", async () => {
    const report = await runWithOneInvented()

    // One unresolvable id among several costs that posting alone. Throwing
    // the run away over it would throw away the other postings, the brief,
    // and the cumulative record with them.
    expect(report.outcome).toBe("success")
    expect(report.postings).toBe(1)
    expect(puts).toHaveLength(1)
    expect(kept[0]?.findings.postings).toEqual(FINDINGS.postings)
    expect(tracked[0]?.postings).toHaveLength(1)
  })

  it("says what it left out, since nothing else ever will", async () => {
    const report = await runWithOneInvented()

    // The brief does not mention what is missing from it and the run
    // succeeded, so without this the drop is invisible in production. The
    // title rides along because an id alone identifies nothing to a person —
    // and it is the scout's own title, which is the point when what is being
    // diagnosed is a posting it may have invented outright.
    expect(report.warnings).toEqual({
      unresolvedPostings: {
        message: "1 posting dropped: the scout named an id no search returned.",
        postings: [{ id: INVENTED.id, title: "Staff Engineer" }],
      },
    })
  })

  it("reports the drop as a hand-off step detail", async () => {
    const events: TraceEvent[] = []
    await run({
      trace: (event) => events.push(event),
      createScout: scoutReturning({ postings: [REAL, INVENTED] }),
    })

    expect(
      events.find(
        (event) =>
          event.type === "step" &&
          event.phase === "end" &&
          event.step === "handoff"
      )
    ).toMatchObject({
      detail: "1 posting dropped — no search returned the id",
    })
  })

  it("stays quiet about a hand-off that dropped nothing", async () => {
    const events: TraceEvent[] = []
    await run({ trace: (event) => events.push(event) })

    // The `handoff` event already carries the findings; a detail restating
    // their count would be the same fact twice.
    expect(
      events.find(
        (event) =>
          event.type === "step" &&
          event.phase === "end" &&
          event.step === "handoff"
      )
    ).not.toHaveProperty("detail")
  })

  it("links to the URL the board issued, not to anything reported", async () => {
    // The scout never sees a URL, so the one in the brief can only have come
    // out of the catalog. That is the whole reason the hand-off carries ids:
    // the seven production runs lost over 2026-08-05/06 were all a URL typed
    // back slightly wrong, and there is nothing left to type.
    const issued =
      "https://au.linkedin.com/jobs/view/engineer-at-acme-443814?position=58&trackingId=vwiYgy%3D%3D"

    await run({
      createScout: () =>
        fakeSession({
          findings: SCOUT_FINDINGS,
          catalog: { [POSTING_ID]: issued },
        }),
    })

    expect(kept[0]?.findings.postings[0]?.url).toBe(issued)
  })
})
