# 02 — Open a drafted Cover Letter in the editor

**What to build:** a Posting that already has a Cover Letter offers to open it.
Today the card offers only _Replace this draft_ and a Download link, so reading a
letter means downloading the file and opening it somewhere else — and changing a
word means losing it, since there is no way back. `OVERVIEW.md` lists rendering
or editing a stored letter under _Not built yet_; this ticket does the rendering
half.

Beside _Draft cover letter_ / _Replace this draft_ on the Posting card, an **Edit
letter** button. Clicking it opens the file editor with that Posting's letter
loaded as rich text, ready to change, with the existing PDF export available.
**Nothing is written back yet** — closing the dialog discards the edit, and that
is this ticket's boundary. Ticket 03 adds saving.

Constraints that matter:

- **The button appears only where a letter exists**, exactly as the Download link
  beside it already does. With no letter there is nothing to edit, and offering
  the editor would be offering an empty document.
- **The letter body is fetched when the dialog opens, not rendered into the
  page.** The summary the card is built from deliberately carries metadata only —
  title, company, when it was drafted — and no markdown. Server-rendering every
  letter body into every card would pull the user's whole shelf out of object
  storage on each page load, and the listing is already an N+1 of metadata reads.
  The download route that serves one letter as markdown already exists and is the
  thing to reuse; it sits under `/api/` so a refused request comes back as a real
  401 rather than as sign-in HTML with a success status.
- **A failed or refused fetch has to be visible inside the open dialog**, not
  behind it. That needs a slot in the shared editor for caller-supplied footer
  content, since the editor's footer currently holds only the filename and the
  export button.
- The trigger's accessible label names the Posting. Several of these buttons sit
  on one page, and the existing draft button names its Posting for the same
  reason.

Two small changes to the shared editor belong here, both additive — a caller
passing neither gets today's behaviour:

- an optional heading, so a dialog over one Cover Letter is not titled _File
  editor_;
- **no file sidebar when there is only one file.** This caller passes one. A
  sidebar listing a single entry, beside a one-option dropdown on narrow screens,
  is chrome for a choice that does not exist.

Finally, the Cover Letter list at the top of the Briefings page carries a
docblock stating there is nothing there but reading and downloading, and no edit.
That claim is about to be false for the page. Narrow it to the list itself.

**Blocked by:** 01 — Bring the file editor onto the branch.

**Status:** ready-for-agent

- [ ] A Posting with a drafted Cover Letter shows an **Edit letter** button
      beside the draft button; a Posting without one shows only the draft button
- [ ] Opening it loads that Posting's stored letter and renders the markdown as
      rich text — headings, lists and emphasis all survive the round trip
- [ ] The dialog is headed for a Cover Letter and shows no file sidebar or file
      dropdown, since there is one file
- [ ] A fetch that fails or is refused shows a message inside the open dialog
- [ ] **Download PDF** produces selectable text rather than a rasterised page
- [ ] The editor's typography is checked in a real browser — PR #118 states its
      stylesheet has never been rendered, and nothing typechecks CSS
- [ ] The Cover Letter list's "no edit" docblock no longer describes the page as
      a whole
- [ ] Typecheck, lint (zero warnings) and the dashboard test suite are clean

**How to see it without AWS, OpenAI or a database:** the dev bypass serves the
app from fixtures, and those fixtures already include a Cover Letter drafted for
one of the seeded Postings, over an in-memory store that implements reads. That
Posting's card is the one to click.
