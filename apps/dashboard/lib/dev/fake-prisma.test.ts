import { latestPostingsForUser } from "@/lib/briefings/latest-postings"
import { createDevPrisma } from "@/lib/dev/fake-prisma"
import {
  DEV_JOB_ACTIVE_ID,
  DEV_JOB_PAUSED_ID,
  DEV_USER_ID,
} from "@/lib/dev/fixtures"
import { pauseJob, resumeJob, updateJobSchedule } from "@workspace/db"
import { describe, expect, it } from "vitest"

/**
 * Driven through the real consumers rather than through raw Prisma calls.
 *
 * `latestPostingsForUser`, `pauseJob`, `resumeJob` and `updateJobSchedule` are
 * what actually talk to this fake in the running app, and they are where its
 * contract lives — `updateJobSchedule` in particular reaches it through
 * `$executeRaw`, which no hand-written query in a test would have exercised.
 * Asserting against them is what makes this a test of "does the dev environment
 * work" instead of a test of the fake agreeing with itself.
 */

describe("the DEV_AUTH_BYPASS fake database", () => {
  it("scopes briefings to the user asking", async () => {
    const prisma = createDevPrisma()

    expect(await latestPostingsForUser(prisma, DEV_USER_ID)).not.toHaveLength(0)
    expect(
      await latestPostingsForUser(
        prisma,
        "00000000-0000-4000-8000-000000000999"
      )
    ).toEqual([])
  })

  it("returns the newest succeeded run's findings, and only one", async () => {
    const prisma = createDevPrisma()

    const briefings = await latestPostingsForUser(prisma, DEV_USER_ID)
    const active = briefings.find(
      (briefing) => briefing.briefingId === DEV_JOB_ACTIVE_ID
    )

    expect(active?.latest.state).toBe("recorded")

    // Proves the nested `select` was honoured rather than the whole row handed
    // back: `state: "recorded"` is only reachable when `findings` parsed.
    if (active?.latest.state !== "recorded") throw new Error("unreachable")
    expect(active.latest.postings.map((posting) => posting.company)).toEqual([
      "Meridian Freight",
      "Northwind Health",
    ])
  })

  it("keeps a pause across reads", async () => {
    const prisma = createDevPrisma()

    expect(await pauseJob(prisma, DEV_JOB_ACTIVE_ID)).toMatchObject({
      nextRunAt: null,
    })
    expect(
      await prisma.job.findUnique({ where: { id: DEV_JOB_ACTIVE_ID } })
    ).toMatchObject({ nextRunAt: null })
  })

  it("computes a fresh occurrence when a briefing is resumed", async () => {
    const prisma = createDevPrisma()
    const now = new Date("2026-08-04T12:00:00.000Z")

    const resumed = await resumeJob(prisma, DEV_JOB_PAUSED_ID, now)

    expect(resumed?.nextRunAt?.getTime()).toBeGreaterThan(now.getTime())
  })

  it("returns undefined rather than throwing for a job that is gone", async () => {
    const prisma = createDevPrisma()

    expect(
      await pauseJob(prisma, "00000000-0000-4000-8000-000000000999")
    ).toBeUndefined()
  })

  /**
   * `updateJobSchedule` is raw SQL, and this is the assertion that the fake's
   * positional match still lines up with the statement in
   * `packages/db/src/jobs.ts`. It fails loudly if that statement changes.
   */
  it("writes a new schedule through $executeRaw", async () => {
    const prisma = createDevPrisma()

    const updated = await updateJobSchedule(prisma, DEV_JOB_ACTIVE_ID, {
      cron: "0 */3 * * *",
      timezone: "UTC",
    })

    expect(updated?.scheduleCron).toBe("0 */3 * * *")
  })

  /**
   * The `CASE` in that statement, reproduced: rescheduling a paused briefing
   * must not quietly put it back on duty.
   */
  it("leaves a paused briefing paused when its schedule changes", async () => {
    const prisma = createDevPrisma()

    const updated = await updateJobSchedule(prisma, DEV_JOB_PAUSED_ID, {
      cron: "0 */12 * * *",
      timezone: "UTC",
    })

    expect(updated?.scheduleCron).toBe("0 */12 * * *")
    expect(updated?.nextRunAt).toBeNull()
  })

  it("names an unimplemented query instead of answering undefined", () => {
    const prisma = createDevPrisma()

    expect(() => prisma.artifact).toThrow(/prisma\.artifact/)
    expect(() => prisma.job.deleteMany).toThrow(/prisma\.job\.deleteMany/)
  })
})
