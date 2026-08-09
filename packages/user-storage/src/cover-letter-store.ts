import {
  createPostingDocumentStore,
  type PostingDocumentProvenance,
  type PostingDocumentRef,
  type StoredPostingDocument,
} from "./posting-document-store.ts"
import type { UserObjectStore } from "./user-object-store.ts"

const KIND = "cover-letters" as const

/**
 * The metadata key holding the drafting instant.
 *
 * ⚠️ **`drafted-at`, and a Tailored Resume's is `generated-at`.** The two must
 * keep differing forever: both are stamped on objects that already exist and
 * `UserObjectStore` exposes no copy-onto-itself, so unifying them would silently
 * drop the recorded instant on every letter drafted before the change. See
 * {@link PostingDocumentStoreOptions.instantKey}.
 */
const DRAFTED_AT = "drafted-at"

/**
 * Addresses one cover letter.
 *
 * ⚠️ **The unit of identity is (user, Posting), and there is no Run in it** —
 * see {@link PostingDocumentRef}, which says why, and which a Tailored Resume's
 * ref is the same shape of for the same reason.
 */
export type CoverLetterRef = PostingDocumentRef

/**
 * The Posting a letter was drafted for, as far as provenance is concerned.
 *
 * ⚠️ **No `sourceDocument`, unlike a Tailored Resume's.** A letter is written
 * *about* a CV and a reader can see whether it fits; a tailored resume *is* the
 * CV, so which upload produced it is the first question anyone asks. Omitting
 * the field here rather than leaving it optional-and-unset is what makes that a
 * decision rather than an oversight — nothing that drafts a letter can supply
 * one.
 */
export type CoverLetterProvenance = Omit<
  PostingDocumentProvenance,
  "sourceDocument"
>

/** A letter on its way in. */
export interface NewCoverLetter extends CoverLetterRef {
  /** The letter itself. Stored as UTF-8 `text/markdown`. */
  markdown: string
  /** When it was drafted. Carried into metadata; the key holds no time. */
  draftedAt: Date
  /**
   * Where it came from. Every value is model-copied text and is cleaned before
   * it becomes a header — see `NewPostingDocument.provenance` in
   * `posting-document-store.ts`.
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
 * A **Posting Document** kind: everything about how one is addressed, stored and
 * read back is {@link createPostingDocumentStore}'s, and this names the half a
 * letter owns — its kind, its metadata key, and the fact that it has no
 * `sourceDocument`.
 *
 * **A letter has no database row, deliberately**; the reasoning is on
 * {@link PostingDocumentStore}, which a Tailored Resume follows too.
 */
export interface CoverLetterStore {
  /**
   * Draft a letter, superseding whatever was at the same address.
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
  /**
   * Every letter a user has, oldest key first.
   *
   * **This method is why the facade has a `list` at all, and it was won rather
   * than assumed.** `docs/cover-letter-existence-plan.md` recorded what the
   * per-row `head()` cost — twenty-five `HeadObject` calls per render, re-issued
   * on every sort click and every five-second poll of a running briefing — and
   * this is that plan's recommended fix. The Tailored Resume was built with one
   * from the start because building the second feature the letters' way would
   * have doubled a number already written down as a problem.
   *
   * A listing carries no user metadata; see {@link PostingDocumentStore.list}.
   */
  list(userId: string): Promise<StoredCoverLetter[]>
}

export function createCoverLetterStore(
  objects: UserObjectStore
): CoverLetterStore {
  const documents = createPostingDocumentStore(objects, {
    kind: KIND,
    instantKey: DRAFTED_AT,
  })

  const toLetter = (document: StoredPostingDocument): StoredCoverLetter => {
    const { writtenAt, markdown, ...rest } = document

    return {
      ...rest,
      draftedAt: writtenAt,
      ...(markdown === undefined ? {} : { markdown }),
    }
  }

  return {
    async put(letter: NewCoverLetter): Promise<StoredCoverLetter> {
      const { draftedAt, ...rest } = letter
      return toLetter(await documents.put({ ...rest, writtenAt: draftedAt }))
    },

    async get(ref: CoverLetterRef): Promise<StoredCoverLetter> {
      return toLetter(await documents.get(ref))
    },

    async head(ref: CoverLetterRef): Promise<StoredCoverLetter> {
      return toLetter(await documents.head(ref))
    },

    async delete(ref: CoverLetterRef): Promise<void> {
      await documents.delete(ref)
    },

    async list(userId: string): Promise<StoredCoverLetter[]> {
      return (await documents.list(userId)).map(toLetter)
    },
  }
}
