# 02 — Collapse a posting found on two boards

**What to build:** one advertisement, listed on SEEK and on Indeed, reads as one **Posting** in
a **Brief** rather than two. Ticket 01 made this possible and therefore made it happen —
employers list the same role on every board they pay for, so the more boards the scout gains,
the more a brief repeats itself and the less a reader trusts the count.

A pure function in `@workspace/agents`, beside `posting-id.ts`, run in `run-briefing.ts` after
`parseFindings` and before the writer and storage. It takes the parsed postings and returns
them grouped: one survivor per group, the rest recorded on it.

**Identity does not change.** `postingId` stays URL-derived, stable across runs and valid as a
`@workspace/user-storage` key segment. This groups _above_ the id; it does not compute a new
one. The `alsoOn` list lives on a `ClusteredPosting` type built by code, and **`PostingSchema`
is not touched** — the model is not asked for provenance, because composed output is exactly
what `posting-id.ts` refuses to derive identity from.

The grouping key is normalised company, normalised title and a city token: lowercase, strip
punctuation and company legal suffixes, and take the city from the front of the location so
`"Sydney NSW"` and `"Sydney, New South Wales, Australia"` agree. Which board a posting came
from is read from its URL host, against the descriptors ticket 01 added — never from anything
the model wrote.

Three restraints, and they are the ticket rather than decoration:

- **Group only across different boards.** Two postings from one board are never grouped. A
  board listing two similar roles is usually two real openings.
- **Ambiguity groups nothing.** If a key matches more than one posting on any single board,
  leave every posting under that key alone. There is no way to tell which of two SEEK
  advertisements the Indeed one is, and a coin toss here silently deletes a real opening from
  a brief.
- **A fixed board order picks the survivor** — SEEK, then Indeed, then LinkedIn — so two runs
  seeing the same pair agree on the URL and therefore on the id. Do not pick by description
  length or by whichever arrived first; both make the id a function of the weather.

Deliberately not solved: a posting found on two boards this week and one board next week
changes its canonical URL and its id. That follows from identity being URL-derived, it is
already true today when a posting moves between boards, and the fixed order minimises it.
Write it down in the docblock rather than leaving the next reader to discover it.

**Blocked by:** 01 — Search Indeed alongside SEEK.

**Status:** ready-for-agent

- [ ] The same advertisement on SEEK and Indeed becomes one Posting, carrying the other board's
      URL in `alsoOn`
- [ ] Two postings from the **same** board are never grouped, however alike
- [ ] A key matching two postings on one board leaves all of them ungrouped
- [ ] The survivor is chosen by fixed board order; running the same findings twice gives the
      same survivor and the same id
- [ ] `"Sydney NSW"` and `"Sydney, New South Wales, Australia"` group; `"Sydney"` and
      `"Melbourne"` do not
- [ ] Company suffixes do not prevent a match — `"Atlassian"` and `"Atlassian Pty Ltd"` group
- [ ] `PostingSchema` and `postingId` are unchanged; a brief with no duplicates is byte-for-byte
      what it was before this ticket
- [ ] Unit tests cover each restraint above, including the ambiguous case
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean

**The test that matters most is the negative one.** It is easy to write a grouper that makes
briefs look tidy and quietly drops a second real opening. If you have to choose between
grouping one more true duplicate and never grouping a false one, choose the second — that is
the trade-off `posting-id.ts` already states, and this ticket inherits it rather than
revisiting it.
