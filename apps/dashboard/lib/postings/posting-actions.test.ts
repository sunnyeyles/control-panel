import type { CurrentUser } from "@/lib/auth/current-user"
import type { PrismaClient } from "@workspace/db"
import {
  ObjectNotFoundError,
  StorageUnavailableError,
  type CoverLetterRef,
  type CoverLetterStore,
} from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import { PAGE_SIZE } from "@/lib/postings/posting-query"
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
  readonly deletes: unknown[] = []
  /** Times the client itself was asked for — a query cannot precede this. */
  handedOut = 0
  /**
   * Every row-touching call and every letter delete, in the order they were
   * made. What makes "the letter goes before the row" assertable at all — the
   * ordering is a property of the action, and each fake on its own can only say
   * that it was reached.
   */
  readonly log: string[] = []

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

        findMany: async (query: {
          where: { userId: string; postingId: { in: string[] } }
        }) =>
          this.matching(query.where).map((row) => ({
            postingId: row.postingId,
          })),

        deleteMany: async (query: {
          where: { userId: string; postingId: { in: string[] } }
        }) => {
          this.deletes.push(query)

          const doomed = new Set(this.matching(query.where))

          for (let index = this.rows.length - 1; index >= 0; index -= 1) {
            const row = this.rows[index]
            if (row !== undefined && doomed.has(row)) {
              this.log.push(`row:${row.postingId}`)
              this.rows.splice(index, 1)
            }
          }

          return { count: doomed.size }
        },
      },
    } as unknown as PrismaClient
  }

  /** Filters on **both** halves of the natural key, as the real query does. */
  private matching(where: {
    userId: string
    postingId: { in: string[] }
  }): PostingRow[] {
    return this.rows.filter(
      (row) =>
        row.userId === where.userId &&
        where.postingId.in.includes(row.postingId)
    )
  }

  find(postingId: string): PostingRow | undefined {
    return this.rows.find((row) => row.postingId === postingId)
  }
}

/**
 * A stand-in for `CoverLetterStore` that only knows how to delete.
 *
 * `object_not_found` is the ordinary case rather than an error — most Postings
 * have no letter — so the fake throws it for any id it was not told about, and
 * the tests assert the action treats that as a success.
 */
class FakeLetters {
  readonly deleted: CoverLetterRef[] = []
  private readonly present = new Set<string>()
  private readonly broken = new Set<string>()

  constructor(private readonly log: string[]) {}

  withLetter(postingId: string): this {
    this.present.add(postingId)
    return this
  }

  /** A letter S3 refuses to delete for a reason that is not "no such object". */
  unavailable(postingId: string): this {
    this.present.add(postingId)
    this.broken.add(postingId)
    return this
  }

  asStore(): CoverLetterStore {
    return {
      delete: async (ref: CoverLetterRef) => {
        this.log.push(`letter:${ref.postingId}`)

        if (this.broken.has(ref.postingId)) {
          throw new StorageUnavailableError("s3 is having a moment")
        }

        if (!this.present.has(ref.postingId)) {
          throw new ObjectNotFoundError(
            `prod/${ref.userId}/cover-letters/${ref.postingId}.md`
          )
        }

        this.deleted.push(ref)
      },
    } as unknown as CoverLetterStore
  }
}

let store: FakeDb
let letters: FakeLetters

beforeEach(() => {
  store = new FakeDb()
    .posting({ postingId: POSTING_ID })
    .posting({ postingId: OTHERS_POSTING_ID, userId: OTHER_USER_ID })

  letters = new FakeLetters(store.log)

  vi.spyOn(console, "error").mockImplementation(() => {})
})

function actionsFor(user: CurrentUser) {
  return createPostingActions({
    getUser: async () => user,
    getPrisma: () => store.asPrisma(),
    getCoverLetters: () => letters.asStore(),
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
      getCoverLetters: () => letters.asStore(),
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
      getCoverLetters: () => letters.asStore(),
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

describe("deleting postings", () => {
  const deleteForm = (...postingIds: string[]): FormData => {
    const data = new FormData()
    for (const postingId of postingIds) data.append("postingId", postingId)
    return data
  }

  const SECOND_POSTING_ID = "abcdef0123456789"
  const THIRD_POSTING_ID = "1122334455667788"

  describe("the gate", () => {
    it("refuses an anonymous caller before the body is read at all", async () => {
      const result = await actionsFor(ANONYMOUS).deletePostings(
        IDLE,
        deleteForm(POSTING_ID)
      )

      expect(result).toMatchObject({ status: "error", message: NOT_AUTHORIZED })
      expect(store.handedOut).toBe(0)
      expect(store.log).toHaveLength(0)
      expect(store.find(POSTING_ID)).toBeDefined()
    })

    it("gives a refused caller the identical state an anonymous one gets", async () => {
      const anonymous = await actionsFor(ANONYMOUS).deletePostings(
        IDLE,
        deleteForm(POSTING_ID)
      )
      const refused = await actionsFor(REFUSED).deletePostings(
        IDLE,
        deleteForm(POSTING_ID)
      )

      expect(refused).toEqual(anonymous)
    })

    it("never takes the user from the submission", async () => {
      const data = deleteForm(OTHERS_POSTING_ID)
      // A caller posting directly can name the owner of the row they would
      // like removed. The session is the only thing that decides.
      data.set("userId", OTHER_USER_ID)

      const result = await actionsFor(SIGNED_IN).deletePostings(IDLE, data)

      expect(result).toMatchObject({ status: "error" })
      expect(store.find(OTHERS_POSTING_ID)).toBeDefined()
      expect(store.log).toHaveLength(0)
    })
  })

  describe("what is accepted", () => {
    it("refuses a malformed id before anything is queried", async () => {
      const actions = actionsFor(SIGNED_IN)

      for (const postingId of [
        "",
        "not-hex",
        "0123456789ABCDEF",
        "0123456789abcde",
        "../../etc/passwd",
      ]) {
        const result = await actions.deletePostings(IDLE, deleteForm(postingId))

        expect(result).toMatchObject({ status: "error" })
      }

      expect(store.handedOut).toBe(0)
      expect(store.log).toHaveLength(0)
    })

    it("refuses a list with one bad id among good ones", async () => {
      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID, "not-hex")
      )

      expect(result).toMatchObject({ status: "error" })
      expect(store.handedOut).toBe(0)
      expect(store.find(POSTING_ID)).toBeDefined()
    })

    it("refuses an empty submission before anything is queried", async () => {
      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm()
      )

      expect(result).toMatchObject({ status: "error" })
      expect(store.handedOut).toBe(0)
    })

    it("refuses a list longer than a page, which only a direct POST can send", async () => {
      const overlong = Array.from({ length: PAGE_SIZE + 1 }, (_, index) =>
        index.toString(16).padStart(16, "0")
      )

      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(...overlong)
      )

      expect(result).toMatchObject({
        status: "error",
        message: expect.stringContaining(String(PAGE_SIZE)),
      })
      expect(store.handedOut).toBe(0)
    })

    it("counts a duplicated id once", async () => {
      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID, POSTING_ID)
      )

      expect(result).toMatchObject({
        status: "success",
        message: "Deleted 1 posting.",
      })
      expect(store.log).toEqual([`letter:${POSTING_ID}`, `row:${POSTING_ID}`])
    })
  })

  describe("someone else's Posting", () => {
    it("is refused with the state a missing one gets, exactly", async () => {
      const actions = actionsFor(SIGNED_IN)

      const theirs = await actions.deletePostings(
        IDLE,
        deleteForm(OTHERS_POSTING_ID)
      )
      const missing = await actions.deletePostings(
        IDLE,
        deleteForm(MISSING_POSTING_ID)
      )

      expect(theirs).toEqual(missing)
      expect(theirs).toMatchObject({ status: "error" })
    })

    it("leaves the row alone, and never reaches for its letter", async () => {
      await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(OTHERS_POSTING_ID)
      )

      expect(store.find(OTHERS_POSTING_ID)).toBeDefined()
      // The letter is addressed by the *caller's* id, so touching storage here
      // would delete a letter belonging to a Posting that was never deleted.
      expect(store.log).toHaveLength(0)
    })

    it("is dropped from a mixed list rather than failing the whole delete", async () => {
      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID, OTHERS_POSTING_ID)
      )

      expect(result).toMatchObject({
        status: "success",
        message: "Deleted 1 posting.",
      })
      expect(store.find(POSTING_ID)).toBeUndefined()
      expect(store.find(OTHERS_POSTING_ID)).toBeDefined()
    })
  })

  describe("the cover letter", () => {
    it("is deleted before the row, so a storage failure cannot strand it", async () => {
      letters.withLetter(POSTING_ID)

      await actionsFor(SIGNED_IN).deletePostings(IDLE, deleteForm(POSTING_ID))

      expect(store.log).toEqual([`letter:${POSTING_ID}`, `row:${POSTING_ID}`])
      expect(letters.deleted).toEqual([
        { userId: USER_ID, postingId: POSTING_ID },
      ])
    })

    it("is addressed with the session's user id, never the form's", async () => {
      letters.withLetter(POSTING_ID)

      const data = deleteForm(POSTING_ID)
      data.set("userId", OTHER_USER_ID)

      await actionsFor(SIGNED_IN).deletePostings(IDLE, data)

      expect(letters.deleted).toEqual([
        { userId: USER_ID, postingId: POSTING_ID },
      ])
    })

    it("not existing is the ordinary case, not a failure", async () => {
      // `letters` was told about nothing, so the store throws object_not_found.
      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID)
      )

      expect(result).toMatchObject({ status: "success" })
      expect(store.find(POSTING_ID)).toBeUndefined()
    })

    it("failing for any other reason leaves its Posting on the page", async () => {
      store.posting({ postingId: SECOND_POSTING_ID })
      letters.unavailable(POSTING_ID).withLetter(SECOND_POSTING_ID)

      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID, SECOND_POSTING_ID)
      )

      expect(result).toMatchObject({
        status: "success",
        message: expect.stringContaining("Deleted 1 of 2 postings"),
      })
      expect(store.find(POSTING_ID)).toBeDefined()
      expect(store.find(SECOND_POSTING_ID)).toBeUndefined()
    })

    it("failing for every one deletes nothing and says so", async () => {
      letters.unavailable(POSTING_ID)

      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID)
      )

      expect(result).toMatchObject({ status: "error" })
      expect(store.deletes).toHaveLength(0)
      expect(store.find(POSTING_ID)).toBeDefined()
    })
  })

  describe("what it hands back", () => {
    it("deletes a whole selection in one statement", async () => {
      store
        .posting({ postingId: SECOND_POSTING_ID })
        .posting({ postingId: THIRD_POSTING_ID })

      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID, SECOND_POSTING_ID, THIRD_POSTING_ID)
      )

      expect(result).toMatchObject({
        status: "success",
        message: "Deleted 3 postings.",
        // Required by the success variant, and minted per success rather than
        // carried over from whatever the previous state held.
        resetKey: RESET_KEY,
      })
      expect(store.deletes).toHaveLength(1)
      expect(store.rows.map((row) => row.postingId)).toEqual([
        OTHERS_POSTING_ID,
      ])
    })

    it("says nothing different when the store fails", async () => {
      const actions = createPostingActions({
        getUser: async () => SIGNED_IN,
        getPrisma: () =>
          ({
            posting: {
              findMany: async () => {
                throw new Error("connection terminated")
              },
            },
          }) as unknown as PrismaClient,
        getCoverLetters: () => letters.asStore(),
        now: () => NOW,
        newResetKey: () => RESET_KEY,
      })

      const result = await actions.deletePostings(IDLE, deleteForm(POSTING_ID))

      expect(result).toMatchObject({
        status: "error",
        message: "Something went wrong.",
      })
    })

    it("does not carry a previous success's reset key through a failure", async () => {
      const previous: ActionState = {
        status: "success",
        message: "Deleted 1 posting.",
        resetKey: "keep-me",
      }

      const result = await actionsFor(SIGNED_IN).deletePostings(
        previous,
        deleteForm("not-hex")
      )

      // Unlike the status action: nothing keys on a delete's failure, and the
      // dialog would be reopened rather than reset.
      expect(result).toEqual({
        status: "error",
        message: expect.any(String),
      })
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
