"use client"

import { useActionState } from "react"
import { ActionAlert } from "@/components/forms/action-alert"
import { SubmitButton } from "@workspace/ui/components/submit-button"

import { updateJobScheduleAction } from "@/app/(app)/jobs/schedules/actions"
import { IntervalField } from "@/components/briefings/jobs/interval-field"
import { IDLE } from "@/lib/actions/action-state"
import type { BriefingSummary } from "@/lib/jobs/briefing-summary"

/**
 * Change how often one briefing runs.
 *
 * A plain `<form action={…}>`, unlike the switch beside it: this one has a
 * submit button, which is exactly the case `useActionState` is shaped for.
 *
 * Note what this form cannot do: turn the briefing on. `updateSchedule()` keeps
 * a paused job paused — changing an interval must not be a back door to putting
 * a retired briefing back on duty — so the action says so in its success message
 * when the job is off.
 */
export function JobScheduleForm({ briefing }: { briefing: BriefingSummary }) {
  const [state, formAction, pending] = useActionState(
    updateJobScheduleAction,
    IDLE
  )

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="jobId" value={briefing.id} />

      {/*
        Not keyed on the reset key, unlike the create form. This field is the
        current schedule rather than a blank slate, so a success should leave it
        showing what was just saved — and the server re-render supplies the new
        value anyway.
      */}
      <IntervalField
        idPrefix={`job-${briefing.id}`}
        {...(briefing.intervalHours
          ? { defaultHours: briefing.intervalHours }
          : {})}
        pending={pending}
      />

      <div>
        <SubmitButton
          pending={pending}
          label="Save schedule"
          pendingLabel="Saving…"
        />
      </div>

      <ActionAlert state={state} />
    </form>
  )
}
