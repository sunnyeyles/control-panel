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
 * The whole file's principle, and nowhere does it matter more than here: this
 * predicate decides what `deleteMany` removes, so a clause quietly dropped
 * would not merely widen a listing — it would delete every Posting the dev user
 * has, in the one environment the delete is built in.
 *
 * Module-level and exported rather than a method, because
 * `lib/postings/posting-actions.test.ts` builds its own `posting` double and had
 * copied this rule out. Two spellings of "which rows does this `where` name" is
 * one more than the number that can be wrong without anyone noticing — sharing
 * the predicate is not code thrift, it is the only way a divergence shows up as
 * a failing test rather than as a fake that agrees with nothing.
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
 * simplification of it.** Both sides are space-padded and punctuation-flattened
 * — `titleMatchPattern()` on one side, the `title_normalized` generated column
 * on the other — which is exactly what turns whole-word matching into
 * `contains`. Reimplementing word boundaries here would make this fake stricter
 * than Postgres and hide the case the padding exists to handle.
 *
 * Throws on a row with no `titleNormalized` rather than admitting it: under the
 * flag that means a fixture missing the field, and quietly keeping the row would
 * make the filter look broken in the one environment it is built in.
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
 * Splices out of the caller's array rather than handing back a new one, because
 * every holder of a `posting` double keeps its rows in a `readonly` field that
 * the rest of the double reads through — a reassignment would leave the other
 * methods looking at rows that are supposed to be gone.
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
