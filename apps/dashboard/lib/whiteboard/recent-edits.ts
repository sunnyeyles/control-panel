/**
 * The shapes the user has touched since the agent last looked.
 *
 * This is what answers "turn what I just drew into a proper architecture" and
 * "make that one bigger" when nothing is selected — the second of the four
 * reference signals the whiteboard prompt reasons from.
 *
 * A module-level set rather than React state, on purpose. It is written on
 * every pointer move of a drag; making it state would re-render the canvas
 * hundreds of times per stroke. Nothing renders from it — it is read once,
 * when a turn is sent, and cleared.
 *
 * It lives here rather than beside the canvas component so the pieces that
 * need it are not forced to import tldraw. That component is behind
 * `dynamic(..., { ssr: false })` precisely because tldraw touches `window` at
 * import time, and an innocent-looking import of a helper from it would undo
 * that.
 */

const touched = new Set<string>()

/** Record a shape the user created or changed. Ids are tldraw's own. */
export function noteUserEdit(id: string): void {
  touched.add(id)
}

/**
 * Read and clear.
 *
 * Draining rather than reading is what makes "recent" mean "since the last
 * turn" instead of "since the page loaded" — otherwise the first thing the
 * user drew would still be claimed as new an hour later.
 */
export function drainRecentEdits(): string[] {
  const ids = [...touched]
  touched.clear()
  return ids
}

/** Forget everything, e.g. when a saved board is loaded over the current one. */
export function clearRecentEdits(): void {
  touched.clear()
}
