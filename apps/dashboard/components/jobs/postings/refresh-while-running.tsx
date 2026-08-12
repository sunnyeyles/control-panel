"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Re-render the page while a Run is in flight, and stop when none is.
 *
 * ⚠️ **The only polling in this app.** A Run is the one thing that changes with
 * nobody doing anything, minutes after the click that started it, so no Server
 * Action is in scope to invalidate at the moment the state changes.
 *
 * **`router.refresh()` rather than a fetch loop**, because what must change is
 * the server render: the page is `force-dynamic` and `staleTimes.dynamic` lets
 * the client router reuse the segment for 30s, which `refresh()` clears. A
 * fetch loop would need a JSON route and a second copy of the read model.
 *
 * It renders nothing — mounting it is the whole effect, and the page mounts it
 * only when something is running (see `anyRunning`).
 */

/** Slow enough not to hammer the database, fast enough to feel live. */
const EVERY_MS = 5000

/**
 * The backstop.
 *
 * `running` is a row's claim, not an observation, so a worker that died leaves
 * one saying `running` forever. `run-activity.ts` reclassifies such a row as
 * `stale` after fifteen minutes and the poller then stops on its own — this cap
 * exists for the case where that reclassification never happens either, and
 * costs nothing when it does.
 */
const GIVE_UP_AFTER_MS = 15 * 60 * 1000

export function RefreshWhileRunning({ active }: { active: boolean }) {
  const router = useRouter()

  useEffect(() => {
    if (!active) return

    const startedAt = Date.now()

    const timer = setInterval(() => {
      if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
        clearInterval(timer)
        return
      }

      // A background tab's timers are throttled rather than stopped, so without
      // this a tab left open overnight would keep waking up to re-render a page
      // nobody is looking at. `visibilitychange` below catches up on return.
      if (document.visibilityState !== "visible") return

      router.refresh()
    }, EVERY_MS)

    // Coming back to the tab should show the current state at once, not up to
    // five seconds later — and if the run finished while it was hidden, this is
    // the render that unmounts the poller.
    const onVisible = () => {
      if (document.visibilityState === "visible") router.refresh()
    }

    document.addEventListener("visibilitychange", onVisible)

    return () => {
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [active, router])

  return null
}
