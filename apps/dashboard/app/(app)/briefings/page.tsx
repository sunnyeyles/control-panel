import {
  BriefingStrip,
  type BriefingStripEntry,
} from "@/components/briefings/briefing-strip"
import { PostingTable } from "@/components/briefings/posting-table"
import { RefreshWhileRunning } from "@/components/briefings/refresh-while-running"
import { requirePageUser } from "@/lib/auth/require-page-user"
import {
  anyRunning,
  runActivityForUser,
  type BriefingActivity,
} from "@/lib/briefing-runs/run-activity"
import {
  loadCoverLetterRows,
  type CoverLetterRow,
} from "@/lib/cover-letters/cover-letter-rows"
import { getPrisma } from "@/lib/db"
import { listPostings, type PostingPage } from "@/lib/postings/list-postings"
import {
  parsePostingQuery,
  type SearchParams,
} from "@/lib/postings/posting-query"
import type { BriefingCounts } from "@/lib/postings/postings-empty-state"
import { getCoverLetterStore } from "@/lib/storage"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * Two database round trips for the table (a count and a page — see
 * `list-postings.ts` for why they are serial), one more for the strip, over a
 * pooled Neon endpoint that a cold serverless instance has to connect to first,
 * plus bounded metadata reads for the visible Postings' cover letters — see
 * `lib/cover-letters/cover-letter-rows.ts`.
 *
 * Raised from 15 when the letters arrived. The S3 work is bounded by the page
 * size, and a page that renders postings correctly and then dies partway
 * through its letters is worse than a slow one.
 */
export const maxDuration = 30

/**
 * Every Posting this user's briefings have ever found.
 *
 * ⚠️ **`requirePageUser()` is this page's own authorization check and is not
 * inherited.** `app/(app)/layout.tsx` calls `getCurrentUser()` too, but that
 * call renders the sidebar: a layout does not re-render on navigation, so its
 * check is not re-run as someone moves between routes. See
 * `lib/auth/require-page-user.ts`.
 *
 * The guard establishes who is asking. It does **not** scope rows — that is
 * `where: { userId }` inside `listPostings`, and the session's `userId` passed
 * to `loadCoverLetterRows`, which is where the two user-isolation tests point.
 * Neither identifier is ever read from the URL or a form.
 *
 * ⚠️ **The guard runs before `searchParams` is touched.** The query string is
 * the app's first untrusted GET input; establishing who is asking before
 * reading anything they sent keeps the order the rest of the app has.
 *
 * ⚠️ **Three independent loads, three independent failures, and none of them
 * may blank the other two.** The postings are Postgres, the letters are S3, and
 * the run activity is a third query answering a different question — the latest
 * Run of any status rather than the rows a briefing has ever produced. The
 * dashboard's `prod:cover-letters` grant is a Terraform apply away from the code
 * that needs it, so "letters unreadable" is a state this page will genuinely be
 * in.
 *
 * `searchParams` is typed inline rather than with the generated `PageProps`
 * helper, which only exists once `next typegen` has written `.next/types/` —
 * a typecheck in a clean checkout would not have it.
 */
export default async function BriefingsPage({
  searchParams,
}: {
  /** A promise in Next 16, and a repeated parameter arrives as `string[]`. */
  searchParams: Promise<SearchParams>
}) {
  const user = await requirePageUser()
  const query = parsePostingQuery(await searchParams)

  // A database outage should say so rather than replacing the page with an
  // error boundary, matching how `/documents` degrades when S3 is unreachable.
  let postings: PostingPage = {
    postings: [],
    total: 0,
    page: 1,
    pageCount: 1,
    pageSize: 0,
  }
  let loadFailed = false

  try {
    postings = await listPostings(getPrisma(), user.userId, query)
  } catch (error) {
    console.error("postings: could not load", error)
    loadFailed = true
  }

  // ⚠️ **Loaded separately, and failing separately.** The two sources are
  // Postgres and S3, and the dashboard's `prod:cover-letters` grant is a
  // Terraform apply away from the code that needs it — so "letters unreadable"
  // is a state this page will genuinely be in, and it must not take the
  // postings down with it.
  let letters = new Map<string, CoverLetterRow>()
  let lettersFailed = false

  try {
    letters = await loadCoverLetterRows(
      user.userId,
      postings.postings.map((posting) => posting.id),
      getCoverLetterStore()
    )
  } catch (error) {
    console.error("cover-letters: could not load", error)
    lettersFailed = true
  }

  // ⚠️ **A third independent load, failing independently.** It answers a
  // different question from the table — the latest Run of any status, rather
  // than every Posting ever found — and a failure here must cost the strip
  // above the table, not the table.
  //
  // Two queries rather than one because the strip needs both halves and neither
  // supplies the other: `runActivityForUser` returns nothing at all for a
  // briefing that has never run, and it carries no names. They share a block
  // because they are one feature — a strip with names and no status, or status
  // and no names, is not worth rendering half of.
  let activity: BriefingActivity[] = []
  let strip: BriefingStripEntry[] = []
  let counts: BriefingCounts | undefined

  try {
    const [briefings, loaded] = await Promise.all([
      getPrisma().job.findMany({
        where: { userId: user.userId },
        orderBy: { createdAt: "desc" },
      }),
      runActivityForUser(getPrisma(), user.userId),
    ])

    activity = loaded
    const activityByBriefing = new Map(
      activity.map((entry) => [entry.briefingId, entry.activity])
    )

    strip = briefings.map((briefing) => ({
      id: briefing.id,
      name: briefing.name,
      activity: activityByBriefing.get(briefing.id) ?? { state: "never-run" },
    }))

    // Only known when this load succeeded, which is exactly why it is optional:
    // "you have no briefings" is the wrong thing to tell someone whose
    // briefings simply could not be read.
    counts = { briefings: briefings.length, runs: activity.length }
  } catch (error) {
    console.error("briefings: could not load run activity", error)
  }

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      {/*
        Mounted only while something is actually running, which is what keeps
        the app's only poller from being a request every five seconds for the
        life of an idle tab. It renders nothing; mounting it is the effect.
      */}
      <RefreshWhileRunning active={anyRunning(activity)} />

      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 lg:px-6">
        <section className="flex flex-col gap-4">
          {/*
            No heading of its own: `SiteHeader` already renders the `<h1>` for
            this route, off the same `lib/nav.ts` entry the sidebar reads, so a
            second one here would be a duplicate that could drift.
          */}
          <p className="text-sm text-muted-foreground">
            Every posting your briefings have found, however long ago. Manage
            schedules and search criteria in Settings.
          </p>

          {/*
            Two things the ticket requires be said outright rather than left to
            be discovered:

            - A drafted letter is a **first draft to edit**. Bracketed
              placeholders are visible in the output by design — the writer is
              instructed to leave one wherever a fact nobody supplied would
              otherwise be invented and attributed to the user.
            - **Three CV formats cannot be read.** `.doc`, `.odt` and `.rtf`
              upload and store fine and have no parser — see
              `READABLE_PROFILE_EXTENSIONS` in `lib/cover-letters/profile-text.ts`
              — so a user whose CV is one of them is refused for a reason that
              has nothing to do with their document being wrong. PDF and DOCX
              *are* read, and this paragraph claimed otherwise for far too long.
          */}
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

          <BriefingStrip briefings={strip} />

          {/*
            Beside the table rather than instead of it: letters live in S3 and
            the dashboard's `prod:cover-letters` grant is a Terraform apply away
            from the code that needs it. Without this alert a storage failure
            looks identical to "no letter drafted", which is the wrong thing to
            tell someone who already drafted one.
          */}
          {lettersFailed ? (
            <Alert variant="destructive">
              <AlertDescription>
                Your cover letters could not be loaded. Try again in a moment.
              </AlertDescription>
            </Alert>
          ) : null}

          {loadFailed ? (
            <Alert variant="destructive">
              <AlertDescription>
                Your postings could not be loaded. Try again in a moment.
              </AlertDescription>
            </Alert>
          ) : (
            <PostingTable
              page={postings}
              query={query}
              letters={letters}
              counts={counts}
            />
          )}
        </section>
      </div>
    </main>
  )
}
