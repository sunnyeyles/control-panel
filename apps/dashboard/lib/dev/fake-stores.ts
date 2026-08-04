import { devContentType, devCoverLetters, devResumes } from "@/lib/dev/fixtures"
import {
  ObjectNotFoundError,
  type CoverLetterRef,
  type CoverLetterStore,
  type NewCoverLetter,
  type NewResume,
  type ResumeRef,
  type ResumeStore,
  type StoredCoverLetter,
  type StoredResume,
} from "@workspace/user-storage"

/**
 * S3, for `DEV_AUTH_BYPASS=1` only — the two facades the dashboard uses, backed
 * by a `Map` each.
 *
 * These implement the facade interfaces rather than `UserObjectStore`, which is
 * the layer below them. Faking the object store instead would mean
 * reimplementing key building and the ownership assertion in `assertSegment()`
 * — the part of `@workspace/user-storage` most worth not having a second
 * version of. The facades are the seam `lib/storage.ts` already hands out, so
 * they are the seam to stand in for.
 *
 * ⚠️ **`list()` deliberately returns less than `head()` does.** The real stores
 * cannot do otherwise — ListObjectsV2 returns no user metadata at all, so a
 * listed resume has no `originalFilename` and no `documentType`, and a listed
 * letter has an empty `provenance`. A fake that supplied them would make the
 * `head()`-per-item loops in `lib/documents/list-documents.ts` and
 * `lib/cover-letters/list-cover-letters.ts` look like something to delete,
 * right up until the deletion reached production and every row lost its name.
 */

/**
 * Not a real S3 key.
 *
 * The real one is built by `buildObjectKey()` and carries the configured
 * environment prefix, which is read from `USER_STORAGE_BUCKET_NAME` and
 * friends — the variables this mode exists to not need. The key is only ever
 * logged from here, never parsed, so a recognisably fake one is the honest
 * choice: seeing `dev-fixture/` in a log should say immediately that no bucket
 * was involved.
 */
function devKey(kind: string, userId: string, name: string): string {
  return `dev-fixture/${kind}/${userId}/${name}`
}

export function createDevResumeStore(): ResumeStore {
  const stored = new Map<string, StoredResume & { bytes: Uint8Array }>()

  const put = async (resume: NewResume): Promise<StoredResume> => {
    const record = {
      key: devKey(
        "resumes",
        resume.userId,
        `${resume.resumeId}${resume.extension}`
      ),
      userId: resume.userId,
      resumeId: resume.resumeId,
      extension: resume.extension,
      contentType: devContentType("resumes", resume.extension),
      size: resume.bytes.byteLength,
      uploadedAt: new Date(),
      bytes: resume.bytes,
      ...(resume.originalFilename
        ? { originalFilename: resume.originalFilename }
        : {}),
      ...(resume.documentType ? { documentType: resume.documentType } : {}),
    }

    stored.set(refKey(resume), record)

    // `put` returns no bytes, matching the real store.
    return withoutBytes(record)
  }

  for (const resume of devResumes()) void put(resume)

  return {
    put,

    async get(ref: ResumeRef): Promise<StoredResume> {
      return { ...mustGet(stored, ref) }
    },

    async head(ref: ResumeRef): Promise<StoredResume> {
      return withoutBytes(mustGet(stored, ref))
    },

    async delete(ref: ResumeRef): Promise<void> {
      // Idempotent, like a DELETE against S3: removing what is already gone is
      // not an error, and the delete action depends on that.
      stored.delete(refKey(ref))
    },

    async list(userId: string): Promise<StoredResume[]> {
      return [...stored.values()]
        .filter((resume) => resume.userId === userId)
        .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
        .map((resume) => {
          // See the warning above: a listing carries no user metadata, so the
          // name and the type are dropped here on purpose.
          const { bytes, originalFilename, documentType, ...listed } = resume
          void bytes
          void originalFilename
          void documentType
          return listed
        })
    },
  }
}

export function createDevCoverLetterStore(): CoverLetterStore {
  const stored = new Map<string, StoredCoverLetter & { markdown: string }>()

  const put = async (letter: NewCoverLetter): Promise<StoredCoverLetter> => {
    const record = {
      key: devKey(
        "cover-letters",
        letter.userId,
        `${letter.postingId}/letter.md`
      ),
      userId: letter.userId,
      postingId: letter.postingId,
      size: new TextEncoder().encode(letter.markdown).byteLength,
      draftedAt: letter.draftedAt,
      provenance: letter.provenance ?? {},
      markdown: letter.markdown,
    }

    // A redraft supersedes rather than accumulates — same address, one object.
    stored.set(refKey(letter), record)

    return withoutMarkdown(record)
  }

  for (const letter of devCoverLetters()) void put(letter)

  return {
    put,

    async get(ref: CoverLetterRef): Promise<StoredCoverLetter> {
      return { ...mustGet(stored, ref) }
    },

    async head(ref: CoverLetterRef): Promise<StoredCoverLetter> {
      return withoutMarkdown(mustGet(stored, ref))
    },

    async delete(ref: CoverLetterRef): Promise<void> {
      stored.delete(refKey(ref))
    },

    async list(userId: string): Promise<StoredCoverLetter[]> {
      return (
        [...stored.values()]
          .filter((letter) => letter.userId === userId)
          .sort((a, b) => b.draftedAt.getTime() - a.draftedAt.getTime())
          // Empty provenance rather than absent, matching `toStoredCoverLetter` —
          // the field is not optional, and a listing has nothing to put in it.
          .map((letter) => ({ ...withoutMarkdown(letter), provenance: {} }))
      )
    },
  }
}

/** One address, one object — the same rule the real key layout enforces. */
function refKey(ref: ResumeRef | CoverLetterRef): string {
  return "resumeId" in ref
    ? `${ref.userId}/${ref.resumeId}${ref.extension}`
    : `${ref.userId}/${ref.postingId}`
}

/**
 * The same error the real store raises for a missing object, so the call sites
 * that narrow with `isUserStorageError` take the branch they were written for
 * rather than falling through to "something went wrong".
 */
function mustGet<T>(
  stored: Map<string, T>,
  ref: ResumeRef | CoverLetterRef
): T {
  const found = stored.get(refKey(ref))
  if (!found) throw new ObjectNotFoundError(refKey(ref))
  return found
}

/**
 * The stored record minus the payload, which is what `put`, `head` and `list`
 * all return — the bytes and the markdown travel only on a `get`.
 *
 * One per store rather than one generic `omit`: the field being dropped is the
 * only difference, and naming it in the signature is what makes the return type
 * come out as the interface's own `StoredResume` / `StoredCoverLetter` without a
 * cast.
 */
function withoutBytes(
  resume: StoredResume & { bytes: Uint8Array }
): StoredResume {
  const { bytes, ...rest } = resume
  void bytes
  return rest
}

function withoutMarkdown(
  letter: StoredCoverLetter & { markdown: string }
): StoredCoverLetter {
  const { markdown, ...rest } = letter
  void markdown
  return rest
}
