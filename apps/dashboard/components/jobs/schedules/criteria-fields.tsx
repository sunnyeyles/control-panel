"use client"

import { RoleTitleField } from "@/components/jobs/schedules/role-title-field"
import type { CriteriaDraft } from "@/components/jobs/schedules/use-criteria-draft"
import { SEARCH_BOARD_COUNT, splitCriteria } from "@/lib/jobs/criteria-text"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"

/**
 * The three fields that describe what to search for, and what they will cost.
 *
 * Shared by the new-briefing form and the edit form on each card, because the
 * two post an identical set of fields and `readCriteria` refuses an identical
 * set of things. Two copies would be two places for the cap, the meter and the
 * completion to drift.
 *
 * The state lives in {@link CriteriaDraft}, one level up; see
 * `use-criteria-draft.ts` for why it cannot live here.
 */

export function CriteriaFields({
  draft,
  suggestedLocations,
  suggestedKeywords,
  titleSuggestions,
  pending,
  idPrefix,
}: {
  draft: CriteriaDraft
  suggestedLocations: string
  suggestedKeywords: string
  /** Rows of clickable titles, each with the label to caption it. */
  titleSuggestions: readonly { source: string; titles: readonly string[] }[]
  pending: boolean
  /** Distinguishes the `<label for>` targets when two forms are on one page. */
  idPrefix: string
}) {
  return (
    <>
      <RoleTitleField
        value={draft.titles}
        onChange={draft.setTitles}
        suggestions={titleSuggestions}
        pending={pending}
        idPrefix={idPrefix}
      />

      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-locations`}>Locations</Label>
        <Input
          id={`${idPrefix}-locations`}
          name="locations"
          required
          defaultValue={suggestedLocations}
          // Uncontrolled: the input keeps its own text and reports only how
          // many entries it holds, which is all the meter below needs. See
          // `use-criteria-draft.ts`.
          onChange={(event) =>
            draft.setLocationCount(
              splitCriteria(event.currentTarget.value).length
            )
          }
          placeholder="Sydney, Remote (Australia)"
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">Comma separated.</p>
      </div>

      {/*
        Optional, unlike the two above, and the missing `required` is the whole
        difference. The worker treats keywords as a hint about what makes a role
        a better match, so a briefing without them is a briefing that matches on
        title and location alone — a worse search, never a broken one.

        No count listener: keywords sharpen a search rather than multiply it, so
        they cost nothing in the meter below.
      */}
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${idPrefix}-keywords`}>Keywords</Label>
        <Input
          id={`${idPrefix}-keywords`}
          name="keywords"
          defaultValue={suggestedKeywords}
          placeholder="TypeScript, Postgres, AWS"
          disabled={pending}
        />
        <p className="text-sm text-muted-foreground">
          Comma separated, and optional. Technologies or specialisms that make a
          role a better match.
        </p>
      </div>

      <SearchBudget draft={draft} />
    </>
  )
}

/**
 * What this combination costs the scout, said before it is saved.
 *
 * ⚠️ **This exists because the failure it describes is silent.** A run is
 * `titles × locations × boards` searches against a hard model budget; past that
 * the scout is routed to `halt` mid-sweep and still answers with a well-formed
 * brief — one drawn from part of the search, indistinguishable from a quiet
 * market. Nothing downstream can tell the difference, and no run report says
 * "this covered less than you asked for".
 *
 * A briefing used to be three text boxes, and was self-limiting: nobody typed
 * six role titles by hand. A field with a completion and two rows of one-click
 * suggestions is not, which is what turned a theoretical cliff into one a user
 * would walk off on their second visit.
 */
function SearchBudget({ draft }: { draft: CriteriaDraft }) {
  if (draft.titleCount === 0 || draft.locationCount === 0) return null

  const sum = `${plural(draft.titleCount, "role title")} × ${plural(
    draft.locationCount,
    "location"
  )} × ${SEARCH_BOARD_COUNT} boards`

  return (
    <p
      className={
        draft.fits
          ? "text-sm text-muted-foreground"
          : "text-sm text-destructive"
      }
      // The count changes as the user types, and the sentence after it is the
      // reason a submit button is disabled. A screen reader that never
      // announced it would leave that button unexplained.
      aria-live="polite"
    >
      {plural(draft.searches, "search", "searches")} per run — {sum}.
      {draft.fits
        ? null
        : " That is too wide to run in one briefing: the scout is cut short rather than searching harder. Remove a title or a location, or split this into two briefings."}
    </p>
  )
}

/**
 * `-s` covers "title", "location" and "board"; "search" needs telling.
 *
 * The explicit parameter rather than a rule, because a rule that handled `-ch`
 * would be the first line of an inflector, and three nouns do not need one.
 */
function plural(count: number, noun: string, many = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : many}`
}
