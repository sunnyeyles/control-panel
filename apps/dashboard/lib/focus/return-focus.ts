/**
 * Put keyboard focus back on the control that opened a dialog.
 *
 * ⚠️ **Needed because the editor dialogs are mounted only while open.**
 * `FileEditorDialog` pulls TipTap in behind `next/dynamic`, so the `/jobs`
 * callers render it as `{open ? <FileEditorDialog … /> : null}` and its trigger
 * sits outside that boundary. Radix restores focus to what it recorded when the
 * content mounted — but the content is gone in the same commit that closes it,
 * so that restore never runs. Left alone, closing drops a keyboard user on
 * `<body>`, losing their place in a table that may be pages long.
 *
 * Safe to be `null`: the trigger's row can have re-rendered away underneath.
 */
export function returnFocusTo(element: HTMLElement | null): void {
  if (!element) return

  // ⚠️ **A frame later, deliberately.** Radix's own focus teardown runs after
  // the closing commit, so focusing synchronously here is undone a moment later
  // by the thing this exists to compensate for. One frame on `<body>` costs
  // nothing that assistive technology announces.
  requestAnimationFrame(() => {
    // The trigger's row is free to re-render while the dialog is open, and a
    // save does exactly that. Focusing a detached node quietly does nothing.
    if (element.isConnected) element.focus()
  })
}
