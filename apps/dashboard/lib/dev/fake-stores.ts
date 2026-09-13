import { devContentType, devUploads } from "@/lib/dev/fixtures"
import {
  ObjectNotFoundError,
  type NewResume,
  type ResumeRef,
  type ResumeStore,
  type StoredResume,
} from "@workspace/user-storage"

/**
 * S3, for `DEV_AUTH_BYPASS=1` only — the resume facade the dashboard uses,
 * backed by a `Map`. Faked at the facade rather than at `UserObjectStore` below
 * it, so key building and `assertSegment()` keep their single implementation.
 *
 * ⚠️ **`list()` deliberately returns less than `head()`**, because ListObjectsV2
 * returns no user metadata: no `originalFilename` on a listed resume. Supplying
 * it would make the bucket look like a place a display name can be read from
 * cheaply — the assumption `/documents` was built on before `documents` in
 * Postgres replaced it.
 *
 * ⚠️ **This fake and `createDevPrisma()` are two halves of one fixture.** See
 * the note on `DEV_DOCUMENT_IDS` in `fixtures.ts`.
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
}

/**
 * ⚠️ **Memoized on `globalThis`, not in a module variable, and that is not
 * belt-and-braces.** `next dev` does not give every server bundle the same
 * module instance, so a Server Action and a Route Handler importing
 * `lib/storage.ts` can each get their own `Map`. Against S3 that is invisible —
 * two facades over one bucket — but against an in-memory fake a write through
 * one is unreadable through the other.
 *
 * It reads as a product bug: an upload succeeds, and
 * `/api/documents/{file}` still 404s on it. `lib/db.ts` memoizes the fake
 * Prisma the same way for the same reason.
 *
 * A string key rather than `Symbol.for`, only because such a symbol is typed
 * `symbol` rather than `unique symbol` and cannot be a computed key.
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

// Not exported: the only correct way to reach this is through the memoized
// getter above. A second `createDevResumeStore()` call is a second `Map`, which
// is exactly the bug that getter exists to prevent.
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

  for (const resume of devUploads()) void put(resume)

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

/** One address, one object — the same rule the real key layout enforces. */
function refKey(ref: ResumeRef): string {
  return `${ref.userId}/${ref.resumeId}${ref.extension}`
}

/**
 * The real store's error, so call sites narrowing with `isUserStorageError` take
 * the branch they were written for.
 */
function mustGet<T>(stored: Map<string, T>, ref: ResumeRef): T {
  const found = stored.get(refKey(ref))
  if (!found) throw new ObjectNotFoundError(refKey(ref))
  return found
}

/**
 * ⚠️ **A delete of something absent throws, and this fake used to shrug** —
 * "idempotent, like S3" describes the `DeleteObject` API, not the store built on
 * it. `S3UserObjectStore.delete()` HEADs first and raises
 * {@link ObjectNotFoundError}, so a caller deleting a typo is not told it worked
 * and the ownership check gets the metadata only a read supplies.
 */
function mustDelete(stored: Map<string, unknown>, ref: ResumeRef): void {
  if (!stored.delete(refKey(ref))) {
    throw new ObjectNotFoundError(refKey(ref))
  }
}

/** The record minus its bytes — what `put`, `head` and `list` return. */
function withoutBytes(
  resume: StoredResume & { bytes: Uint8Array }
): StoredResume {
  const { bytes, ...rest } = resume
  void bytes
  return rest
}
