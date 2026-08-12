import type { ActionState } from "@/lib/actions/action-state"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

/**
 * What a Server Action just said, as a boxed alert.
 *
 * Renders nothing while the state is `idle`, so a form can drop it in
 * unconditionally rather than repeating the `status !== "idle"` test.
 *
 * `role="status"` with `aria-live="polite"` rather than `role="alert"`: the
 * message answers something the user did, so it should be announced after the
 * current utterance rather than interrupting it.
 *
 * Not a client component — a plain serializable prop and no interactivity, so
 * it renders inside whichever client form owns the state.
 */
export function ActionAlert({ state }: { state: ActionState }) {
  if (state.status === "idle") return null

  return (
    <Alert
      variant={state.status === "success" ? "default" : "destructive"}
      role="status"
      aria-live="polite"
    >
      <AlertDescription>{state.message}</AlertDescription>
    </Alert>
  )
}
