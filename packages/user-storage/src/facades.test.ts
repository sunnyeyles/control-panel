import { beforeEach, describe, expect, it } from "vitest"

import { createBriefStore } from "./brief-store.ts"
import { createCoverLetterStore } from "./cover-letter-store.ts"
import { InvalidObjectKeyError } from "./errors.ts"
import {
  acceptedResumeExtensions,
  createResumeStore,
  type DocumentType,
} from "./resume-store.ts"
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

describe("CoverLetterStore", () => {
  const DRAFTED_AT = new Date("2026-08-03T04:15:00.000Z")
  const POSTING_ID = "0f1e2d3c4b5a6978"

  it("keys flat on the Posting id, with no Run and no date in it", async () => {
    const letters = createCoverLetterStore(objects)

    await letters.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "Dear Hiring Team",
      draftedAt: DRAFTED_AT,
      provenance: { runId: "run-1" },
    })

    const [put] = objects.puts
    expect(put?.kind).toBe("cover-letters")
    expect(put?.segments).toEqual([POSTING_ID])
    expect(put?.extension).toBe(".md")
  })

  it("overwrites one object when the same Posting is redrafted", async () => {
    const letters = createCoverLetterStore(objects)

    // The whole reason the Run is not in the key: two clicks a week apart find
    // the same advertisement, and the second must supersede the first rather
    // than orphan it.
    const first = await letters.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "First draft",
      draftedAt: DRAFTED_AT,
      provenance: { runId: "run-1" },
    })

    const second = await letters.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown: "Second draft",
      draftedAt: new Date("2026-08-10T04:15:00.000Z"),
      provenance: { runId: "run-2" },
    })

    expect(second.key).toBe(first.key)
    expect(
      (await letters.get({ userId: "alice", postingId: POSTING_ID })).markdown
    ).toBe("Second draft")
  })

  it("round-trips the markdown and the drafting instant", async () => {
    const letters = createCoverLetterStore(objects)
    const markdown = "Dear Hiring Team — café 日本語 🎉\n\n[start date]"

    await letters.put({
      userId: "alice",
      postingId: POSTING_ID,
      markdown,
      draftedAt: DRAFTED_AT,
    })

    const read = await letters.get({ userId: "alice", postingId: POSTING_ID })

    expect(read.markdown).toBe(markdown)
    expect(read.draftedAt.toISOString()).toBe(DRAFTED_AT.toISOString())
  })

  describe("list", () => {
    it("answers which Postings have a letter in one request", async () => {
      // The reason this method exists. The postings table asks it once per page
      // render; it used to ask `head()` once per visible Posting, twenty-five
      // at a time. The posting id is the last key segment, so the set of
      // drafted ids falls straight out of the listing.
      const letters = createCoverLetterStore(objects)
      const other = "aaaaaaaaaaaaaaaa"

      for (const postingId of [POSTING_ID, other]) {
        await letters.put({
          userId: "alice",
          postingId,
          markdown: "Dear Hiring Team",
          draftedAt: DRAFTED_AT,
        })
      }

      await letters.put({
        userId: "bob",
        postingId: POSTING_ID,
        markdown: "Not alice's",
        draftedAt: DRAFTED_AT,
      })

      const listed = await letters.list("alice")

      expect(listed.map((letter) => letter.postingId).sort()).toEqual(
        [POSTING_ID, other].sort()
      )
    })

    it("carries no provenance, because ListObjectsV2 returns no metadata", async () => {
      // The same trap the resume suite pins below: `MemoryObjectStore` keeps
      // metadata on a listed object and the real store hardcodes `metadata: {}`
      // in `list()`. Narrowing the fake is what makes this about S3 rather than
      // about the fake — and it is why `posting-detail.tsx` derives a letter's
      // display name and filename from the Posting instead of from the letter.
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

      const letters = createCoverLetterStore(listsWithoutMetadata)

      await letters.put({
        userId: "alice",
        postingId: POSTING_ID,
        markdown: "Dear Hiring Team",
        draftedAt: DRAFTED_AT,
        provenance: { title: "Backend Engineer", company: "Acme" },
      })

      const [listed] = await letters.list("alice")

      expect(listed?.postingId).toBe(POSTING_ID)
      expect(listed?.provenance).toEqual({})

      // And `draftedAt` degrades to the object's write time rather than going
      // missing, because the `drafted-at` metadata is gone with the rest.
      expect(listed?.draftedAt).toBeInstanceOf(Date)

      const headed = await letters.head({
        userId: "alice",
        postingId: POSTING_ID,
      })
      expect(headed.provenance.title).toBe("Backend Engineer")
    })
  })

  describe("provenance metadata", () => {
    it("carries the Run and the Posting rather than putting them in the key", async () => {
      const letters = createCoverLetterStore(objects)

      await letters.put({
        userId: "alice",
        postingId: POSTING_ID,
        markdown: "x",
        draftedAt: DRAFTED_AT,
        provenance: {
          runId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          title: "Backend Engineer",
          company: "Acme",
          url: "https://www.seek.com.au/job/1",
        },
      })

      expect(objects.puts[0]?.metadata).toEqual({
        "drafted-at": DRAFTED_AT.toISOString(),
        "run-id": "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        "posting-title": "Backend Engineer",
        "posting-company": "Acme",
        "posting-url": "https://www.seek.com.au/job/1",
      })
      expect(objects.puts[0]?.segments).toEqual([POSTING_ID])
    })

    it("strips characters an HTTP header cannot carry", async () => {
      const letters = createCoverLetterStore(objects)

      // ⚠️ Not a formality. Title and company are text the scout transcribed
      // out of an advertisement someone else wrote, and S3 user metadata
      // travels in HTTP headers — a newline here is header injection.
      await letters.put({
        userId: "alice",
        postingId: POSTING_ID,
        markdown: "x",
        draftedAt: DRAFTED_AT,
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
      const letters = createCoverLetterStore(objects)

      // Unlike a filename, which is raised on: a letter whose company name is
      // entirely non-ASCII is still a letter, and an empty metadata field
      // would claim the company is blank rather than unknown.
      await letters.put({
        userId: "alice",
        postingId: POSTING_ID,
        markdown: "x",
        draftedAt: DRAFTED_AT,
        provenance: { company: "日本語" },
      })

      expect(objects.puts[0]?.metadata).toEqual({
        "drafted-at": DRAFTED_AT.toISOString(),
      })
    })
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
    it("round-trips through metadata alongside the filename", async () => {
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

      const read = await resumes.head({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
      })
      expect(read.documentType).toBe("cover-letter")
      expect(read.originalFilename).toBe("cover.pdf")
    })

    it("is absent rather than defaulted when none was given", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
      })

      // Nothing uploaded before this field existed carries it, so "unlabelled"
      // has to be representable. Defaulting to `resume` here would invent a
      // claim the user never made.
      expect(objects.puts[0]?.metadata).toEqual({})

      const read = await resumes.head({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
      })
      expect(read.documentType).toBeUndefined()
    })

    it("is dropped on the way in when it is not on the allowlist", async () => {
      const resumes = createResumeStore(objects)

      await resumes.put({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
        bytes: BYTES,
        // Reachable despite the type: this value crosses a form boundary
        // before it gets here.
        documentType: "curriculum-vitae" as DocumentType,
      })

      expect(objects.puts[0]?.metadata).toEqual({})
    })

    it("reads back as undefined when the stored value is unrecognised", async () => {
      const resumes = createResumeStore(objects)

      // An object written by an older version of this code, or edited by hand
      // in the S3 console. Validating only on the way in would let it out.
      await objects.put({
        userId: "alice",
        kind: "resumes",
        segments: ["r"],
        extension: ".pdf",
        body: BYTES,
        metadata: { "document-type": "something-else" },
      })

      const read = await resumes.head({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
      })
      expect(read.documentType).toBeUndefined()
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

      // The trap this pins: both fields read as undefined from a listing even
      // though the object plainly has them. A list view that shows a filename
      // must `head()` each item.
      expect(listed?.resumeId).toBe("r")
      expect(listed?.size).toBe(BYTES.byteLength)
      expect(listed?.documentType).toBeUndefined()
      expect(listed?.originalFilename).toBeUndefined()

      const headed = await resumes.head({
        userId: "alice",
        resumeId: "r",
        extension: ".pdf",
      })
      expect(headed.documentType).toBe("resume")
      expect(headed.originalFilename).toBe("cv.pdf")
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
