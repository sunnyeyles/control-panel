import { PostingColumnHeading } from "@/components/jobs/postings/posting-column-heading"
import {
  POSTING_ACTIONS_WIDTH,
  POSTING_COLUMNS,
  POSTING_EXPAND_WIDTH,
  POSTING_HIDE_BELOW_LG,
  POSTING_HIDE_BELOW_MD,
  POSTING_ROW_HEIGHT,
  POSTING_SELECT_WIDTH,
} from "@/lib/postings/posting-columns"
import { PAGE_SIZE } from "@/lib/postings/posting-query"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"

/**
 * The table's shape, with no data in it.
 *
 * ⚠️ **Two callers that must not drift**: `app/(app)/jobs/loading.tsx` during
 * the route's server render, then `page.tsx` inside the postings `<Suspense>`.
 * Those are consecutive moments in one navigation, so two hand-written
 * skeletons would visibly disagree mid-click.
 *
 * ⚠️ **The same geometry as `posting-table.tsx`, not merely the same idea** —
 * each correspondence below was a visible jump before it existed: `table-fixed`
 * plus the `POSTING_COLUMNS` widths (under the default `table-auto` this is
 * unachievable in principle, since widths are measured from content and a
 * skeleton has none), `POSTING_ROW_HEIGHT` on {@link PAGE_SIZE} rows, the same
 * columns — fewer than eight below `lg`, see `PostingColumn.visibility` — and
 * the bulk bar's empty 36px above with the pager's line below.
 *
 * The headings are real, from `POSTING_COLUMNS`, but plain text rather than
 * `PostingSortHeader`s: a sortable heading is ~28px wider than its label and
 * used to drag the column with it.
 *
 * Deliberately not in `@workspace/ui`: it knows this table's columns.
 */
export function PostingTableSkeleton({
  rows = PAGE_SIZE,
}: {
  /**
   * How many placeholder rows to draw.
   *
   * A full page by default: the two errors are not symmetrical. Extra rows fall
   * below the fold of the `overflow-y-auto` `<main>` unseen, where too few
   * leaves a mid-viewport gap the arriving rows visibly fill. Neither this nor
   * `loading.tsx` can know the total, so overshooting is the cheaper mistake.
   */
  rows?: number
}) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading postings"
      className="flex flex-col gap-4"
    >
      {/*
        Genuinely empty rather than a guess: `PostingBulkBar` renders this exact
        box and nothing inside it until a row is ticked.
      */}
      <div className="flex min-h-9 items-center gap-2" />

      <div className="rounded-lg border">
        <Table className="table-fixed">
          <TableHeader>
            <TableRow>
              {/* The selection checkbox and the disclosure chevron. */}
              <TableHead className={POSTING_SELECT_WIDTH} />
              <TableHead className={POSTING_EXPAND_WIDTH} />

              {POSTING_COLUMNS.map((column) => (
                <TableHead
                  key={column.key}
                  className={cn(column.width, column.visibility)}
                >
                  <PostingColumnHeading column={column} />
                </TableHead>
              ))}

              {/* The delete control. */}
              <TableHead className={POSTING_ACTIONS_WIDTH} />
            </TableRow>
          </TableHeader>

          <TableBody>
            {Array.from({ length: rows }, (_, index) => (
              <PlaceholderRow key={index} index={index} />
            ))}
          </TableBody>
        </Table>
      </div>

      {/*
        `min-h-7` is the height of the `size="sm"` Previous/Next buttons. It
        sits below the table, so being a few pixels out moves nothing above it.
      */}
      <nav
        aria-hidden="true"
        className="flex min-h-7 flex-wrap items-center justify-between gap-2"
      >
        <Skeleton className="h-5 w-56" />
      </nav>
    </div>
  )
}

/**
 * How wide the bar in each text column is, cycled by row.
 *
 * ⚠️ A fixed cycle, not `Math.random()`: random widths render different markup
 * on the server and in the browser, which React reports as a hydration mismatch
 * rather than the cosmetic choice it was meant to be.
 *
 * ⚠️ Whole class names, never composed from fragments — Tailwind v4 scans
 * source for literal strings, so a width built at runtime has no CSS behind it.
 *
 * Seven fields, not eight: the cover-letter column holds an icon. Match and
 * Status use fixed widths rather than column fractions, since both vary over a
 * known, narrow range of content.
 */
const BAR_WIDTHS: readonly {
  title: string
  company: string
  location: string
  match: string
  posted: string
  source: string
  status: string
}[] = [
  {
    title: "w-4/5",
    company: "w-3/5",
    location: "w-2/3",
    match: "w-6",
    posted: "w-4/5",
    source: "w-14",
    status: "w-16",
  },
  {
    title: "w-2/3",
    company: "w-4/5",
    location: "w-1/2",
    match: "w-5",
    posted: "w-3/4",
    source: "w-12",
    status: "w-11",
  },
  {
    title: "w-11/12",
    company: "w-1/2",
    location: "w-3/4",
    match: "w-6",
    posted: "w-4/5",
    source: "w-16",
    status: "w-11",
  },
  {
    title: "w-3/4",
    company: "w-2/3",
    location: "w-3/5",
    match: "w-5",
    posted: "w-2/3",
    source: "w-12",
    status: "w-16",
  },
]

/** Never `undefined`, which `noUncheckedIndexedAccess` cannot know on its own. */
const FIRST_BAR_WIDTHS = BAR_WIDTHS[0]!

/**
 * One placeholder row, cell for cell against `PostingRow` in
 * `posting-table-body.tsx`.
 *
 * The bars are `h-4` — one line of `text-sm` — and the row's height comes from
 * `POSTING_ROW_HEIGHT` rather than from them, as the real row's does.
 */
function PlaceholderRow({ index }: { index: number }) {
  const widths = BAR_WIDTHS[index % BAR_WIDTHS.length] ?? FIRST_BAR_WIDTHS

  return (
    <TableRow className={POSTING_ROW_HEIGHT}>
      <TableCell className={POSTING_SELECT_WIDTH}>
        <Skeleton className="size-4" />
      </TableCell>

      <TableCell className={POSTING_EXPAND_WIDTH}>
        <Skeleton className="size-4" />
      </TableCell>

      {/*
        Two bars below `md`, one above: the company moves into this cell when
        its own column stops being rendered, so the fallback stacks the way the
        row does. `POSTING_ROW_HEIGHT` grows at the same breakpoint.
      */}
      <TableCell>
        <div className="flex flex-col gap-1.5">
          <Skeleton className={cn("h-4", widths.title)} />
          <Skeleton className={cn("h-3 md:hidden", widths.company)} />
        </div>
      </TableCell>

      <TableCell className={POSTING_HIDE_BELOW_MD}>
        <Skeleton className={cn("h-4", widths.company)} />
      </TableCell>

      {/*
        ⚠️ The same cells `PostingRow` hides, at the same two widths. Not an
        optimisation — a placeholder drawing a column the arriving rows do not
        is the sideways jump this file exists to prevent.
      */}
      <TableCell className={POSTING_HIDE_BELOW_MD}>
        <Skeleton className={cn("h-4", widths.location)} />
      </TableCell>

      {/*
        No visibility class: Match is one of the three columns rendered at every
        width — see `POSTING_COLUMNS`.
      */}
      <TableCell>
        <Skeleton className={cn("h-4", widths.match)} />
      </TableCell>

      <TableCell className={POSTING_HIDE_BELOW_MD}>
        <Skeleton className={cn("h-4", widths.posted)} />
      </TableCell>

      {/* A `Badge`, which is neither the height nor the shape of a line. */}
      <TableCell className={POSTING_HIDE_BELOW_LG}>
        <Skeleton className={cn("h-5 rounded-4xl", widths.source)} />
      </TableCell>

      {/* Also a `Badge` — see `posting-status-badge.tsx`. */}
      <TableCell className={POSTING_HIDE_BELOW_MD}>
        <Skeleton className={cn("h-5 rounded-4xl", widths.status)} />
      </TableCell>

      {/* The letter cell, whose content is a `size-4` icon either way. */}
      <TableCell>
        <Skeleton className="size-4" />
      </TableCell>

      <TableCell className={POSTING_ACTIONS_WIDTH}>
        <Skeleton className="size-4" />
      </TableCell>
    </TableRow>
  )
}
