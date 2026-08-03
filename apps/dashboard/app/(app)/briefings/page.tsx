import { BriefingList } from "@/components/briefings/briefing-list"
import { requirePageUser } from "@/lib/auth/require-page-user"
import {
  latestPostingsForUser,
  type BriefingPostings,
} from "@/lib/briefings/latest-postings"
import { getPrisma } from "@/lib/db"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * One database round trip, over a pooled Neon endpoint that a cold serverless
 * instance has to connect to first. Well under the documents page's 30 — there
 * is no upload here — and well above a healthy read, so a slow connection is
 * answered rather than cut off.
 */
export const maxDuration = 15

/**
 * What the briefings found.
 *
 * ⚠️ **`requirePageUser()` is this page's own authorization check and is not
 * inherited.** `app/(app)/layout.tsx` calls `getCurrentUser()` too, but that
 * call renders the sidebar: a layout does not re-render on navigation, so its
 * check is not re-run as someone moves between routes. See
 * `lib/auth/require-page-user.ts`.
 *
 * The guard establishes who is asking. It does **not** scope rows — that is
 * `where: { userId }` inside `latestPostingsForUser`, which is where the
 * user-isolation test points.
 */
export default async function BriefingsPage() {
  const user = await requirePageUser()

  // A database outage should say so rather than replacing the page with an
  // error boundary, matching how `/documents` degrades when S3 is unreachable.
  let briefings: BriefingPostings[] = []
  let loadFailed = false

  try {
    briefings = await latestPostingsForUser(getPrisma(), user.userId)
  } catch (error) {
    console.error("briefings: could not load", error)
    loadFailed = true
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 lg:px-6">
        <section className="flex flex-col gap-4">
          {/*
            No heading of its own: `SiteHeader` already renders the `<h1>` for
            this route, off the same `lib/nav.ts` entry the sidebar reads, so a
            second one here would be a duplicate that could drift.
          */}
          <p className="text-sm text-muted-foreground">
            The postings each briefing found on its most recent run. Manage
            schedules and search criteria in Settings.
          </p>

          {/*
            Two things the ticket requires be said outright rather than left to
            be discovered, and both are said once here rather than on every
            card:

            - A drafted letter is a **first draft to edit**. Bracketed
              placeholders are visible in the output by design — the writer is
              instructed to leave one wherever a fact nobody supplied would
              otherwise be invented and attributed to the user.
            - **Only .md and .txt CVs can be read.** A PDF or DOCX uploads and
              stores fine and cannot be turned into text yet (#86), so a user
              whose CV is a PDF is refused for a reason that has nothing to do
              with their document being wrong.
          */}
          <p className="text-sm text-muted-foreground">
            Drafting a cover letter gives you a{" "}
            <strong className="font-medium text-foreground">
              first draft to edit, not a letter to send
            </strong>
            . Anything nobody supplied — a start date, a named recipient — is
            left as a visible [bracketed placeholder] rather than invented. It
            is written from the newest document you have labelled{" "}
            <em>Resume</em> under Documents, and only{" "}
            <code className="text-foreground">.md</code> and{" "}
            <code className="text-foreground">.txt</code> files can be read so
            far — PDF and Word documents can be stored but not yet read.
          </p>

          {loadFailed ? (
            <Alert variant="destructive">
              <AlertDescription>
                Your briefings could not be loaded. Try again in a moment.
              </AlertDescription>
            </Alert>
          ) : (
            <BriefingList briefings={briefings} />
          )}
        </section>
      </div>
    </main>
  )
}
