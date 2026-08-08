import { PostingColumnHeading } from "@/components/briefings/posting-column-heading"
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
 * ⚠️ **Two callers, and they must not drift**: `app/(app)/jobs/loading.tsx`
 * shows it while the route's server render is in flight, and `page.tsx` shows it
 * inside the `<Suspense>` the postings query sits behind. Those are consecutive
 * moments in the same navigation — the route-level fallback is replaced by the
 * page's shell, which shows this again until the rows arrive — so two
 * hand-written skeletons would visibly disagree with each other mid-click.
 *
 * ⚠️ **It has to be the same geometry as `posting-table.tsx`, not merely the
 * same idea.** Everything below is a specific correspondence with that file, and
 * each one was a visible jump before it existed:
 *
 * - `table-fixed` and the widths from `POSTING_COLUMNS`, so columns do not
 *   reflow sideways when the rows land. Under the default `table-auto` this is
 *   unachievable in principle — column widths are measured from content, and a
 *   skeleton has none.
 * - `POSTING_ROW_HEIGHT` on every row, and {@link PAGE_SIZE} of them.
 * - **The same columns, which below `lg` is fewer than six.** Location, Posted
 *   and Source stop being rendered on a narrow viewport — see
 *   `PostingColumn.visibility` — and a skeleton that kept them would be a
 *   different table from the one replacing it, on exactly the viewport where
 *   the difference is widest.
 * - The bulk bar's empty 36px above, and the pager's line below.
 *
 * ⚠️ **The real headings, not grey bars where headings go.** They come from
 * `POSTING_COLUMNS`, the same array the real table reads. They are plain text
 * rather than `PostingSortHeader`s because a heading that looks clickable and is
 * not is worse than one that does not — and the declared widths are what make
 * that safe, since a sortable heading is about 28px wider than its own label and
 * used to drag the column with it.
 *
 * Deliberately not in `@workspace/ui`: it knows this table's columns, which is
 * exactly the kind of thing the shared package has none of.
 */
export function PostingTableSkeleton({
  rows = PAGE_SIZE,
}: {
  /**
   * How many placeholder rows to draw.
   *
   * A full page by default, because the two errors are not symmetrical.
   * `<main>` is `overflow-y-auto` inside an `h-svh` inset, so rows drawn past
   * the end of a short page fall below the fold and collapse unseen — while
   * drawing too few leaves a gap in the middle of the viewport that the arriving
   * rows visibly fill. Neither this component nor `loading.tsx` can know the
   * total; overshooting is the cheaper way to be wrong.
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
        The bulk bar, which is genuinely empty rather than a guess at one:
        `PostingBulkBar` renders this exact box and nothing inside it until a row
        is ticked, and reserves the height for the same reason repeated here.
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
        The pager. `min-h-7` is the height of the `size="sm"` Previous/Next
        buttons, which is what the real `<nav>` is as tall as whenever there is
        more than one page. It sits below the table, so being a few pixels out on
        a single-page table moves nothing above it.
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
 * Rows of identical bars read as a loading *pattern* rather than as a table, so
 * the widths vary — but from a fixed cycle rather than at random, because a
 * `Math.random()` here would render different markup on the server and in the
 * browser, and React reports that as a hydration mismatch rather than as the
 * cosmetic choice it was meant to be.
 *
 * Written out as whole class names, not composed from fragments: Tailwind v4
 * finds classes by scanning the source for literal strings, so a width built at
 * runtime is a width with no CSS behind it.
 *
 * Five fields and not six — the cover-letter column holds a `size-4` icon rather
 * than text, so it has nothing to vary.
 */
const BAR_WIDTHS: readonly {
  title: string
  company: string
  location: string
  posted: string
  source: string
}[] = [
  {
    title: "w-4/5",
    company: "w-3/5",
    location: "w-2/3",
    posted: "w-4/5",
    source: "w-14",
  },
  {
    title: "w-2/3",
    company: "w-4/5",
    location: "w-1/2",
    posted: "w-3/4",
    source: "w-12",
  },
  {
    title: "w-11/12",
    company: "w-1/2",
    location: "w-3/4",
    posted: "w-4/5",
    source: "w-16",
  },
  {
    title: "w-3/4",
    company: "w-2/3",
    location: "w-3/5",
    posted: "w-2/3",
    source: "w-12",
  },
]

/** Never `undefined`, which `noUncheckedIndexedAccess` cannot know on its own. */
const FIRST_BAR_WIDTHS = BAR_WIDTHS[0]!

/**
 * One placeholder row, cell for cell against `PostingRow` in
 * `posting-table-body.tsx`.
 *
 * The bars are `h-4` — one line of the table's `text-sm` — and the row's height
 * comes from `POSTING_ROW_HEIGHT` rather than from them, exactly as the real
 * row's does.
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
        Two bars below `md`, one above it: the company moves into this cell when
        its own column stops being rendered, so the fallback has to stack the
        same way the row does. `POSTING_ROW_HEIGHT` grows at the same breakpoint
        for the same reason.
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
        ⚠️ **The same three cells `PostingRow` hides, at the same two widths.**
        Not an optimisation — the skeleton's whole job is to occupy the geometry
        the rows will, so a placeholder still drawing a Source column that the
        arriving rows do not is the sideways jump this file exists to prevent.
      */}
      <TableCell className={POSTING_HIDE_BELOW_MD}>
        <Skeleton className={cn("h-4", widths.location)} />
      </TableCell>

      <TableCell className={POSTING_HIDE_BELOW_MD}>
        <Skeleton className={cn("h-4", widths.posted)} />
      </TableCell>

      {/* A `Badge`, which is neither the height nor the shape of a line. */}
      <TableCell className={POSTING_HIDE_BELOW_LG}>
        <Skeleton className={cn("h-5 rounded-4xl", widths.source)} />
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
