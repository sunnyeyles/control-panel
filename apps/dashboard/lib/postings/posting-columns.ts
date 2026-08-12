import type { PostingSort } from "./posting-query"

/**
 * The Postings table's columns, declared once, so the header row and the
 * expanded detail row's `colSpan` cannot drift — a mismatch there has no type
 * error and no test behind it.
 *
 * Nothing here imports Next or React, so a server and a client component can
 * both read it. Not a shadcn/TanStack column definition: sorting and paging
 * happen in Postgres and travel in the URL, so a column is only a heading plus,
 * when sortable, the key it links with.
 */
export interface PostingColumn {
  /** For React keys. Not a `PostingView` field name, and not a database column. */
  key: string
  label: string
  /**
   * A shorter heading for when the column is too narrow for {@link label}.
   * Absent when the label already fits at every width.
   *
   * ⚠️ `TableHead` is `whitespace-nowrap`, so a `<th>` narrower than its own
   * words spills sideways rather than wrapping — the floor on a column is the
   * width of its heading, which is why this exists rather than a wider share.
   *
   * Swapped in CSS, not in JavaScript: both spellings render and one is hidden,
   * so the header stays a server component. See `PostingColumnHeading`.
   */
  shortLabel?: string
  /**
   * How wide this column is, as a Tailwind class on its `<th>`.
   *
   * ⚠️ **The table is `table-fixed`, and these widths are what makes a loading
   * skeleton possible at all.** Under `table-auto` a column is as wide as its
   * widest cell, so the geometry depends on the data and every sort click moved
   * the columns sideways as the rows landed.
   *
   * Percentages, not pixels, so the table answers to `max-w-6xl` and to a narrow
   * viewport. They total 90%; the other tenth is the three unlabelled control
   * cells (`w-8`, `w-8`, `w-12` ≈ 112px).
   *
   * ⚠️ **Below `md` a second set applies and has to add up on its own.** Only
   * Title, Match and the letter column render there, so their `lg` shares would
   * leave 61% of slack the browser spreads over every cell including the three
   * controls — which is how Title once came out at 97px on a 390px viewport. The
   * mobile set is sized against the 252px that actually remains: 40/12/18.
   * **Check both sums when changing either.**
   *
   * The floor on each is its own heading (`whitespace-nowrap`), which is why
   * "Cover letter" carries a `shortLabel` rather than a wider share. Status is
   * the exception — its `Badge` cell sets the floor, not the heading.
   */
  width: string
  /**
   * Present when the heading sorts, absent when the column is display-only.
   *
   * Location has no order worth having. The letter column is answered from S3
   * after the rows are chosen, later than an `ORDER BY` can be decided. `source`
   * is derived from the URL's host at read time and stored nowhere, so there is
   * no column to name — see `posting-source.ts` for why that is the design.
   */
  sort?: PostingSort
  /**
   * When this column is rendered, as a Tailwind class on its `<th>` and on the
   * matching `<td>`. Absent means always.
   *
   * ⚠️ **Eleven cells do not fit on a phone**, and the shared `Table`'s
   * `overflow-x-auto` does not save this one: it is `w-full` and `table-fixed`,
   * so it shrinks to the viewport rather than overflowing it.
   *
   * Scanning aids stop rendering and what they said is disclosed in the detail
   * panel instead. **Hiding a column here without adding the fact to
   * `posting-detail.tsx` makes it unreachable on the device the change is for.**
   *
   * Two consequences of `table-fixed`, neither needing a fix: the percentages no
   * longer total 90% (a `display: none` cell contributes no column, and the
   * slack goes to the rest in proportion), and {@link POSTING_COLSPAN} stays 11
   * (an over-wide `colSpan` is clamped rather than inventing a twelfth column).
   */
  visibility?: string
}

/**
 * The two points at which a column stops being rendered. Named because
 * `posting-table-body.tsx` and `posting-table-skeleton.tsx` hand-write their
 * cells in this array's order and all three files must spell the same class.
 *
 * `md:table-cell`, not `md:block`: these are `<th>`/`<td>`, and a block takes
 * one out of the table's layout rather than returning it to the row.
 *
 * Plain CSS and deliberately not `use-mobile`'s hook — a media query read in
 * JavaScript renders differently on the server, and the header row is a server
 * component.
 */
export const POSTING_HIDE_BELOW_MD = "hidden md:table-cell"
export const POSTING_HIDE_BELOW_LG = "hidden lg:table-cell"

/**
 * ⚠️ **Which columns hide is a judgement about what a row is *for*.** Title,
 * Match and the letter column stay at every width; Location, Posted and Source
 * answer questions about one posting, which is what expanding it is for.
 *
 * Status hides below `md` even though it is per-row state: a fourth mobile
 * column comes out of Title, and its value is already in the detail panel by
 * construction — `PostingStatusSelect` lives there and shows it as trigger text.
 *
 * ⚠️ **Company hides but moves into the title cell rather than the panel** — it
 * is half of how a row is identified at a glance. See `posting-table-body.tsx`.
 *
 * ⚠️ **A percentage is a share of the *table*, not of what is left.** Slack from
 * hidden columns is redistributed in proportion, so a column that was narrow to
 * begin with stays narrow — `w-[17%]` of a 358px table is 61px, and 61px of
 * Company is "Meri…".
 */
export const POSTING_COLUMNS: readonly PostingColumn[] = [
  { key: "title", label: "Title", width: "w-[40%] md:w-[21%]", sort: "title" },
  {
    key: "company",
    label: "Company",
    width: "w-[13%]",
    sort: "company",
    visibility: POSTING_HIDE_BELOW_MD,
  },
  {
    key: "location",
    label: "Location",
    width: "w-[11%]",
    visibility: POSTING_HIDE_BELOW_MD,
  },
  {
    key: "match",
    label: "Match",
    width: "w-[12%] md:w-[10%]",
    sort: "match",
  },
  {
    key: "postedAt",
    label: "Posted",
    width: "w-[9%]",
    sort: "posted",
    visibility: POSTING_HIDE_BELOW_MD,
  },
  {
    key: "source",
    label: "Source",
    width: "w-[8%]",
    visibility: POSTING_HIDE_BELOW_LG,
  },
  /**
   * ⚠️ **10% and not 8%, because the badge sets the floor rather than the
   * heading.** "Rejected" in a `text-xs` `Badge` plus `px-2` is ≈69px, and with
   * the cell's `p-2` an 85px floor; `Badge` is `whitespace-nowrap` and
   * `overflow-hidden`, so being under it clips the word rather than wrapping.
   *
   * Display-only because `PostingOrder` in `@workspace/db` is closed on purpose
   * — a sortable heading here is a migration, not a `sort` key.
   */
  {
    key: "status",
    label: "Status",
    width: "w-[10%]",
    visibility: POSTING_HIDE_BELOW_MD,
  },
  {
    key: "letter",
    label: "Cover letter",
    shortLabel: "Letter",
    width: "w-[18%] md:w-[8%]",
  },
]

/**
 * The width of the three cells that carry controls rather than a heading, in
 * the order they are rendered: the selection checkbox, the disclosure chevron,
 * and the row's delete control.
 *
 * Here rather than in three components: the header, every body row and the
 * skeleton must agree, and under `table-fixed` a disagreement is a visible jump.
 *
 * ⚠️ **These are why the mobile percentages are declared rather than left to
 * work themselves out.** Slack is handed out roughly evenly, so hiding four
 * columns fed a quarter of the reclaimed space to each of *these three* and the
 * controls ended up holding half the table.
 */
export const POSTING_SELECT_WIDTH = "w-8"
export const POSTING_EXPAND_WIDTH = "w-8"
export const POSTING_ACTIONS_WIDTH = "w-10 md:w-12"

/**
 * How tall one body row is, header excluded.
 *
 * ⚠️ **Uniform, and that is the point.** The title wraps to two lines, so
 * without a declared height the skeleton would have to guess which of
 * twenty-five rows are tall. 56px = the 44px the `size-7` icon buttons need plus
 * a second title line.
 *
 * ⚠️ **72px below `md`, because the company moves into the title cell there** —
 * two clamped `text-sm` lines (40px) plus one `text-xs` line (16px) plus `p-2`.
 * Shrinking this back to a single value re-clips the company line.
 */
export const POSTING_ROW_HEIGHT = "h-18 md:h-14"

/**
 * The cells the table renders outside {@link POSTING_COLUMNS}: the selection
 * checkbox, the disclosure chevron, and the row's delete control. Named rather
 * than a bare `+ 3`, which says nothing about what would change it.
 */
const FIXED_CELLS = 3

/**
 * How wide the expanded detail row is.
 *
 * Derived from the array plus {@link FIXED_CELLS}, so a column added cannot
 * leave the detail row behind.
 *
 * ⚠️ **Every column, including the ones a narrow viewport does not render** —
 * "visible" is a media query and this number becomes an HTML attribute. Under
 * `table-fixed` the excess is clamped; see {@link PostingColumn.visibility}.
 */
export const POSTING_COLSPAN = POSTING_COLUMNS.length + FIXED_CELLS
