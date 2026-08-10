import { TitleFilterForm } from "@/components/briefings/jobs/title-filter-form"
import { getPrisma } from "@/lib/db"
import { titleExclusions } from "@workspace/db"
import { formatTitleExclusions } from "@workspace/job-search"

/**
 * The one subtractive criterion the app has, and it belongs to the account
 * rather than to a briefing.
 *
 * **On `/jobs/schedules` rather than `/settings`**, by the argument that page's
 * own docblock makes about the cover-letter section moving off it: this
 * configures what a search returns, so it belongs beside the search criteria.
 * It sits above the briefings because it qualifies all of them — a filter listed
 * under one briefing would read as that briefing's.
 *
 * A server component, like `briefing-section.tsx`: it reads the row and hands
 * the client component a plain string. `updatedAt` is a `Date` and deliberately
 * does not cross — see `lib/jobs/briefing-summary.ts` for why that boundary
 * matters.
 *
 * ⚠️ **`formatTitleExclusions` and not `.join(", ")`.** It is the inverse of the
 * parse the save runs, so what is rendered back into the box round-trips to the
 * same list; a second opinion about the separator here would show the user a
 * field that saves to something other than what it displays.
 */
export async function PostingFilterSection({ userId }: { userId: string }) {
  // `userId` is `users.id` — the platform identity, not the Neon Auth id —
  // passed down from the page's own `requirePageUser()`, exactly as
  // `BriefingSection` takes it. It is never read from the URL or a form.
  const terms = await titleExclusions(getPrisma(), userId)

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-lg font-medium">Filters</h2>
        <p className="text-sm text-muted-foreground">
          Applies to every briefing you have, and to the Postings table.
        </p>
      </div>

      <TitleFilterForm titleExclusions={formatTitleExclusions(terms)} />
    </section>
  )
}
