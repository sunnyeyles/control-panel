# 03 — Collapse a posting found on two boards

**What to build:** one advertisement listed on two boards reads as one **Posting** in a
**Brief** rather than two. 01 and 02 made this possible and therefore made it happen —
employers list the same role on every board they pay for, so the more boards the Scout
gains, the more a brief repeats itself and the less a reader trusts the count.

A pure function in `@workspace/agents`, beside `posting-id.ts`, over the pooled results
of the board functions **before the Scout ranks**. Grouping after `parseFindings` would
let the model spend context on two copies of one advertisement and possibly select both —
the duplicate paid for twice and removed once — and would operate on the eight postings
the model already chose rather than on the population where both copies are present.

If 05 has not landed, pool and group where `run-briefing.ts` assembles search results; if
it has, group the retrieval pool. Either way the function itself takes a list and returns
a list, and does not know which caller it has.

What the Scout sees is one entry per advertisement, the other boards named in the
rendered entry as text. It selects the survivor's URL like any other, and the worker
reattaches the group by that URL after `parseFindings`. The model neither reports
provenance nor picks a survivor — it reads both as facts.

**Identity does not change.** `postingId` stays URL-derived and stable. This groups
_above_ the id. `alsoOn` lives on a `ClusteredPosting` built in code and **`PostingSchema`
is not touched** — composed output is exactly what `posting-id.ts` refuses to derive
identity from.

The key is normalised company + normalised title + city token: lowercase, strip
punctuation and company legal suffixes, take the city from the front of the location so
`"Sydney NSW"` and `"Sydney, New South Wales, Australia"` agree. Which board a posting
came from is read from its URL host against 00's descriptors, never from anything the
model wrote.

Three restraints, and they are the ticket rather than decoration:

- **Group only across different boards.** Two postings from one board are never grouped.
  A board listing two similar roles is usually two real openings.
- **Ambiguity groups nothing.** If a key matches more than one posting on any single
  board, leave every posting under that key alone. There is no way to tell which of two
  SEEK advertisements the Indeed one is, and a coin toss silently deletes a real opening.
- **A fixed board order picks the survivor** — SEEK, then Indeed, then LinkedIn — so two
  runs seeing the same pair agree on the URL and the id. Not by description length, not by
  arrival order; both make the id a function of the weather.

## Where `alsoOn` is allowed to travel

`toNewPostings` passes each Posting **verbatim** into `postings.payload`, which the
dashboard renders and the **Letter Writer** is given. Decide this rather than discover it:

- **Into the writer prompt: yes.** "also listed on Indeed" is the kind of thing a brief
  should be able to say.
- **Into `postings.payload`: yes, and optional.** A Posting found on one board has no
  `alsoOn` and its payload stays byte-for-byte what it is today. Nothing reading the
  column may require the field.
- **Into `PostingSchema`: no.** That is the model's contract and the model does not
  produce this.

## Decide the status-loss question before shipping

A posting on SEEK and Indeed this week and only on Indeed next week changes its canonical
URL and therefore its id. **This is the same failure 00 fixed for one board, in a form 00
cannot reach** — there the URL was decorated, here the survivor is gone — and the common
direction is the bad one, because SEEK advertisements expire while aggregator copies
persist.

What it costs is not a duplicate row. `postings` is keyed `(user_id, posting_id)` and
`status` is the one column a person writes; `postings.ts` names the failure as "splitting
one Posting into two rows and stranding the status a person set on the first". Someone who
marked something `applied` finds it back at `new`.

So this ticket owes an answer. The option to evaluate: have the write path resolve an
existing row by **any** URL in the group rather than the survivor's alone, so a run that
loses the survivor reattaches instead of minting a sibling. That is a `recordPostings`
change and possibly a stored-alias column. Implement it or write down why the exposure is
acceptable — but do not ship grouping with the question open.

**Blocked by:** 01 or 02 — one more board than SEEK. Both is better, because a three-board
group exercises `alsoOn` carrying more than one entry.

**Status:** ready-for-agent

- [ ] The same advertisement on two boards reaches the Scout as one entry and the Brief as
      one Posting, carrying the other board's URL in `alsoOn`
- [ ] Grouping happens before ranking, and the group is reattached to the selected Posting
      by URL
- [ ] Two postings from the **same** board are never grouped, however alike
- [ ] A key matching two postings on one board leaves all of them ungrouped
- [ ] The survivor is chosen by fixed board order; the same pool twice gives the same
      survivor and the same id
- [ ] `"Sydney NSW"` and `"Sydney, New South Wales, Australia"` group; `"Sydney"` and
      `"Melbourne"` do not
- [ ] `"Atlassian"` and `"Atlassian Pty Ltd"` group
- [ ] `alsoOn` is optional in `postings.payload`; a one-board Posting stores what it
      stores today, byte for byte
- [ ] The status-loss question is answered in the pull request — implemented, or declined
      with reasoning
- [ ] `PostingSchema` and `postingId` are unchanged
- [ ] Unit tests cover each restraint, including the ambiguous case
- [ ] Typecheck, lint (zero warnings) and `pnpm test` are clean
