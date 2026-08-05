import { toMetadataRecord } from "./metadata.ts"
import type { StoredObject, UserObjectStore } from "./user-object-store.ts"

/** Letters are Markdown and nothing else. */
const EXTENSION = ".md"
const KIND = "cover-letters" as const

/**
 * Provenance, as metadata keys.
 *
 * Lowercase because S3 lowercases metadata names in transit; written from these
 * constants on both sides so the round trip cannot drift.
 */
const DRAFTED_AT = "drafted-at"
const RUN_ID = "run-id"
const POSTING_TITLE = "posting-title"
const POSTING_COMPANY = "posting-company"
const POSTING_URL = "posting-url"

/**
 * Addresses one cover letter.
 *
 * ⚠️ **The unit of identity is (user, Posting), and there is no Run in it.**
 * The same advertisement found by two Runs a week apart is one thing a person
 * wants one letter for, and `postingId()` in `@workspace/agents` is derived
 * from the Posting's URL precisely so both Runs agree on what to call it. A Run
 * id in the key would mean a second click produced a second object, with the
 * first one orphaned and nothing pointing at it.
 *
 * The Run is still recorded — as metadata, below — because "which Run found
 * this" is worth knowing and is not worth an extra object.
 */
export interface CoverLetterRef {
  userId: string
  /**
   * The Posting's derived id — `postingId()` from `@workspace/agents`.
   *
   * That function's output satisfies the key-segment rule in `keys.ts`
   * unmodified, which is why it can be a key segment without escaping. It is
   * asserted there against this package's own predicate rather than restated.
   */
  postingId: string
}

/** The Posting a letter was drafted for, as far as provenance is concerned. */
export interface CoverLetterProvenance {
  /** The Run whose Findings the Posting was read out of, if there was one. */
  runId?: string
  title?: string
  company?: string
  url?: string
}

/** A letter on its way in. */
export interface NewCoverLetter extends CoverLetterRef {
  /** The letter itself. Stored as UTF-8 `text/markdown`. */
  markdown: string
  /** When it was drafted. Carried into metadata; the key holds no time. */
  draftedAt: Date
  /**
   * Where it came from.
   *
   * ⚠️ **Every value here is model-copied text and is cleaned before it becomes
   * a header.** `title` and `company` are transcribed by the scout out of an
   * advertisement whoever paid for it wrote, so a newline or an em dash in one
   * is ordinary rather than exotic — and S3 user metadata travels in HTTP
   * headers. {@link toMetadataRecord} strips each value to printable ASCII and
   * drops anything that leaves nothing behind. That is the same treatment an
   * uploaded filename gets in `resume-store.ts`, from the same module.
   */
  provenance?: CoverLetterProvenance
}

/** A letter that exists in the store. */
export interface StoredCoverLetter extends CoverLetterRef {
  key: string
  size: number
  draftedAt: Date
  provenance: CoverLetterProvenance
  /** Present on a read, absent from a metadata-only result. */
  markdown?: string
}

/**
 * Cover letters drafted for a Posting.
 *
 * A facade over {@link UserObjectStore}, not a second implementation — the same
 * arrangement as `BriefStore` and `ResumeStore`, and for the same reason: it
 * knows this kind's key shape and single file type so a call site cannot get
 * them wrong.
 *
 * **A letter has no database row, deliberately.** `artifacts.run_id` is
 * `NOT NULL` and references `runs`, and drafting is not an execution of a
 * briefing job — minting an ad-hoc Run per click would put rows that are not
 * briefings into a job's history. The key is fully derivable from the user and
 * the Posting, so a row buys no addressability that `head()` does not already
 * give. Uploaded documents have no row for exactly this reason.
 */
export interface CoverLetterStore {
  /**
   * Write a letter, superseding whatever was at the same address.
   *
   * Re-drafting the same Posting therefore overwrites one object rather than
   * accumulating. The bucket is versioned, so the previous draft survives as a
   * non-current version until the noncurrent-expiry rule removes it.
   */
  put(letter: NewCoverLetter): Promise<StoredCoverLetter>
  get(ref: CoverLetterRef): Promise<StoredCoverLetter>
  /** Metadata only — does not transfer the markdown. */
  head(ref: CoverLetterRef): Promise<StoredCoverLetter>
  delete(ref: CoverLetterRef): Promise<void>
}

export function createCoverLetterStore(
  objects: UserObjectStore
): CoverLetterStore {
  const refFor = (ref: CoverLetterRef) => ({
    userId: ref.userId,
    kind: KIND,
    segments: [ref.postingId],
    extension: EXTENSION,
  })

  return {
    async put(letter: NewCoverLetter): Promise<StoredCoverLetter> {
      const stored = await objects.put({
        ...refFor(letter),
        body: letter.markdown,
        metadata: toMetadataRecord({
          [DRAFTED_AT]: letter.draftedAt.toISOString(),
          [RUN_ID]: letter.provenance?.runId,
          [POSTING_TITLE]: letter.provenance?.title,
          [POSTING_COMPANY]: letter.provenance?.company,
          [POSTING_URL]: letter.provenance?.url,
        }),
      })

      return {
        key: stored.key,
        userId: letter.userId,
        postingId: letter.postingId,
        size: stored.size,
        draftedAt: letter.draftedAt,
        provenance: toProvenance(stored.metadata),
      }
    },

    async get(ref: CoverLetterRef): Promise<StoredCoverLetter> {
      const fetched = await objects.get(refFor(ref))

      return {
        ...toStoredCoverLetter(ref.userId, fetched),
        markdown: fetched.text(),
      }
    },

    async head(ref: CoverLetterRef): Promise<StoredCoverLetter> {
      const stored = await objects.head(refFor(ref))
      return toStoredCoverLetter(ref.userId, stored)
    },

    async delete(ref: CoverLetterRef): Promise<void> {
      await objects.delete(refFor(ref))
    },
  }
}

function toStoredCoverLetter(
  userId: string,
  object: StoredObject
): StoredCoverLetter {
  // segments is [postingId] by construction, and parseObjectKey has already
  // validated it.
  const [postingId] = object.segments

  return {
    key: object.key,
    userId,
    postingId: postingId ?? "",
    size: object.size,
    draftedAt: instantFrom(object.metadata, object.storedAt),
    provenance: toProvenance(object.metadata),
  }
}

function toProvenance(metadata: Record<string, string>): CoverLetterProvenance {
  return {
    ...(metadata[RUN_ID] ? { runId: metadata[RUN_ID] } : {}),
    ...(metadata[POSTING_TITLE] ? { title: metadata[POSTING_TITLE] } : {}),
    ...(metadata[POSTING_COMPANY]
      ? { company: metadata[POSTING_COMPANY] }
      : {}),
    ...(metadata[POSTING_URL] ? { url: metadata[POSTING_URL] } : {}),
  }
}

/**
 * Metadata holds the drafting instant; fall back to the object's own write time
 * when it is absent or unparseable, which is close enough and never missing.
 */
function instantFrom(metadata: Record<string, string>, storedAt: Date): Date {
  const raw = metadata[DRAFTED_AT]
  const parsed = raw ? new Date(raw) : undefined

  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : storedAt
}
