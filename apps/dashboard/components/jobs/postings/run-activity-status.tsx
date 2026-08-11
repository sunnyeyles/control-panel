"use client"

import { useEffect, useState } from "react"

import type { RunActivity } from "@/lib/briefing-runs/run-activity"
import { Spinner } from "@workspace/ui/components/spinner"

/**
 * What a briefing's most recent Run is doing, beside its name.
 *
 * Every displayed instant arrives pre-formatted from the server — see
 * `run-activity.ts` — so nothing here formats a `Date`. The one live value is
 * the elapsed counter, which is a *duration* rather than a time and so cannot
 * disagree across hydration in the way a formatted date would; it still starts
 * at `null` and fills in after mount, because the first client render has to
 * match the server's.
 */
export function RunActivityStatus({ activity }: { activity: RunActivity }) {
  switch (activity.state) {
    case "never-run":
      return <Muted>Has not run yet</Muted>

    case "running":
      return (
        <span className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          <span>
            Running… <Elapsed since={activity.startedAtIso} />
          </span>
        </span>
      )

    case "stale":
      return (
        <Muted>
          Started {activity.startedAt} and never reported back. Try running it
          again.
        </Muted>
      )

    case "succeeded":
      // The note is only ever there when the run added nothing, and it is the
      // only thing on the page that says so — the table simply looks unchanged.
      return (
        <Muted>
          Last ran {activity.ranAt}
          {activity.note ? ` — ${activity.note}` : ""}
        </Muted>
      )

    case "failed":
      return (
        <span className="text-sm text-destructive">
          Failed {activity.ranAt}
          {activity.reason ? ` — ${activity.reason}` : ""}
        </span>
      )
  }
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-sm text-muted-foreground">{children}</span>
}

/**
 * `m:ss` since the run started, ticking.
 *
 * `null` until the first effect runs. The server cannot know what the client's
 * clock says, and rendering a duration computed from the server's would produce
 * a hydration mismatch on every mount — so the first paint deliberately shows
 * nothing and the number appears a tick later.
 */
function Elapsed({ since }: { since: string }) {
  const [seconds, setSeconds] = useState<number | null>(null)

  useEffect(() => {
    const startedAt = new Date(since).getTime()
    const tick = () =>
      setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)))

    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [since])

  if (seconds === null) return null

  const minutes = Math.floor(seconds / 60)
  const rest = String(seconds % 60).padStart(2, "0")

  return (
    <span className="tabular-nums">
      {minutes}:{rest}
    </span>
  )
}
