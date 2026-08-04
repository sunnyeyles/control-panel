import type { CurrentUser } from "@/lib/auth/current-user"
import {
  InvalidScheduleError,
  type Job,
  type NewJob,
  type PrismaClient,
} from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import { createJobActions } from "./job-actions"
import { MAX_CRITERIA_ITEMS } from "./search-criteria"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"
const JOB_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const RESET_KEY = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa"

const NOW = new Date("2026-08-01T00:00:00.000Z")
const NEXT_RUN = new Date("2026-08-02T09:00:00.000Z")

const SIGNED_IN: CurrentUser = {
  status: "ok",
  userId: USER_ID,
  email: "alice@example.com",
  name: "Alice",
}

const REFUSED: CurrentUser = {
  status: "refused",
  email: "mallory@example.com",
}

const ANONYMOUS: CurrentUser = { status: "anonymous" }

const mocks = vi.hoisted(() => ({
  createJob: vi.fn(),
  pauseJob: vi.fn(),
  resumeJob: vi.fn(),
  updateJobSchedule: vi.fn(),
}))

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>()
  return {
    ...actual,
    createJob: mocks.createJob,
    pauseJob: mocks.pauseJob,
    resumeJob: mocks.resumeJob,
    updateJobSchedule: mocks.updateJobSchedule,
  }
})

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    userId: USER_ID,
    name: "Daily briefing",
    config: { titles: ["backend engineer"], locations: ["Sydney"] },
    scheduleCron: "0 9 * * *",
    scheduleTimezone: "Australia/Sydney",
    nextRunAt: NEXT_RUN,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Job
}

/** Records what the helpers were asked to do, and backs `job.findUnique`. */
class SpyDb {
  readonly rows = new Map<string, Job>()
  readonly pauses: string[] = []
  readonly resumes: string[] = []
  readonly scheduleUpdates: {
    id: string
    cron: string
    timezone?: string | undefined
  }[] = []
  readonly creates: NewJob[] = []

  pauseError: unknown
  resumeError: unknown
  updateError: unknown
  createError: unknown

  seed(row: Job): this {
    this.rows.set(row.id, row)
    return this
  }

  get mutations(): number {
    return (
      this.pauses.length +
      this.resumes.length +
      this.scheduleUpdates.length +
      this.creates.length
    )
  }

  asPrisma(): PrismaClient {
    return {
      job: {
        findUnique: async ({ where: { id } }: { where: { id: string } }) =>
          this.rows.get(id) ?? null,
      },
    } as unknown as PrismaClient
  }

  installMocks(): void {
    mocks.pauseJob.mockImplementation(async (_prisma, id: string) => {
      if (this.pauseError) throw this.pauseError
      const row = this.rows.get(id)
      if (!row) return undefined
      this.pauses.push(id)
      return { ...row, nextRunAt: null }
    })

    mocks.resumeJob.mockImplementation(async (_prisma, id: string) => {
      if (this.resumeError) throw this.resumeError
      const row = this.rows.get(id)
      if (!row) return undefined
      this.resumes.push(id)
      return { ...row, nextRunAt: NEXT_RUN }
    })

    mocks.updateJobSchedule.mockImplementation(
      async (
        _prisma,
        id: string,
        schedule: { cron: string; timezone?: string }
      ) => {
        if (this.updateError) throw this.updateError
        const row = this.rows.get(id)
        if (!row) return undefined
        this.scheduleUpdates.push({ id, ...schedule })
        return { ...row, scheduleCron: schedule.cron }
      }
    )

    mocks.createJob.mockImplementation(async (_prisma, newJob: NewJob) => {
      if (this.createError) throw this.createError
      this.creates.push(newJob)
      return job({
        id: JOB_ID,
        userId: newJob.userId,
        name: newJob.name,
        config: (newJob.config ?? {}) as Job["config"],
        scheduleCron: newJob.scheduleCron,
        scheduleTimezone: newJob.scheduleTimezone ?? "UTC",
      })
    })
  }
}

let store: SpyDb

beforeEach(() => {
  store = new SpyDb().seed(job())
  store.installMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

function actionsFor(user: CurrentUser) {
  return createJobActions({
    getUser: async () => user,
    getPrisma: () => store.asPrisma(),
    now: () => NOW,
    newResetKey: () => RESET_KEY,
  })
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

const enableForm = (enabled: boolean, jobId = JOB_ID) =>
  form({ jobId, enabled: String(enabled) })

const scheduleForm = (
  overrides: Partial<Record<"jobId" | "hours", string>> = {}
) => form({ jobId: JOB_ID, hours: "3", ...overrides })

const createForm = (overrides: Record<string, string> = {}) =>
  form({
    name: "Morning briefing",
    hours: "24",
    titles: "senior backend engineer, staff engineer",
    locations: "Sydney, Remote (Australia)",
    ...overrides,
  })

describe("the gate", () => {
  it("refuses an anonymous caller without touching the store", async () => {
    const actions = actionsFor(ANONYMOUS)

    await actions.setJobEnabled(IDLE, enableForm(false))
    await actions.updateJobSchedule(IDLE, scheduleForm())
    await actions.createJob(IDLE, createForm())

    expect(store.mutations).toBe(0)
  })

  it("gives a refused caller the identical state an anonymous one gets", async () => {
    const anonymous = await actionsFor(ANONYMOUS).setJobEnabled(
      IDLE,
      enableForm(false)
    )
    const refused = await actionsFor(REFUSED).setJobEnabled(
      IDLE,
      enableForm(false)
    )

    expect(refused).toEqual(anonymous)
    expect(refused).toMatchObject({ message: NOT_AUTHORIZED })
    expect(store.mutations).toBe(0)
  })

  it("treats a thrown getUser as unauthorized rather than propagating it", async () => {
    const actions = createJobActions({
      getUser: async () => {
        throw new Error("neon is asleep")
      },
      getPrisma: () => store.asPrisma(),
    })

    const result = await actions.setJobEnabled(IDLE, enableForm(false))

    expect(result.status).toBe("error")
    expect(store.mutations).toBe(0)
  })
})

describe("ownership", () => {
  it("refuses a job owned by someone else, and says the same as a missing one", async () => {
    store.seed(job({ userId: OTHER_USER_ID }))

    const notMine = await actionsFor(SIGNED_IN).setJobEnabled(
      IDLE,
      enableForm(false)
    )

    store.rows.clear()

    const missing = await actionsFor(SIGNED_IN).setJobEnabled(
      IDLE,
      enableForm(false)
    )

    expect(notMine).toEqual(missing)
    expect(store.mutations).toBe(0)
  })

  it("refuses to reschedule a job owned by someone else", async () => {
    store.seed(job({ userId: OTHER_USER_ID }))

    const result = await actionsFor(SIGNED_IN).updateJobSchedule(
      IDLE,
      scheduleForm()
    )

    expect(result.status).toBe("error")
    expect(store.scheduleUpdates).toHaveLength(0)
  })

  it("rejects a jobId that is not a uuid before querying", async () => {
    const result = await actionsFor(SIGNED_IN).setJobEnabled(
      IDLE,
      enableForm(false, "../../etc/passwd")
    )

    expect(result.status).toBe("error")
    expect(store.mutations).toBe(0)
  })
})

describe("setJobEnabled", () => {
  it("pauses when asked to turn off", async () => {
    const result = await actionsFor(SIGNED_IN).setJobEnabled(
      IDLE,
      enableForm(false)
    )

    expect(result.status).toBe("success")
    expect(store.pauses).toEqual([JOB_ID])
    expect(store.resumes).toHaveLength(0)
  })

  it("resumes when asked to turn on", async () => {
    store.seed(job({ nextRunAt: null }))

    const result = await actionsFor(SIGNED_IN).setJobEnabled(
      IDLE,
      enableForm(true)
    )

    expect(result.status).toBe("success")
    expect(store.resumes).toEqual([JOB_ID])
    expect(store.pauses).toHaveLength(0)
  })

  it("rejects an `enabled` value that is neither true nor false", async () => {
    const result = await actionsFor(SIGNED_IN).setJobEnabled(
      IDLE,
      form({ jobId: JOB_ID, enabled: "on" })
    )

    expect(result.status).toBe("error")
    expect(store.mutations).toBe(0)
  })

  it("turns a store failure into an error state, not a throw", async () => {
    store.pauseError = new Error("connection reset")

    const result = await actionsFor(SIGNED_IN).setJobEnabled(
      IDLE,
      enableForm(false)
    )

    expect(result.status).toBe("error")
  })
})

describe("updateJobSchedule", () => {
  it("derives the cron from the interval and always stores UTC", async () => {
    const result = await actionsFor(SIGNED_IN).updateJobSchedule(
      IDLE,
      scheduleForm()
    )

    expect(result.status).toBe("success")
    expect(store.scheduleUpdates).toEqual([
      { id: JOB_ID, cron: "0 */3 * * *", timezone: "UTC" },
    ])
  })

  it.each([
    ["one outside the offered set", "5"],
    ["a non-number", "hourly"],
    ["an empty value", ""],
    ["a cron expression", "0 */3 * * *"],
  ])("rejects %s before the store is touched", async (_label, hours) => {
    const result = await actionsFor(SIGNED_IN).updateJobSchedule(
      IDLE,
      scheduleForm({ hours })
    )

    expect(result.status).toBe("error")
    expect(store.scheduleUpdates).toHaveLength(0)
  })

  it("rejects a missing interval", async () => {
    const result = await actionsFor(SIGNED_IN).updateJobSchedule(
      IDLE,
      form({ jobId: JOB_ID })
    )

    expect(result.status).toBe("error")
    expect(store.scheduleUpdates).toHaveLength(0)
  })

  it("says the briefing is still off when rescheduling a paused job", async () => {
    store.seed(job({ nextRunAt: null }))

    const result = await actionsFor(SIGNED_IN).updateJobSchedule(
      IDLE,
      scheduleForm()
    )

    expect(result.status).toBe("success")
    expect(result.status === "success" && result.message).toContain(
      "still turned off"
    )
  })

  it("turns an InvalidScheduleError from the store into an error state", async () => {
    store.updateError = new InvalidScheduleError("no next occurrence")

    const result = await actionsFor(SIGNED_IN).updateJobSchedule(
      IDLE,
      scheduleForm()
    )

    expect(result.status).toBe("error")
  })
})

describe("createJob", () => {
  it("takes the userId from the session, never from the form", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ userId: OTHER_USER_ID })
    )

    expect(result.status).toBe("success")
    expect(store.creates[0]?.userId).toBe(USER_ID)
  })

  it("splits and trims the criteria into the shape the worker requires", async () => {
    await actionsFor(SIGNED_IN).createJob(IDLE, createForm())

    expect(store.creates[0]?.config).toEqual({
      titles: ["senior backend engineer", "staff engineer"],
      locations: ["Sydney", "Remote (Australia)"],
    })
  })

  it("stores the keywords when the optional field was filled in", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ keywords: " TypeScript, Postgres ,AWS " })
    )

    // Valid titles and locations are still the only thing the create turns on —
    // keywords ride along and never gate it.
    expect(result.status).toBe("success")
    expect(store.creates[0]?.config).toEqual({
      titles: ["senior backend engineer", "staff engineer"],
      locations: ["Sydney", "Remote (Australia)"],
      keywords: ["TypeScript", "Postgres", "AWS"],
    })
  })

  it("omits keywords from the config entirely rather than storing an empty list", async () => {
    // `keywords: []` would parse for the worker, so this is about what the row
    // claims: an absent field and an empty one must not both mean "none", and a
    // stored `[]` reads as a choice the user made.
    await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ keywords: "  , " })
    )

    expect(store.creates).toHaveLength(1)
    const config = store.creates[0]?.config ?? {}

    expect("keywords" in config).toBe(false)
  })

  it("creates normally when keywords are missing, because they are optional", async () => {
    // The guard rail on the message above: only titles and locations may ever
    // be the reason a create fails.
    const result = await actionsFor(SIGNED_IN).createJob(IDLE, createForm())

    expect(result.status).toBe("success")
    expect(store.creates).toHaveLength(1)
  })

  /** One over the cap, which is the only way keywords can fail at all. */
  const tooManyKeywords = Array.from(
    { length: MAX_CRITERIA_ITEMS + 1 },
    (_, index) => `tech-${index}`
  ).join(", ")

  it("names keywords when the list is the only thing over the line", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ keywords: tooManyKeywords })
    )

    expect(result.status).toBe("error")
    // The count, so the sentence says how far over it is rather than only that
    // it is over.
    expect(result.status === "error" && result.message).toContain(
      String(MAX_CRITERIA_ITEMS)
    )
    expect(store.creates).toHaveLength(0)
  })

  it("names the blocking field, not keywords, when both are wrong", async () => {
    // ⚠️ The regression this exists for. Keywords appearing *among* the issues
    // is not the same question as keywords being *the* issue: answer this with
    // the keyword sentence and the user trims the list, submits again, and only
    // then discovers the empty title that was blocking them the whole time —
    // two round trips for one failure, the first naming a field that was never
    // the obstacle.
    const result = await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ titles: "   ", keywords: tooManyKeywords })
    )

    expect(result.status).toBe("error")
    expect(result.status === "error" && result.message).toBe(
      "Add at least one role title and one location."
    )
    expect(store.creates).toHaveLength(0)
  })

  it("derives the cron from the interval and always stores UTC", async () => {
    await actionsFor(SIGNED_IN).createJob(IDLE, createForm({ hours: "12" }))

    expect(store.creates[0]?.scheduleCron).toBe("0 */12 * * *")
    expect(store.creates[0]?.scheduleTimezone).toBe("UTC")
  })

  it("refuses an interval outside the offered set", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ hours: "7" })
    )

    expect(result.status).toBe("error")
    expect(store.creates).toHaveLength(0)
  })

  it("refuses to create a job with no titles or no locations", async () => {
    const empties: Record<string, string>[] = [
      { titles: "" },
      { locations: "  ,  " },
    ]

    for (const empty of empties) {
      const result = await actionsFor(SIGNED_IN).createJob(
        IDLE,
        createForm(empty)
      )

      expect(result.status).toBe("error")
    }

    expect(store.creates).toHaveLength(0)
  })

  it("refuses an empty name", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ name: "   " })
    )

    expect(result.status).toBe("error")
    expect(store.creates).toHaveLength(0)
  })

  it("reports a duplicate name instead of leaking a Postgres error", async () => {
    store.createError = Object.assign(new Error("duplicate key"), {
      code: "P2002",
    })

    const result = await actionsFor(SIGNED_IN).createJob(IDLE, createForm())

    expect(result.status).toBe("error")
    expect(result.status === "error" && result.message).toContain(
      "already have a briefing with that name"
    )
  })

  it("uses the new row's id as the reset key, so the form resets once per success", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(IDLE, createForm())

    expect(result.status === "success" && result.resetKey).toBe(JOB_ID)
  })
})

describe("the reset key", () => {
  it("carries the previous reset key forward on failure", async () => {
    const previous: ActionState = {
      status: "success",
      message: "Created.",
      resetKey: RESET_KEY,
    }

    const result = await actionsFor(SIGNED_IN).createJob(
      previous,
      createForm({ titles: "" })
    )

    expect(result).toEqual({
      status: "error",
      message: expect.any(String),
      resetKey: RESET_KEY,
    })
  })

  it("omits the reset key when no action has succeeded yet", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ titles: "" })
    )

    expect(result).not.toHaveProperty("resetKey")
  })
})
