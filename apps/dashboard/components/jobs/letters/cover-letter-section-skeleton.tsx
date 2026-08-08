import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * Stands in for {@link CoverLetterSection} while it loads.
 *
 * Shaped against the real markup rather than drawn freehand —
 * `CoverLetterSection` opens `<section className="flex flex-col gap-4">` with a
 * paragraph of explanation, then a run of bordered cards. The measurements
 * follow from that: `h-4` is `text-sm`, and two lines is what that paragraph
 * runs to at this width. Reserving the wrong height is worse than reserving
 * none, because the content arriving then shifts everything below it.
 *
 * **No heading bar, because the section has no heading.** It lost its `<h2>`
 * when it stopped being one section of `/settings` — `SiteHeader` renders the
 * `<h1>` for `/jobs/letters` — and a skeleton still reserving a title would
 * push everything under it down the moment the real section arrived.
 *
 * **A file of its own because two things draw it**: the page's `<Suspense>`
 * fallback, and `loading.tsx` — which has to match the page exactly, and cannot
 * import a function declared inside it.
 *
 * `cards` stays a parameter rather than a hardcoded `1`: it is what a second
 * async section on this page would need again, and the alternative is a
 * skeleton nobody remembers exists until the next one is built freehand.
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
