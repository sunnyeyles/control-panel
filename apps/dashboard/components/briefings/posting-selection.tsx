"use client"

import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

/**
 * Which Postings are ticked, for the bulk bar and the row checkboxes to share.
 *
 * A context rather than state in `PostingTableBody`, and the reason is where
 * the bar sits: above the `<Table>`, outside the body, in a server component
 * that must stay one. Lifting the state into a provider that wraps both is what
 * lets `posting-table.tsx` keep rendering its shell on the server while two
 * client leaves inside it agree on a selection.
 *
 * Deliberately **not** in the URL, for the reason `posting-table-body.tsx`
 * gives about the expanded row: a `?selected=` parameter would make every tick
 * a navigation, and the sort headers and pagination links exist to keep those
 * expensive and rare.
 */
interface PostingSelection {
  /**
   * The ticked ids that are actually on the page, in the page's own order.
   *
   * ⚠️ **Derived by intersecting with the visible ids, and that is the whole
   * safety property here.** The set survives a sort or a page change — React
   * keeps client state across a navigation that does not remount this provider
   * — so without the intersection a bulk delete would silently carry rows the
   * user ticked three pages ago and can no longer see. Filtering on render
   * makes an off-page tick unreachable rather than merely unlikely.
   */
  selected: readonly string[]
  isSelected: (postingId: string) => boolean
  toggle: (postingId: string) => void
  /** Tick every visible row, or clear them when they are all already ticked. */
  toggleAll: () => void
  /** Whether every visible row is ticked. False on an empty page. */
  allSelected: boolean
  clear: () => void
}

const PostingSelectionContext = createContext<PostingSelection | null>(null)

export function PostingSelectionProvider({
  ids,
  children,
}: {
  /** The Posting ids on this page, in the order they are rendered. */
  ids: readonly string[]
  children: ReactNode
}) {
  // Everything ever ticked, including ids no longer on the page. `selected`
  // below is what callers act on, and it can only ever name a visible row.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set())

  const selected = useMemo(
    () => ids.filter((id) => ticked.has(id)),
    [ids, ticked]
  )

  const value = useMemo<PostingSelection>(() => {
    const allSelected = ids.length > 0 && selected.length === ids.length

    return {
      selected,
      allSelected,
      isSelected: (postingId) => ticked.has(postingId),
      toggle: (postingId) =>
        setTicked((current) => {
          const next = new Set(current)

          if (!next.delete(postingId)) next.add(postingId)

          return next
        }),
      toggleAll: () =>
        setTicked((current) => {
          const next = new Set(current)

          for (const id of ids) {
            if (allSelected) next.delete(id)
            else next.add(id)
          }

          return next
        }),
      // Clears everything, not only the visible page. A delete succeeded and
      // the user is done with the selection; leaving invisible ticks behind
      // would make the bar reappear on a page they have not touched.
      clear: () => setTicked(new Set()),
    }
  }, [ids, selected, ticked])

  return (
    <PostingSelectionContext value={value}>{children}</PostingSelectionContext>
  )
}

/**
 * Throws outside a provider rather than answering with an empty selection.
 *
 * A checkbox that silently never ticks is a bug someone finds by clicking; a
 * component rendered outside the provider should fail where it is written.
 */
export function usePostingSelection(): PostingSelection {
  const selection = useContext(PostingSelectionContext)

  if (selection === null) {
    throw new Error(
      "usePostingSelection must be used inside a PostingSelectionProvider"
    )
  }

  return selection
}
