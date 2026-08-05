import { PostingPagination } from "@/components/briefings/posting-pagination"
import { PostingRow } from "@/components/briefings/posting-row"
import { PostingSortHeader } from "@/components/briefings/posting-sort-header"
import type { CoverLetterSummary } from "@/lib/cover-letters/list-cover-letters"
import type { PostingPage } from "@/lib/postings/list-postings"
import type { PostingQuery } from "@/lib/postings/posting-query"
import {
  postingsEmptyState,
  POSTINGS_EMPTY_MESSAGES,
  type BriefingCounts,
} from "@/lib/postings/postings-empty-state"
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

/**
 * Every Posting this user's briefings have ever found, one row each.
 *
 * A server component throughout: sorting and paging are `<Link>`s, so there is
 * no table state on the client and nothing to keep in step with the URL.
 *
 * "Ever found" is the change this whole feature is for. The cards this replaced
 * rendered one Run's findings, so an advertisement the next Run did not re-find
 * simply vanished — taking any status the user had set with it.
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
   * The letters this user has already drafted, keyed by Posting id.
   *
   * Keyed rather than a list because the question each row asks is "is there
   * one for *this* Posting", and a linear scan per row would make the page
   * quadratic in a user's drafting history for no reason. Empty when the
   * letters could not be read — a storage failure degrades to rows with no
   * letter rather than to no table.
   */
  letters?: ReadonlyMap<string, CoverLetterSummary>
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
              <PostingSortHeader column="title" label="Title" query={query} />
              <PostingSortHeader
                column="company"
                label="Company"
                query={query}
              />
              {/*
                Displayed, not sortable. Nobody orders a job search by the
                spelling of a suburb, and a header that sorts is a promise the
                column has an order worth having.
              */}
              <TableHead>Location</TableHead>
              <PostingSortHeader column="status" label="Status" query={query} />
              <PostingSortHeader
                column="firstSeen"
                label="First seen"
                query={query}
              />
              <PostingSortHeader
                column="lastSeen"
                label="Last seen"
                query={query}
              />
              <TableHead>Cover letter</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {page.postings.map((posting) => (
              <PostingRow
                key={posting.id}
                posting={posting}
                letter={letters?.get(posting.id)}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      <PostingPagination page={page} query={query} />
    </div>
  )
}
