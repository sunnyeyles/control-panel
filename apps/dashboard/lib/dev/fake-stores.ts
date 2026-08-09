import {
  devContentType,
  devCoverLetters,
  devResumes,
  devTailoredResumes,
} from "@/lib/dev/fixtures"
import {
  ObjectNotFoundError,
  type CoverLetterRef,
  type CoverLetterStore,
  type NewCoverLetter,
  type NewResume,
  type NewTailoredResume,
  type ResumeRef,
  type ResumeStore,
  type StoredCoverLetter,
  type StoredResume,
  type StoredTailoredResume,
  type TailoredResumeRef,
  type TailoredResumeStore,
} from "@workspace/user-storage"

/**
 * S3, for `DEV_AUTH_BYPASS=1` only — the three facades the dashboard uses,
 * backed by a `Map` each. Faked at the facade rather than at `UserObjectStore`
 * below it, so key building and `assertSegment()` keep their single
 * implementation.
 *
 * ⚠️ **`list()` deliberately returns less than `head()` does**, because
 * ListObjectsV2 returns no user metadata. For resumes that means a listed one
 * has no `originalFilename`; for tailored resumes it means no provenance and a
 * `generatedAt` off the object's own write time. Both fakes drop it on purpose:
 * supplying it here would hide that the postings table dates a tailored resume
 * by when the object was written, and would make the bucket look like a place a
 * display name can be read from cheaply — which is the assumption `/documents`
 * was built on before `documents` in Postgres replaced it. Cover letters are
 * addressed directly by Posting id and have no `list()` at all, so their
 * metadata is always read through `head()`.
 *
 * ⚠️ **The resume fake and `createDevPrisma()` are two halves of one fixture.**
 * `/documents` reads the rows and downloads the bytes, so an id present in
 * `devResumes()` and absent from `devDocuments()` — or the reverse — reproduces
 * a real production state and not a useful default. See the note on
 * `DEV_DOCUMENT_IDS` in `fixtures.ts`.
 */

/**
 * Not a real S3 key — `buildObjectKey()` needs the storage config this mode
 * exists to not need. Only ever logged, never parsed, so `dev-fixture/` in a log
 * says plainly that no bucket was involved.
 */
function devKey(kind: string, userId: string, name: string): string {
  return `dev-fixture/${kind}/${userId}/${name}`
}

interface DevStores {
  resumes?: ResumeStore
  coverLetters?: CoverLetterStore
  tailoredResumes?: TailoredResumeStore
}

/**
 * Anything these fakes address an object by.
 *
 * `TailoredResumeRef` and `CoverLetterRef` are structurally identical — both are
 * `(userId, postingId)` — so naming it here buys nothing at the type level and
 * is written out anyway: the helpers below fan out over every kind the fakes
 * hold, and a union that lists two of three reads as an oversight.
 */
type DevRef = ResumeRef | CoverLetterRef | TailoredResumeRef

/**
 * ⚠️ **The fakes are memoized on `globalThis`, not in a module variable, and
 * that is not belt-and-braces.** `next dev` does not give every server bundle
 * the same module instance: a Server Action and a Route Handler that both
 * import `lib/storage.ts` can each get their own copy of its `let coverLetters`
 * memo, and therefore their own `Map`. Against S3 that is invisible — two
 * facades over one bucket — but against an in-memory fake the two are separate
 * worlds, and a write through one is unreadable through the other.
 *
 * The symptom is specific and reads as a product bug rather than a harness one:
 * saving an edited cover letter reports success, the action can read its own
 * write back, and `/api/cover-letters/{postingId}` still serves the fixture. The
 * same shape applies to `/documents`, where an upload is a Server Action and the
 * download is a Route Handler.
 *
 * A string-keyed property rather than `Symbol.for`, only because a symbol from
 * `Symbol.for` is typed `symbol` rather than `unique symbol` and cannot be a
 * computed key in an interface.
 *
 * `lib/dev/fake-prisma.ts` had the same gap and no longer does — `lib/db.ts`
 * moved it onto `globalThis` under `Symbol.for("@workspace/dashboard.devPrisma")`
 * when the whiteboard turned out to write from a route handler and read from a
 * page. The two fakes are now memoized the same way for the same reason; only
 * the key differs, and that one is a symbol because it can be.
 */
function devStores(): DevStores {
  const holder = globalThis as typeof globalThis & {
    __workspaceDevStores?: DevStores
  }

  holder.__workspaceDevStores ??= {}
  return holder.__workspaceDevStores
}

export function getDevResumeStore(): ResumeStore {
  const stores = devStores()
  stores.resumes ??= createDevResumeStore()
  return stores.resumes
}

export function getDevCoverLetterStore(): CoverLetterStore {
  const stores = devStores()
  stores.coverLetters ??= createDevCoverLetterStore()
  return stores.coverLetters
}

export function getDevTailoredResumeStore(): TailoredResumeStore {
  const stores = devStores()
  stores.tailoredResumes ??= createDevTailoredResumeStore()
  return stores.tailoredResumes
}

// Not exported: the only correct way to reach these is through the memoized
// getters above. A second `createX()` call is a second `Map`, which is exactly
// the bug those getters exist to prevent.
function createDevResumeStore(): ResumeStore {
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
      // `documentType` is *not* held. The real store writes it to the object as
      // provenance and never reads it back — `documents.doc_type` is what the
      // application sees — so a fake that could answer it would offer something
      // production cannot.
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
      mustDelete(stored, ref)
    },

    async list(userId: string): Promise<StoredResume[]> {
      return [...stored.values()]
        .filter((resume) => resume.userId === userId)
        .sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())
        .map((resume) => {
          // See the warning above: a listing carries no user metadata, so the
          // filename is dropped here on purpose.
          const { bytes, originalFilename, ...listed } = resume
          void bytes
          void originalFilename
          return listed
        })
    },
  }
}

function createDevCoverLetterStore(): CoverLetterStore {
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
      mustDelete(stored, ref)
    },

    async list(userId: string): Promise<StoredCoverLetter[]> {
      return [...stored.values()]
        .filter((letter) => letter.userId === userId)
        .sort((a, b) => a.postingId.localeCompare(b.postingId))
        .map((letter) => {
          // See the warning at the top of this file: a listing carries no user
          // metadata, so the provenance is dropped here on purpose. The real
          // store cannot supply it from `ListObjectsV2` either, and a fake that
          // did would make the `head()` in `posting-detail.tsx` look deletable.
          const { markdown, provenance, ...listed } = letter
          void markdown
          void provenance
          return { ...listed, provenance: {} }
        })
    },
  }
}

function createDevTailoredResumeStore(): TailoredResumeStore {
  const stored = new Map<string, StoredTailoredResume & { markdown: string }>()

  const put = async (
    resume: NewTailoredResume
  ): Promise<StoredTailoredResume> => {
    const record = {
      key: devKey(
        "tailored-resumes",
        resume.userId,
        `${resume.postingId}/resume.md`
      ),
      userId: resume.userId,
      postingId: resume.postingId,
      size: new TextEncoder().encode(resume.markdown).byteLength,
      generatedAt: resume.generatedAt,
      provenance: resume.provenance ?? {},
      markdown: resume.markdown,
    }

    // Re-generating supersedes rather than accumulates — same address, one
    // object.
    stored.set(refKey(resume), record)

    return withoutTailoredMarkdown(record)
  }

  for (const resume of devTailoredResumes()) void put(resume)

  return {
    put,

    async get(ref: TailoredResumeRef): Promise<StoredTailoredResume> {
      return { ...mustGet(stored, ref) }
    },

    async head(ref: TailoredResumeRef): Promise<StoredTailoredResume> {
      return withoutTailoredMarkdown(mustGet(stored, ref))
    },

    async delete(ref: TailoredResumeRef): Promise<void> {
      mustDelete(stored, ref)
    },

    async list(userId: string): Promise<StoredTailoredResume[]> {
      return [...stored.values()]
        .filter((resume) => resume.userId === userId)
        .map((resume) => ({
          // See the warning at the top of this file: a listing carries no user
          // metadata, so the provenance is dropped and the instant falls back
          // to the object's own write time — which is what the real store does
          // too, and what the postings table therefore renders. Faking it
          // richer here would hide that from every local run.
          ...withoutTailoredMarkdown(resume),
          provenance: {},
        }))
    },
  }
}

/** One address, one object — the same rule the real key layout enforces. */
function refKey(ref: DevRef): string {
  return "resumeId" in ref
    ? `${ref.userId}/${ref.resumeId}${ref.extension}`
    : `${ref.userId}/${ref.postingId}`
}

/**
 * The real store's error, so call sites narrowing with `isUserStorageError` take
 * the branch they were written for.
 */
function mustGet<T>(stored: Map<string, T>, ref: DevRef): T {
  const found = stored.get(refKey(ref))
  if (!found) throw new ObjectNotFoundError(refKey(ref))
  return found
}

/**
 * ⚠️ **A delete of something that is not there throws, and this fake used to
 * shrug** — "idempotent, like S3", which describes the `DeleteObject` API and
 * not the store built on it. `S3UserObjectStore.delete()` deliberately HEADs
 * first and raises {@link ObjectNotFoundError}, both so a caller deleting a
 * typo is not told it worked and because the ownership check needs metadata
 * only a read can supply.
 *
 * The divergence mattered most where it was least visible. Deleting a
 * **Posting** removes its **Cover Letter** and its **Tailored Resume** first,
 * and most Postings have neither — so `object_not_found` is the *ordinary* path
 * there, and a fake that never raised it meant `DEV_AUTH_BYPASS=1` exercised the
 * branch zero times. A missing branch would have looked perfect locally and
 * refused every delete of a Posting nothing had been written for in production.
 */
function mustDelete(stored: Map<string, unknown>, ref: DevRef): void {
  if (!stored.delete(refKey(ref))) {
    throw new ObjectNotFoundError(refKey(ref))
  }
}

/**
 * The record minus its payload — what `put`, `head` and `list` return; bytes and
 * markdown travel only on a `get`. One function per store rather than a generic
 * `omit`, so each return type lands as the interface's own, uncast.
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

function withoutTailoredMarkdown(
  resume: StoredTailoredResume & { markdown: string }
): StoredTailoredResume {
  const { markdown, ...rest } = resume
  void markdown
  return rest
}
