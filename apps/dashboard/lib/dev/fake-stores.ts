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
 * by a `Map` each. Faked at the facade rather than at `UserObjectStore` below
 * it, so key building and `assertSegment()` keep their single implementation.
 *
 * ⚠️ **`list()` deliberately returns less than `head()` does**, because
 * ListObjectsV2 returns no user metadata — a listed resume has no
 * `originalFilename`, a listed letter an empty `provenance`. Supplying them
 * would make the `head()`-per-item loops in `list-documents.ts` and
 * `list-cover-letters.ts` look deletable.
 */

/**
 * Not a real S3 key — `buildObjectKey()` needs the storage config this mode
 * exists to not need. Only ever logged, never parsed, so `dev-fixture/` in a log
 * says plainly that no bucket was involved.
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
      // Idempotent, like S3: removing what is gone is not an error.
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
 * The real store's error, so call sites narrowing with `isUserStorageError` take
 * the branch they were written for.
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
 * The record minus its payload — what `put`, `head` and `list` return; bytes and
 * markdown travel only on a `get`. Two functions rather than one generic `omit`
 * so each return type lands as the interface's own, uncast.
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
