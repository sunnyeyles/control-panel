import { RunActivityStatus } from "@/components/jobs/postings/run-activity-status"
import { RunNowButton } from "@/components/jobs/postings/run-now-button"
import type { RunActivity } from "@/lib/briefing-runs/run-activity"
import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * One compact line per briefing, above the table.
 *
 * ⚠️ **This exists because the table has nowhere else to put these two
 * controls.** A cumulative table has no per-briefing row, so retiring the old
 * briefing card without this strip would have silently removed the ability to
 * run a briefing on demand and see that one is running. Both controls are
 * reused unchanged; only the arrangement is new.
 *
 * A server component taking only strings — `RunActivity` is formatted in
 * `lib/briefing-runs/run-activity.ts`, and the elapsed counter is computed
 * client-side.
 */
export interface BriefingStripEntry {
  id: string
  name: string
  /**
   * The most recent Run of this briefing, whatever became of it.
   *
   * `never-run` for a briefing that has none, which is a real and common state
   * rather than a missing value — the activity load only returns briefings that
   * have run at least once.
   */
  activity: RunActivity
}

export function BriefingStrip({
  briefings,
}: {
  briefings: readonly BriefingStripEntry[]
}) {
  // Nothing to arrange, and the table's own "no briefings yet" empty state is
  // already saying what to do about it. An empty bordered box above it would be
  // the same news with no words.
  if (briefings.length === 0) return null

  return (
    <div className="divide-y rounded-lg border">
      {briefings.map((briefing) => (
        <div
          key={briefing.id}
          className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
        >
          <div className="flex flex-col gap-1">
            <span className="font-medium">{briefing.name}</span>
            <RunActivityStatus activity={briefing.activity} />
          </div>

          <RunNowButton
            briefingId={briefing.id}
            briefingName={briefing.name}
            running={briefing.activity.state === "running"}
          />
        </div>
      ))}
    </div>
  )
}

/**
 * The strip's shape while the activity load is in flight.
 *
 * ⚠️ **One row, which is a guess — and the alternative was worse.** The strip
 * sits directly above the table, so no placeholder at all pushed it down 72px
 * on every load. One row is exact for one briefing and 72px out either way for
 * none or two, so the error is bounded and zero in the common case; this
 * component cannot do better, since the count is what the pending query answers.
 *
 * Beside the component so the markup it imitates is the next thing in the file.
 * Its two callers are the pair the table skeleton has, and drift between them
 * is the same defect.
 */
export function BriefingStripSkeleton() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading briefings"
      className="divide-y rounded-lg border"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
        <div className="flex flex-col gap-1">
          {/* The name, then the status line `RunActivityStatus` renders. */}
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-4 w-56" />
        </div>

        {/* `Run now` — an `outline`, `sm` button, so `h-7`. */}
        <Skeleton className="h-7 w-20" />
      </div>
    </div>
  )
}
