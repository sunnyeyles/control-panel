/**
 * The five gates a **Posting Document** passes before a model is asked for one.
 *
 * These assertions were made twice — once in the letters' suite and once in the
 * resumes' — and each copy tested the same five branches through a different
 * action, which meant "does a refused caller reach the database" had two answers
 * that could disagree. They are about preparation rather than about either
 * document, so they belong here, and each feature's suite is left asserting what
 * it actually owns: the sentence it says, the prompt it composes, and what it
 * writes.
 *
 * ⚠️ **The order is what most of this file is about.** Nothing here would fail
 * if the steps ran in a different sequence and all still ran — so the assertions
 * are on what did *not* happen: no query for a refused caller, no CV read for an
 * unidentifiable Posting, no storage call once the Posting is missing.
 */

import { UndraftableError } from "@workspace/agents/draftable"
import type { Posting } from "@workspace/agents/findings"
import { postingId } from "@workspace/agents/posting-id"
import type { PrismaClient } from "@workspace/db"
import { StorageUnavailableError } from "@workspace/user-storage"
import { beforeEach, describe, expect, it } from "vitest"

import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import { POSTING_UNREADABLE } from "@/lib/postings/load-stored-posting"
import {
  fakeDocumentDb,
  mergeClients,
} from "@/lib/test-support/fake-document-db"
import { FakeResumes } from "@/lib/test-support/fake-resumes"
import {
  ANONYMOUS,
  OTHER_USER_ID,
  REFUSED,
  RUN_ID,
  SIGNED_IN,
  USER_ID,
} from "@/lib/test-support/identities"
import { BAD_REQUEST } from "./posting-document-ref"
import {
  preparePostingDocument,
  type PreparePostingDocumentDeps,
} from "./prepare-posting-document"

const NOW = new Date("2026-08-09T04:15:00.000Z")

const POSTING: Posting = {
  title: "Backend Engineer",
  company: "Acme",
  location: "Sydney",
  url: "https://www.seek.com.au/job/1",
  summary: "Building payment services.",
  matchReason: "Matches your titles.",
}

const POSTING_ID = postingId(POSTING)

/** Comfortably over `MIN_BACKGROUND_CHARS`, so `assertDraftable` passes. */
const CV = [
  "# Alice Example",
  "",
  "Backend engineer, eight years. Built and ran payment services on Node and",
  "Postgres at Northwind, then led the migration of a monolith to a set of",
  "services at Contoso. Comfortable with TypeScript, Go, Terraform and AWS.",
  "Mentored four juniors. Based in Sydney and looking for backend work with",
  "some infrastructure in it.",
].join("\n")

/** The one table this reads, and a record of every time it was asked. */
class FakePostings {
  readonly reads: { userId: string; postingId: string }[] = []
  private readonly rows = new Map<string, { payload: unknown }>()
  /** Set to make the query throw, as an unreachable database would. */
  failing = false

  seed(userId: string, payload: unknown): this {
    this.rows.set(`${userId}/${POSTING_ID}`, { payload })
    return this
  }

  asPrisma(): PrismaClient {
    return {
      posting: {
        findUnique: async (query: {
          where: { userId_postingId: { userId: string; postingId: string } }
        }) => {
          const where = query.where.userId_postingId
          this.reads.push(where)
          if (this.failing) throw new Error("database unreachable")

          const found = this.rows.get(`${where.userId}/${where.postingId}`)
          return found
            ? { payload: found.payload, lastSeenRunId: RUN_ID }
            : null
        },
      },
    } as unknown as PrismaClient
  }
}

let postings: FakePostings
let resumes: FakeResumes

beforeEach(() => {
  postings = new FakePostings().seed(USER_ID, POSTING)
  resumes = new FakeResumes(CV, NOW).add({
    resumeId: "3f8d1b2a-0000-4000-8000-0000000000c1",
    extension: ".md",
    documentType: "resume",
    originalFilename: "alice-cv.md",
  })
})

function deps(
  overrides: Partial<PreparePostingDocumentDeps> = {}
): PreparePostingDocumentDeps {
  return {
    getUser: async () => SIGNED_IN,
    getPrisma: () =>
      mergeClients(postings.asPrisma(), fakeDocumentDb(USER_ID, resumes.rows)),
    getResumes: () => resumes,
    ...overrides,
  }
}

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

function prepare(
  overrides: Partial<PreparePostingDocumentDeps> = {},
  entries: Record<string, string> = { postingId: POSTING_ID }
) {
  return preparePostingDocument(deps(overrides), form(entries), "cover-letters")
}

describe("who is asking", () => {
  it("refuses an anonymous caller before the body is read at all", async () => {
    const result = await prepare({ getUser: async () => ANONYMOUS })

    expect(result).toEqual({
      ok: false,
      reason: "refused",
      message: NOT_AUTHORIZED,
    })
    // The order, asserted the only way it can be: nothing was looked up.
    expect(postings.reads).toEqual([])
  })

  it("refuses a caller the allowlist turned away, in the same words", async () => {
    // ⚠️ Authenticated by the provider and refused by `AUTH_ALLOWED_EMAILS`, so
    // this is a real session. Two messages would tell someone outside the list
    // that their sign-in worked.
    const result = await prepare({ getUser: async () => REFUSED })

    expect(result).toMatchObject({ reason: "refused", message: NOT_AUTHORIZED })
    expect(postings.reads).toEqual([])
  })
})

describe("which Posting", () => {
  it("reads only the id, and never a Posting the caller supplied", async () => {
    // ⚠️ The security property. A Posting body accepted from a form would be
    // arbitrary text stored in a document written in the user's own name.
    const result = await prepare(
      {},
      {
        postingId: POSTING_ID,
        posting: JSON.stringify({
          title: "Chief of Everything",
          company: "Mine",
        }),
      }
    )

    expect(result).toMatchObject({ ok: true, posting: POSTING })
  })

  it("refuses an id that could not be one", async () => {
    for (const bad of ["", "not-hex", "0f1e2d3c4b5a697", "../../etc/passwd"]) {
      const result = await prepare({}, { postingId: bad })

      expect(result).toMatchObject({ reason: "refused", message: BAD_REQUEST })
    }

    // And nothing reached a query, so a malformed id cannot be probed with.
    expect(postings.reads).toEqual([])
  })

  it("addresses the Posting by the session's user, not by anything sent", async () => {
    // `(user_id, posting_id)` is the natural key and the user half comes from
    // the session, so a stranger's advertisement cannot be *named* from here —
    // there is no window between an ownership check and a read.
    await prepare({}, { postingId: POSTING_ID, userId: OTHER_USER_ID })

    expect(postings.reads).toEqual([{ userId: USER_ID, postingId: POSTING_ID }])
  })

  it("cannot tell another user's Posting from one nobody has", async () => {
    // Posting ids are derived from an advertisement's URL, so two messages would
    // turn this into an oracle for whether a stranger has been shown one.
    postings = new FakePostings().seed(OTHER_USER_ID, POSTING)

    const result = await prepare()

    expect(result).toMatchObject({ reason: "refused" })
    expect((result as { message: string }).message).toBe(
      "That posting could not be found."
    )
  })

  it("refuses a row whose stored Posting will not parse", async () => {
    // `payload` *is* what the document would be written from, so there is
    // nothing to degrade to — unlike the postings table, which renders such a
    // row from its projected columns and looks ordinary doing it.
    postings = new FakePostings().seed(USER_ID, { title: 42 })

    const result = await prepare()

    expect(result).toMatchObject({
      reason: "refused",
      message: POSTING_UNREADABLE,
    })
  })

  it("does not read a CV once the Posting is gone", async () => {
    // Spending, and privacy: an unidentifiable Posting must not cause someone's
    // CV to be fetched and parsed.
    postings = new FakePostings()

    await prepare()

    expect(await resumes.list(USER_ID)).toHaveLength(1)
    expect(postings.reads).toHaveLength(1)
  })
})

describe("whether there is anything to write from", () => {
  it("reports a missing resume as a reason, not as a sentence", async () => {
    // ⚠️ The point of the union. A letter with no CV and a resume with no CV are
    // the same condition and are told to the user differently, because the next
    // thing to do about them differs.
    resumes = new FakeResumes(CV, NOW)

    expect(await prepare()).toEqual({
      ok: false,
      reason: "no-background",
      missing: "no-resume",
    })
  })

  it("distinguishes a format nothing can read", async () => {
    resumes = new FakeResumes(CV, NOW).add({
      resumeId: "3f8d1b2a-0000-4000-8000-0000000000c2",
      extension: ".rtf",
      documentType: "resume",
    })

    expect(await prepare()).toMatchObject({ missing: "unreadable-format" })
  })

  it("passes a storage outage through as a refusal, never as 'no resume'", async () => {
    // Telling a user they have no CV during an outage would have them re-upload
    // a document they already have.
    resumes.failsWith(new StorageUnavailableError("the bucket is down"))

    const result = await prepare()

    expect(result).toMatchObject({ reason: "refused" })
    expect((result as { message: string }).message).not.toContain("Upload")
  })
})

describe("whether there is enough to write from", () => {
  it("reports too little text as an error the feature can word", async () => {
    resumes = new FakeResumes("Alice.", NOW).add({
      resumeId: "3f8d1b2a-0000-4000-8000-0000000000c3",
      extension: ".md",
      documentType: "resume",
      originalFilename: "stub.md",
    })

    const result = await prepare()

    expect(result).toMatchObject({ ok: false, reason: "undraftable" })
    const undraftable = result as {
      error: UndraftableError
      displayName: string
    }
    expect(undraftable.error).toBeInstanceOf(UndraftableError)
    expect(undraftable.error.reason).toBe("too-short")
    // Named, so the message can say *which* document was tried — the selection
    // rule takes the newest one labelled Resume and the user may not know which
    // that is.
    expect(undraftable.displayName).toBe("stub.md")
  })

  it("measures the extracted text, not the file", async () => {
    // Which is why the background is loaded and parsed before this runs. A PDF
    // that is a scan parses fine and yields nothing.
    resumes = new FakeResumes("", NOW).add({
      resumeId: "3f8d1b2a-0000-4000-8000-0000000000c4",
      extension: ".md",
      documentType: "resume",
      bytes: new TextEncoder().encode(""),
    })

    expect(await prepare()).toMatchObject({
      reason: "undraftable",
      error: expect.objectContaining({ reason: "absent" }),
    })
  })
})

describe("when everything holds", () => {
  it("hands back the session's user, the stored Posting and the CV", async () => {
    const result = await prepare()

    expect(result).toEqual({
      ok: true,
      userId: USER_ID,
      postingId: POSTING_ID,
      posting: POSTING,
      // Carried off the row rather than looked up: nothing on this path reads a
      // Run, and the Run is provenance rather than part of any key.
      lastSeenRunId: RUN_ID,
      background: CV,
      displayName: "alice-cv.md",
    })
  })
})
