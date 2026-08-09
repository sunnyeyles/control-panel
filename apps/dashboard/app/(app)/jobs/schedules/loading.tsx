import { BriefingSectionSkeleton } from "@/components/briefings/jobs/briefing-section-skeleton"
import { JobTabs } from "@/components/jobs/job-tabs"

/**
 * ⚠️ **This file exists to override an inherited skeleton, not to add one.**
 *
 * Next resolves the nearest *ancestor* boundary, and for this segment that is
 * `app/(app)/jobs/loading.tsx` — a posting-table skeleton with postings prose
 * baked into it. Without this file, opening the schedules page flashes a wide
 * table of postings and then collapses to a narrow column of forms. The
 * group-level `app/(app)/loading.tsx` is already the right shape and never gets
 * a look in, because it is one segment further up.
 *
 * **The container has to match `page.tsx` exactly** — the same `max-w-6xl`
 * outer, the same `max-w-2xl` inner, the same padding and gaps. This element is
 * replaced by the page's shell mid navigation, and any difference between the
 * two is a jump the user sees. Same rule `jobs/loading.tsx` states for the page
 * below it, and the reason the outer width is the section's rather than the
 * form's is given there: the tab bar must not move.
 *
 * `<JobTabs />` is the real component, not a skeleton of it — static markup off
 * `usePathname`, so the tabs stay live while the forms load.
 *
 * Shape only, no prose: unlike the postings skeleton this one duplicates no
 * sentences, so there is nothing here to keep in step with the page.
 *
 * The skeleton beneath the bar is the page's own `<Suspense>` fallback, drawn
 * from the same component — so the transition from this file to the page is,
 * for the section itself, no transition at all. Same arrangement as
 * `jobs/letters/loading.tsx`.
 */
export default function Loading() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 lg:px-6">
        <JobTabs />

        <div className="flex w-full max-w-2xl flex-col gap-10">
          {/* Two cards. Most users have one or two; an empty column would read
              as "no briefings" a moment before the real answer. */}
          <BriefingSectionSkeleton cards={2} />
        </div>
      </div>
    </main>
  )
}
