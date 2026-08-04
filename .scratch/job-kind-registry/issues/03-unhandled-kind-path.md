# 03 — The unhandled-kind path

**What to build:** a job whose config names a kind nothing handles fails the tick
_without burning its slot_. The kind lookup moves ahead of the claim, because an
unhandled kind is knowable from the row alone and claiming a slot to discover it
advances `next_run_at`, inserts a `running` row, and consumes an occurrence for a
job that had no chance of running. The failure message names the kind and cannot
be mistaken for the "config this worker cannot read" message a malformed config
already produces.

**Two consequences of not claiming, both deliberate, both asserted here rather
than discovered later.**

The first is that the row never moves. The guarded update inside the claim is the
only thing that advances `next_run_at`, so a job skipped ahead of the claim keeps
the occurrence it missed, comes back on every subsequent tick, and — because due
jobs are ordered oldest-slot-first — sorts steadily earlier, holding a place in
the fifty-row limit for as long as it exists. One such row makes every invocation
of the worker fail until a human edits it. Other due jobs still run; the
invocation is still marked failed. This is accepted, for the reasoning in
Decision 3 of the plan: auto-pausing instead would hide the job behind a
`next_run_at = NULL` indistinguishable from a pause the user performed, on a
platform where nothing renders a `runs` row at all.

The second is that **there is no database record of this failure at all** — no
`runs` row, so nothing in `runs.failure`, so nothing a later query can find. That
is what makes the rest of this ticket contract rather than diagnostics:

- **The tick report gains `unhandled`.** The report carries an unstated invariant
  — succeeded + failed equals claimed, because both counters only increment
  inside the claimed branch. Folding unhandled kinds into `failed` breaks it
  silently and would have a reader computing a phantom skipped job. The existing
  `skipped` counter must not be borrowed either: it means "another party holds
  this slot", which is not an error, and an unhandled kind is a fault.
- **The aggregate error message stops lying.** It currently reads "N of M claimed
  jobs failed", and an unhandled kind joins the failure list without ever
  incrementing the claimed count — so a tick whose only due job is an unhandled
  kind would throw _"1 of 0 claimed jobs failed"_. Either the denominator counts
  unhandled kinds too, or the message stops naming a denominator.
- **One JSON line on stdout**, carrying the event, the job id, the job name and
  the offending kind. This is the only durable evidence the failure mode
  produces. It also keeps the Errors alarm's runbook honest: that runbook tells
  whoever is paged to read "the briefing-run line with outcome=failure", and an
  unhandled kind never emits one, because the briefing is never reached. This
  plan changes nothing under `infra/aws/`, so the log is where the fix goes.

The throw contract is untouched: every due job is still attempted before the tick
rethrows.

See `docs/job-kind-registry-plan.md`, Decisions 3 and 5, and Stage 2.

**Blocked by:** 02 — Registry and kind lookup, dispatching after the claim.

**Status:** ready-for-agent

- [ ] The kind lookup happens before the claim
- [ ] An unhandled kind fails with a message naming the kind, distinguishable
      from a config-parse failure
- [ ] A test proves no slot was claimed for it
- [ ] A test proves no `runs` row was created — the same fact, but the one a
      reader of the `runs` table would actually notice
- [ ] A test proves `next_run_at` is unchanged
- [ ] A test proves a `kind` that is present but not a non-empty string takes the
      unhandled path rather than falling back to the briefing
- [ ] The tick report carries `unhandled`, and succeeded + failed still equals
      claimed
- [ ] The aggregate error message no longer claims a denominator it does not have
- [ ] One JSON line on stdout names the job and the offending kind, asserted by a
      test
- [ ] Other due jobs in the same tick still run, and the tick still rethrows
