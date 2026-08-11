import type { PrismaClient } from "@workspace/db"
import { describe, expect, it } from "vitest"

import { runActivityForUser, type RunActivity } from "./run-activity"

/**
 * What a briefing's latest Run is shown as, and in particular what a *succeeded*
 * run that recorded nothing is shown as.
 *
 * That case was the silence: `succeeded`, an unchanged Postings table, and "Last
 * ran 5 minutes ago" as the only thing the user was told, whether the run had
 * added twenty postings or none. The worker now writes a sentence into
 * `runs.failure` on the succeeded row — which is what that column is for — and
 * this is the read that surfaces it.
 *
 * Driven through `runActivityForUser` with a fake `$queryRaw`, because the state
 * machine it implements is not exported and should not be: the interesting
 * behaviour is "a row like this shows like that".
 */

const USER_ID = "33333333-3333-4333-8333-333333333333"

interface RunRow {
  id: string
  jobId: string
  status: string
  scheduledFor: Date | null
  startedAt: Date
  finishedAt: Date | null
  failure: unknown
}

const NOW = new Date("2026-08-11T10:00:00.000Z")

function succeeded(failure: unknown): RunRow {
  return {
    id: "run-1",
    jobId: "job-1",
    status: "succeeded",
    scheduledFor: new Date("2026-08-11T09:30:00.000Z"),
    startedAt: new Date("2026-08-11T09:30:00.000Z"),
    finishedAt: new Date("2026-08-11T09:31:00.000Z"),
    failure,
  }
}

/** A client that answers the one raw query this module makes. */
function prismaReturning(rows: RunRow[]): PrismaClient {
  return { $queryRaw: async () => rows } as unknown as PrismaClient
}

async function activityFor(rows: RunRow[]): Promise<RunActivity> {
  const activities = await runActivityForUser(
    prismaReturning(rows),
    USER_ID,
    NOW
  )

  const first = activities[0]
  if (!first) throw new Error("expected one briefing's activity")

  return first.activity
}

describe("a succeeded run that recorded no postings", () => {
  const noPostings = {
    noPostings: {
      message: "Searched the boards 6 times, and nothing is currently listed.",
      reason: "no-matches",
      searched: 6,
      results: 0,
      excluded: 0,
    },
  }

  it("carries the reason the run added nothing", async () => {
    expect(await activityFor([succeeded(noPostings)])).toMatchObject({
      state: "succeeded",
      note: "Searched the boards 6 times, and nothing is currently listed.",
    })
  })

  it("says nothing when the run recorded postings", async () => {
    // The ordinary run, and it has to read exactly as it did before any of this
    // existed: `failure` is null and there is no note.
    expect(await activityFor([succeeded(null)])).toEqual({
      state: "succeeded",
      ranAt: expect.any(String) as unknown as string,
    })
  })

  it("ignores the warnings that are not about an empty run", async () => {
    // A lost `postings` write is real and is not what somebody is asking when
    // they look at a briefing whose table did not change.
    expect(
      await activityFor([
        succeeded({ postings: { message: "the postings table is gone" } }),
      ])
    ).not.toHaveProperty("note")
  })

  it("shows nothing rather than [object Object] on a shape it cannot read", async () => {
    // `runs.failure` is an opaque bag that `@workspace/db` never looks inside, so
    // every read of it here is a guess about what the worker wrote.
    for (const failure of [
      { noPostings: "just a string" },
      { noPostings: { message: 42 } },
      { noPostings: { message: "   " } },
      { noPostings: null },
      "not an object at all",
      42,
    ]) {
      expect(await activityFor([succeeded(failure)])).not.toHaveProperty("note")
    }
  })
})

describe("a failed run", () => {
  it("still reads its own message off the top of the bag", async () => {
    // The note and the reason are two reads of one column at different depths,
    // and widening one must not disturb the other.
    const activity = await activityFor([
      {
        ...succeeded({ message: "every search failed" }),
        status: "failed",
      },
    ])

    expect(activity).toMatchObject({
      state: "failed",
      reason: "every search failed",
    })
    expect(activity).not.toHaveProperty("note")
  })
})
