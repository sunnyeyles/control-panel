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
  /**
   * The UTC calendar date the key partitions on, `YYYY-MM-DD`.
   *
   * Derived from the brief's **occurrence** — the slot it was written for — and
   * not from when it was generated. Those are not always the same day: a 23:30
   * slot that takes forty minutes finishes after midnight, and partitioning on
   * the finish time would file it under a day its run row disagrees with.
   */
  partitionOn: string
  briefId: string
}

/** A brief on its way in. */
export interface NewBrief {
  userId: string
  briefId: string
  /**
   * The slot this brief is for — `runs.scheduled_for` — which decides the key's
   * partition day.
   *
   * Separate from {@link NewBrief.generatedAt} on purpose, and the whole reason
   * this interface carries two Dates. It makes the object key derivable from
   * the run row alone, without knowing when the run happened to finish, so
   * "which day is this brief for" has exactly one answer in both places.
   *
   * An ad-hoc run has no scheduled occurrence; pass the instant it was
   * triggered.
   *
   * Note the consequence of the day being computed in UTC: a 09:00
   * `Australia/Sydney` briefing fires at 23:00 UTC the previous day and lands
   * in the previous UTC day's folder. That is intended — the key is a storage
   * partition, not a date display, and keeping it UTC means a key stays
   * interpretable without its job row. Dates shown to a person come from
   * `runs.scheduled_for`.
   */
  occurrence: Date
  /**
   * The instant the brief was actually generated.
   *
   * Carried into the object's metadata and nowhere else — it no longer decides
   * the key. Keeping it means nothing is lost to the day-level granularity of
   * the partition.
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
    segments: [...dateSegments(ref.partitionOn), ref.briefId],
    extension: EXTENSION,
  })

  return {
    async put(brief: NewBrief): Promise<StoredBrief> {
      // `toGeneratedOn` is "the UTC calendar day of an instant" and is
      // unchanged. What changed is which instant it is handed: the occurrence,
      // not the generation time.
      const partitionOn = toGeneratedOn(brief.occurrence)

      const stored = await objects.put({
        ...refFor({ ...brief, partitionOn }),
        body: brief.markdown,
        metadata: { [GENERATED_AT]: brief.generatedAt.toISOString() },
      })

      return {
        key: stored.key,
        userId: brief.userId,
        partitionOn,
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
        partitionOn: ref.partitionOn,
        briefId: ref.briefId,
        size: fetched.size,
        generatedAt: instantFrom(fetched.metadata, ref.partitionOn),
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
  const partitionOn = `${year}-${month}-${day}`

  return {
    key: object.key,
    userId,
    partitionOn,
    briefId: briefId ?? "",
    size: object.size,
    generatedAt: instantFrom(object.metadata, partitionOn),
  }
}

/**
 * Metadata holds the exact instant; the key only holds the day. Fall back to
 * UTC midnight on the partition day if an object predates the metadata — wrong
 * by up to a day, but never silently absent.
 */
function instantFrom(
  metadata: Record<string, string>,
  partitionOn: string
): Date {
  const raw = metadata[GENERATED_AT]
  const parsed = raw ? new Date(raw) : undefined

  return parsed && !Number.isNaN(parsed.getTime())
    ? parsed
    : new Date(`${partitionOn}T00:00:00.000Z`)
}
