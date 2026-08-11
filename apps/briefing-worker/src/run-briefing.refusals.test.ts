import { AIMessage, ToolMessage } from "@langchain/core/messages"
import { describe, expect, it } from "vitest"

import {
  JOB,
  SCOUT_FINDINGS,
  fakeSession,
  installRunBriefingFixtures,
  puts,
  recorded,
  run,
  scoutReturning,
  searchFailed,
  searchResult,
  writerReturning,
} from "./run-briefing.test-helpers.ts"

installRunBriefingFixtures()

describe("refuses to produce a brief when", () => {
  it("the job config cannot be read", async () => {
    const job = { ...JOB, config: { titles: [] } }

    await expect(run({ job })).rejects.toThrow(/config this worker cannot read/)
    expect(puts).toHaveLength(0)
    expect(recorded).toHaveLength(0)
  })

  it("every search it made failed", async () => {
    // ⚠️ **The regression this whole change exists for.** Every board down,
    // and the scout honestly reporting what it could see, which was nothing.
    // This used to *succeed*: a failed search answers the model with a
    // sentence, so the transcript showed three perfectly successful tool
    // results and the gate below never fired. The brief was written, the
    // `postings` table went untouched, and the run said `succeeded`.
    await expect(
      run({
        createScout: scoutReturning(SCOUT_FINDINGS, [
          searchFailed("seek_search", "SEEK"),
          searchFailed("indeed_search", "Indeed"),
        ]),
      })
    ).rejects.toThrow(/Every one of the scout's 2 searches failed/)
    expect(puts).toHaveLength(0)
  })

  it("names the boards and quotes one failure, since nothing else will", async () => {
    // The run row carries this sentence and production keeps no trace, so
    // "which board, and what did it say" has to be in the message itself.
    await expect(
      run({
        createScout: scoutReturning(SCOUT_FINDINGS, [
          searchFailed("seek_search", "SEEK"),
        ]),
      })
    ).rejects.toThrow(/SEEK.*HTTP 500/s)
  })

  it("it never searched at all", async () => {
    // Distinct from every search failing: no board was even called. Same
    // conclusion — nothing it reported came from a live search — and a
    // different diagnosis.
    await expect(
      run({ createScout: scoutReturning(SCOUT_FINDINGS, []) })
    ).rejects.toThrow(/called none of seek_search/)
    expect(puts).toHaveLength(0)
  })

  it("no posting the scout reported came from a search", async () => {
    // Every field valid — and not one id came back from a search. A single
    // unresolvable id is a slip and costs that posting alone (see above);
    // *all* of them is a scout reporting postings it never found, and a brief
    // built from the empty remainder would cite nothing at all.
    const invented = {
      postings: [{ ...SCOUT_FINDINGS.postings[0]!, id: "deadbeefdeadbeef" }],
    }

    await expect(
      run({ createScout: scoutReturning(invented) })
    ).rejects.toThrow(/no search returned any of their ids/)
    expect(puts).toHaveLength(0)
  })

  it("the scout never submitted its findings", async () => {
    // It searched and then stopped — out of turns, or answering in prose. A
    // scout that submits an empty list has reported a result; one that never
    // submits has reported nothing, and only the second is a failed run.
    await expect(
      run({ createScout: () => fakeSession({ findings: undefined }) })
    ).rejects.toThrow(/never called submit_findings/)
    expect(puts).toHaveLength(0)
  })

  it("the scout submitted after running out of turns, and is believed", async () => {
    // The gain from capturing findings as the tool validates them rather than
    // reading the final message: a scout that reported and *then* hit its
    // budget has still reported. This used to fail the run outright.
    const halted = new ToolMessage({
      content: "Stopped: the agent reached its budget of 10 model calls.",
      tool_call_id: "call_2",
      name: "seek_search",
      status: "error",
    })

    const report = await run({
      createScout: () =>
        fakeSession({
          findings: SCOUT_FINDINGS,
          messages: [searchResult(), halted],
          reply: null,
        }),
    })

    expect(report.outcome).toBe("success")
    expect(report.postings).toBe(1)
  })

  it("the writer returned nothing", async () => {
    await expect(
      run({ createWriter: writerReturning("   \n  ") })
    ).rejects.toThrow(/empty brief/)
    expect(puts).toHaveLength(0)
    expect(recorded).toHaveLength(0)
  })
})
