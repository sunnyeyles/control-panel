"use client"

import { useState } from "react"

import {
  DEFAULT_INTERVAL_HOURS,
  describeInterval,
  INTERVAL_HOURS,
  type IntervalHours,
} from "@/lib/jobs/interval"
import { Label } from "@workspace/ui/components/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

/**
 * How often a briefing runs — the entire schedule control.
 *
 * One select, no time of day, no timezone and no cron field. Shared by the
 * create and edit forms so both post the same `hours` value and cannot come to
 * disagree about what an interval means.
 */
export function IntervalField({
  idPrefix,
  defaultHours,
  pending,
}: {
  /** Distinguishes label/control ids when two of these are on one page. */
  idPrefix: string
  /**
   * Omitted when creating, and also when the stored expression is not one of
   * the offered intervals — a hand-written cron has no interval to preselect,
   * so the picker falls back rather than inventing one.
   */
  defaultHours?: IntervalHours
  pending: boolean
}) {
  const [hours, setHours] = useState<IntervalHours>(
    defaultHours ?? DEFAULT_INTERVAL_HOURS
  )

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={`${idPrefix}-hours`}>Run every</Label>
      <Select
        value={String(hours)}
        onValueChange={(value) => setHours(Number(value) as IntervalHours)}
        disabled={pending}
      >
        <SelectTrigger id={`${idPrefix}-hours`} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {INTERVAL_HOURS.map((value) => (
            <SelectItem key={value} value={String(value)}>
              {value === 1 ? "1 hour" : `${value} hours`}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-sm text-muted-foreground">
        {describeInterval(hours)}, on the hour, UTC. Each run is a paid search.
      </p>

      {/*
        A Radix Select renders a button, not a <select>, so its value never
        reaches FormData on its own. This hidden input is what actually submits
        the interval — omitting it is the quiet way this posts no schedule at
        all.
      */}
      <input type="hidden" name="hours" value={String(hours)} />
    </div>
  )
}
