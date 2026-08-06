import type { CoverLetterPromise } from "@/components/briefings/cover-letter-cell"
import { PostingPagination } from "@/components/briefings/posting-pagination"
import { PostingSortHeader } from "@/components/briefings/posting-sort-header"
import { PostingTableBody } from "@/components/briefings/posting-table-body"
import type { PostingPage } from "@/lib/postings/list-postings"
import { POSTING_COLUMNS } from "@/lib/postings/posting-columns"
import type { PostingQuery } from "@/lib/postings/posting-query"
import {
  postingsEmptyState,
  POSTINGS_EMPTY_MESSAGES,
  type BriefingCounts,
} from "@/lib/postings/postings-empty-state"
import {
  Table,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

/**
 * Every Posting this user's briefings have ever found, one row each.
 *
 * A server component for the shell: sorting and paging are `<Link>`s, so there
 * is no table state on the client for those and nothing to keep in step with
 * the URL. The body is a client boundary only so one posting can expand
 * without turning every open/close into a navigation.
 *
 * "Ever found" is the change this whole feature is for. The cards this replaced
 * rendered one Run's findings, so an advertisement the next Run did not re-find
 * simply vanished — taking any status the user had set with it.
 *
 * **The headings come from `POSTING_COLUMNS` rather than being written out
 * here.** They used to be seven literal `<TableHead>`s, with the detail row's
 * `colSpan` kept in step by hand from a constant in a different file. See
 * `lib/postings/posting-columns.ts`.
 */
export function PostingTable({
  page,
  query,
  letters,
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
   * What the strip knows, for choosing among the three empty states.
   *
   * `undefined` when that load failed, which is why it is optional here rather
   * than defaulted to zeroes — see `postings-empty-state.ts`.
   */
  counts?: BriefingCounts
}) {
  if (page.total === 0) {
    return (
      <div className="rounded-lg border border-dashed p-8 text-center">
        <p className="text-sm text-muted-foreground">
          {POSTINGS_EMPTY_MESSAGES[postingsEmptyState(counts)]}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {/*
                The disclosure column. It has no heading worth reading aloud
                twenty-five times, but an empty `<th>` leaves a screen reader
                with an unnamed column — so it is named once here, and the
                per-row chevrons carry each posting's own title.
              */}
              <TableHead className="w-8">
                <span className="sr-only">Expand</span>
              </TableHead>

              {POSTING_COLUMNS.map((column) =>
                column.sort === undefined ? (
                  <TableHead key={column.key}>{column.label}</TableHead>
                ) : (
                  <PostingSortHeader
                    key={column.key}
                    column={column.sort}
                    label={column.label}
                    query={query}
                  />
                )
              )}
            </TableRow>
          </TableHeader>

          <PostingTableBody postings={page.postings} letters={letters} />
        </Table>
      </div>

      <PostingPagination page={page} query={query} />
    </div>
  )
}
