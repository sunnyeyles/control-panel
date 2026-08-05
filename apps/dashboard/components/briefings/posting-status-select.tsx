"use client"

import { startTransition, useActionState, useOptimistic } from "react"

import { setPostingStatusAction } from "@/app/(app)/briefings/actions"
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
 * The three statuses with their labels, in the order they are offered.
 *
 * Derived from the label map rather than imported from `@workspace/db`, and the
 * difference is what ends up in the browser: `POSTING_STATUSES` is a *runtime*
 * export of a package that carries the Prisma client and `pg`, so importing it
 * into a client component would put a database driver in the bundle to spell
 * three strings. The `import type` above is erased entirely — see
 * `lib/postings/posting-status-labels.ts`, which exists for exactly this.
 *
 * The cast is the one thing `Object.entries` cannot give: it widens keys to
 * `string`, while `satisfies Record<PostingStatus, string>` on the map is what
 * already makes the compiler prove the set is complete and contains nothing
 * else. So the values are checked — just not here.
 */
const STATUS_OPTIONS = Object.entries(POSTING_STATUS_LABELS) as [
  PostingStatus,
  string,
][]

/** Whether a value the select emitted is one of the three. */
function isPostingStatus(value: string): value is PostingStatus {
  return STATUS_OPTIONS.some(([status]) => status === value)
}

/**
 * Where one application stands, as a control on its row.
 *
 * **There is no `<form>` here, and unlike `JobEnabledSwitch` there could not
 * be.** A Radix `Select` does not bubble a hidden input at all — the switch at
 * least renders a hidden checkbox when given a `name`, which is why that
 * component's docblock argues about checkbox semantics rather than about this.
 * A `Select` given a `name` posts nothing, so the payload is built in the change
 * handler from the value the user just chose, with no DOM or state read in
 * between.
 *
 * **`postingId` is untrusted on the way out and cannot name a user.** A Posting
 * is `(user, posting id)`, so the action pairs this id with the *session's*
 * user; a submitted id that belongs to someone else simply matches no row. See
 * `lib/postings/posting-actions.ts`.
 */
export function PostingStatusSelect({
  postingId,
  status,
  title,
}: {
  postingId: string
  status: PostingStatus
  /**
   * Only for the accessible label. Twenty-five of these sit on one page and the
   * trigger's own text is "New" or "Applied" repeated down the column, so a
   * screen reader is told which advertisement each one belongs to — a bare
   * "Status" twenty-five times names nothing.
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
        Beside the row that failed, never a banner at the top of the page: with
        twenty-five rows on screen, a page-level message names no advertisement
        and the one the user was looking at has already reverted underneath it.
      */}
      <ActionError state={state} />
    </div>
  )
}
