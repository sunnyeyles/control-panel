"use client"

import { usePostingSelection } from "@/components/briefings/posting-selection"
import { Checkbox } from "@workspace/ui/components/checkbox"
import { TableHead } from "@workspace/ui/components/table"

/**
 * The header checkbox: tick every row on this page, or clear them.
 *
 * **This page, and only this page.** Sorting and paging happen in Postgres and
 * the client holds one page at a time, so there is no honest way to offer
 * "select all 400" — the ids for the other pages are not here. A control that
 * claimed to would have to send a *query* to the delete action instead of a
 * list of ids, which is the one thing `posting-query.ts` is careful never to
 * let the address bar do.
 *
 * `checked` is all-or-nothing rather than indeterminate: the shared `Checkbox`
 * renders a tick for any indicator state, so a mixed selection would show a
 * tick that means something else. The bulk bar's "3 selected" is what reports
 * a partial selection, and it reports it in words.
 *
 * A `<TableHead>` and not just the control, so the header row stays a list of
 * cells in `posting-table.tsx` rather than one cell built differently.
 */
export function PostingSelectAll({ total }: { total: number }) {
  const { allSelected, toggleAll } = usePostingSelection()

  return (
    <TableHead className="w-8">
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
