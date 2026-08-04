import type { ClaimedRun, Job, PrismaClient } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The orchestration around a run someone asked for, with the run itself faked.
 *
 * `runBriefing` has its own suite next door; what is asserted here is
 * everything around it — that a duplicate delivery runs nothing, that a failure
 * is recorded rather than thrown, and that the occurrence handed to the
 * pipeline is the row's own instant. Each of those is a property of this file
 * and invisible from the other one.
 */

const mocks = vi.hoisted(() => ({
  claimAdHocRun: vi.fn(),
  failRun: vi.fn(async () => true),
  finishRun: vi.fn(async () => true),
  recordArtifact: vi.fn(),
  recordRunFindings: vi.fn(),
  runBriefing: vi.fn(),
}))

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>()
  return { ...actual, ...mocks }
})

vi.mock("./run-briefing.ts", () => ({ runBriefing: mocks.runBriefing }))

const { runAdHocBriefing } = await import("./run-ad-hoc.ts")

const RUN_ID = "11111111-1111-4111-8111-111111111111"
const JOB_ID = "22222222-2222-4222-8222-222222222222"

/** When the run was requested — what the brief must be filed under. */
const REQUESTED_AT = new Date("2026-07-28T23:30:00.000Z")

/** Deliberately different, so a run that reaches for the clock is caught. */
const NOW = new Date("2026-07-29T00:11:00.000Z")

const CLAIM: ClaimedRun = { jobId: JOB_ID, startedAt: REQUESTED_AT }

const JOB = {
  id: JOB_ID,
  userId: "33333333-3333-4333-8333-333333333333",
  name: "daily job search",
  config: { titles: ["senior backend engineer"], locations: ["Sydney"] },
  scheduleCron: "30 9 * * *",
  scheduleTimezone: "Australia/Sydney",
  // Paused. An ad-hoc run of a briefing that is turned off is legitimate, and
  // this is what proves `runBriefing` no longer demands a `DueJob`.
  nextRunAt: null,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
} as Job

const briefs = {} as BriefStore

let findUnique: ReturnType<typeof vi.fn>

function prismaWith(job: Job | null): PrismaClient {
  findUnique = vi.fn(async () => job)
  return { job: { findUnique } } as unknown as PrismaClient
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.failRun.mockResolvedValue(true)
  mocks.finishRun.mockResolvedValue(true)
  mocks.claimAdHocRun.mockResolvedValue(CLAIM)
  mocks.runBriefing.mockResolvedValue({ warnings: undefined })
  vi.spyOn(console, "log").mockImplementation(() => {})
})

function run(prisma: PrismaClient) {
  return runAdHocBriefing(prisma, briefs, { runId: RUN_ID, jobId: JOB_ID }, NOW)
}

describe("claiming", () => {
  it("runs nothing when the claim is already held", async () => {
    mocks.claimAdHocRun.mockResolvedValue(undefined)
    const prisma = prismaWith(JOB)

    const report = await run(prisma)

    expect(report.outcome).toBe("skipped")
    expect(mocks.runBriefing).not.toHaveBeenCalled()
    expect(mocks.failRun).not.toHaveBeenCalled()
    expect(mocks.finishRun).not.toHaveBeenCalled()
    // Not even looked up. A duplicate delivery must be cheap.
    expect(findUnique).not.toHaveBeenCalled()
  })

  it("does not report a duplicate delivery as a failure", async () => {
    mocks.claimAdHocRun.mockResolvedValue(undefined)

    const report = await run(prismaWith(JOB))

    expect(report.outcome).not.toBe("failed")
  })

  it("claims before doing anything else", async () => {
    await run(prismaWith(JOB))

    expect(mocks.claimAdHocRun).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      NOW
    )
  })
})

describe("the request and the row disagreeing", () => {
  it("refuses a job id that is not the one the run belongs to", async () => {
    mocks.claimAdHocRun.mockResolvedValue({
      jobId: "44444444-4444-4444-8444-444444444444",
      startedAt: REQUESTED_AT,
    })

    const report = await run(prismaWith(JOB))

    expect(report.outcome).toBe("failed")
    expect(mocks.runBriefing).not.toHaveBeenCalled()
    expect(mocks.failRun).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      expect.objectContaining({
        message: expect.stringContaining("belongs to"),
      })
    )
  })

  it("fails rather than throws when the job has been deleted", async () => {
    const report = await run(prismaWith(null))

    expect(report.outcome).toBe("failed")
    expect(mocks.runBriefing).not.toHaveBeenCalled()
    expect(mocks.failRun).toHaveBeenCalled()
  })
})

describe("running it", () => {
  it("files the brief under the instant the run was requested", async () => {
    await run(prismaWith(JOB))

    expect(mocks.runBriefing).toHaveBeenCalledWith(
      expect.objectContaining({
        job: JOB,
        slot: { runId: RUN_ID, scheduledFor: REQUESTED_AT },
        trigger: "manual",
      })
    )
  })

  it("runs a briefing that is turned off", async () => {
    const report = await run(prismaWith(JOB))

    expect(JOB.nextRunAt).toBeNull()
    expect(report.outcome).toBe("succeeded")
  })

  it("carries warnings onto the succeeded row", async () => {
    const warnings = { findings: { message: "could not be kept" } }
    mocks.runBriefing.mockResolvedValue({ warnings })

    await run(prismaWith(JOB))

    expect(mocks.finishRun).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      warnings
    )
  })
})

describe("failure", () => {
  it("records the failure and does not throw", async () => {
    mocks.runBriefing.mockRejectedValue(new Error("no search returned"))

    const report = await run(prismaWith(JOB))

    expect(report).toMatchObject({
      outcome: "failed",
      reason: "no search returned",
    })
    expect(mocks.failRun).toHaveBeenCalledWith(expect.anything(), RUN_ID, {
      message: "no search returned",
    })
    expect(mocks.finishRun).not.toHaveBeenCalled()
  })

  it("still reports when recording the failure itself fails", async () => {
    mocks.runBriefing.mockRejectedValue(new Error("no search returned"))
    mocks.failRun.mockRejectedValue(new Error("database gone"))

    await expect(run(prismaWith(JOB))).resolves.toMatchObject({
      outcome: "failed",
    })
  })
})
