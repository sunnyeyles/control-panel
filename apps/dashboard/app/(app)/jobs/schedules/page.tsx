import { Suspense } from "react"

import { BriefingSection } from "@/components/jobs/schedules/briefing-section"
import { BriefingSectionSkeleton } from "@/components/jobs/schedules/briefing-section-skeleton"
import { PostingFilterSection } from "@/components/jobs/schedules/posting-filter-section"
import { JobTabs } from "@/components/jobs/job-tabs"
import { requirePageUser } from "@/lib/auth/require-page-user"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * The schedules page: what a briefing searches for, and how often.
 *
 * **No `maxDuration`, unlike `/documents` and `/jobs/letters`.** Those raise
 * it for object-store work on their Server Actions (upload; example-letter
 * import). This page reads `jobs` through Prisma — one indexed query, no
 * object store — so raising the ceiling here would be cargo-culted from a
 * page whose problem it does not share.
 */
export default async function BriefingSchedulesPage() {
  const user = await requirePageUser()

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/*
        These widths and paddings are duplicated in `loading.tsx`, which replaces
        this element mid navigation — any difference between the two is a jump
        the user sees.

        ⚠️ **The outer container is `max-w-6xl` to match `/jobs`, and the forms
        narrow themselves inside it.** The tab bar is on all three routes, so a
        container that changed width between them would slide it sideways on
        every click. The reading width the forms want is a property of the forms,
        not of the section.
      */}
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 lg:px-6">
        <JobTabs />

        <div className="flex w-full max-w-2xl flex-col gap-10">
          {/*
            `user.userId` is `users.id` — the platform identity, not the Neon
            Auth id — which is what `jobs.user_id` references and so the only
            thing that can scope this list.

            Streamed rather than awaited above, so the shell paints as soon as
            the session resolves: an `await` at the top of a page is the whole
            page's wait.
          */}
          <Suspense fallback={<BriefingSectionSkeleton cards={2} />}>
            <BriefingSection userId={user.userId} />
          </Suspense>

          {/*
            Its own boundary, below the briefings and streamed independently:
            it is a second unrelated query, and putting it inside the briefings'
            boundary would hold both behind whichever landed last. Same
            arrangement, and the same reason, as the four loads on `/jobs`.
          */}
          <Suspense fallback={<BriefingSectionSkeleton cards={1} />}>
            <PostingFilterSection userId={user.userId} />
          </Suspense>
        </div>
      </div>
    </main>
  )
}
