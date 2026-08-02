import type { CurrentUser } from "@/lib/auth/current-user"
import type { ClaimedSlot, JobStore, NewJob } from "@workspace/db/jobs"
import type { DueJob, Job } from "@workspace/db/rows"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDLE, type JobActionState } from "./action-state"
import { createJobActions } from "./job-actions"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"
const JOB_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const NONCE = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa"

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
  }
}

/** Records what it was asked to do, and can be told to fail. */
class SpyJobStore implements JobStore {
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

  /** Everything the store was asked to change, so one assertion covers all three. */
  get mutations(): number {
    return (
      this.pauses.length +
      this.resumes.length +
      this.scheduleUpdates.length +
      this.creates.length
    )
  }

  async create(newJob: NewJob): Promise<Job> {
    if (this.createError) throw this.createError
    this.creates.push(newJob)

    return job({
      id: JOB_ID,
      userId: newJob.userId,
      name: newJob.name,
      config: newJob.config ?? {},
      scheduleCron: newJob.scheduleCron,
      scheduleTimezone: newJob.scheduleTimezone ?? "UTC",
    })
  }

  async get(id: string): Promise<Job | undefined> {
    return this.rows.get(id)
  }

  async listForUser(userId: string): Promise<Job[]> {
    return [...this.rows.values()].filter((row) => row.userId === userId)
  }

  async dueJobs(): Promise<DueJob[]> {
    throw new Error("not used")
  }

  async claim(): Promise<ClaimedSlot | undefined> {
    throw new Error("not used")
  }

  async updateSchedule(
    id: string,
    schedule: { cron: string; timezone?: string }
  ): Promise<Job | undefined> {
    if (this.updateError) throw this.updateError

    const row = this.rows.get(id)
    if (!row) return undefined

    this.scheduleUpdates.push({ id, ...schedule })

    return { ...row, scheduleCron: schedule.cron }
  }

  async pause(id: string): Promise<Job | undefined> {
    if (this.pauseError) throw this.pauseError

    const row = this.rows.get(id)
    if (!row) return undefined

    this.pauses.push(id)

    return { ...row, nextRunAt: null }
  }

  async resume(id: string): Promise<Job | undefined> {
    if (this.resumeError) throw this.resumeError

    const row = this.rows.get(id)
    if (!row) return undefined

    this.resumes.push(id)

    return { ...row, nextRunAt: NEXT_RUN }
  }
}

let store: SpyJobStore

beforeEach(() => {
  store = new SpyJobStore().seed(job())
  vi.spyOn(console, "error").mockImplementation(() => {})
})

function actionsFor(user: CurrentUser) {
  return createJobActions({
    getUser: async () => user,
    getJobs: () => store,
    now: () => NOW,
    newNonce: () => NONCE,
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

    // The property that matters more than any message: nothing was written.
    expect(store.mutations).toBe(0)
  })

  it("gives a refused caller the identical state an anonymous one gets", async () => {
    // The non-disclosure property. A different message would confirm to someone
    // outside AUTH_ALLOWED_EMAILS that their account exists and is merely
    // unapproved. Easy to regress by improving the copy, invisible in review.
    const anonymous = await actionsFor(ANONYMOUS).setJobEnabled(
      IDLE,
      enableForm(false)
    )
    const refused = await actionsFor(REFUSED).setJobEnabled(
      IDLE,
      enableForm(false)
    )

    expect(refused).toEqual(anonymous)
    expect(store.mutations).toBe(0)
  })

  it("treats a thrown getUser as unauthorized rather than propagating it", async () => {
    // `getCurrentUser` touches the database to map an auth id onto a platform
    // user. A database blip must not become an unauthenticated write.
    const actions = createJobActions({
      getUser: async () => {
        throw new Error("neon is asleep")
      },
      getJobs: () => store,
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

    // Distinct messages would turn a form that takes a uuid into an oracle for
    // whether another user's row exists.
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
    // The switch posts the transition explicitly rather than relying on
    // checkbox semantics, so an absent or odd value is a bug, not "off".
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
    // The client posts an interval, never an expression — so there is no way to
    // store a schedule the picker could not have produced.
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
    // `updateSchedule` keeps a paused job paused, so the copy has to say so —
    // otherwise "Schedule saved" reads as "and it will run".
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
    // `updateSchedule` signals failure by throwing, unlike every other method
    // on the store, which returns `undefined`. Unhandled it would reach the
    // client as an opaque Next digest.
    store.updateError = Object.assign(new Error("no next occurrence"), {
      code: "invalid_schedule",
    })

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
    // A job with an unreadable config claims its slot and then fails, so this
    // is refused up front rather than stored and discovered by the worker.
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
    // `jobs` carries `unique (user_id, name)`, and `client.ts` remaps only
    // class-08 faults — so 23505 arrives raw and would otherwise reach the
    // client as an opaque Next digest.
    store.createError = Object.assign(new Error("duplicate key"), {
      code: "23505",
    })

    const result = await actionsFor(SIGNED_IN).createJob(IDLE, createForm())

    expect(result.status).toBe("error")
    expect(result.status === "error" && result.message).toContain(
      "already have a briefing with that name"
    )
  })

  it("uses the new row's id as the nonce, so the form resets once per success", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(IDLE, createForm())

    expect(result.status === "success" && result.nonce).toBe(JOB_ID)
  })
})

describe("the reset nonce", () => {
  it("carries the previous nonce forward on failure", async () => {
    // The create form keys its fields on the nonce. Dropping it here would
    // remount the fields and discard what the user typed, at the exact moment
    // they are being told to fix it.
    const previous: JobActionState = {
      status: "success",
      message: "Created.",
      nonce: NONCE,
    }

    const result = await actionsFor(SIGNED_IN).createJob(
      previous,
      createForm({ titles: "" })
    )

    expect(result).toEqual({
      status: "error",
      message: expect.any(String),
      nonce: NONCE,
    })
  })

  it("omits the nonce when no action has succeeded yet", async () => {
    const result = await actionsFor(SIGNED_IN).createJob(
      IDLE,
      createForm({ titles: "" })
    )

    expect(result).not.toHaveProperty("nonce")
  })
})
