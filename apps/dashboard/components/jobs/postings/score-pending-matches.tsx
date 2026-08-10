"use client"

import { useEffect, useRef, useState } from "react"

import { scorePendingMatchesAction } from "@/app/(app)/jobs/actions"

/**
 * The thing that actually scores Postings, and the line that says it is
 * happening.
 *
 * ⚠️ **This exists because nothing else can do it.** Scoring reads the
 * candidate's CV, and the briefing worker holds the `prod:briefs` S3 grant and
 * nothing more — `infra/aws/tests/vercel_dashboard.tftest.hcl` asserts the two
 * roles' grants stay disjoint. So the process that finds an advertisement is
 * structurally unable to score it, and the backlog is worked through here, on
 * the page where the scores are read. A briefing that runs overnight leaves its
 * Postings unscored until somebody opens `/jobs`, which is the honest cost of
 * that boundary rather than an oversight.
 *
 * ⚠️ **The loop terminates on "the last round scored nothing", not on
 * `remaining === 0`.** A Posting that fails scoring stays unscored and is
 * therefore picked again by the very next round — so a permanently failing
 * advertisement, or a provider that is refusing every call, would spin here
 * forever on a count that never reaches zero. A round that wrote nothing is the
 * signal to stop, whatever the count says, and the next page view tries again
 * from scratch.
 *
 * Mounted only when the table has rows — see `page.tsx`. It renders nothing at
 * all once there is nothing left to do, so a page whose Postings are all scored
 * shows one cheap request and no chrome.
 */
export function ScorePendingMatches() {
  const [state, setState] = useState<State>({ phase: "starting" })
  /**
   * ⚠️ **A ref, and it is what makes the effect run once.** React's StrictMode
   * mounts, unmounts and remounts every component in development, so an effect
   * with an empty dependency list fires twice — and each firing here is a round
   * of model calls. A ref is consulted and set synchronously within one call,
   * which state would not be.
   */
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true

    // Set false by the cleanup, so a navigation away mid-round does not set
    // state on an unmounted component. The round itself is not cancelled: the
    // writes it has already made are wanted either way.
    let live = true

    async function run() {
      let scoredTotal = 0

      for (;;) {
        let result: Awaited<ReturnType<typeof scorePendingMatchesAction>>

        try {
          result = await scorePendingMatchesAction()
        } catch (error) {
          // The action rejected rather than returning its union — the network
          // went away, or the deployment did. Its own failures come back
          // through the branches below.
          console.error("postings: could not score", error)
          if (live) setState({ phase: "done" })
          return
        }

        if (!live) return

        if (result.status === "unavailable") {
          setState({ phase: "unavailable", message: result.message })
          return
        }

        if (result.status === "error") {
          // Deliberately silent to the reader. Nothing was lost — the rows stay
          // unscored and the next page view tries again — and a red alert over
          // a table full of advertisements would be about a background task
          // they did not ask for.
          setState({ phase: "done" })
          return
        }

        scoredTotal += result.scored

        // The termination condition, stated once. See the docblock above for
        // why it is not `remaining === 0`.
        if (result.scored === 0 || result.remaining === 0) {
          setState({ phase: "done" })
          return
        }

        setState({
          phase: "working",
          scored: scoredTotal,
          remaining: result.remaining,
        })
      }
    }

    void run()

    return () => {
      live = false
    }
  }, [])

  if (state.phase === "done") return null

  if (state.phase === "unavailable") {
    return <p className="text-sm text-muted-foreground">{state.message}</p>
  }

  return (
    <p aria-live="polite" className="text-sm text-muted-foreground">
      {state.phase === "starting"
        ? "Scoring your postings against your resume…"
        : `Scoring your postings against your resume — ${state.scored} done, ${state.remaining} to go.`}
    </p>
  )
}

/**
 * ⚠️ **`starting` is not `working`, because the first round is the only one
 * with no numbers to report.** Nothing is known about the size of the backlog
 * until a round comes back, and a count of zero on screen while eight model
 * calls are in flight reads as "nothing is happening".
 */
type State =
  | { phase: "starting" }
  | { phase: "working"; scored: number; remaining: number }
  | { phase: "unavailable"; message: string }
  | { phase: "done" }
