import type { ClaimedSlot, DueJob, RunFailure, RunStatus } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  BRIEFING_KIND,
  type JobHandler,
  type JobHandlerContext,
} from "./job-kinds.ts"
import {
  runTick,
  type RunTickInput,
  type TickDatabase,
  type TickReport,
  type UnhandledKindReport,
} from "./run-tick.ts"

/**
 * A whole tick — ask what is due, claim the slot, run it, record the outcome —
 * driven with a fake database and a fake registry. No Prisma client is
 * constructed here and no Postgres is reached, which is what the `db` seam
 * exists for: what these tests are about is whether a slot was claimed and
 * what was written to its run, and a module binding can be observed by
 * nothing.
 */

const SLOT: ClaimedSlot = {
  runId: "11111111-1111-4111-8111-111111111111",
  scheduledFor: new Date("2026-07-28T23:30:00.000Z"),
  nextRunAt: new Date("2026-07-29T23:30:00.000Z"),
}

/** What every job here carries, before anything puts a `kind` on it. */
const CONFIG = { titles: ["senior backend engineer"], locations: ["Sydney"] }

const JOB = {
  id: "22222222-2222-4222-8222-222222222222",
  userId: "33333333-3333-4333-8333-333333333333",
  name: "daily job search",
  config: CONFIG,
  scheduleCron: "30 9 * * *",
  scheduleTimezone: "Australia/Sydney",
  nextRunAt: SLOT.scheduledFor,
  createdAt: new Date("2026-07-01T00:00:00.000Z"),
  updatedAt: new Date("2026-07-01T00:00:00.000Z"),
} as DueJob

const OTHER_SLOT: ClaimedSlot = {
  runId: "44444444-4444-4444-8444-444444444444",
  scheduledFor: SLOT.scheduledFor,
  nextRunAt: SLOT.nextRunAt,
}

const OTHER_JOB = { ...JOB, id: "55555555-5555-4555-8555-555555555555" }

/** A row naming a kind nothing in the registry answers to. */
const UNHANDLED_JOB = {
  ...JOB,
  id: "66666666-6666-4666-8666-666666666666",
  name: "weekend weather",
  config: { ...CONFIG, kind: "weather" },
} as DueJob

/**
 * Required by the signature and never reached: with every database call
 * supplied and the briefing faked, nothing in the tick touches either. Spelled
 * through the input type so this file does not so much as name a Prisma
 * client.
 */
const NO_PRISMA = {} as RunTickInput["prisma"]
const NO_BRIEFS = {} as RunTickInput["briefs"]

let database: TickDatabase
let claimed: DueJob[]
let ran: Array<{ jobId: string; runId: string }>
let finished: Array<{ runId: string; warnings?: RunFailure }>
let failed: Array<{ runId: string; failure: RunFailure }>

/**
 * The `runs` table, modelled rather than inferred.
 *
 * `claimJob` is what inserts the `running` row, so this is written by the claim
 * and by nothing else — which makes "no run row was created" assertable in the
 * terms a reader of the real table would notice, rather than only as a
 * corollary of the claim not happening.
 */
let runs: Array<{ runId: string; jobId: string; status: RunStatus }>

/**
 * Where each job's `next_run_at` has been moved to, if anything moved it.
 *
 * The claim's guarded UPDATE is the only thing that advances the column, so the
 * fake advances it in exactly that one place. A row that is missing here is a
 * row still sitting on the occurrence it was selected for.
 */
let advanced: Map<string, Date>

function nextRunAtOf(job: DueJob): Date {
  return advanced.get(job.id) ?? job.nextRunAt
}

/** The handler every job here dispatches to unless a test says otherwise. */
const recordRun: JobHandler = async ({ job, slot }) => {
  ran.push({ jobId: job.id, runId: slot.runId })
  return {}
}

/** Every JSON line the tick put on stdout, in the order it wrote them. */
function loggedLines(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.log)
    .mock.calls.map(
      ([line]) => JSON.parse(String(line)) as Record<string, unknown>
    )
}

function tickLine(): TickReport {
  const line = loggedLines().find((entry) => entry.event === "tick")
  expect(line).toBeDefined()
  return line as unknown as TickReport
}

function unhandledLines(): UnhandledKindReport[] {
  return loggedLines().filter(
    (entry) => entry.event === "unhandled-job-kind"
  ) as unknown as UnhandledKindReport[]
}

beforeEach(() => {
  claimed = []
  ran = []
  finished = []
  failed = []
  runs = []
  advanced = new Map()
  // Restored first: spying on an already-spied method hands back the existing
  // spy, whose call log would otherwise accumulate across tests.
  vi.restoreAllMocks()
  vi.spyOn(console, "log").mockImplementation(() => {})

  database = {
    dueJobs: async () => [JOB],
    claimJob: async (job) => {
      claimed.push(job)
      const slot = job.id === JOB.id ? SLOT : OTHER_SLOT
      // The two writes the real claim makes, and the only place either happens.
      advanced.set(job.id, slot.nextRunAt)
      runs.push({ runId: slot.runId, jobId: job.id, status: "running" })
      return slot
    },
    finishRun: async (runId, warnings) => {
      finished.push({ runId, warnings })
      settle(runId, "succeeded")
      return true
    },
    failRun: async (runId, failure) => {
      failed.push({ runId, failure })
      settle(runId, "failed")
      return true
    },
    recordArtifact: async () => {
      throw new Error("the tick hands this to the run and never calls it")
    },
    recordFindings: async () => {
      throw new Error("the tick hands this to the run and never calls it")
    },
  }
})

function settle(runId: string, status: RunStatus) {
  const run = runs.find((candidate) => candidate.runId === runId)
  if (run) run.status = status
}

/**
 * A tick over the fake database, with the calls a test cares about swapped in.
 *
 * `db` is partial *here* and whole at the seam: the merge happens against a
 * complete fake, so a test names only the call its assertions are about and
 * still cannot leave one bound to a real client by forgetting it.
 */
function tick({
  db,
  handler = recordRun,
  ...overrides
}: Omit<Partial<RunTickInput>, "db"> & {
  db?: Partial<TickDatabase>
  handler?: JobHandler
} = {}) {
  return runTick({
    prisma: NO_PRISMA,
    briefs: NO_BRIEFS,
    db: { ...database, ...db },
    kinds: { [BRIEFING_KIND]: handler },
    ...overrides,
  })
}

describe("runTick", () => {
  it("claims the slot, runs the job, and finishes the run it claimed", async () => {
    const report = await tick()

    expect(report).toMatchObject({
      due: 1,
      claimed: 1,
      skipped: 0,
      succeeded: 1,
      failed: 0,
      unhandled: 0,
    })

    // The run the handler was driven for and the run that was finished are
    // both the claim's, not an id the tick invented along the way.
    expect(ran).toEqual([{ jobId: JOB.id, runId: SLOT.runId }])
    expect(finished).toEqual([{ runId: SLOT.runId, warnings: undefined }])
    expect(failed).toEqual([])
  })

  it("carries the run's warnings onto the finished row", async () => {
    // Third argument, and the rule `packages/db/src/types.ts` states: a run
    // that produced a brief but could not keep its findings is `succeeded`
    // with a non-empty `failure`.
    const warnings = { findings: { message: "the runs row is gone" } }
    const report = await tick({ handler: async () => ({ warnings }) })

    expect(report.succeeded).toBe(1)
    expect(finished).toEqual([{ runId: SLOT.runId, warnings }])
  })

  it("leaves a job whose slot someone else holds entirely alone", async () => {
    // Not run, not retried, nothing recorded either way. Every duplicate
    // occurrence is a paid LLM run.
    const report = await tick({ db: { claimJob: async () => undefined } })

    expect(report).toMatchObject({
      due: 1,
      claimed: 0,
      skipped: 1,
      succeeded: 0,
      failed: 0,
      unhandled: 0,
    })
    expect(ran).toEqual([])
    expect(finished).toEqual([])
    expect(failed).toEqual([])

    // The same facts the unhandled-kind tests assert, and asserted here for the
    // same reason: this tick wrote no `runs` row of its own and moved no slot.
    // The difference is *whose* claim did — the other party's, before this tick
    // looked — which is why it is not an error.
    expect(runs).toEqual([])
    expect(nextRunAtOf(JOB)).toBe(JOB.nextRunAt)
  })

  it("attempts every due job, records the failure, and rethrows", async () => {
    const boom = new Error("the scout gave up")

    await expect(
      tick({
        db: { dueJobs: async () => [JOB, OTHER_JOB] },
        handler: async ({ job, slot }) => {
          ran.push({ jobId: job.id, runId: slot.runId })
          if (job.id === JOB.id) throw boom
          return {}
        },
      })
      // A lone failure is rethrown as itself, so what reaches the log group is
      // the error the run threw rather than a wrapper around it.
    ).rejects.toBe(boom)

    // One failing job must not stop the others: the second was claimed, run
    // and finished after the first had already blown up.
    expect(claimed.map((job) => job.id)).toEqual([JOB.id, OTHER_JOB.id])
    expect(ran).toHaveLength(2)
    expect(finished).toEqual([{ runId: OTHER_SLOT.runId, warnings: undefined }])
    expect(failed).toEqual([
      { runId: SLOT.runId, failure: { message: boom.message } },
    ])
  })

  it("reports a tick with nothing due as a success", async () => {
    const report = await tick({ db: { dueJobs: async () => [] } })

    expect(report.due).toBe(0)

    // `due: 0` on stdout is how silence is told apart from breakage: a tick
    // that found nothing still says so.
    expect(tickLine()).toMatchObject({ event: "tick", due: 0 })
  })

  it("hands the handler one context, not a parameter list", async () => {
    const briefs = {} as RunTickInput["briefs"]
    let received: unknown[] = []

    await tick({
      briefs,
      handler: async (...args) => {
        received = args
        return {}
      },
    })

    expect(received).toHaveLength(1)

    const context = received[0] as JobHandlerContext
    expect(context).toMatchObject({ job: JOB, slot: SLOT })
    expect(context.recordArtifact).toBe(database.recordArtifact)
    expect(context.recordFindings).toBe(database.recordFindings)

    // Asked for rather than handed over, which is what leaves a kind that
    // writes no brief free never to be given a store at all.
    expect(context.briefs()).toBe(briefs)
  })

  it("fails a malformed config where it fails today, having claimed its slot", async () => {
    // No registry supplied, so this runs through the real one and the real
    // briefing handler: the config still reaches `parseJobSearchConfig`, still
    // fails there, and still leaves the failed `runs` row it leaves today.
    const malformed = { ...JOB, config: { titles: [] } } as DueJob

    const error = await runTick({
      prisma: NO_PRISMA,
      briefs: NO_BRIEFS,
      db: { ...database, dueJobs: async () => [malformed] },
    }).catch((thrown: unknown) => thrown)

    expect(String(error)).toMatch(/config this worker cannot read/)

    // The other half of "distinguishable": a config malformed for its kind is
    // a different fault with a different fix, and must not read like a kind
    // nothing handles.
    expect(String(error)).not.toMatch(/no handler for/)

    expect(claimed.map((job) => job.id)).toEqual([malformed.id])
    expect(failed).toEqual([
      {
        runId: SLOT.runId,
        failure: { message: expect.stringContaining("cannot read") },
      },
    ])
    expect(finished).toEqual([])
  })
})

/**
 * A kind nothing handles is decided from the row, before anything is claimed.
 *
 * Everything asserted here is contract rather than diagnostics, and for one
 * reason: the decision happens ahead of the claim, so there is no `runs` row to
 * write the failure to and no query that can ever find it. The thrown error,
 * the counter on the tick line and the line on stdout are the whole record.
 */
describe("runTick, on a kind nothing handles", () => {
  const dueUnhandled = { dueJobs: async () => [UNHANDLED_JOB] }

  it("fails with a message naming the kind, unlike a config-parse failure", async () => {
    await expect(tick({ db: dueUnhandled })).rejects.toThrow(
      /names a job kind this worker has no handler for: "weather"/
    )
  })

  it("claims no slot for it", async () => {
    await expect(tick({ db: dueUnhandled })).rejects.toThrow()

    expect(claimed).toEqual([])
    expect(ran).toEqual([])
  })

  it("leaves no `runs` row behind for it", async () => {
    // The same fact as the claim never happening, in the terms someone reading
    // the `runs` table would meet it: there is no row for this job at all, so
    // nothing carries the failure and no later query can find it.
    await expect(tick({ db: dueUnhandled })).rejects.toThrow()

    expect(runs).toEqual([])
    expect(finished).toEqual([])
    expect(failed).toEqual([])
  })

  it("leaves its `next_run_at` on the occurrence it missed", async () => {
    // Deliberate, and the cost of not claiming: the row keeps the occurrence,
    // comes back on every tick, and fails the worker each hour until a human
    // edits it. The claimed job alongside it is what proves the fake would
    // have shown the column moving.
    await expect(
      tick({ db: { dueJobs: async () => [UNHANDLED_JOB, JOB] } })
    ).rejects.toThrow()

    expect(nextRunAtOf(UNHANDLED_JOB)).toBe(UNHANDLED_JOB.nextRunAt)
    expect(nextRunAtOf(JOB)).toBe(SLOT.nextRunAt)
  })

  it.each([null, "", 42, true, { name: BRIEFING_KIND }])(
    "takes this path for `kind: %j` rather than falling back to the briefing",
    async (kind) => {
      // A malformed discriminator read as "absent, so briefing" would spend a
      // paid job-search run on a config never meant for one, so each shape is
      // driven through the whole tick and not only through the pure lookup.
      const job = { ...JOB, config: { ...CONFIG, kind } } as DueJob

      await expect(
        tick({ db: { dueJobs: async () => [job] } })
      ).rejects.toThrow(/no handler for/)

      expect(ran).toEqual([])
      expect(claimed).toEqual([])
      expect(unhandledLines()).toEqual([
        {
          event: "unhandled-job-kind",
          jobId: job.id,
          jobName: job.name,
          kind,
        },
      ])
    }
  )

  it("names the job and the offending kind on stdout", async () => {
    // The only durable evidence this failure mode produces: no `runs` row, and
    // no `briefing-run` line either, because the briefing is never reached.
    await expect(tick({ db: dueUnhandled })).rejects.toThrow()

    expect(unhandledLines()).toEqual([
      {
        event: "unhandled-job-kind",
        jobId: UNHANDLED_JOB.id,
        jobName: UNHANDLED_JOB.name,
        kind: "weather",
      },
    ])
  })

  it("counts it as `unhandled`, leaving succeeded + failed === claimed", async () => {
    const boom = new Error("the scout gave up")

    await expect(
      tick({
        db: { dueJobs: async () => [JOB, UNHANDLED_JOB, OTHER_JOB] },
        handler: async ({ job, slot }) => {
          ran.push({ jobId: job.id, runId: slot.runId })
          if (job.id === OTHER_JOB.id) throw boom
          return {}
        },
      })
    ).rejects.toThrow()

    const line = tickLine()
    expect(line).toMatchObject({
      due: 3,
      claimed: 2,
      skipped: 0,
      succeeded: 1,
      failed: 1,
      unhandled: 1,
    })

    // The invariant the report cannot state in types, asserted rather than
    // trusted: an unhandled kind sits outside the sum, so a reader who
    // subtracts is not handed a phantom skipped job.
    expect(line.succeeded + line.failed).toBe(line.claimed)
  })

  it("throws a message that claims no denominator it does not have", async () => {
    const boom = new Error("the scout gave up")

    const error = await tick({
      db: { dueJobs: async () => [UNHANDLED_JOB, OTHER_JOB] },
      handler: async () => {
        throw boom
      },
    }).catch((thrown: unknown) => thrown)

    // Two failures against one claimed slot, which is what the old wording
    // undercounted: it read "2 of 1 claimed jobs failed", because an unhandled
    // kind joins the failure list without ever incrementing `claimed`.
    expect(error).toBeInstanceOf(AggregateError)
    expect((error as AggregateError).message).toBe("2 jobs failed this tick.")
    expect(tickLine()).toMatchObject({ claimed: 1, failed: 1, unhandled: 1 })
  })

  it("rethrows the lone failure as itself, with no counts in it", async () => {
    // The case the old wording would have read "1 of 0" for. A single failure
    // is rethrown as itself rather than wrapped, so what a reader gets is the
    // error naming the kind — and it must not have picked up a denominator on
    // the way out either.
    const error = await tick({ db: dueUnhandled }).catch(
      (thrown: unknown) => thrown
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toMatch(/"weather"/)
    expect((error as Error).message).not.toMatch(/of 0|claimed jobs/)
  })

  it("still runs the other due jobs, and still rethrows", async () => {
    // The throw contract is untouched: the tick attempts everything due before
    // it gives up, and the invocation is still marked failed.
    await expect(
      tick({ db: { dueJobs: async () => [UNHANDLED_JOB, JOB] } })
    ).rejects.toThrow(/no handler for/)

    expect(claimed.map((job) => job.id)).toEqual([JOB.id])
    expect(ran).toEqual([{ jobId: JOB.id, runId: SLOT.runId }])
    expect(finished).toEqual([{ runId: SLOT.runId, warnings: undefined }])
    expect(runs).toEqual([
      { runId: SLOT.runId, jobId: JOB.id, status: "succeeded" },
    ])
  })
})

/**
 * A second kind, registered in this file and nowhere else.
 *
 * A registry holding one entry cannot tell "dispatched to the briefing" from
 * "reached for the only thing there", and the briefing handler cannot check the
 * property the context shape exists for: that a kind writing no brief is never
 * handed the authority to write one. A fake proves both. So would a real second
 * kind — and it would leave a half-built feature behind it, where one real entry
 * plus a fake is a finished refactor with no speculative surface. Nothing here
 * is exported, added to `jobKinds`, or reachable from `index.ts`, so none of it
 * is in the bundle that ships.
 */
describe("runTick, with a second kind registered", () => {
  const PROBE_KIND = "test-only-probe"

  /** Any id but `JOB`'s, so the claim fake hands it `OTHER_SLOT`. */
  const PROBE_JOB = {
    ...JOB,
    id: "77777777-7777-4777-8777-777777777777",
    name: "seam probe",
    config: { ...CONFIG, kind: PROBE_KIND },
  } as DueJob

  let probed: Array<{ jobId: string; runId: string }> = []

  /**
   * What the briefing handler cannot be: a handler that never asks for
   * `briefs`. It records where it was driven and returns, so both what it
   * reached and what it never needed are observable.
   */
  const probeHandler: JobHandler = async ({ job, slot }) => {
    probed.push({ jobId: job.id, runId: slot.runId })
    return {}
  }

  /**
   * Not a stub store — a value that refuses to be one, throwing on any use.
   * `NO_BRIEFS` is inert and would let an eager store slip past unnoticed; this
   * makes "the tick touched no store" a thing the tests fail on rather than a
   * thing a reader takes on trust, so the day something between the tick and a
   * handler needs one to exist, this says so.
   */
  const HOSTILE_BRIEFS = new Proxy(
    {},
    {
      get() {
        throw new Error("a kind that writes no brief must never need a store")
      },
    }
  ) as RunTickInput["briefs"]

  const kinds = { [BRIEFING_KIND]: recordRun, [PROBE_KIND]: probeHandler }

  function probeTick(overrides: Parameters<typeof tick>[0] = {}) {
    return tick({ briefs: HOSTILE_BRIEFS, kinds, ...overrides })
  }

  beforeEach(() => {
    probed = []
  })

  it("routes a job carrying that kind to it, and not to the briefing", async () => {
    const report = await probeTick({ db: { dueJobs: async () => [PROBE_JOB] } })

    expect(report).toMatchObject({
      due: 1,
      claimed: 1,
      skipped: 0,
      succeeded: 1,
      failed: 0,
      unhandled: 0,
    })

    expect(probed).toEqual([{ jobId: PROBE_JOB.id, runId: OTHER_SLOT.runId }])
    expect(ran).toEqual([])
  })

  it("records its outcome by the path a briefing takes", async () => {
    // Claimed, run, finished, `succeeded`. A routing assertion alone would
    // leave the second half of dispatch unproven — that a kind which is not the
    // briefing is a special case nowhere after the lookup.
    await probeTick({ db: { dueJobs: async () => [PROBE_JOB] } })

    expect(claimed.map((job) => job.id)).toEqual([PROBE_JOB.id])
    expect(finished).toEqual([{ runId: OTHER_SLOT.runId, warnings: undefined }])
    expect(failed).toEqual([])
    expect(runs).toEqual([
      { runId: OTHER_SLOT.runId, jobId: PROBE_JOB.id, status: "succeeded" },
    ])
  })

  it("satisfies the handler context with no brief store in existence", async () => {
    // The reason `briefs` is a thunk, and the one thing the briefing handler
    // structurally cannot check. Every field of the context is supplied here
    // and none of them is a `BriefStore`: the thunk throws, so this passes only
    // while a kind that writes no brief is never made to pay for the authority
    // to write one.
    const context: JobHandlerContext = {
      job: PROBE_JOB,
      slot: OTHER_SLOT,
      briefs: () => {
        throw new Error("a kind that writes no brief must never need a store")
      },
      recordArtifact: database.recordArtifact,
      recordFindings: database.recordFindings,
    }

    await expect(probeHandler(context)).resolves.toEqual({})
    expect(probed).toEqual([{ jobId: PROBE_JOB.id, runId: OTHER_SLOT.runId }])
  })

  it("still routes a config with no discriminator to the briefing", async () => {
    // The fake must not have displaced what was already there, and every
    // existing row is this shape: no `kind` at all.
    const report = await probeTick()

    expect(JOB.config).not.toHaveProperty("kind")
    expect(report.succeeded).toBe(1)
    expect(ran).toEqual([{ jobId: JOB.id, runId: SLOT.runId }])
    expect(probed).toEqual([])
  })

  it("still routes an explicit `briefing` to the briefing", async () => {
    // A row that says out loud what an empty row means routes identically,
    // which is what normalising absence to the registered key buys.
    const explicit = {
      ...JOB,
      config: { ...CONFIG, kind: BRIEFING_KIND },
    } as DueJob

    const report = await probeTick({ db: { dueJobs: async () => [explicit] } })

    expect(report.succeeded).toBe(1)
    expect(ran).toEqual([{ jobId: explicit.id, runId: SLOT.runId }])
    expect(probed).toEqual([])
  })
})
