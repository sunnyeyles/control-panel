"use client"

import { useId, useMemo } from "react"

import {
  appendRoleTitle,
  hasRoleTitle,
  MAX_ROLE_TITLES,
  splitCriteria,
} from "@/lib/jobs/criteria-text"
import { roleTitleCompletions } from "@/lib/jobs/role-titles"
import { Input } from "@workspace/ui/components/input"
import { Label } from "@workspace/ui/components/label"
import {
  Suggestion,
  Suggestions,
} from "@workspace/ui/components/ai-elements/suggestion"

/**
 * The role titles a briefing searches for: a text field with a completion
 * behind it, and the suggestion buttons that fill it.
 *
 * Still one comma-separated `<input name="titles">`, and that is the point of
 * restraint here. Everything added — the completion, the two rows of buttons,
 * the count — is a way of *producing* the same string, so the posted field,
 * `searchCriteriaSchema` and the Server Action are untouched by any of it, and
 * a user who ignores all three still gets the field they had before.
 */

/**
 * How many completions to offer.
 *
 * Eight is what a browser will show without scrolling. A longer list is worse
 * rather than better: the ranking is only trustworthy near the top, and rows
 * nine onward are the ones that make a completion feel like a lottery.
 */
const COMPLETION_LIMIT = 8

export function RoleTitleField({
  value,
  onChange,
  suggestions,
  pending,
  idPrefix,
}: {
  value: string
  onChange: (value: string) => void
  /**
   * Titles to offer as buttons, already deduplicated by the actions that
   * produced them. Rendered in the order given.
   */
  suggestions: readonly { source: string; titles: readonly string[] }[]
  pending: boolean
  idPrefix: string
}) {
  const fieldId = `${idPrefix}-titles`
  const listId = useId()

  const chosen = splitCriteria(value)
  const full = chosen.length >= MAX_ROLE_TITLES

  /*
    Rebuilt on every keystroke, and it has to be — `roleTitleCompletions` says
    why an option's value is the whole field rather than one title. Only the
    eight matches reach the DOM, which is what makes that affordable. Nothing is
    offered at the cap: a completion the field would refuse is worse than none.
  */
  const options = useMemo(
    () => (full ? [] : roleTitleCompletions(value, COMPLETION_LIMIT)),
    [value, full]
  )

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={fieldId}>Role titles</Label>

      <Input
        id={fieldId}
        name="titles"
        required
        list={listId}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder="senior backend engineer, staff engineer"
        disabled={pending}
        // The browser's own history dropdown and the datalist occupy the same
        // slot, and the browser picks history when both have something to say.
        autoComplete="off"
      />

      <datalist id={listId}>
        {options.map((option) => (
          <option key={option.title} value={option.value}>
            {option.title}
          </option>
        ))}
      </datalist>

      <p className="text-sm text-muted-foreground">
        Comma separated, {MAX_ROLE_TITLES} at most. These are what the scout
        searches for — start typing and it will complete a title for you.
      </p>

      {suggestions.map((row) =>
        row.titles.length === 0 ? null : (
          <div key={row.source} className="flex flex-col gap-1.5">
            <p className="text-sm text-muted-foreground">{row.source}</p>
            <Suggestions>
              {row.titles.map((title) => (
                <Suggestion
                  key={title}
                  suggestion={title}
                  onClick={() => onChange(appendRoleTitle(value, title))}
                  // ⚠️ Disabled at the cap rather than hidden: buttons that
                  // vanished when the third title landed would read as the
                  // suggestion being withdrawn. `hasRoleTitle` rather than
                  // `includes`, so the button disables under exactly the
                  // comparison `appendRoleTitle` refuses on — otherwise a
                  // differently-cased duplicate is a live button doing nothing.
                  disabled={pending || full || hasRoleTitle(value, title)}
                />
              ))}
            </Suggestions>
          </div>
        )
      )}
    </div>
  )
}
