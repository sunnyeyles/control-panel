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
   * How wide this column is, as a Tailwind class on its `<th>`.
   *
   * ⚠️ **The table is `table-fixed`, and these widths are what makes a loading
   * skeleton possible at all.** Under the default `table-auto`, a column is as
   * wide as its widest cell — so the table's geometry is a function of the data
   * in it, and a placeholder rendered before that data arrives cannot be the
   * same shape by any amount of care. Every sort click moved the columns
   * sideways as the rows landed.
   *
   * It is not only the rows that differ: a sortable heading wraps its label in a
   * `size="sm"` button with an icon beside it, roughly 28px wider than the plain
   * text `posting-table-skeleton.tsx` draws in its place. Even a skeleton that
   * copied the headings exactly would still have measured differently.
   *
   * Percentages rather than pixels, so the table still answers to its
   * `max-w-6xl` container and to a narrow viewport. They total 90%; the
   * remaining tenth is the three unlabelled cells, which keep the fixed `w-8`,
   * `w-8` and `w-12` they already carried — 112px, or almost exactly 10% of the
   * table inside `max-w-6xl`.
   *
   * The floor on each is its own heading: `TableHead` is `whitespace-nowrap`, so
   * a column narrower than the words in it spills rather than wrapping. "Cover
   * letter" is the longest and is why that column is 10% and not the 7% its
   * contents — a single `size-4` icon — would otherwise justify.
   */
  width: string
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
  /**
   * When this column is rendered, as a Tailwind class on its `<th>` and on the
   * matching `<td>`. Absent means always.
   *
   * ⚠️ **Nine cells do not fit on a phone.** At 375px each of them is about
   * 40px, and `TableHead` is `whitespace-nowrap`, so every heading spills its
   * own column. The `overflow-x-auto` the shared `Table` puts around itself
   * does not save this table: it is `w-full` and `table-fixed`, so it shrinks
   * to the viewport instead of overflowing it, and there is nothing to scroll.
   *
   * So the columns that are scanning aids rather than identity stop being
   * rendered — and what they said is disclosed in the panel the row already
   * opens, which is why `posting-detail.tsx` has a section that appears only
   * below `lg`. **Hiding a column here without adding the fact there makes it
   * unreachable on the device the change is for.**
   *
   * Two things follow from `table-fixed` and neither needs fixing:
   *
   * - **The percentages no longer total 90%, and that is fine.** A
   *   `display: none` cell contributes no column at all, and the slack is
   *   distributed across the columns that remain in proportion to their
   *   declared widths — so below `md` the 27/17/10 ratio scales up to fill the
   *   row and Title stays the widest thing on screen. A per-breakpoint width
   *   would be three more numbers to keep in step with the skeleton for no
   *   visible gain.
   * - **{@link POSTING_COLSPAN} stays 9.** CSS cannot vary an attribute, and
   *   under `table-fixed` the column count is fixed by the first row — so a
   *   `colSpan` wider than the visible columns is clamped to the row rather
   *   than inventing a phantom tenth one. Computing a smaller number from a
   *   media query would put the breakpoint into JavaScript, and the header is a
   *   server component.
   */
  visibility?: string
}

/**
 * The two points at which a column stops being rendered.
 *
 * Named rather than written into the array below, because the `<td>`s in
 * `posting-table-body.tsx` and the placeholder cells in
 * `posting-table-skeleton.tsx` are hand-written in the array's order rather than
 * mapped from it — so all three files have to spell the same class, and a
 * literal repeated in three places is the drift this file exists to prevent.
 *
 * `md:table-cell` and not `md:block`: these are `<th>` and `<td>`, and putting
 * one back as a block takes it out of the table's layout rather than returning
 * it to the row.
 *
 * `md` is 768px, which is also `MOBILE_BREAKPOINT` in
 * `@workspace/ui/hooks/use-mobile` — but this is plain CSS and deliberately not
 * that hook. A media query read in JavaScript renders differently on the server
 * than in the browser, and the header row is a server component.
 */
export const POSTING_HIDE_BELOW_MD = "hidden md:table-cell"
export const POSTING_HIDE_BELOW_LG = "hidden lg:table-cell"

/**
 * ⚠️ **Which three columns hide is a judgement about what a row is *for*.**
 * Title and Company are how somebody recognises an advertisement they have
 * already seen, and the letter column is the only per-row state worth scanning
 * a page for — so those stay at every width. Location, Posted and Source answer
 * questions about one posting, which is what expanding it is for.
 */
export const POSTING_COLUMNS: readonly PostingColumn[] = [
  { key: "title", label: "Title", width: "w-[27%]", sort: "title" },
  { key: "company", label: "Company", width: "w-[17%]", sort: "company" },
  {
    key: "location",
    label: "Location",
    width: "w-[15%]",
    visibility: POSTING_HIDE_BELOW_MD,
  },
  {
    key: "postedAt",
    label: "Posted",
    width: "w-[11%]",
    sort: "posted",
    visibility: POSTING_HIDE_BELOW_MD,
  },
  {
    key: "source",
    label: "Source",
    width: "w-[10%]",
    visibility: POSTING_HIDE_BELOW_LG,
  },
  { key: "letter", label: "Cover letter", width: "w-[10%]" },
]

/**
 * The width of the three cells that carry controls rather than a heading, in
 * the order they are rendered: the selection checkbox, the disclosure chevron,
 * and the row's delete control.
 *
 * Here rather than written into three components, for the same reason
 * {@link POSTING_COLUMNS} carries its own: the header row, every body row and
 * the loading skeleton all have to agree on them, and under `table-fixed` a
 * disagreement is a visible jump rather than a silent no-op.
 */
export const POSTING_SELECT_WIDTH = "w-8"
export const POSTING_EXPAND_WIDTH = "w-8"
export const POSTING_ACTIONS_WIDTH = "w-12"

/**
 * How tall one body row is, header excluded.
 *
 * ⚠️ **Uniform, and that is the point.** The title cell wraps to two lines when
 * an advertisement has a long one, so without a declared height a page of rows
 * is a mix of one- and two-line rows — and the skeleton would have to guess
 * which, for all twenty-five. Fixing the height moves the variation inside the
 * cell (`line-clamp-2`) where it costs nothing, and lets the fallback reserve
 * exactly the space the rows will take.
 *
 * 56px, which is the 44px the row already needed for its `size-7` icon buttons
 * plus room for the second line of a wrapped title.
 */
export const POSTING_ROW_HEIGHT = "h-14"

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
 *
 * ⚠️ **Every column, including the ones a narrow viewport does not render.** It
 * is deliberately not `POSTING_COLUMNS.filter(visible)`, because "visible" is a
 * media query and this number becomes an HTML attribute. Under `table-fixed`
 * the row count is set by the first row, so the excess is clamped — see
 * {@link PostingColumn.visibility}.
 */
export const POSTING_COLSPAN = POSTING_COLUMNS.length + FIXED_CELLS
