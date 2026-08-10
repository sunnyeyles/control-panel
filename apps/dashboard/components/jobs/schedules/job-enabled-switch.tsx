"use client"

import { startTransition, useActionState, useOptimistic } from "react"
import { ActionError } from "@/components/forms/action-error"

import { setJobEnabledAction } from "@/app/(app)/jobs/schedules/actions"
import { IDLE } from "@/lib/actions/action-state"
import { Switch } from "@workspace/ui/components/switch"

/**
 * The on/off control for one briefing.
 *
 * **There is no `<form>` here, and that is deliberate.** A switch is not a
 * submit control, and the two obvious ways of making it behave like one are both
 * subtly wrong:
 *
 * 1. Reading the switch's own value. A Radix `Switch` does bubble a hidden
 *    checkbox when given a `name` — unlike `Select`, which does not — but it
 *    inherits checkbox semantics, so *unchecked submits nothing at all* and the
 *    server would see an absent field rather than `"false"`.
 * 2. A hidden input holding "the opposite of what is currently rendered", posted
 *    with `requestSubmit()`. That reads fine and races: between a successful
 *    toggle and the `refresh()` payload landing, the input still describes the
 *    *old* prop, so a quick second click re-posts the value just written.
 *
 * Building the payload from the handler's own `next` has neither problem — the
 * value submitted is the value the user just asked for, with no DOM or state
 * read in between.
 */
export function JobEnabledSwitch({
  jobId,
  enabled,
  name,
}: {
  jobId: string
  enabled: boolean
  /** Only for the accessible label; the switch itself carries no visible text. */
  name: string
}) {
  const [state, submit, pending] = useActionState(setJobEnabledAction, IDLE)

  /**
   * Without this the control visibly rejects the click it just accepted:
   * `useActionState` holds the previous state until the action resolves, so the
   * switch would sit in its old position for the whole round trip and then jump.
   * On failure the optimistic value reverts on its own, which is exactly right —
   * the briefing did not change, so the switch should not claim it did.
   */
  const [optimistic, setOptimistic] = useOptimistic(enabled)

  function onCheckedChange(next: boolean) {
    const payload = new FormData()
    payload.set("jobId", jobId)
    payload.set("enabled", String(next))

    startTransition(() => {
      setOptimistic(next)
      submit(payload)
    })
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Switch
        checked={optimistic}
        onCheckedChange={onCheckedChange}
        disabled={pending}
        aria-label={`Turn ${name} ${optimistic ? "off" : "on"}`}
      />
      <ActionError state={state} />
    </div>
  )
}
