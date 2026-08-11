import type { Posting, Run } from "@workspace/db"
import { DevPrismaError } from "./errors"
import type { PostingOrderBy, SortDirection } from "./query-types"

/**
 * Every `orderBy` clause applied in turn, first difference winning.
 *
 * The tie-break clause `list-postings.ts` appends is what makes a page boundary
 * stable, so it has to be applied here too — a fake that stopped at the first
 * clause would hide exactly the bug that tie-break exists to prevent.
 */
export function sortPostings(
  rows: Posting[],
  orderBy: PostingOrderBy[]
): Posting[] {
  return [...rows].sort((left, right) => {
    for (const clause of orderBy) {
      for (const [field, spec] of Object.entries(clause)) {
        const { sort: direction, nulls } =
          typeof spec === "string" ? { sort: spec, nulls: undefined } : spec

        const a = readPostingField(left, field)
        const b = readPostingField(right, field)

        // Nullity first, and outside the direction flip below — where a NULL
        // sits is decided by the clause, not by which way the values run.
        const byNullity = compareNullity(a, b, direction, nulls)
        if (byNullity !== undefined) {
          if (byNullity !== 0) return byNullity
          continue
        }

        const compared = comparePostingValues(field, a, b)
        if (compared !== 0) return direction === "desc" ? -compared : compared
      }
    }

    return 0
  })
}

/**
 * Throws on a field that is not a column, rather than answering `undefined`.
 *
 * The whole file's principle, applied to the one place where the alternative is
 * invisible: a comparator that shrugged would leave the rows in insertion order
 * and look like a table that had been sorted.
 */
function readPostingField(row: Posting, field: string): unknown {
  if (!(field in row)) {
    throw new DevPrismaError(
      `prisma.posting.findMany orderBy.${field}`,
      "That column is not on a Posting. Add it to lib/dev/fixtures.ts, or fix the orderBy in lib/postings/list-postings.ts."
    )
  }

  return row[field as keyof Posting]
}

/**
 * Where a NULL sits, or `undefined` when both sides have a value and the values
 * themselves decide.
 *
 * ⚠️ **The default depends on the direction, because Postgres's does**: NULLS
 * LAST under `ASC` and NULLS FIRST under `DESC`. Defaulting to "last" both ways
 * would be the friendlier rule and would make this fake disagree with the
 * database it stands in for — which is the one thing it must not do.
 * `list-postings.ts` pins `nulls: "last"` on the Posted column precisely so
 * that the direction stops deciding it.
 *
 * Exported so `list-postings.test.ts`'s own `FakeDb` — a narrower double that
 * simulates only the query shapes `listPostings()` sends, rather than the
 * whole of `prisma.posting` this file stands in for — applies the identical
 * rule instead of restating it, the same way `posting-actions.test.ts` already
 * reuses {@link matchesPostingWhere} and {@link removeMatchingPostings} from
 * here rather than reimplementing them.
 */
export function compareNullity(
  a: unknown,
  b: unknown,
  direction: SortDirection,
  nulls: "first" | "last" | undefined
): number | undefined {
  const aEmpty = a === null || a === undefined
  const bEmpty = b === null || b === undefined

  if (!aEmpty && !bEmpty) return undefined
  if (aEmpty && bEmpty) return 0

  const last = nulls === undefined ? direction === "asc" : nulls === "last"

  return (aEmpty ? 1 : -1) * (last ? 1 : -1)
}

/**
 * Two present values of a column, compared in ascending order.
 *
 * Exported alongside {@link compareNullity} so `list-postings.test.ts`'s
 * `FakeDb` shares this half of the sort rule too, rather than a second inline
 * comparator that could silently fall back to comparing something neither a
 * `Date` nor a `string` — which this one refuses, on the file's own principle
 * that an unimplemented case should throw rather than answer `undefined`.
 */
export function comparePostingValues(
  field: string,
  a: unknown,
  b: unknown
): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime()
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b)

  throw new DevPrismaError(
    `prisma.posting.findMany orderBy.${field}`,
    `Only text and timestamp columns can be ordered by here, and ${field} is neither.`
  )
}

export function byStartedAtThenIdDesc(a: Run, b: Run): number {
  const byTime = b.startedAt.getTime() - a.startedAt.getTime()
  return byTime !== 0 ? byTime : b.id.localeCompare(a.id)
}
