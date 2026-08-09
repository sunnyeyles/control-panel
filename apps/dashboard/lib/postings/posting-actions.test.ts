import type { CurrentUser } from "@/lib/auth/current-user"
import type { PrismaClient } from "@workspace/db"
import {
  ObjectNotFoundError,
  StorageUnavailableError,
  type CoverLetterRef,
  type CoverLetterStore,
  type TailoredResumeStore,
} from "@workspace/user-storage"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import {
  matchesPostingWhere,
  removeMatchingPostings,
  type PostingWhere,
} from "@/lib/dev/fake-prisma"
import { PAGE_SIZE } from "@/lib/postings/posting-query"
import { createPostingActions } from "./posting-actions"

const USER_ID = "11111111-2222-4333-8444-555555555555"
const OTHER_USER_ID = "99999999-8888-4777-8666-555555555555"
const POSTING_ID = "0123456789abcdef"
const OTHERS_POSTING_ID = "fedcba9876543210"
const MISSING_POSTING_ID = "aaaaaaaaaaaaaaaa"
const RESET_KEY = "cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa"
/** `postingPayload` returns it beside the payload; nothing here reads it. */
const RUN_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"

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
  /** Only `loadPostingDetail` reads it; the three writers leave it alone. */
  payload?: unknown
}

/** A payload the schema accepts, for the detail loader below. */
const PAYLOAD = {
  title: "Platform Engineer",
  company: "Acme",
  location: "Sydney",
  url: "https://www.seek.com.au/job/1",
  summary: "Building services.",
  matchReason: "Matches the criteria.",
  highlights: ["Kubernetes", "Go"],
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
 *
 * **The `where` is read by the same predicate the dev fake reads it with** —
 * `matchesPostingWhere` and `removeMatchingPostings` from `lib/dev/fake-prisma`.
 * The rows and the call log are this file's own, and deliberately so: the seeded
 * dev database knows one user, and these tests need a stranger. What is shared
 * is only the rule for which rows a `where` names, because two hand-written
 * spellings of an ownership filter can drift apart while both keep passing.
 */
class FakeDb {
  readonly rows: PostingRow[] = []
  readonly updates: unknown[] = []
  readonly deletes: unknown[] = []
  readonly reads: unknown[] = []
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

        findMany: async (query: { where: PostingWhere }) =>
          this.rows
            .filter((row) => matchesPostingWhere(row, query.where))
            .map((row) => ({ postingId: row.postingId })),

        /**
         * Addressed by **both** halves of the natural key, like `updateMany`
         * above and for the same reason: that pair is the ownership check, so a
         * fake that answered from `postingId` alone would let the stranger test
         * pass over an implementation that had stopped scoping.
         *
         * The compound `userId_postingId` rather than a plain `where`, because
         * `postingPayload` in `@workspace/db` addresses the unique index.
         */
        findUnique: async (query: {
          where: { userId_postingId: { userId: string; postingId: string } }
        }) => {
          const where = query.where.userId_postingId
          this.reads.push({ where })

          const found = this.rows.find(
            (row) =>
              row.userId === where.userId && row.postingId === where.postingId
          )

          return found
            ? { payload: found.payload, lastSeenRunId: RUN_ID }
            : null
        },

        deleteMany: async (query: { where: PostingWhere }) => {
          this.deletes.push(query)

          const removed = removeMatchingPostings(this.rows, query.where)
          for (const row of removed) this.log.push(`row:${row.postingId}`)

          return { count: removed.length }
        },
      },
    } as unknown as PrismaClient
  }

  find(postingId: string): PostingRow | undefined {
    return this.rows.find((row) => row.postingId === postingId)
  }
}

/**
 * A stand-in for one Posting-addressed document store that only knows how to
 * delete.
 *
 * `object_not_found` is the ordinary case rather than an error — most Postings
 * have neither a cover letter nor a tailored resume — so the fake throws it for
 * any id it was not told about, and the tests assert the action treats that as a
 * success.
 *
 * One class for both stores because their refs are identical (`(userId,
 * postingId)`) and the delete path treats them the same way. `label` is what
 * lands in the shared log, so an assertion can pin the *order* the two deletes
 * and the row deletion happen in — which is the property that keeps an object
 * from being orphaned by a row that went first.
 */
class FakeDocuments {
  readonly deleted: CoverLetterRef[] = []
  private readonly present = new Set<string>()
  private readonly broken = new Set<string>()

  constructor(
    private readonly log: string[],
    private readonly label: string,
    private readonly kind: string
  ) {}

  with(postingId: string): this {
    this.present.add(postingId)
    return this
  }

  /** A document S3 refuses to delete for a reason that is not "no such object". */
  unavailable(postingId: string): this {
    this.present.add(postingId)
    this.broken.add(postingId)
    return this
  }

  asStore(): CoverLetterStore & TailoredResumeStore {
    return {
      delete: async (ref: CoverLetterRef) => {
        this.log.push(`${this.label}:${ref.postingId}`)

        if (this.broken.has(ref.postingId)) {
          throw new StorageUnavailableError("s3 is having a moment")
        }

        if (!this.present.has(ref.postingId)) {
          throw new ObjectNotFoundError(
            `prod/${ref.userId}/${this.kind}/${ref.postingId}.md`
          )
        }

        this.deleted.push(ref)
      },
    } as unknown as CoverLetterStore & TailoredResumeStore
  }
}

let store: FakeDb
let letters: FakeDocuments
let tailoredResumes: FakeDocuments

beforeEach(() => {
  store = new FakeDb()
    .posting({ postingId: POSTING_ID, payload: PAYLOAD })
    .posting({
      postingId: OTHERS_POSTING_ID,
      userId: OTHER_USER_ID,
      payload: { ...PAYLOAD, summary: "A stranger's advertisement." },
    })

  letters = new FakeDocuments(store.log, "letter", "cover-letters")
  tailoredResumes = new FakeDocuments(store.log, "resume", "tailored-resumes")

  vi.spyOn(console, "error").mockImplementation(() => {})
})

function actionsFor(user: CurrentUser) {
  return createPostingActions({
    getUser: async () => user,
    getPrisma: () => store.asPrisma(),
    getCoverLetters: () => letters.asStore(),
    getTailoredResumes: () => tailoredResumes.asStore(),
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
      getTailoredResumes: () => tailoredResumes.asStore(),
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
      getTailoredResumes: () => tailoredResumes.asStore(),
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
      // One pass per distinct id, not per submitted field: both documents are
      // attempted once each, and the row once.
      expect(store.log).toEqual([
        `letter:${POSTING_ID}`,
        `resume:${POSTING_ID}`,
        `row:${POSTING_ID}`,
      ])
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
      letters.with(POSTING_ID)

      await actionsFor(SIGNED_IN).deletePostings(IDLE, deleteForm(POSTING_ID))

      expect(store.log).toEqual([
        `letter:${POSTING_ID}`,
        `resume:${POSTING_ID}`,
        `row:${POSTING_ID}`,
      ])
      expect(letters.deleted).toEqual([
        { userId: USER_ID, postingId: POSTING_ID },
      ])
    })

    it("is addressed with the session's user id, never the form's", async () => {
      letters.with(POSTING_ID)

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
      letters.unavailable(POSTING_ID).with(SECOND_POSTING_ID)

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

  /**
   * A Posting carries two documents, and both are keyed on its id — so a delete
   * that removed only one would leave an object nothing in the app can any
   * longer address, because the Posting whose id was its key is gone.
   *
   * Every case here is the letter's own, asked of the other store. They are not
   * redundant: the two travel through one `Promise.allSettled` and are folded
   * into one "is this Posting removable" answer, so an asymmetry — one store
   * skipped when the other misses, one failure not counted — is a real and
   * invisible way for this to be wrong.
   */
  describe("the tailored resume", () => {
    it("is deleted before the row, like the letter", async () => {
      tailoredResumes.with(POSTING_ID)

      await actionsFor(SIGNED_IN).deletePostings(IDLE, deleteForm(POSTING_ID))

      expect(store.log).toEqual([
        `letter:${POSTING_ID}`,
        `resume:${POSTING_ID}`,
        `row:${POSTING_ID}`,
      ])
      expect(tailoredResumes.deleted).toEqual([
        { userId: USER_ID, postingId: POSTING_ID },
      ])
    })

    it("is addressed with the session's user id, never the form's", async () => {
      tailoredResumes.with(POSTING_ID)

      const data = deleteForm(POSTING_ID)
      data.set("userId", OTHER_USER_ID)

      await actionsFor(SIGNED_IN).deletePostings(IDLE, data)

      expect(tailoredResumes.deleted).toEqual([
        { userId: USER_ID, postingId: POSTING_ID },
      ])
    })

    /**
     * ⚠️ **The case that would orphan an object.** A Posting with a tailored
     * resume and no cover letter is ordinary — the two are generated
     * independently — and the letter's delete rejects with `object_not_found`.
     * Issuing the pair with `allSettled` rather than `all` is what keeps that
     * rejection from skipping the resume's delete.
     */
    it("is still deleted when the Posting has no cover letter", async () => {
      tailoredResumes.with(POSTING_ID)

      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID)
      )

      expect(result).toMatchObject({ status: "success" })
      expect(tailoredResumes.deleted).toEqual([
        { userId: USER_ID, postingId: POSTING_ID },
      ])
      expect(store.find(POSTING_ID)).toBeUndefined()
    })

    /** And the mirror of it: a letter with no tailored resume beside it. */
    it("not existing does not stop the letter being deleted", async () => {
      letters.with(POSTING_ID)

      const result = await actionsFor(SIGNED_IN).deletePostings(
        IDLE,
        deleteForm(POSTING_ID)
      )

      expect(result).toMatchObject({ status: "success" })
      expect(letters.deleted).toEqual([
        { userId: USER_ID, postingId: POSTING_ID },
      ])
      expect(store.find(POSTING_ID)).toBeUndefined()
    })

    it("failing for any other reason leaves its Posting on the page", async () => {
      tailoredResumes.unavailable(POSTING_ID)

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
        getTailoredResumes: () => tailoredResumes.asStore(),
        now: () => NOW,
        newResetKey: () => RESET_KEY,
      })

      const result = await actions.deletePostings(IDLE, deleteForm(POSTING_ID))

      expect(result).toMatchObject({
        status: "error",
        message: "Something went wrong.",
      })
    })

    it("says the documents are gone when the rows fail after them", async () => {
      letters.with(POSTING_ID)
      tailoredResumes.with(POSTING_ID)

      const actions = createPostingActions({
        getUser: async () => SIGNED_IN,
        getPrisma: () =>
          ({
            posting: {
              findMany: async () => [{ postingId: POSTING_ID }],
              deleteMany: async () => {
                throw new Error("connection terminated")
              },
            },
          }) as unknown as PrismaClient,
        getCoverLetters: () => letters.asStore(),
        getTailoredResumes: () => tailoredResumes.asStore(),
        now: () => NOW,
        newResetKey: () => RESET_KEY,
      })

      const result = await actions.deletePostings(IDLE, deleteForm(POSTING_ID))

      // Both documents are already gone by the time the rows are attempted —
      // that is what deleting them first buys everywhere else — so this is the
      // one failure the message must not round off to "something went wrong".
      expect(letters.deleted).toHaveLength(1)
      expect(tailoredResumes.deleted).toHaveLength(1)
      expect(result).toMatchObject({
        status: "error",
        message: expect.stringContaining("already been deleted"),
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

/**
 * The read among the writes.
 *
 * ⚠️ **A read reachable by direct POST is still a read someone can aim at
 * another user's rows.** `"use server"` makes this an endpoint whether or not a
 * chevron is what usually calls it, so it gets the same two checks the writers
 * get — the caller from the session, and the Posting id against the shape
 * `postingId()` produces — and the same test for the stranger's row.
 */
describe("loadPostingDetail", () => {
  it("returns the prose the compact row does not carry", async () => {
    const result = await actionsFor(SIGNED_IN).loadPostingDetail(POSTING_ID)

    expect(result).toEqual({
      status: "success",
      detail: {
        summary: "Building services.",
        matchReason: "Matches the criteria.",
        highlights: ["Kubernetes", "Go"],
      },
    })
  })

  it("refuses a stranger's Posting the same way it refuses a missing one", async () => {
    const strangers =
      await actionsFor(SIGNED_IN).loadPostingDetail(OTHERS_POSTING_ID)
    const missing =
      await actionsFor(SIGNED_IN).loadPostingDetail(MISSING_POSTING_ID)

    // Indistinguishable on purpose: telling the two apart would confirm that a
    // Posting with that id exists and belongs to somebody.
    expect(strangers).toEqual(missing)
    expect(strangers).toMatchObject({ status: "error" })
  })

  it("refuses before anything is queried when nobody is signed in", async () => {
    for (const user of [ANONYMOUS, REFUSED]) {
      const result = await actionsFor(user).loadPostingDetail(POSTING_ID)

      expect(result).toEqual({ status: "error", message: NOT_AUTHORIZED })
    }

    expect(store.handedOut).toBe(0)
  })

  it("refuses an id that could not address a Posting, before querying", async () => {
    const result =
      await actionsFor(SIGNED_IN).loadPostingDetail("../../etc/passwd")

    expect(result).toMatchObject({ status: "error" })
    expect(store.handedOut).toBe(0)
  })

  /**
   * ⚠️ **A drifted payload is not a failed request, and the panel says
   * different things about them.** `listPostings` makes the same judgement
   * about the same rows: the advertisement is what the user came for, so the
   * detail going missing must not read as the row going missing.
   */
  it("answers with empty detail when the stored payload no longer parses", async () => {
    const mine = store.find(POSTING_ID)
    if (mine) mine.payload = { ...PAYLOAD, url: "not a url" }

    const result = await actionsFor(SIGNED_IN).loadPostingDetail(POSTING_ID)

    expect(result).toEqual({ status: "success", detail: { highlights: [] } })
  })

  it("reports a database failure as a failure, not as an empty detail", async () => {
    const actions = createPostingActions({
      getUser: async () => SIGNED_IN,
      getPrisma: () =>
        ({
          posting: {
            findUnique: async () => {
              throw new Error("connection reset")
            },
          },
        }) as unknown as PrismaClient,
      getCoverLetters: () => letters.asStore(),
      getTailoredResumes: () => tailoredResumes.asStore(),
    })

    await expect(actions.loadPostingDetail(POSTING_ID)).resolves.toMatchObject({
      status: "error",
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
