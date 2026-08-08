import { JobTabs } from "@/components/jobs/job-tabs"
import { CoverLetterSectionSkeleton } from "@/components/jobs/letters/cover-letter-section-skeleton"

/**
 * ⚠️ **This file exists to override an inherited skeleton, not to add one.**
 *
 * Next resolves the nearest *ancestor* boundary, and for this segment that is
 * `app/(app)/jobs/loading.tsx` — a posting-table skeleton with postings prose
 * baked into it. Without this file, opening the cover-letter settings flashes a
 * wide table of postings and then collapses to a narrow column of forms. Same
 * reason `jobs/schedules/loading.tsx` exists.
 *
 * **The container has to match `page.tsx` exactly** — the same `max-w-6xl`
 * outer, the same `max-w-2xl` inner, the same padding and gaps. This element is
 * replaced by the page's shell mid navigation, and any difference between the
 * two is a jump the user sees. The outer width belongs to the section rather
 * than to the forms so the tab bar cannot move between tabs; `jobs/page.tsx`
 * says why.
 *
 * The skeleton beneath the bar is the page's own `<Suspense>` fallback, drawn
 * from the same component — so the transition from this file to the page is,
 * for the section itself, no transition at all.
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
