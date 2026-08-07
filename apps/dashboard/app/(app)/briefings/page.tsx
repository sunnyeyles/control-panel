import { Suspense } from "react"

import {
  BriefingStrip,
  BriefingStripSkeleton,
  type BriefingStripEntry,
} from "@/components/briefings/briefing-strip"
import { CoverLetterAlert } from "@/components/briefings/cover-letter-alert"
import type { CoverLetterPromise } from "@/components/briefings/cover-letter-cell"
import { PostingTable } from "@/components/briefings/posting-table"
import { PostingTableSkeleton } from "@/components/briefings/posting-table-skeleton"
import { RefreshWhileRunning } from "@/components/briefings/refresh-while-running"
import type { TailoredResumePromise } from "@/components/briefings/use-tailored-resume"
import { requirePageUser } from "@/lib/auth/require-page-user"
import {
  anyRunning,
  runActivityForUser,
  type BriefingActivity,
} from "@/lib/briefing-runs/run-activity"
import {
  coverLetterRowsFor,
  listCoverLetters,
} from "@/lib/cover-letters/cover-letter-rows"
import { getPrisma } from "@/lib/db"
import { listPostings, type PostingPage } from "@/lib/postings/list-postings"
import {
  parsePostingQuery,
  type PostingQuery,
  type SearchParams,
} from "@/lib/postings/posting-query"
import type { BriefingCounts } from "@/lib/postings/postings-empty-state"
import { getCoverLetterStore, getTailoredResumeStore } from "@/lib/storage"
import { loadTailoredResumeRows } from "@/lib/tailored-resumes/tailored-resume-rows"
import { timed } from "@/lib/timed"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import type { StoredCoverLetter } from "@workspace/user-storage"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * A handful of queries over a pooled Neon endpoint that a cold serverless
 * instance has to connect to first, plus a single S3 listing for the cover
 * letters.
 *
 * Raised from 15 when the letters arrived, and kept there now that they cost
 * one request rather than twenty-five: the binding constraint is the cold
 * connection, not the fan-out that is gone.
 *
 * The tailored resumes added one more S3 call and not one more per row — a
 * single `ListObjectsV2` — so this did not move again for them.
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
 * to `listCoverLetters`, which is where the two user-isolation tests point.
 * Neither identifier is ever read from the URL or a form.
 *
 * ⚠️ **The guard runs before `searchParams` is touched.** The query string is
 * the app's first untrusted GET input; establishing who is asking before
 * reading anything they sent keeps the order the rest of the app has.
 *
 * ⚠️ **Four independent loads, four independent failures, and none of them may
 * blank the other three.** The postings are Postgres; the letters and the
 * tailored resumes are S3, read by different means and therefore able to fail
 * separately; and the run activity is a fourth query answering a different
 * question — the latest Run of any status rather than the rows a briefing has
 * ever produced. Each of the dashboard's storage grants is a Terraform apply
 * away from the code that needs it, so "unreadable" is a state this page will
 * genuinely be in — and `prod:tailored-resumes` is the newest of them, so it is
 * the one most likely to be missing.
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
  // Timed as well as the loads below, because it is the one thing genuinely in
  // front of all of them and it is not free: the session itself resolves from a
  // signed cookie, but `ensureUserForAuth` is a database round trip on every
  // request. Whether that is worth caching across requests is a question this
  // number answers.
  const user = await timed("briefings.gate", requirePageUser)
  const query = parsePostingQuery(await searchParams)

  // ⚠️ **These two awaits are the whole of what this component blocks on, and
  // keeping it that way is the point.** Everything that talks to Postgres or S3
  // is inside a `<Suspense>` below, in a child that awaits it — so the shell
  // (the copy, the table's own chrome) is on screen as soon as the session
  // resolves off its cookie, and the route's `loading.tsx` is replaced then
  // rather than when the last query lands. Moving a `listPostings` or a
  // `runActivityForUser` back up here would put the entire page behind it
  // again, which is exactly what made a sort click feel like a page load.
  //
  // ⚠️ **Started here, awaited in two different children.** The run activity
  // answers a different question from the table — the latest Run of any status,
  // rather than every Posting ever found — so it depends on neither of the other
  // loads and must not queue behind them; `06-fetching-data.md` is explicit that
  // sequential `await`s in one component are sequential *requests*, however
  // unrelated they are. One promise shared by both children is one request.
  //
  // Two queries rather than one because the strip needs both halves and neither
  // supplies the other: `runActivityForUser` returns nothing at all for a
  // briefing that has never run, and it carries no names. They share a promise
  // because they are one feature — a strip with names and no status, or status
  // and no names, is not worth rendering half of.
  //
  // ⚠️ **The `.catch()` is attached now, not at the `await`.** A rejection
  // before anything is awaiting is an unhandled rejection, which in Node is a
  // process-level event and not this page's problem to survive.
  const activityPromise: ActivityPromise = timed("briefings.activity", () =>
    Promise.all([
      getPrisma().job.findMany({
        where: { userId: user.userId },
        orderBy: { createdAt: "desc" },
        // Only the two fields the strip renders. Without it this reads every
        // column a briefing has, including the search-criteria JSON, for a
        // component that shows a name and a status.
        select: { id: true, name: true },
      }),
      runActivityForUser(getPrisma(), user.userId),
    ])
  ).catch((error) => {
    console.error("briefings: could not load run activity", error)
    return null
  })

  // ⚠️ **Started here rather than after the postings, and the reason is in the
  // signature.** `listCoverLetters` takes the user and nothing else — narrowing
  // to the twenty-five ids on screen is `coverLetterRowsFor`, a filter over the
  // result. So this depends on the postings query for nothing and used to wait
  // for it anyway, which on a function deployed away from its data is a round
  // trip to a second service paid in series for no reason.
  //
  // The trade, stated in `cover-letter-rows.ts`: a user with no postings now
  // pays one listing they will not read.
  //
  // `null` on failure, never an empty list. The two sources are Postgres and S3,
  // and the dashboard's `prod:cover-letters` grant is a Terraform apply away
  // from the code that needs it — so "letters unreadable" is a state this page
  // will genuinely be in. Degrading it to "nothing drafted" would tell someone
  // who has already written a letter that they have not.
  const listedLetters: ListedLetters = timed("briefings.cover-letters", () =>
    listCoverLetters(user.userId, getCoverLetterStore())
  ).catch((error) => {
    console.error("cover-letters: could not load", error)
    return null
  })

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
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

          {/*
            One reserved strip row. The height genuinely depends on how many
            briefings someone has, so this is a guess — but it sits directly
            above the table, so the alternative was not "no guess", it was
            pushing the table down by a whole row every time the strip landed.
            See `BriefingStripSkeleton` for why one row is the guess to make.
          */}
          <Suspense fallback={<BriefingStripSkeleton />}>
            <BriefingActivitySection activity={activityPromise} />
          </Suspense>

          <Suspense fallback={<PostingTableSkeleton />}>
            <PostingsSection
              userId={user.userId}
              query={query}
              activity={activityPromise}
              letters={listedLetters}
            />
          </Suspense>
        </section>
      </div>
    </main>
  )
}

/** Both halves of the run activity, or `null` when that load failed. */
type ActivityPromise = Promise<
  [{ id: string; name: string }[], BriefingActivity[]] | null
>

/**
 * Every letter this user has drafted, or `null` when the store could not be
 * read.
 *
 * The whole user rather than the visible page, because that is what one
 * `ListObjectsV2` returns and what lets the request start before the postings
 * are known. `PostingsSection` narrows it once they are.
 */
type ListedLetters = Promise<readonly StoredCoverLetter[] | null>

/**
 * The per-briefing strip above the table, and the poller.
 *
 * ⚠️ **Its own boundary, so its failure and its latency are its own.** A
 * briefing's run history has nothing to do with the Postings a user has ever
 * been shown; before this split, a slow or failed activity query held up — or
 * blanked — the whole page including the table.
 */
async function BriefingActivitySection({
  activity,
}: {
  activity: ActivityPromise
}) {
  const loaded = await activity

  // Nothing to say and nothing to poll. The table below still renders, and its
  // empty state says the honest thing — see `postingsEmptyState`.
  if (loaded === null) return null

  const [briefings, runs] = loaded
  const activityByBriefing = new Map(
    runs.map((entry) => [entry.briefingId, entry.activity])
  )

  const strip: BriefingStripEntry[] = briefings.map((briefing) => ({
    id: briefing.id,
    name: briefing.name,
    activity: activityByBriefing.get(briefing.id) ?? { state: "never-run" },
  }))

  return (
    <>
      {/*
        Mounted only while something is actually running, which is what keeps
        the app's only poller from being a request every five seconds for the
        life of an idle tab. It renders nothing; mounting it is the effect.
      */}
      <RefreshWhileRunning active={anyRunning(runs)} />
      <BriefingStrip briefings={strip} />
    </>
  )
}

/**
 * The table itself, and the cover-letter alert that belongs above it.
 *
 * ⚠️ **The activity promise is awaited here only when the table is empty**, and
 * that condition is the reason this component can stream at all. `counts` picks
 * among three empty-state messages, so it matters exactly when there is nothing
 * to show — and a table with rows in it must not wait on a query it will not
 * read. Awaiting it unconditionally would put every render behind the slower of
 * the two loads and undo the split above.
 */
async function PostingsSection({
  userId,
  query,
  activity,
  letters,
}: {
  userId: string
  query: PostingQuery
  activity: ActivityPromise
  /**
   * The whole user's letters, already in flight.
   *
   * ⚠️ **A promise, and narrowing it must not await it.** The request was
   * started in `BriefingsPage` precisely so it would not queue behind
   * `listPostings`; awaiting it here to filter would put it back in series and
   * hold the table behind a second service.
   */
  letters: ListedLetters
}) {
  let postings: PostingPage

  try {
    postings = await timed("briefings.postings", () =>
      listPostings(getPrisma(), userId, query)
    )
  } catch (error) {
    // A database outage should say so rather than replacing the page with an
    // error boundary, matching how `/documents` degrades when S3 is
    // unreachable. The strip above is unaffected — that is the point of the
    // separate boundary.
    console.error("postings: could not load", error)

    return (
      <Alert variant="destructive">
        <AlertDescription>
          Your postings could not be loaded. Try again in a moment.
        </AlertDescription>
      </Alert>
    )
  }

  // ⚠️ **Narrowed with `.then`, not with `await`, and that is still the fix.**
  // The listing is one S3 request for the whole user — see
  // `lib/cover-letters/cover-letter-rows.ts` — and it is already in flight,
  // started alongside the postings query above. Awaiting it here to apply the
  // filter would put a second service back on the table's critical path, which
  // is the wait this shape exists to remove. The promise goes down to the cells
  // that need it, each behind its own `<Suspense>`, so the table paints and the
  // letter column fills in. See `cover-letter-cell.tsx`.
  //
  // `null` survives the narrowing: a store that could not be read is a distinct
  // state from a user with nothing drafted, and only the alert below may speak
  // for it.
  //
  // An array rather than a `Map` keyed by Posting, because this crosses the RSC
  // boundary into client components and a `Map` is an awkward payload. It is
  // bounded by the page size, so the per-row scan that replaces the keying is
  // bounded too.
  const postingIds = postings.postings.map((posting) => posting.id)

  const lettersPromise: CoverLetterPromise = letters.then((listed) =>
    listed === null ? null : coverLetterRowsFor(listed, postingIds)
  )

  // ⚠️ **A second storage read, alongside the letters rather than behind them.**
  // Also a single `ListObjectsV2` over one prefix — see
  // `lib/tailored-resumes/tailored-resume-rows.ts` — and it takes no posting ids
  // for the same reason the letters now take theirs only to filter: what comes
  // back is everything this user has generated, not a page of it.
  //
  // Not awaited, `.catch()` attached now rather than at the `await`, and `null`
  // on failure never an empty list — all three for the reasons the letters give
  // one comment up. Degrading this one to "nothing generated" would offer to
  // spend a model call replacing a document the page simply could not see, and
  // `prod:tailored-resumes` is the newest grant, so the missing-permission case
  // is the likely one.
  const tailoredResumesPromise: TailoredResumePromise = timed(
    "briefings.tailored-resumes",
    () => loadTailoredResumeRows(userId, getTailoredResumeStore())
  ).catch((error) => {
    console.error("tailored-resumes: could not load", error)
    return null
  })

  // Only known when the activity load succeeded, which is exactly why it is
  // optional: "you have no briefings" is the wrong thing to tell someone whose
  // briefings simply could not be read.
  const counts: BriefingCounts | undefined =
    postings.total === 0 ? countsFrom(await activity) : undefined

  return (
    <>
      {/*
        `fallback={null}` because there is nothing useful to say while the
        storage read is still in flight, and a placeholder here would reserve
        space above the table for a message that almost never arrives. The
        boundary exists so this component's `await` cannot hold up the table
        beneath it.
      */}
      <Suspense fallback={null}>
        <CoverLetterAlert letters={lettersPromise} />
      </Suspense>

      <PostingTable
        page={postings}
        query={query}
        letters={lettersPromise}
        tailoredResumes={tailoredResumesPromise}
        counts={counts}
      />
    </>
  )
}

/** What the empty state needs, when the activity load could answer it. */
function countsFrom(
  loaded: Awaited<ActivityPromise>
): BriefingCounts | undefined {
  if (loaded === null) return undefined

  const [briefings, runs] = loaded

  return { briefings: briefings.length, runs: runs.length }
}
