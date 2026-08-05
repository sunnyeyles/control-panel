import type { CurrentUser } from "@/lib/auth/current-user"
import type { PrismaClient } from "@workspace/db"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import { createPostingActions } from "./posting-actions"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"
const POSTING_ID = "0123456789abcdef"
const OTHERS_POSTING_ID = "fedcba9876543210"
const MISSING_POSTING_ID = "aaaaaaaaaaaaaaaa"
const RESET_KEY = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa"

const NOW = new Date("2026-08-05T00:00:00.000Z")

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

/** A `postings` row, as far as this action can see one. */
interface PostingRow {
  userId: string
  postingId: string
  status: string
  statusChangedAt: Date | null
}

/**
 * A stand-in for `prisma.posting` that filters on **both** halves of the natural
 * key, because that filter is the claim under test.
 *
 * The real `setPostingStatus` from `@workspace/db` runs against this rather than
 * being mocked: what the tests below assert is that a stranger's Posting is
 * unreachable and that the refusal is indistinguishable from a missing one, and
 * a mocked helper would assert only that this file passed it some arguments.
 *
 * Every call is recorded, so "refused before anything is queried" can be checked
 * as a fact about the store rather than inferred from a message.
 */
class FakeDb {
  readonly rows: PostingRow[] = []
  readonly updates: unknown[] = []
  /** Times the client itself was asked for — a query cannot precede this. */
  handedOut = 0

  posting(row: Partial<PostingRow> & { postingId: string }): this {
    this.rows.push({
      userId: USER_ID,
      status: "new",
      statusChangedAt: null,
      ...row,
    })

    return this
  }

  asPrisma(): PrismaClient {
    this.handedOut += 1

    return {
      posting: {
        updateMany: async (query: {
          where: { userId: string; postingId: string }
          data: Partial<PostingRow>
        }) => {
          this.updates.push(query)

          const matched = this.rows.filter(
            (row) =>
              row.userId === query.where.userId &&
              row.postingId === query.where.postingId
          )

          for (const row of matched) Object.assign(row, query.data)

          return { count: matched.length }
        },
      },
    } as unknown as PrismaClient
  }

  find(postingId: string): PostingRow | undefined {
    return this.rows.find((row) => row.postingId === postingId)
  }
}

let store: FakeDb

beforeEach(() => {
  store = new FakeDb()
    .posting({ postingId: POSTING_ID })
    .posting({ postingId: OTHERS_POSTING_ID, userId: OTHER_USER_ID })

  vi.spyOn(console, "error").mockImplementation(() => {})
})

function actionsFor(user: CurrentUser) {
  return createPostingActions({
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

const statusForm = (overrides: Record<string, string> = {}) =>
  form({ postingId: POSTING_ID, status: "applied", ...overrides })

describe("the gate", () => {
  it("refuses an anonymous caller before the body is read at all", async () => {
    const result = await actionsFor(ANONYMOUS).setPostingStatus(
      IDLE,
      statusForm()
    )

    expect(result).toMatchObject({ status: "error", message: NOT_AUTHORIZED })
    expect(store.handedOut).toBe(0)
    expect(store.updates).toHaveLength(0)
    expect(store.find(POSTING_ID)?.status).toBe("new")
  })

  it("gives a refused caller the identical state an anonymous one gets", async () => {
    const anonymous = await actionsFor(ANONYMOUS).setPostingStatus(
      IDLE,
      statusForm()
    )
    const refused = await actionsFor(REFUSED).setPostingStatus(
      IDLE,
      statusForm()
    )

    expect(refused).toEqual(anonymous)
    expect(store.updates).toHaveLength(0)
  })

  it("treats a thrown getUser as unauthorized rather than propagating it", async () => {
    const actions = createPostingActions({
      getUser: async () => {
        throw new Error("neon is asleep")
      },
      getPrisma: () => store.asPrisma(),
    })

    const result = await actions.setPostingStatus(IDLE, statusForm())

    expect(result).toMatchObject({ status: "error", message: NOT_AUTHORIZED })
    expect(store.handedOut).toBe(0)
  })

  it("never takes the user from the submission", async () => {
    const actions = actionsFor(SIGNED_IN)

    // A caller posting directly can put anything in the body, including the
    // owner of the row they would like to write.
    await actions.setPostingStatus(
      IDLE,
      statusForm({ postingId: OTHERS_POSTING_ID, userId: OTHER_USER_ID })
    )

    expect(store.updates).toEqual([
      {
        where: { userId: USER_ID, postingId: OTHERS_POSTING_ID },
        data: { status: "applied", statusChangedAt: NOW },
      },
    ])
    expect(store.find(OTHERS_POSTING_ID)?.status).toBe("new")
  })
})

describe("what is accepted", () => {
  it("refuses a malformed Posting id before anything is queried", async () => {
    const actions = actionsFor(SIGNED_IN)

    for (const postingId of [
      "",
      "not-hex",
      "0123456789ABCDEF",
      "0123456789abcde",
      "0123456789abcdef0",
      "../../etc/passwd",
    ]) {
      const result = await actions.setPostingStatus(
        IDLE,
        statusForm({ postingId })
      )

      expect(result).toMatchObject({ status: "error" })
    }

    expect(store.handedOut).toBe(0)
    expect(store.updates).toHaveLength(0)
  })

  it("refuses a fourth status before anything is queried", async () => {
    const actions = actionsFor(SIGNED_IN)

    for (const status of ["", "offered", "NEW", "new "]) {
      const result = await actions.setPostingStatus(
        IDLE,
        statusForm({ status })
      )

      expect(result).toMatchObject({ status: "error" })
    }

    expect(store.handedOut).toBe(0)
    expect(store.updates).toHaveLength(0)
    expect(store.find(POSTING_ID)?.status).toBe("new")
  })

  it("accepts each of the three", async () => {
    const actions = actionsFor(SIGNED_IN)

    for (const status of ["new", "applied", "rejected"]) {
      const result = await actions.setPostingStatus(
        IDLE,
        statusForm({ status })
      )

      expect(result).toMatchObject({ status: "success", resetKey: RESET_KEY })
      expect(store.find(POSTING_ID)?.status).toBe(status)
    }
  })

  it("stamps when the person touched it, from the injected clock", async () => {
    await actionsFor(SIGNED_IN).setPostingStatus(IDLE, statusForm())

    expect(store.find(POSTING_ID)?.statusChangedAt).toEqual(NOW)
  })
})

describe("someone else's Posting", () => {
  it("is refused with the message a missing one gets, exactly", async () => {
    const actions = actionsFor(SIGNED_IN)

    const theirs = await actions.setPostingStatus(
      IDLE,
      statusForm({ postingId: OTHERS_POSTING_ID })
    )
    const missing = await actions.setPostingStatus(
      IDLE,
      statusForm({ postingId: MISSING_POSTING_ID })
    )

    // The whole state, not just the message: a difference in any field would be
    // the same oracle by another route.
    expect(theirs).toEqual(missing)
    expect(theirs).toMatchObject({ status: "error" })
  })

  it("leaves the row alone", async () => {
    await actionsFor(SIGNED_IN).setPostingStatus(
      IDLE,
      statusForm({ postingId: OTHERS_POSTING_ID, status: "rejected" })
    )

    expect(store.find(OTHERS_POSTING_ID)).toMatchObject({
      status: "new",
      statusChangedAt: null,
    })
  })

  it("says nothing different when the store fails", async () => {
    const actions = createPostingActions({
      getUser: async () => SIGNED_IN,
      getPrisma: () =>
        ({
          posting: {
            updateMany: async () => {
              throw new Error("connection terminated")
            },
          },
        }) as unknown as PrismaClient,
      now: () => NOW,
      newResetKey: () => RESET_KEY,
    })

    const result = await actions.setPostingStatus(IDLE, statusForm())

    expect(result).toMatchObject({
      status: "error",
      message: "Something went wrong.",
    })
  })
})

describe("the state it hands back", () => {
  it("carries a previous success's reset key through a failure", async () => {
    const previous: ActionState = {
      status: "success",
      message: "Marked as Applied.",
      resetKey: "keep-me",
    }

    const result = await actionsFor(SIGNED_IN).setPostingStatus(
      previous,
      statusForm({ status: "offered" })
    )

    expect(result).toMatchObject({ status: "error", resetKey: "keep-me" })
  })
})
