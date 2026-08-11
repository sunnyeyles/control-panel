import { AddPostingByLinkSkeleton } from "@/components/jobs/postings/add-posting-by-link"
import { BriefingStripSkeleton } from "@/components/jobs/postings/briefing-strip"
import { PostingTableSkeleton } from "@/components/jobs/postings/posting-table-skeleton"
import { JobTabs } from "@/components/jobs/job-tabs"

/**
 * What a sort click, a page click and an arrival at `/jobs` show first.
 *
 * ⚠️ **A route-level `loading.tsx` beside the group-level one, and it overrides
 * it for this segment only.** `app/(app)/loading.tsx` is deliberately
 * shape-agnostic because it covers a chat, a document list and a settings panel
 * — but it is four grey bars in a `max-w-2xl` column, and this route is a wide
 * table. Every navigation within `/jobs` changes only the query string, so that
 * fallback replaced the table with something a third of its width and then put
 * it back: a layout jump on every single sort.
 *
 * That group-level file explains why it must stay generic. This is the case it
 * names — "add a `loading.tsx` inside a segment if that segment ever earns a
 * shape worth previewing".
 *
 * ⚠️ **The container has to match `page.tsx` exactly.** `max-w-6xl`, the same
 * padding, the same gaps: this element is replaced by the page's shell mid
 * navigation, and any difference between the two is a jump the user sees.
 *
 * **`<JobTabs />` is the real component, not a skeleton of it.** It is static
 * markup off `usePathname` — nothing to wait for — so drawing it here keeps the
 * tabs live and clickable while the panel below loads, and guarantees the bar
 * cannot move as this element is swapped for the page.
 *
 * The two paragraphs of copy are repeated rather than shared, and that is the
 * one duplication here worth accepting: extracting them into a component to be
 * imported by both would mean a skeleton that renders real prose from a module
 * whose whole job is to look like the page. They are static text; if they
 * change, this file shows the wrong text for a few hundred milliseconds and
 * nothing breaks.
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
