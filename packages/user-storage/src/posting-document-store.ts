import type { ObjectKind } from "./kinds.ts"
import { parseInstant, toMetadataRecord } from "./metadata.ts"
import type { StoredObject, UserObjectStore } from "./user-object-store.ts"

/**
 * The half a **Posting Document** kind shares with every other one.
 *
 * A Cover Letter and a Tailored Resume are addressed, stored and provenanced
 * identically — see **Posting Document** in `CONTEXT.md`. This is that, once;
 * `cover-letter-store.ts` and `tailored-resume-store.ts` stay as the interfaces
 * callers hold.
 *
 * ⚠️ **This is not a kind and there is no `posting-documents/` prefix.** Each
 * facade supplies its own {@link ObjectKind}, so the bucket keeps the two
 * separate — they take different retention rules from Terraform's
 * `object_kinds` map.
 *
 * ⚠️ **Both facades are markdown-only**, so the extension is not a parameter:
 * a non-markdown Posting Document would not share the read path either.
 */

/** Letters and tailored resumes are Markdown and nothing else. */
const EXTENSION = ".md"

/**
 * Provenance, as metadata keys.
 *
 * Lowercase because S3 lowercases metadata names in transit; written from these
 * constants on both sides so the round trip cannot drift.
 */
const RUN_ID = "run-id"
const POSTING_TITLE = "posting-title"
const POSTING_COMPANY = "posting-company"
const POSTING_URL = "posting-url"
/** The Document a resume was rewritten from, by display name. */
const SOURCE_DOCUMENT = "source-document"

/**
 * Addresses one Posting Document.
 *
 * ⚠️ **The unit of identity is (user, Posting), with no Run in it.** The same
 * advertisement found by two Runs a week apart is one document, and
 * `postingId()` in `@workspace/agents` derives from the URL precisely so both
 * Runs agree what to call it. A Run id in the key would orphan the first object
 * on the second click. The Run is still recorded as metadata below.
 */
export interface PostingDocumentRef {
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

/** The Posting a document was written for, as far as provenance is concerned. */
export interface PostingDocumentProvenance {
  /** The Run whose Findings the Posting was read out of, if there was one. */
  runId?: string
  title?: string
  company?: string
  url?: string
  /**
   * Which of the user's Documents it was written from, by display name.
   *
   * ⚠️ **Only a Tailored Resume sets this**, and `CoverLetterProvenance` does
   * not declare it — see the field's own docblock there for why the asymmetry is
   * argued rather than accidental. It is read and written here so that the
   * round trip is stated once; a letter simply never has one, because nothing
   * that writes a letter can supply it.
   */
  sourceDocument?: string
}

/** A document on its way in. */
export interface NewPostingDocument extends PostingDocumentRef {
  /** The document itself. Stored as UTF-8 `text/markdown`. */
  markdown: string
  /**
   * When it was written. Carried into metadata; the key holds no time.
   *
   * Each facade names this after what its kind does — `draftedAt` for a letter,
   * `generatedAt` for a resume — and so does the metadata key it lands under.
   */
  writtenAt: Date
  /**
   * Where it came from.
   *
   * ⚠️ **Every value here is model- or user-supplied text, cleaned before it
   * becomes a header.** `title` and `company` are transcribed out of someone
   * else's advertisement and `sourceDocument` is an uploaded filename, so an em
   * dash or a newline is ordinary — and S3 metadata travels in HTTP headers.
   * {@link toMetadataRecord} strips to printable ASCII and drops the remainder.
   */
  provenance?: PostingDocumentProvenance
}

/** A document that exists in the store. */
export interface StoredPostingDocument extends PostingDocumentRef {
  key: string
  size: number
  writtenAt: Date
  provenance: PostingDocumentProvenance
  /** Present on a read, absent from a metadata-only result. */
  markdown?: string
}

/**
 * The five operations both kinds perform.
 *
 * A facade over {@link UserObjectStore}, like `BriefStore` and `ResumeStore`:
 * it knows the key shape and the single file type so a call site cannot.
 *
 * **A Posting Document has no database row, deliberately.** `artifacts.run_id`
 * is `NOT NULL`, and writing one is not an execution of a briefing job —
 * minting an ad-hoc Run per click would put non-briefings into a job's history.
 * The key is derivable from the user and the Posting, so a row buys no
 * addressability {@link head} does not. Uploaded documents have none for the
 * same reason.
 */
export interface PostingDocumentStore {
  /**
   * Write a document, superseding whatever was at the same address.
   *
   * Re-writing for the same Posting therefore overwrites one object rather than
   * accumulating. The bucket is versioned, so the previous one survives as a
   * non-current version until the noncurrent-expiry rule removes it.
   */
  put(document: NewPostingDocument): Promise<StoredPostingDocument>
  get(ref: PostingDocumentRef): Promise<StoredPostingDocument>
  /** Metadata only — does not transfer the markdown. */
  head(ref: PostingDocumentRef): Promise<StoredPostingDocument>
  delete(ref: PostingDocumentRef): Promise<void>
  /**
   * Every document of this kind one user has, oldest key first.
   *
   * **This is the "which of these have one" question.** Answering it per row
   * with `head()` cost one `HeadObject` per visible posting, re-issued on every
   * sort click and five-second poll. One `ListObjectsV2` answers the whole page,
   * because the last key segment **is** the posting id — and it is O(this
   * user's documents) rather than O(postings on the page).
   *
   * ⚠️ **A listing carries less than `head()`.** `ListObjectsV2` returns no user
   * metadata, so {@link StoredPostingDocument.provenance} comes back empty and
   * `writtenAt` falls back to the object's write time. Enough for existence and
   * "written <when>"; a caller needing the stored title, company or URL must
   * `head()` the one document it cares about. Not for populating a filename.
   */
  list(userId: string): Promise<StoredPostingDocument[]>
}

export interface PostingDocumentStoreOptions {
  /** Which prefix the objects live under. One kind per facade. */
  kind: ObjectKind
  /**
   * The metadata key holding {@link NewPostingDocument.writtenAt}.
   *
   * ⚠️ **The two kinds differ here and must keep differing forever.** A letter's
   * is `drafted-at` and a resume's is `generated-at`, and those names are
   * stamped on objects that already exist. {@link UserObjectStore} deliberately
   * exposes no copy-onto-itself, so there is no migration that would rename them
   * — unifying the key would silently drop the recorded instant on every
   * document written before the change and fall back to its S3 write time.
   */
  instantKey: string
}

export function createPostingDocumentStore(
  objects: UserObjectStore,
  { kind, instantKey }: PostingDocumentStoreOptions
): PostingDocumentStore {
  const refFor = (ref: PostingDocumentRef) => ({
    userId: ref.userId,
    kind,
    segments: [ref.postingId],
    extension: EXTENSION,
  })

  const toStored = (
    userId: string,
    object: StoredObject
  ): StoredPostingDocument => {
    // segments is [postingId] by construction, and parseObjectKey has already
    // validated it.
    const [postingId] = object.segments

    return {
      key: object.key,
      userId,
      postingId: postingId ?? "",
      size: object.size,
      writtenAt: instantFrom(object.metadata, instantKey, object.storedAt),
      provenance: toProvenance(object.metadata),
    }
  }

  return {
    async put(document: NewPostingDocument): Promise<StoredPostingDocument> {
      const stored = await objects.put({
        ...refFor(document),
        body: document.markdown,
        metadata: toMetadataRecord({
          [instantKey]: document.writtenAt.toISOString(),
          [RUN_ID]: document.provenance?.runId,
          [POSTING_TITLE]: document.provenance?.title,
          [POSTING_COMPANY]: document.provenance?.company,
          [POSTING_URL]: document.provenance?.url,
          [SOURCE_DOCUMENT]: document.provenance?.sourceDocument,
        }),
      })

      return {
        key: stored.key,
        userId: document.userId,
        postingId: document.postingId,
        size: stored.size,
        writtenAt: document.writtenAt,
        provenance: toProvenance(stored.metadata),
      }
    },

    async get(ref: PostingDocumentRef): Promise<StoredPostingDocument> {
      const fetched = await objects.get(refFor(ref))

      return {
        ...toStored(ref.userId, fetched),
        markdown: fetched.text(),
      }
    },

    async head(ref: PostingDocumentRef): Promise<StoredPostingDocument> {
      return toStored(ref.userId, await objects.head(refFor(ref)))
    },

    async delete(ref: PostingDocumentRef): Promise<void> {
      await objects.delete(refFor(ref))
    },

    async list(userId: string): Promise<StoredPostingDocument[]> {
      const found = await objects.list(userId, kind)
      return found.map((object) => toStored(userId, object))
    },
  }
}

function toProvenance(
  metadata: Record<string, string>
): PostingDocumentProvenance {
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
 * Metadata holds the writing instant; fall back to the object's own write time
 * when it is absent or unparseable, which is close enough and never missing.
 *
 * The fallback is not the edge case it looks like: {@link
 * PostingDocumentStore.list} reaches this with an empty metadata record for
 * *every* entry, because a listing carries none. `storedAt` is what that whole
 * path renders.
 */
function instantFrom(
  metadata: Record<string, string>,
  instantKey: string,
  storedAt: Date
): Date {
  return parseInstant(metadata[instantKey]) ?? storedAt
}
