import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Stands in for {@link DocumentList} while the listing is in flight.
 *
 * Shaped against the real markup — a `rounded-lg border` box around a `<Table>`
 * — so the border and row rhythm are here rather than one grey block.
 *
 * **Only the page's `<Suspense>` draws this, unlike the two skeletons under
 * `/jobs`.** `/documents` has no `loading.tsx` and should not grow one; it
 * inherits the deliberately shape-agnostic `app/(app)/loading.tsx`.
 *
 * `rows` is a parameter rather than a constant because no number is right for
 * both a stocked shelf and a one-line empty state.
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
