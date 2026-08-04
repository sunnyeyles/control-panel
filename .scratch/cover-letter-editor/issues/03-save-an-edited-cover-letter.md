# 03 — Save an edited Cover Letter back to storage

**What to build:** the edit survives. A **Save** button in the editor footer
writes the edited markdown over the stored Cover Letter for that Posting, so
reopening the dialog — or reloading the page — shows the user's words rather than
the model's. This closes the editing half of the _Not built yet_ entry in
`OVERVIEW.md`, and it is the point of the whole feature: without it the editor is
a scratchpad that loses work on close.

An explicit button, chosen over saving silently on close: a stray keystroke
should not rewrite a document, and the user should be told the write happened.
The shared editor's footer holds only the filename and the PDF export today, so
it needs an optional save action — supplied by the caller, absent by default, so
every other consumer is unaffected.

### What the write must preserve

A Cover Letter is addressed by **(user, Posting)** and nothing else — no Run —
so saving overwrites one object rather than accumulating drafts, which is already
how redrafting behaves. Two things ride alongside the markdown as metadata and
must survive the save:

- **When it was drafted.** That instant means _when the model wrote this_, and an
  edit is not a drafting. The card says "Cover letter drafted 3 Aug"; a save must
  not make it claim otherwise.
- **Provenance** — the Run it came from, and the Posting's title, company and
  URL. The Cover Letter list renders the title and company, so dropping
  provenance would blank a row down to a hex digest.

Read the existing letter's metadata first and carry both across.

### The line that makes this safe

**A save must refuse when no Cover Letter exists at that address, and write
nothing.** This is the security property of the ticket, not a nicety.

Drafting deliberately never accepts letter text from a form: it carries
identifiers only, re-reads the Posting out of the Run's stored Findings, and a
test submits a Posting body to prove it is ignored — because text accepted from a
form would become arbitrary content inside a document stored in the user's own
voice. Saving _does_ accept text, and that is fine only because it is the user's
own letter in their own prefix. Requiring the object to already exist is what
keeps the two different; without it, this action becomes a way to mint a letter
of arbitrary content at any well-formed Posting id.

Everything else follows the shape the drafting action already sets:

- **Who is asking is checked before the body is touched at all.** For a Server
  Action this is the only real check — the proxy cannot evaluate a session on a
  POST, so it degrades to looking for a cookie-shaped substring, and a forged
  cookie gets past it.
- **The storage key's user segment is the session's, never anything from the
  form.** There is then no way to spell a request naming another user's letter,
  and the ownership assertion inside the storage package stays a second line of
  defence rather than the only one.
- **The Posting id is shape-checked before storage is touched.** A value storage
  would refuse cannot name an object, and "not there" and "you may not have it"
  answer identically — splitting them turns the field into an oracle for whether
  another user's letter exists.
- **A bound on the markdown's length.** The drafting path needs none because a
  model wrote the bytes; here a person does.
- **The action imports nothing from Next and takes injected dependencies**, which
  is what makes its refusal branches testable without a live session. The
  Next-aware wrapper is thin, lives with the other Briefings actions, and
  refreshes the page on success.

**Blocked by:** 02 — Open a drafted Cover Letter in the editor.

**Status:** ready-for-agent

- [ ] The editor footer offers **Save** beside the PDF export, with a pending
      state while the write is in flight
- [ ] Saving an edit and reopening the dialog shows the edited text; so does
      reloading the Briefings page
- [ ] After a save, the card still reports the **original** drafting time, and
      the Cover Letter list still shows the Posting's title and company
- [ ] A save is refused, with a message visible in the open dialog, when the
      caller is not signed in or not on the allowlist
- [ ] A save for a Posting with no drafted letter is refused **and writes
      nothing** — asserted against the store, not just the returned message
- [ ] A malformed Posting id is refused before storage is touched
- [ ] Markdown over the length bound is refused
- [ ] The refusal branches above are covered by tests, which the existing
      in-memory object store in the Cover Letter action tests already supports
- [ ] `OVERVIEW.md` no longer lists rendering or editing a stored Cover Letter
      under _Not built yet_, including its diagram node
- [ ] Typecheck, lint (zero warnings) and the dashboard test suite are clean

**How to see it without AWS, OpenAI or a database:** the dev bypass's in-memory
Cover Letter store implements writes and is memoised for the life of the dev
server, so save, reload and reopen all behave as they would against real storage.
Note that a production build fails while the dev bypass flag is set — by design —
so unset it before building.
