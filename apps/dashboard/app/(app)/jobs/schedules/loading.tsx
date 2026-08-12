import { BriefingSectionSkeleton } from "@/components/jobs/schedules/briefing-section-skeleton"
import { JobTabs } from "@/components/jobs/job-tabs"

/**
 * ⚠️ **This file exists to override an inherited skeleton, not to add one.**
 *
 * Next resolves the nearest *ancestor* boundary, which for this segment is
 * `app/(app)/jobs/loading.tsx` — a posting-table skeleton. Without this file the
 * schedules page flashes a wide table and collapses to a narrow column of
 * forms; the group-level `loading.tsx` is the right shape but one segment too
 * far up to get a look in.
 *
 * **The container has to match `page.tsx` exactly** — same `max-w-6xl` outer,
 * `max-w-2xl` inner, padding and gaps — because this element is swapped for the
 * page's shell mid navigation, and the tab bar must not move. `<JobTabs />` is
 * the real component, static markup off `usePathname`.
 *
 * The skeleton beneath the bar is the page's own `<Suspense>` fallback, so for
 * the section itself there is no transition at all.
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
