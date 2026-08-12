"use client"

import { useActionState } from "react"

import {
  suggestRoleTitlesAction,
  updateJobCriteriaAction,
} from "@/app/(app)/jobs/schedules/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import { CriteriaFields } from "@/components/jobs/schedules/criteria-fields"
import { RoleTitleSuggestForm } from "@/components/jobs/schedules/role-title-suggest-form"
import { useCriteriaDraft } from "@/components/jobs/schedules/use-criteria-draft"
import { IDLE } from "@/lib/actions/action-state"
import type { BriefingCriteriaView } from "@/lib/jobs/briefing-summary"
import { ROLE_TITLES_IDLE } from "@/lib/jobs/criteria-suggestion"
import { MAX_ROLE_TITLES, splitCriteria } from "@/lib/jobs/criteria-text"
import { SubmitButton } from "@workspace/ui/components/submit-button"

/**
 * Change what an existing briefing searches for.
 *
 * The criteria were write-once until this existed: changing a role title meant
 * deleting the briefing and building another, losing its name, its schedule and
 * the fact that it had been running.
 *
 * **Collapsed by default**, since four briefings would otherwise stack four
 * full criteria forms down a page most visits change nothing on. `<details>`
 * rather than the Collapsible primitive, matching `briefing-section.tsx`.
 *
 * ⚠️ **No `key` on the fields, unlike the create form.** There is no suggestion
 * to remount for — the fields are seeded from the stored config and the
 * adjacent-titles buttons write into the value rather than replacing it — and
 * the update action returns a constant `resetKey` for exactly that reason. A
 * key that changed on save would blank what was just saved and rebuild it from
 * a server render that has not landed yet.
 */
export function EditCriteriaForm({
  briefingId,
  criteria,
}: {
  briefingId: string
  criteria: BriefingCriteriaView
}) {
  const [state, action, saving] = useActionState(updateJobCriteriaAction, IDLE)

  const [titlesState, titlesAction, suggestingTitles] = useActionState(
    suggestRoleTitlesAction,
    ROLE_TITLES_IDLE
  )

  const draft = useCriteriaDraft({
    titles: criteria.titles,
    locations: criteria.locations,
  })

  const adjacent =
    titlesState.status === "success" ? titlesState.titles : undefined

  /*
    A briefing written before the cap existed, or by hand, can hold more titles
    than the form now permits. It keeps running exactly as it did — the worker's
    schema was deliberately not narrowed — but it cannot be saved from here
    until it is trimmed, and the submit button is disabled meanwhile. Said out
    loud, because a button that refuses with no explanation reads as a bug.
  */
  const overCap = splitCriteria(draft.titles).length > MAX_ROLE_TITLES

  return (
    <details className="rounded-md border p-3">
      <summary className="cursor-pointer text-sm font-medium">
        Search criteria
      </summary>

      <div className="flex flex-col gap-4 pt-4">
        <RoleTitleSuggestForm
          action={titlesAction}
          chosen={draft.titles}
          state={titlesState}
          pending={suggestingTitles || saving}
        />

        <form action={action} className="flex flex-col gap-4">
          {/*
            The row this edits. Validated as a uuid and then checked for
            ownership against the *session* before anything is written — see
            `updateJobCriteriaAction`. A uuid in a form names nothing on its own.
          */}
          <input type="hidden" name="jobId" value={briefingId} />

          <CriteriaFields
            draft={draft}
            suggestedLocations={criteria.locations}
            suggestedKeywords={criteria.keywords}
            titleSuggestions={
              adjacent
                ? [{ source: "Roles adjacent to these", titles: adjacent }]
                : []
            }
            pending={saving}
            idPrefix={`briefing-${briefingId}`}
          />

          {overCap ? (
            <p className="text-sm text-destructive" aria-live="polite">
              This briefing has more than {MAX_ROLE_TITLES} role titles, from
              before that was the limit. It keeps running as it is — but to save
              a change here, remove the extras or move them to a second
              briefing.
            </p>
          ) : null}

          <div>
            <SubmitButton
              pending={saving}
              disabled={!draft.fits || overCap}
              label="Save criteria"
              pendingLabel="Saving…"
            />
          </div>
        </form>

        <ActionAlert state={state} />
      </div>
    </details>
  )
}
