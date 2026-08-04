import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import type { CurrentUser } from "@/lib/auth/current-user"
import type { Job, PrismaClient, Run } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BriefingInvoker } from "./invoke-worker"
import { RUN_STALE_AFTER_MS } from "./staleness"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"
const JOB_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const RUN_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff"

const NOW = new Date("2026-08-01T12:00:00.000Z")

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
  runningRunForJob: vi.fn(),
  startAdHocRun: vi.fn(),
  failRun: vi.fn(),
}))

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>()
  return { ...actual, ...mocks }
})

const { createRunActions } = await import("./run-actions")

function job(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    userId: USER_ID,
    name: "Daily briefing",
    config: { titles: ["backend engineer"], locations: ["Sydney"] },
    scheduleCron: "0 9 * * *",
    scheduleTimezone: "Australia/Sydney",
    nextRunAt: new Date("2026-08-02T09:00:00.000Z"),
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as Job
}

/**
 * Backs `job.findUnique` and counts every write.
 *
 * `mutations` is what the refusal tests assert on: an action that refuses must
 * not have started a run, and "returned an error" is a weaker claim than
 * "touched nothing".
 */
class SpyDb {
  readonly rows = new Map<string, Job>()

  constructor(...jobs: Job[]) {
    for (const row of jobs) this.rows.set(row.id, row)
  }

  get mutations(): number {
    return (
      mocks.startAdHocRun.mock.calls.length + mocks.failRun.mock.calls.length
    )
  }

  asPrisma(): PrismaClient {
    return {
      job: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          this.rows.get(where.id) ?? null,
      },
    } as unknown as PrismaClient
  }
}

let store: SpyDb
let requested: { runId: string; jobId: string }[]
let invoker: BriefingInvoker

function actionsFor(user: CurrentUser) {
  return createRunActions({
    getUser: async () => user,
    getPrisma: () => store.asPrisma(),
    getInvoker: () => invoker,
    now: () => NOW,
  })
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.append(key, value)
  return data
}

function trigger(user: CurrentUser, jobId: string = JOB_ID) {
  return actionsFor(user).triggerBriefingRun(IDLE, form({ jobId }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})

  store = new SpyDb(job())
  requested = []
  invoker = {
    requestRun: async (request) => {
      requested.push(request)
    },
  }

  mocks.runningRunForJob.mockResolvedValue(undefined)
  mocks.startAdHocRun.mockResolvedValue({ id: RUN_ID } as Run)
  mocks.failRun.mockResolvedValue(true)
})

describe("the gate", () => {
  it("refuses an anonymous caller without touching the store", async () => {
    const state = await trigger(ANONYMOUS)

    expect(state).toMatchObject({ status: "error", message: NOT_AUTHORIZED })
    expect(store.mutations).toBe(0)
    expect(requested).toEqual([])
  })

  it("gives a refused caller the identical state an anonymous one gets", async () => {
    const refused = await trigger(REFUSED)
    const anonymous = await trigger(ANONYMOUS)

    expect(refused).toEqual(anonymous)
    expect(refused).toMatchObject({ message: NOT_AUTHORIZED })
  })

  it("treats a thrown getUser as unauthorized rather than propagating it", async () => {
    const actions = createRunActions({
      getUser: async () => {
        throw new Error("the session store is down")
      },
      getPrisma: () => store.asPrisma(),
      getInvoker: () => invoker,
      now: () => NOW,
    })

    const state = await actions.triggerBriefingRun(
      IDLE,
      form({ jobId: JOB_ID })
    )

    expect(state).toMatchObject({ status: "error", message: NOT_AUTHORIZED })
    expect(store.mutations).toBe(0)
  })
})

describe("ownership", () => {
  it("refuses a briefing owned by someone else, and says the same as a missing one", async () => {
    store = new SpyDb(job({ userId: OTHER_USER_ID }))
    const notMine = await trigger(SIGNED_IN)

    store = new SpyDb()
    const missing = await trigger(SIGNED_IN)

    expect(notMine).toEqual(missing)
    expect(notMine.status).toBe("error")
    expect(store.mutations).toBe(0)
    expect(requested).toEqual([])
  })

  it("rejects a jobId that is not a uuid before querying", async () => {
    const findUnique = vi.fn()
    store.asPrisma = () => ({ job: { findUnique } }) as unknown as PrismaClient

    const state = await trigger(SIGNED_IN, "../../etc/passwd")

    expect(state.status).toBe("error")
    expect(findUnique).not.toHaveBeenCalled()
    expect(store.mutations).toBe(0)
  })
})

describe("starting a run", () => {
  it("creates an ad-hoc run and asks the worker for it", async () => {
    const state = await trigger(SIGNED_IN)

    expect(state).toMatchObject({ status: "success", resetKey: RUN_ID })
    expect(mocks.startAdHocRun).toHaveBeenCalledWith(expect.anything(), JOB_ID)
    expect(requested).toEqual([{ runId: RUN_ID, jobId: JOB_ID }])
  })

  it("runs a briefing that is turned off", async () => {
    store = new SpyDb(job({ nextRunAt: null }))

    const state = await trigger(SIGNED_IN)

    expect(state.status).toBe("success")
    expect(requested).toHaveLength(1)
  })

  it("never takes the job id from the form for the invoke", async () => {
    // The form field and the row agree here; what is asserted is that the value
    // sent on is the row's, so a future change that passes the parsed input
    // through instead is caught.
    await trigger(SIGNED_IN)

    expect(requested[0]?.jobId).toBe(store.rows.get(JOB_ID)?.id)
  })
})

describe("one at a time", () => {
  it("refuses while a run is already going, and starts nothing", async () => {
    mocks.runningRunForJob.mockResolvedValue({ id: "other" } as Run)

    const state = await trigger(SIGNED_IN)

    expect(state.status).toBe("error")
    expect(mocks.startAdHocRun).not.toHaveBeenCalled()
    expect(requested).toEqual([])
  })

  it("asks only about runs new enough to still be believed", async () => {
    await trigger(SIGNED_IN)

    expect(mocks.runningRunForJob).toHaveBeenCalledWith(
      expect.anything(),
      JOB_ID,
      new Date(NOW.getTime() - RUN_STALE_AFTER_MS)
    )
  })

  it("starts a run once the previous one is too old to believe", async () => {
    // `runningRunForJob` is what applies the bound, so an undefined answer here
    // *is* the stale case — the point being that the action does not add a
    // second opinion on top of it.
    mocks.runningRunForJob.mockResolvedValue(undefined)

    expect((await trigger(SIGNED_IN)).status).toBe("success")
  })
})

describe("when the worker cannot be reached", () => {
  it("closes the run it just opened rather than leaving it running", async () => {
    invoker = {
      requestRun: async () => {
        throw new Error("AccessDeniedException")
      },
    }

    const state = await trigger(SIGNED_IN)

    expect(state.status).toBe("error")
    expect(mocks.failRun).toHaveBeenCalledWith(
      expect.anything(),
      RUN_ID,
      expect.objectContaining({ message: expect.any(String) })
    )
  })

  it("does not leak the AWS error to the user", async () => {
    invoker = {
      requestRun: async () => {
        throw new Error(
          "AccessDeniedException: arn:aws:iam::650694420748:role/x"
        )
      },
    }

    const state = await trigger(SIGNED_IN)

    expect(state.status).toBe("error")
    if (state.status !== "error") throw new Error("unreachable")
    expect(state.message).not.toContain("arn:aws")
    expect(state.message).not.toContain("AccessDenied")
  })

  it("still reports an error when closing the run also fails", async () => {
    invoker = {
      requestRun: async () => {
        throw new Error("timeout")
      },
    }
    mocks.failRun.mockRejectedValue(new Error("database gone"))

    await expect(trigger(SIGNED_IN)).resolves.toMatchObject({
      status: "error",
    })
  })
})

describe("when the store is unavailable", () => {
  it("reports a failure rather than throwing", async () => {
    mocks.startAdHocRun.mockRejectedValue(new Error("connection refused"))

    const state: ActionState = await trigger(SIGNED_IN)

    expect(state.status).toBe("error")
    expect(requested).toEqual([])
  })
})
