import { beforeEach, describe, expect, it } from "vitest"

import { InvalidObjectKeyError } from "./errors.ts"
import { MemoryObjectStore } from "./memory-object-store.ts"
import { acceptedResumeExtensions, createResumeStore } from "./resume-store.ts"
import type { UserObjectStore } from "./user-object-store.ts"

/**
 * The facade is tested against the interface rather than against S3, which is
 * the whole point of the seam: no AWS SDK is involved below this line. The
 * store is the shared `MemoryObjectStore` — real key building, real error types
 * — so a key-layout change fails here rather than agreeing with itself.
 */

let objects: MemoryObjectStore

beforeEach(() => {
  objects = new MemoryObjectStore()
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
