"use client"

import { startTransition, useActionState, useOptimistic } from "react"

import { setPostingStatusAction } from "@/app/(app)/jobs/actions"
import { ActionError } from "@/components/forms/action-error"
import { IDLE } from "@/lib/actions/action-state"
import { POSTING_STATUS_LABELS } from "@/lib/postings/posting-status-labels"
import type { PostingStatus } from "@workspace/db"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@workspace/ui/components/select"

/**
 * The four statuses with their labels, in the label map's insertion order —
 * the order a person moves through them.
 *
 * ⚠️ Derived from the label map, not imported from `@workspace/db`:
 * `POSTING_STATUSES` is a *runtime* export of a package carrying the Prisma
 * client and `pg`, so a client component importing it ships a database driver
 * to spell four strings. See `lib/postings/posting-status-labels.ts`.
 *
 * The cast only recovers the key type `Object.entries` widens to `string`;
 * `satisfies Record<PostingStatus, string>` on the map already proves the set.
 */
const STATUS_OPTIONS = Object.entries(POSTING_STATUS_LABELS) as [
  PostingStatus,
  string,
][]

/** Whether a value the select emitted is one of the four. */
function isPostingStatus(value: string): value is PostingStatus {
  return STATUS_OPTIONS.some(([status]) => status === value)
}

/**
 * Where one application stands, as a control in the Posting's expanded detail.
 *
 * ⚠️ **Rendered at most once per page; it used to be twenty-five times.** A
 * select is a wide control to repeat down a page, and Radix sets
 * `aria-expanded` on its trigger while open, tripping the row highlight meant
 * for the disclosure chevron. The Status column is a read-only `Badge` for that
 * reason — putting this control back in the row re-creates both problems.
 *
 * **No `<form>`, and unlike `JobEnabledSwitch` there could not be**: a Radix
 * `Select` given a `name` posts nothing at all, so the payload is built in the
 * change handler from the value the user just chose.
 *
 * `postingId` is untrusted on the way out and cannot name a user: the action
 * pairs it with the *session's* user, so a stranger's id matches no row.
 */
export function PostingStatusSelect({
  postingId,
  status,
  title,
}: {
  postingId: string
  status: PostingStatus
  /**
   * Only for the accessible label: nothing in the control names the
   * advertisement it belongs to, and any of twenty-five detail panels can be
   * open with an identically labelled select.
   */
  title: string
}) {
  const [state, submit, pending] = useActionState(setPostingStatusAction, IDLE)

  /**
   * Without this the control visibly rejects the choice it just accepted:
   * `useActionState` holds the previous state until the action resolves, so the
   * trigger would keep showing the old status for the whole round trip and then
   * jump. On failure the optimistic value reverts on its own, which is exactly
   * right — the row did not change, so the control must not claim it did.
   */
  const [optimistic, setOptimistic] = useOptimistic(status)

  function onValueChange(next: string) {
    // The select cannot emit anything else; the guard is what lets the
    // optimistic value be a `PostingStatus` without a cast at the point where a
    // wrong one would be invisible.
    if (!isPostingStatus(next)) return

    const payload = new FormData()
    payload.set("postingId", postingId)
    payload.set("status", next)

    startTransition(() => {
      setOptimistic(next)
      submit(payload)
    })
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <Select
        value={optimistic}
        onValueChange={onValueChange}
        disabled={pending}
      >
        <SelectTrigger size="sm" aria-label={`Status for ${title}`}>
          <SelectValue />
        </SelectTrigger>

        <SelectContent>
          {STATUS_OPTIONS.map(([value, label]) => (
            <SelectItem key={value} value={value}>
              {label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/*
        Beside the control that failed, never a page-level banner: the detail
        panel is a scroll away from the top of a table of twenty-five, so a
        banner would sit off screen naming no advertisement.
      */}
      <ActionError state={state} />
    </div>
  )
}
