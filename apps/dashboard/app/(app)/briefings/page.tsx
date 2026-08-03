import { BriefingList } from "@/components/briefings/briefing-list"
import { CoverLetterList } from "@/components/briefings/cover-letter-list"
import { requirePageUser } from "@/lib/auth/require-page-user"
import {
  latestPostingsForUser,
  type BriefingPostings,
} from "@/lib/briefings/latest-postings"
import {
  listCoverLetters,
  type CoverLetterSummary,
} from "@/lib/cover-letters/list-cover-letters"
import { getPrisma } from "@/lib/db"
import { getCoverLetterStore } from "@/lib/storage"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * One database round trip over a pooled Neon endpoint that a cold serverless
 * instance has to connect to first, plus a listing of this user's cover letters
 * and one `HeadObject` per letter — see `lib/cover-letters/list-cover-letters.ts`
 * for why that N+1 is the right shape and why it is bounded.
 *
 * Raised from 15 when the letters arrived. The S3 work is bounded but not
 * constant, and a page that renders postings correctly and then dies partway
 * through the letters is worse than a slow one.
 */
export const maxDuration = 30

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
 * `where: { userId }` inside `latestPostingsForUser`, and the session's
 * `userId` passed to `listCoverLetters`, which is where the two user-isolation
 * tests point. Neither identifier is ever read from the URL or a form.
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

  // ⚠️ **Loaded separately, and failing separately.** The two sources are
  // Postgres and S3, and the dashboard's `prod:cover-letters` grant is a
  // Terraform apply away from the code that needs it — so "letters unreadable"
  // is a state this page will genuinely be in, and it must not take the
  // postings down with it.
  let letters: CoverLetterSummary[] = []
  let lettersFailed = false

  try {
    letters = await listCoverLetters(user.userId, getCoverLetterStore())
  } catch (error) {
    console.error("cover-letters: could not list", error)
    lettersFailed = true
  }

  // Keyed so each Posting card can ask about itself without scanning. Built
  // here rather than in the component because it is derived from data the page
  // already holds, and a component that builds it would rebuild it per render.
  const lettersByPosting = new Map(
    letters.map((letter) => [letter.postingId, letter])
  )

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
            <BriefingList briefings={briefings} letters={lettersByPosting} />
          )}
        </section>

        <section className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">Your cover letters</h2>
            <p className="text-sm text-muted-foreground">
              Every letter you have drafted, newest first. Drafting again for
              the same posting replaces the letter here.
            </p>
          </div>

          {lettersFailed ? (
            <Alert variant="destructive">
              <AlertDescription>
                Your cover letters could not be loaded. Try again in a moment.
              </AlertDescription>
            </Alert>
          ) : (
            <CoverLetterList letters={letters} />
          )}
        </section>
      </div>
    </main>
  )
}
