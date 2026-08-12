"use client"

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

/**
 * The empty selection, as one value rather than a fresh `Set` per clear.
 *
 * ⚠️ **Shared so clearing an already-empty selection is a real no-op.** React
 * bails out only when the next state is `Object.is` the current one, and
 * `new Set()` never is — so a `clear()` minting its own would re-render, hand
 * out new callback identities, and let an effect keyed on one call `clear()`
 * again forever. Unreachable today by luck; this is the half of the fix that
 * does not depend on how a caller writes its dependencies.
 */
const NOTHING: ReadonlySet<string> = new Set()

/**
 * Which Postings are ticked, for the bulk bar and the row checkboxes to share.
 *
 * ⚠️ A context rather than state in `PostingTableBody` because the bulk bar
 * sits above the `<Table>`, outside the body, in a server component that must
 * stay one. The provider wrapping both is what lets `posting-table.tsx` render
 * its shell on the server while two client leaves agree on a selection.
 *
 * Deliberately not in the URL: a `?selected=` parameter would make every tick a
 * navigation.
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
  /**
   * Answered from {@link PostingSelection.selected}, not the underlying set, so
   * there is one membership rule rather than two. The raw set would agree today
   * only by an accident of the caller, and the intersection above is too
   * load-bearing to live in one of two places.
   */
  isSelected: (postingId: string) => boolean
  toggle: (postingId: string) => void
  /** Tick every visible row, or clear them when they are all already ticked. */
  toggleAll: () => void
  /** Whether every visible row is ticked. False on an empty page. */
  allSelected: boolean
  /**
   * How many rows this page holds — what `allSelected` is measured against, and
   * what the header checkbox names in its label. Here rather than passed down
   * beside the provider, so the page's length reaches its two readers by one
   * route instead of two that can disagree.
   */
  total: number
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
  const [ticked, setTicked] = useState<ReadonlySet<string>>(NOTHING)

  const selected = useMemo(
    () => ids.filter((id) => ticked.has(id)),
    [ids, ticked]
  )

  // Stable because each takes the functional updater form and closes over
  // nothing. `clear` is handed to `DeletePostingsDialog` as `onDeleted` and
  // kept across renders; a steady identity keeps that free to move into an
  // effect later.
  const toggle = useCallback((postingId: string) => {
    setTicked((current) => {
      const next = new Set(current)

      if (!next.delete(postingId)) next.add(postingId)

      return next
    })
  }, [])

  const toggleAll = useCallback(() => {
    setTicked((current) => {
      // Recomputed from `current` rather than read off the render that built
      // this callback, which is what lets it depend on `ids` alone.
      const all = ids.length > 0 && ids.every((id) => current.has(id))
      const next = new Set(current)

      for (const id of ids) {
        if (all) next.delete(id)
        else next.add(id)
      }

      return next
    })
  }, [ids])

  // Clears everything, not only the visible page. A delete succeeded and the
  // user is done with the selection; leaving invisible ticks behind would make
  // the bar reappear on a page they have not touched.
  const clear = useCallback(() => setTicked(NOTHING), [])

  const value = useMemo<PostingSelection>(() => {
    // Built from `selected` rather than from `ticked`, which is what keeps the
    // intersection the single answer to "is this row ticked". A `Set` because
    // the lookup happens once per rendered row.
    const visible = new Set(selected)

    return {
      selected,
      total: ids.length,
      allSelected: ids.length > 0 && selected.length === ids.length,
      isSelected: (postingId) => visible.has(postingId),
      toggle,
      toggleAll,
      clear,
    }
  }, [ids, selected, toggle, toggleAll, clear])

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
