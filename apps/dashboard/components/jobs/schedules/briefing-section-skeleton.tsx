import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Stands in for {@link BriefingSection} while it loads.
 *
 * Measured against the real markup: `h-6` is the heading, `h-4` is `text-sm`,
 * and `h-36` is a card carrying a name, a schedule, a next-run line and the
 * interval form.
 *
 * **Unlike `CoverLetterSectionSkeleton` this one reserves a heading**, because
 * this section still renders "Briefings" above its cards while `/jobs/letters`
 * lost its `<h2>` on becoming a page of its own.
 *
 * **A file of its own because two things draw it**: the page's `<Suspense>`
 * fallback and `loading.tsx`, which must match the page exactly and cannot
 * import a function declared inside it.
 *
 * Two is the `cards` value a caller should pass — an empty column reads as "no
 * briefings" a moment before the real answer.
 */
export function BriefingSectionSkeleton({ cards }: { cards: number }) {
  return (
    <section
      aria-busy="true"
      aria-label="Loading briefings"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-2">
        <Skeleton className="h-6 w-32" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>

      {Array.from({ length: cards }, (_, index) => (
        <Skeleton key={index} className="h-36 w-full rounded-lg" />
      ))}

      {/* The closing note about the worker being off duty. */}
      <Skeleton className="h-4 w-full max-w-sm" />
    </section>
  )
}
