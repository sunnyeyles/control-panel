"use client"

import { useActionState } from "react"

import { triggerBriefingRunAction } from "@/app/(app)/jobs/actions"
import { ActionError } from "@/components/forms/action-error"
import { SubmitButton } from "@workspace/ui/components/submit-button"
import { IDLE } from "@/lib/actions/action-state"

/**
 * Run one briefing now, rather than when its cadence next comes round.
 *
 * The form carries **the briefing's id and nothing else**. It is untrusted on
 * the way in and cannot name an owner: the action loads the job and requires
 * its owner to be the caller, answering the same message for "no such briefing"
 * and "not yours".
 *
 * `ActionError` rather than `ActionAlert` — errors only. The card's own state
 * changing to `Running…` is the success signal, so an alert saying so as well
 * would be the same news twice, and it would still be on screen after the run
 * had finished.
 */
export function RunNowButton({
  briefingId,
  briefingName,
  running = false,
}: {
  briefingId: string
  /** Only for the accessible label, so several buttons on a page differ. */
  briefingName: string
  /**
   * Whether a run is already going.
   *
   * ⚠️ Disables the button but is **not** the guard: this is state that was
   * true when the page was built, and a POST need not come from this form at
   * all, so the action re-checks server-side. It prevents the honest case —
   * clicking again because a running briefing has not visibly finished.
   */
  running?: boolean
}) {
  const [state, formAction, pending] = useActionState(
    triggerBriefingRunAction,
    IDLE
  )

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <input type="hidden" name="jobId" value={briefingId} />

      <SubmitButton
        pending={pending}
        disabled={running}
        variant="outline"
        size="sm"
        label="Run now"
        pendingLabel="Starting…"
        aria-label={`Run the ${briefingName} briefing now`}
      />

      <ActionError state={state} />
    </form>
  )
}
