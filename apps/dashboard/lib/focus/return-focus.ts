/**
 * Put keyboard focus back on the control that opened a dialog.
 *
 * ⚠️ **Needed because the editor dialogs are mounted only while they are
 * open.** `FileEditorDialog` pulls TipTap in behind `next/dynamic`, so the
 * three callers on `/briefings` render it as `{open ? <FileEditorDialog … /> :
 * null}` and its trigger sits outside that boundary. Radix restores focus to
 * whatever it recorded when the dialog content mounted — but the content is
 * gone from the tree in the same commit that closes it, so that restore never
 * gets to run. Left alone, closing drops the user on `<body>`: a keyboard user
 * loses their place in a Postings table that may be pages long, and a screen
 * reader starts reading from the top of the document.
 *
 * Called with the trigger's ref target, which is safe to be `null` — the button
 * can be unmounted by the time a close lands, if the row it belongs to was
 * re-rendered away underneath the dialog.
 */
export function returnFocusTo(element: HTMLElement | null): void {
  if (!element) return

  // ⚠️ **A frame later, deliberately.** The close and the unmount land in the
  // same commit, and Radix's own focus teardown runs after it — so focusing
  // synchronously here is undone a moment later by the thing this exists to
  // compensate for. Waiting one frame lets that settle and makes this the last
  // write to `document.activeElement`. The cost is a single frame on `<body>`,
  // which no assistive technology announces.
  requestAnimationFrame(() => {
    // The trigger can be gone by now: its Posting row is free to re-render
    // while the dialog is open, and a save does exactly that. Focusing a
    // detached node quietly does nothing, so this guard is about saying that
    // the case was considered rather than about preventing a throw.
    if (element.isConnected) element.focus()
  })
}
