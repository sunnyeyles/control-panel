"use client"

import { useActionState } from "react"

import { saveTitleFiltersAction } from "@/app/(app)/jobs/schedules/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import { IDLE } from "@/lib/actions/action-state"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { SubmitButton } from "@workspace/ui/components/submit-button"

/**
 * The words that rule a posting out by its title.
 *
 * One field, one row, one button — the same shape as
 * `letter-instructions-form.tsx`, and for the same reason: a save is the whole
 * setting rather than a patch of it, so an emptied box genuinely means "no
 * filters" instead of "this form did not mention them".
 *
 * ⚠️ **Keyed on the stored value, not on the reset key.** The action tidies what
 * was typed, so the box must be replaced by what was actually stored or the
 * user sees a list differing from the one in force. Keying on the reset key
 * would blank the field on every success, reading as the save discarding them.
 *
 * `defaultValue` and uncontrolled, like the criteria fields: a starting point
 * edited by hand, with React never fighting the user for the caret.
 */
export function TitleFilterForm({
  titleExclusions,
}: {
  titleExclusions: string
}) {
  const [state, formAction, pending] = useActionState(
    saveTitleFiltersAction,
    IDLE
  )

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="title-exclusions">Excluded title words</Label>
        <Input
          key={`exclusions:${titleExclusions}`}
          id="title-exclusions"
          name="titleExclusions"
          defaultValue={titleExclusions}
          placeholder="senior, principal, tech lead"
          disabled={pending}
        />
        {/*
          Both halves said out loud: nobody expects already-collected postings
          to disappear, and the whole-words sentence is what stops "ml" being
          typed in the belief it only matches a machine-learning role.
        */}
        <p className="text-sm text-muted-foreground">
          Comma separated, and optional. A posting whose title contains one of
          these words is left out of every briefing, and hidden from Postings if
          it was already found — nothing is deleted, and clearing this brings
          them back.
        </p>
        <p className="text-sm text-muted-foreground">
          Whole words only, ignoring case: <em>senior</em> hides “Senior Backend
          Engineer” and not “Seniority Partners”.
        </p>
      </div>

      <div>
        <SubmitButton
          pending={pending}
          label="Save filters"
          pendingLabel="Saving…"
        />
      </div>

      <ActionAlert state={state} />
    </form>
  )
}
