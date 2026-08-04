"use client"

import { useRouter } from "next/navigation"
import { useEffect } from "react"

/**
 * Re-render the page while a Run is in flight, and stop when none is.
 *
 * ⚠️ **The only polling in this app.** Everything else is request/response:
 * mutate, `refresh()`, server re-render. A Run is the one thing that changes
 * without anyone doing anything, and it does so minutes after the click that
 * started it, so there is nothing for a Server Action to invalidate at the
 * moment the state actually changes.
 *
 * **`router.refresh()` rather than a fetch loop**, because the thing that must
 * change is the server render. The page is `force-dynamic` and
 * `staleTimes.dynamic` in `next.config.ts` lets the client router reuse the
 * segment for 30 seconds; `refresh()` is what clears that, and it is the same
 * mechanism the document and briefing actions already rely on. A fetch loop
 * would need a JSON route, a second copy of the read model, and a way to push
 * the result into a server component — three new things to buy what one call
 * already does.
 *
 * It renders nothing. Mounting it is the whole effect, and the page mounts it
 * **only when something is actually running** — see `anyRunning`. A poller left
 * armed on a quiet page is a request every few seconds for the life of the tab.
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
