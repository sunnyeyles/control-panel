# 06 — Posting detail dialog

**What to build:** Clicking a Posting opens its full detail without leaving the
table — the summary, the highlights copied from the advertisement, why it
matched the user's criteria, which Briefing found it and when it was first seen.

The table row carries only what is worth scanning; everything else lives here.
That is what lets the table be a table rather than a stack of cards.

Cover Letter drafting moves into the dialog and keeps working exactly as it does
today. The next ticket changes how drafting reads its source; this one
deliberately does not, so that the dialog is not gated on that rework's security
tests.

**Blocked by:** 04 — The Briefings page becomes a sortable, paginated postings
table

**Status:** ready-for-agent

## Acceptance criteria

- [ ] Every field the superseded card displayed is reachable from the dialog —
      nothing the user could previously read is lost.
- [ ] Opening it costs no additional query; the page already holds the data.
- [ ] The link out to the advertisement opens in a new tab, and the app does not
      prefetch a third party's site.
- [ ] Drafting a Cover Letter works from inside the dialog, and an existing
      draft is still downloadable and labelled as already drafted rather than
      offering a first draft.
- [ ] Closing returns to the same page and scroll position.
- [ ] Fully keyboard-navigable: focus moves into the dialog, is trapped while it
      is open, and returns to the trigger on close.
- [ ] Works under `DEV_AUTH_BYPASS`.
