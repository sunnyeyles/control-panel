import { beforeEach, describe, expect, it } from "vitest"

import { createBriefStore } from "./brief-store.js"
import { InvalidObjectKeyError } from "./errors.js"
import { acceptedResumeExtensions, createResumeStore } from "./resume-store.js"
import type {
  FetchedObject,
  NewObject,
  ObjectRef,
  StoredObject,
  UserObjectStore,
} from "./user-object-store.js"

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
