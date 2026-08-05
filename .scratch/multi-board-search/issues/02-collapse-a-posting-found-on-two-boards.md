# 02 — Collapse a posting found on two boards

**What to build:** one advertisement, listed on SEEK and on Indeed, reads as one **Posting** in
a **Brief** rather than two. Ticket 01 made this possible and therefore made it happen —
employers list the same role on every board they pay for, so the more boards the Scout gains,
the more a brief repeats itself and the less a reader trusts the count.

A pure function in `@workspace/agents`, beside `posting-id.ts`. **It runs over the retrieval
pool 05 built, before the Scout ranks** — not over `parseFindings` output. Grouping afterwards
would let the model spend context reasoning about two copies of one advertisement and possibly
select both, so the duplicate is paid for twice and removed once; and it would operate on the
eight postings the model already chose rather than on the population where both copies are
still present.

What the Scout sees is one entry per advertisement, the other boards named in the rendered
entry as text. It selects the survivor's URL like any other, and the worker reattaches the
group to the selected Posting by that URL after `parseFindings`. The model neither reports
provenance nor picks a survivor — it reads both as facts.

**Identity does not change.** `postingId` stays URL-derived, stable across runs and valid as a
`@workspace/user-storage` key segment. This groups _above_ the id; it does not compute a new
one. The `alsoOn` list lives on a `ClusteredPosting` type built by code, and **`PostingSchema`
is not touched** — the model is not asked for provenance, because composed output is exactly
what `posting-id.ts` refuses to derive identity from.

The grouping key is normalised company, normalised title and a city token: lowercase, strip
punctuation and company legal suffixes, and take the city from the front of the location so
`"Sydney NSW"` and `"Sydney, New South Wales, Australia"` agree. Which board a posting came
from is read from its URL host, against the descriptors in
`packages/agents/src/job-scout.ts` — never from anything the model wrote.

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

## Where `alsoOn` is allowed to travel

"`PostingSchema` is untouched" is true and is not the whole answer. `toNewPostings` passes each
Posting **verbatim** into `postings.payload`, and `payload` is what the dashboard renders and
what the **Letter Writer** is given. Decide this rather than discover it:

- **Into the writer prompt: yes.** `toWriterPrompt` serialises the findings, and "also listed
  on Indeed" is the kind of thing a brief should be able to say.
- **Into `postings.payload`: yes, and optional.** A Posting found on one board has no `alsoOn`
  and its payload stays byte-for-byte what it is today. Nothing reading the column may require
  the field.
- **Into `PostingSchema`: no.** That schema is the model's contract and the model does not
  produce this. `ClusteredPosting` extends the parsed type in code.

## Decide the status-loss question before shipping

A posting found on SEEK and Indeed this week and only on Indeed next week changes its canonical
URL, and therefore its id. An earlier draft filed this as an accepted limitation on the grounds
that it is "already true today when a posting moves between boards" — technically true, and
practically misleading: with one board there is nowhere to move. This ticket is what makes it
reachable, and the common direction is the bad one, because SEEK advertisements expire while
aggregator copies persist.

What it costs is not a duplicate row. `postings` is keyed `(user_id, posting_id)` and `status`
is the one column in that schema a person writes — `postings.ts` names the failure in as many
words, "splitting one Posting into two rows and stranding the status a person set on the
first". A user who marked something `applied` finds it back at `new`, with nothing recording
that it happened.

So this ticket owes an answer, not a docblock paragraph. The option to evaluate: have the write
path resolve an existing row by **any** URL in the group rather than by the survivor's alone,
so a run that loses the survivor reattaches to the row instead of minting a sibling. That is a
`recordPostings` change and possibly a stored-alias column. Either implement it or write down
why the exposure is acceptable — but do not ship the grouping with the question open.

**Blocked by:** 05 — Retrieve postings in the worker. Grouping needs the pool, and grouping the
Scout's output instead is the arrangement this ticket exists to avoid.

**Status:** ready-for-agent

- [ ] The same advertisement on SEEK and Indeed reaches the Scout as one entry and reaches the
      Brief as one Posting, carrying the other board's URL in `alsoOn`
- [ ] Grouping happens before ranking; the Scout is never shown two entries for one
      advertisement, and the group is reattached to the selected Posting by URL
- [ ] Two postings from the **same** board are never grouped, however alike
- [ ] A key matching two postings on one board leaves all of them ungrouped
- [ ] The survivor is chosen by fixed board order; running the same pool twice gives the same
      survivor and the same id
- [ ] `"Sydney NSW"` and `"Sydney, New South Wales, Australia"` group; `"Sydney"` and
      `"Melbourne"` do not
- [ ] Company suffixes do not prevent a match — `"Atlassian"` and `"Atlassian Pty Ltd"` group
- [ ] `alsoOn` is optional in `postings.payload`; a Posting found on one board stores what it
      stores today, byte for byte
- [ ] The status-loss question above is answered in the pull request — implemented, or declined
      with reasoning
- [ ] `PostingSchema` and `postingId` are unchanged
- [ ] Unit tests cover each restraint above, including the ambiguous case
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
