"use client"

import { useActionState } from "react"
import { StarsIcon } from "lucide-react"

import { ActionAlert } from "@/components/forms/action-alert"
import { ActionError } from "@/components/forms/action-error"
import { SubmitButton } from "@workspace/ui/components/submit-button"

import {
  createJobAction,
  suggestCriteriaAction,
  suggestRoleTitlesAction,
} from "@/app/(app)/jobs/schedules/actions"
import { CriteriaFields } from "@/components/jobs/schedules/criteria-fields"
import { RoleTitleSuggestForm } from "@/components/jobs/schedules/role-title-suggest-form"
import { IntervalField } from "@/components/jobs/schedules/interval-field"
import { useCriteriaDraft } from "@/components/jobs/schedules/use-criteria-draft"
import { IDLE } from "@/lib/actions/action-state"
import {
  ROLE_TITLES_IDLE,
  SUGGESTION_IDLE,
  type RoleTitleSuggestionState,
  type SuggestedCriteria,
} from "@/lib/jobs/criteria-suggestion"
import {
  DEFAULT_MAX_POSTINGS,
  MAX_POSTINGS_PER_BRIEF,
} from "@workspace/job-search"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"

/** What the criteria fields start from before anything has been suggested. */
const NOTHING_SUGGESTED: SuggestedCriteria = {
  titles: [],
  locations: "",
  keywords: "",
}

/**
 * Create a briefing, optionally starting from what a resume says.
 *
 * **Only the create action lives here; the draft below owns the suggestions.**
 * That split is what makes one `key` do all the resetting: a successful create
 * remounts {@link BriefingDraft} wholesale, discarding the spent CV reading
 * along with every field, while `createState` stays out here so the success
 * message survives the remount.
 *
 * ⚠️ An error state carries the previous key forward — see `carryResetKey` — so
 * the key holds still through a failure. Keying on `status === "success"` would
 * discard what the user typed at the moment they are told to fix one field.
 */
export function CreateBriefingForm() {
  const [createState, createAction, creating] = useActionState(
    createJobAction,
    IDLE
  )

  const createKey =
    createState.status === "idle" ? "new" : (createState.resetKey ?? "new")

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <BriefingDraft
        key={createKey}
        createAction={createAction}
        creating={creating}
      />

      <ActionAlert state={createState} />
    </div>
  )
}

/**
 * One unsaved briefing: the two suggest buttons, and the fields they fill.
 *
 * The suggestion hooks live here, not in the parent: everything this component
 * holds is exactly what a successful create should clear, so the parent's `key`
 * clears all of it at once with no effect and no "suggestion spent" flag.
 *
 * ⚠️ **A suggestion is a value the fields are rendered *from*, not something
 * that happens *to* them**, so it must be readable during their render. Pushing
 * the buttons into a child would mean handing values back upwards via
 * `setState` in an effect — flagged by `react-hooks/set-state-in-effect`, and
 * explained in `lib/actions/action-state.ts`.
 */
function BriefingDraft({
  createAction,
  creating,
}: {
  createAction: (formData: FormData) => void
  creating: boolean
}) {
  const [suggestState, suggestAction, suggesting] = useActionState(
    suggestCriteriaAction,
    SUGGESTION_IDLE
  )

  const [titlesState, titlesAction, suggestingTitles] = useActionState(
    suggestRoleTitlesAction,
    ROLE_TITLES_IDLE
  )

  const suggested =
    suggestState.status === "success"
      ? suggestState.criteria
      : NOTHING_SUGGESTED

  /*
    The criteria fields are keyed and the name field is not: a suggestion
    replaces locations and keywords, but the name is the user's and not
    derivable from a CV, so keying it would clear it for no visible reason.

    ⚠️ Titles is no longer among what a suggestion replaces, nor what this key
    resets — the extractor's titles arrive as buttons rather than text (see
    `SuggestedCriteria`), so a half-typed title must survive.
  */
  const suggestKey =
    suggestState.status === "success" ? suggestState.resetKey : "none"

  const pending = creating || suggesting

  return (
    <>
      {/*
        Its own <form>, and it has to be: a form cannot contain a form, so the
        suggest button cannot sit among the fields it fills. It posts no fields
        at all — the document is chosen server-side (newest labelled Resume), so
        there is nothing to smuggle across in a hidden input.
      */}
      <form action={suggestAction} className="flex flex-col gap-2">
        <div>
          <SubmitButton
            pending={suggesting}
            icon={<StarsIcon data-icon="inline-start" />}
            label="Suggest from my resume"
            pendingLabel="Reading your resume…"
            variant="secondary"
          />
        </div>

        <p className="text-sm text-muted-foreground">
          Reads the newest document you labelled Resume and proposes criteria
          for you to edit. Role titles arrive as buttons to pick from; nothing
          is saved until you press Create briefing.
        </p>

        {/*
          The extractor's own remarks — most often "your CV does not state a
          location". Without them a blank Locations box after a successful
          suggestion looks identical to one that failed halfway through.
        */}
        {suggestState.status === "success" && suggestState.notes ? (
          <p className="text-sm text-muted-foreground">{suggestState.notes}</p>
        ) : null}

        {/*
          Narrowed before it reaches `ActionError`, whose prop is an
          `ActionState`: this union's success case carries criteria rather than
          a `message` (deliberately separate — see
          `lib/jobs/criteria-suggestion.ts`), but its error case matches
          exactly. So the narrowing reuses the component without widening
          anybody's prop type or hand-rolling a <p> that could lose the
          `aria-live` pairing.
        */}
        {suggestState.status === "error" ? (
          <ActionError state={suggestState} />
        ) : null}
      </form>

      <CreateFields
        key={suggestKey}
        suggested={suggested}
        titlesState={titlesState}
        titlesAction={titlesAction}
        suggestingTitles={suggestingTitles}
        createAction={createAction}
        creating={creating}
        pending={pending}
      />
    </>
  )
}

/**
 * The create form proper, remounted whenever a resume suggestion lands.
 *
 * Split out from {@link BriefingDraft} so that `useCriteriaDraft` — which seeds
 * its state from the suggestion — is *inside* the thing the `suggestKey`
 * remounts. A hook cannot be re-seeded by a changed prop, so the remount is how
 * a suggestion reaches it, which is the same mechanism `defaultValue` relies on
 * one level down.
 */
function CreateFields({
  suggested,
  titlesState,
  titlesAction,
  suggestingTitles,
  createAction,
  creating,
  pending,
}: {
  suggested: SuggestedCriteria
  titlesState: RoleTitleSuggestionState
  titlesAction: (formData: FormData) => void
  suggestingTitles: boolean
  createAction: (formData: FormData) => void
  creating: boolean
  pending: boolean
}) {
  const draft = useCriteriaDraft({
    titles: "",
    locations: suggested.locations,
  })

  const adjacent =
    titlesState.status === "success" ? titlesState.titles : undefined

  return (
    <>
      {/*
        A third form for the same reason as the second. It submits the titles
        chosen so far so the suggester knows what *not* to propose — the one
        field either suggest action reads, and the user's own text rather than
        an identity or a document selector.
      */}
      <RoleTitleSuggestForm
        action={titlesAction}
        chosen={draft.titles}
        state={titlesState}
        pending={suggestingTitles || pending}
      />

      <form action={createAction} className="flex flex-col gap-4">
        <NameField pending={creating} />

        <CriteriaFields
          draft={draft}
          suggestedLocations={suggested.locations}
          suggestedKeywords={suggested.keywords}
          titleSuggestions={[
            { source: "From your resume", titles: suggested.titles },
            ...(adjacent
              ? [{ source: "Roles adjacent to these", titles: adjacent }]
              : []),
          ]}
          // Disabled while a suggestion is in flight as well as while creating:
          // these are the fields the suggestion is about to fill, so typing into
          // them meanwhile is work about to be thrown away.
          pending={pending}
          idPrefix="briefing-new"
        />

        <MaxPostingsField pending={pending} />

        <IntervalField idPrefix="briefing-new" pending={creating} />

        <div>
          <SubmitButton
            pending={creating}
            // ⚠️ Disabled on an over-budget sweep, not merely warned about. The
            // action refuses it too — see `readCriteria` — and this is the half
            // that stops the user finding out after a round trip.
            disabled={!draft.fits}
            label="Create briefing"
            pendingLabel="Creating…"
          />
        </div>
      </form>
    </>
  )
}

function NameField({ pending }: { pending: boolean }) {
  return (
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
  )
}

/**
 * How many postings to ask for, or nothing at all.
 *
 * **Create-only**, unlike the shared `CriteriaFields` above. `EditCriteriaForm`
 * never posts it, and `readCriteria` treats absent as blank, so a criteria edit
 * leaves a briefing's stored `maxPostings` untouched rather than resetting it.
 *
 * ⚠️ Blank is not the same as a number: an empty field leaves `maxPostings` out
 * of the config, so the briefing follows the platform default as it changes,
 * where a saved 20 pins it to today's number for ever. The bound is the
 * scout's, stated on the input rather than failing on submit.
 */
function MaxPostingsField({ pending }: { pending: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="briefing-max-postings">Postings per briefing</Label>
      <Input
        id="briefing-max-postings"
        name="maxPostings"
        type="number"
        inputMode="numeric"
        min={1}
        max={MAX_POSTINGS_PER_BRIEF}
        placeholder={String(DEFAULT_MAX_POSTINGS)}
        disabled={pending}
      />
      <p className="text-sm text-muted-foreground">
        Optional, 1 to {MAX_POSTINGS_PER_BRIEF}. Leave it blank for{" "}
        {DEFAULT_MAX_POSTINGS}.
      </p>
    </div>
  )
}
