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
   * A shorter heading for when the column is too narrow for {@link label}.
   * Absent when the label already fits at every width.
   *
   * ⚠️ **This is not a nicety — a heading that does not fit is a heading that
   * overlaps the next column.** `TableHead` is `whitespace-nowrap`, so a `<th>`
   * narrower than its own words spills sideways rather than wrapping or
   * truncating, and "Cover letter" in a 67px column ran clean across the delete
   * control beside it. The floor on a column is the width of its heading, which
   * is why this field exists rather than a narrower percentage.
   *
   * Swapped in CSS, not chosen in JavaScript: both spellings are rendered and
   * one is hidden, so the header stays a server component with no breakpoint in
   * its logic. See `PostingColumnHeading`.
   */
  shortLabel?: string
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
   * ⚠️ **Below `md` a second set of percentages applies, and they have to add
   * up on their own.** Only Title, Match and the letter column are still
   * rendered there, and their `lg` shares — 21%, 10% and 8% — describe a table
   * with five more columns in it. Left at those, 39% of the width would be
   * claimed and the other 61% would be slack the browser spreads across every
   * column including the three control cells; measured on a 390px viewport an
   * earlier version of exactly that produced a 97px Title, a letter column too
   * narrow for its own heading, and half the table spent on a checkbox, a
   * chevron and a bin.
   *
   * So the mobile set is sized against the space that actually exists. On a
   * 356px table: 32 + 32 + 40 for the control cells leaves 252px, which is 40%
   * for Title (≈142px), 12% for Match (≈43px, enough for a two- or three-digit
   * number) and 18% for the letter column (≈64px, against the ≈59px "Letter"
   * plus `px-2` needs). **Check both sums when changing either.** A column whose
   * share leaves slack does not simply render narrow — it makes every other
   * column wrong too.
   *
   * The floor on each is its own heading: `TableHead` is `whitespace-nowrap`, so
   * a column narrower than the words in it spills rather than wrapping. "Cover
   * letter" is the longest and is why that column carries a `shortLabel` rather
   * than a wider share; "Match" is short enough to need neither.
   *
   * ⚠️ **Status is the exception, and it is the *cell* that sets its floor.** It
   * renders a `Badge` rather than text, and "Rejected" inside one is wider than
   * the word "Status" above it — so sizing that column against its heading
   * clips its own values. See its entry in {@link POSTING_COLUMNS}.
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
   * ⚠️ **Eleven cells do not fit on a phone.** At 375px each of them is under
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
   *   declared widths — so below `md` the 40/12/18 ratio fills the row and
   *   Title stays the widest thing on screen. A per-breakpoint width would be
   *   three more numbers to keep in step with the skeleton for no visible
   *   gain.
   * - **{@link POSTING_COLSPAN} stays 11.** CSS cannot vary an attribute, and
   *   under `table-fixed` the column count is fixed by the first row — so a
   *   `colSpan` wider than the visible columns is clamped to the row rather
   *   than inventing a phantom twelfth one. Computing a smaller number from a
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
 * ⚠️ **Which columns hide is a judgement about what a row is *for*.** Title is
 * how somebody recognises an advertisement they have already seen; Match is the
 * reason to scan the page at all; and the letter column is the only per-row
 * state worth scanning for. Those three stay at every width. Location, Posted
 * and Source answer questions about one posting, which is what expanding it is
 * for.
 *
 * ⚠️ **Status hides below `md`, and the rule about unreachability is already
 * satisfied there.** It is per-row state and by that measure belongs beside the
 * letter column at every width — but the mobile percentages below already add up
 * against the three control cells, so a fourth column on a phone comes out of
 * Title, and 26% of a 356px table is the 92px that made the first attempt at
 * this unreadable. What decides it is that Status is the one column whose value
 * is in the detail panel *by construction*: `PostingStatusSelect` is the control
 * that sets it, it is rendered there and only there, and it shows the current
 * value as its own trigger text. So below `md` the fact is one tap away without
 * anything being added to `posting-detail.tsx` — unlike Location, Posted and
 * Source, each of which needed a section written for it.
 *
 * ⚠️ **Company hides but does not go to the detail panel — it moves into the
 * title cell.** A column and a stacked line are not the same trade. The other
 * three are facts somebody looks up about one posting; the company is half of
 * how a row is identified at a glance, and a page of titles with no employers
 * beside them is not a shorter table, it is a table missing a field. So below
 * `md` it is rendered under the title in the same cell — see the title cell in
 * `posting-table-body.tsx`.
 *
 * ⚠️ **A percentage is a share of the *table*, not of what is left.** This is
 * what made the first attempt at this unreadable: with the other columns gone,
 * `w-[17%]` of a 358px table is 61px, and 61px of Company is "Meri…". The slack
 * from the hidden columns is redistributed in proportion to the widths that
 * remain, so Title and the letter column grow — but a column that was narrow to
 * begin with stays narrow, and no amount of hiding fixes it.
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
   * heading.** Every other column here is bounded by its own `<th>` — see
   * {@link PostingColumn.shortLabel} — but this one renders a `Badge`, whose
   * `text-xs` "Rejected" plus its `px-2` is about 69px, against about 46px for
   * the word "Status". With the cell's own `p-2` that is an 85px floor, and 8%
   * of a `max-w-6xl` table is 92px before the sidebar is open. `Badge` is
   * `whitespace-nowrap` and `overflow-hidden`, so being under it clips the word
   * rather than wrapping it.
   *
   * Display-only, and unlike Location and Source that is not a statement about
   * whether the order would be useful. `PostingOrder` in `@workspace/db` is
   * closed on purpose — "adding one is a decision about the index, not a
   * convenience" — so a sortable heading here is a migration, not a `sort` key.
   * See `posting-query.ts`, which used to carry a `status` sort for exactly this
   * column.
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
 * Here rather than written into three components, for the same reason
 * {@link POSTING_COLUMNS} carries its own: the header row, every body row and
 * the loading skeleton all have to agree on them, and under `table-fixed` a
 * disagreement is a visible jump rather than a silent no-op.
 *
 * ⚠️ **These are why the mobile percentages are declared rather than left to
 * work themselves out.** When declared widths total less than the table, the
 * browser hands the slack out roughly evenly — so hiding four columns fed a
 * quarter of the reclaimed space to each of *these three*, and the controls
 * ended up holding half the table while the title stayed at 97px. Declaring
 * mobile widths that already add up leaves no slack to misallocate.
 */
export const POSTING_SELECT_WIDTH = "w-8"
export const POSTING_EXPAND_WIDTH = "w-8"
export const POSTING_ACTIONS_WIDTH = "w-10 md:w-12"

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
 *
 * ⚠️ **72px below `md`, because the title cell carries a third line there.**
 * That is where the company moves when its own column stops being rendered —
 * two clamped lines of `text-sm` title (40px) plus one of `text-xs` company
 * (16px) plus the cell's `p-2` (16px). Uniform at each width, which is all the
 * skeleton needs; it reads this same constant, so the two heights cannot drift.
 * Shrinking this back to a single value re-clips the company line.
 */
export const POSTING_ROW_HEIGHT = "h-18 md:h-14"

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
