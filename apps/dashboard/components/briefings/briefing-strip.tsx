import { RunActivityStatus } from "@/components/briefings/run-activity-status"
import { RunNowButton } from "@/components/briefings/run-now-button"
import type { RunActivity } from "@/lib/briefing-runs/run-activity"
import { Skeleton } from "@workspace/ui/components/skeleton"

/**
 * One compact line per briefing, above the table.
 *
 * ⚠️ **This exists because the table has nowhere else to put these two
 * controls.** `RunNowButton` and `RunActivityStatus` used to hang off the
 * per-briefing card in `components/briefings/briefing-list.tsx`; a cumulative
 * table has no per-briefing row at all, so deleting that component without this
 * strip would have removed the ability to run a briefing on demand and to see
 * that one is running — a feature regression with nothing failing to compile to
 * announce it. Both controls are reused **unchanged**; what is new is only the
 * arrangement.
 *
 * A server component that takes only strings: `RunActivity` was formatted in
 * `lib/briefing-runs/run-activity.ts`, and the one live value on screen — the
 * elapsed counter — is a duration the client computes for itself.
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
 * ⚠️ **One row, which is a guess — and the alternative was a worse one.** The
 * strip sits directly above the table, so anything it does on arrival moves the
 * table. With no placeholder at all it pushed the whole table down by 72px on
 * every load, which is the jump most visible to someone whose eyes are already
 * on the first row. Reserving one row is right for one briefing, 72px too much
 * for none, and 72px short for two — so the error is bounded and, for the common
 * case, zero. This component cannot do better: how many briefings someone has is
 * the answer the query it is standing in for has not come back with yet.
 *
 * Beside the component rather than in `posting-table-skeleton.tsx` or in either
 * caller, so the markup it imitates is the next thing in the file. The two
 * callers — `page.tsx`'s `<Suspense fallback>` and `loading.tsx` — are the same
 * pair the table skeleton has, and drift between them is the same defect.
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
