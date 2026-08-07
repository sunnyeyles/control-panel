import { toMetadataRecord } from "./metadata.ts"
import type { StoredObject, UserObjectStore } from "./user-object-store.ts"

/** Tailored resumes are Markdown and nothing else. */
const EXTENSION = ".md"
const KIND = "tailored-resumes" as const

/**
 * Provenance, as metadata keys.
 *
 * Lowercase because S3 lowercases metadata names in transit; written from these
 * constants on both sides so the round trip cannot drift.
 */
const GENERATED_AT = "generated-at"
const RUN_ID = "run-id"
const POSTING_TITLE = "posting-title"
const POSTING_COMPANY = "posting-company"
const POSTING_URL = "posting-url"
/** The Document this was rewritten from, by its display name. */
const SOURCE_DOCUMENT = "source-document"

/**
 * Addresses one tailored resume.
 *
 * ⚠️ **The unit of identity is (user, Posting)** — the same as a Cover
 * Letter's, and for the same reason. `postingId()` in `@workspace/agents` is
 * derived from the advertisement's normalised URL, so two Runs a week apart that
 * find the same job agree on what to call it, and re-generating overwrites one
 * object rather than orphaning the first. There is no Run in the key; the Run
 * that most recently reported the advertisement rides in metadata below.
 */
export interface TailoredResumeRef {
  userId: string
  /**
   * The Posting's derived id — `postingId()` from `@workspace/agents`.
   *
   * That function's output satisfies the key-segment rule in `keys.ts`
   * unmodified, which is why it can be a key segment without escaping.
   */
  postingId: string
}

/** The Posting a resume was tailored for, as far as provenance is concerned. */
export interface TailoredResumeProvenance {
  /** The Run whose Findings the Posting was read out of, if there was one. */
  runId?: string
  title?: string
  company?: string
  url?: string
  /**
   * Which of the user's Documents it was rewritten from, by display name.
   *
   * ⚠️ **This one has no counterpart on a Cover Letter, and it earns its place.**
   * A letter is written *about* a CV and the reader can see whether it fits.
   * A tailored resume *is* the CV, rewritten — so "which of my three uploads
   * produced this" is the first question anyone asks when the output looks
   * wrong, and the selection rule (`loadCandidateBackground` takes the newest
   * document labelled Resume) means the answer changes silently the moment a
   * new one is uploaded. Without this, the only way to know is to reason about
   * what the shelf looked like at the time.
   */
  sourceDocument?: string
}

/** A tailored resume on its way in. */
export interface NewTailoredResume extends TailoredResumeRef {
  /** The resume itself. Stored as UTF-8 `text/markdown`. */
  markdown: string
  /** When it was generated. Carried into metadata; the key holds no time. */
  generatedAt: Date
  /**
   * Where it came from.
   *
   * ⚠️ **Every value here is model- or user-supplied text and is cleaned before
   * it becomes a header.** `title` and `company` are transcribed by the scout out
   * of an advertisement whoever paid for it wrote, and `sourceDocument` is an
   * uploaded filename — so a newline or an em dash in one is ordinary rather than
   * exotic, and S3 user metadata travels in HTTP headers. {@link
   * toMetadataRecord} strips each value to printable ASCII and drops anything
   * that leaves nothing behind.
   */
  provenance?: TailoredResumeProvenance
}

/** A tailored resume that exists in the store. */
export interface StoredTailoredResume extends TailoredResumeRef {
  key: string
  size: number
  generatedAt: Date
  provenance: TailoredResumeProvenance
  /** Present on a read, absent from a metadata-only result. */
  markdown?: string
}

/**
 * Resumes tailored to a Posting.
 *
 * A facade over {@link UserObjectStore}, not a second implementation — the same
 * arrangement as `BriefStore`, `ResumeStore` and `CoverLetterStore`, and for the
 * same reason: it knows this kind's key shape and single file type so a call
 * site cannot get them wrong.
 *
 * **No database row, deliberately**, on the precedent a Cover Letter set:
 * `artifacts.run_id` is `NOT NULL` and references `runs`, and generating a
 * resume is not an execution of a briefing job — minting an ad-hoc Run per click
 * would put rows that are not briefings into a job's history. The key is fully
 * derivable from the user and the Posting, so a row buys no addressability that
 * {@link TailoredResumeStore.head} does not already give.
 */
export interface TailoredResumeStore {
  /**
   * Write a resume, superseding whatever was at the same address.
   *
   * Re-generating for the same Posting therefore overwrites one object rather
   * than accumulating. The bucket is versioned, so the previous one survives as
   * a non-current version until the noncurrent-expiry rule removes it.
   */
  put(resume: NewTailoredResume): Promise<StoredTailoredResume>
  get(ref: TailoredResumeRef): Promise<StoredTailoredResume>
  /** Metadata only — does not transfer the markdown. */
  head(ref: TailoredResumeRef): Promise<StoredTailoredResume>
  delete(ref: TailoredResumeRef): Promise<void>
  /**
   * Every tailored resume one user has.
   *
   * ⚠️ **`CoverLetterStore` has no counterpart to this, and the asymmetry is
   * the point rather than an oversight to even out.**
   * `docs/cover-letter-existence-plan.md` documents what the letters pay for
   * lacking it: rendering "does one exist for this Posting" down a page of
   * twenty-five costs twenty-five `HeadObject` calls, on every render, including
   * the five-second poll a running briefing turns on. That plan's recommended
   * fix is exactly this method, and building the second feature the same way
   * would have doubled a cost already written down as a problem.
   *
   * ⚠️ **A listing carries no user metadata**, because ListObjectsV2 does not
   * return it — so every entry here has an empty {@link
   * StoredTailoredResume.provenance} and a `generatedAt` taken from the object's
   * own write time rather than from the `generated-at` header. That is enough for
   * "exists, and roughly when", which is the whole of what a table column needs;
   * anything that renders provenance must `get()` or `head()` the one object it
   * is actually showing. Do not reach for this to populate a filename.
   */
  list(userId: string): Promise<StoredTailoredResume[]>
}

export function createTailoredResumeStore(
  objects: UserObjectStore
): TailoredResumeStore {
  const refFor = (ref: TailoredResumeRef) => ({
    userId: ref.userId,
    kind: KIND,
    segments: [ref.postingId],
    extension: EXTENSION,
  })

  return {
    async put(resume: NewTailoredResume): Promise<StoredTailoredResume> {
      const stored = await objects.put({
        ...refFor(resume),
        body: resume.markdown,
        metadata: toMetadataRecord({
          [GENERATED_AT]: resume.generatedAt.toISOString(),
          [RUN_ID]: resume.provenance?.runId,
          [POSTING_TITLE]: resume.provenance?.title,
          [POSTING_COMPANY]: resume.provenance?.company,
          [POSTING_URL]: resume.provenance?.url,
          [SOURCE_DOCUMENT]: resume.provenance?.sourceDocument,
        }),
      })

      return {
        key: stored.key,
        userId: resume.userId,
        postingId: resume.postingId,
        size: stored.size,
        generatedAt: resume.generatedAt,
        provenance: toProvenance(stored.metadata),
      }
    },

    async get(ref: TailoredResumeRef): Promise<StoredTailoredResume> {
      const fetched = await objects.get(refFor(ref))

      return {
        ...toStoredTailoredResume(ref.userId, fetched),
        markdown: fetched.text(),
      }
    },

    async head(ref: TailoredResumeRef): Promise<StoredTailoredResume> {
      const stored = await objects.head(refFor(ref))
      return toStoredTailoredResume(ref.userId, stored)
    },

    async delete(ref: TailoredResumeRef): Promise<void> {
      await objects.delete(refFor(ref))
    },

    async list(userId: string): Promise<StoredTailoredResume[]> {
      const listed = await objects.list(userId, KIND)
      return listed.map((object) => toStoredTailoredResume(userId, object))
    },
  }
}

function toStoredTailoredResume(
  userId: string,
  object: StoredObject
): StoredTailoredResume {
  // segments is [postingId] by construction, and parseObjectKey has already
  // validated it.
  const [postingId] = object.segments

  return {
    key: object.key,
    userId,
    postingId: postingId ?? "",
    size: object.size,
    generatedAt: instantFrom(object.metadata, object.storedAt),
    provenance: toProvenance(object.metadata),
  }
}

function toProvenance(
  metadata: Record<string, string>
): TailoredResumeProvenance {
  return {
    ...(metadata[RUN_ID] ? { runId: metadata[RUN_ID] } : {}),
    ...(metadata[POSTING_TITLE] ? { title: metadata[POSTING_TITLE] } : {}),
    ...(metadata[POSTING_COMPANY]
      ? { company: metadata[POSTING_COMPANY] }
      : {}),
    ...(metadata[POSTING_URL] ? { url: metadata[POSTING_URL] } : {}),
    ...(metadata[SOURCE_DOCUMENT]
      ? { sourceDocument: metadata[SOURCE_DOCUMENT] }
      : {}),
  }
}

/**
 * Metadata holds the generating instant; fall back to the object's own write
 * time when it is absent or unparseable, which is close enough and never
 * missing.
 *
 * The fallback is not the edge case it looks like here: {@link
 * TailoredResumeStore.list} reaches this with an empty metadata record for
 * *every* entry, because a listing carries none. `storedAt` is what that whole
 * path renders.
 */
function instantFrom(metadata: Record<string, string>, storedAt: Date): Date {
  const raw = metadata[GENERATED_AT]
  const parsed = raw ? new Date(raw) : undefined

  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : storedAt
}
