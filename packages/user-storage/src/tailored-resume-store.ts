import {
  createPostingDocumentStore,
  type PostingDocumentProvenance,
  type PostingDocumentRef,
  type StoredPostingDocument,
} from "./posting-document-store.ts"
import type { UserObjectStore } from "./user-object-store.ts"

const KIND = "tailored-resumes" as const

/**
 * The metadata key holding the generating instant.
 *
 * ⚠️ **`generated-at`, and a Cover Letter's is `drafted-at`.** The two must keep
 * differing forever, for the reason set out on
 * {@link PostingDocumentStoreOptions.instantKey}: both are stamped on objects
 * that already exist, and nothing can rewrite them.
 */
const GENERATED_AT = "generated-at"

/**
 * Addresses one tailored resume.
 *
 * ⚠️ **The unit of identity is (user, Posting)** — the same as a Cover Letter's,
 * and for the same reason. See {@link PostingDocumentRef}.
 */
export type TailoredResumeRef = PostingDocumentRef

/**
 * The Posting a resume was tailored for, as far as provenance is concerned.
 *
 * ⚠️ **This carries one field a letter's does not: {@link
 * PostingDocumentProvenance.sourceDocument}, and it earns its place.** A letter
 * is written *about* a CV and the reader can see whether it fits. A tailored
 * resume *is* the CV, rewritten — so "which of my three uploads produced this"
 * is the first question anyone asks when the output looks wrong, and the
 * selection rule (`loadCandidateBackground` takes the newest document labelled
 * Resume) means the answer changes silently the moment a new one is uploaded.
 * Without it, the only way to know is to reason about what the shelf looked like
 * at the time.
 */
export type TailoredResumeProvenance = PostingDocumentProvenance

/** A tailored resume on its way in. */
export interface NewTailoredResume extends TailoredResumeRef {
  /** The resume itself. Stored as UTF-8 `text/markdown`. */
  markdown: string
  /** When it was generated. Carried into metadata; the key holds no time. */
  generatedAt: Date
  /**
   * Where it came from. Every value is model- or user-supplied text and is
   * cleaned before it becomes a header — see
   * `NewPostingDocument.provenance` in `posting-document-store.ts`.
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
 * A **Posting Document** kind: everything about how one is addressed, stored and
 * read back is {@link createPostingDocumentStore}'s, and this names the half a
 * tailored resume owns — its kind, its metadata key, and the `sourceDocument`
 * a letter has no use for.
 *
 * **No database row, deliberately**, on the precedent a Cover Letter set; see
 * {@link PostingDocumentStore}.
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
   * This feature had one from the start rather than a per-row `head()`, because
   * building it the letters' way would have doubled a cost
   * `docs/cover-letter-existence-plan.md` had already written down as a problem.
   * A Cover Letter has the same method now, and that plan is what put it there.
   *
   * A listing carries no user metadata; see {@link PostingDocumentStore.list}.
   */
  list(userId: string): Promise<StoredTailoredResume[]>
}

export function createTailoredResumeStore(
  objects: UserObjectStore
): TailoredResumeStore {
  const documents = createPostingDocumentStore(objects, {
    kind: KIND,
    instantKey: GENERATED_AT,
  })

  const toResume = (document: StoredPostingDocument): StoredTailoredResume => {
    const { writtenAt, markdown, ...rest } = document

    return {
      ...rest,
      generatedAt: writtenAt,
      ...(markdown === undefined ? {} : { markdown }),
    }
  }

  return {
    async put(resume: NewTailoredResume): Promise<StoredTailoredResume> {
      const { generatedAt, ...rest } = resume
      return toResume(await documents.put({ ...rest, writtenAt: generatedAt }))
    },

    async get(ref: TailoredResumeRef): Promise<StoredTailoredResume> {
      return toResume(await documents.get(ref))
    },

    async head(ref: TailoredResumeRef): Promise<StoredTailoredResume> {
      return toResume(await documents.head(ref))
    },

    async delete(ref: TailoredResumeRef): Promise<void> {
      await documents.delete(ref)
    },

    async list(userId: string): Promise<StoredTailoredResume[]> {
      return (await documents.list(userId)).map(toResume)
    },
  }
}
