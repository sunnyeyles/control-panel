import * as React from "react"
import type { ReactNode } from "react"

import { Button } from "@workspace/ui/components/button"
import { Spinner } from "@workspace/ui/components/spinner"

/**
 * A submit button that shows the action running.
 *
 * A spinner, not a progress bar: a Server Action surfaces no progress events,
 * so a bar would be fake or stuck at zero — both read as the app having hung.
 *
 * `pending` is passed in, not read from `useFormStatus()`: callers hold it from
 * `useActionState`, and some dispatch without a `<form>` at all. `disabled`
 * composes with it rather than replacing it.
 */
function SubmitButton({
  pending,
  label,
  pendingLabel,
  disabled,
  icon,
  ...props
}: {
  pending: boolean
  label: string
  /**
   * Shown in place of `label` while pending. Omit when the label is already
   * short enough to leave alone — a delete button often says "Delete"
   * throughout, because a dialog that changes its own button text mid-confirm
   * is worse.
   */
  pendingLabel?: string
  disabled?: boolean
  /**
   * Leading icon, shown only while idle. The pending spinner takes its place
   * so the button does not grow a second glyph mid-submit.
   */
  icon?: ReactNode
} & Omit<React.ComponentProps<typeof Button>, "children">) {
  return (
    <Button type="submit" disabled={pending || disabled} {...props}>
      {pending ? <Spinner /> : icon}
      {pending ? (pendingLabel ?? label) : label}
    </Button>
  )
}

export { SubmitButton }
