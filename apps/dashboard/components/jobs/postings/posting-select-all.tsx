"use client"

import { usePostingSelection } from "@/components/jobs/postings/posting-selection"
import { POSTING_SELECT_WIDTH } from "@/lib/postings/posting-columns"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { TableHead } from "@workspace/ui/components/table"

/**
 * The header checkbox: tick every row on this page, or clear them.
 *
 * ⚠️ **This page, and only this page.** Sorting and paging happen in Postgres,
 * so the ids for other pages are not here — "select all 400" would have to send
 * a *query* to the delete action instead of a list of ids, the one thing
 * `posting-query.ts` never lets the address bar do.
 *
 * `checked` is all-or-nothing, not indeterminate: the shared `Checkbox` renders
 * a tick for any indicator state, so a mixed selection would show a tick
 * meaning something else. The bulk bar reports a partial selection in words.
 *
 * A `<TableHead>` and not just the control, so the header row stays a list of
 * cells in `posting-table.tsx`.
 */
export function PostingSelectAll() {
  const { allSelected, toggleAll, total } = usePostingSelection()

  return (
    <TableHead className={POSTING_SELECT_WIDTH}>
      <Checkbox
        checked={allSelected}
        onCheckedChange={toggleAll}
        aria-label={
          allSelected
            ? `Clear the selection of ${total} postings`
            : `Select all ${total} postings on this page`
        }
      />
    </TableHead>
  )
}
