import type { CoverLetterPromise } from "@/components/jobs/postings/cover-letter-cell"
import type { TailoredResumePromise } from "@/components/jobs/postings/use-tailored-resume"
import { PostingBulkBar } from "@/components/jobs/postings/posting-bulk-bar"
import { PostingColumnHeading } from "@/components/jobs/postings/posting-column-heading"
import { PostingPagination } from "@/components/jobs/postings/posting-pagination"
import { PostingSelectAll } from "@/components/jobs/postings/posting-select-all"
import { PostingSelectionProvider } from "@/components/jobs/postings/posting-selection"
import { PostingSortHeader } from "@/components/jobs/postings/posting-sort-header"
import { PostingTableBody } from "@/components/jobs/postings/posting-table-body"
import type { PostingPage } from "@/lib/postings/list-postings"
import {
  POSTING_ACTIONS_WIDTH,
  POSTING_COLUMNS,
  POSTING_EXPAND_WIDTH,
} from "@/lib/postings/posting-columns"
import type { PostingQuery } from "@/lib/postings/posting-query"
import {
  postingsEmptyState,
  POSTINGS_EMPTY_MESSAGES,
  type BriefingCounts,
} from "@/lib/postings/postings-empty-state"
import { Empty, EmptyDescription } from "@workspace/ui/components/empty"
import {
  Table,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"
import { cn } from "@workspace/ui/lib/utils"

/**
 * Every Posting this user's briefings have ever found, one row each.
 *
 * A server component for the shell: sorting and paging are `<Link>`s, so no
 * table state lives on the client. The body is a client boundary only so one
 * posting can expand without turning every open/close into a navigation.
 *
 * "Ever found" is the point: the cards this replaced rendered one Run's
 * findings, so an advertisement the next Run missed vanished — taking any
 * status the user had set with it.
 *
 * Headings come from `POSTING_COLUMNS`, which also keeps the detail row's
 * `colSpan` in step — see `lib/postings/posting-columns.ts`.
 */
export function PostingTable({
  page,
  query,
  letters,
  tailoredResumes,
  counts,
}: {
  page: PostingPage
  query: PostingQuery
  /**
   * The user's drafted letters, still in flight.
   *
   * ⚠️ **A promise, and it is not awaited anywhere on the way to the cells that
   * need it.** Reading it here — or in the body — would put the whole table
   * behind a page's worth of S3 round trips, which is exactly the wait this
   * shape exists to remove. See `cover-letter-cell.tsx`.
   */
  letters: CoverLetterPromise
  /**
   * The user's tailored resumes, still in flight.
   *
   * ⚠️ **A second promise rather than one merged object.** The two are read
   * from two different prefixes by two independent requests, so they fail
   * independently, and each section of the detail reports its own failure. It
   * is likewise never awaited on the way down. See `use-tailored-resume.ts`.
   */
  tailoredResumes: TailoredResumePromise
  /**
   * What the strip knows, for choosing among the three empty states.
   *
   * `undefined` when that load failed, which is why it is optional here rather
   * than defaulted to zeroes — see `postings-empty-state.ts`.
   */
  counts?: BriefingCounts
}) {
  if (page.total === 0) {
    return (
      <Empty>
        <EmptyDescription>
          {/*
            `page.hidden` is passed because "empty" has a fourth cause now: the
            user's own filters took every row. Telling them their briefings
            found nothing would send them to widen a search that is working.
          */}
          {POSTINGS_EMPTY_MESSAGES[postingsEmptyState(counts, page.hidden)]}
        </EmptyDescription>
      </Empty>
    )
  }

  return (
    /*
      The one client boundary this shell needs, and it wraps rather than
      replaces the server-rendered table: the bulk bar sits above the `<Table>`
      and the checkboxes inside it, so the shared selection can live in neither.
      Everything below is still server-rendered and passed through as children.
    */
    <PostingSelectionProvider ids={page.postings.map((posting) => posting.id)}>
      <div className="flex flex-col gap-4">
        <PostingBulkBar letters={letters} tailoredResumes={tailoredResumes} />

        <div className="rounded-lg border">
          {/*
            ⚠️ `table-fixed`, and `posting-table-skeleton.tsx` says it too.
            Dropping it reverts to content-measured columns, and the skeleton
            silently stops matching.
          */}
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <PostingSelectAll />

                {/*
                  An empty `<th>` leaves a screen reader with an unnamed column,
                  so the disclosure column is named once here; the per-row
                  chevrons carry each posting's own title.
                */}
                <TableHead className={POSTING_EXPAND_WIDTH}>
                  <span className="sr-only">Expand</span>
                </TableHead>

                {/*
                  ⚠️ `column.visibility` is half of a pair: the matching `<td>`
                  in `posting-table-body.tsx` carries the same class, and hiding
                  one without the other leaves the row a column out of step.
                */}
                {POSTING_COLUMNS.map((column) =>
                  column.sort === undefined ? (
                    <TableHead
                      key={column.key}
                      className={cn(column.width, column.visibility)}
                    >
                      <PostingColumnHeading column={column} />
                    </TableHead>
                  ) : (
                    <PostingSortHeader
                      key={column.key}
                      column={column.sort}
                      label={<PostingColumnHeading column={column} />}
                      width={column.width}
                      visibility={column.visibility}
                      query={query}
                    />
                  )
                )}

                {/* Named for the same reason the disclosure column is. */}
                <TableHead className={POSTING_ACTIONS_WIDTH}>
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>

            <PostingTableBody
              postings={page.postings}
              letters={letters}
              tailoredResumes={tailoredResumes}
            />
          </Table>
        </div>

        <PostingPagination page={page} query={query} />
      </div>
    </PostingSelectionProvider>
  )
}
