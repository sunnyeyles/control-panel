import { Suspense } from "react"

import {
  BriefingStrip,
  BriefingStripSkeleton,
  type BriefingStripEntry,
} from "@/components/jobs/postings/briefing-strip"
import { AddPostingByLink } from "@/components/jobs/postings/add-posting-by-link"
import { CoverLetterAlert } from "@/components/jobs/postings/cover-letter-alert"
import type { CoverLetterPromise } from "@/components/jobs/postings/cover-letter-cell"
import { PostingTable } from "@/components/jobs/postings/posting-table"
import { PostingTableSkeleton } from "@/components/jobs/postings/posting-table-skeleton"
import { RefreshWhileRunning } from "@/components/jobs/postings/refresh-while-running"
import { ScorePendingMatches } from "@/components/jobs/postings/score-pending-matches"
import type { TailoredResumePromise } from "@/components/jobs/postings/use-tailored-resume"
import { JobTabs } from "@/components/jobs/job-tabs"
import { requirePageUser } from "@/lib/auth/require-page-user"
import {
  anyRunning,
  runActivityForUser,
  type BriefingActivity,
} from "@/lib/briefing-runs/run-activity"
import {
  coverLetterViewsFor,
  listCoverLetters,
} from "@/lib/cover-letters/cover-letter-views"
import { getPrisma } from "@/lib/db"
import { listPostings, type PostingPage } from "@/lib/postings/list-postings"
import {
  parsePostingQuery,
  type PostingQuery,
  type SearchParams,
} from "@/lib/postings/posting-query"
import type { BriefingCounts } from "@/lib/postings/postings-empty-state"
import { getCoverLetterStore, getTailoredResumeStore } from "@/lib/storage"
import {
  listTailoredResumes,
  tailoredResumeViewsFor,
} from "@/lib/tailored-resumes/tailored-resume-views"
import { timed } from "@/lib/timed"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import type {
  StoredCoverLetter,
  StoredTailoredResume,
} from "@workspace/user-storage"

/** Required of any server component reading the session — it depends on cookies. */
export const dynamic = "force-dynamic"

/**
 * A handful of queries over a pooled Neon endpoint that a cold serverless
 * instance has to connect to first, plus a single S3 listing for the cover
 * letters.
 *
 * The binding constraint is the cold connection, not fan-out — both the letters
 * and the tailored resumes cost one `ListObjectsV2`, not one per row.
 *
 * ⚠️ **60 for `addPostingByLinkAction`, which is not a page load.** A Server
 * Action posts to the route it was rendered from, so this bounds it too — and
 * that action fetches through Tavily and then makes a model call, in sequence.
 * Thirty seconds is a plausible total for the two and therefore not a safe one.
 */
export const maxDuration = 60

/**
 * Every Posting this user's briefings have ever found.
 *
 * ⚠️ **`requirePageUser()` is this page's own authorization check and is not
 * inherited.** The layout's `getCurrentUser()` renders the sidebar; a layout
 * does not re-render on navigation, so its check is not re-run between routes.
 *
 * The guard establishes who is asking; it does **not** scope rows — that is
 * `where: { userId }` inside `listPostings` and the `userId` handed to
 * `listCoverLetters`, never read from the URL or a form. ⚠️ It runs *before*
 * `searchParams` is touched, the app's first untrusted GET input.
 *
 * ⚠️ **Four independent loads, four independent failures, and none may blank
 * the other three.** Each storage grant is a Terraform apply away from the code
 * needing it, so "unreadable" is a state this page will genuinely be in —
 * `prod:tailored-resumes` is the newest and likeliest to be missing.
 *
 * `searchParams` is typed inline rather than with the generated `PageProps`,
 * which only exists once `next typegen` has written `.next/types/`.
 */
export default async function BriefingsPage({
  searchParams,
}: {
  /** A promise in Next 16, and a repeated parameter arrives as `string[]`. */
  searchParams: Promise<SearchParams>
}) {
  // Timed because it sits in front of everything else and is not free: the
  // session resolves off a signed cookie, but `ensureUserForAuth` is a database
  // round trip on every request.
  const user = await timed("briefings.gate", requirePageUser)
  const query = parsePostingQuery(await searchParams)

  // ⚠️ **The two awaits above are the whole of what this component blocks on.**
  // Everything touching Postgres or S3 is awaited inside a `<Suspense>` child,
  // so the shell replaces `loading.tsx` as soon as the session resolves rather
  // than when the last query lands. Moving a `listPostings` back up here is
  // what made a sort click feel like a page load.
  //
  // ⚠️ **Started here, awaited in two different children.** Sequential `await`s
  // in one component are sequential *requests* (`06-fetching-data.md`), however
  // unrelated; one shared promise is one request. Two queries rather than one
  // because neither half supplies the other — `runActivityForUser` returns
  // nothing for a briefing that has never run, and carries no names.
  //
  // ⚠️ **The `.catch()` is attached now, not at the `await`.** A rejection
  // before anything awaits is an unhandled rejection — a process-level event in
  // Node, not something this page can survive.
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

  // ⚠️ **Started here rather than after the postings**, because the signature
  // says it can be: `listCoverLetters` takes the user and nothing else, and
  // narrowing to the ids on screen is `coverLetterViewsFor`. Waiting for the
  // postings query paid an S3 round trip in series for no dependency. The
  // trade: a user with no postings pays one listing they will not read.
  //
  // ⚠️ **`null` on failure, never an empty list.** The `prod:cover-letters`
  // grant is a Terraform apply away from the code needing it, and degrading to
  // "nothing drafted" would tell someone who has written a letter they have not.
  const listedLetters: ListedLetters = timed("briefings.cover-letters", () =>
    listCoverLetters(user.userId, getCoverLetterStore())
  ).catch((error) => {
    console.error("cover-letters: could not load", error)
    return null
  })

  // Same start-early shape as the letters, and `null` on failure for the same
  // correctness reason. `prod:tailored-resumes` is the newest grant, so the
  // missing-permission case is the likely one.
  const listedResumes: ListedResumes = timed("briefings.tailored-resumes", () =>
    listTailoredResumes(user.userId, getTailoredResumeStore())
  ).catch((error) => {
    console.error("tailored-resumes: could not load", error)
    return null
  })

  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 lg:px-6">
        {/*
          ⚠️ **`max-w-6xl` on the container above, on all three routes in this
          section, and the two narrow panels wrap themselves rather than
          narrowing it.** The bar is the one element common to every tab, so a
          container that changed width between them would slide it sideways on
          every click.
        */}
        <JobTabs />

        <section className="flex flex-col gap-4">
          {/*
            No heading of its own: `SiteHeader` already renders the `<h1>` for
            this route, off the same `lib/nav.ts` entry the sidebar reads, so a
            second one here would be a duplicate that could drift.
          */}
          <p className="text-sm text-muted-foreground">
            Every posting your briefings have found, however long ago. Manage
            schedules and search criteria in Schedules.
          </p>

          {/*
            Said outright rather than left to be discovered: bracketed
            placeholders are in the output by design, and `.doc`, `.odt` and
            `.rtf` upload and store fine with no parser behind them — see
            `READABLE_PROFILE_EXTENSIONS` in `lib/candidate/profile-text.ts`.
            ⚠️ PDF and DOCX *are* read; this paragraph claimed otherwise for
            far too long.
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
            Outside every `<Suspense>` below, deliberately: it depends on no
            query, so it paints as soon as the session resolves rather than
            waiting behind the strip or the table. Its height is fixed, which is
            what lets `loading.tsx` reserve it exactly rather than guess.
          */}
          <AddPostingByLink />

          {/*
            One reserved strip row — a guess, since the height depends on how
            many briefings someone has, but it sits directly above the table, so
            the alternative was pushing the table down every time the strip
            landed. `BriefingStripSkeleton` says why one row is the guess.
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
              resumes={listedResumes}
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
 * Every tailored resume this user has, or `null` when the store could not be
 * read. Same start-early / narrow-later shape as {@link ListedLetters}.
 */
type ListedResumes = Promise<readonly StoredTailoredResume[] | null>

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
  resumes,
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
  /**
   * The whole user's tailored resumes, already in flight — same rule as
   * {@link letters}.
   */
  resumes: ListedResumes
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

  // ⚠️ **Narrowed with `.then`, not with `await`.** The listing is already in
  // flight; awaiting it here to filter would put a second service back on the
  // table's critical path, which is the wait this shape exists to remove. The
  // promise goes down to the cells behind their own `<Suspense>`, so the table
  // paints and the letter column fills in.
  //
  // `null` survives the narrowing: a store that could not be read is distinct
  // from a user with nothing drafted, and only the alert below speaks for it.
  //
  // An array rather than a `Map`, because this crosses the RSC boundary and a
  // `Map` is an awkward payload; the page size bounds the per-row scan.
  const postingIds = postings.postings.map((posting) => posting.id)

  const lettersPromise: CoverLetterPromise = letters.then((listed) =>
    listed === null ? null : coverLetterViewsFor(listed, postingIds)
  )

  // Same pipeline as the letters: list early, filter to the page, keep `null`
  // distinct from empty. Bounded by `PAGE_SIZE` once it crosses the RSC
  // boundary — the unbounded inventory no longer does.
  const tailoredResumesPromise: TailoredResumePromise = resumes.then(
    (listed) =>
      listed === null ? null : tailoredResumeViewsFor(listed, postingIds)
  )

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

      {/*
        ⚠️ **Mounted only when there are rows, and it decides the rest for
        itself.** Whether anything needs scoring depends on which document is
        labelled Resume, and answering that here would put a second document
        query on every page view — so the component asks the action, which has
        to resolve the CV anyway. No `<Suspense>` and no server work of its own:
        a client component that starts a Server Action on mount.
      */}
      {postings.total > 0 ? <ScorePendingMatches /> : null}

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
