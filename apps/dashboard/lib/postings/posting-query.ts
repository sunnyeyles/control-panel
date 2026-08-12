import { z } from "zod"

/**
 * The Postings table's view, as it travels in the query string.
 *
 * **Nothing here imports Next**: what is interesting is how a hand-edited URL
 * degrades, and that is exactly what a page component cannot be tested for. The
 * page awaits `searchParams` and hands the plain object here.
 *
 * ⚠️ **This is the app's first reader of untrusted GET input.** Every other value
 * the app parses arrives through a form it rendered; a query string arrives
 * however someone typed it, with no submit button to refuse. Two consequences:
 *
 * - **Per-field `.catch()`, never a whole-object `safeParse`.**
 *   `?page=abc&sort=title` must keep the sort and quietly fix the page; a single
 *   object parse fails as a unit, and a 500 is the wrong answer to a URL somebody
 *   edited by hand.
 * - **`page` is capped**, because it becomes `skip` and an arbitrarily large
 *   offset is a scan for a page that cannot exist. The clamp against the *real*
 *   page count is `list-postings.ts`'s; this one applies before anything has been
 *   counted.
 *
 * ⚠️ Next 16 hands `searchParams` to a page as a **`Promise`**, and a repeated
 * parameter (`?page=1&page=2`) arrives as a `string[]` — both verified against
 * `next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md:75`. The
 * array case is handled at the edge, in {@link first}.
 */

/** One page of the table. */
export const PAGE_SIZE = 25

/**
 * The furthest `page` may be before anything has been counted.
 *
 * Not a limit on the table — `list-postings.ts` clamps to the real page count,
 * which is almost always far lower. This only stops `?page=999999999` from
 * reaching `skip`.
 */
export const MAX_PAGE = 10_000

/**
 * The orderable columns, as the URL spells them.
 *
 * Deliberately not the Prisma field names: `list-postings.ts` maps them, so what
 * a user sees in their address bar is not a database column to probe by editing.
 *
 * ⚠️ **Four of these are headings and one is not.** `title`, `company`, `posted`
 * and `match` are the sortable headings — see `POSTING_COLUMNS` in
 * `posting-columns.ts`, which names per column why the others do not sort.
 * `lastSeen` has no heading and is here because it is {@link DEFAULT_SORT}: the
 * order of the page nobody has sorted still has to be spellable.
 *
 * ⚠️ **Status has a heading and still does not sort.** Ordering by it would mean
 * a sixth `PostingOrder` in `@workspace/db`, and that enum is closed on purpose —
 * "adding one is a decision about the index, not a convenience". Adding the entry
 * back without that is a heading linking to a sort the query cannot perform. A
 * URL naming a sort that is not here is not an error: `SortSchema` catches it
 * back to the default.
 */
export const POSTING_SORTS = [
  "lastSeen",
  "title",
  "company",
  "posted",
  "match",
] as const

export type PostingSort = (typeof POSTING_SORTS)[number]

export type SortDirection = "asc" | "desc"

/**
 * Which way a column runs when it is first clicked.
 *
 * A date's interesting end is the recent one and a name's is the top of the
 * alphabet, so "sort by this" means different things per column; a single
 * default would make half the headers need two clicks to be useful.
 */
const DEFAULT_DIRECTIONS = {
  lastSeen: "desc",
  title: "asc",
  company: "asc",
  posted: "desc",
  // The best matches, which is the only reason anybody clicks this heading.
  match: "desc",
} as const satisfies Record<PostingSort, SortDirection>

/**
 * The default view: most recently seen first.
 *
 * The same order as `postings_user_last_seen_idx`, tie-break included, so the
 * page nobody has sorted is an index scan.
 */
const DEFAULT_SORT: PostingSort = "lastSeen"

export interface PostingQuery {
  sort: PostingSort
  direction: SortDirection
  /** One-based, as the URL and the controls both read it. */
  page: number
}

/** What Next resolves `searchParams` to, once awaited. */
export type SearchParams = Record<string, string | string[] | undefined>

const SortSchema = z.enum(POSTING_SORTS).catch(DEFAULT_SORT)

/**
 * Absent rather than defaulted, because the fallback depends on the sort parsed
 * beside it — see {@link DEFAULT_DIRECTIONS}.
 */
const DirectionSchema = z
  .enum(["asc", "desc"] as const)
  .optional()
  .catch(undefined)

/**
 * `z.coerce.number()` turns `"abc"` into `NaN` and `""` into `0`, both of which
 * the constraints below reject and `.catch()` answers `1` for — the same answer
 * an absent parameter gets, deliberately. There is nothing to tell a user about
 * a page number they did not type.
 */
const PageSchema = z.coerce.number().int().min(1).max(MAX_PAGE).catch(1)

/**
 * The view a URL asks for, with every unusable part replaced and the rest kept.
 *
 * Total by construction: there is no input this refuses, which is the point.
 */
export function parsePostingQuery(params: SearchParams = {}): PostingQuery {
  const sort = SortSchema.parse(first(params.sort))
  const direction = DirectionSchema.parse(first(params.dir))

  return {
    sort,
    direction: direction ?? DEFAULT_DIRECTIONS[sort],
    page: PageSchema.parse(first(params.page)),
  }
}

/**
 * The link to a view, with every default left out.
 *
 * So the canonical first page is a bare `/jobs` rather than
 * `/jobs?sort=lastSeen&dir=desc&page=1` — the same page under a URL nobody
 * would choose to share.
 *
 * Round-trips through {@link parsePostingQuery}: a non-default direction is
 * kept even when the sort is the default one, because `?dir=asc` alone is a
 * different view from no parameters at all.
 */
export function postingsHref(query: PostingQuery): string {
  const params = new URLSearchParams()

  if (query.sort !== DEFAULT_SORT) params.set("sort", query.sort)
  if (query.direction !== DEFAULT_DIRECTIONS[query.sort]) {
    params.set("dir", query.direction)
  }
  if (query.page > 1) params.set("page", String(query.page))

  const search = params.toString()

  return search === "" ? "/jobs" : `/jobs?${search}`
}

/**
 * The link a sortable column header points at.
 *
 * **Sorting resets the page**, because page 3 of one order is unrelated to page
 * 3 of another: the row someone was looking at is not there, and the page they
 * land on has no relationship to the click they made.
 */
export function sortHref(column: PostingSort, current: PostingQuery): string {
  return postingsHref({
    sort: column,
    direction: nextDirectionFor(column, current),
    page: 1,
  })
}

/**
 * Which way clicking a column header would sort it.
 *
 * The column already sorted flips; any other column starts at its own natural
 * end rather than inheriting the direction of the column being left behind.
 */
export function nextDirectionFor(
  column: PostingSort,
  current: PostingQuery
): SortDirection {
  if (current.sort !== column) return DEFAULT_DIRECTIONS[column]

  return current.direction === "asc" ? "desc" : "asc"
}

/** The link to another page of the same order. */
export function pageHref(page: number, current: PostingQuery): string {
  return postingsHref({ ...current, page })
}

/**
 * The first value of a parameter that may have been repeated.
 *
 * `?page=1&page=2` is legal in a URL and Next reports it as an array. First
 * wins rather than last, because there is no reason to prefer either and a rule
 * that is written down is one that cannot drift.
 */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}
