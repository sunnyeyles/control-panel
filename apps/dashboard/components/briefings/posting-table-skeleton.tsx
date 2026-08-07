import {
  POSTING_COLUMNS,
  POSTING_COLSPAN,
} from "@/lib/postings/posting-columns"
import { Skeleton } from "@workspace/ui/components/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@workspace/ui/components/table"

/**
 * The table's shape, with no data in it.
 *
 * ⚠️ **Two callers, and they must not drift**: `app/(app)/briefings/loading.tsx`
 * shows it while the route's server render is in flight, and `page.tsx` shows it
 * inside the `<Suspense>` the postings query sits behind. Those are consecutive
 * moments in the same navigation — the route-level fallback is replaced by the
 * page's shell, which shows this again until the rows arrive — so two
 * hand-written skeletons would visibly disagree with each other mid-click.
 *
 * ⚠️ **The real headings, not grey bars where headings go.** They come from
 * `POSTING_COLUMNS`, the same array the real table reads, so the column layout
 * under the fallback is the layout the rows land in and nothing shifts sideways
 * when they do. They are plain text rather than `PostingSortHeader`s because a
 * heading that looks clickable and is not is worse than one that does not.
 *
 * Deliberately not in `@workspace/ui`: it knows this table's columns, which is
 * exactly the kind of thing the shared package has none of.
 */
export function PostingTableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading postings"
      className="flex flex-col gap-4"
    >
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              {/* The selection checkbox and the disclosure chevron. */}
              <TableHead className="w-8" />
              <TableHead className="w-8" />

              {POSTING_COLUMNS.map((column) => (
                <TableHead key={column.key}>{column.label}</TableHead>
              ))}

              {/* The delete control. */}
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>

          <TableBody>
            {Array.from({ length: rows }, (_, index) => (
              <TableRow key={index}>
                <TableCell colSpan={POSTING_COLSPAN}>
                  <Skeleton className="h-5 w-full" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
