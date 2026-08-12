import { InvalidObjectKeyError } from "./errors.ts"
import { extensionsFor } from "./kinds.ts"
import { toMetadataValue } from "./metadata.ts"
import type { StoredObject, UserObjectStore } from "./user-object-store.ts"

const KIND = "resumes" as const

/**
 * ⚠️ **The two metadata names below are written and never read back.**
 *
 * A Document's filename and Document Type live in `documents` in Postgres,
 * which is what the application reads. They are stamped on the object anyway so
 * the bucket stays self-describing — an operator in the console, or a script
 * rebuilding a lost table, has nothing else to go on.
 *
 * Neither is validated against a set, and must not be: `DOCUMENT_TYPES` lives
 * in `@workspace/db`, which is not a dependency of this package.
 */

/** The name the file arrived with. Provenance only. */
const ORIGINAL_FILENAME = "original-filename"

/** What the user said the document is. Provenance only. */
const DOCUMENT_TYPE = "document-type"

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
  /**
   * What the user said this document is, stamped on the object as provenance.
   *
   * A plain `string`, not a union: the set of valid labels is a database
   * concern (`DOCUMENT_TYPES` in `@workspace/db`, plus a CHECK on the column),
   * and this package never reads the value back, so narrowing it here would be
   * a second copy of a list with no way to keep it in step.
   */
  documentType?: string
}

/** A resume that exists in the store. */
export interface StoredResume extends ResumeRef {
  key: string
  contentType: string
  size: number
  uploadedAt: Date
  /**
   * The provenance copy, and not what anything displays — that is
   * `documents.filename` in Postgres, which is not restricted to the printable
   * ASCII a header can carry. Absent on a listed object, always.
   */
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
  /**
   * Every resume belonging to one user.
   *
   * ⚠️ **`originalFilename` is always undefined here** — it is S3 user
   * metadata and ListObjectsV2 does not return it. `key`, `size` and
   * `uploadedAt` are real.
   *
   * **Not how the application lists a user's documents**; that is
   * `listDocuments` in the dashboard, one indexed query over `documents`. This
   * answers the different question of what is actually *in the bucket* — what a
   * reconciliation or a backfill asks.
   */
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
        metadata: {
          ...cleanFilename(resume.originalFilename),
          ...documentTypeMetadata(resume.documentType),
        },
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
    // ⚠️ `list()` supplies `metadata: {}` unconditionally, because
    // ListObjectsV2 does not return user metadata at all, so this is always
    // undefined on a listed object. The document type is not read back here at
    // all — see the note at the top of this file.
    originalFilename: object.metadata[ORIGINAL_FILENAME],
  }
}

/**
 * The label as the object can carry it, or nothing.
 *
 * Cleaned rather than checked against a list, because this package does not
 * hold the list — the database does. `toMetadataValue` is what every other
 * caller-supplied metadata value goes through, and a label is no different: it
 * reaches here from a form field.
 */
function documentTypeMetadata(
  documentType: string | undefined
): Record<string, string> {
  const safe = toMetadataValue(documentType)

  return safe ? { [DOCUMENT_TYPE]: safe } : {}
}

/**
 * S3 user-metadata values travel in HTTP headers, so a raw filename containing
 * a newline is header injection and a non-ASCII one is silently mangled.
 * Strip it to something a header can carry, and keep only the basename so a
 * path never survives into the record.
 *
 * The stripping itself is {@link toMetadataValue}, shared with the cover-letter
 * store rather than restated — the rule is about what a header can carry, which
 * has nothing to do with filenames. What stays here is the part that *is* about
 * filenames: taking the basename, and treating "nothing survived" as an error
 * rather than an absence. A document with no name is a row of raw uuid, and the
 * user has a file in front of them to rename.
 */
function cleanFilename(filename: string | undefined): Record<string, string> {
  if (!filename) return {}

  const basename = filename.split(/[/\\]/).pop() ?? ""
  const safe = toMetadataValue(basename)

  if (!safe) {
    throw new InvalidObjectKeyError(
      `originalFilename ${JSON.stringify(filename)} has no representable characters.`
    )
  }

  return { [ORIGINAL_FILENAME]: safe }
}
