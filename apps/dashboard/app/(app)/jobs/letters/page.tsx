import { Suspense } from "react"

import { JobTabs } from "@/components/jobs/job-tabs"
import { CoverLetterSection } from "@/components/jobs/letters/cover-letter-section"
import { CoverLetterSectionSkeleton } from "@/components/jobs/letters/cover-letter-section-skeleton"
import { requirePageUser } from "@/lib/auth/require-page-user"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * Raised for the example-letter import action, not for the listing.
 *
 * `listDocuments()` is one indexed Postgres query now — the old S3
 * `HeadObject` fan-out is gone — so painting this page no longer needs a
 * raised ceiling. A Server Action runs under the duration of the segment that
 * invoked it, and importing an example letter still `get`s the chosen
 * document's bytes from the object store. Without the raise, a slow get of a
 * multi-megabyte CV can be cut off mid-read.
 *
 * **It moved here from `/settings` with the section that needs it.** That page
 * raised the ceiling when this section lived there; it dropped back to the
 * default when the section left.
 */
export const maxDuration = 30

/**
 * How cover letters get written: the instructions the writer follows, and an
 * example to learn a voice from.
 *
 * Job-search configuration, so it sits with the postings that use it rather
 * than under the app's global Settings — a letter is drafted from a Posting one
 * tab away, and the instructions that shape it were two clicks in the other
 * direction.
 *
 * ⚠️ **`requirePageUser()` is this page's own authorization check and is not
 * inherited.** `app/(app)/layout.tsx` calls `getCurrentUser()` too, but that
 * call renders the sidebar: a layout does not re-render on navigation, so its
 * check is not re-run as someone moves between routes. See
 * `lib/auth/require-page-user.ts`.
 */
export default async function CoverLetterSettingsPage() {
  const user = await requirePageUser()

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/*
        ⚠️ **`max-w-6xl` outer to match `/jobs`, with the section narrowing
        itself inside it.** The tab bar is on all three routes in this section,
        so a container that changed width between them would slide it sideways
        on every click. Duplicated in `loading.tsx`, which replaces this element
        mid navigation.
      */}
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 lg:px-6">
        <JobTabs />

        <div className="flex w-full max-w-2xl flex-col gap-10">
          {/*
            `user.userId` is `users.id` — the platform identity — not the Neon
            Auth id. It is the only thing that can scope what this section reads.

            Streamed rather than awaited above, so the tab bar and the shell
            paint immediately instead of waiting on the document listing
            `CoverLetterSection` pays for. {@link maxDuration} above is for
            the import action, not this read.
          */}
          <Suspense fallback={<CoverLetterSectionSkeleton cards={1} />}>
            <CoverLetterSection userId={user.userId} />
          </Suspense>
        </div>
      </div>
    </main>
  )
}
