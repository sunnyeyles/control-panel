import { FindingsSchema } from "@workspace/agents/findings"
import { postingId } from "@workspace/agents/posting-id"
import type { PrismaClient, RunStatus } from "@workspace/db"

/**
 * What the Briefings page shows: for each of a user's briefings, the Postings
 * its most recent successful Run found.
 *
 * **Nothing here imports Next**, for the reason `lib/jobs/job-actions.ts` gives:
 * the interesting behaviour — which rows a user can reach, and what an empty
 * Run looks like — is exactly what a page component cannot be tested for. The
 * client arrives as an argument rather than through `getPrisma()` for the same
 * reason.
 *
 * ⚠️ **`latestArtifactForJob()` is deliberately not used here.** It answers a
 * different question (the newest object key from a successful Run) by ordering
 * on run start *and* artifact creation, which stops being well defined the
 * moment a Run writes more than one artifact. This page needs the Run itself,
 * and it needs the Findings kept against it — never the artifact.
 *
 * It is also not a brief viewer. The markdown a Run produced stays in object
 * storage, which this app holds no grant over: `infra/aws/` gives the dashboard
 * `prod:resumes` and the worker `prod:briefs`, and the two are disjoint. What
 * renders here is the Findings record on the `runs` row.
 */

/** One Posting, flattened to what the list renders. */
export interface PostingView {
  /**
   * Derived from the Posting's URL by `postingId()`, so the same advertisement
   * carries the same id across Runs — and so React's key is stable when a
   * briefing is re-rendered after a new Run.
   */
  id: string
  title: string
  company: string
  location: string
  url: string
  /** Whatever the posting said, verbatim. Absent when the page did not say. */
  postedAt?: string
  /** Lines copied from the advertisement. Empty when it carried none. */
  highlights: string[]
  summary: string
  matchReason: string
}

/**
 * The state of one briefing's most recent successful Run.
 *
 * Four states rather than "postings, possibly empty", because they are four
 * different things to tell someone and only one of them is a problem:
 *
 * - `no-run` — nothing has succeeded yet. New and paused briefings live here.
 * - `not-recorded` — a Run succeeded and its Findings were not kept. Every Run
 *   from before the `runs.findings` column existed is in this state, and so is
 *   one whose findings write failed after the brief was already written (the
 *   worker treats that as a warning, not a failed Run).
 * - `unreadable` — a Findings record is there and does not match the schema.
 *   Kept apart from `not-recorded` so a contract drift is visible as itself
 *   rather than as "nothing found".
 * - `recorded` — the Findings were read. `postings` may be empty: an empty
 *   findings list is a legitimate result, not an error.
 */
export type LatestFindings =
  | { state: "no-run" }
  | { state: "not-recorded"; ranAt: string }
  | { state: "unreadable"; ranAt: string }
  | {
      state: "recorded"
      ranAt: string
      postings: PostingView[]
      /** The scout's note about the search itself, when it left one. */
      notes?: string
    }

/** One briefing, with what its latest successful Run found. */
export interface BriefingPostings {
  briefingId: string
  briefingName: string
  latest: LatestFindings
}

/**
 * Every briefing this user owns, newest first, each with the Postings from its
 * most recent successful Run.
 *
 * ⚠️ **`where: { userId }` on the outer query is the whole of the row scoping,
 * and it is not optional.** The page guard establishes *who is asking*; it says
 * nothing about which rows they may read. Runs hang off jobs here rather than
 * being queried in their own right precisely so that there is no path to a run
 * whose job is not in this user's set — `latest-postings.test.ts` asserts that
 * against a second user's data.
 *
 * The latest Run is resolved per briefing by the database (`take: 1` on the
 * nested relation), not by pulling every Run back and sorting in memory.
 * `startedAt` descending is the order, tie-broken on `id` so two Runs that
 * started in the same instant still resolve to one deterministic answer.
 *
 * **"Most recent successful Run" is taken literally**, including when that Run
 * kept no Findings and an older one did. Reaching further back would put an
 * older Run's Postings under a heading that says the briefing last ran today,
 * which is worse than an empty state that says what actually happened.
 */
export async function latestPostingsForUser(
  prisma: PrismaClient,
  userId: string
): Promise<BriefingPostings[]> {
  const briefings = await prisma.job.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      runs: {
        where: { status: "succeeded" satisfies RunStatus },
        orderBy: [{ startedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: {
          id: true,
          startedAt: true,
          finishedAt: true,
          findings: true,
        },
      },
    },
  })

  return briefings.map((briefing) => ({
    briefingId: briefing.id,
    briefingName: briefing.name,
    latest: toLatestFindings(briefing.runs[0]),
  }))
}

/** The shape this module reads off a run row, and all it reads. */
interface LatestRun {
  id: string
  startedAt: Date
  finishedAt: Date | null
  findings: unknown
}

function toLatestFindings(run: LatestRun | undefined): LatestFindings {
  if (!run) return { state: "no-run" }

  // The Run finished — it is `succeeded` — but `finished_at` is nullable in the
  // schema, so a row written outside the worker can still lack one.
  const ranAt = formatRunTime(run.finishedAt ?? run.startedAt)

  if (run.findings === null || run.findings === undefined) {
    return { state: "not-recorded", ranAt }
  }

  const parsed = FindingsSchema.safeParse(run.findings)

  if (!parsed.success) {
    // The only place this is visible. The page renders an empty state either
    // way, so without this line a scout that started writing a different shape
    // would look exactly like a scout that found nothing.
    console.error("briefings: findings do not match the schema", run.id)
    return { state: "unreadable", ranAt }
  }

  return {
    state: "recorded",
    ranAt,
    postings: parsed.data.postings.map((posting) => ({
      id: postingId(posting),
      title: posting.title,
      company: posting.company,
      location: posting.location,
      url: posting.url,
      ...(posting.postedAt ? { postedAt: posting.postedAt } : {}),
      highlights: posting.highlights ?? [],
      summary: posting.summary,
      matchReason: posting.matchReason,
    })),
    ...(parsed.data.notes ? { notes: parsed.data.notes } : {}),
  }
}

/**
 * The Run's time as a string, resolved here rather than in a component.
 *
 * Same rule as `lib/jobs/briefing-summary.ts` and
 * `components/documents/document-list.tsx`: a fixed locale, because the
 * server's default is whatever the platform decides, and an explicit zone that
 * is named in the output. UTC rather than the job's stored timezone — a Run has
 * no timezone of its own, and a time with no zone beside it reads as local and
 * is wrong by hours.
 */
function formatRunTime(date: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(date)
}
