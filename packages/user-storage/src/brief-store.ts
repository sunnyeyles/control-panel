import { dateSegments, toGeneratedOn } from "./keys.js"
import type { StoredObject, UserObjectStore } from "./user-object-store.js"

/** Briefs are Markdown and nothing else. */
const EXTENSION = ".md"
const KIND = "briefs" as const

/** Where the full generation instant lives, since the key holds only the day. */
const GENERATED_AT = "generated-at"

/** Addresses one brief. */
export interface BriefRef {
  userId: string
  /** UTC calendar date the brief was generated for, `YYYY-MM-DD`. */
  generatedOn: string
  briefId: string
}

/** A brief on its way in. */
export interface NewBrief {
  userId: string
  briefId: string
  /**
   * The instant the brief was generated. The store derives the key's UTC date
   * from this and keeps the full value on the object's metadata, so nothing is
   * lost to the day-level granularity of the key.
   */
  generatedAt: Date
  /** The brief itself. Stored as UTF-8 `text/markdown`. */
  markdown: string
}

/** A brief that exists in the store. */
export interface StoredBrief extends BriefRef {
  key: string
  size: number
  generatedAt: Date
  /** Present on a read, absent from a `put` result. */
  markdown?: string
}

/**
 * Markdown briefs written by the scheduled worker.
 *
 * A facade over {@link UserObjectStore}, not a second implementation. It knows
 * one kind's key shape and file type so a call site does not have to restate
 * them — and, more usefully, so a call site cannot get them wrong. Ownership
 * checks, key validation, and error mapping all still happen in the one place
 * underneath.
 */
export interface BriefStore {
  put(brief: NewBrief): Promise<StoredBrief>
  get(ref: BriefRef): Promise<StoredBrief>
  delete(ref: BriefRef): Promise<void>
  /** Every brief a user has, oldest first — the key sorts chronologically. */
  list(userId: string): Promise<StoredBrief[]>
}

export function createBriefStore(objects: UserObjectStore): BriefStore {
  const refFor = (ref: BriefRef) => ({
    userId: ref.userId,
    kind: KIND,
    segments: [...dateSegments(ref.generatedOn), ref.briefId],
    extension: EXTENSION,
  })

  return {
    async put(brief: NewBrief): Promise<StoredBrief> {
      const generatedOn = toGeneratedOn(brief.generatedAt)

      const stored = await objects.put({
        ...refFor({ ...brief, generatedOn }),
        body: brief.markdown,
        metadata: { [GENERATED_AT]: brief.generatedAt.toISOString() },
      })

      return {
        key: stored.key,
        userId: brief.userId,
        generatedOn,
        briefId: brief.briefId,
        size: stored.size,
        generatedAt: brief.generatedAt,
      }
    },

    async get(ref: BriefRef): Promise<StoredBrief> {
      const fetched = await objects.get(refFor(ref))

      return {
        key: fetched.key,
        userId: ref.userId,
        generatedOn: ref.generatedOn,
        briefId: ref.briefId,
        size: fetched.size,
        generatedAt: instantFrom(fetched.metadata, ref.generatedOn),
        markdown: fetched.text(),
      }
    },

    async delete(ref: BriefRef): Promise<void> {
      await objects.delete(refFor(ref))
    },

    async list(userId: string): Promise<StoredBrief[]> {
      const found = await objects.list(userId, KIND)
      return found.map((object) => toStoredBrief(userId, object))
    },
  }
}

function toStoredBrief(userId: string, object: StoredObject): StoredBrief {
  // segments are [YYYY, MM, DD, briefId] by construction, and parseObjectKey
  // has already validated each one.
  const [year, month, day, briefId] = object.segments
  const generatedOn = `${year}-${month}-${day}`

  return {
    key: object.key,
    userId,
    generatedOn,
    briefId: briefId ?? "",
    size: object.size,
    generatedAt: instantFrom(object.metadata, generatedOn),
  }
}

/**
 * Metadata holds the exact instant; the key only holds the day. Fall back to
 * UTC midnight on that day if an object predates the metadata — wrong by up to
 * a day, but never silently absent.
 */
function instantFrom(
  metadata: Record<string, string>,
  generatedOn: string
): Date {
  const raw = metadata[GENERATED_AT]
  const parsed = raw ? new Date(raw) : undefined

  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed
    : new Date(`${generatedOn}T00:00:00.000Z`)
}
