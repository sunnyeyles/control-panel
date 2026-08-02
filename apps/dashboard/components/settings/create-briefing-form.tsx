"use client"

import { useActionState } from "react"
import { ActionAlert } from "@/components/forms/action-alert"
import { SubmitButton } from "@/components/forms/submit-button"

import { createJobAction } from "@/app/(app)/settings/actions"
import { IntervalField } from "@/components/settings/interval-field"
import { IDLE } from "@/lib/actions/action-state"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"

export function CreateBriefingForm() {
  const [state, formAction, pending] = useActionState(createJobAction, IDLE)

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      {/*
        Keyed on the new job's id, so exactly one success clears the fields —
        and no effect is involved. An error state carries the previous key
        forward precisely so this key holds still through a failure; keying on
        `status === "success"` instead would remount the fields and discard
        everything typed, at the moment the user is being told to fix one of
        them.
      */}
      <CreateFields
        key={state.status === "idle" ? "new" : (state.resetKey ?? "new")}
        pending={pending}
      />

      <ActionAlert state={state} />
    </form>
  )
}

function CreateFields({ pending }: { pending: boolean }) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="briefing-name">Name</Label>
        <Input
          id="briefing-name"
          name="name"
          required
          maxLength={80}
          placeholder="Morning briefing"
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">
          Just a label, and it has to be unique among your briefings.
        </p>
      </div>

      {/*
        Required, not optional, and not a nicety. The worker's config schema
        needs at least one title and one location — a briefing created without
        them would claim its first slot, spend the claim, and then fail on a
        config it cannot read. See lib/jobs/search-criteria.ts.
      */}
      <div className="flex flex-col gap-2">
        <Label htmlFor="briefing-titles">Role titles</Label>
        <Input
          id="briefing-titles"
          name="titles"
          required
          placeholder="senior backend engineer, staff engineer"
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">
          Comma separated. These are what the scout searches for.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="briefing-locations">Locations</Label>
        <Input
          id="briefing-locations"
          name="locations"
          required
          placeholder="Sydney, Remote (Australia)"
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">Comma separated.</p>
      </div>

      <IntervalField idPrefix="briefing-new" pending={pending} />

      <div>
        <SubmitButton
          pending={pending}
          label="Create briefing"
          pendingLabel="Creating…"
        />
      </div>
    </>
  )
}
