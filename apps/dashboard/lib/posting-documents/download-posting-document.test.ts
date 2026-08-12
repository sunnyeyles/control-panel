/**
 * Fetching one **Posting Document** for download, tested once for both kinds.
 *
 * Every branch these two suites exercised belongs to `downloadPostingDocument`,
 * which neither feature adds to beyond a kind and a label. The gates and the
 * error mapping run once; the table below runs the two feature delegations
 * through the **real** facades over an in-memory store, which is what proves
 * each kind's key, label and instant survive the round trip.
 *
 * ⚠️ The caller supplies the Posting id and nothing else — the `userId` segment
 * of the key comes from the session at the call site, so a request naming
 * another user's document cannot be spelled.
 */

import {
  ObjectOwnershipError,
  StorageUnavailableError,
} from "@workspace/user-storage/errors"
import { createCoverLetterStore } from "@workspace/user-storage/cover-letter-store"
import { createTailoredResumeStore } from "@workspace/user-storage/tailored-resume-store"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { downloadCoverLetter } from "@/lib/cover-letters/download-cover-letter"
import { downloadTailoredResume } from "@/lib/tailored-resumes/download-tailored-resume"
import { OTHER_USER_ID, USER_ID } from "@/lib/test-support/identities"
import { MemoryObjects } from "@/lib/test-support/memory-objects"
import {
  downloadPostingDocument,
  type DownloadablePostingDocuments,
} from "./download-posting-document"

const NOW = new Date("2026-08-01T04:15:00.000Z")

const POSTING_ID = "0f1e2d3c4b5a6978"

const MARKDOWN = "# For this Posting\n\nAs the model wrote it."

let objects: MemoryObjects

beforeEach(() => {
  objects = new MemoryObjects(NOW)
  vi.spyOn(console, "error").mockImplementation(() => {})
})

/**
 * A hand-made store rather than a facade, for the branches below the facade:
 * it records every ask, so "the store was never touched" is assertable, and it
 * throws whatever a test hands it.
 */
class FakeDocuments implements DownloadablePostingDocuments {
  readonly asked: { userId: string; postingId: string }[] = []

  constructor(
    private readonly answer: () => Promise<{
      key: string
      markdown?: string | undefined
      provenance: { title?: string; company?: string }
    }>
  ) {}

  async get(ref: { userId: string; postingId: string }) {
    this.asked.push(ref)
    return this.answer()
  }
}

const download = (documents: DownloadablePostingDocuments, id = POSTING_ID) =>
  downloadPostingDocument(USER_ID, id, documents, {
    kind: "cover-letters",
    label: "Cover letter",
  })

describe("the gates and the error mapping", () => {
  it("answers not-found rather than failed for a malformed id, without touching the store", async () => {
    const store = new FakeDocuments(async () => {
      throw new Error("must not be reached")
    })

    // A path traversal, an uppercase digest, a short digest, a uuid, an empty
    // segment. None can name an object, and a 500 for any of them would report
    // a malformed URL as a server fault and fill the log with alarms anyone can
    // trigger from the address bar.
    for (const bad of [
      "../../etc/passwd",
      "0F1E2D3C4B5A6978",
      "0f1e2d3c4b5a697",
      USER_ID,
      "",
    ]) {
      expect(await download(store, bad)).toEqual({ status: "not-found" })
    }

    expect(store.asked).toEqual([])
  })

  it("conflates a storage ownership failure with not-found", async () => {
    // Deliberate: distinguishing them would say whether another user's document
    // exists to someone who may not read it.
    const store = new FakeDocuments(async () => {
      throw new ObjectOwnershipError(
        `prod/${OTHER_USER_ID}/cover-letters/${POSTING_ID}.md`,
        USER_ID,
        OTHER_USER_ID
      )
    })

    expect(await download(store)).toEqual({ status: "not-found" })
  })

  it("reports a storage outage as a failure rather than as a missing document", async () => {
    // The one that must *not* be conflated: an outage reported as "not found"
    // would tell someone their document is gone.
    const store = new FakeDocuments(async () => {
      throw new StorageUnavailableError("AccessDenied")
    })

    expect(await download(store)).toEqual({ status: "failed" })
  })

  it("refuses to hand back an empty file as a successful download", async () => {
    const store = new FakeDocuments(async () => ({
      key: `test/${USER_ID}/cover-letters/${POSTING_ID}.md`,
      markdown: undefined,
      provenance: {},
    }))

    expect(await download(store)).toEqual({ status: "failed" })
  })
})

/**
 * The round trip, per kind, through each feature's own delegation — which is
 * why there is no separate suite for the two five-line feature modules. What
 * genuinely varies is the facade, the label, and the instant the facade stamps.
 */
const KINDS = [
  {
    name: "cover letter",
    label: "Cover letter",
    download: downloadCoverLetter,
    seed: (userId: string, markdown: string, provenance = {}) =>
      createCoverLetterStore(objects).put({
        userId,
        postingId: POSTING_ID,
        markdown,
        draftedAt: NOW,
        provenance,
      }),
    store: () => createCoverLetterStore(objects),
  },
  {
    name: "tailored resume",
    label: "Tailored resume",
    download: downloadTailoredResume,
    seed: (userId: string, markdown: string, provenance = {}) =>
      createTailoredResumeStore(objects).put({
        userId,
        postingId: POSTING_ID,
        markdown,
        generatedAt: NOW,
        provenance,
      }),
    store: () => createTailoredResumeStore(objects),
  },
] as const

describe.each(KINDS)("$name", (kind) => {
  const fetch = (userId = USER_ID) =>
    // The union of the two facades, and each row pairs its own — the `as never`
    // is only TypeScript unable to correlate the table's columns.
    kind.download(userId, POSTING_ID, kind.store() as never)

  it("returns the markdown, named with its own label", async () => {
    await kind.seed(USER_ID, MARKDOWN, {
      title: "Backend Engineer",
      company: "Acme",
    })

    expect(await fetch()).toEqual({
      status: "ok",
      markdown: MARKDOWN,
      filename: `${kind.label} - Backend Engineer - Acme.md`,
    })
  })

  it("falls back to the Posting id when provenance recorded nothing", async () => {
    await kind.seed(USER_ID, MARKDOWN)

    expect(await fetch()).toMatchObject({
      filename: `${kind.label} - ${POSTING_ID}.md`,
    })
  })

  it("reaches only the caller's own document at a shared Posting id", async () => {
    // The same id, written by both users. The only thing separating the two
    // objects is the key segment built from the session's user — so ownership
    // is a consequence of the address, not of a comparison.
    await kind.seed(USER_ID, "Mine")
    await kind.seed(OTHER_USER_ID, "Not mine")

    expect(await fetch()).toMatchObject({ markdown: "Mine" })
    expect(await fetch(OTHER_USER_ID)).toMatchObject({ markdown: "Not mine" })
  })

  it("is not found when the caller has nothing at a Posting someone else wrote for", async () => {
    await kind.seed(OTHER_USER_ID, "Not mine")

    // Not "forbidden", and not the other user's bytes: the caller's prefix
    // simply holds nothing at that address.
    expect(await fetch()).toEqual({ status: "not-found" })
  })
})
