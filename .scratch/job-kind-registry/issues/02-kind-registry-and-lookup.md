# 02 — Registry and kind lookup, dispatching after the claim

**What to build:** the tick stops calling the briefing directly and starts
dispatching through a registry keyed by job kind. The registry has exactly one
real entry — the briefing — whose handler is a thin adapter that changes nothing
about how a briefing runs. Every job in the database today behaves identically,
because the lookup sits exactly where the direct call sat: inside the `try`,
after the slot is claimed. Moving it earlier is ticket 03's job, and moving it is
a behaviour change, which is why it is a separate ticket.

The discriminator is `config.kind`, and the lookup is a pure function of the
config bag — no database, no context, testable on its own. What it must decide:

- **absent** → the briefing, permanently. Not a missing value to be back-filled.
- **`"briefing"`** → the briefing. A row that says out loud what an empty row
  means routes identically.
- **present but not a non-empty string** (`42`, `null`, `""`) → _not found_.
  These are faults, not absences. Reading a malformed discriminator as "absent,
  so briefing" would spend a paid job-search run on a config never meant for one.
- **any other string** → not found.

In this ticket "not found" simply throws from where the direct call used to be;
ticket 03 gives it a path of its own.

Handlers receive a context object assembled once per tick — the job, the claimed
slot, and the recording callbacks — and reach for what they need, rather than
every handler being handed the authority to write a brief whether or not it
writes one. A future kind needing its own store is out of scope; the only
constraint this ticket carries is that the context shape must not make lazy
per-kind construction impossible later.

The registry lives in the worker and must not go in `@workspace/db` — the opacity
of `jobs.config` is the platform's organising rule, and a database package that
knows what kinds exist has stopped being opaque.

See `docs/job-kind-registry-plan.md`, Decisions 1 and 2, and Stage 1.

**Blocked by:** 01 — Give `runTick` a seam over its database calls.

**Status:** ready-for-agent

- [ ] A pure lookup function maps a config bag to a handler or to "not found",
      with unit tests for absent, `"briefing"`, an unknown string, a non-string
      `kind`, `null` and `""`
- [ ] The registry is injectable into the tick, with the real one as the default
- [ ] The briefing handler is an adapter over the existing run function; the
      existing briefing tests pass unchanged
- [ ] A test proves a config with no discriminator routes to the briefing handler
- [ ] Handlers receive a context object, not a positional parameter list
- [ ] Behaviour is unchanged for every existing job: a malformed config still
      fails where it fails today, having claimed its slot
- [ ] The registry lives in the worker, not in `@workspace/db`
