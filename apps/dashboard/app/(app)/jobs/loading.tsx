import { AddPostingByLinkSkeleton } from "@/components/jobs/postings/add-posting-by-link"
import { BriefingStripSkeleton } from "@/components/jobs/postings/briefing-strip"
import { PostingTableSkeleton } from "@/components/jobs/postings/posting-table-skeleton"
import { JobTabs } from "@/components/jobs/job-tabs"

/**
 * What a sort click, a page click and an arrival at `/jobs` show first.
 *
 * ⚠️ **A route-level `loading.tsx` overriding the group-level one for this
 * segment.** `app/(app)/loading.tsx` is four grey bars in a `max-w-2xl` column
 * and this route is a wide table, so it replaced the table with something a
 * third of its width and put it back — a layout jump on every sort.
 *
 * ⚠️ **The container has to match `page.tsx` exactly** — `max-w-6xl`, the same
 * padding and gaps. This element is swapped for the page's shell mid
 * navigation, so any difference is a jump the user sees.
 *
 * `<JobTabs />` is the real component: static markup off `usePathname`, so
 * drawing it keeps the tabs clickable and guarantees the bar cannot move.
 *
 * The copy is repeated rather than shared — a skeleton importing real prose
 * from the page inverts what it is for, and stale text here costs a few hundred
 * milliseconds of being wrong.
 */
export default function Loading() {
  return (
    <main
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 lg:px-6">
        <JobTabs />

        <section className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">
            Every posting your briefings have found, however long ago. Manage
            schedules and search criteria in Schedules.
          </p>

          <p className="text-sm text-muted-foreground">
            Drafting a cover letter gives you a{" "}
            <strong className="font-medium text-foreground">
              first draft to edit, not a letter to send
            </strong>
            . Anything nobody supplied — a start date, a named recipient — is
            left as a visible [bracketed placeholder] rather than invented. It
            is written from the newest document you have labelled{" "}
            <em>Resume</em> under Documents. Markdown, plain text, PDF and Word
            (<code className="text-foreground">.docx</code>) files can all be
            read; <code className="text-foreground">.doc</code>,{" "}
            <code className="text-foreground">.odt</code> and{" "}
            <code className="text-foreground">.rtf</code> can be stored but not
            yet read.
          </p>

          {/*
            The same three placeholders `page.tsx` draws, in the same order —
            this element is replaced by that shell mid navigation, so anything
            only one of them draws is a jump. The first is not a Suspense
            fallback there: `AddPostingByLink` waits for nothing, so what is
            reserved here is simply its height.
          */}
          <AddPostingByLinkSkeleton />
          <BriefingStripSkeleton />
          <PostingTableSkeleton />
        </section>
      </div>
    </main>
  )
}
