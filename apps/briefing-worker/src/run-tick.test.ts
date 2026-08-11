import type { ClaimedSlot, DueJob, PrismaClient } from "@workspace/db"
import type { BriefStore } from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { JobKindEntry } from "./job-kinds.ts"

/**
 * The tick's orchestration, with the briefing path faked.
 *
 * `runBriefing` / `executeClaimedBriefing` have their own suites; what is
 * asserted here is everything around them — that a lost claim runs nothing,
 * that one failure among many still attempts the rest and then rethrows, that
 * title exclusions and finishRun warnings are wired through, and that the
 * pre-claim kind gate leaves the slot alone.
 */

const mocks = vi.hoisted(() => ({
  dueJobs: vi.fn(),
  claimJob: vi.fn(),
  failRun: vi.fn(async () => true),
  finishRun: vi.fn(async () => true),
  recordArtifact: vi.fn(),
  recordRunFindings: vi.fn(),
  recordPostings: vi.fn(),
  titleExclusions: vi.fn(async () => [] as string[]),
  executeClaimedBriefing: vi.fn(),
}))

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>()
  return { ...actual, ...mocks }
})

vi.mock("./execute-claimed-briefing.ts", () => ({
  executeClaimedBriefing: mocks.executeClaimedBriefing,
}))

const { runTick } = await import("./run-tick.ts")
const { defaultJobKindRegistry, UnknownJobKindError } =
  await import("./job-kinds.ts")

const NOW = new Date("2026-07-29T00:00:00.000Z")
const RUN_ID = "11111111-1111-4111-8111-111111111111"
const JOB_ID = "22222222-2222-4222-8222-222222222222"

const SLOT: ClaimedSlot = {
  runId: RUN_ID,
  scheduledFor: new Date("2026-07-28T23:30:00.000Z"),
  nextRunAt: new Date("2026-07-29T23:30:00.000Z"),
}

function dueJob(overrides: Partial<DueJob> = {}): DueJob {
  return {
    id: JOB_ID,
    userId: "33333333-3333-4333-8333-333333333333",
    name: "daily job search",
    config: { titles: ["senior backend engineer"], locations: ["Sydney"] },
    scheduleCron: "30 9 * * *",
    scheduleTimezone: "Australia/Sydney",
    nextRunAt: SLOT.scheduledFor,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    ...overrides,
  } as DueJob
}

const briefs = {} as BriefStore
const prisma = {} as PrismaClient

beforeEach(() => {
  vi.clearAllMocks()
  mocks.failRun.mockResolvedValue(true)
  mocks.finishRun.mockResolvedValue(true)
  mocks.dueJobs.mockResolvedValue([])
  mocks.claimJob.mockResolvedValue(SLOT)
  mocks.executeClaimedBriefing.mockResolvedValue({ warnings: undefined })
  mocks.titleExclusions.mockResolvedValue([])
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

describe("runTick", () => {
  it("emits a quiet tick when nothing is due", async () => {
    const report = await runTick(prisma, briefs, NOW)

    expect(report).toMatchObject({
      event: "tick",
      due: 0,
      claimed: 0,
      skipped: 0,
      succeeded: 0,
      failed: 0,
    })
    expect(mocks.claimJob).not.toHaveBeenCalled()
    expect(mocks.executeClaimedBriefing).not.toHaveBeenCalled()
  })

  it("skips a slot another party already holds", async () => {
    mocks.dueJobs.mockResolvedValue([dueJob()])
    mocks.claimJob.mockResolvedValue(undefined)

    const report = await runTick(prisma, briefs, NOW)

    expect(report).toMatchObject({
      due: 1,
      claimed: 0,
      skipped: 1,
      succeeded: 0,
    })
    expect(mocks.executeClaimedBriefing).not.toHaveBeenCalled()
  })

  it("runs one claimed job to success", async () => {
    const job = dueJob()
    mocks.dueJobs.mockResolvedValue([job])

    const report = await runTick(prisma, briefs, NOW)

    expect(report).toMatchObject({
      due: 1,
      claimed: 1,
      succeeded: 1,
      failed: 0,
    })
    expect(mocks.executeClaimedBriefing).toHaveBeenCalledWith(
      prisma,
      briefs,
      expect.objectContaining({
        job,
        slot: SLOT,
        trigger: "schedule",
      })
    )
  })

  it("applies the owner's title exclusions via the shared spine", async () => {
    // Title exclusions are loaded inside executeClaimedBriefing; the tick's
    // job is to call that spine. This pins the wiring, not the loader itself.
    mocks.dueJobs.mockResolvedValue([dueJob()])
    mocks.titleExclusions.mockResolvedValue(["senior"])

    await runTick(prisma, briefs, NOW)

    expect(mocks.executeClaimedBriefing).toHaveBeenCalled()
  })

  it("lets finishRun warnings ride on a succeeded run", async () => {
    mocks.dueJobs.mockResolvedValue([dueJob()])
    const warnings = { findings: { message: "could not be kept" } }
    mocks.executeClaimedBriefing.mockResolvedValue({ warnings })

    const report = await runTick(prisma, briefs, NOW)

    expect(report.succeeded).toBe(1)
    expect(report.failed).toBe(0)
  })

  it("attempts every due job, then rethrows a single failure", async () => {
    const first = dueJob({ id: "aaaaaaa1-1111-4111-8111-111111111111" })
    const second = dueJob({ id: "aaaaaaa2-2222-4222-8222-222222222222" })
    mocks.dueJobs.mockResolvedValue([first, second])
    mocks.claimJob
      .mockResolvedValueOnce({ ...SLOT, runId: "run-1" })
      .mockResolvedValueOnce({ ...SLOT, runId: "run-2" })
    mocks.executeClaimedBriefing
      .mockRejectedValueOnce(new Error("scout failed"))
      .mockResolvedValueOnce({ warnings: undefined })

    await expect(runTick(prisma, briefs, NOW)).rejects.toThrow(/scout failed/)

    expect(mocks.executeClaimedBriefing).toHaveBeenCalledTimes(2)
  })

  it("rethrows AggregateError when more than one claimed job fails", async () => {
    const first = dueJob({ id: "aaaaaaa1-1111-4111-8111-111111111111" })
    const second = dueJob({ id: "aaaaaaa2-2222-4222-8222-222222222222" })
    mocks.dueJobs.mockResolvedValue([first, second])
    mocks.claimJob
      .mockResolvedValueOnce({ ...SLOT, runId: "run-1" })
      .mockResolvedValueOnce({ ...SLOT, runId: "run-2" })
    mocks.executeClaimedBriefing
      .mockRejectedValueOnce(new Error("first failed"))
      .mockRejectedValueOnce(new Error("second failed"))

    const error = await runTick(prisma, briefs, NOW).then(
      () => {
        throw new Error("expected reject")
      },
      (caught: unknown) => caught
    )

    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).errors).toHaveLength(2)
  })

  /**
   * The alarm contract: a throw marks the invocation failed and produces the
   * Lambda `Errors` datapoint. Swallowing a failure here would silence the
   * only signal that says the schedule is broken.
   */
  it("rethrows so the Errors alarm can see the failure", async () => {
    mocks.dueJobs.mockResolvedValue([dueJob()])
    mocks.executeClaimedBriefing.mockRejectedValue(new Error("board down"))

    await expect(runTick(prisma, briefs, NOW)).rejects.toThrow(/board down/)
  })

  describe("pre-claim kind and config gates", () => {
    it("routes a config with no discriminator to the briefing handler", async () => {
      const job = dueJob({ config: { titles: ["x"], locations: ["y"] } })
      mocks.dueJobs.mockResolvedValue([job])

      await runTick(prisma, briefs, NOW)

      expect(mocks.claimJob).toHaveBeenCalled()
      expect(mocks.executeClaimedBriefing).toHaveBeenCalled()
    })

    it("rejects an unknown kind before claiming, distinguishably", async () => {
      const job = dueJob({
        config: { kind: "weather", city: "Sydney" },
        nextRunAt: SLOT.scheduledFor,
      })
      mocks.dueJobs.mockResolvedValue([job])

      const error = await runTick(prisma, briefs, NOW).then(
        () => {
          throw new Error("expected reject")
        },
        (caught: unknown) => caught
      )

      expect(error).toBeInstanceOf(UnknownJobKindError)
      expect((error as Error).message).toMatch(/kind "weather"/)
      expect((error as Error).message).not.toMatch(/cannot read/)
      expect(mocks.claimJob).not.toHaveBeenCalled()
      expect(mocks.executeClaimedBriefing).not.toHaveBeenCalled()
    })

    it("leaves next_run_at untouched when the kind is unknown", async () => {
      // claimJob is the only thing that advances next_run_at. Not calling it
      // is the assertion — the row keeps the occurrence it already missed.
      const nextRunAt = new Date("2026-07-28T23:30:00.000Z")
      mocks.dueJobs.mockResolvedValue([
        dueJob({
          config: { kind: "weather" },
          nextRunAt,
        }),
      ])

      await expect(runTick(prisma, briefs, NOW)).rejects.toBeInstanceOf(
        UnknownJobKindError
      )
      expect(mocks.claimJob).not.toHaveBeenCalled()
    })

    it("rejects a malformed briefing config before claiming", async () => {
      mocks.dueJobs.mockResolvedValue([
        dueJob({ config: { titles: [], locations: ["Sydney"] } }),
      ])

      await expect(runTick(prisma, briefs, NOW)).rejects.toThrow(/cannot read/)
      expect(mocks.claimJob).not.toHaveBeenCalled()
    })

    it("still attempts other due jobs when one kind is unknown", async () => {
      const bad = dueJob({
        id: "bad-job",
        config: { kind: "weather" },
      })
      const good = dueJob({ id: "good-job" })
      mocks.dueJobs.mockResolvedValue([bad, good])
      mocks.claimJob.mockResolvedValue({ ...SLOT, runId: "run-good" })

      await expect(runTick(prisma, briefs, NOW)).rejects.toBeInstanceOf(
        UnknownJobKindError
      )

      expect(mocks.executeClaimedBriefing).toHaveBeenCalledTimes(1)
      expect(mocks.executeClaimedBriefing).toHaveBeenCalledWith(
        prisma,
        briefs,
        expect.objectContaining({ job: good })
      )
    })

    it("routes a test-only fake kind through the injectable registry", async () => {
      const handled: string[] = []
      const fake: JobKindEntry = {
        kind: "probe",
        validate: () => undefined,
        handle: async ({ job }) => {
          handled.push(job.id)
        },
      }
      const registry = [...defaultJobKindRegistry, fake]
      const job = dueJob({
        id: "probe-job",
        config: { kind: "probe", anything: true },
      })
      mocks.dueJobs.mockResolvedValue([job])

      const report = await runTick(prisma, briefs, NOW, registry)

      expect(report.succeeded).toBe(1)
      expect(handled).toEqual(["probe-job"])
      expect(mocks.executeClaimedBriefing).not.toHaveBeenCalled()
    })
  })
})
