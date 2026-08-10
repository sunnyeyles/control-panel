import type { CurrentUser } from "@/lib/auth/current-user"
import type { PostingFilters, PrismaClient } from "@workspace/db"
import { MAX_TITLE_EXCLUSIONS } from "@workspace/job-search"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { IDLE, type ActionState } from "@/lib/actions/action-state"
import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import {
  ANONYMOUS,
  REFUSED,
  RESET_KEY,
  SIGNED_IN,
  USER_ID,
} from "@/lib/test-support/identities"

import { createTitleFilterActions } from "./title-filter-actions"

/**
 * Saving the title filter: authorization, the bound, and what actually lands in
 * the row.
 *
 * Every claim here is about something invisible from the happy path — that an
 * unauthenticated POST is refused before the body is read, that the row is
 * addressed by the session and never by a form field, that an over-long list is
 * refused rather than trimmed, and that what is *stored* has been through the
 * same parse the *matching* rule is built from.
 *
 * That last one is the bug this suite exists for. A filter that saves cleanly
 * and then matches nothing — because the stored term kept its capitals, or its
 * punctuation — is invisible from both ends: the field shows what the user
 * typed, and the table shows every posting they thought they had hidden.
 */

const NOW = new Date("2026-08-10T00:00:00.000Z")

const mocks = vi.hoisted(() => ({ savePostingFilters: vi.fn() }))

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>()
  return { ...actual, savePostingFilters: mocks.savePostingFilters }
})

/** Records every write of the filters row, and can fail one. */
class SpyDb {
  readonly saves: { userId: string; titleExclusions: string[] }[] = []
  saveError: unknown

  asPrisma(): PrismaClient {
    // Nothing reaches a delegate — the helper is mocked — so this only has to
    // be the value the action threads through to it.
    return {} as unknown as PrismaClient
  }

  installMocks(): void {
    mocks.savePostingFilters.mockImplementation(
      async (
        _prisma,
        userId: string,
        values: { titleExclusions: string[] }
      ) => {
        if (this.saveError) throw this.saveError
        this.saves.push({ userId, ...values })

        return { userId, ...values, updatedAt: NOW } as PostingFilters
      }
    )
  }
}

let db: SpyDb

beforeEach(() => {
  vi.clearAllMocks()
  db = new SpyDb()
  db.installMocks()
})

function actions(user: CurrentUser = SIGNED_IN) {
  return createTitleFilterActions({
    getUser: async () => user,
    getPrisma: () => db.asPrisma(),
    newResetKey: () => RESET_KEY,
  })
}

function save(
  value: string | null,
  user: CurrentUser = SIGNED_IN,
  state: ActionState = IDLE
) {
  const form = new FormData()
  if (value !== null) form.set("titleExclusions", value)

  return actions(user).saveTitleFilters(state, form)
}

describe("authorization", () => {
  it("refuses an anonymous caller before touching the body", async () => {
    const result = await save("senior", ANONYMOUS)

    expect(result).toMatchObject({
      status: "error",
      message: NOT_AUTHORIZED,
    })
    expect(mocks.savePostingFilters).not.toHaveBeenCalled()
  })

  it("refuses a signed-in caller the allowlist does not admit, identically", async () => {
    // A real session that `AUTH_ALLOWED_EMAILS` does not admit. Telling it
    // apart from an anonymous one would confirm the account exists.
    const result = await save("senior", REFUSED)

    expect(result).toMatchObject({ status: "error", message: NOT_AUTHORIZED })
    expect(mocks.savePostingFilters).not.toHaveBeenCalled()
  })

  it("addresses the row by the session, never by anything posted", async () => {
    const form = new FormData()
    form.set("titleExclusions", "senior")
    // A field that would name someone else's row if anything read it.
    form.set("userId", "99999999-8888-4777-8666-555555555555")

    await actions().saveTitleFilters(IDLE, form)

    expect(db.saves).toEqual([{ userId: USER_ID, titleExclusions: ["senior"] }])
  })
})

describe("what gets stored", () => {
  it("stores terms as the matching rule will read them", async () => {
    // ⚠️ The whole point of sharing `parseTitleExclusions` with the matcher: a
    // term stored as the user typed it would save cleanly and match nothing.
    await save("Senior,  Tech-Lead , PRINCIPAL")

    expect(db.saves[0]?.titleExclusions).toEqual([
      "senior",
      "tech-lead",
      "principal",
    ])
  })

  it("drops duplicates that only collide once normalised", async () => {
    await save("tech lead, Tech-Lead, senior")

    expect(db.saves[0]?.titleExclusions).toEqual(["tech lead", "senior"])
  })

  it("treats an emptied field as clearing the filter", async () => {
    const result = await save("  ,  , ")

    // Clearing is an ordinary save rather than its own control, so the empty
    // list has to reach the row — not be read as "nothing to do".
    expect(db.saves[0]?.titleExclusions).toEqual([])
    expect(result).toMatchObject({ status: "success" })
    expect(result).toMatchObject({
      message: expect.stringMatching(/cleared/i) as unknown as string,
    })
  })

  it("treats a field that was never posted the same as an empty one", async () => {
    await save(null)

    expect(db.saves[0]?.titleExclusions).toEqual([])
  })
})

describe("the bound", () => {
  it("refuses a list longer than the cap rather than trimming it", async () => {
    const tooMany = Array.from(
      { length: MAX_TITLE_EXCLUSIONS + 1 },
      (_, at) => `term${at}`
    ).join(",")

    const result = await save(tooMany)

    // Trimming would drop terms off the end silently, and the postings they
    // were meant to hide would simply reappear — which reads as a broken
    // filter rather than as a list that was too long.
    expect(result).toMatchObject({ status: "error" })
    expect(mocks.savePostingFilters).not.toHaveBeenCalled()
  })

  it("accepts a list exactly at the cap", async () => {
    const exactly = Array.from(
      { length: MAX_TITLE_EXCLUSIONS },
      (_, at) => `term${at}`
    ).join(",")

    await save(exactly)

    expect(db.saves[0]?.titleExclusions).toHaveLength(MAX_TITLE_EXCLUSIONS)
  })
})

describe("failures", () => {
  it("reports a store failure as a message rather than throwing", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    db.saveError = new Error("the filters table is gone")

    const result = await save("senior")

    expect(result).toMatchObject({ status: "error" })
    expect(error).toHaveBeenCalled()
  })

  it("carries the previous reset key through a failure", async () => {
    // A form keys its fields on this, so a key that changed here would remount
    // them and throw away what the user typed, at the moment they are being
    // told to fix it.
    const previous: ActionState = {
      status: "success",
      message: "Saved.",
      resetKey: "prior-key",
    }

    const result = await save("senior", ANONYMOUS, previous)

    expect(result).toMatchObject({ status: "error", resetKey: "prior-key" })
  })
})
