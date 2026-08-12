import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Stands in for {@link CoverLetterSection} while it loads.
 *
 * Measured against the real markup: `h-4` is `text-sm`, and two lines is what
 * the opening paragraph runs to at this width.
 *
 * **No heading bar, because the section has no heading** — `SiteHeader` renders
 * the `<h1>` for `/jobs/letters`, and a skeleton reserving a title would push
 * everything under it down when the real section arrived.
 *
 * **A file of its own because two things draw it**: the page's `<Suspense>`
 * fallback and `loading.tsx`, which must match the page exactly and cannot
 * import a function declared inside it.
 *
 * `cards` stays a parameter rather than a hardcoded `1`, for the second async
 * section this page could grow.
 */
export function CoverLetterSectionSkeleton({ cards }: { cards: number }) {
  return (
    <section
      aria-busy="true"
      aria-label="Loading cover letter settings"
      className="flex flex-col gap-4"
    >
      {/* The two lines of muted description the section opens with. */}
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/4" />
      </div>

      {Array.from({ length: cards }, (_, index) => (
        <Skeleton key={index} className="h-28 w-full rounded-lg" />
      ))}
    </section>
  )
}
