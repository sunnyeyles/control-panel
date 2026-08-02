import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"

/**
 * A submit button that shows the action running.
 *
 * A spinner, not a progress bar — and that is a real constraint rather than a
 * style choice. A Server Action surfaces no progress events, so a bar would
 * either be fake or sit at zero, both of which read as the app having hung.
 *
 * `pending` is passed in rather than read from `useFormStatus()`. The forms here
 * already hold it from `useActionState`, and one of them — the enabled switch —
 * dispatches without a `<form>` at all, so there is no form status to read.
 *
 * `disabled` composes with `pending` rather than replacing it: the uploader
 * disables on a client-side size check *and* while submitting.
 */
export function SubmitButton({
  pending,
  label,
  pendingLabel,
  disabled,
  ...props
}: {
  pending: boolean
  label: string
  /**
   * Shown in place of `label` while pending. Omit when the label is already
   * short enough to leave alone — the delete button says "Delete" throughout,
   * because a dialog that changes its own button text mid-confirm is worse.
   */
  pendingLabel?: string
  disabled?: boolean
} & Omit<React.ComponentProps<typeof Button>, "children">) {
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending ? <Spinner /> : null}
      {pending ? (pendingLabel ?? label) : label}
    </Button>
  )
}
