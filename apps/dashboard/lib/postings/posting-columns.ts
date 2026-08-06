import type { PostingSort } from "./posting-query"

/**
 * The Postings table's columns, declared once.
 *
 * **This exists because the header row and the expanded detail row have to
 * agree on a number, and nothing made them.** The headers were seven literal
 * `<TableHead>`s in `posting-table.tsx`; the detail row's `colSpan` was a
 * `COLUMN_COUNT = 7` constant in `posting-row.tsx`, a different file. Adding or
 * removing a column meant editing both, and forgetting the second one produces
 * a detail panel that is silently narrower or wider than the table — a defect
 * with no type error and no test behind it.
 *
 * **Nothing here imports Next or React**, so a server component and a client
 * component can both read it. That is the whole reason it sits in `lib/`
 * beside `posting-query.ts` rather than next to the components.
 *
 * ⚠️ **Not a shadcn/TanStack column definition, and deliberately not one.**
 * There is no cell renderer here and no accessor: sorting and paging happen in
 * Postgres and travel in the URL, so a column is only a heading and, when it is
 * sortable, the key that heading links with. What the table wanted from the
 * data-table pattern was columns as data instead of duplicated JSX, and that is
 * an array — not a dependency.
 */
export interface PostingColumn {
  /** For React keys. Not a `PostingView` field name, and not a database column. */
  key: string
  label: string
  /**
   * Present when the heading sorts, absent when the column is display-only.
   *
   * Location has no order worth having — nobody sorts a job search by the
   * spelling of a suburb, and a heading that sorts is a promise the column does.
   * The letter column is answered from S3 after the rows are chosen, which is
   * later than an `ORDER BY` can be decided.
   *
   * `postedAt` did not sort either, and for a reason that was true until
   * `0006_posting_posted_at` stopped it being: the value lived only inside
   * `postings.payload`, so there was nothing for an `ORDER BY` to name. It is a
   * column now, and the heading sorts.
   *
   * `source` cannot sort, and not for that reason: it is derived from the URL's
   * host at read time and stored nowhere, so there is no column for an
   * `ORDER BY` to name at all — see `posting-source.ts` for why that is the
   * design rather than an omission this migration could also fix.
   */
  sort?: PostingSort
}

export const POSTING_COLUMNS: readonly PostingColumn[] = [
  { key: "title", label: "Title", sort: "title" },
  { key: "company", label: "Company", sort: "company" },
  { key: "location", label: "Location" },
  { key: "postedAt", label: "Posted", sort: "posted" },
  { key: "source", label: "Source" },
  { key: "letter", label: "Cover letter" },
]

/**
 * The cells the table renders outside {@link POSTING_COLUMNS}: the selection
 * checkbox, the disclosure chevron, and the row's delete control.
 *
 * Named rather than left as a literal in the sum below, because the number is
 * the one thing in this file that has ever been wrong — and a bare `+ 3` says
 * nothing about which cells it is counting or what would change it.
 */
const FIXED_CELLS = 3

/**
 * How wide the expanded detail row is.
 *
 * The columns above plus the {@link FIXED_CELLS} that carry controls and no
 * heading text. Derived rather than written down, so a column added to the
 * array cannot leave the detail row behind.
 */
export const POSTING_COLSPAN = POSTING_COLUMNS.length + FIXED_CELLS
