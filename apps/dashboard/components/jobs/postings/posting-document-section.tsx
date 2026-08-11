"use client"

import type { ReactNode } from "react"

/**
 * The three-state shell shared by Cover Letter and Tailored Resume controls.
 *
 * ⚠️ **"Could not be read" is a third state, not a synonym for "none".** With
 * the store unavailable, offering *Generate* would invite someone to spend a
 * model call replacing a document this panel simply could not see.
 *
 * Feature entry points supply the slots and keep distinct user-facing strings
 * (CONTEXT).
 */
export function PostingDocumentSection({
  unavailable,
  existing,
  emptyHint,
  actions,
}: {
  /** When set, nothing else renders — the listing could not be read. */
  unavailable?: ReactNode
  /** Date + download (+ PDF), when a document exists. */
  existing?: ReactNode
  /** Feature-owned empty-state copy, when none exists yet. */
  emptyHint?: ReactNode
  /** Generate / create / edit row. */
  actions: ReactNode
}) {
  if (unavailable) {
    return <>{unavailable}</>
  }

  return (
    <>
      {existing ?? emptyHint ?? null}
      <div className="flex flex-wrap items-start gap-2">{actions}</div>
    </>
  )
}
