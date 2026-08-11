"use client"

import { useState } from "react"

import {
  fitsSearchBudget,
  searchesPerRun,
  splitCriteria,
} from "@/lib/jobs/criteria-text"

/**
 * The criteria a form is holding, and whether the scout could search them.
 *
 * **A hook rather than state inside `CriteriaFields`, because the answer is
 * needed above the fields.** Whether the combination fits the scout's budget
 * decides whether the form's submit button is disabled, and that button is not
 * a child of the fields — it sits below an interval picker on one form and
 * beside a Cancel on the other. A child reporting upward through a callback
 * would have to call it during render, which React forbids, or from an effect,
 * which `react-hooks/set-state-in-effect` forbids here for the reasons
 * `lib/actions/action-state.ts` sets out. Owning the state where both readers
 * can see it avoids needing either.
 *
 * ⚠️ **Titles is a value; locations is only a count.** The titles field is
 * controlled because a suggestion button appends to it programmatically, and an
 * uncontrolled input cannot be written from outside without a ref React knows
 * nothing about. Nothing writes to locations, so it stays uncontrolled with a
 * `defaultValue` — this holds the one thing the meter needs from it, and the
 * browser keeps the text.
 */
export interface CriteriaDraft {
  titles: string
  setTitles: (titles: string) => void
  /** Reported by the locations field's `onChange`; the input owns its text. */
  setLocationCount: (count: number) => void
  titleCount: number
  locationCount: number
  /** `titles × locations × boards`, the number of searches one run performs. */
  searches: number
  /** Whether the scout can finish that sweep. `false` blocks the save. */
  fits: boolean
}

export function useCriteriaDraft(initial: {
  titles: string
  locations: string
}): CriteriaDraft {
  const [titles, setTitles] = useState(initial.titles)
  const [locationCount, setLocationCount] = useState(
    splitCriteria(initial.locations).length
  )

  const titleCount = splitCriteria(titles).length

  return {
    titles,
    setTitles,
    setLocationCount,
    titleCount,
    locationCount,
    searches: searchesPerRun(titleCount, locationCount),
    fits: fitsSearchBudget(titleCount, locationCount),
  }
}
