import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Stands in for {@link DocumentList} while the listing is in flight.
 *
 * Shaped against the real markup — `DocumentList` renders a `rounded-lg border`
 * box around a `<Table>` with a header row and one row per document — so the
 * border and the row rhythm are here rather than a single grey block. A
 * fallback that reserves the wrong height is worse than one that reserves none,
 * because the content arriving then shifts everything below it.
 *
 * **Only the page's `<Suspense>` draws this, unlike the two skeletons under
 * `/jobs`.** `/documents` has no `loading.tsx` of its own and should not grow
 * one: it inherits `app/(app)/loading.tsx`, which is deliberately shape-agnostic
 * because one file covers a chat, a document list and a settings panel.
 *
 * `rows` is a guess at how many documents someone has, which is why it is a
 * parameter and not a constant: three is a reasonable shelf, and the empty
 * state is one line rather than three, so no number is right for both.
 */
export function DocumentListSkeleton({ rows }: { rows: number }) {
  return (
    <div
      aria-busy="true"
      aria-label="Loading your documents"
      className="rounded-lg border"
    >
      {/* The header row, which carries the same padding as a body row. */}
      <div className="border-b p-2">
        <Skeleton className="h-6 w-full" />
      </div>

      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="border-b p-2 last:border-b-0">
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  )
}
