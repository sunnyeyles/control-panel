import { JobTabs } from "@/components/jobs/job-tabs"
import { CoverLetterSectionSkeleton } from "@/components/jobs/letters/cover-letter-section-skeleton"

/**
 * ⚠️ **This file exists to override an inherited skeleton, not to add one.**
 *
 * Next resolves the nearest *ancestor* boundary, which for this segment is
 * `app/(app)/jobs/loading.tsx` — a posting-table skeleton. Without this file,
 * opening the cover-letter settings flashes a wide table and collapses to a
 * narrow column of forms. Same reason `jobs/schedules/loading.tsx` exists.
 *
 * **The container has to match `page.tsx` exactly** — same `max-w-6xl` outer,
 * `max-w-2xl` inner, padding and gaps — because this element is swapped for the
 * page's shell mid navigation, and the tab bar must not move between tabs.
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
          <CoverLetterSectionSkeleton cards={1} />
        </div>
      </div>
    </main>
  )
}
