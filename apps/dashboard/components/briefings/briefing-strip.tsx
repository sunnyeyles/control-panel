import { RunActivityStatus } from "@/components/briefings/run-activity-status"
import { RunNowButton } from "@/components/briefings/run-now-button"
import type { RunActivity } from "@/lib/briefing-runs/run-activity"

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
