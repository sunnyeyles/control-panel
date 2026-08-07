import { describe, expect, it } from "vitest"

import { ScoutFindingsSchema, type ScoutFindings } from "./findings.ts"
import { createSubmitFindings } from "./submit-findings.ts"

/**
 * What is under test is the capture, not the validation: the schema is
 * `ScoutFindingsSchema` itself, so proving it rejects a bad shape would be
 * proving Zod works. What is worth proving is that the tool hands over exactly
 * what the schema accepted, that nothing leaks between runs, and that a scout
 * which corrects itself is believed the second time.
 */

const POSTING = {
  id: "7f3a91c2aa10bb42",
  title: "Senior Backend Engineer",
  company: "Acme",
  location: "Sydney NSW",
  summary: "Building payment services.",
  matchReason: "Backend, Sydney, and the stack the candidate asked for.",
}

const FINDINGS: ScoutFindings = { postings: [POSTING] }

/** Call the tool the way the runtime does — through `invoke`, post-validation. */
async function submit(
  tool: ReturnType<typeof createSubmitFindings>["tool"],
  findings: unknown
): Promise<string> {
  return (await tool.invoke(findings as ScoutFindings)) as string
}

describe("createSubmitFindings", () => {
  it("has nothing to hand over before it is called", () => {
    // A real outcome, not a default: a scout that never reported has not
    // reported an empty result, and the run tells the two apart.
    expect(createSubmitFindings().submitted()).toBeUndefined()
  })

  it("hands over what the scout submitted", async () => {
    const submitFindings = createSubmitFindings()
    await submit(submitFindings.tool, FINDINGS)

    expect(submitFindings.submitted()).toEqual(FINDINGS)
  })

  it("keeps an honestly empty result, which is not the same as no result", async () => {
    const submitFindings = createSubmitFindings()
    await submit(submitFindings.tool, {
      postings: [],
      notes: "Nothing open this week.",
    })

    expect(submitFindings.submitted()).toEqual({
      postings: [],
      notes: "Nothing open this week.",
    })
  })

  it("believes a correction rather than the first attempt", async () => {
    // A scout that reports, notices it left one out and reports again means the
    // second one. Keeping the first would silently discard the correction.
    const submitFindings = createSubmitFindings()
    await submit(submitFindings.tool, FINDINGS)
    await submit(submitFindings.tool, {
      postings: [POSTING, { ...POSTING, id: "a1b2c3d4e5f60718" }],
    })

    expect(submitFindings.submitted()?.postings).toHaveLength(2)
  })

  it("tells the model it is finished, so the run does not search again", async () => {
    const answer = await submit(createSubmitFindings().tool, FINDINGS)

    expect(answer).toMatch(/Recorded 1 posting/)
    expect(answer).toMatch(/stop/i)
  })

  it("keeps one run's findings out of the next", async () => {
    // Per run, like the catalog it reports against. A module-level instance
    // would carry a briefing's postings into the one after it, and on a warm
    // Lambda container that is not hypothetical.
    const first = createSubmitFindings()
    await submit(first.tool, FINDINGS)

    expect(createSubmitFindings().submitted()).toBeUndefined()
    expect(first.submitted()).toEqual(FINDINGS)
  })

  it("is the findings schema itself, so the contract has one definition", () => {
    // The provider validates against this, which is what makes a malformed
    // hand-off a tool result the model can correct rather than a failed run.
    expect(createSubmitFindings().tool.schema).toBe(ScoutFindingsSchema)
  })
})
