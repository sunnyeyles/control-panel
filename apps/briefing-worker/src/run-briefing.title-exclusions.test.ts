import { AIMessage, ToolMessage } from "@langchain/core/messages"
import type { ScoutFindings } from "@workspace/agents"
import { describe, expect, it } from "vitest"

import {
  CATALOG,
  POSTING_ID,
  SCOUT_FINDINGS,
  fakeSession,
  installRunBriefingFixtures,
  kept,
  run,
  streamOptions,
  tracked,
} from "./run-briefing.test-helpers.ts"
import type { TraceEvent } from "./trace.ts"

installRunBriefingFixtures()

/**
 * The account-wide title filter, enforced rather than asked for.
 *
 * `config.exclude` next door is rendered into the scout's brief and the model
 * may weigh it. These assertions are about the thing that is not weighed: what
 * the writer is shown, what is stored, and what the report says was left out.
 */
describe("excluding a posting by a word in its title", () => {
  const MID_ID = "aa11bb22cc33dd44"
  const MID_URL = "https://example.com/jobs/2"

  /** One senior role and one that is not, both really returned by a search. */
  const BOTH: ScoutFindings = {
    postings: [
      SCOUT_FINDINGS.postings[0]!,
      {
        ...SCOUT_FINDINGS.postings[0]!,
        id: MID_ID,
        title: "Backend Engineer",
      },
    ],
  }

  function runWithBoth(titleExclusions: string[]) {
    return run({
      titleExclusions,
      createScout: () =>
        fakeSession({
          findings: BOTH,
          catalog: { ...CATALOG, [MID_ID]: MID_URL },
          messages: [
            new ToolMessage({
              content: `1. [${POSTING_ID}] Senior Backend Engineer — Acme\n2. [${MID_ID}] Backend Engineer — Acme`,
              tool_call_id: "call_1",
              name: "seek_search",
              status: "success",
            }),
          ],
        }),
    })
  }

  it("keeps it out of the brief, the findings and the postings alike", async () => {
    const report = await runWithBoth(["senior"])

    // One decision, honoured in three places — a filter the writer applied
    // and the `postings` table did not would put a row on the table the brief
    // never mentions.
    expect(report.postings).toBe(1)
    expect(report.excludedPostings).toBe(1)
    expect(kept[0]?.findings.postings.map((posting) => posting.title)).toEqual([
      "Backend Engineer",
    ])
    expect(tracked[0]?.postings.map((posting) => posting.title)).toEqual([
      "Backend Engineer",
    ])
  })

  it("does not show the writer what it excluded", async () => {
    // The prompt is the findings verbatim as JSON, so a title left in it is a
    // role the brief can still be written about.
    const prompts: string[] = []

    await run({
      titleExclusions: ["senior"],
      trace: (event) => {
        if (event.type === "prompt" && event.agent === "writer") {
          prompts.push(event.text)
        }
      },
      createScout: () =>
        fakeSession({
          findings: BOTH,
          catalog: { ...CATALOG, [MID_ID]: MID_URL },
        }),
    })

    expect(prompts[0]).toContain("Backend Engineer")
    expect(prompts[0]).not.toContain("Senior Backend Engineer")
  })

  it("tells the scout, so the search is not spent on them either", async () => {
    const prompts: string[] = []

    await run({
      titleExclusions: ["senior"],
      trace: (event) => {
        if (event.type === "prompt" && event.agent === "scout") {
          prompts.push(event.text)
        }
      },
    })

    // Belt and braces. The filter above is the guarantee; this only stops the
    // scout paying for roles that are going to be thrown away.
    expect(prompts[0]).toContain("senior")
    expect(prompts[0]).toMatch(/never report a posting whose title/i)
  })

  it("matches a whole word rather than a substring", async () => {
    // The rule `@workspace/job-search` owns, reached through the run: a user
    // who blocked `ml` must not lose every HTML role, and there is nothing on
    // screen to notice it by if they do.
    const report = await runWithBoth(["ml"])

    expect(report.postings).toBe(2)
    expect(report.excludedPostings).toBe(0)
  })

  it("reports the exclusion as a step detail, and stays quiet without one", async () => {
    function detailOf(events: TraceEvent[]) {
      return events.find(
        (event) =>
          event.type === "step" &&
          event.phase === "end" &&
          event.step === "filter"
      )
    }

    const filtered: TraceEvent[] = []
    await run({
      titleExclusions: ["senior"],
      trace: (event) => filtered.push(event),
      createScout: () =>
        fakeSession({
          findings: BOTH,
          catalog: { ...CATALOG, [MID_ID]: MID_URL },
        }),
    })

    expect(detailOf(filtered)).toMatchObject({
      detail: "1 posting excluded by title",
    })

    // A run with no filter reads exactly as it did before this step existed.
    const unfiltered: TraceEvent[] = []
    await run({ trace: (event) => unfiltered.push(event) })

    expect(detailOf(unfiltered)).not.toHaveProperty("detail")
  })

  it("is not a warning, because it is the filter working", async () => {
    const report = await runWithBoth(["senior"])

    // Every other thing a run can lose is a fault, and the warning is how
    // somebody finds out. This one was asked for, so it is a count.
    expect(report.outcome).toBe("success")
    expect(report.warnings).toBeUndefined()
  })

  it("reports nothing excluded when the user has no filter", async () => {
    const report = await run()

    expect(report.excludedPostings).toBe(0)
  })
})
