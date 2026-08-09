/**
 * The four gates a **Posting Document** passes before an edit overwrites it.
 *
 * These assertions were made twice — once in the letters' suite and once in the
 * resumes' — and each copy tested the same branches through a different action,
 * which meant "is an outage reported as a missing document" had two answers that
 * could disagree. (It had one wrong one: neither suite asked.) They are about
 * editing rather than about either document, so they belong here, and each
 * feature's suite is left asserting what it owns — the sentence it says and the
 * object it writes, through its own facade and a real key.
 *
 * ⚠️ **Most of this file is about order.** Nothing here would fail if the steps
 * ran in a different sequence and all still ran, so the assertions are on what
 * did *not* happen: no store call for a refused caller, none for a malformed id,
 * none for a body that was never going to be stored, and no write for a document
 * that is not there.
 *
 * The store side is the **real** facades over an in-memory `UserObjectStore`,
 * driven from a table, because the one thing a shared editor could plausibly get
 * wrong is the round trip through them: the two name their instant differently
 * and this module never learns which name it is holding.
 */

import type { CurrentUser } from "@/lib/auth/current-user"
import {
  StorageUnavailableError,
  type ObjectKind,
} from "@workspace/user-storage"
import { createCoverLetterStore } from "@workspace/user-storage/cover-letter-store"
import { createTailoredResumeStore } from "@workspace/user-storage/tailored-resume-store"
import { beforeEach, describe, expect, it } from "vitest"

import { NOT_AUTHORIZED } from "@/lib/actions/require-user"
import { STORAGE_UNAVAILABLE } from "@/lib/actions/storage-message"
import {
  ANONYMOUS,
  ENVIRONMENT,
  OTHER_USER_ID,
  REFUSED,
  RUN_ID,
  SIGNED_IN,
  USER_ID,
} from "@/lib/test-support/identities"
import { MemoryObjects } from "@/lib/test-support/memory-objects"
import {
  editPostingDocument,
  type EditablePostingDocuments,
} from "./edit-posting-document"
import { BAD_REQUEST } from "./posting-document-ref"

const NOW = new Date("2026-08-09T06:20:00.000Z")

/** When the document under edit was written. Never `NOW`, so a restamp shows. */
const WRITTEN_AT = new Date("2026-08-02T01:05:00.000Z")

/**
 * A well-formed Posting id, written out rather than derived.
 *
 * Nothing on this path reads a Posting — an edit addresses a document that
 * already exists and takes its provenance off that object — so there is no
 * advertisement here for `postingId()` to derive one from. The shape is what
 * matters, and `posting-document-ref.test.ts` is where the shape is pinned.
 */
const POSTING_ID = "0f1e2d3c4b5a6978"

const ORIGINAL = "# Original\n\nAs it was written."
const EDITED = "# Original\n\nAs the user rewrote it."

/**
 * Small, and this suite's own rather than either feature's.
 *
 * `MAX_LETTER_CHARS` and `MAX_RESUME_CHARS` are 50,000 each and are the
 * features' to choose; what is asserted here is that the number is applied, and
 * applied to the right string.
 */
const MAX_CHARS = 40

interface Kind {
  /** How the failure reads in the runner. */
  name: string
  /** The bucket prefix, which the two must not share. */
  objectKind: ObjectKind
  /** The metadata key its instant lands under. The whole point of the table. */
  instantKey: string
  /** Writes one document at `(USER_ID, POSTING_ID)`, as its feature would. */
  seed(objects: MemoryObjects): Promise<void>
  /** Runs the editor over this kind's real facade. */
  edit(
    objects: MemoryObjects,
    user: CurrentUser,
    formData: FormData
  ): ReturnType<typeof editPostingDocument>
}

const PROVENANCE = {
  runId: RUN_ID,
  title: "Backend Engineer",
  company: "Acme",
  url: "https://www.seek.com.au/job/1",
}

const KINDS: Kind[] = [
  {
    name: "cover letter",
    objectKind: "cover-letters",
    instantKey: "drafted-at",
    async seed(objects) {
      await createCoverLetterStore(objects).put({
        userId: USER_ID,
        postingId: POSTING_ID,
        markdown: ORIGINAL,
        draftedAt: WRITTEN_AT,
        provenance: PROVENANCE,
      })
    },
    edit(objects, user, formData) {
      return editPostingDocument(
        { getUser: async () => user },
        formData,
        createCoverLetterStore(objects),
        { kind: "cover-letters", maxChars: MAX_CHARS }
      )
    },
  },
  {
    name: "tailored resume",
    objectKind: "tailored-resumes",
    instantKey: "generated-at",
    async seed(objects) {
      await createTailoredResumeStore(objects).put({
        userId: USER_ID,
        postingId: POSTING_ID,
        markdown: ORIGINAL,
        generatedAt: WRITTEN_AT,
        // The field a letter's provenance does not declare. It has to survive
        // an edit too, and only this kind can prove that.
        provenance: { ...PROVENANCE, sourceDocument: "alice-cv.md" },
      })
    },
    edit(objects, user, formData) {
      return editPostingDocument(
        { getUser: async () => user },
        formData,
        createTailoredResumeStore(objects),
        { kind: "tailored-resumes", maxChars: MAX_CHARS }
      )
    },
  },
]

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.set(key, value)
  return data
}

const VALID = { postingId: POSTING_ID, markdown: EDITED }

let objects: MemoryObjects

beforeEach(() => {
  objects = new MemoryObjects(NOW)
})

describe.each(KINDS)("$name", (kind) => {
  const EXPECTED_KEY = `${ENVIRONMENT}/${USER_ID}/${kind.objectKind}/${POSTING_ID}.md`

  /** Runs the editor as the signed-in user unless a suite says otherwise. */
  const edit = (
    entries: Record<string, string> = VALID,
    user: CurrentUser = SIGNED_IN
  ) => kind.edit(objects, user, form(entries))

  describe("who is asking", () => {
    it("refuses an anonymous caller before the store is touched", async () => {
      await kind.seed(objects)
      const writes = objects.puts.length

      expect(await edit(VALID, ANONYMOUS)).toEqual({
        ok: false,
        reason: "refused",
        message: NOT_AUTHORIZED,
      })
      // The order, asserted the only way it can be: nothing was looked up, and
      // the seeded document is untouched.
      expect(objects.reads).toEqual([])
      expect(objects.puts).toHaveLength(writes)
    })

    it("refuses a caller the allowlist turned away, in the same words", async () => {
      // ⚠️ Authenticated by the provider and refused by `AUTH_ALLOWED_EMAILS`,
      // so this is a real session. Two messages would tell someone outside the
      // list that their sign-in worked.
      await kind.seed(objects)

      expect(await edit(VALID, REFUSED)).toMatchObject({
        reason: "refused",
        message: NOT_AUTHORIZED,
      })
      expect(objects.reads).toEqual([])
    })
  })

  describe("what it accepts", () => {
    it("refuses an id that could not address anything, without asking the store", async () => {
      await kind.seed(objects)

      for (const bad of [
        "",
        "not-hex",
        "0f1e2d3c4b5a697",
        "../../etc/passwd",
      ]) {
        expect(await edit({ postingId: bad, markdown: EDITED })).toEqual({
          ok: false,
          reason: "refused",
          message: BAD_REQUEST,
        })
      }

      // A value the store would refuse cannot name an object, so there is
      // nothing to look up — and asking would fill the log with alarms anyone
      // can trigger from a hand-made POST.
      expect(objects.reads).toEqual([])
    })

    it("tells a missing field apart from an empty one", async () => {
      await kind.seed(objects)

      // No `markdown` at all is a broken request; an empty one is a person who
      // cleared the editor. The feature words only the second.
      expect(await edit({ postingId: POSTING_ID })).toMatchObject({
        reason: "refused",
        message: BAD_REQUEST,
      })
      expect(await edit({ ...VALID, markdown: "   \n\n  " })).toEqual({
        ok: false,
        reason: "empty",
      })
    })

    it("reports the two bounds as reasons, not as sentences", async () => {
      // ⚠️ The point of the union. An empty letter and an empty resume are the
      // same condition told differently, because each names its own document.
      await kind.seed(objects)

      expect(await edit({ ...VALID, markdown: "" })).toEqual({
        ok: false,
        reason: "empty",
      })
      expect(
        await edit({ ...VALID, markdown: "x".repeat(MAX_CHARS + 1) })
      ).toEqual({ ok: false, reason: "too-long" })

      // Neither reached the store: a body that was never going to be stored
      // costs no round trip.
      expect(objects.reads).toEqual([])
    })

    it("measures the bound on the normalized text, not on what was sent", async () => {
      await kind.seed(objects)

      // Twenty `a\r\n` pairs is sixty characters on the wire and thirty-nine
      // once the carriage returns are gone and the trailing newline is trimmed.
      // A caller cannot spend the bound on bytes the store would never see, and
      // a legitimate document is not refused for carrying them.
      const sent = "a\r\n".repeat(20)
      expect(sent.length).toBeGreaterThan(MAX_CHARS)

      expect(await edit({ ...VALID, markdown: sent })).toEqual({ ok: true })
    })
  })

  describe("a document that is not there", () => {
    it("refuses, and writes nothing at all", async () => {
      // Nothing seeded: a caller naming a well-formed Posting id they have
      // never had a document for.
      expect(await edit()).toEqual({ ok: false, reason: "not-found" })

      // ⚠️ The assertion this whole module exists for. Not merely "reported an
      // error" — no object was created, so an action that accepts document text
      // cannot mint one.
      expect(objects.puts).toEqual([])
      expect(objects.keys()).toEqual([])
    })

    it("cannot reach a document of the same Posting belonging to someone else", async () => {
      await kind.seed(objects)

      // Same Posting id, different session. The key is built from the session's
      // user, so this addresses a prefix with nothing in it rather than reaching
      // the document seeded above — the refusal is a consequence of the address,
      // not of a comparison somebody has to remember to write.
      const result = await kind.edit(
        objects,
        { ...SIGNED_IN, userId: OTHER_USER_ID },
        form(VALID)
      )

      expect(result).toEqual({ ok: false, reason: "not-found" })
      expect(objects.keys()).toEqual([EXPECTED_KEY])
    })
  })

  describe("what it writes", () => {
    it("replaces the markdown at the same key", async () => {
      await kind.seed(objects)

      expect(await edit()).toEqual({ ok: true })
      // One object, not two: the key holds the Posting and nothing else, so an
      // edit supersedes rather than accumulates.
      expect(objects.keys()).toEqual([EXPECTED_KEY])

      const stored = await objects.get({
        userId: USER_ID,
        kind: kind.objectKind,
        segments: [POSTING_ID],
        extension: ".md",
      })
      expect(stored.text()).toBe(EDITED)
    })

    it("carries the writing instant and the provenance across untouched", async () => {
      // ⚠️ An edit is not a writing, and this is the assertion the two facades
      // are in the table for: one stamps `drafted-at` and the other
      // `generated-at`, and this module hands back whatever it was given
      // without ever learning which. A save that restamped it would have the
      // page report that the model rewrote the document just now.
      await kind.seed(objects)

      await edit()

      const stored = await objects.head({
        userId: USER_ID,
        kind: kind.objectKind,
        segments: [POSTING_ID],
        extension: ".md",
      })

      expect(stored.metadata[kind.instantKey]).toBe(WRITTEN_AT.toISOString())
      // And the lists render the title and company out of provenance, so
      // dropping it would blank a row down to a hex digest.
      expect(stored.metadata["posting-title"]).toBe(PROVENANCE.title)
      expect(stored.metadata["posting-company"]).toBe(PROVENANCE.company)
      expect(stored.metadata["posting-url"]).toBe(PROVENANCE.url)
      expect(stored.metadata["run-id"]).toBe(RUN_ID)
    })

    it("stores LF line endings whatever was sent", async () => {
      await kind.seed(objects)

      await edit({ ...VALID, markdown: "# Title\r\n\r\nEdited.\r\n" })

      const stored = await objects.get({
        userId: USER_ID,
        kind: kind.objectKind,
        segments: [POSTING_ID],
        extension: ".md",
      })

      // ⚠️ This asserts the *direct-POST* path, not anything a user can do.
      // ProseMirror normalizes CRLF while parsing the clipboard and Turndown
      // emits LF (pinned in the UI package's `markdown.test.ts`), so the editor
      // cannot send CRLF — a hand-made FormData against the action can.
      expect(stored.text()).toBe("# Title\n\nEdited.")
    })

    it("builds the key from the session, ignoring a userId in the form", async () => {
      await kind.seed(objects)

      expect(await edit({ ...VALID, userId: OTHER_USER_ID })).toEqual({
        ok: true,
      })
      // Still the caller's own prefix. Nothing from the form reaches the key.
      expect(objects.keys()).toEqual([EXPECTED_KEY])
    })
  })
})

/**
 * The outage branch, which neither feature suite could reach.
 *
 * `MemoryObjects` answers a missing object with `ObjectNotFoundError`, which is
 * the case both suites already covered. What matters here is the case they did
 * not: a bucket that is unreachable must not be reported as a document the user
 * never wrote. Telling someone their letter is gone during an outage is the one
 * wrong answer available on this path.
 *
 * A hand-made store rather than a facade, because the failure is below the
 * facade and there is nothing kind-specific about it.
 */
describe("when the bucket is unreachable", () => {
  /** The narrow interface, satisfied by hand so a call can be made to throw. */
  class BrokenStore implements EditablePostingDocuments<{
    userId: string
    postingId: string
  }> {
    readonly puts: unknown[] = []

    constructor(
      private readonly failing: "head" | "put",
      private readonly error: unknown = new StorageUnavailableError(
        "the bucket is down"
      )
    ) {}

    async head(ref: { userId: string; postingId: string }) {
      if (this.failing === "head") throw this.error
      return ref
    }

    async put(document: { markdown: string }) {
      this.puts.push(document)
      if (this.failing === "put") throw this.error
      return document
    }
  }

  const edit = (store: BrokenStore) =>
    editPostingDocument(
      { getUser: async () => SIGNED_IN },
      form(VALID),
      store,
      { kind: "cover-letters", maxChars: MAX_CHARS }
    )

  it("says so, rather than reporting the document as missing", async () => {
    const store = new BrokenStore("head")

    const result = await edit(store)

    expect(result).toEqual({
      ok: false,
      reason: "refused",
      message: STORAGE_UNAVAILABLE,
    })
    // Which is what makes it a different answer from "not-found": nothing was
    // written, and the user is not told to draft a document they already have.
    expect(store.puts).toEqual([])
  })

  it("refuses rather than reporting a save that did not happen", async () => {
    const result = await edit(new BrokenStore("put"))

    expect(result).toMatchObject({
      reason: "refused",
      message: STORAGE_UNAVAILABLE,
    })
  })
})
