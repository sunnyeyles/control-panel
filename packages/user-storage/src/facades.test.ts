import { beforeEach, describe, expect, it } from "vitest"

import { createBriefStore } from "./brief-store.ts"
import {
  createCoverLetterStore,
  type CoverLetterProvenance,
} from "./cover-letter-store.ts"
import { InvalidObjectKeyError } from "./errors.ts"
import type { PostingDocumentRef } from "./posting-document-store.ts"
import { acceptedResumeExtensions, createResumeStore } from "./resume-store.ts"
import { createTailoredResumeStore } from "./tailored-resume-store.ts"
import type {
  FetchedObject,
  NewObject,
  ObjectRef,
  StoredObject,
  UserObjectStore,
} from "./user-object-store.ts"

/**
 * An in-memory {@link UserObjectStore}.
 *
 * The facades are tested against the interface rather than against S3, which
 * is the whole point of the seam: no AWS SDK is involved below this line.
 */
class MemoryObjectStore implements UserObjectStore {
  readonly puts: NewObject[] = []
  private readonly objects = new Map<string, StoredObject & { body: Buffer }>()

  private keyOf(ref: ObjectRef): string {
    return `${ref.userId}/${ref.kind}/${ref.segments.join("/")}${ref.extension}`
  }

  async put(object: NewObject): Promise<StoredObject> {
    this.puts.push(object)

    const body =
      typeof object.body === "string"
        ? Buffer.from(object.body, "utf8")
        : Buffer.from(object.body)

    const stored = {
      key: this.keyOf(object),
      environment: "test",
      userId: object.userId,
      kind: object.kind,
      segments: object.segments,
      extension: object.extension,
      contentType: "application/octet-stream",
      size: body.byteLength,
      storedAt: new Date("2026-07-28T09:00:00.000Z"),
      metadata: object.metadata ?? {},
      body,
    }

    this.objects.set(stored.key, stored)
    return stored
  }

  async get(ref: ObjectRef): Promise<FetchedObject> {
    const found = this.objects.get(this.keyOf(ref))
    if (!found) throw new Error(`not stored: ${this.keyOf(ref)}`)

    return {
      ...found,
      body: found.body,
      text: () => found.body.toString("utf8"),
    }
  }

  async head(ref: ObjectRef): Promise<StoredObject> {
    const found = this.objects.get(this.keyOf(ref))
    if (!found) throw new Error(`not stored: ${this.keyOf(ref)}`)
    return found
  }

  async delete(ref: ObjectRef): Promise<void> {
    this.objects.delete(this.keyOf(ref))
  }

  async list(userId: string, kind: ObjectRef["kind"]): Promise<StoredObject[]> {
    return [...this.objects.values()]
      .filter((o) => o.userId === userId && o.kind === kind)
      .sort((a, b) => a.key.localeCompare(b.key))
  }
}

let objects: MemoryObjectStore

beforeEach(() => {
  objects = new MemoryObjectStore()
})

describe("BriefStore", () => {
  const OCCURRENCE = new Date("2026-07-28T09:00:00.000Z")
  const GENERATED_AT = new Date("2026-07-28T09:00:41.000Z")

  it("date-partitions the key and fixes the extension", async () => {
    const briefs = createBriefStore(objects)

    await briefs.put({
      userId: "alice",
      briefId: "morning",
      occurrence: OCCURRENCE,
      generatedAt: GENERATED_AT,
      markdown: "# Hello",
    })

    const [put] = objects.puts
    expect(put?.kind).toBe("briefs")
    expect(put?.segments).toEqual(["2026", "07", "28", "morning"])
    expect(put?.extension).toBe(".md")
  })

  it("derives the key date in UTC", async () => {
    const briefs = createBriefStore(objects)

    // 22:30 UTC is already tomorrow in Sydney. The key must not depend on
    // where the worker runs.
    await briefs.put({
      userId: "alice",
      briefId: "evening",
      occurrence: new Date("2026-07-28T22:30:00.000Z"),
      generatedAt: new Date("2026-07-28T22:30:00.000Z"),
      markdown: "# Hello",
    })

    expect(objects.puts[0]?.segments).toEqual(["2026", "07", "28", "evening"])
  })

  it("partitions on the occurrence, not on when the run finished", async () => {
    const briefs = createBriefStore(objects)

    // The failure this separation exists to prevent: a 23:30 slot that takes
    // forty minutes finishes on the 29th. Partitioning on the finish time would
    // file it under a day the run row disagrees with, so "which day is this
    // brief for" would have two answers.
    const stored = await briefs.put({
      userId: "alice",
      briefId: "late",
      occurrence: new Date("2026-07-28T23:30:00.000Z"),
      generatedAt: new Date("2026-07-29T00:10:00.000Z"),
      markdown: "# Hello",
    })

    expect(objects.puts[0]?.segments).toEqual(["2026", "07", "28", "late"])
    expect(stored.partitionOn).toBe("2026-07-28")
    // The true instant is not lost; it just lives in metadata now.
    expect(objects.puts[0]?.metadata?.["generated-at"]).toBe(
      "2026-07-29T00:10:00.000Z"
    )
  })

  it("files a 09:00 Sydney occurrence under the previous UTC day", async () => {
    const briefs = createBriefStore(objects)

    // Pinned because it looks like a bug and is the specified behaviour. 09:00
    // in Sydney is 23:00 UTC the day before, and the key is a storage
    // partition rather than a date display — a key stays interpretable without
    // its job row, and the dashboard renders dates from `runs.scheduled_for`.
    await briefs.put({
      userId: "alice",
      briefId: "sydney-morning",
      occurrence: new Date("2026-07-28T23:00:00.000Z"),
      generatedAt: new Date("2026-07-28T23:00:12.000Z"),
      markdown: "# Hello",
    })

    expect(objects.puts[0]?.segments).toEqual([
      "2026",
      "07",
      "28",
      "sydney-morning",
    ])
  })

  it("keeps the full instant in metadata though the key holds only the day", async () => {
    const briefs = createBriefStore(objects)
    const precise = new Date("2026-07-28T23:47:11.123Z")

    await briefs.put({
      userId: "alice",
      briefId: "morning",
      occurrence: OCCURRENCE,
      generatedAt: precise,
      markdown: "# Hello",
    })

    expect(objects.puts[0]?.metadata?.["generated-at"]).toBe(
      precise.toISOString()
    )
  })

  it("round-trips Markdown", async () => {
    const briefs = createBriefStore(objects)
    const markdown = "# Brief — café 日本語 🎉"

    await briefs.put({
      userId: "alice",
      briefId: "morning",
      occurrence: OCCURRENCE,
      generatedAt: GENERATED_AT,
      markdown,
    })

    const read = await briefs.get({
      userId: "alice",
      partitionOn: "2026-07-28",
      briefId: "morning",
    })

    expect(read.markdown).toBe(markdown)
    expect(read.generatedAt.toISOString()).toBe(GENERATED_AT.toISOString())
  })

  it("lists a user's briefs chronologically, because the key sorts", async () => {
    const briefs = createBriefStore(objects)

    for (const [occurrence, briefId] of [
      ["2026-07-28T09:00:00.000Z", "c"],
      ["2026-01-02T09:00:00.000Z", "a"],
      ["2026-03-15T09:00:00.000Z", "b"],
    ] as const) {
      await briefs.put({
        userId: "alice",
        briefId,
        occurrence: new Date(occurrence),
        generatedAt: new Date(occurrence),
        markdown: "x",
      })
    }

    const listed = await briefs.list("alice")
    expect(listed.map((b) => b.briefId)).toEqual(["a", "b", "c"])
    expect(listed.map((b) => b.partitionOn)).toEqual([
      "2026-01-02",
      "2026-03-15",
      "2026-07-28",
    ])
  })

  it("rejects an impossible date before touching the store", async () => {
    const briefs = createBriefStore(objects)

    await expect(
      briefs.get({
        userId: "alice",
        partitionOn: "2026-02-31",
        briefId: "morning",
      })
    ).rejects.toThrow(InvalidObjectKeyError)
  })
})

/**
 * The two **Posting Document** kinds, driven through one table.
 *
 * ⚠️ **`describe.each` rather than two suites, because the two stores are one
 * store.** Everything below — the flat Posting key, the overwrite, the metadata
 * round trip, what a listing does and does not carry — is
 * `createPostingDocumentStore`'s behaviour, and asserting it twice would mean
 * two sets of assertions that could come to disagree about a single
 * implementation. What each kind genuinely owns is in {@link KINDS}: its
 * prefix, and the metadata key its instant lands under.
 *
 * The adapters exist because the two facades name their instant differently on
 * purpose — `draftedAt` reads right for a letter and `generatedAt` for a resume
 * — so the table speaks the core's `writtenAt` and each adapter translates. That
 * translation is itself worth exercising: it is the only code the facades add.
 */
interface DocumentInput {
  userId: string
  postingId: string
  markdown: string
  writtenAt: Date
  provenance?: CoverLetterProvenance
}

interface DocumentKind {
  /** The kind's name, for the test titles. */
  name: string
  /** The bucket prefix. The two must not be the same. */
  kind: string
  /** The metadata key its instant lands under. */
  instantKey: string
  create(objects: UserObjectStore): {
    put(input: DocumentInput): Promise<{ key: string }>
    get(ref: PostingDocumentRef): Promise<{
      markdown?: string | undefined
      writtenAt: Date
    }>
    head(ref: PostingDocumentRef): Promise<{
      provenance: CoverLetterProvenance
    }>
    list(userId: string): Promise<
      {
        postingId: string
        provenance: CoverLetterProvenance
        writtenAt: Date
      }[]
    >
  }
}

const KINDS: DocumentKind[] = [
  {
    name: "CoverLetterStore",
    kind: "cover-letters",
    instantKey: "drafted-at",
    create(objects) {
      const letters = createCoverLetterStore(objects)

      return {
        put: ({ writtenAt, ...rest }) =>
          letters.put({ ...rest, draftedAt: writtenAt }),
        get: async (ref) => {
          const letter = await letters.get(ref)
          return { markdown: letter.markdown, writtenAt: letter.draftedAt }
        },
        head: (ref) => letters.head(ref),
        list: async (userId) =>
          (await letters.list(userId)).map((letter) => ({
            postingId: letter.postingId,
            provenance: letter.provenance,
            writtenAt: letter.draftedAt,
          })),
      }
    },
  },
  {
    name: "TailoredResumeStore",
    kind: "tailored-resumes",
    instantKey: "generated-at",
    create(objects) {
      const resumes = createTailoredResumeStore(objects)

      return {
        put: ({ writtenAt, ...rest }) =>
          resumes.put({ ...rest, generatedAt: writtenAt }),
        get: async (ref) => {
          const resume = await resumes.get(ref)
          return { markdown: resume.markdown, writtenAt: resume.generatedAt }
        },
        head: (ref) => resumes.head(ref),
        list: async (userId) =>
          (await resumes.list(userId)).map((resume) => ({
            postingId: resume.postingId,
            provenance: resume.provenance,
            writtenAt: resume.generatedAt,
          })),
      }
    },
  },
]

const POSTING_ID = "0f1e2d3c4b5a6978"
const WRITTEN_AT = new Date("2026-08-03T04:15:00.000Z")

/**
 * The memory store narrowed to what `ListObjectsV2` actually returns.
 *
 * Delegating method by method rather than spreading the instance: the methods
 * live on the prototype, so a spread would silently drop them.
 */
function listsWithoutMetadata(objects: UserObjectStore): UserObjectStore {
  return {
    put: (object) => objects.put(object),
    get: (ref) => objects.get(ref),
    head: (ref) => objects.head(ref),
    delete: (ref) => objects.delete(ref),
    list: async (userId, kind) =>
      (await objects.list(userId, kind)).map((object) => ({
        ...object,
        metadata: {},
      })),
  }
}

describe.each(KINDS)("$name", (subject) => {
  it("keys flat on the Posting id, under its own kind", async () => {
    const store = subject.create(objects)

    await store.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "x",
      writtenAt: WRITTEN_AT,
    })

    const [put] = objects.puts
    expect(put?.kind).toBe(subject.kind)
    expect(put?.segments).toEqual([POSTING_ID])
    expect(put?.extension).toBe(".md")
  })

  it("overwrites one object when the same Posting is written again", async () => {
    // The whole reason the Run is not in the key: two clicks a week apart find
    // the same advertisement, and the second must supersede the first rather
    // than orphan it.
    const store = subject.create(objects)

    const first = await store.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "First",
      writtenAt: WRITTEN_AT,
      provenance: { runId: "run-1" },
    })
    const second = await store.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "Second",
      writtenAt: new Date("2026-08-10T04:15:00.000Z"),
      provenance: { runId: "run-2" },
    })

    expect(second.key).toBe(first.key)
    expect(
      (await store.get({ userId: "alice", postingId: POSTING_ID })).markdown
    ).toBe("Second")
  })

  it("round-trips the markdown and the instant it was written", async () => {
    const store = subject.create(objects)
    const markdown = "Dear Hiring Team — café 日本語 🎉\n\n[start date]"

    await store.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown,
      writtenAt: WRITTEN_AT,
    })

    const read = await store.get({ userId: "alice", postingId: POSTING_ID })

    expect(read.markdown).toBe(markdown)
    expect(read.writtenAt.toISOString()).toBe(WRITTEN_AT.toISOString())
  })

  describe("list", () => {
    it("answers which Postings have one, in a single request", async () => {
      // The reason this method exists. The postings table asks it once per page
      // render; it used to ask `head()` once per visible Posting, twenty-five at
      // a time. The posting id is the last key segment, so the set of written
      // ids falls straight out of the listing.
      const store = subject.create(objects)
      const other = "1122334455667788"

      for (const postingId of [POSTING_ID, other]) {
        await store.put({
          userId: "alice",
          postingId,
          markdown: "x",
          writtenAt: WRITTEN_AT,
        })
      }

      const listed = await store.list("alice")

      expect(listed.map((entry) => entry.postingId).sort()).toEqual(
        [POSTING_ID, other].sort()
      )
    })

    it("does not return another user's", async () => {
      const store = subject.create(objects)

      await store.put({
        userId: "bob",
        postingId: POSTING_ID,
        markdown: "x",
        writtenAt: WRITTEN_AT,
      })

      expect(await store.list("alice")).toEqual([])
    })

    it("carries no provenance, and dates each entry by the object's write time", async () => {
      // ⚠️ The documented limitation, asserted so it stays documented. The
      // memory store returns what was written, metadata included, and the real
      // store hardcodes `metadata: {}` in `list()` — so narrowing the fake is
      // what makes this about S3 rather than about the fake. A caller that
      // rendered a filename or a company off `list()` would render blanks, and
      // would do it only in production.
      const store = subject.create(listsWithoutMetadata(objects))

      await store.put({
        userId: "alice",
        postingId: POSTING_ID,
        markdown: "x",
        writtenAt: WRITTEN_AT,
        provenance: { title: "Backend Engineer", company: "Acme" },
      })

      const [listed] = await store.list("alice")

      expect(listed?.postingId).toBe(POSTING_ID)
      expect(listed?.provenance).toEqual({})
      // Degrades to the object's write time rather than going missing, because
      // the instant travels in the metadata that is gone with the rest.
      expect(listed?.writtenAt.toISOString()).toBe("2026-07-28T09:00:00.000Z")

      // And `head()` still has all of it, which is what a caller that needs the
      // title has to use.
      const headed = await store.head({
        userId: "alice",
        postingId: POSTING_ID,
      })
      expect(headed.provenance.title).toBe("Backend Engineer")
    })
  })

  describe("provenance metadata", () => {
    it("carries the Run and the Posting rather than putting them in the key", async () => {
      const store = subject.create(objects)

      await store.put({
        userId: "alice",
        postingId: POSTING_ID,
        markdown: "x",
        writtenAt: WRITTEN_AT,
        provenance: {
          runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          title: "Backend Engineer",
          company: "Acme",
          url: "https://www.seek.com.au/job/1",
        },
      })

      expect(objects.puts[0]?.metadata).toEqual({
        // ⚠️ The one metadata key the two kinds differ by, and they must keep
        // differing: both are stamped on objects that already exist, and
        // `UserObjectStore` has no copy-onto-itself to rename them with.
        [subject.instantKey]: WRITTEN_AT.toISOString(),
        "run-id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "posting-title": "Backend Engineer",
        "posting-company": "Acme",
        "posting-url": "https://www.seek.com.au/job/1",
      })
      expect(objects.puts[0]?.segments).toEqual([POSTING_ID])
    })

    it("strips characters an HTTP header cannot carry", async () => {
      // ⚠️ Not a formality. Title and company are text the scout transcribed out
      // of an advertisement someone else wrote, and S3 user metadata travels in
      // HTTP headers — a newline here is header injection.
      const store = subject.create(objects)

      await store.put({
        userId: "alice",
        postingId: POSTING_ID,
        markdown: "x",
        writtenAt: WRITTEN_AT,
        provenance: {
          title: "Senior Engineer\r\nX-Injected: yes",
          company: "Café Ünicode — Pty Ltd",
        },
      })

      const metadata = objects.puts[0]?.metadata ?? {}
      expect(metadata["posting-title"]).toBe("Senior EngineerX-Injected: yes")
      expect(metadata["posting-title"]).not.toContain("\r")
      expect(metadata["posting-title"]).not.toContain("\n")
      expect(metadata["posting-company"]).toBe("Caf nicode  Pty Ltd")
    })

    it("drops a value with nothing representable left rather than writing a blank", async () => {
      // Unlike a filename, which is raised on: a document whose company name is
      // entirely non-ASCII is still a document, and an empty metadata field
      // would claim the company is blank rather than unknown.
      const store = subject.create(objects)

      await store.put({
        userId: "alice",
        postingId: POSTING_ID,
        markdown: "x",
        writtenAt: WRITTEN_AT,
        provenance: { company: "日本語" },
      })

      expect(objects.puts[0]?.metadata).toEqual({
        [subject.instantKey]: WRITTEN_AT.toISOString(),
      })
    })
  })
})

/**
 * What only one kind does, and the one thing that needs both.
 *
 * Everything here is a decision `CONTEXT.md` argues for rather than a gap in the
 * table above: the source document is a field a letter deliberately has no use
 * for, and the collision test is about the two kinds *not* being one.
 */
describe("what the two kinds do not share", () => {
  const POSTING_ID = "0f1e2d3c4b5a6978"
  const GENERATED_AT = new Date("2026-08-06T04:15:00.000Z")

  it("keeps a letter and a resume for the same Posting apart", async () => {
    // The two share a Posting id, so they would collide if either wrote under
    // the other's prefix. Asserted rather than assumed: the whole reason a
    // tailored resume is not a sixth Document Type is that it lives somewhere
    // else — and it is the property the shared core could most plausibly break.
    const letters = createCoverLetterStore(objects)
    const resumes = createTailoredResumeStore(objects)

    await letters.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "Dear Hiring Team",
      draftedAt: GENERATED_AT,
    })
    await resumes.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "# Alice",
      generatedAt: GENERATED_AT,
    })

    expect(
      (await letters.get({ userId: "alice", postingId: POSTING_ID })).markdown
    ).toBe("Dear Hiring Team")
    expect(
      (await resumes.get({ userId: "alice", postingId: POSTING_ID })).markdown
    ).toBe("# Alice")
  })

  it("records which Document a resume was rewritten from", async () => {
    // A letter has no counterpart: it is written *about* a CV and the reader can
    // see whether it fits, while a resume *is* the CV and the selection rule
    // takes the newest upload labelled Resume — so which one produced this
    // changes silently and is worth stamping.
    const resumes = createTailoredResumeStore(objects)

    await resumes.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "x",
      generatedAt: GENERATED_AT,
      provenance: { sourceDocument: "alice-cv-2026.pdf" },
    })

    expect(objects.puts[0]?.metadata?.["source-document"]).toBe(
      "alice-cv-2026.pdf"
    )

    const read = await resumes.head({ userId: "alice", postingId: POSTING_ID })
    expect(read.provenance.sourceDocument).toBe("alice-cv-2026.pdf")
  })

  it("strips characters an HTTP header cannot carry from the source filename", async () => {
    // The source document is an uploaded filename, so it is the value most
    // likely to carry something a header cannot. Same treatment as a title and
    // company, from the same module — the point of `toMetadataRecord` is that no
    // call site writes its own regex.
    const resumes = createTailoredResumeStore(objects)

    await resumes.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "x",
      generatedAt: GENERATED_AT,
      provenance: { sourceDocument: "cv\r\nX-Injected: yes.pdf" },
    })

    const metadata = objects.puts[0]?.metadata ?? {}
    expect(metadata["source-document"]).toBe("cvX-Injected: yes.pdf")
    expect(metadata["source-document"]).not.toContain("\n")
  })
})

describe("ResumeStore", () => {
  const BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0xff, 0xfe])

  it("uses a flat key with no date, since a resume is replaced not regenerated", async () => {
    const resumes = createResumeStore(objects)

    await resumes.put({
      userId: "alice",
      resumeId: "backend-2026",
      extension: ".pdf",
      bytes: BYTES,
    })

    const [put] = objects.puts
    expect(put?.kind).toBe("resumes")
    expect(put?.segments).toEqual(["backend-2026"])
  })

  it("round-trips bytes that are not valid UTF-8", async () => {
    const resumes = createResumeStore(objects)

    await resumes.put({
      userId: "alice",
      resumeId: "backend-2026",
      extension: ".pdf",
      bytes: BYTES,
    })

    const read = await resumes.get({
      userId: "alice",
      resumeId: "backend-2026",
      extension: ".pdf",
    })

    expect(read.bytes && Uint8Array.from(read.bytes)).toEqual(BYTES)
  })

  it("exposes the accepted file types for an upload form", () => {
    expect(acceptedResumeExtensions()).toContain(".pdf")
    expect(acceptedResumeExtensions()).toContain(".docx")
    expect(acceptedResumeExtensions()).not.toContain(".html")
  })

  describe("the uploaded filename", () => {
    it("is recorded as metadata, never as a key segment", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "backend-2026",
        extension: ".pdf",
        bytes: BYTES,
        originalFilename: "My CV (final).pdf",
      })

      const [put] = objects.puts
      expect(put?.metadata?.["original-filename"]).toBe("My CV (final).pdf")
      // The key comes from resumeId alone. An uploaded filename is
      // attacker-controlled text; using it as a path segment is the classic
      // traversal.
      expect(put?.segments).toEqual(["backend-2026"])
    })

    it("keeps only the basename, so a path never survives", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        originalFilename: "../../etc/passwd.pdf",
      })

      expect(objects.puts[0]?.metadata?.["original-filename"]).toBe(
        "passwd.pdf"
      )
    })

    it("strips characters an HTTP header cannot carry", async () => {
      const resumes = createResumeStore(objects)

      // S3 user-metadata travels in headers, so a raw newline here is header
      // injection and a non-ASCII character is silently mangled.
      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        originalFilename: "cv\r\nX-Injected: yesé.pdf",
      })

      const stored = objects.puts[0]?.metadata?.["original-filename"]
      expect(stored).toBe("cvX-Injected: yes.pdf")
      expect(stored).not.toContain("\n")
      expect(stored).not.toContain("\r")
    })

    it("rejects a filename with nothing representable left", async () => {
      const resumes = createResumeStore(objects)

      await expect(
        resumes.put({
          userId: "alice",
          resumeId: "r",
          extension: ".pdf",
          bytes: BYTES,
          originalFilename: "日本語",
        })
      ).rejects.toThrow(InvalidObjectKeyError)
    })

    it("is simply absent when none was given", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
      })

      expect(objects.puts[0]?.metadata).toEqual({})
    })
  })

  describe("the document type", () => {
    it("is stamped on the object alongside the filename", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        originalFilename: "cover.pdf",
        documentType: "cover-letter",
      })

      // Both fields, so the filename passthrough is not quietly replaced by
      // the type one — they are merged into a single metadata map.
      expect(objects.puts[0]?.metadata).toEqual({
        "original-filename": "cover.pdf",
        "document-type": "cover-letter",
      })
    })

    it("is left off entirely when none was given", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
      })

      // A present-but-empty metadata field says "we know this and it is
      // blank", which is a different and false claim.
      expect(objects.puts[0]?.metadata).toEqual({})
    })

    it("is stamped even when it is not a type this application offers", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        documentType: "curriculum-vitae",
      })

      // ⚠️ This package deliberately holds no allowlist. The set of valid
      // Document Types is `DOCUMENT_TYPES` in `@workspace/db` and a CHECK on
      // `documents.doc_type`, which is the gate an upload actually passes
      // through; a second copy here would be one more thing to keep in step and
      // would refuse a label the database had just accepted.
      expect(objects.puts[0]?.metadata).toEqual({
        "document-type": "curriculum-vitae",
      })
    })

    it("is cleaned like every other metadata value", async () => {
      const resumes = createResumeStore(objects)

      // It reaches here from a form field, so it is caller input, so it goes
      // through `toMetadataValue` — a newline in a metadata value is header
      // injection whatever the field is called.
      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        documentType: "resume\r\nx-injected: yes",
      })

      expect(objects.puts[0]?.metadata).toEqual({
        "document-type": "resumex-injected: yes",
      })
    })

    it("is not read back onto the stored resume", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        documentType: "resume",
      })

      const read = await resumes.head({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
      })

      // ⚠️ The whole point of the move to Postgres. What is on the object is
      // provenance — recoverable, and out of date the moment the row is
      // relabelled. Reading it back here is how the two would silently
      // disagree, so this store does not offer the value at all.
      expect(read).not.toHaveProperty("documentType")
    })

    it("uses a metadata key the object store does not reserve", async () => {
      // The reason the type can be metadata at all. `assertCustomMetadata` in
      // the S3 store throws on `user-id`, `kind` or `environment`, so a facade
      // writing one of those would fail every upload — and `user-id` is the
      // ownership boundary, so shadowing it is the failure worth naming.
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        documentType: "portfolio",
      })

      expect(Object.keys(objects.puts[0]?.metadata ?? {})).not.toContain(
        "user-id"
      )
      expect(Object.keys(objects.puts[0]?.metadata ?? {})).not.toContain("kind")
      expect(Object.keys(objects.puts[0]?.metadata ?? {})).not.toContain(
        "environment"
      )
    })

    it("does not survive a listing, because ListObjectsV2 carries no metadata", async () => {
      // `MemoryObjectStore` keeps metadata on a listed object; the real store
      // cannot, and hardcodes `metadata: {}` in `list()` because ListObjectsV2
      // does not return user metadata at all. Narrowing the fake to match is
      // what makes this test about S3's behaviour rather than the fake's.
      const listsWithoutMetadata: UserObjectStore = {
        ...objects,
        put: (object) => objects.put(object),
        get: (ref) => objects.get(ref),
        head: (ref) => objects.head(ref),
        delete: (ref) => objects.delete(ref),
        list: async (userId, kind) =>
          (await objects.list(userId, kind)).map((object) => ({
            ...object,
            metadata: {},
          })),
      }

      const resumes = createResumeStore(listsWithoutMetadata)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        originalFilename: "cv.pdf",
        documentType: "resume",
      })

      const [listed] = await resumes.list("alice")

      // The trap this pins, and the reason `listDocuments` reads Postgres
      // rather than this: the filename is undefined from a listing even though
      // the object plainly has it, so a list view built on this call needs a
      // `head()` per item to show anything but a raw uuid.
      expect(listed?.resumeId).toBe("r")
      expect(listed?.size).toBe(BYTES.byteLength)
      expect(listed?.originalFilename).toBeUndefined()

      const headed = await resumes.head({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
      })
      expect(headed.originalFilename).toBe("cv.pdf")
    })
  })
})

describe("the two facades share one store", () => {
  it("so a user's briefs and resumes live under one prefix", async () => {
    const briefs = createBriefStore(objects)
    const resumes = createResumeStore(objects)

    await briefs.put({
      userId: "alice",
      briefId: "morning",
      occurrence: new Date("2026-07-28T09:00:00.000Z"),
      generatedAt: new Date("2026-07-28T09:00:00.000Z"),
      markdown: "x",
    })
    await resumes.put({
      userId: "alice",
      resumeId: "backend",
      extension: ".pdf",
      bytes: new Uint8Array([1]),
    })

    // Ownership, key validation and error mapping happen once, underneath —
    // not twice, which is where a divergence would become a security bug.
    expect(objects.puts.every((p) => p.userId === "alice")).toBe(true)
    expect(objects.puts.map((p) => p.kind)).toEqual(["briefs", "resumes"])
  })

  it("and listing one kind never returns the other", async () => {
    const briefs = createBriefStore(objects)
    const resumes = createResumeStore(objects)

    await briefs.put({
      userId: "alice",
      briefId: "morning",
      occurrence: new Date("2026-07-28T09:00:00.000Z"),
      generatedAt: new Date("2026-07-28T09:00:00.000Z"),
      markdown: "x",
    })
    await resumes.put({
      userId: "alice",
      resumeId: "backend",
      extension: ".pdf",
      bytes: new Uint8Array([1]),
    })

    expect(await briefs.list("alice")).toHaveLength(1)
    expect(await resumes.list("alice")).toHaveLength(1)
  })
})
