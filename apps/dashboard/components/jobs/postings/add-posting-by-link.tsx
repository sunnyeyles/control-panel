"use client"

import { useActionState, useState } from "react"

import { addPostingByLinkAction } from "@/app/(app)/jobs/actions"
import { ActionAlert } from "@/components/forms/action-alert"
import {
  ADD_BY_LINK_IDLE,
  CONFIRM_FIELD,
  type AddByLinkState,
} from "@/lib/postings/add-by-link-state"
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@workspace/ui/components/alert"
import { Button } from "@workspace/ui/components/button"
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
 * key unchanged (`carryForward`), so the link stays in the box to be corrected
 * — which is the whole reason this is two components rather than one. A
 * `duplicate` carries it forward for the same reason: the link has to survive
 * the question being asked about it, or "Add anyway" would have nothing to add.
 */
export function AddPostingByLink() {
  const [state, formAction, pending] = useActionState(
    addPostingByLinkAction,
    ADD_BY_LINK_IDLE
  )

  /**
   * The link whose duplicate warning has been waved away.
   *
   * `useActionState` has no reset, so "Cancel" cannot clear the state — it
   * records *which* question was answered instead. Keyed on the URL rather than
   * a boolean so that dismissing one warning does not suppress the next one: a
   * second paste of a different link is a different question.
   */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined)

  const key = state.status === "idle" ? "new" : (state.resetKey ?? "new")

  return (
    <div className="flex flex-col gap-2">
      <LinkField key={key} formAction={formAction} pending={pending} />

      {state.status === "duplicate" ? (
        state.url === dismissed ? null : (
          <DuplicateChoice
            state={state}
            formAction={formAction}
            pending={pending}
            onCancel={() => setDismissed(state.url)}
          />
        )
      ) : (
        <ActionAlert state={state} />
      )}
    </div>
  )
}

/**
 * The advertisement is already on the list under another link — add it anyway?
 *
 * **Asked rather than decided, and the two rows are never merged.** See
 * `lib/postings/duplicate-posting.ts`: `status` is the only column in `postings`
 * a person writes and the `match_*` columns cost a model call, so a wrong merge
 * would destroy something silently. A wrong *question* costs one click.
 *
 * ⚠️ **"Add anyway" resubmits the URL and nothing else.** The fields the
 * extractor produced are deliberately not held here to be sent back — a Server
 * Function is reachable by direct POST, so a form that carried a title and a
 * company would be a way to write either. The cost is that confirming re-reads
 * the page, which is why the button keeps the same "Reading the page…" pending
 * label as the first submit: it really is doing that again.
 *
 * The link to what is already tracked opens the advertisement itself rather than
 * the row on `/jobs`. The question is "are these the same job", and only the
 * advertisement answers it.
 */
function DuplicateChoice({
  state,
  formAction,
  pending,
  onCancel,
}: {
  state: Extract<AddByLinkState, { status: "duplicate" }>
  formAction: (formData: FormData) => void
  pending: boolean
  onCancel: () => void
}) {
  const { duplicate } = state

  return (
    <Alert role="status" aria-live="polite">
      <AlertTitle>Possible duplicate</AlertTitle>

      <AlertDescription className="flex flex-col gap-2">
        <span>
          {state.message} It was added on {duplicate.addedOn}
          {duplicate.location ? ` — ${duplicate.location}` : ""}.
        </span>

        <a
          href={duplicate.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-4"
        >
          Open the one you already track
        </a>

        <span>
          If this link is a different opening, add it — nothing is merged either
          way.
        </span>

        <div className="flex flex-col gap-2 sm:flex-row">
          <form action={formAction}>
            <input type="hidden" name="url" value={state.url} />
            <input type="hidden" name={CONFIRM_FIELD} value={state.url} />

            <SubmitButton
              pending={pending}
              variant="outline"
              size="sm"
              label="Add anyway"
              pendingLabel="Reading the page…"
            />
          </form>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onCancel}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </AlertDescription>
    </Alert>
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
