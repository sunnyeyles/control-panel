import { InvalidObjectKeyError } from "./errors.js"
import { extensionsFor } from "./kinds.js"
import type { StoredObject, UserObjectStore } from "./user-object-store.js"

const KIND = "resumes" as const

/** The name the file arrived with, kept for display and download only. */
const ORIGINAL_FILENAME = "original-filename"

/** Addresses one resume. */
export interface ResumeRef {
  userId: string
  /** Stable identifier the application assigns. Not the uploaded filename. */
  resumeId: string
  /** Dot-prefixed, e.g. `.pdf`. Determines the stored media type. */
  extension: string
}

/** A resume on its way in. */
export interface NewResume extends ResumeRef {
  /** The uploaded bytes, stored verbatim. */
  bytes: Uint8Array
  /**
   * The name the file arrived with, if there was one.
   *
   * Recorded as metadata for display, and deliberately *not* used to build the
   * key. An uploaded filename is attacker-controlled text — using it as a path
   * segment is the classic traversal, and using it as an identifier means a
   * user who uploads two files called `cv.pdf` silently overwrites one.
   */
  originalFilename?: string
}

/** A resume that exists in the store. */
export interface StoredResume extends ResumeRef {
  key: string
  contentType: string
  size: number
  uploadedAt: Date
  originalFilename?: string
  /** Present on a read, absent from a `put` or `list` result. */
  bytes?: Uint8Array
}

/**
 * Documents the user uploaded — CVs and the like.
 *
 * A facade over {@link UserObjectStore}, not a second implementation. Unlike
 * briefs these are opaque binary, arrive from outside, and are replaced rather
 * than regenerated — so the key carries no date and the extension is chosen
 * from an allowlist per upload.
 */
export interface ResumeStore {
  put(resume: NewResume): Promise<StoredResume>
  get(ref: ResumeRef): Promise<StoredResume>
  /** Metadata only — does not transfer the bytes. */
  head(ref: ResumeRef): Promise<StoredResume>
  delete(ref: ResumeRef): Promise<void>
  list(userId: string): Promise<StoredResume[]>
}

/** The file types a resume may be uploaded as. */
export function acceptedResumeExtensions(): string[] {
  return extensionsFor(KIND)
}

export function createResumeStore(objects: UserObjectStore): ResumeStore {
  const refFor = (ref: ResumeRef) => ({
    userId: ref.userId,
    kind: KIND,
    segments: [ref.resumeId],
    extension: ref.extension,
  })

  return {
    async put(resume: NewResume): Promise<StoredResume> {
      const stored = await objects.put({
        ...refFor(resume),
        body: resume.bytes,
        metadata: cleanFilename(resume.originalFilename),
      })

      return toStoredResume(resume.userId, stored, {
        uploadedAt: stored.storedAt,
      })
    },

    async get(ref: ResumeRef): Promise<StoredResume> {
      const fetched = await objects.get(refFor(ref))

      return {
        ...toStoredResume(ref.userId, fetched, {
          uploadedAt: fetched.storedAt,
        }),
        bytes: fetched.body,
      }
    },

    async head(ref: ResumeRef): Promise<StoredResume> {
      const stored = await objects.head(refFor(ref))
      return toStoredResume(ref.userId, stored, { uploadedAt: stored.storedAt })
    },

    async delete(ref: ResumeRef): Promise<void> {
      await objects.delete(refFor(ref))
    },

    async list(userId: string): Promise<StoredResume[]> {
      const found = await objects.list(userId, KIND)

      return found.map((object) =>
        toStoredResume(userId, object, { uploadedAt: object.storedAt })
      )
    },
  }
}

function toStoredResume(
  userId: string,
  object: StoredObject,
  extra: { uploadedAt: Date }
): StoredResume {
  const [resumeId] = object.segments

  return {
    key: object.key,
    userId,
    resumeId: resumeId ?? "",
    extension: object.extension,
    contentType: object.contentType,
    size: object.size,
    uploadedAt: extra.uploadedAt,
    originalFilename: object.metadata[ORIGINAL_FILENAME],
  }
}

/**
 * S3 user-metadata values travel in HTTP headers, so a raw filename containing
 * a newline is header injection and a non-ASCII one is silently mangled.
 * Strip it to something a header can carry, and keep only the basename so a
 * path never survives into the record.
 */
function cleanFilename(filename: string | undefined): Record<string, string> {
  if (!filename) return {}

  const basename = filename.split(/[/\\]/).pop() ?? ""
  const safe = basename.replace(/[^\x20-\x7E]/g, "").slice(0, 255)

  if (!safe.trim()) {
    throw new InvalidObjectKeyError(
      `originalFilename ${JSON.stringify(filename)} has no representable characters.`
    )
  }

  return { [ORIGINAL_FILENAME]: safe.trim() }
}
