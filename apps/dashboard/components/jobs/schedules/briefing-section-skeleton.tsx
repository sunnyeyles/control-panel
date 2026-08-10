import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Stands in for {@link BriefingSection} while it loads.
 *
 * Shaped against the real markup rather than drawn freehand — `BriefingSection`
 * opens `<section className="flex flex-col gap-4">` with an `<h2>` and a
 * paragraph, then a run of bordered briefing cards, then the closing note about
 * the worker being off duty. The measurements follow from that: `h-6` is the
 * heading, `h-4` is `text-sm`, and `h-36` is a card carrying a name, a schedule,
 * a next-run line and the interval form beneath them.
 *
 * **Unlike `CoverLetterSectionSkeleton` this one does reserve a heading**, and
 * the difference is real rather than an oversight: `/jobs/letters` lost its
 * `<h2>` when it became a page of its own, while this section still renders
 * "Briefings" above its cards because it is one section among several the page
 * could grow.
 *
 * **A file of its own because two things draw it**: the page's `<Suspense>`
 * fallback, and `loading.tsx` — which has to match the page exactly, and cannot
 * import a function declared inside it. It was previously inline in
 * `loading.tsx` alone, which is why the page had no fallback to use and awaited
 * its query instead.
 *
 * `cards` stays a parameter for the reason `CoverLetterSectionSkeleton` gives.
 * Two is the default a caller should pass: most users have one or two, and an
 * empty column would read as "no briefings" a moment before the real answer.
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
