import type { ActionState } from "@/lib/actions/action-state"
import { cn } from "@workspace/ui/lib/utils"

/**
 * The inline variant of {@link ActionAlert}, for a control with no room for a
 * box — a switch in a table row, a button inside a dialog.
 *
 * **Errors only.** These call sites sit next to a control whose own state is the
 * success signal: a switch that moved, a row that vanished. Announcing "Briefing
 * turned on" beside a switch that visibly turned on is noise, and the reason
 * these were never `ActionAlert` in the first place.
 *
 * The two hand-written copies this replaces had drifted — one carried
 * `aria-live="polite"` and the other did not, so one of them announced nothing
 * to a screen reader. Which is the ordinary fate of a block copied by hand and
 * exactly what a shared component is for.
 */
export function ActionError({
  state,
  className,
}: {
  state: ActionState
  className?: string
}) {
  if (state.status !== "error") return null

  return (
    <p
      className={cn("text-sm text-destructive", className)}
      role="status"
      aria-live="polite"
    >
      {state.message}
    </p>
  )
}
