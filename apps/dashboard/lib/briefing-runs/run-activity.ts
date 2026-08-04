import { latestRunPerJob, type PrismaClient } from "@workspace/db"

import { isStale } from "./staleness"

/**
 * The state of each briefing's most recent Run, whatever became of it.
 *
 * Deliberately separate from `lib/postings/list-postings.ts`, which asks a
 * different question — every Posting a user's briefings have ever found, with
 * no Run in the answer at all. This one is about what a Run is *doing*, and
 * merging them would give one type two jobs: the table is cumulative and has no
 * per-briefing row, while this is per-briefing and has nothing to say about
 * what was found.
 *
 * **Nothing here imports Next**, and the client arrives as an argument rather
 * than through `getPrisma()`, for the reason `list-postings.ts` gives: which
 * rows a user can reach is the interesting behaviour, and a page component
 * cannot be tested for it.
 */

/**
 * What the card shows beside its name.
 *
 * `stale` is split out from `running` rather than folded into `failed` because
 * they are different claims. A stale row means *nobody knows* — the worker
 * never wrote a terminal status, so the run may have finished, may have died,
 * and nothing will ever say which. Reporting that as a failure would assert
 * something untrue, and reporting it as running would spin forever.
 */
export type RunActivity =
  | { state: "never-run" }
  | { state: "running"; startedAt: string; startedAtIso: string }
  | { state: "stale"; startedAt: string }
  | { state: "succeeded"; ranAt: string }
  | { state: "failed"; ranAt: string; reason?: string }

export interface BriefingActivity {
  briefingId: string
  activity: RunActivity
}

/**
 * Is anything of this user's still going?
 *
 * What the page uses to decide whether to mount the poller at all — the app has
 * no other polling, and one that ran when nothing was happening would be a
 * request every few seconds for the life of the tab.
 */
export function anyRunning(activities: BriefingActivity[]): boolean {
  return activities.some(({ activity }) => activity.state === "running")
}

/**
 * The latest Run of every briefing this user owns.
 *
 * Scoped inside `latestRunPerJob`, which joins through `jobs` on `user_id`, so
 * — as with every read this app makes — there is no argument that could reach
 * another user's Run.
 */
export async function runActivityForUser(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date()
): Promise<BriefingActivity[]> {
  const runs = await latestRunPerJob(prisma, userId)

  return runs.map((run) => ({
    briefingId: run.jobId,
    activity: toActivity(run, now),
  }))
}

type LatestRun = Awaited<ReturnType<typeof latestRunPerJob>>[number]

function toActivity(run: LatestRun, now: Date): RunActivity {
  if (run.status === "running") {
    if (isStale(run.startedAt, now)) {
      return { state: "stale", startedAt: formatRunTime(run.startedAt) }
    }

    return {
      state: "running",
      startedAt: formatRunTime(run.startedAt),
      // The raw instant as well as the formatted one: the elapsed counter ticks
      // on the client and needs a value it can subtract, while everything
      // displayed is formatted here — see `formatRunTime` on why.
      startedAtIso: run.startedAt.toISOString(),
    }
  }

  const ranAt = formatRunTime(run.finishedAt ?? run.startedAt)

  if (run.status === "failed") {
    return { state: "failed", ranAt, ...reasonOf(run.failure) }
  }

  return { state: "succeeded", ranAt }
}

/**
 * The `failure` record's message, when it carries one worth showing.
 *
 * `RunFailure` is an opaque bag — `@workspace/db` never reads inside it — so
 * this reads defensively and shows nothing rather than `[object Object]` when
 * the shape is not what the worker writes.
 */
function reasonOf(failure: unknown): { reason?: string } {
  if (typeof failure !== "object" || failure === null) return {}

  const message = (failure as { message?: unknown }).message

  return typeof message === "string" && message.trim() !== ""
    ? { reason: message }
    : {}
}

/**
 * Formatted here, on the server, for the reason `lib/jobs/briefing-summary.ts`
 * gives: a `Date` crossing into a client component renders differently on the
 * two sides of hydration, and the fix is to send a string.
 */
function formatRunTime(at: Date): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(at)
}
