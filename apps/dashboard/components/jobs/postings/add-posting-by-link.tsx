"use client"

import { useActionState } from "react"

import { addPostingByLinkAction } from "@/app/(app)/jobs/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import { IDLE } from "@/lib/actions/action-state"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import { SubmitButton } from "@workspace/ui/components/submit-button"

/**
 * Add a Posting the briefings did not find, by pasting its link.
 *
 * The form carries **the URL and nothing else**, and the URL is not identity:
 * the session says who is adding it and `postingId()` derives the row's id from
 * the link server-side. Everything that could go wrong with what is typed here
 * is decided in `lib/postings/add-by-link-actions.ts` — this component
 * validates nothing on its own account.
 *
 * `ActionAlert` rather than `ActionError`, unlike `RunNowButton` beside it, and
 * the difference is which signal the page already carries. A started run turns
 * its own strip row to "Running…"; an added Posting appears somewhere in a
 * sorted, paginated table of every advertisement the user has ever seen, which
 * on any page but the first is no signal at all. So the success is said out
 * loud, and it names the role so that "added" is checkable rather than merely
 * claimed.
 *
 * ⚠️ **Keyed on `resetKey`, which is what clears the field.** A success mints
 * the Posting's id; remounting on it empties the input, so the next paste does
 * not start by selecting what is already there. A failure carries the previous
 * key unchanged (`carryResetKey`), so the link stays in the box to be corrected
 * — which is the whole reason this is two components rather than one.
 */
export function AddPostingByLink() {
  const [state, formAction, pending] = useActionState(
    addPostingByLinkAction,
    IDLE
  )

  const key = state.status === "idle" ? "new" : (state.resetKey ?? "new")

  return (
    <div className="flex flex-col gap-2">
      <LinkField key={key} formAction={formAction} pending={pending} />
      <ActionAlert state={state} />
    </div>
  )
}

/**
 * The same block, inert, for `app/(app)/jobs/loading.tsx`.
 *
 * Co-located with the real thing for the reason `BriefingStripSkeleton` is: the
 * two are swapped for each other mid navigation, so anything that differs
 * between them is a jump the user sees, and keeping them in one file is what
 * makes a change to one obviously a change to both.
 *
 * ⚠️ **A skeleton rather than the real component, unlike `<JobTabs />` in that
 * same file.** The tabs are static markup off `usePathname` and can simply be
 * drawn. This one owns `useActionState` and an input: rendering it in the
 * fallback would mount a live field that is then thrown away and remounted when
 * the page arrives, taking anything typed into it with it.
 *
 * It is the same elements with the same classes, disabled — not a grey bar —
 * because the height has to match exactly and the surest way to match a form's
 * height is to be that form.
 */
export function AddPostingByLinkSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Add a posting by link</span>

        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            type="url"
            disabled
            placeholder="https://…"
            className="sm:flex-1"
            tabIndex={-1}
          />
          <SubmitButton
            pending={false}
            disabled
            variant="outline"
            label="Add posting"
            pendingLabel="Reading the page…"
            tabIndex={-1}
          />
        </div>

        <p className="text-sm text-muted-foreground">
          Paste the link to a single job advertisement — any site, not just the
          boards your briefings search. It is read once and added to the table
          below, and a cover letter or tailored resume can be written for it
          like any other posting.
        </p>
      </div>
    </div>
  )
}

/**
 * The field itself, split out so the key above remounts it and nothing else.
 *
 * Remounting the alert with it would take the message off the screen at the
 * moment it appeared.
 */
function LinkField({
  formAction,
  pending,
}: {
  formAction: (formData: FormData) => void
  pending: boolean
}) {
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <Label htmlFor="posting-url" className="text-sm font-medium">
        Add a posting by link
      </Label>

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id="posting-url"
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          disabled={pending}
          placeholder="https://…"
          aria-describedby="posting-url-hint"
          className="sm:flex-1"
        />

        <SubmitButton
          pending={pending}
          variant="outline"
          label="Add posting"
          pendingLabel="Reading the page…"
        />
      </div>

      <p id="posting-url-hint" className="text-sm text-muted-foreground">
        Paste the link to a single job advertisement — any site, not just the
        boards your briefings search. It is read once and added to the table
        below, and a cover letter or tailored resume can be written for it like
        any other posting.
      </p>
    </form>
  )
}
