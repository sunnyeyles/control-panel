import { latestRunPerJob, type PrismaClient } from "@workspace/db"

import { formatRunTime } from "@/lib/format-dates"

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
 *
 * `note` on the succeeded arm is how a run that worked and found nothing stops
 * being silent. A `succeeded` row used to say "Last ran 5 minutes ago" and
 * nothing else, whether the run had added twenty postings or none — the table
 * was simply unchanged, with no reason for it anywhere a user could reach. The
 * worker writes the sentence into `runs.failure` on a succeeded row, which is
 * exactly what that column is for ("succeeded with warnings is `succeeded` with
 * a non-empty `failure`" — `@workspace/db`'s `types.ts`).
 */
export type RunActivity =
  | { state: "never-run" }
  | { state: "running"; startedAt: string; startedAtIso: string }
  | { state: "stale"; startedAt: string }
  | { state: "succeeded"; ranAt: string; note?: string }
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

  return { state: "succeeded", ranAt, ...noteOf(run.failure) }
}

/**
 * The `failure` record's message, when it carries one worth showing.
 *
 * `RunFailure` is an opaque bag — `@workspace/db` never reads inside it — so
 * this reads defensively and shows nothing rather than `[object Object]` when
 * the shape is not what the worker writes.
 */
function reasonOf(failure: unknown): { reason?: string } {
  return { ...rename(messageAt(failure, []), "reason") }
}

/**
 * Why a successful run added nothing, when that is what happened.
 *
 * The same defensive read as {@link reasonOf} one level down: the warning bag on
 * a succeeded row holds a key per thing that went wrong, and only `noPostings`
 * is about the run having produced nothing. The other keys are lost writes and
 * dropped ids — real, and not what somebody is asking when they look at a
 * briefing whose table did not change.
 */
function noteOf(failure: unknown): { note?: string } {
  return { ...rename(messageAt(failure, ["noPostings"]), "note") }
}

/** `bag.a.b.message`, if every step of that is what it needs to be. */
function messageAt(bag: unknown, path: string[]): string | undefined {
  let cursor = bag

  for (const key of [...path, "message"]) {
    if (typeof cursor !== "object" || cursor === null) return undefined
    cursor = (cursor as Record<string, unknown>)[key]
  }

  return typeof cursor === "string" && cursor.trim() !== "" ? cursor : undefined
}

/** The message under the key its arm of {@link RunActivity} calls it by. */
function rename<K extends string>(
  message: string | undefined,
  key: K
): Partial<Record<K, string>> {
  return message === undefined ? {} : ({ [key]: message } as Record<K, string>)
}
