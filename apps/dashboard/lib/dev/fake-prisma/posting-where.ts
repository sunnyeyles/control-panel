import { DevPrismaError } from "./errors"
import type {
  PostingKey,
  PostingMatchClause,
  PostingWhere,
  TitleExclusion,
} from "./query-types"

/**
 * ⚠️ **Throws on a filter it does not understand, rather than ignoring it.**
 *
 * This predicate decides what `deleteMany` removes, so a dropped clause would
 * not merely widen a listing — it would delete every Posting the dev user has,
 * in the one environment the delete is built in.
 *
 * Exported rather than a method because `posting-actions.test.ts` builds its own
 * `posting` double and had copied this rule out. Sharing it is what makes a
 * divergence a failing test rather than a fake that agrees with nothing.
 */
export function matchesPostingWhere(
  row: PostingKey,
  where: PostingWhere
): boolean {
  if (row.userId !== where.userId) return false

  if (where.OR !== undefined && !matchesUnscored(row, where.OR)) return false

  if (where.NOT !== undefined && matchesAnyTitlePattern(row, where.NOT.OR)) {
    return false
  }

  const byId = where.postingId
  if (byId === undefined) return true

  if (!Array.isArray(byId.in)) {
    throw new DevPrismaError(
      "prisma.posting where.postingId",
      "The only filter understood here is `postingId: { in: [...] }`. Teach matchesPostingWhere() in this file the new shape — ignoring it would widen a delete to every posting the dev user has."
    )
  }

  return byId.in.includes(row.postingId)
}

/**
 * The `OR` arm of a "not scored against this document" filter.
 *
 * ⚠️ **Throws on any other clause rather than ignoring it**, the whole file's
 * principle: an `OR` quietly treated as "everything matches" would hand the
 * scoring loop every Posting the dev user has and spend a model call on each,
 * every page view.
 */
function matchesUnscored(
  row: PostingKey,
  clauses: readonly PostingMatchClause[]
): boolean {
  return clauses.some((clause) => {
    // Absent is NULL, which is what an unscored Posting holds.
    const scoredAgainst = row.matchResumeId ?? null

    if (clause.matchResumeId === null) return scoredAgainst === null

    if (
      typeof clause.matchResumeId === "object" &&
      typeof clause.matchResumeId.not === "string"
    ) {
      return (
        scoredAgainst !== null && scoredAgainst !== clause.matchResumeId.not
      )
    }

    throw new DevPrismaError(
      "prisma.posting where.OR",
      "The only `OR` understood here is the unscored-against-a-document pair from unmatchedAgainst() in @workspace/db. Teach matchesUnscored() in this file the new shape — ignoring it would match every posting the dev user has."
    )
  })
}

/**
 * Whether a row's normalised title carries any of the excluded patterns.
 *
 * ⚠️ **A plain substring test, and that is the *real* rule rather than a
 * simplification.** Both sides are space-padded and punctuation-flattened —
 * `titleMatchPattern()` and the `title_normalized` column — which is what turns
 * whole-word matching into `contains`. Reimplementing word boundaries here would
 * make the fake stricter than Postgres and hide the case padding handles.
 *
 * Throws on a row with no `titleNormalized`: that is a fixture missing the
 * field, and keeping the row would make the filter look broken locally.
 */
function matchesAnyTitlePattern(
  row: PostingKey,
  patterns: TitleExclusion[]
): boolean {
  if (patterns.length === 0) return false

  const normalized = row.titleNormalized

  if (typeof normalized !== "string") {
    throw new DevPrismaError(
      "prisma.posting where.NOT",
      "This row has no `titleNormalized`. It is a generated column in `0010`, so lib/dev/fixtures.ts has to derive it with normalizeTitle() from @workspace/job-search — the same rule the SQL states."
    )
  }

  return patterns.some((pattern) =>
    normalized.includes(pattern.titleNormalized.contains)
  )
}

/**
 * Delete in place and answer with the rows that went, in the order they sat in.
 *
 * Splices in place rather than handing back a new array: every holder keeps its
 * rows in a `readonly` field the rest of the double reads through, so a
 * reassignment would leave the other methods looking at deleted rows.
 */
export function removeMatchingPostings<Row extends PostingKey>(
  rows: Row[],
  where: PostingWhere
): Row[] {
  const removed: Row[] = []

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (row !== undefined && matchesPostingWhere(row, where)) {
      rows.splice(index, 1)
      removed.push(row)
    }
  }

  return removed.reverse()
}
