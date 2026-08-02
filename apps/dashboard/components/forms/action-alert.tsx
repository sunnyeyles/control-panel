import type { ActionState } from "@/lib/actions/action-state"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"

/**
 * What a Server Action just said, as a boxed alert.
 *
 * Renders nothing while the state is `idle`, so a form can drop it in
 * unconditionally rather than repeating the `status !== "idle"` test.
 *
 * `role="status"` with `aria-live="polite"` rather than `role="alert"`: the
 * message arrives in response to something the user did, so it should be
 * announced after the current utterance finishes rather than interrupting it.
 * That pairing was already correct at every call site and is now impossible to
 * get wrong at a new one.
 *
 * Not a client component. It takes a plain serializable prop and renders no
 * interactivity, so it stays a server component and is simply rendered inside
 * whichever client form owns the state.
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
