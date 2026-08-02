"use client"

import { useActionState } from "react"

import { createJobAction } from "@/app/(app)/settings/actions"
import { IntervalField } from "@/components/settings/interval-field"
import { IDLE } from "@/lib/jobs/action-state"
import { Alert, AlertDescription } from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { Spinner } from "@workspace/ui/components/spinner"

export function CreateBriefingForm() {
  const [state, formAction, pending] = useActionState(createJobAction, IDLE)

  return (
    <form
      action={formAction}
      className="flex flex-col gap-4 rounded-lg border p-4"
    >
      {/*
        Keyed on the new job's id, so exactly one success clears the fields —
        and no effect is involved. An error state carries the previous nonce
        forward precisely so this key holds still through a failure; keying on
        `status === "success"` instead would remount the fields and discard
        everything typed, at the moment the user is being told to fix one of
        them.
      */}
      <CreateFields
        key={state.status === "idle" ? "new" : (state.nonce ?? "new")}
        pending={pending}
      />

      {state.status !== "idle" ? (
        <Alert
          variant={state.status === "success" ? "default" : "destructive"}
          role="status"
          aria-live="polite"
        >
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      ) : null}
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
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner /> : null}
          {pending ? "Creating…" : "Create briefing"}
        </Button>
      </div>
    </>
  )
}
