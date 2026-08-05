"use client"

import { useState } from "react"

import { PostingRow } from "@/components/briefings/posting-row"
import type { CoverLetterRow } from "@/lib/cover-letters/cover-letter-rows"
import type { PostingView } from "@/lib/postings/list-postings"
import { TableBody } from "@workspace/ui/components/table"

/**
 * The table's body, and the client boundary that owns which posting is open.
 *
 * Headers, sorting and pagination stay on the server — they are `<Link>`s that
 * must not remount with every disclosure. Expansion is local state: one id at
 * a time, never the URL, so opening and closing a detail does not fight the
 * query string the rest of the table uses for sort and page.
 *
 * Letters arrive already looked up per posting rather than as a `Map`: a `Map`
 * is an awkward RSC payload, and the lookup is a server concern the page has
 * already paid for. {@link CoverLetterRow} contains only serializable metadata.
 */
export function PostingTableBody({
  rows,
}: {
  rows: readonly {
    posting: PostingView
    letter?: CoverLetterRow
  }[]
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)

  return (
    <TableBody>
      {rows.map(({ posting, letter }) => (
        <PostingRow
          key={posting.id}
          posting={posting}
          letter={letter}
          expanded={expandedId === posting.id}
          onToggle={() =>
            setExpandedId((current) =>
              current === posting.id ? null : posting.id
            )
          }
        />
      ))}
    </TableBody>
  )
}
