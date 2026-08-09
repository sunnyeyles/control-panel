/**
 * The four gates a **Posting Document** passes before an edit overwrites it.
 *
 * ⚠️ **Most of this is about order.** Nothing here would fail if the steps ran
 * in a different sequence and all still ran, so the assertions are on what did
 * *not* happen: no store call for a refused caller, none for a malformed id,
 * none for a body that was never going to be stored, and no write for a
 * document that is not there.
 *
 * **The gates run once and the round trip runs per kind**, which is the split
 * worth keeping: the branch order is one function's and does not vary, while
 * the two facades name their instant differently and this module never learns
 * which name it is holding. Parameterising the gates as well would double
 * thirteen assertions to prove a function it does not branch on.
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
 * advertisement here for `postingId()` to derive one from. The shape is pinned
 * in `posting-document-ref.test.ts`.
 */
const POSTING_ID = "0f1e2d3c4b5a6978"

const ORIGINAL = "# Original\n\nAs it was written."
const EDITED = "# Original\n\nAs the user rewrote it."

/** Small, and this suite's own: the features choose 50,000 each. */
const MAX_CHARS = 40

const PROVENANCE = {
  runId: RUN_ID,
  title: "Backend Engineer",
  company: "Acme",
  url: "https://www.seek.com.au/job/1",
}

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

/**
 * The gates, over one facade.
 *
 * The cover letter's, arbitrarily — none of these reach the store's own
 * behaviour, and the two that do are in the table below.
 */
describe("the gates", () => {
  const seed = () =>
    createCoverLetterStore(objects).put({
      userId: USER_ID,
      postingId: POSTING_ID,
      markdown: ORIGINAL,
      draftedAt: WRITTEN_AT,
      provenance: PROVENANCE,
    })

  const edit = (
    entries: Record<string, string> = VALID,
    user: CurrentUser = SIGNED_IN
  ) =>
    editPostingDocument(
      { getUser: async () => user },
      form(entries),
      createCoverLetterStore(objects),
      { kind: "cover-letters", maxChars: MAX_CHARS }
    )

  it("refuses both kinds of unauthorized caller in the same words, before the store is touched", async () => {
    // ⚠️ `REFUSED` is authenticated by the provider and turned away by
    // `AUTH_ALLOWED_EMAILS`, so it is a real session. Two messages would tell
    // someone outside the list that their sign-in worked.
    await seed()

    for (const caller of [ANONYMOUS, REFUSED]) {
      expect(await edit(VALID, caller)).toEqual({
        ok: false,
        reason: "refused",
        message: NOT_AUTHORIZED,
      })
    }

    // The order, asserted the only way it can be: nothing was looked up, and
    // the seeded document was never written over.
    expect(objects.reads).toEqual([])
    expect(objects.puts).toHaveLength(1)
  })

  it("refuses an id that could not address anything, without asking the store", async () => {
    await seed()

    for (const bad of ["", "not-hex", "0f1e2d3c4b5a697", "../../etc/passwd"]) {
      expect(await edit({ postingId: bad, markdown: EDITED })).toEqual({
        ok: false,
        reason: "refused",
        message: BAD_REQUEST,
      })
    }

    // A value the store would refuse cannot name an object, so there is nothing
    // to look up — and asking would fill the log with alarms anyone can trigger
    // from a hand-made POST.
    expect(objects.reads).toEqual([])
  })

  it("reports the body's three failures as it should, and reaches no store for any", async () => {
    // ⚠️ A missing `markdown` is a broken request and an empty one is a person
    // who cleared the editor — the first is refused with a sentence somebody
    // else owns, the second with a reason the feature words. The two bounds are
    // reasons for the same purpose: an empty letter and an empty resume are one
    // condition told differently.
    await seed()

    expect(await edit({ postingId: POSTING_ID })).toMatchObject({
      reason: "refused",
      message: BAD_REQUEST,
    })
    expect(await edit({ ...VALID, markdown: "   \n\n  " })).toEqual({
      ok: false,
      reason: "empty",
    })
    expect(
      await edit({ ...VALID, markdown: "x".repeat(MAX_CHARS + 1) })
    ).toEqual({ ok: false, reason: "too-long" })

    expect(objects.reads).toEqual([])
  })

  it("measures the bound on the normalized text, not on what was sent", async () => {
    await seed()

    // Twenty `a\r\n` pairs is sixty characters on the wire and thirty-nine once
    // the carriage returns are gone and the trailing newline is trimmed. A
    // caller cannot spend the bound on bytes the store would never see, and a
    // legitimate document is not refused for carrying them.
    const sent = "a\r\n".repeat(20)
    expect(sent.length).toBeGreaterThan(MAX_CHARS)

    expect(await edit({ ...VALID, markdown: sent })).toEqual({ ok: true })
  })

  it("cannot create a document at an address with nothing there", async () => {
    // ⚠️ The assertion this whole module exists for. Not merely "reported an
    // error" — no object was created, so an action that accepts document text
    // cannot mint one.
    expect(await edit()).toEqual({ ok: false, reason: "not-found" })

    expect(objects.puts).toEqual([])
    expect(objects.keys()).toEqual([])
  })
})

/**
 * The store round trip, per kind.
 *
 * ⚠️ **This is what the table is for.** One facade stamps `drafted-at` and the
 * other `generated-at`, they must keep differing forever, and this module hands
 * `head()`'s answer straight back to `put()` without ever learning which it is
 * holding. Nothing but running it through both real facades checks that.
 */
const KINDS: {
  name: string
  objectKind: ObjectKind
  instantKey: string
  extraProvenance?: Record<string, string>
  seed(objects: MemoryObjects): Promise<unknown>
  edit(
    objects: MemoryObjects,
    user: CurrentUser,
    formData: FormData
  ): ReturnType<typeof editPostingDocument>
}[] = [
  {
    name: "cover letter",
    objectKind: "cover-letters",
    instantKey: "drafted-at",
    seed: (objects) =>
      createCoverLetterStore(objects).put({
        userId: USER_ID,
        postingId: POSTING_ID,
        markdown: ORIGINAL,
        draftedAt: WRITTEN_AT,
        provenance: PROVENANCE,
      }),
    edit: (objects, user, formData) =>
      editPostingDocument(
        { getUser: async () => user },
        formData,
        createCoverLetterStore(objects),
        { kind: "cover-letters", maxChars: MAX_CHARS }
      ),
  },
  {
    name: "tailored resume",
    objectKind: "tailored-resumes",
    instantKey: "generated-at",
    // The field a letter's provenance does not declare. It has to survive an
    // edit too, and only this kind can prove it.
    extraProvenance: { "source-document": "alice-cv.md" },
    seed: (objects) =>
      createTailoredResumeStore(objects).put({
        userId: USER_ID,
        postingId: POSTING_ID,
        markdown: ORIGINAL,
        generatedAt: WRITTEN_AT,
        provenance: { ...PROVENANCE, sourceDocument: "alice-cv.md" },
      }),
    edit: (objects, user, formData) =>
      editPostingDocument(
        { getUser: async () => user },
        formData,
        createTailoredResumeStore(objects),
        { kind: "tailored-resumes", maxChars: MAX_CHARS }
      ),
  },
]

describe.each(KINDS)("$name", (kind) => {
  const EXPECTED_KEY = `${ENVIRONMENT}/${USER_ID}/${kind.objectKind}/${POSTING_ID}.md`

  const ref = {
    userId: USER_ID,
    kind: kind.objectKind,
    segments: [POSTING_ID],
    extension: ".md",
  }

  const edit = (entries: Record<string, string> = VALID) =>
    kind.edit(objects, SIGNED_IN, form(entries))

  it("replaces the markdown at the caller's own key, and only there", async () => {
    await kind.seed(objects)

    // A `userId` in the form reaches nothing: the key is built from the session.
    expect(await edit({ ...VALID, userId: OTHER_USER_ID })).toEqual({
      ok: true,
    })

    // One object, not two: the key holds the Posting and nothing else, so an
    // edit supersedes rather than accumulates.
    expect(objects.keys()).toEqual([EXPECTED_KEY])
    expect((await objects.get(ref)).text()).toBe(EDITED)
  })

  it("carries the writing instant and the provenance across untouched", async () => {
    // ⚠️ An edit is not a writing. A save that restamped the instant would have
    // the page report that the model rewrote the document just now, and the
    // lists render title and company out of provenance — dropping it would
    // blank a row down to a hex digest.
    await kind.seed(objects)

    await edit()

    const { metadata } = await objects.head(ref)

    expect(metadata[kind.instantKey]).toBe(WRITTEN_AT.toISOString())
    expect(metadata).toMatchObject({
      "posting-title": PROVENANCE.title,
      "posting-company": PROVENANCE.company,
      "posting-url": PROVENANCE.url,
      "run-id": RUN_ID,
      ...kind.extraProvenance,
    })
  })

  it("stores LF line endings whatever was sent", async () => {
    await kind.seed(objects)

    await edit({ ...VALID, markdown: "# Title\r\n\r\nEdited.\r\n" })

    // ⚠️ The *direct-POST* path, not anything a user can do. ProseMirror
    // normalizes CRLF while parsing the clipboard and Turndown emits LF (pinned
    // in the UI package's `markdown.test.ts`), so the editor cannot send CRLF —
    // a hand-made FormData against the action can.
    expect((await objects.get(ref)).text()).toBe("# Title\n\nEdited.")
  })

  it("cannot reach the same Posting's document under another user", async () => {
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

/**
 * The outage branch, which neither feature suite could reach.
 *
 * `MemoryObjects` answers a missing object with `ObjectNotFoundError`, the case
 * both suites already covered. This is the one they did not: a bucket that is
 * unreachable must not be reported as a document the user never wrote. Telling
 * someone their letter is gone during an outage is the one wrong answer
 * available on this path.
 *
 * A hand-made store rather than a facade, because the failure is below the
 * facade and there is nothing kind-specific about it.
 */
describe("when the bucket is unreachable", () => {
  class BrokenStore implements EditablePostingDocuments<{
    userId: string
    postingId: string
  }> {
    readonly puts: unknown[] = []

    constructor(private readonly failing: "head" | "put") {}

    async head(ref: { userId: string; postingId: string }) {
      if (this.failing === "head") throw new StorageUnavailableError("down")
      return ref
    }

    async put(document: { markdown: string }) {
      this.puts.push(document)
      if (this.failing === "put") throw new StorageUnavailableError("down")
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

    expect(await edit(store)).toEqual({
      ok: false,
      reason: "refused",
      message: STORAGE_UNAVAILABLE,
    })
    // Which is what makes it a different answer from "not-found": nothing was
    // written, and the user is not told to draft a document they already have.
    expect(store.puts).toEqual([])
  })

  it("refuses rather than reporting a save that did not happen", async () => {
    expect(await edit(new BrokenStore("put"))).toMatchObject({
      reason: "refused",
      message: STORAGE_UNAVAILABLE,
    })
  })
})
