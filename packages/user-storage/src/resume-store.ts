import { InvalidObjectKeyError } from "./errors.ts"
import { extensionsFor } from "./kinds.ts"
import type { StoredObject, UserObjectStore } from "./user-object-store.ts"

const KIND = "resumes" as const

/** The name the file arrived with, kept for display and download only. */
const ORIGINAL_FILENAME = "original-filename"

/** What the user says the document is. Display and filtering only. */
const DOCUMENT_TYPE = "document-type"

/**
 * What a user says an uploaded document is.
 *
 * Deliberately *not* an object kind. A kind is a key segment, an object tag and
 * a file-type allowlist all at once, and its tag is what the S3 lifecycle rules
 * filter on — so a new kind is the only way to give something different
 * retention or different accepted extensions. These five want none of that:
 * they are one shelf of documents with one retention policy, labelled. Adding a
 * kind per label would cost a `kinds.ts` entry, a Terraform `object_kinds`
 * entry (omit it and those objects get *no* retention at all), a facade and an
 * IAM policy each, to buy nothing.
 *
 * So this is metadata, which also means it is **fixed at write time**. S3 user
 * metadata cannot be changed without copying the object onto itself with
 * `MetadataDirective: REPLACE`, and {@link UserObjectStore} deliberately exposes
 * no copy. Re-uploading is the supported way to relabel.
 *
 * `other` is not filler. Without it a document that is none of the first four
 * has to be mislabelled as one of them, and a label nobody trusts is worse than
 * no label.
 */
export const DOCUMENT_TYPES = [
  "resume",
  "cover-letter",
  "portfolio",
  "reference",
  "other",
] as const

export type DocumentType = (typeof DOCUMENT_TYPES)[number]

/**
 * Whether a value is a document type.
 *
 * Used on both sides, and for different reasons. On the way in it validates
 * caller input — a `<select>` value arrives in the same untrusted form data as
 * everything else. On the way out it validates *stored* data, because an object
 * written by an older version of this code, or edited by hand in the console,
 * carries whatever string it carries.
 */
export function isDocumentType(value: unknown): value is DocumentType {
  return (
    typeof value === "string" && DOCUMENT_TYPES.includes(value as DocumentType)
  )
}

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
   * What the user says this document is.
   *
   * Optional, and absent is a legitimate state rather than a defaulted one —
   * every object written before this field existed has no value for it, and a
   * read must be able to say so. Fixed at write time; see {@link DOCUMENT_TYPES}.
   */
  documentType?: DocumentType
}

/** A resume that exists in the store. */
export interface StoredResume extends ResumeRef {
  key: string
  contentType: string
  size: number
  uploadedAt: Date
  originalFilename?: string
  /** Absent on anything written before document types existed. */
  documentType?: DocumentType
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
   * ⚠️ **`originalFilename` and `documentType` are always undefined here.**
   * Both live in S3 user metadata, and ListObjectsV2 does not return it — the
   * underlying store supplies `metadata: {}` for every listed object. `key`,
   * `size` and `uploadedAt` are real.
   *
   * A caller that needs a display name must `head()` each item. That is a
   * deliberate N+1 rather than an oversight: the alternative is either showing
   * raw uuids or keeping a second copy of the metadata in Postgres, and at the
   * scale of one person's documents the extra HeadObject calls are cheaper than
   * either.
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
  const storedType = object.metadata[DOCUMENT_TYPE]

  return {
    key: object.key,
    userId,
    resumeId: resumeId ?? "",
    extension: object.extension,
    contentType: object.contentType,
    size: object.size,
    uploadedAt: extra.uploadedAt,
    originalFilename: object.metadata[ORIGINAL_FILENAME],
    // Validated on the way out, not just on the way in. What is stored is
    // whatever was written — by an older version of this code, or by hand in
    // the console — and an unrecognised label is closer to "unlabelled" than to
    // a fifth category the caller has to defend against.
    //
    // ⚠️ `list()` supplies `metadata: {}` unconditionally, because
    // ListObjectsV2 does not return user metadata at all. Every field read from
    // metadata here — this one and `originalFilename` — is therefore always
    // undefined on a listed object. Recovering either means a `head()` per
    // item; see the note on `list` in the interface below.
    documentType: isDocumentType(storedType) ? storedType : undefined,
  }
}

/**
 * S3 lowercases metadata names in transit but leaves values alone, and every
 * document type is already lowercase ASCII, so no cleaning is needed here —
 * unlike a filename, which arrives from outside. The allowlist is what makes
 * that true, so it is checked rather than assumed.
 */
function documentTypeMetadata(
  documentType: DocumentType | undefined
): Record<string, string> {
  if (!isDocumentType(documentType)) return {}
  return { [DOCUMENT_TYPE]: documentType }
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
