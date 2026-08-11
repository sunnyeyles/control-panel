"use client"

import { SparklesIcon } from "lucide-react"

import { ActionError } from "@/components/forms/action-error"
import type { RoleTitleSuggestionState } from "@/lib/jobs/criteria-suggestion"
import { SubmitButton } from "@workspace/ui/components/submit-button"

/**
 * The second suggestion: role titles adjacent to the ones already chosen.
 *
 * Its own `<form>`, because a form cannot contain a form and this one submits
 * alongside the create or edit form rather than inside it. `example-letter-
 * import.tsx` is a separate form for the same pair of reasons — suggesting is
 * not saving, and two submit buttons in one form make the Enter key ambiguous.
 *
 * **Unlike "Suggest from my resume", this posts a field**, and the hidden input
 * is that field: the titles chosen so far, which the suggester is told not to
 * propose back. It is the user's own text, and it reaches the prompt as fenced
 * quoted material and nothing else — no part of it selects a document or names
 * a user, which stays the property both suggest actions hold.
 *
 * Shared by the new-briefing form and the edit form on each card, which offer
 * the same button over the same action.
 */
export function RoleTitleSuggestForm({
  action,
  chosen,
  state,
  pending,
}: {
  action: (formData: FormData) => void
  /** The titles field's current value, submitted as the exclusion set. */
  chosen: string
  state: RoleTitleSuggestionState
  pending: boolean
}) {
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="titles" value={chosen} />

      <div>
        <SubmitButton
          pending={pending}
          icon={<SparklesIcon data-icon="inline-start" />}
          label="Suggest related titles"
          pendingLabel="Thinking…"
          variant="secondary"
        />
      </div>

      {/*
        The suggester's own remark about its answer. Load-bearing for the empty
        case in particular, together with the sentence below it: a successful
        call that proposed nothing renders no buttons at all, which without
        either would be indistinguishable from a call that failed silently.
      */}
      {state.status === "success" && state.notes ? (
        <p className="text-sm text-muted-foreground">{state.notes}</p>
      ) : null}

      {state.status === "success" && state.titles.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing to add — the titles you have already cover what your resume
          supports.
        </p>
      ) : null}

      {/*
        Narrowed before it is handed over: `ActionError` takes an `ActionState`,
        and only this union's error case is one. The same narrowing the resume
        suggestion does, for the same reason.
      */}
      {state.status === "error" ? <ActionError state={state} /> : null}
    </form>
  )
}
